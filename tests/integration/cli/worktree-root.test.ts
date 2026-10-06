/**
 * Issue #3: inside a linked worktree the worktree is the repository root for every command (the semantics of
 * `git rev-parse --show-toplevel`), while what git shares between worktrees (the common git directory and its
 * info/exclude) stays shared. The labs use a real linked worktree made with `git worktree add`, nested inside a main
 * working tree that is on another branch and dirty, which is the usual reason to give Orbit a worktree.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { git, makeSandbox, TEST_CONFIG, type Sandbox } from './helpers.ts';

const boxes: Sandbox[] = [];
afterEach(() => boxes.splice(0).forEach((b) => b.close()));

interface Linked {
  b: Sandbox;
  /** The linked worktree, on branch "feature". */
  wt: string;
}

/** A main working tree on branch "busy" with uncommitted work, and a clean linked worktree on "feature" inside it. */
function linkedLab(): Linked {
  const b = makeSandbox({ config: null });
  boxes.push(b);
  mkdirSync(join(b.repo, 'src'));
  writeFileSync(join(b.repo, 'src', 'calc.ts'), 'export const add = (a: number, b: number): number => a + b;\n');
  git(b.repo, 'add', '-A');
  git(b.repo, 'commit', '-q', '-m', 'calc');
  const wt = join(b.repo, '.claude', 'worktrees', 'wt');
  git(b.repo, 'worktree', 'add', '-q', '-b', 'feature', wt, 'main');
  git(b.repo, 'checkout', '-q', '-b', 'busy');
  writeFileSync(join(b.repo, 'README.md'), '# acme, edited\n');
  writeFileSync(join(b.repo, 'notes.txt'), 'scratch\n');
  return { b, wt };
}

describe('a linked worktree is its own repository root (#3)', () => {
  it('init writes the worktree\'s config with its own branch as the base, and the exclude rules into the shared exclude file', async () => {
    const { b, wt } = linkedLab();
    const r = await b.run(['init', '--json'], { cwd: wt });
    expect(r.code, r.stderr).toBe(0);
    const j = JSON.parse(r.stdout) as { config: { path: string; status: string; base_branch?: string }; exclude: { path: string } };
    expect(j.config).toMatchObject({ path: join(wt, '.orbit', 'config.yaml'), status: 'created', base_branch: 'feature' });
    expect(readFileSync(join(wt, '.orbit', 'config.yaml'), 'utf8')).toMatch(/^\s*base_branch: "feature"$/m);
    expect(existsSync(join(b.repo, '.orbit'))).toBe(false);
    // info/exclude is shared by every worktree of the clone, and its rooted rules apply in each.
    expect(j.exclude.path).toBe(join(b.repo, '.git', 'info', 'exclude'));
    expect(readFileSync(j.exclude.path, 'utf8')).toContain('/.orbit/state.sqlite*');
    writeFileSync(join(wt, '.orbit', 'state.sqlite'), '');
    expect(git(wt, 'status', '--porcelain', '--untracked-files=all')).toBe('?? .orbit/config.yaml');
    // The main working tree is left as it was: still on its own branch, still dirty.
    expect(git(b.repo, 'branch', '--show-current')).toBe('busy');
    expect(git(b.repo, 'status', '--porcelain')).toContain('README.md');
  });

  // The exclude file lives in the main checkout's git directory (git reads only the common dir's info/exclude), which
  // surprises a person who expects init in a worktree to change nothing outside it. Orbit keeps the shared write, so
  // it says that this is what it did, as the real CLI prints it.
  it('init in a worktree says the exclude file is shared by every worktree of the clone, whether it adds the rules or finds them', async () => {
    const { b, wt } = linkedLab();
    const shared = join(b.repo, '.git', 'info', 'exclude');
    const first = await b.run(['init'], { cwd: wt });
    expect(first.code, first.stderr).toBe(0);
    const added = first.stdout.split('\n').find((l) => l.startsWith('added '));
    expect(added).toMatch(/^added 3 rule\(s\) to .*\/\.git\/info\/exclude so runtime state stays out of git status; .* every worktree of this clone shares it/);
    expect(added).toContain(shared);
    const second = await b.run(['init'], { cwd: wt });
    const present = second.stdout.split('\n').find((l) => l.includes('already excludes'));
    expect(present).toMatch(/already excludes Orbit runtime state; .* every worktree of this clone shares it/);
    expect(present).toContain(shared);
    const j = JSON.parse((await b.run(['init', '--json'], { cwd: wt })).stdout) as { exclude: { path: string; added: string[] }; exclude_file: { path: string; shared_across_worktrees: boolean } };
    expect(j.exclude).toEqual({ path: shared, added: [] });
    expect(j.exclude_file).toEqual({ path: shared, shared_across_worktrees: true });
  });

  it('init in the main working tree keeps its output and reports the file as not shared', async () => {
    const { b } = linkedLab();
    const shared = join(b.repo, '.git', 'info', 'exclude');
    const first = await b.run(['init'], { cwd: b.repo });
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout.split('\n')).toContain(`added 3 rule(s) to ${shared} so runtime state stays out of git status`);
    expect(first.stdout).not.toMatch(/worktree/i);
    const j = JSON.parse((await b.run(['init', '--json'], { cwd: b.repo })).stdout) as { exclude_file: unknown };
    expect(j.exclude_file).toEqual({ path: shared, shared_across_worktrees: false });
  });

  it('doctor judges the worktree: its branch, its cleanliness, its config', async () => {
    const { b, wt } = linkedLab();
    mkdirSync(join(wt, '.orbit'));
    writeFileSync(join(wt, '.orbit', 'config.yaml'), TEST_CONFIG.replace('base_branch: main', 'base_branch: feature'));
    const r = await b.run(['doctor', '--json'], { cwd: wt });
    const report = JSON.parse(r.stdout) as { repo: string; checks: { id: string; status: string; summary: string }[] };
    expect(report.repo).toBe(wt);
    const repo = report.checks.find((c) => c.id === 'git.repo');
    expect(repo, JSON.stringify(report.checks)).toMatchObject({ status: 'pass', summary: `repository ${wt}; worktrees supported` });
    expect(report.checks.find((c) => c.id === 'config')?.status).toBe('pass');
    // The same doctor in the main working tree still sees that tree's own uncommitted work.
    const main = JSON.parse((await b.run(['doctor', '--json'], { cwd: b.repo })).stdout) as typeof report;
    expect(main.repo).toBe(b.repo);
    expect(main.checks.find((c) => c.id === 'git.repo')?.summary).toContain('a clean working tree');
  });
});
