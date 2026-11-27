// Issue #273, on real repositories: which starts lack commits of the base branch, read locally and as its remote.
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { staleStart } from '../../../src/controller/steps/preflight.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false'];
const git = (cwd: string, ...a: string[]) => execFileSync('git', [...ID, ...a], { cwd, encoding: 'utf8' }).trim();
const commit = (cwd: string, name: string) => {
  writeFileSync(join(cwd, `${name}.txt`), `${name}\n`);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', name);
};
function repo(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-stale-')));
  dirs.push(d);
  git(d, 'init', '-q', '-b', 'main');
  commit(d, 'base');
  return d;
}

describe('staleStart', () => {
  it('names a start behind the local base branch', async () => {
    const r = repo();
    git(r, 'checkout', '-q', '-b', 'next');
    commit(r, 'a');
    commit(r, 'b');
    git(r, 'checkout', '-q', 'main');
    const s = await staleStart(r, git(r, 'rev-parse', 'HEAD'), 'next', 'origin');
    expect(s?.data).toMatchObject({ base: 'next', base_ref: 'refs/heads/next', missing: 2 });
  });

  it('lets a branch on top of the base start, and is quiet when the base cannot be read', async () => {
    const r = repo();
    git(r, 'checkout', '-q', '-b', 'feature');
    commit(r, 'f');
    expect(await staleStart(r, git(r, 'rev-parse', 'HEAD'), 'main', 'origin')).toBeNull();
    expect(await staleStart(r, git(r, 'rev-parse', 'HEAD'), 'no-such-branch', 'origin')).toBeNull();
  });

  it('reads a base branch that exists only on the remote, as in a fresh clone', async () => {
    const origin = repo();
    git(origin, 'checkout', '-q', '-b', 'next');
    commit(origin, 'n');
    git(origin, 'checkout', '-q', 'main');
    const clone = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-stale-clone-')));
    dirs.push(clone);
    execFileSync('git', ['clone', '-q', origin, clone]);
    expect(() => git(clone, 'rev-parse', '--verify', '--quiet', 'refs/heads/next')).toThrow();
    const s = await staleStart(clone, git(clone, 'rev-parse', 'HEAD'), 'next', 'origin');
    expect(s?.data).toMatchObject({ base_ref: 'refs/remotes/origin/next', missing: 1 });
    expect(s?.reason).toContain('lacks 1 commit(s) of origin/next');
  });

  it('counts the remote base when the local copy lags it', async () => {
    const origin = repo();
    const clone = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-stale-clone-')));
    dirs.push(clone);
    execFileSync('git', ['clone', '-q', origin, clone]);
    commit(origin, 'later');
    git(clone, 'fetch', '-q', 'origin');
    // The checkout is the local main, equal to its local branch but behind origin/main.
    const s = await staleStart(clone, git(clone, 'rev-parse', 'HEAD'), 'main', 'origin');
    expect(s?.data).toMatchObject({ base_ref: 'refs/remotes/origin/main', missing: 1 });
  });
});
