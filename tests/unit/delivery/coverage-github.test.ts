import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecResult } from '../../../src/core/exec.ts';
import {
  FakeGitHub,
  GhCliClient,
  classifyGhFailure,
  parseAuthStatus,
  parseChecks,
  parseFailedSteps,
  parseMergeState,
  parsePullRequest,
  parseRunListAsChecks,
  type GhRunner,
} from '../../../src/delivery/github.ts';
import { git, makeLab, type Lab } from '../../integration/delivery/harness.ts';

const TOKEN = 'github_pat_scopedtokenvalue0123456789';
const PR = { number: 7, url: 'https://github.com/acme/app/pull/7', headRefName: 'orbit/r1', headRefOid: 'a'.repeat(40), baseRefName: 'main', isDraft: true, state: 'OPEN', title: 't', body: 'b' };

function res(over: Partial<ExecResult>): ExecResult {
  return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, cancelled: false, durationMs: 1, stdoutTruncated: false, stderrTruncated: false, pid: 1, ...over };
}
function client(runner: GhRunner, env: Record<string, string | undefined> = { PATH: '/bin', GH_TOKEN: TOKEN }) {
  return new GhCliClient({ repo: 'acme/app', env, runner });
}
const timedOut = async () => res({ exitCode: null, signal: 'SIGKILL', timedOut: true });

describe('parsers: malformed and sparse input', () => {
  it('refuses input that is not an object, and accepts a PR with no title or body as empty strings', () => {
    expect(() => parsePullRequest('text')).toThrow(expect.objectContaining({ code: 'MALFORMED_OUTPUT', message: expect.stringContaining('expected an object') }));
    expect(() => parsePullRequest(null)).toThrow(/expected an object/);
    expect(() => parsePullRequest([PR])).toThrow(/expected an object/);
    const { title: _t, body: _b, ...sparse } = PR;
    expect(parsePullRequest(sparse)).toMatchObject({ title: '', body: '' });
    expect(parsePullRequest({ ...sparse, title: null, body: null })).toMatchObject({ title: '', body: '' });
  });

  it('parseMergeState refuses an unknown state and a bad number, and reads a merge commit only when merged', () => {
    const view = { number: 7, state: 'merged', headRefOid: 'a'.repeat(40), baseRefName: 'main', mergeCommit: { oid: 'b'.repeat(40) }, mergedAt: '2026-01-01T00:00:00Z' };
    expect(() => parseMergeState({ ...view, state: 'WEIRD' })).toThrow(/unknown state "WEIRD"/);
    expect(() => parseMergeState({ ...view, number: 0 })).toThrow(/positive integer/);
    expect(() => parseMergeState({ ...view, number: 1.5 })).toThrow(/positive integer/);
    expect(parseMergeState(view)).toMatchObject({ state: 'MERGED', mergeCommitSha: 'b'.repeat(40), mergedAt: '2026-01-01T00:00:00Z' });
    expect(parseMergeState({ ...view, state: 'OPEN', mergedAt: '' })).toMatchObject({ mergeCommitSha: null, mergedAt: null });
    expect(parseMergeState({ ...view, mergeCommit: null, mergedAt: undefined })).toMatchObject({ mergeCommitSha: null, mergedAt: null });
  });

  it('parseRunListAsChecks needs an array of runs with numeric ids and maps each field', () => {
    expect(() => parseRunListAsChecks('{}')).toThrow(/expected an array/);
    expect(() => parseRunListAsChecks('[{"databaseId":"5"}]')).toThrow(/databaseId/);
    const rows = parseRunListAsChecks(
      JSON.stringify([
        { databaseId: 1, status: 'completed', conclusion: 'success', workflowName: 'ci', url: 'https://x/runs/1', startedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:05:00Z' },
        { databaseId: 2, status: 'in_progress', conclusion: '', name: 'deploy', updatedAt: '2026-01-01T00:06:00Z' },
        { databaseId: 3, status: 7, conclusion: 7 },
        { databaseId: 4, status: 'completed', conclusion: 'weird', workflowName: '', name: '' },
      ]),
    );
    expect(rows[0]).toMatchObject({ name: 'ci', bucket: 'pass', state: 'SUCCESS', link: 'https://x/runs/1', workflow: 'ci', runId: '1', startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:05:00Z' });
    // Still running: no completion time even though the host reports an update time.
    expect(rows[1]).toMatchObject({ name: 'deploy', bucket: 'pending', state: 'IN_PROGRESS', link: null, workflow: null, startedAt: null, completedAt: null });
    expect(rows[2]).toMatchObject({ name: 'run 3', bucket: 'pending', state: '' });
    expect(rows[3]).toMatchObject({ name: 'run 4', bucket: 'fail', completedAt: null });
  });

  it('parseFailedSteps tolerates jobs and steps that are missing or odd', () => {
    expect(parseFailedSteps('{}')).toEqual([]);
    expect(parseFailedSteps('{"jobs":"none"}')).toEqual([]);
    const out = parseFailedSteps(
      JSON.stringify({
        jobs: [
          { conclusion: 'failure', steps: 'oops' },
          { name: 'lint', conclusion: 'failure', steps: [null, 'x', { conclusion: 'success' }] },
          { name: 'build', steps: [{ name: 'compile', conclusion: 'failure' }, { conclusion: 'failure' }] },
        ],
      }),
    );
    expect(out).toEqual([
      { job: '', step: '' },
      { job: 'lint', step: '' },
      { job: 'build', step: 'compile' },
      { job: 'build', step: '' },
    ]);
  });

  it('parseAuthStatus handles a missing hosts object, odd fields, and every reason for not ok', () => {
    expect(parseAuthStatus('{}', 'github.com', true)).toMatchObject({ ok: false, error: 'no active account for github.com' });
    const entry = (e: Record<string, unknown>) => JSON.stringify({ hosts: { 'github.com': [{ active: true, ...e }] } });
    expect(parseAuthStatus(entry({ state: 'success', tokenSource: 7, login: '', scopes: 5 }), 'github.com', false)).toEqual({ ok: true, login: null, tokenSource: null, scopes: null, error: null });
    expect(parseAuthStatus(entry({ state: 'error', error: `bad token ${TOKEN}` }), 'github.com', true).error).not.toContain(TOKEN);
    expect(parseAuthStatus(entry({ state: 'timeout' }), 'github.com', true).error).toBe('state timeout');
    expect(parseAuthStatus(entry({ state: 'error', error: '' }), 'github.com', true).error).toBe('state error');
    expect(parseAuthStatus(entry({ state: 'success' }), 'github.com', true).error).toBe('the active credential comes from an unknown source, not a scoped GH_TOKEN');
    expect(parseAuthStatus(entry({ state: 'success', tokenSource: 'keyring' }), 'github.com', true).error).toContain('comes from keyring');
  });

  it('parseChecks needs an array and reads a check with no state as an empty state', () => {
    expect(() => parseChecks('{}')).toThrow(expect.objectContaining({ code: 'MALFORMED_OUTPUT', message: expect.stringContaining('expected an array') }));
    expect(parseChecks(JSON.stringify([{ name: 'build', bucket: 'pass', state: 7 }]))[0]).toMatchObject({ name: 'build', state: '' });
  });

  it('classifyGhFailure names a missing exit status as a signal', () => {
    expect(classifyGhFailure('pr list', null, 'something odd').message).toContain('(exit signal)');
  });
});

describe('GhCliClient: timeouts, defaults and argument checks', () => {
  it('takes GH_TOKEN from the process environment when no environment is given', async () => {
    vi.stubEnv('GH_TOKEN', 'from-process-env');
    try {
      let seen: string | undefined;
      const c = new GhCliClient({ repo: 'acme/app', runner: async (_argv, o) => ((seen = o.env.GH_TOKEN), res({ stdout: '[]' })) });
      await c.findPullRequest('orbit/r1');
      expect(seen).toBe('from-process-env');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('reports a hung gh as transient for every command that can hang', async () => {
    const c = client(timedOut);
    await expect(c.findPullRequest('orbit/r1')).rejects.toMatchObject({ code: 'PROVIDER_TRANSIENT', message: expect.stringContaining('pr list timed out') });
    await expect(c.createPullRequest({ head: 'orbit/r1', base: 'main', title: 't', body: 'b', draft: false })).rejects.toMatchObject({ code: 'PROVIDER_TRANSIENT', message: expect.stringContaining('pr create timed out') });
    await expect(c.mergePullRequest({ number: 7, headSha: 'a'.repeat(40), method: 'squash', deleteBranch: false })).rejects.toMatchObject({ code: 'PROVIDER_TRANSIENT', message: expect.stringContaining('pr merge timed out') });
    await expect(c.listChecks({ pr: 7 })).rejects.toMatchObject({ code: 'PROVIDER_TRANSIENT', message: expect.stringContaining('pr checks timed out') });
    await expect(c.failedLogs('5')).rejects.toMatchObject({ code: 'PROVIDER_TRANSIENT', message: expect.stringContaining('run view timed out') });
  });

  it('prefers the newest of several open PRs for a head', async () => {
    const c = client(async () => res({ stdout: JSON.stringify([{ ...PR, number: 3 }, { ...PR, number: 9 }, { ...PR, number: 5 }]) }));
    expect((await c.findPullRequest('orbit/r1'))!.number).toBe(9);
  });

  it('adopts the PR listed for the head when create exits 0 without printing a URL, and fails when none is listed', async () => {
    const out = (argv: readonly string[]) => (argv[2] === 'create' ? res({ stdout: 'Creating pull request...\n' }) : res({ stdout: JSON.stringify([PR]) }));
    expect((await client(async (argv) => out(argv)).createPullRequest({ head: 'orbit/r1', base: 'main', title: 't', body: 'b', draft: false })).number).toBe(7);
    const none = client(async (argv) => (argv[2] === 'create' ? res({ stdout: '' }) : res({ stdout: '[]' })));
    await expect(none.createPullRequest({ head: 'orbit/r1', base: 'main', title: 't', body: 'b', draft: false })).rejects.toMatchObject({ code: 'DELIVERY_FAILED', message: expect.stringContaining('no pull request URL was printed') });
  });

  it('keeps the create error when gh says "already exists" but no PR is listed', async () => {
    const c = client(async (argv) => (argv[2] === 'create' ? res({ exitCode: 1, stderr: 'a pull request already exists' }) : res({ stdout: '[]' })));
    await expect(c.createPullRequest({ head: 'orbit/r1', base: 'main', title: 't', body: 'b', draft: false })).rejects.toMatchObject({ code: 'DELIVERY_FAILED' });
  });
});

describe('GhCliClient.updatePullRequest', () => {
  function recorder() {
    const calls: { argv: readonly string[]; input?: string }[] = [];
    const c = client(async (argv, o) => {
      calls.push({ argv, input: o.input });
      return res({ stdout: argv[2] === 'view' ? JSON.stringify(PR) : '' });
    });
    return { c, calls };
  }

  it('edits the title only, the body only (on stdin), or both', async () => {
    const t = recorder();
    await t.c.updatePullRequest(7, { title: 'New title' });
    expect(t.calls[0]!.argv).toEqual(['gh', 'pr', 'edit', '7', '-R', 'acme/app', '--title', 'New title']);
    expect(t.calls[0]!.input).toBeUndefined();

    const b = recorder();
    await b.c.updatePullRequest(7, { body: 'line one\nline two' });
    expect(b.calls[0]!.argv).toEqual(['gh', 'pr', 'edit', '7', '-R', 'acme/app', '--body-file', '-']);
    expect(b.calls[0]!.input).toBe('line one\nline two');

    const both = recorder();
    await both.c.updatePullRequest(7, { title: 'T', body: 'B' });
    expect(both.calls[0]!.argv).toEqual(['gh', 'pr', 'edit', '7', '-R', 'acme/app', '--title', 'T', '--body-file', '-']);
  });

  it('only reads the PR back when there is nothing to change, and refuses a bad number', async () => {
    const r = recorder();
    expect((await r.c.updatePullRequest(7, {})).number).toBe(7);
    expect(r.calls.map((c) => c.argv[2])).toEqual(['view']);
    await expect(r.c.updatePullRequest(0, { title: 'x' })).rejects.toMatchObject({ code: 'INTERNAL' });
    await expect(r.c.updatePullRequest(1.5, { title: 'x' })).rejects.toMatchObject({ code: 'INTERNAL' });
  });
});

describe('GhCliClient merge, checks and logs: remaining edges', () => {
  it('refuses a bad number for a merge and for a merge state', async () => {
    const c = client(async () => res({}));
    await expect(c.mergePullRequest({ number: 0, headSha: 'a'.repeat(40), method: 'squash', deleteBranch: false })).rejects.toMatchObject({ code: 'INTERNAL' });
    await expect(c.getMergeState(-1)).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('falls back to workflow runs when a PR has no checks and a commit is known, and refuses a malformed commit', async () => {
    const sha = 'd'.repeat(40);
    const calls: string[] = [];
    const c = client(async (argv) => {
      calls.push(`${argv[1]} ${argv[2]}`);
      if (argv[2] === 'view') return res({ stdout: JSON.stringify({ ...PR, headRefOid: sha }) });
      if (argv[1] === 'pr') return res({ stdout: '[]' });
      return res({ stdout: JSON.stringify([{ databaseId: 5, status: 'completed', conclusion: 'success', workflowName: 'ci' }]) });
    });
    const r = await c.listChecks({ pr: 7, sha });
    expect(calls).toEqual(['pr view', 'pr checks', 'run list']);
    expect(r).toMatchObject({ absent: false, headSha: sha, checks: [{ bucket: 'pass' }] });
    await expect(c.listChecks({ sha: 'not-a-sha' })).rejects.toMatchObject({ code: 'INTERNAL', message: expect.stringContaining('not a commit sha') });
  });

  it('reports no checks as absent for a PR without a commit', async () => {
    const c = client(async () => res({ stdout: '[]' }));
    expect(await c.listChecks({ pr: 7 })).toEqual({ checks: [], absent: true, headSha: null });
  });

  it('throws what the host said when the log is missing for another reason, and surfaces expired credentials from the job listing', async () => {
    const other = client(async () => res({ exitCode: 1, stderr: 'HTTP 502: Bad Gateway' }));
    await expect(other.failedLogs('5')).rejects.toMatchObject({ code: 'PROVIDER_TRANSIENT' });

    const expired = client(async (argv) => (argv.includes('--log-failed') ? res({ exitCode: 1, stderr: 'HTTP 410' }) : res({ exitCode: 4, stderr: 'HTTP 401: Bad credentials' })));
    await expect(expired.failedLogs('5')).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });

    const quiet = client(async (argv) => (argv.includes('--log-failed') ? res({ exitCode: 1, stderr: 'HTTP 410' }) : res({ exitCode: 1, stderr: 'HTTP 502' })));
    expect(await quiet.failedLogs('5')).toEqual({ status: 'expired', text: '', failedSteps: [] });
  });

  it('authStatus reports gh failing, with its output or with its exit status', async () => {
    expect(await client(async () => res({ exitCode: 1, stderr: `gh: broken ${TOKEN}` })).authStatus()).toMatchObject({ ok: false, error: expect.not.stringContaining(TOKEN) });
    expect((await client(async () => res({ exitCode: 3 })).authStatus()).error).toBe('gh exited 3');
  });
});

describe('FakeGitHub with only a state file', () => {
  let dir: string;
  let statePath: string;
  let fake: FakeGitHub;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orbit-fakegh-cov-'));
    statePath = join(dir, 'gh.json');
    fake = new FakeGitHub({ statePath });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const open = (head = 'orbit/r1') => fake.createPullRequest({ head, base: 'main', title: 't', body: 'b', draft: false });

  it('returns the newest PR for a head when several exist and none is open', async () => {
    await open();
    fake.setPullRequestState(1, 'CLOSED');
    await open();
    fake.setPullRequestState(2, 'CLOSED');
    expect((await fake.findPullRequest('orbit/r1'))!.number).toBe(2);
    await open();
    expect((await fake.findPullRequest('orbit/r1'))!.number).toBe(3);
    fake.setPullRequestState(3, 'CLOSED');
    fake.setPullRequestState(1, 'OPEN');
    expect((await fake.findPullRequest('orbit/r1'))!.number).toBe(1);
  });

  it('refuses to merge a PR that does not exist or is closed, and answers again for one already merged', async () => {
    await expect(fake.mergePullRequest({ number: 4, headSha: 'a'.repeat(40), method: 'squash', deleteBranch: false })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await open();
    fake.setPullRequestState(1, 'CLOSED');
    await expect(fake.mergePullRequest({ number: 1, headSha: 'a'.repeat(40), method: 'squash', deleteBranch: false })).rejects.toMatchObject({ code: 'DELIVERY_FAILED', details: expect.objectContaining({ refused: true }), message: expect.stringContaining('is closed') });
    fake.setPullRequestState(1, 'MERGED');
    const again = await fake.mergePullRequest({ number: 1, headSha: 'a'.repeat(40), method: 'squash', deleteBranch: false });
    expect(again).toMatchObject({ number: 1, state: 'MERGED', mergeCommitSha: null, mergedAt: null });
  });

  it('refuses a merge when the head is unknown, counts merges and answers getMergeState', async () => {
    await open();
    await expect(fake.mergePullRequest({ number: 1, headSha: 'a'.repeat(40), method: 'squash', deleteBranch: false })).rejects.toMatchObject({ message: expect.stringContaining('Head branch was modified'), details: expect.objectContaining({ head: '' }) });
    fake.setHead('orbit/r1', 'b'.repeat(40));
    const merged = await fake.mergePullRequest({ number: 1, headSha: 'b'.repeat(40), method: 'squash', deleteBranch: false });
    expect(merged).toMatchObject({ state: 'MERGED', headRefOid: 'b'.repeat(40) });
    expect(merged.mergeCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(fake.state.merges).toBe(1);
    expect(await fake.getMergeState(1)).toEqual(merged);
    await expect(fake.getMergeState(9)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('copes with a state file written before merge counters and the ready fault existed', async () => {
    await open();
    const legacy = JSON.parse(JSON.stringify(fake.state)) as Record<string, unknown>;
    delete legacy.merges;
    delete legacy.readies;
    delete (legacy.faults as Record<string, unknown>).loseReadyResponse;
    delete (legacy.faults as Record<string, unknown>).loseMergeResponse;
    writeFileSync(statePath, JSON.stringify(legacy));
    fake.setHead('orbit/r1', 'c'.repeat(40));
    expect(await fake.markPullRequestReady(1)).toMatchObject({ isDraft: false });
    await fake.mergePullRequest({ number: 1, headSha: 'c'.repeat(40), method: 'squash', deleteBranch: false });
    expect(fake.state.merges).toBe(1);
  });

  it('listChecks on a PR without a known head reports it absent with no commit, and on a missing PR fails', async () => {
    await expect(fake.listChecks({ pr: 3 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await open();
    expect(await fake.listChecks({ pr: 1 })).toEqual({ checks: [], absent: true, headSha: null });
    fake.scriptCi('e'.repeat(40), []);
    expect(await fake.listChecks({ sha: 'e'.repeat(40) })).toEqual({ checks: [], absent: true, headSha: 'e'.repeat(40) });
  });

  it('maps every bucket to its raw state and an empty snapshot to absent', async () => {
    const sha = 'f'.repeat(40);
    fake.scriptCi(sha, [[{ name: 'a', bucket: 'pass' }, { name: 'b', bucket: 'cancel' }, { name: 'c', bucket: 'skipping' }, { name: 'd', bucket: 'pending' }, { name: 'e', bucket: 'fail', runId: '12' }], []]);
    const first = await fake.listChecks({ sha });
    expect(first.checks.map((c) => c.state)).toEqual(['SUCCESS', 'CANCELLED', 'SKIPPED', 'IN_PROGRESS', 'FAILURE']);
    expect(first.checks[4]).toMatchObject({ link: 'https://github.example/acme/app/actions/runs/12/job/1', jobId: '1' });
    expect(first.checks[0]).toMatchObject({ link: null, jobId: null });
    expect(await fake.listChecks({ sha })).toEqual({ checks: [], absent: true, headSha: sha });
  });
});

describe('FakeGitHub attached to a real remote', () => {
  let lab: Lab;
  beforeEach(() => {
    lab = makeLab();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    lab.cleanup();
  });

  /** Pushes a candidate to `branch` and opens a ready PR for it, returning the head commit. */
  async function openPr(branch: string, base = 'main'): Promise<string> {
    const c = lab.candidate(`content of ${branch}\n`);
    git(lab.work, ['push', 'origin', `${c.commitSha}:refs/heads/${branch}`]);
    await lab.fake.createPullRequest({ head: branch, base, title: `Change ${branch}`, body: 'b', draft: false });
    return c.commitSha;
  }

  it('leaves a PR without a head when its branch was never pushed', async () => {
    const pr = await lab.fake.createPullRequest({ head: 'orbit/unpushed', base: 'main', title: 't', body: 'b', draft: false });
    expect(pr.headRefOid).toBe('');
  });

  it('merges with a two-parent commit, a rebase that keeps the head, and a squash on a single parent', async () => {
    const mergeHead = await openPr('orbit/m');
    const merged = await lab.fake.mergePullRequest({ number: 1, headSha: mergeHead, method: 'merge', deleteBranch: false });
    expect(git(lab.remote, ['rev-list', '--parents', '-n', '1', merged.mergeCommitSha!]).split(' ')).toHaveLength(3);
    expect(lab.remoteSha('main')).toBe(merged.mergeCommitSha);

    // A second PR was cut from the old base, so after the first merge its base has moved: refused, not merged.
    const stale = await openPr('orbit/s');
    await expect(lab.fake.mergePullRequest({ number: 2, headSha: stale, method: 'squash', deleteBranch: false })).rejects.toMatchObject({ details: expect.objectContaining({ refused: true }), message: expect.stringContaining('base main moved') });
  });

  it('rebases onto an unmoved base by fast-forwarding to the head, and can delete the head branch', async () => {
    const head = await openPr('orbit/r');
    const merged = await lab.fake.mergePullRequest({ number: 1, headSha: head, method: 'rebase', deleteBranch: true });
    expect(merged.mergeCommitSha).toBe(head);
    expect(lab.remoteSha('main')).toBe(head);
    expect(lab.remoteSha('orbit/r')).toBeNull();
    // The merged PR keeps the head it was merged at after its branch is gone.
    expect((await lab.fake.findPullRequest('orbit/r'))!.headRefOid).toBe(head);
  });

  it('squashes onto a single parent and refuses a base branch that does not exist', async () => {
    const head = await openPr('orbit/q');
    const squashed = await lab.fake.mergePullRequest({ number: 1, headSha: head, method: 'squash', deleteBranch: false });
    expect(git(lab.remote, ['rev-list', '--parents', '-n', '1', squashed.mergeCommitSha!]).split(' ')).toHaveLength(2);

    const other = await openPr('orbit/nobase', 'release');
    await expect(lab.fake.mergePullRequest({ number: 2, headSha: other, method: 'squash', deleteBranch: false })).rejects.toMatchObject({ details: expect.objectContaining({ refused: true }), message: expect.stringContaining('base branch release does not exist') });
  });

  it('reports a failing git operation on the remote, other than a missing ref, as a delivery failure', async () => {
    await lab.fake.createPullRequest({ head: 'orbit/bad', base: 'main', title: 't', body: 'b', draft: false });
    const missing = 'f'.repeat(40);
    lab.fake.setHead('orbit/bad', missing);
    await expect(lab.fake.mergePullRequest({ number: 1, headSha: missing, method: 'squash', deleteBranch: false })).rejects.toMatchObject({ code: 'DELIVERY_FAILED', message: expect.stringContaining('fake remote: git merge-base failed') });
  });

  it('finds git even when PATH is not set in the process', async () => {
    const head = await openPr('orbit/nopath');
    vi.stubEnv('PATH', undefined as unknown as string);
    const merged = await lab.fake.mergePullRequest({ number: 1, headSha: head, method: 'rebase', deleteBranch: false });
    expect(merged.mergeCommitSha).toBe(head);
  });
});
