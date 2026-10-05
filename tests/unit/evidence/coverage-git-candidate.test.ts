import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupCandidateCheckout, diffStat, materializeCandidate } from '../../../src/evidence/candidate.ts';
import { adminDirFor, git, gitEnv, resolveCommit } from '../../../src/evidence/git.ts';
import { makeRepo, sh, tempRoot, write } from './fixtures.ts';

let t: ReturnType<typeof tempRoot>;
beforeEach(() => {
  t = tempRoot();
});
afterEach(() => {
  vi.unstubAllEnvs();
  t.remove();
});

const REAL_GIT = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();

/** Puts a `git` first on PATH that runs `intercept` (shell) before the real one. */
function fakeGit(intercept: string): void {
  const bin = join(t.root, 'fakebin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'git'), `#!/bin/sh\n${intercept}\nexec '${REAL_GIT}' "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);
  vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
}

describe('gitEnv', () => {
  it('falls back to a minimal PATH when the process has none, and lets the caller override anything', () => {
    vi.stubEnv('PATH', undefined as unknown as string);
    expect(gitEnv().PATH).toBe('/usr/bin:/bin');
    vi.stubEnv('PATH', '/opt/acme/bin');
    expect(gitEnv().PATH).toBe('/opt/acme/bin');
    expect(gitEnv({ PATH: '/x', GIT_DIR: '/y' })).toMatchObject({ PATH: '/x', GIT_DIR: '/y', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' });
  });
});

describe('git', () => {
  it('reports a git that could not run at all, with and without a subcommand', async () => {
    await expect(git(join(t.root, 'no-such-dir'), ['status'])).rejects.toMatchObject({ code: 'GIT_FAILED', message: expect.stringMatching(/^git status could not run: /) });
    await expect(git(join(t.root, 'no-such-dir'), [])).rejects.toMatchObject({ code: 'GIT_FAILED', message: expect.stringMatching(/^git  could not run: /) });
  });

  it('reports a git that ran out of time as a timeout, not an exit status', async () => {
    const r = makeRepo(t.root);
    fakeGit('case "$*" in *rev-parse*) sleep 5;; esac');
    await expect(git(r.repo, ['rev-parse', 'HEAD'], { timeoutMs: 150 })).rejects.toMatchObject({ code: 'GIT_FAILED', message: expect.stringMatching(/failed \(timeout\)/) });
  });

  it('puts the exit status and bounded stderr in the message of a failing git', async () => {
    const r = makeRepo(t.root);
    await expect(git(r.repo, ['rev-parse', '--verify', 'no-such-ref'])).rejects.toMatchObject({ code: 'GIT_FAILED', details: expect.objectContaining({ exitCode: 128 }), message: expect.stringMatching(/failed \(exit 128\)/) });
  });
});

describe('resolveCommit', () => {
  it('refuses revisions that could be read as options or contain odd characters', async () => {
    const r = makeRepo(t.root);
    await expect(resolveCommit(r.repo, '--help')).rejects.toMatchObject({ code: 'GIT_FAILED', message: expect.stringContaining('not a usable revision') });
    await expect(resolveCommit(r.repo, 'a b')).rejects.toMatchObject({ code: 'GIT_FAILED' });
    expect(await resolveCommit(r.repo, 'HEAD')).toBe(r.base);
  });
});

describe('adminDirFor', () => {
  it('answers with the common git directory for the main working tree itself', async () => {
    const r = makeRepo(t.root);
    const res = await adminDirFor(r.repo, r.repo);
    expect(res.worktree).toBe(r.repo);
    expect(res.gitDir).toBe(join(r.repo, '.git'));
  });

  it('refuses a worktree path that does not exist', async () => {
    const r = makeRepo(t.root);
    await expect(adminDirFor(r.repo, join(t.root, 'gone'))).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('does not exist') });
  });

  it('refuses a directory that is not a registered worktree, even when it carries a .git file pointing somewhere', async () => {
    const r = makeRepo(t.root);
    const other = join(t.root, 'other');
    mkdirSync(other);
    write(join(other, '.git'), `gitdir: ${join(r.repo, '.git')}\n`);
    await expect(adminDirFor(r.repo, other)).rejects.toMatchObject({ code: 'GIT_FAILED', message: expect.stringContaining('is not a registered worktree') });
  });
});

describe('diffStat parsing', () => {
  it('counts files, binary files and lines, skips records it cannot parse, and caps the path list at 200', async () => {
    const r = makeRepo(t.root);
    const records = ['not a numstat record', '-\t-\timage.png', '3\t1\tsrc/odd name\nwith newline.txt', ...Array.from({ length: 205 }, (_, i) => `1\t0\tf${i}.txt`)];
    fakeGit(`case " $* " in *" diff "*) printf '%s\\0' ${records.map((x) => `'${x}'`).join(' ')}; exit 0;; esac`);
    const stat = await diffStat(r.repo, r.baseTree, r.baseTree);
    expect(stat.files).toBe(207);
    expect(stat.binaryFiles).toBe(1);
    expect(stat.insertions).toBe(3 + 205);
    expect(stat.deletions).toBe(1);
    expect(stat.paths).toHaveLength(200);
    expect(stat.paths[1]).toBe('src/odd name\nwith newline.txt');
    expect(stat.truncated).toBe(true);
  });
});

describe('cleanupCandidateCheckout refuses to delete what is not a checkout', () => {
  it('refuses a directory that is, or contains, the repository, including the filesystem root', async () => {
    const r = makeRepo(t.root);
    await expect(cleanupCandidateCheckout(r.repo, r.repo)).rejects.toMatchObject({ code: 'GIT_FAILED', message: expect.stringContaining('it is or contains the repository') });
    await expect(cleanupCandidateCheckout(r.repo, t.root)).rejects.toMatchObject({ code: 'GIT_FAILED', message: expect.stringContaining('it is or contains the repository') });
    await expect(cleanupCandidateCheckout(r.repo, '/')).rejects.toMatchObject({ code: 'GIT_FAILED', message: expect.stringContaining('it is or contains the repository') });
    expect(existsSync(join(r.repo, '.git'))).toBe(true);
  });

  it('refuses a directory with its own .git directory, and removes a plain directory with none', async () => {
    const r = makeRepo(t.root);
    const other = makeRepo(t.root, { 'a.txt': 'x\n' }, 'other');
    await expect(cleanupCandidateCheckout(r.repo, other.repo)).rejects.toMatchObject({ code: 'GIT_FAILED', message: expect.stringContaining('holds its own .git directory') });
    expect(existsSync(join(other.repo, 'a.txt'))).toBe(true);

    const plain = join(t.root, 'plain');
    write(join(plain, 'sub', 'file.txt'), 'x\n', 0o444);
    await cleanupCandidateCheckout(r.repo, plain);
    expect(existsSync(plain)).toBe(false);
  });

  it('does nothing for a directory that does not exist', async () => {
    const r = makeRepo(t.root);
    await expect(cleanupCandidateCheckout(r.repo, join(t.root, 'never-made'))).resolves.toBeUndefined();
  });
});

describe('materializeCandidate and symbolic links', () => {
  it('makes the checkout read-only without following a link out of it', async () => {
    const r = makeRepo(t.root);
    const outside = join(t.root, 'outside.txt');
    write(outside, 'outside\n', 0o644);
    symlinkSync(outside, join(r.repo, 'link-to-outside'));
    sh(r.repo, 'add', '-A');
    sh(r.repo, 'commit', '-qm', 'add link');
    const commit = sh(r.repo, 'rev-parse', 'HEAD').trim();
    const dir = await materializeCandidate(r.repo, commit, join(t.root, 'checkout'));
    // The link itself is skipped; the file it points at keeps its mode.
    expect(statSync(outside).mode & 0o777).toBe(0o644);
    expect(statSync(join(dir, 'README.md')).mode & 0o777).toBe(0o444);
    await cleanupCandidateCheckout(r.repo, dir);
    expect(existsSync(dir)).toBe(false);
  });
});
