import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertTaskBranch, createDeliveryCommit, deliveryRef, findDeliveryCommit, lsRemoteBranch, parsePushPorcelain, pushBranch, readControllerIdentity, reconcilePush, remoteHost, resolveRemoteUrl } from '../../../src/delivery/git.ts';
import { git, makeLab, type Lab } from './harness.ts';

const rules = { branchPrefix: 'orbit/', baseBranch: 'main' };
let lab: Lab;

beforeEach(() => {
  lab = makeLab();
});
afterEach(() => lab.cleanup());

const ident = { name: 'Orbit Controller', email: 'controller@example.com' };

describe('assertTaskBranch', () => {
  it('accepts task branches', () => {
    expect(() => assertTaskBranch('orbit/run-1', rules)).not.toThrow();
    expect(() => assertTaskBranch('orbit/a/b', rules)).not.toThrow();
  });

  it.each([
    ['main', 'task branches start with'],
    ['feature/x', 'task branches start with'],
    ['orbit/', 'task branches start with'],
    ['refs/heads/orbit/x', 'not a ref'],
    ['', 'empty'],
    ['orbit/..', 'valid branch name'],
    ['orbit/a b', 'valid branch name'],
    ['orbit/x.lock', 'valid branch name'],
    ['orbit/x@{1}', 'valid branch name'],
    ['orbit//x', 'valid branch name'],
    ['orbit/x~1', 'valid branch name'],
  ])('refuses %j', (branch, why) => {
    expect(() => assertTaskBranch(branch, rules)).toThrow(expect.objectContaining({ code: 'POLICY_DENIED', message: expect.stringContaining(why) }));
  });

  it('refuses the base branch even when it carries the prefix', () => {
    expect(() => assertTaskBranch('orbit/base', { branchPrefix: 'orbit/', baseBranch: 'orbit/base' })).toThrow(/base branch/);
  });
});

describe('parsePushPorcelain', () => {
  it('reads flags, refs and summaries', () => {
    const out = 'To /x/remote.git\n*\tabc:refs/heads/orbit/a\t[new branch]\n \tabc:refs/heads/orbit/b\t1..2\n!\tabc:refs/heads/orbit/c\t[rejected] (stale info)\n=\tabc:refs/heads/orbit/d\t[up to date]\nDone\n';
    expect(parsePushPorcelain(out)).toEqual([
      { flag: '*', from: 'abc', to: 'refs/heads/orbit/a', summary: '[new branch]' },
      { flag: ' ', from: 'abc', to: 'refs/heads/orbit/b', summary: '1..2' },
      { flag: '!', from: 'abc', to: 'refs/heads/orbit/c', summary: '[rejected] (stale info)' },
      { flag: '=', from: 'abc', to: 'refs/heads/orbit/d', summary: '[up to date]' },
    ]);
  });
});

describe('createDeliveryCommit', () => {
  it('commits exactly the reviewed tree with the controller identity and is deterministic', async () => {
    const c = lab.candidate('hello\n');
    const input = { repoRoot: lab.work, tree: c.treeHash, parent: lab.base, message: 'Add widget\n\nOrbit run: x', identity: ident, timeMs: 1_700_000_000_000 };
    const a = await createDeliveryCommit(input);
    const b = await createDeliveryCommit(input);
    expect(a).toBe(b);
    expect(git(lab.work, ['rev-parse', `${a}^{tree}`])).toBe(c.treeHash);
    expect(git(lab.work, ['rev-parse', `${a}^`])).toBe(lab.base);
    expect(git(lab.work, ['log', '-1', '--format=%an <%ae>|%cn <%ce>|%at', a])).toBe('Orbit Controller <controller@example.com>|Orbit Controller <controller@example.com>|1700000000');
    expect(git(lab.work, ['log', '-1', '--format=%B', a])).toContain('Orbit run: x');
  });

  it('pins the commit at the given ref and can find it again', async () => {
    const c = lab.candidate('hello\n');
    expect(await findDeliveryCommit(lab.work, lab.runId, c.treeHash, lab.base)).toBeNull();
    const commit = await createDeliveryCommit({ repoRoot: lab.work, tree: c.treeHash, parent: lab.base, message: 'm', identity: ident, timeMs: 1_700_000_000_000, ref: deliveryRef(lab.runId, c.treeHash, lab.base) });
    expect(await findDeliveryCommit(lab.work, lab.runId, c.treeHash, lab.base)).toBe(commit);
    // The same tree on another parent is a different delivery commit, found under its own ref.
    expect(await findDeliveryCommit(lab.work, lab.runId, c.treeHash, commit)).toBeNull();
    // A ref that points at a commit with some other tree is not trusted.
    git(lab.work, ['update-ref', deliveryRef(lab.runId, 'f'.repeat(40), lab.base), commit]);
    expect(await findDeliveryCommit(lab.work, lab.runId, 'f'.repeat(40), lab.base)).toBeNull();
  });

  it('refuses malformed or missing objects and empty messages', async () => {
    const c = lab.candidate('x');
    const ok = { repoRoot: lab.work, tree: c.treeHash, parent: lab.base, message: 'm', identity: ident, timeMs: 1_700_000_000_000 };
    await expect(createDeliveryCommit({ ...ok, tree: 'HEAD^{tree}' })).rejects.toMatchObject({ code: 'GIT_FAILED' });
    await expect(createDeliveryCommit({ ...ok, tree: 'a'.repeat(40) })).rejects.toThrow(/not in the repository/);
    await expect(createDeliveryCommit({ ...ok, parent: 'b'.repeat(40) })).rejects.toThrow(/not a commit/);
    await expect(createDeliveryCommit({ ...ok, parent: '--help' })).rejects.toMatchObject({ code: 'GIT_FAILED' });
    await expect(createDeliveryCommit({ ...ok, message: '  ' })).rejects.toThrow(/message/);
    await expect(createDeliveryCommit({ ...ok, identity: { name: '', email: '' } })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('is not affected by commit hooks or signing configuration', async () => {
    const c = lab.candidate('x');
    mkdirSync(join(lab.work, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(lab.work, '.git', 'hooks', 'commit-msg'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    git(lab.work, ['config', 'commit.gpgsign', 'true']);
    git(lab.work, ['config', 'gpg.program', '/usr/bin/false']);
    const commit = await createDeliveryCommit({ repoRoot: lab.work, tree: c.treeHash, parent: lab.base, message: 'm', identity: ident, timeMs: 1_700_000_000_000 });
    expect(git(lab.work, ['rev-parse', `${commit}^{tree}`])).toBe(c.treeHash);
  });
});

describe('readControllerIdentity', () => {
  it('reads the controller git configuration', async () => {
    expect(await readControllerIdentity(lab.work)).toEqual(ident);
  });

  it('refuses when no identity is configured (it is never taken from elsewhere)', async () => {
    const bare = join(lab.dir, 'noident');
    mkdirSync(bare);
    git(bare, ['init', '-b', 'main']);
    const env = { PATH: process.env.PATH, HOME: join(lab.dir, 'nohome'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    await expect(readControllerIdentity(bare, { env })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });
});

describe('pushBranch', () => {
  const push = (over: Record<string, unknown> = {}) => {
    const c = (over.commit as string | undefined) ?? lab.base;
    return pushBranch({ repoRoot: lab.work, remote: lab.remote, branch: 'orbit/t1', commit: c, ...rules, ...over });
  };

  it('creates the branch with an explicit refspec, and a repeat is up to date', async () => {
    const c = lab.candidate('a');
    const r = await push({ commit: c.commitSha });
    expect(r).toEqual({ remote: lab.remote, ref: 'refs/heads/orbit/t1', sha: c.commitSha, outcome: 'created' });
    expect(lab.remoteSha('orbit/t1')).toBe(c.commitSha);
    expect((await push({ commit: c.commitSha })).outcome).toBe('up-to-date');
  });

  it('fast-forwards an existing task branch', async () => {
    const c1 = lab.candidate('a');
    await push({ commit: c1.commitSha });
    const next = await createDeliveryCommit({ repoRoot: lab.work, tree: lab.candidate('b', 'other.txt').treeHash, parent: c1.commitSha, message: 'm', identity: ident, timeMs: 1_700_000_000_000 });
    expect((await push({ commit: next })).outcome).toBe('updated');
    expect(lab.remoteSha('orbit/t1')).toBe(next);
  });

  it('refuses the base branch, non-task branches and bad remotes before contacting anything', async () => {
    await expect(push({ branch: 'main' })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(push({ branch: 'feature/x' })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(push({ remote: '--upload-pack=evil' })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(push({ commit: 'HEAD' })).rejects.toMatchObject({ code: 'GIT_FAILED' });
    expect(lab.remoteSha('main')).toBe(lab.base);
    expect(lab.remoteSha('feature/x')).toBeNull();
  });

  it('never overwrites a diverged branch without a lease: the rejection is definitive and changes nothing', async () => {
    const a = lab.candidate('a');
    const b = lab.candidate('b');
    await push({ commit: a.commitSha });
    await expect(push({ commit: b.commitSha })).rejects.toMatchObject({ code: 'GIT_FAILED', details: { definitive: true } });
    expect(lab.remoteSha('orbit/t1')).toBe(a.commitSha);
  });

  it('forces only as a lease on the previously delivered commit', async () => {
    const a = lab.candidate('a');
    const b = lab.candidate('b');
    await push({ commit: a.commitSha });
    await expect(push({ commit: b.commitSha, force: true })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    // A stale expectation is rejected by the lease.
    await expect(push({ commit: b.commitSha, force: true, leaseSha: lab.base })).rejects.toMatchObject({ details: { definitive: true } });
    expect(lab.remoteSha('orbit/t1')).toBe(a.commitSha);
    const r = await push({ commit: b.commitSha, force: true, leaseSha: a.commitSha });
    expect(r.outcome).toBe('forced');
    expect(lab.remoteSha('orbit/t1')).toBe(b.commitSha);
  });

  it('is not blocked by a failing local pre-push hook (trusted checks already ran)', async () => {
    mkdirSync(join(lab.work, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(lab.work, '.git', 'hooks', 'pre-push'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const c = lab.candidate('a');
    await expect(push({ commit: c.commitSha })).resolves.toMatchObject({ outcome: 'created' });
  });

  it('classifies an unreachable remote as transient and an authentication refusal as AUTH_EXPIRED', async () => {
    const c = lab.candidate('a');
    await expect(push({ commit: c.commitSha, remote: join(lab.dir, 'does-not-exist.git') })).rejects.toMatchObject({ code: expect.stringMatching(/GIT_FAILED|PROVIDER_TRANSIENT/) });
    // A hook on the remote that prints an authentication failure.
    mkdirSync(join(lab.remote, 'hooks'), { recursive: true });
    writeFileSync(join(lab.remote, 'hooks', 'pre-receive'), '#!/bin/sh\necho "remote: Permission denied to bot" >&2\nexit 1\n', { mode: 0o755 });
    await expect(push({ commit: c.commitSha })).rejects.toMatchObject({ code: 'AUTH_EXPIRED', details: { definitive: true } });
  });
});

describe('lsRemoteBranch and reconcilePush', () => {
  it('matches the full ref name only, not the tail of another ref', async () => {
    git(lab.work, ['push', 'origin', `${lab.base}:refs/heads/x/orbit/run-1`]);
    expect(await lsRemoteBranch({ repoRoot: lab.work, remote: lab.remote, branch: 'orbit/run-1' })).toBeNull();
    git(lab.work, ['push', 'origin', `${lab.base}:refs/heads/orbit/run-1`]);
    expect(await lsRemoteBranch({ repoRoot: lab.work, remote: lab.remote, branch: 'orbit/run-1' })).toBe(lab.base);
  });

  it('reconciles a push by comparing the remote sha to the intended commit', async () => {
    const a = lab.candidate('a');
    const o = { repoRoot: lab.work, remote: lab.remote, branch: 'orbit/t1' };
    expect(await reconcilePush({ ...o, commit: a.commitSha })).toBeNull();
    git(lab.work, ['push', 'origin', `${a.commitSha}:refs/heads/orbit/t1`]);
    expect(await reconcilePush({ ...o, commit: a.commitSha })).toMatchObject({ sha: a.commitSha, ref: 'refs/heads/orbit/t1' });
    // The branch holds something else: this push did not land.
    expect(await reconcilePush({ ...o, commit: lab.candidate('b').commitSha })).toBeNull();
  });

  it('surfaces an unreachable remote instead of reporting "absent"', async () => {
    await expect(lsRemoteBranch({ repoRoot: lab.work, remote: join(lab.dir, 'missing.git'), branch: 'orbit/x' })).rejects.toBeTruthy();
  });
});

describe('remote resolution for network authorization', () => {
  it('derives the host from every remote address form git accepts', () => {
    expect(remoteHost('https://x-access-token:secret@github.com/acme/app.git')).toBe('github.com');
    expect(remoteHost('ssh://git@github.com:22/acme/app.git')).toBe('github.com');
    expect(remoteHost('git@github.com:acme/app.git')).toBe('github.com');
    expect(remoteHost('github.com:acme/app.git')).toBe('github.com');
    expect(remoteHost('/srv/git/app.git')).toBeNull();
    expect(remoteHost('./relative/app.git')).toBeNull();
    expect(remoteHost('file:///srv/git/app.git')).toBeNull();
  });

  it('resolves a remote name to its push URL, and refuses one that does not exist', async () => {
    {
      expect(await resolveRemoteUrl(lab.work, 'origin')).toBe(lab.remote);
      git(lab.work, ['remote', 'set-url', '--push', 'origin', 'https://evil.example/acme/app.git']);
      expect(await resolveRemoteUrl(lab.work, 'origin')).toBe('https://evil.example/acme/app.git');
      expect(await resolveRemoteUrl(lab.work, lab.remote)).toBe(lab.remote);
      await expect(resolveRemoteUrl(lab.work, 'nosuchremote')).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    }
  });
});
