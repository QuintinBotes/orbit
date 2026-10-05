import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExecResult } from '../../../src/core/exec.ts';
import { FakeGitHub, GhCliClient, parseMergeState, type CheckBucket, type ChecksResult, type GhRunner } from '../../../src/delivery/github.ts';
import { verdictOf } from '../../../src/delivery/release.ts';
import { ACTION_KINDS } from '../../../src/delivery/actions.ts';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const TOKEN = 'github_pat_scopedtokenvalue0123456789';

function res(over: Partial<ExecResult>): ExecResult {
  return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, cancelled: false, durationMs: 1, stdoutTruncated: false, stderrTruncated: false, pid: 1, ...over };
}

const VIEW = { number: 7, state: 'MERGED', headRefOid: SHA, baseRefName: 'main', mergeCommit: { oid: OTHER }, mergedAt: '2026-01-01T00:00:00Z' };

function client(runner: GhRunner): GhCliClient {
  return new GhCliClient({ repo: 'acme/app', env: { PATH: '/bin', HOME: '/home/x', GH_TOKEN: TOKEN }, runner });
}

function checks(list: [string, CheckBucket][], over: Partial<ChecksResult> = {}): ChecksResult {
  const all = list.map(([name, bucket]) => ({ name, bucket, state: '', link: null, workflow: null, runId: null, jobId: null, startedAt: null, completedAt: null, description: null }));
  return { checks: all, absent: all.length === 0, headSha: SHA, ...over };
}

describe('release action kinds', () => {
  it('names merge and deploy, so their fault points exist', () => {
    expect(ACTION_KINDS).toContain('pr_ready');
    expect(ACTION_KINDS).toContain('merge');
    expect(ACTION_KINDS).toContain('deploy');
  });
});

describe('verdictOf', () => {
  it('passes only when every required check passed on that commit', () => {
    expect(verdictOf(checks([['test', 'pass'], ['lint', 'pass']]), SHA, ['test'], true).state).toBe('passed');
    expect(verdictOf(checks([['test', 'pass'], ['docs', 'skipping']]), SHA, ['test'], true).state).toBe('passed');
  });

  it('is pending while a required check is missing or anything still runs, or the checks belong to another commit', () => {
    expect(verdictOf(checks([['lint', 'pass']]), SHA, ['test'], false)).toMatchObject({ state: 'pending', detail: expect.stringMatching(/not reported yet: test/) });
    expect(verdictOf(checks([['test', 'pass'], ['e2e', 'pending']]), SHA, ['test'], false)).toMatchObject({ state: 'pending', detail: expect.stringMatching(/running: e2e/) });
    expect(verdictOf(checks([['test', 'pass']], { headSha: OTHER }), SHA, ['test'], false).state).toBe('pending');
    expect(verdictOf(checks([['test', 'skipping']]), SHA, ['test'], false)).toMatchObject({ state: 'pending', detail: expect.stringMatching(/not passed: test/) });
  });

  it('fails on any failing or cancelled check, required or not', () => {
    expect(verdictOf(checks([['test', 'pass'], ['lint', 'fail']]), SHA, ['test'], false).state).toBe('failed');
    expect(verdictOf(checks([['test', 'cancel']]), SHA, ['test'], false).state).toBe('failed');
  });

  it('never treats "no checks" as green when checks are required', () => {
    expect(verdictOf(checks([]), SHA, [], true).state).toBe('pending');
    expect(verdictOf(checks([]), SHA, ['test'], false).state).toBe('pending');
    expect(verdictOf(checks([]), SHA, [], false).state).toBe('passed');
  });
});

describe('parseMergeState', () => {
  it('reads the merge commit only for a merged PR', () => {
    expect(parseMergeState(VIEW)).toEqual({ number: 7, state: 'MERGED', headRefOid: SHA, baseRefName: 'main', mergeCommitSha: OTHER, mergedAt: '2026-01-01T00:00:00Z' });
    expect(parseMergeState({ ...VIEW, state: 'OPEN', mergeCommit: null, mergedAt: null })).toMatchObject({ state: 'OPEN', mergeCommitSha: null, mergedAt: null });
    expect(() => parseMergeState({ ...VIEW, state: 'QUEUED' })).toThrow(expect.objectContaining({ code: 'MALFORMED_OUTPUT' }));
  });
});

describe('GhCliClient merge', () => {
  it('merges with the configured method pinned to the reviewed head, then reads the merge back', async () => {
    const calls: (readonly string[])[] = [];
    const c = client(async (argv) => {
      calls.push(argv);
      return argv[2] === 'merge' ? res({ stdout: '' }) : res({ stdout: JSON.stringify(VIEW) });
    });
    const s = await c.mergePullRequest({ number: 7, headSha: SHA, method: 'squash', deleteBranch: true });
    expect(calls[0]).toEqual(['gh', 'pr', 'merge', '7', '-R', 'acme/app', '--squash', '--match-head-commit', SHA, '--delete-branch']);
    expect(calls[1]!.slice(0, 6)).toEqual(['gh', 'pr', 'view', '7', '-R', 'acme/app']);
    expect(calls[1]).toContain('number,state,headRefOid,baseRefName,mergeCommit,mergedAt');
    expect(s.mergeCommitSha).toBe(OTHER);
  });

  it('turns a moved head into a definitive refusal, adopts an already-merged PR, and refuses a queued merge', async () => {
    const moved = client(async () => res({ exitCode: 1, stderr: 'GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)' }));
    await expect(moved.mergePullRequest({ number: 7, headSha: SHA, method: 'merge', deleteBranch: false })).rejects.toMatchObject({ code: 'DELIVERY_FAILED', details: { definitive: true } });

    const already = client(async (argv) => (argv[2] === 'merge' ? res({ exitCode: 1, stderr: 'Pull request acme/app#7 was already merged' }) : res({ stdout: JSON.stringify(VIEW) })));
    expect((await already.mergePullRequest({ number: 7, headSha: SHA, method: 'merge', deleteBranch: false })).state).toBe('MERGED');

    const queued = client(async (argv) => (argv[2] === 'merge' ? res({}) : res({ stdout: JSON.stringify({ ...VIEW, state: 'OPEN', mergeCommit: null }) })));
    await expect(queued.mergePullRequest({ number: 7, headSha: SHA, method: 'rebase', deleteBranch: false })).rejects.toMatchObject({ code: 'DELIVERY_FAILED', details: { definitive: true } });

    const transient = client(async () => res({ exitCode: 1, stderr: 'HTTP 502: Bad Gateway' }));
    await expect(transient.mergePullRequest({ number: 7, headSha: SHA, method: 'squash', deleteBranch: false })).rejects.toMatchObject({ code: 'PROVIDER_TRANSIENT' });
  });

  it('validates its input before running gh', async () => {
    let ran = false;
    const c = client(async () => {
      ran = true;
      return res({});
    });
    await expect(c.mergePullRequest({ number: 7, headSha: 'abc', method: 'squash', deleteBranch: false })).rejects.toThrow(/full commit sha/);
    await expect(c.mergePullRequest({ number: 7, headSha: SHA, method: 'octopus' as 'merge', deleteBranch: false })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    expect(ran).toBe(false);
  });
});

describe('FakeGitHub merge', () => {
  let dir: string;
  let fake: FakeGitHub;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orbit-fake-merge-'));
    fake = new FakeGitHub({ statePath: join(dir, 'state.json') });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('refuses a stale head and a draft, merges the exact head once, and can lose the response', async () => {
    fake.setHead('orbit/r1', SHA);
    const pr = await fake.createPullRequest({ head: 'orbit/r1', base: 'main', title: 't', body: 'b', draft: true });
    await expect(fake.mergePullRequest({ number: pr.number, headSha: SHA, method: 'squash', deleteBranch: false })).rejects.toThrow(/draft/);
    const ready = await fake.createPullRequest({ head: 'orbit/r2', base: 'main', title: 't', body: 'b', draft: false });
    fake.setHead('orbit/r2', SHA);
    await expect(fake.mergePullRequest({ number: ready.number, headSha: OTHER, method: 'squash', deleteBranch: false })).rejects.toMatchObject({ code: 'DELIVERY_FAILED', details: { definitive: true } });
    expect((await fake.getMergeState(ready.number)).state).toBe('OPEN');

    fake.setFaults({ loseMergeResponse: 1 });
    await expect(fake.mergePullRequest({ number: ready.number, headSha: SHA, method: 'squash', deleteBranch: false })).rejects.toMatchObject({ code: 'PROVIDER_TRANSIENT' });
    const s = await fake.getMergeState(ready.number);
    expect(s).toMatchObject({ state: 'MERGED', headRefOid: SHA });
    expect(s.mergeCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(fake.state.merges).toBe(1);
  });
});
