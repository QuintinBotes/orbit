/** Issue #235: the scope inspection reports changes to instruction files and which of them the goal's scope does not name. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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

  /** Commits the working tree, inspects it against the base, and puts the tree back. */
  const inspect = async (contractAllowed?: string[]) => {
    git('add', '-A');
    git('commit', '-q', '-m', 'candidate');
    const r = await inspectScope({ repoRoot: repo, baseRev: base, candidateRev: git('rev-parse', 'HEAD'), snapshot: snapshotOf('scope: {allowed_paths: ["**"]}\n'), ...(contractAllowed ? { contractAllowedPaths: contractAllowed } : {}) });
    git('reset', '-q', '--hard', base);
    git('clean', '-q', '-fd');
    return r;
  };

  it('lists AGENTS.md at the root and at any depth, and files under .claude/skills', async () => {
    write('AGENTS.md', 'changed\n');
    write('packages/a/b/AGENTS.md', 'new\n');
    write('docs/AGENTS.md', 'changed\n');
    write('.claude/skills/helper/SKILL.md', 'skill\n');
    write('src/app.ts', 'export const x = 1;\n');
    expect((await inspect()).instruction_files_changed).toEqual(['.claude/skills/helper/SKILL.md', 'AGENTS.md', 'docs/AGENTS.md', 'packages/a/b/AGENTS.md']);
  });

  it('lists the other instruction surfaces: CLAUDE.md, GEMINI.md, .claude/agents and commands, .cursor/rules, copilot instructions', async () => {
    const files = ['CLAUDE.md', 'sub/CLAUDE.md', 'GEMINI.md', '.claude/agents/a.md', '.claude/commands/c.md', '.cursor/rules/r.mdc'];
    for (const f of files) write(f, 'x\n');
    // The default policy protects .github/**, so the copilot file is reported as forbidden there; the glob stays for a policy that does not.
    write('.github/copilot-instructions.md', 'x\n');
    const r = await inspect();
    expect(r.instruction_files_changed).toEqual([...files].sort());
    expect(r.forbidden_paths_changed).toEqual(['.github/copilot-instructions.md']);
  });

  it('lists a deletion and a case variant', async () => {
    unlinkSync(join(repo, 'AGENTS.md'));
    write('sub/agents.md', 'lower\n');
    expect((await inspect()).instruction_files_changed).toEqual(['AGENTS.md', 'sub/agents.md']);
  });

  it('does not list a path the built-in protections already cover, so it is not handled twice', async () => {
    write('.codex/AGENTS.md', 'x\n');
    write('.agents/skills/s/SKILL.md', 'x\n');
    const r = await inspect();
    expect(r.instruction_files_changed).toBeUndefined();
    expect(r.forbidden_paths_changed).toEqual(['.agents/skills/s/SKILL.md', '.codex/AGENTS.md']);
  });

  it('names a file by its literal path, a pattern ending in its file name, or a directory glob that holds it', async () => {
    write('AGENTS.md', 'a\n');
    write('sub/AGENTS.md', 'b\n');
    write('.claude/skills/x/SKILL.md', 'c\n');
    expect((await inspect(['AGENTS.md', '**/AGENTS.md', '.claude/skills/x/**'])).instruction_files_unnamed).toBeUndefined();
  });

  it('does not count a catch-all scope as naming an instruction file', async () => {
    for (const catchAll of [['**'], ['.'], ['*'], ['**/*'], ['src/**', '**']]) {
      write('AGENTS.md', 'a\n');
      write('sub/AGENTS.md', 'b\n');
      expect((await inspect(catchAll)).instruction_files_unnamed, catchAll.join(',')).toEqual(['AGENTS.md', 'sub/AGENTS.md']);
    }
  });

  it('with no contract scope, the policy scope decides: its catch-all names nothing', async () => {
    write('AGENTS.md', 'a\n');
    expect((await inspect()).instruction_files_unnamed).toEqual(['AGENTS.md']);
  });

  it('names a case variant by a case-insensitive match, and reports what a narrower scope leaves unnamed', async () => {
    write('sub/agents.md', 'lower\n');
    write('docs/AGENTS.md', 'changed\n');
    expect((await inspect(['**/AGENTS.md', 'src/**'])).instruction_files_unnamed).toBeUndefined();
    write('sub/agents.md', 'lower\n');
    write('docs/AGENTS.md', 'changed\n');
    expect((await inspect(['docs/AGENTS.md'])).instruction_files_unnamed).toEqual(['sub/agents.md']);
  });

  it('control: a change that touches no instruction file reports none', async () => {
    write('src/app.ts', 'export const y = 2;\n');
    const r = await inspect();
    expect(r.instruction_files_changed).toBeUndefined();
    expect(r.instruction_files_unnamed).toBeUndefined();
  });
});
