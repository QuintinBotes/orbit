import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
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

function snapshotOf(yaml: string): PolicySnapshot {
  const config = parseConfig(`version: 1\n${yaml}`);
  return { schema: 'orbit.policy/1', run_id: 'orb-s', created_at: '', repo_root: '/', config, effective_protected_paths: effectiveProtectedPaths(config), check_config_hashes: {} };
}

const SNAPSHOT = snapshotOf(
  'scope: {allowed_paths: ["apps/**", "tests/**", "docs/**", "package.json", "package-lock.json"], protected_paths: [".github/**"]}\nui: {visual: {baseline_globs: ["**/*-snapshots/**"]}}\n',
);

let repo: string;
let outside: string;
let base: string;
let cand: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, env: GIT_ENV, encoding: 'utf8' }).trim();
}

function write(rel: string, content: string | Buffer): void {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), content);
}

const PKG_BASE = { name: 'acme-widgets', version: '1.0.0', scripts: { test: 'vitest run' }, dependencies: { zod: '^3.0.0' }, devDependencies: { vitest: '^5.0.0' } };
const TEST_BASE = ["import { sum } from '../apps/web/sum';", "it('adds', () => {", '  expect(sum(1, 2)).toBe(3);', '  expect(sum(-1, 1)).toBe(0);', '});', ''].join('\n');

describe.skipIf(!gitAvailable)('inspectScope on a real repository (skipped when git is not installed)', () => {
  beforeAll(() => {
    const top = mkdtempSync(join(tmpdir(), 'orbit-scope-'));
    repo = join(top, 'repo');
    outside = join(top, 'outside');
    mkdirSync(repo);
    mkdirSync(outside);
    git('init', '-q', '-b', 'main');
    write('package.json', `${JSON.stringify(PKG_BASE, null, 2)}\n`);
    write('package-lock.json', '{"lockfileVersion": 3}\n');
    write('apps/web/package.json', `${JSON.stringify({ name: 'web', private: true, dependencies: { react: '19.0.0' } }, null, 2)}\n`);
    write('apps/web/sum.ts', 'export const sum = (a: number, b: number) => a + b;\n');
    write('tests/sum.test.ts', TEST_BASE);
    write('.github/workflows/ci.yml', 'on: push\n');
    write('docs/readme.md', '# docs\n');
    write('tests/e2e/home.spec.ts-snapshots/home.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1]));
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    base = git('rev-parse', 'HEAD');

    // The candidate: one change of every kind the inspection must notice.
    write('.github/workflows/ci.yml', 'on: [push, pull_request]\n');
    write('src/new-module.ts', 'export {};\n');
    write('package-lock.json', '{"lockfileVersion": 3, "packages": {}}\n');
    write('package.json', `${JSON.stringify({ ...PKG_BASE, dependencies: { ...PKG_BASE.dependencies, 'left-pad': '^1.3.0' } }, null, 2)}\n`);
    // Same dependencies, different formatting and key order: not a dependency change.
    write('apps/web/package.json', JSON.stringify({ dependencies: { react: '19.0.0' }, private: true, name: 'web' }));
    write('tests/sum.test.ts', ["import { sum } from '../apps/web/sum';", "it.skip('adds', () => {", '  expect(sum(1, 2)).toBe(3);', '});', ''].join('\n'));
    write('tests/e2e/home.spec.ts-snapshots/home.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 2]));
    symlinkSync(join(outside, 'secret.txt'), join(repo, 'apps', 'web', 'abs-link'));
    symlinkSync('../../../outside/secret.txt', join(repo, 'apps', 'web', 'rel-link'));
    symlinkSync('../../.github/workflows/ci.yml', join(repo, 'apps', 'web', 'protected-link'));
    symlinkSync('sum.ts', join(repo, 'apps', 'web', 'fine-link'));
    // A chain: hop -> rel-link -> outside.
    symlinkSync('rel-link', join(repo, 'apps', 'web', 'hop'));
    git('add', '-A');
    git('commit', '-q', '-m', 'candidate');
    cand = git('rev-parse', 'HEAD');
  });

  afterAll(() => {
    if (repo) rmSync(dirname(repo), { recursive: true, force: true });
  });

  let report: ScopeReport;
  beforeAll(async () => {
    report = await inspectScope({ repoRoot: repo, baseRev: base, candidateRev: cand, snapshot: SNAPSHOT });
  });

  it('reports protected changes as forbidden', () => {
    expect(report.forbidden_paths_changed).toEqual(['.github/workflows/ci.yml']);
    expect(report.allowed_paths_pass).toBe(false);
  });

  it('reports changes outside allowed scope', () => {
    expect(report.out_of_scope_paths_changed).toEqual(['src/new-module.ts']);
  });

  it('counts files and lines', () => {
    expect(report.changed_files).toBe(12);
    expect(report.changed_lines).toBeGreaterThan(8);
    expect(report.within_size_limits).toBe(true);
  });

  it('notices lockfile changes and structural dependency changes only', () => {
    expect(report.lockfile_changed).toBe(true);
    expect(report.dependency_manifest_changed).toEqual(['package.json']);
  });

  it('finds symlinks that escape or point at protected paths, following chains', () => {
    expect(report.symlinks_escaping.sort()).toEqual(['apps/web/abs-link', 'apps/web/hop', 'apps/web/protected-link', 'apps/web/rel-link']);
  });

  it('reports visual baseline changes', () => {
    expect(report.visual_baseline_changes).toEqual(['tests/e2e/home.spec.ts-snapshots/home.png']);
  });

  it('reports weakened tests', () => {
    const signals = report.weakening_signals.map((s) => `${s.path}:${s.signal}`);
    expect(signals).toEqual(expect.arrayContaining(['tests/sum.test.ts:test-skipped', 'tests/sum.test.ts:assertion-removed', 'tests/e2e/home.spec.ts-snapshots/home.png:snapshot-edited']));
  });

  it('applies hard size limits from the snapshot', async () => {
    const tight = snapshotOf('scope: {allowed_paths: ["**"]}\nscheduler: {hard_limits: {changed_files: 3}}\n');
    const r = await inspectScope({ repoRoot: repo, baseRev: base, candidateRev: cand, snapshot: tight });
    expect(r.within_size_limits).toBe(false);
  });

  it('narrows scope to the contract when one is given', async () => {
    const r = await inspectScope({ repoRoot: repo, baseRev: base, candidateRev: cand, snapshot: SNAPSHOT, contractAllowedPaths: ['tests/**'] });
    expect(r.out_of_scope_paths_changed).toEqual(expect.arrayContaining(['apps/web/package.json', 'package.json', 'src/new-module.ts']));
    expect(r.out_of_scope_paths_changed).not.toContain('tests/sum.test.ts');
  });

  it('is clean for a candidate that stays in scope', async () => {
    write('apps/web/sum.ts', 'export const sum = (a: number, b: number): number => a + b;\n');
    git('add', 'apps/web/sum.ts');
    git('commit', '-q', '-m', 'in scope');
    const next = git('rev-parse', 'HEAD');
    const r = await inspectScope({ repoRoot: repo, baseRev: cand, candidateRev: next, snapshot: SNAPSHOT });
    expect(r).toEqual({
      allowed_paths_pass: true,
      forbidden_paths_changed: [],
      out_of_scope_paths_changed: [],
      changed_files: 1,
      changed_lines: 2,
      within_size_limits: true,
      lockfile_changed: false,
      dependency_manifest_changed: [],
      symlinks_escaping: [],
      weakening_signals: [],
      visual_baseline_changes: [],
    });
  });

  it('sees through attributes that mark text as binary', async () => {
    // A .gitattributes in the checkout makes git call .ts files binary; lines and test diffs must still be inspected.
    write('.gitattributes', '*.ts -diff\n');
    const before = git('rev-parse', 'HEAD');
    write('tests/sum.test.ts', ["import { sum } from '../apps/web/sum';", "it('adds', () => {", '});', ''].join('\n'));
    git('add', 'tests/sum.test.ts');
    git('commit', '-q', '-m', 'hidden');
    const after = git('rev-parse', 'HEAD');
    const r = await inspectScope({ repoRoot: repo, baseRev: before, candidateRev: after, snapshot: SNAPSHOT });
    expect(r.changed_lines).toBeGreaterThan(0);
    expect(r.weakening_signals.map((s) => s.signal)).toContain('assertion-removed');
    unlinkSync(join(repo, '.gitattributes'));
  });

  it('refuses revisions that are not commits or look like options', async () => {
    await expect(inspectScope({ repoRoot: repo, baseRev: '--output=/tmp/x', candidateRev: cand, snapshot: SNAPSHOT })).rejects.toMatchObject({ code: 'GIT_FAILED' });
    await expect(inspectScope({ repoRoot: repo, baseRev: 'no-such-ref', candidateRev: cand, snapshot: SNAPSHOT })).rejects.toMatchObject({ code: 'GIT_FAILED' });
    await expect(inspectScope({ repoRoot: repo, baseRev: `${base}^{tree}`, candidateRev: cand, snapshot: SNAPSHOT })).rejects.toMatchObject({ code: 'GIT_FAILED' });
  });
});
