import { chmodSync, existsSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupCandidateCheckout, materializeCandidate, snapshotCandidate, candidateRef } from '../../../src/evidence/candidate.ts';
import { listCandidates } from '../../../src/evidence/store.ts';
import { isOrbitError } from '../../../src/core/errors.ts';
import { ManualClock } from '../../../src/core/clock.ts';
import { addWorktree, checkDef, makeRepo, makeRun, sh, tempRoot, write, type TestRepo, type TestRun } from '../../unit/evidence/fixtures.ts';

describe('snapshotCandidate', () => {
  let t: ReturnType<typeof tempRoot>;
  let r: TestRepo;
  let wt: string;
  let run: TestRun;
  const clock = new ManualClock();

  beforeEach(() => {
    t = tempRoot();
    r = makeRepo(t.root);
    wt = addWorktree(r.repo, join(t.root, 'wt', 'w1'));
    run = makeRun(t.root, r.repo, [checkDef('unit')], { clock });
  });
  afterEach(() => {
    run.db.close();
    t.remove();
  });

  const snap = (over: Partial<Parameters<typeof snapshotCandidate>[0]> = {}) =>
    snapshotCandidate({ db: run.db, clock, repoRoot: r.repo, worktree: wt, runId: run.runId, baseRev: r.base, attempt: 1, workerId: 'w1', ...over });

  it('commits the worktree content on the base under a pinned ref with a fixed identity', async () => {
    write(join(wt, 'src', 'a.txt'), 'two\n');
    write(join(wt, 'src', 'new.sh'), '#!/bin/sh\n', 0o755);
    rmSync(join(wt, 'README.md'));
    const c = await snap();
    expect(c.created).toBe(true);
    expect(c.seq).toBe(1);
    expect(c.parentSha).toBe(r.base);
    expect(c.status).toBe('READY');
    expect(sh(r.repo, 'rev-parse', `${c.commitSha}^{tree}`).trim()).toBe(c.treeHash);
    expect(sh(r.repo, 'rev-parse', `${c.commitSha}^`).trim()).toBe(r.base);
    expect(sh(r.repo, 'rev-parse', candidateRef(run.runId, 1)).trim()).toBe(c.commitSha);
    expect(sh(r.repo, 'log', '-1', '--format=%an <%ae>|%cn <%ce>', c.commitSha).trim()).toBe('Orbit <orbit@orbit.invalid>|Orbit <orbit@orbit.invalid>');
    expect(sh(r.repo, 'show', `${c.commitSha}:src/a.txt`)).toBe('two\n');
    expect(sh(r.repo, 'ls-tree', c.commitSha, 'src/new.sh')).toMatch(/^100755 /);
    expect(sh(r.repo, 'ls-tree', '-r', '--name-only', c.commitSha).split('\n').filter(Boolean).sort()).toEqual(['src/a.txt', 'src/new.sh']);
    expect(c.diffStat).toMatchObject({ files: 3, insertions: 2, deletions: 2, binaryFiles: 0 });
    expect(c.diffStat?.paths.sort()).toEqual(['README.md', 'src/a.txt', 'src/new.sh']);
  });

  it('never touches the worktree index, HEAD or branch, and ignores what is staged there', async () => {
    write(join(wt, 'staged.txt'), 'staged content\n');
    sh(wt, 'add', 'staged.txt');
    write(join(wt, 'staged.txt'), 'different on disk\n');
    const indexFile = sh(wt, 'rev-parse', '--path-format=absolute', '--git-path', 'index').trim();
    // `git status` itself refreshes the index, so it runs before the baseline reading.
    const status = sh(wt, 'status', '--porcelain=v2');
    const before = { index: readFileSync(indexFile), mtime: statSync(indexFile).mtimeMs, head: sh(wt, 'rev-parse', 'HEAD'), status, refs: sh(r.repo, 'for-each-ref', 'refs/heads') };
    const c = await snap();
    expect(sh(r.repo, 'show', `${c.commitSha}:staged.txt`)).toBe('different on disk\n');
    expect(readFileSync(indexFile).equals(before.index)).toBe(true);
    expect(statSync(indexFile).mtimeMs).toBe(before.mtime);
    expect(sh(wt, 'rev-parse', 'HEAD')).toBe(before.head);
    expect(sh(r.repo, 'for-each-ref', 'refs/heads')).toBe(before.refs);
  });

  it('is idempotent: unchanged content returns the existing candidate, even after a revert', async () => {
    write(join(wt, 'src', 'a.txt'), 'two\n');
    const first = await snap();
    const again = await snap();
    expect(again.created).toBe(false);
    expect(again.id).toBe(first.id);
    expect(again.commitSha).toBe(first.commitSha);

    write(join(wt, 'src', 'a.txt'), 'two!\n');
    const second = await snap({ attempt: 2 });
    expect(second.seq).toBe(2);
    expect(second.treeHash).not.toBe(first.treeHash);

    write(join(wt, 'src', 'a.txt'), 'two\n');
    const reverted = await snap({ attempt: 3 });
    expect(reverted.id).toBe(first.id);
    expect(listCandidates(run.db, run.runId).map((c) => c.seq)).toEqual([1, 2]);
  });

  it('gives two concurrent snapshots of the same content one candidate with one commit', async () => {
    write(join(wt, 'src', 'a.txt'), 'racing\n');
    const [a, b] = await Promise.all([snap(), snap()]);
    expect(a.id).toBe(b.id);
    expect(a.commitSha).toBe(b.commitSha);
    expect(listCandidates(run.db, run.runId)).toHaveLength(1);
  });

  it('changes the tree for a single byte and for a mode change', async () => {
    const empty = await snap();
    expect(empty.treeHash).toBe(r.baseTree);
    expect(empty.diffStat?.files).toBe(0);
    write(join(wt, 'src', 'a.txt'), 'one\n ');
    const byte = await snap();
    expect(byte.treeHash).not.toBe(r.baseTree);
    write(join(wt, 'src', 'a.txt'), 'one\n');
    chmodSync(join(wt, 'src', 'a.txt'), 0o755);
    const mode = await snap();
    expect(mode.treeHash).not.toBe(r.baseTree);
    expect(mode.treeHash).not.toBe(byte.treeHash);
  });

  it('respects gitignore, info/exclude and the built-in noise list but keeps tracked files and untracked source', async () => {
    write(join(r.repo, '.gitignore'), 'build/\n');
    sh(r.repo, 'add', '.gitignore');
    sh(r.repo, 'commit', '-qm', 'ignore');
    const base2 = sh(r.repo, 'rev-parse', 'HEAD').trim();
    sh(wt, 'checkout', '-q', '--detach', base2);
    write(join(wt, 'build', 'out.js'), 'x');
    write(join(wt, 'node_modules', 'dep', 'index.js'), 'x');
    write(join(wt, '.DS_Store'), 'x');
    write(join(wt, 'src', 'keep.ts'), 'x');
    write(join(wt, 'private.log'), 'x');
    writeFileSync(join(sh(r.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim(), 'info', 'exclude'), '*.log\n', { flag: 'a' });
    const c = await snap({ baseRev: base2 });
    expect(sh(r.repo, 'ls-tree', '-r', '--name-only', c.commitSha).split('\n').filter(Boolean).sort()).toEqual(['.gitignore', 'README.md', 'src/a.txt', 'src/keep.ts']);
  });

  it('cannot be redirected by a worker rewriting the worktree .git file', async () => {
    const other = makeRepo(t.root, { 'other.txt': 'secret\n' }, 'other');
    write(join(wt, 'src', 'a.txt'), 'honest\n');
    writeFileSync(join(wt, '.git'), `gitdir: ${join(other.repo, '.git')}\n`);
    const c = await snap();
    expect(sh(r.repo, 'show', `${c.commitSha}:src/a.txt`)).toBe('honest\n');
    expect(sh(r.repo, 'ls-tree', '-r', '--name-only', c.commitSha)).not.toContain('other.txt');
  });

  it('refuses a directory that is not a registered worktree, an unknown base and an option-like revision', async () => {
    const stray = join(t.root, 'stray');
    write(join(stray, 'x.txt'), 'x');
    await expect(snap({ worktree: stray })).rejects.toMatchObject({ code: 'GIT_FAILED' });
    await expect(snap({ baseRev: 'no-such-branch' })).rejects.toMatchObject({ code: 'GIT_FAILED' });
    await expect(snap({ baseRev: '--output=/tmp/x' })).rejects.toSatisfy((e) => isOrbitError(e, 'GIT_FAILED'));
    await expect(snap({ runId: 'a/../b' })).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(listCandidates(run.db, run.runId)).toHaveLength(0);
  });

  it('resumes a candidate whose commit was never written (crash after reserving the seq)', async () => {
    write(join(wt, 'src', 'a.txt'), 'crashy\n');
    const first = await snap();
    run.db.run("UPDATE candidates SET status = 'CREATING', commit_sha = '' WHERE id = ?", first.id);
    sh(r.repo, 'update-ref', '-d', candidateRef(run.runId, 1));
    const resumed = await snap();
    expect(resumed.id).toBe(first.id);
    expect(resumed.status).toBe('READY');
    expect(resumed.created).toBe(true);
    expect(sh(r.repo, 'rev-parse', candidateRef(run.runId, 1)).trim()).toBe(resumed.commitSha);
    expect(resumed.commitSha).toBe(first.commitSha);
  });

  it('keeps a symlink as a link and does not follow it', async () => {
    symlinkSync('/etc/hosts', join(wt, 'link'));
    const c = await snap();
    expect(sh(r.repo, 'ls-tree', c.commitSha, 'link')).toMatch(/^120000 /);
  });
});

describe('materializeCandidate', () => {
  let t: ReturnType<typeof tempRoot>;
  beforeEach(() => {
    t = tempRoot();
  });
  afterEach(() => t.remove());

  it('makes a clean read-only detached checkout without running repository hooks, and cleans it up', async () => {
    const r = makeRepo(t.root);
    const marker = join(t.root, 'hook-ran');
    write(join(r.repo, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\necho ran > ${marker}\n`, 0o755);
    const dir = join(t.root, 'checkouts', 'c1');
    const real = await materializeCandidate(r.repo, r.base, dir);
    expect(readFileSync(join(real, 'src', 'a.txt'), 'utf8')).toBe('one\n');
    expect(existsSync(marker)).toBe(false);
    expect(sh(real, 'status', '--porcelain')).toBe('');
    expect(sh(real, 'rev-parse', 'HEAD').trim()).toBe(r.base);
    expect(() => writeFileSync(join(real, 'src', 'a.txt'), 'edit')).toThrow(/EACCES|EPERM/);
    expect(() => writeFileSync(join(real, 'new.txt'), 'edit')).toThrow(/EACCES|EPERM/);
    expect(sh(r.repo, 'worktree', 'list')).toContain(real);

    await cleanupCandidateCheckout(r.repo, real);
    expect(existsSync(real)).toBe(false);
    expect(sh(r.repo, 'worktree', 'list')).not.toContain(real);
  });

  it('can leave the checkout writable for checks that build, and refuses a non-empty target', async () => {
    const r = makeRepo(t.root);
    const dir = join(t.root, 'c2');
    const real = await materializeCandidate(r.repo, r.base, dir, { readOnly: false });
    writeFileSync(join(real, 'built.txt'), 'ok');
    await expect(materializeCandidate(r.repo, r.base, real)).rejects.toMatchObject({ code: 'GIT_FAILED' });
    await cleanupCandidateCheckout(r.repo, real);
  });

  it('checks out exactly the candidate commit, without worker leftovers', async () => {
    const r = makeRepo(t.root);
    const wt = addWorktree(r.repo, join(t.root, 'wt', 'w1'));
    const clock = new ManualClock();
    const run = makeRun(t.root, r.repo, [checkDef('unit')], { clock });
    write(join(wt, 'src', 'a.txt'), 'changed\n');
    write(join(wt, 'build', 'junk'), 'x');
    write(join(r.repo, '.gitignore'), 'build/\n');
    const c = await snapshotCandidate({ db: run.db, clock, repoRoot: r.repo, worktree: wt, runId: run.runId, baseRev: r.base, attempt: 1, workerId: null });
    const real = await materializeCandidate(r.repo, c.commitSha, join(t.root, 'c3'));
    expect(readFileSync(join(real, 'src', 'a.txt'), 'utf8')).toBe('changed\n');
    expect(sh(real, 'rev-parse', 'HEAD^{tree}').trim()).toBe(c.treeHash);
    await cleanupCandidateCheckout(r.repo, real);
    run.db.close();
  });
});
