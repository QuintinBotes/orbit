/** Issue #235: the scope inspection reports changes to instruction files (AGENTS.md at any depth, .claude/skills/**). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectScope } from '../../../src/policy/scope.ts';
import { parseConfig } from '../../../src/policy/config.ts';
import { effectiveProtectedPaths } from '../../../src/policy/builtin.ts';
import type { PolicySnapshot } from '../../../src/policy/types.ts';

const gitAvailable = spawnSync('git', ['--version']).status === 0;
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Acme Dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Acme Dev', GIT_COMMITTER_EMAIL: 'dev@example.com' };

function snapshotOf(yaml: string): PolicySnapshot {
  const config = parseConfig(`version: 1\n${yaml}`);
  return { schema: 'orbit.policy/1', run_id: 'orb-i', created_at: '', repo_root: '/', config, effective_protected_paths: effectiveProtectedPaths(config), check_config_hashes: {} };
}

let repo: string;
const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, env: GIT_ENV, encoding: 'utf8' }).trim();
function write(rel: string, content: string): void {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), content);
}

describe.skipIf(!gitAvailable)('inspectScope: instruction files (#235)', () => {
  let base: string;
  beforeAll(() => {
    repo = join(mkdtempSync(join(tmpdir(), 'orbit-instr-')), 'repo');
    mkdirSync(repo);
    git('init', '-q', '-b', 'main');
    write('AGENTS.md', 'root\n');
    write('src/app.ts', 'export {};\n');
    write('docs/AGENTS.md', 'docs\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    base = git('rev-parse', 'HEAD');
  });
  afterAll(() => repo && rmSync(dirname(repo), { recursive: true, force: true }));

  const inspect = async (): Promise<string[] | undefined> => {
    git('add', '-A');
    git('commit', '-q', '-m', 'candidate');
    const r = await inspectScope({ repoRoot: repo, baseRev: base, candidateRev: git('rev-parse', 'HEAD'), snapshot: snapshotOf('scope: {allowed_paths: ["**"]}\n') });
    git('reset', '-q', '--hard', base);
    return r.instruction_files_changed;
  };

  it('lists AGENTS.md at the root and at any depth, and files under .claude/skills', async () => {
    write('AGENTS.md', 'changed\n');
    write('packages/a/b/AGENTS.md', 'new\n');
    write('docs/AGENTS.md', 'changed\n');
    write('.claude/skills/helper/SKILL.md', 'skill\n');
    write('src/app.ts', 'export const x = 1;\n');
    expect(await inspect()).toEqual(['.claude/skills/helper/SKILL.md', 'AGENTS.md', 'docs/AGENTS.md', 'packages/a/b/AGENTS.md']);
  });

  it('control: a change that touches no instruction file reports none', async () => {
    write('src/app.ts', 'export const y = 2;\n');
    expect(await inspect()).toBeUndefined();
  });
});
