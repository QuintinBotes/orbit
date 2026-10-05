import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertTaskBranch, createDeliveryCommit, fetchBranchContaining, gitEnv, lsRemoteBranch, pushBranch, remoteHost, resolveRemoteUrl } from '../../../src/delivery/git.ts';
import { git, makeLab, type Lab } from '../../integration/delivery/harness.ts';

let lab: Lab;
beforeEach(() => {
  lab = makeLab();
});
afterEach(() => {
  vi.unstubAllEnvs();
  lab.cleanup();
});

const REAL_GIT = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const ident = { name: 'Orbit Controller', email: 'controller@example.com' };

/**
 * A `git` that first runs `intercept` (shell, sees "$@" and may exit), and otherwise runs the real one.
 * Every call is appended to calls.log, with GH_TOKEN when it is set. The fake directory is put first on this
 * process's PATH too, because delivery builds its own environment for some commands (commit-tree).
 */
function fakeGit(intercept: string): { env: Record<string, string | undefined>; calls: () => string[] } {
  const bin = join(lab.dir, 'fakebin');
  mkdirSync(bin, { recursive: true });
  const log = join(lab.dir, 'calls.log');
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf '%s|GH_TOKEN=%s\\n' "$*" "$GH_TOKEN" >> '${log}'\n${intercept}\nexec '${REAL_GIT}' "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);
  vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
  return {
    env: gitEnv(),
    calls: () => {
      try {
        return readFileSync(log, 'utf8').split('\n').filter(Boolean);
      } catch {
        return [];
      }
    },
  };
}

describe('assertTaskBranch without a configured prefix', () => {
  it('refuses every branch when repository.branch_prefix is empty', () => {
    expect(() => assertTaskBranch('orbit/x', { branchPrefix: '', baseBranch: 'main' })).toThrow(expect.objectContaining({ code: 'POLICY_DENIED', message: expect.stringContaining('no branch prefix is configured') }));
  });
});

describe('remoteHost on addresses that cannot be trusted', () => {
  it('refuses a URL that does not parse and a non-file URL that names no host', () => {
    expect(() => remoteHost('https://[::1')).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID', message: expect.stringContaining('cannot be parsed') }));
    expect(() => remoteHost('ssh:///srv/repo.git')).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID', message: expect.stringContaining('names no host') }));
  });
});

describe('resolveRemoteUrl', () => {
  it('refuses a remote that answers with several push URLs, or with none', async () => {
    // Real git prints only the first push URL without --all, so the guard is exercised with a git that prints more.
    const many = fakeGit(`case "$1 $2" in 'remote get-url') printf '/a/one.git\\n/b/two.git\\n'; exit 0;; esac`);
    await expect(resolveRemoteUrl(lab.work, 'origin', { env: many.env })).rejects.toMatchObject({ code: 'CONFIG_INVALID', message: expect.stringContaining('remote origin has 2 push URLs; delivery needs exactly one') });
    const none = fakeGit(`case "$1 $2" in 'remote get-url') exit 0;; esac`);
    await expect(resolveRemoteUrl(lab.work, 'origin', { env: none.env })).rejects.toMatchObject({ message: expect.stringContaining('has 0 push URLs') });
  });
});

describe('createDeliveryCommit when git misbehaves', () => {
  // The candidate is made with the real git, before any test puts a fake one on PATH.
  let c: ReturnType<Lab['candidate']>;
  beforeEach(() => {
    c = lab.candidate('x');
  });
  const commit = (env: Record<string, string | undefined>, over: { ref?: string } = {}) => {
    return createDeliveryCommit({ repoRoot: lab.work, tree: c.treeHash, parent: c.parentSha, message: 'msg', identity: ident, timeMs: 1_700_000_000_000, env, ...over });
  };

  it('reports git commit-tree failing, with its exit status and stderr', async () => {
    const f = fakeGit(`case "$1" in commit-tree) echo 'fatal: disk full' >&2; exit 3;; esac`);
    await expect(commit(f.env)).rejects.toMatchObject({ code: 'GIT_FAILED', message: expect.stringMatching(/git commit-tree failed \(exit 3\): fatal: disk full/) });
  });

  it('names the signal when git was killed and has no exit status', async () => {
    const f = fakeGit(`case "$1" in commit-tree) kill -9 $$;; esac`);
    await expect(commit(f.env)).rejects.toMatchObject({ message: expect.stringMatching(/git commit-tree failed \(exit SIGKILL\)/) });
  });

  it('refuses a commit-tree answer that is not an object id', async () => {
    const f = fakeGit(`case "$1" in commit-tree) echo 'not-a-sha'; exit 0;; esac`);
    await expect(commit(f.env)).rejects.toMatchObject({ code: 'GIT_FAILED', message: expect.stringContaining('printed an unexpected value: not-a-sha') });
  });

  it('refuses a commit whose tree is not the reviewed tree', async () => {
    const f = fakeGit(`case "$1" in rev-parse) case "$2" in *'^{tree}') echo ${'d'.repeat(40)}; exit 0;; esac;; esac`);
    await expect(commit(f.env)).rejects.toMatchObject({ code: 'GIT_FAILED', details: expect.objectContaining({ definitive: true }), message: expect.stringContaining(`has tree ${'d'.repeat(40)}, not the reviewed tree`) });
  });

  it('refuses a commit whose tree cannot be read back', async () => {
    const f = fakeGit(`case "$1" in rev-parse) case "$2" in *'^{tree}') exit 9;; esac;; esac`);
    await expect(commit(f.env)).rejects.toMatchObject({ code: 'GIT_FAILED', message: expect.stringContaining('has tree , not the reviewed tree') });
  });

  it('reports a pin ref that cannot be written', async () => {
    const f = fakeGit(`case "$1" in update-ref) echo 'fatal: cannot lock ref' >&2; exit 1;; esac`);
    await expect(commit(f.env, { ref: 'refs/orbit/x/pin' })).rejects.toMatchObject({ code: 'GIT_FAILED', message: expect.stringMatching(/git update-ref failed \(exit 1\): fatal: cannot lock ref/) });
  });
});

describe('pushBranch edge cases', () => {
  const base = () => ({ repoRoot: lab.work, remote: 'origin', branchPrefix: 'orbit/', baseBranch: 'main' });

  it('refuses a commit the local repository does not have, before contacting the remote', async () => {
    const f = fakeGit('');
    await expect(pushBranch({ ...base(), branch: 'orbit/x', commit: '1'.repeat(40), env: f.env })).rejects.toMatchObject({ code: 'GIT_FAILED', message: expect.stringContaining(`commit ${'1'.repeat(40)} is not in the repository`) });
    expect(f.calls().some((c) => c.startsWith('push'))).toBe(false);
  });

  it('does not take a silent success for a landed push when git reports nothing about the ref', async () => {
    const c = lab.candidate('x');
    const f = fakeGit(`case "$1" in push) exit 0;; esac`);
    await expect(pushBranch({ ...base(), branch: 'orbit/x', commit: c.commitSha, env: f.env })).rejects.toMatchObject({ code: 'GIT_FAILED', message: expect.stringContaining('reported success but no result for refs/heads/orbit/x') });
    expect(lab.remoteSha('orbit/x')).toBeNull();
  });
});

describe('remote failures are classified', () => {
  it('a name-resolution failure is transient and a hung git is transient too', async () => {
    const dns = fakeGit(`case "$1" in ls-remote) echo "fatal: unable to access 'https://h.test/x.git/': Could not resolve host: h.test" >&2; exit 128;; esac`);
    await expect(lsRemoteBranch({ repoRoot: lab.work, remote: 'origin', branch: 'orbit/x', env: dns.env })).rejects.toMatchObject({ code: 'PROVIDER_TRANSIENT', message: expect.stringContaining('Could not resolve host') });

    const hung = fakeGit(`case "$1" in ls-remote) sleep 5;; esac`);
    await expect(lsRemoteBranch({ repoRoot: lab.work, remote: 'origin', branch: 'orbit/x', env: hung.env, timeoutMs: 100 })).rejects.toMatchObject({ code: 'PROVIDER_TRANSIENT' });
  });

  it('a refusal for lack of credentials is AUTH_EXPIRED and definitive', async () => {
    const f = fakeGit(`case "$1" in ls-remote) echo 'remote: HTTP 401 Bad credentials' >&2; exit 128;; esac`);
    await expect(lsRemoteBranch({ repoRoot: lab.work, remote: 'origin', branch: 'orbit/x', env: f.env })).rejects.toMatchObject({ code: 'AUTH_EXPIRED', details: expect.objectContaining({ definitive: true }) });
  });
});

describe('a token is handed to git only through the credential helper, for that command', () => {
  it('uses gh by default and a given gh path otherwise, resetting the helper list first', async () => {
    const f = fakeGit('');
    expect(await lsRemoteBranch({ repoRoot: lab.work, remote: 'origin', branch: 'main', token: 'tok-1', env: f.env })).toBe(lab.base);
    expect(await lsRemoteBranch({ repoRoot: lab.work, remote: 'origin', branch: 'main', token: 'tok-2', ghPath: '/opt/acme/gh', env: f.env })).toBe(lab.base);
    const [first, second] = f.calls();
    expect(first).toContain('-c credential.helper= -c credential.helper=!gh auth git-credential ls-remote');
    expect(first).toContain('GH_TOKEN=tok-1');
    expect(second).toContain('credential.helper=!/opt/acme/gh auth git-credential');
    expect(second).toContain('GH_TOKEN=tok-2');
  });

  it('works with the default environment too, and a lookup without a token passes no helper', async () => {
    expect(await lsRemoteBranch({ repoRoot: lab.work, remote: 'origin', branch: 'main', token: 'tok-3' })).toBe(lab.base);
    const f = fakeGit('');
    await lsRemoteBranch({ repoRoot: lab.work, remote: 'origin', branch: 'main', env: f.env });
    expect(f.calls()[0]).not.toContain('credential.helper');
    expect(f.calls()[0]).toMatch(/GH_TOKEN=$/);
  });
});

describe('fetchBranchContaining', () => {
  const REF = 'refs/orbit/r1/merged';
  const args = (over: Partial<Parameters<typeof fetchBranchContaining>[0]> = {}) => ({ repoRoot: lab.work, remote: 'origin', branch: 'main', commit: lab.base, ref: REF, ...over });

  it('refuses a commit that is not a full object id, a ref outside refs/orbit and a branch that is not a name', async () => {
    await expect(fetchBranchContaining(args({ commit: 'main' }))).rejects.toMatchObject({ code: 'INTERNAL', message: expect.stringContaining('not a full commit sha') });
    await expect(fetchBranchContaining(args({ ref: 'refs/heads/main' }))).rejects.toMatchObject({ code: 'INTERNAL', message: expect.stringContaining('private refs/orbit/ ref') });
    await expect(fetchBranchContaining(args({ ref: 'refs/orbit/a..b' }))).rejects.toMatchObject({ code: 'INTERNAL' });
    await expect(fetchBranchContaining(args({ branch: '-x' }))).rejects.toMatchObject({ code: 'CONFIG_INVALID', message: expect.stringContaining('not a valid branch name') });
    await expect(fetchBranchContaining(args({ branch: 'a..b' }))).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('returns the tip when the commit is the tip, and when it is an ancestor of the tip', async () => {
    expect(await fetchBranchContaining(args())).toBe(lab.base);
    const c = lab.candidate('merged\n');
    git(lab.work, ['push', 'origin', `${c.commitSha}:refs/heads/main`]);
    expect(await fetchBranchContaining(args())).toBe(c.commitSha);
    expect(git(lab.work, ['rev-parse', REF])).toBe(c.commitSha);
  });

  it('refuses a commit that is not on the branch', async () => {
    const c = lab.candidate('elsewhere\n');
    await expect(fetchBranchContaining(args({ commit: c.commitSha }))).rejects.toMatchObject({ code: 'DELIVERY_FAILED', details: expect.objectContaining({ definitive: true, tip: lab.base }), message: expect.stringContaining('is not on main') });
  });

  it('reports a fetch the remote refuses and a fetch that leaves no commit behind', async () => {
    await expect(fetchBranchContaining(args({ branch: 'nonexistent' }))).rejects.toMatchObject({ code: 'GIT_FAILED', message: expect.stringContaining('git fetch failed') });
    const f = fakeGit(`case "$1 $2" in 'rev-parse --verify') exit 0;; esac`);
    await expect(fetchBranchContaining(args({ env: f.env }))).rejects.toMatchObject({ code: 'GIT_FAILED', message: expect.stringContaining(`produced no commit at ${REF}`) });
  });
});
