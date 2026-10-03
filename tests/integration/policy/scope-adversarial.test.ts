/**
 * Ways a candidate could hide a change from inspectScope, found by an
 * adversarial review. Uses a real git repository; skipped without git.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectScope } from '../../../src/policy/scope.ts';
import { parseConfig } from '../../../src/policy/config.ts';
import { effectiveProtectedPaths } from '../../../src/policy/builtin.ts';
import type { PolicySnapshot } from '../../../src/policy/types.ts';
import type { ScopeReport } from '../../../src/evidence/types.ts';

const gitAvailable = spawnSync('git', ['--version']).status === 0;

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Acme Dev',
  GIT_AUTHOR_EMAIL: 'dev@example.com',
  GIT_COMMITTER_NAME: 'Acme Dev',
  GIT_COMMITTER_EMAIL: 'dev@example.com',
};

const config = parseConfig('version: 1\nscope: {allowed_paths: ["**"], protected_paths: [".github/**"]}\nscheduler: {hard_limits: {changed_lines: 500}}\n');
const SNAPSHOT: PolicySnapshot = { schema: 'orbit.policy/1', run_id: 'orb-sa', created_at: '', repo_root: '/', config, effective_protected_paths: effectiveProtectedPaths(config), check_config_hashes: {} };

let top: string;
let repo: string;
let report: ScopeReport;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, env: GIT_ENV, encoding: 'utf8' }).trim();
}

function write(rel: string, content: string | Buffer): void {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), content);
}

const TEST_BASE = "it('adds', () => {\n  expect(sum(1, 2)).toBe(3);\n  expect(sum(2, 2)).toBe(4);\n});\n";

describe.skipIf(!gitAvailable)('inspectScope against hiding tricks (skipped when git is not installed)', () => {
  beforeAll(async () => {
    top = mkdtempSync(join(tmpdir(), 'orbit-scope-adv-'));
    repo = join(top, 'repo');
    mkdirSync(repo);
    git('init', '-q', '-b', 'main');
    write('tests/sum.test.ts', TEST_BASE);
    write('package.json', `${JSON.stringify({ name: 'acme', trustedDependencies: [] }, null, 2)}\n`);
    write('assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1]));
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    const base = git('rev-parse', 'HEAD');

    // A NUL byte makes git call the file binary, which used to hide both the
    // removed assertions and every added line.
    write('tests/sum.test.ts', `// \u0000\nit('adds', () => {\n});\n${'filler();\n'.repeat(600)}`);
    // Lets the named package run install scripts under bun.
    write('package.json', `${JSON.stringify({ name: 'acme', trustedDependencies: ['evil-pkg'] }, null, 2)}\n`);
    // pnpm 10 keeps overrides and build permissions here.
    write('pnpm-workspace.yaml', 'onlyBuiltDependencies:\n  - evil-pkg\n');
    write('.yarnrc.yml', 'npmRegistryServer: "https://registry.example.com"\n');
    // A real binary asset still counts as zero lines.
    write('assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 2]));
    git('add', '-A');
    git('commit', '-q', '-m', 'candidate');
    report = await inspectScope({ repoRoot: repo, baseRev: base, candidateRev: git('rev-parse', 'HEAD'), snapshot: SNAPSHOT });
  });

  afterAll(() => rmSync(top, { recursive: true, force: true }));

  it('still sees removed assertions in a source file that contains a NUL byte', () => {
    expect(report.weakening_signals).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'tests/sum.test.ts', signal: 'assertion-removed' })]));
  });

  it('counts the lines of such a file against the size limit', () => {
    expect(report.changed_lines).toBeGreaterThan(600);
    expect(report.within_size_limits).toBe(false);
  });

  it('reports dependency-control files and sections as dependency changes', () => {
    expect(report.dependency_manifest_changed).toEqual(expect.arrayContaining(['package.json', 'pnpm-workspace.yaml', '.yarnrc.yml']));
  });

  it('sees a submodule pointer change even when repository config says to ignore submodules', async () => {
    const sub = join(top, 'sub-repo');
    mkdirSync(sub);
    const subRepo = repo;
    repo = sub;
    try {
      git('init', '-q', '-b', 'main');
      write('README.md', 'x\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'base');
      const base = git('rev-parse', 'HEAD');
      git('config', 'diff.ignoreSubmodules', 'all');
      git('update-index', '--add', '--cacheinfo', `160000,${base},apps/vendored`);
      git('commit', '-q', '-m', 'add gitlink');
      const r = await inspectScope({ repoRoot: sub, baseRev: base, candidateRev: git('rev-parse', 'HEAD'), snapshot: SNAPSHOT });
      expect(r.changed_files).toBe(1);
    } finally {
      repo = subRepo;
    }
  });
});
