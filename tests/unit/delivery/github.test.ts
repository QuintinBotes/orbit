import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../../../src/core/clock.ts';
import type { ExecResult } from '../../../src/core/exec.ts';
import { observeCi } from '../../../src/delivery/ci.ts';
import {
  FakeGitHub,
  GhCliClient,
  classifyGhFailure,
  parseAuthStatus,
  parseChecks,
  parseCombinedStatus,
  parseFailedSteps,
  parsePullRequest,
  parsePullRequestList,
  parseRunListAsChecks,
  runBucket,
  type GhRunner,
} from '../../../src/delivery/github.ts';

// Shapes taken from docs/interfaces/playwright-and-github.md B3 to B5.
const PR = { number: 7, url: 'https://github.com/acme/app/pull/7', headRefName: 'orbit/r1', headRefOid: 'a'.repeat(40), baseRefName: 'main', isDraft: true, state: 'OPEN', title: 't', body: 'b', statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }] };

function res(over: Partial<ExecResult>): ExecResult {
  return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, cancelled: false, durationMs: 1, stdoutTruncated: false, stderrTruncated: false, pid: 1, ...over };
}

describe('gh JSON parsing', () => {
  it('parses pr list output and ignores fields it does not need', () => {
    const list = parsePullRequestList(JSON.stringify([PR]));
    expect(list).toEqual([{ number: 7, url: PR.url, headRefName: 'orbit/r1', headRefOid: 'a'.repeat(40), baseRefName: 'main', isDraft: true, state: 'OPEN', title: 't', body: 'b' }]);
    expect(parsePullRequestList('[]')).toEqual([]);
  });

  it('accepts MERGED and CLOSED and rejects unknown states and bad numbers', () => {
    expect(parsePullRequest({ ...PR, state: 'MERGED' }).state).toBe('MERGED');
    expect(parsePullRequest({ ...PR, state: 'CLOSED' }).state).toBe('CLOSED');
    expect(() => parsePullRequest({ ...PR, state: 'WEIRD' })).toThrow(expect.objectContaining({ code: 'MALFORMED_OUTPUT' }));
    expect(() => parsePullRequest({ ...PR, number: '7' })).toThrow(expect.objectContaining({ code: 'MALFORMED_OUTPUT' }));
    expect(() => parsePullRequest({ ...PR, headRefOid: undefined })).toThrow(/headRefOid/);
  });

  it('rejects non-JSON and non-array output', () => {
    expect(() => parsePullRequestList('no pull requests found for branch "x"')).toThrow(expect.objectContaining({ code: 'MALFORMED_OUTPUT' }));
    expect(() => parsePullRequestList('{}')).toThrow(/array/);
  });

  it('parses pr checks and extracts run and job ids from the link', () => {
    const out = JSON.stringify([
      { name: 'build', state: 'FAILURE', bucket: 'fail', link: 'https://github.com/cli/cli/actions/runs/12345/job/678', workflow: 'ci', event: 'pull_request', startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:01:00Z', description: '' },
      { name: 'lint', state: 'IN_PROGRESS', bucket: 'pending', link: '', workflow: 'ci', event: 'pull_request', startedAt: '', completedAt: '', description: '' },
      { name: 'external', state: 'SUCCESS', bucket: 'pass', link: 'https://ci.example/build/9', workflow: '', event: '', startedAt: '', completedAt: '', description: 'ok' },
    ]);
    const checks = parseChecks(out);
    expect(checks[0]).toMatchObject({ name: 'build', bucket: 'fail', runId: '12345', jobId: '678', workflow: 'ci' });
    expect(checks[1]).toMatchObject({ bucket: 'pending', link: null, runId: null });
    expect(checks[2]).toMatchObject({ runId: null, description: 'ok' });
  });

  it('rejects a bucket it does not know rather than guessing pass', () => {
    expect(() => parseChecks(JSON.stringify([{ name: 'x', bucket: 'mystery' }]))).toThrow(/bucket/);
  });

  it('maps workflow runs onto check buckets, never calling an unknown conclusion a pass', () => {
    expect(runBucket('in_progress', '')).toBe('pending');
    expect(runBucket('queued', '')).toBe('pending');
    expect(runBucket('completed', 'success')).toBe('pass');
    expect(runBucket('completed', 'failure')).toBe('fail');
    expect(runBucket('completed', 'timed_out')).toBe('fail');
    expect(runBucket('completed', 'startup_failure')).toBe('fail');
    expect(runBucket('completed', 'cancelled')).toBe('cancel');
    expect(runBucket('completed', 'skipped')).toBe('skipping');
    expect(runBucket('completed', 'something-new')).toBe('fail');
    const checks = parseRunListAsChecks(JSON.stringify([{ databaseId: 99, status: 'completed', conclusion: 'failure', headSha: 'x', workflowName: 'ci', name: 'ci', url: 'https://github.com/a/b/actions/runs/99' }]));
    expect(checks[0]).toMatchObject({ name: 'ci', bucket: 'fail', runId: '99', state: 'FAILURE' });
  });

  it('extracts failed steps from the jobs listing', () => {
    const steps = parseFailedSteps(JSON.stringify({ jobs: [{ name: 'build', conclusion: 'failure', steps: [{ name: 'checkout', conclusion: 'success' }, { name: 'npm test', conclusion: 'failure' }] }, { name: 'setup', conclusion: 'failure', steps: [] }, { name: 'ok', conclusion: 'success', steps: [] }] }));
    expect(steps).toEqual([{ job: 'build', step: 'npm test' }, { job: 'setup', step: '' }]);
  });

  it('reads the active account from `auth status --json hosts`', () => {
    const good = JSON.stringify({ hosts: { 'github.com': [{ active: true, error: '', gitProtocol: 'https', host: 'github.com', login: 'bot', scopes: '', state: 'success', tokenSource: 'GH_TOKEN' }] } });
    expect(parseAuthStatus(good, 'github.com', true)).toMatchObject({ ok: true, login: 'bot', tokenSource: 'GH_TOKEN' });
    const keyring = JSON.stringify({ hosts: { 'github.com': [{ active: true, state: 'success', tokenSource: 'keyring', login: 'me', scopes: 'admin:org, repo' }] } });
    expect(parseAuthStatus(keyring, 'github.com', true)).toMatchObject({ ok: false });
    expect(parseAuthStatus(keyring, 'github.com', true).error).toMatch(/keyring/);
    expect(parseAuthStatus(keyring, 'github.com', false).ok).toBe(true);
    // The bad GH_TOKEN case from the notes: exit 0, active entry in error, keyring entry inactive.
    const bad = JSON.stringify({ hosts: { 'github.com': [{ active: true, state: 'error', tokenSource: 'GH_TOKEN', login: '', error: 'non-200 OK status code: 401 Unauthorized' }, { active: false, state: 'success', tokenSource: 'keyring', login: 'me' }] } });
    const r = parseAuthStatus(bad, 'github.com', true);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/401/);
    expect(parseAuthStatus(JSON.stringify({ hosts: {} }), 'github.com', true)).toMatchObject({ ok: false });
  });
});

describe('classifyGhFailure', () => {
  it('maps exit codes and messages to codes', () => {
    expect(classifyGhFailure('x', 4, 'To get started with GitHub CLI, please run: gh auth login')).toMatchObject({ code: 'AUTH_EXPIRED' });
    expect(classifyGhFailure('x', 1, 'gh: Bad credentials (HTTP 401)')).toMatchObject({ code: 'AUTH_EXPIRED' });
    expect(classifyGhFailure('x', 1, 'Resource not accessible by personal access token (HTTP 403)')).toMatchObject({ code: 'AUTH_MISSING' });
    expect(classifyGhFailure('x', 1, 'gh: API rate limit exceeded (HTTP 403)')).toMatchObject({ code: 'PROVIDER_TRANSIENT', details: { retryAfterMs: 60_000 } });
    expect(classifyGhFailure('x', 1, 'secondary rate limit. Retry-After: 30')).toMatchObject({ details: { retryAfterMs: 30_000 } });
    expect(classifyGhFailure('x', 1, 'HTTP 502: Bad Gateway')).toMatchObject({ code: 'PROVIDER_TRANSIENT' });
    expect(classifyGhFailure('x', 1, 'gh: Not Found (HTTP 404)')).toMatchObject({ code: 'NOT_FOUND' });
    expect(classifyGhFailure('x', 1, 'something odd')).toMatchObject({ code: 'DELIVERY_FAILED' });
  });

  it('redacts tokens in the message', () => {
    const e = classifyGhFailure('x', 1, 'failed with ghp_abcdefghijklmnopqrstuvwxyz0123456789 in url');
    expect(e.message).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });
});

describe('GhCliClient (stubbed runner)', () => {
  const TOKEN = 'github_pat_scopedtokenvalue0123456789';
  function client(runner: GhRunner, env: Record<string, string | undefined> = { PATH: '/bin', HOME: '/home/x', GH_TOKEN: TOKEN, GITHUB_TOKEN: 'ghp_shouldnotpass', AWS_SECRET_ACCESS_KEY: 'zzz' }) {
    return new GhCliClient({ repo: 'acme/app', env, runner });
  }

  it('marks a pull request ready with gh pr ready and reads it back, and refuses without the scoped token', async () => {
    const seen: (readonly string[])[] = [];
    const c = client(async (argv) => {
      seen.push(argv);
      return res({ stdout: argv[2] === 'view' ? JSON.stringify({ ...PR, isDraft: false }) : '' });
    });
    const pr = await c.markPullRequestReady(7);
    expect(pr.isDraft).toBe(false);
    expect(seen[0]).toEqual(['gh', 'pr', 'ready', '7', '-R', 'acme/app']);
    expect(seen[1]!.slice(0, 3)).toEqual(['gh', 'pr', 'view']);
    await expect(client(async () => res({}), { PATH: '/bin' }).markPullRequestReady(7)).rejects.toMatchObject({ code: 'AUTH_MISSING' });
    await expect(c.markPullRequestReady(0)).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('lists PRs by exact head with the verified flags and a scrubbed environment', async () => {
    const seen: { argv: readonly string[]; env: Record<string, string | undefined> }[] = [];
    const c = client(async (argv, o) => {
      seen.push({ argv, env: o.env });
      return res({ stdout: JSON.stringify([{ ...PR, headRefName: 'x/orbit/r1', number: 3 }, { ...PR, state: 'CLOSED', number: 5 }, PR]) });
    });
    const pr = await c.findPullRequest('orbit/r1');
    expect(pr?.number).toBe(7); // the OPEN one, and the look-alike head was ignored
    expect(seen[0]!.argv.slice(0, 9)).toEqual(['gh', 'pr', 'list', '-R', 'acme/app', '--head', 'orbit/r1', '--state', 'all']);
    expect(seen[0]!.argv).toContain('--json');
    expect(seen[0]!.env.GH_TOKEN).toBe(TOKEN);
    expect(seen[0]!.env.GITHUB_TOKEN).toBeUndefined();
    expect(seen[0]!.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(seen[0]!.env.GH_PROMPT_DISABLED).toBe('1');
  });

  it('returns null when no PR matches', async () => {
    expect(await client(async () => res({ stdout: '[]' })).findPullRequest('orbit/r1')).toBeNull();
  });

  it('creates with --head, --base and the body on stdin, then reads the PR back', async () => {
    const calls: { argv: readonly string[]; input?: string }[] = [];
    const c = client(async (argv, o) => {
      calls.push({ argv, input: o.input });
      if (argv[2] === 'create') return res({ stdout: 'https://github.com/acme/app/pull/7\n' });
      return res({ stdout: JSON.stringify(PR) });
    });
    const pr = await c.createPullRequest({ head: 'orbit/r1', base: 'main', title: 'Add widget', body: 'line1\nline2', draft: true });
    expect(pr.number).toBe(7);
    expect(calls[0]!.argv).toEqual(['gh', 'pr', 'create', '-R', 'acme/app', '--head', 'orbit/r1', '--base', 'main', '--title', 'Add widget', '--body-file', '-', '--draft']);
    expect(calls[0]!.input).toBe('line1\nline2');
    expect(calls[1]!.argv.slice(0, 3)).toEqual(['gh', 'pr', 'view']);
  });

  it('adopts the existing PR when gh says one already exists', async () => {
    const c = client(async (argv) => {
      if (argv[2] === 'create') return res({ exitCode: 1, stderr: 'a pull request for branch "orbit/r1" into branch "main" already exists:\nhttps://github.com/acme/app/pull/7' });
      return res({ stdout: JSON.stringify([PR]) });
    });
    expect((await c.createPullRequest({ head: 'orbit/r1', base: 'main', title: 't', body: 'b', draft: true })).number).toBe(7);
  });

  it('surfaces a failed create as an error to reconcile, not as success', async () => {
    const c = client(async () => res({ exitCode: 1, stderr: 'HTTP 502: Bad Gateway' }));
    await expect(c.createPullRequest({ head: 'orbit/r1', base: 'main', title: 't', body: 'b', draft: false })).rejects.toMatchObject({ code: 'PROVIDER_TRANSIENT' });
  });

  it('refuses to run without a scoped token and never calls gh', async () => {
    let called = 0;
    const c = client(async () => { called++; return res({}); }, { PATH: '/bin', GITHUB_TOKEN: 'ghp_x' });
    await expect(c.findPullRequest('orbit/r1')).rejects.toMatchObject({ code: 'AUTH_MISSING' });
    expect(called).toBe(0);
    expect(await c.authStatus()).toMatchObject({ ok: false });
  });

  it('computes check verdicts from JSON, treating exit 0 with failing buckets as data', async () => {
    const c = client(async () => res({ stdout: JSON.stringify([{ name: 'build', state: 'FAILURE', bucket: 'fail', link: 'https://github.com/acme/app/actions/runs/5/job/6' }]) }));
    const r = await c.listChecks({ pr: 7 });
    expect(r.absent).toBe(false);
    expect(r.checks[0]).toMatchObject({ bucket: 'fail', runId: '5' });
  });

  it('treats "no checks reported" as absent and cross-checks workflow runs by commit', async () => {
    const sha = 'b'.repeat(40);
    const calls: string[] = [];
    const c = client(async (argv) => {
      const path = argv.find((a) => a.startsWith('repos/'));
      calls.push(path ? `api ${path.split('/')[5]!.split('?')[0]}` : `${argv[1]} ${argv[2]}`);
      if (path?.includes('/check-runs')) return res({ stdout: JSON.stringify({ total_count: 0, check_runs: [] }) });
      if (path?.includes('/status')) return res({ stdout: JSON.stringify({ state: 'pending', sha, total_count: 0, statuses: [] }) });
      return res({ stdout: JSON.stringify([{ databaseId: 5, status: 'in_progress', conclusion: '', workflowName: 'ci', url: 'u' }]) });
    });
    const r = await c.listChecks({ pr: 7, sha });
    expect(calls).toEqual(['api check-runs', 'api status', 'run list']);
    expect(r).toMatchObject({ absent: false, headSha: sha, checks: [{ bucket: 'pending', runId: '5' }] });
    const none = await client(async () => res({ exitCode: 1, stderr: "no checks reported on the 'b' branch" })).listChecks({ pr: 7 });
    expect(none).toEqual({ checks: [], absent: true, headSha: null });
  });

  it('falls back to workflow runs when the token cannot read check runs', async () => {
    const c = client(async (argv) => {
      if (argv[1] === 'api') return res({ exitCode: 1, stderr: 'Resource not accessible by personal access token (HTTP 403)' });
      return res({ stdout: '[]' });
    });
    expect(await c.listChecks({ pr: 7, sha: 'c'.repeat(40) })).toEqual({ checks: [], absent: true, headSha: 'c'.repeat(40) });
    await expect(client(async () => res({ exitCode: 1, stderr: 'Resource not accessible (HTTP 403)' })).listChecks({ pr: 7 })).rejects.toMatchObject({ code: 'AUTH_MISSING' });
  });

  it('handles expired and missing logs and falls back to failed steps', async () => {
    const calls: string[] = [];
    const c = client(async (argv) => {
      calls.push(argv.slice(1).join(' '));
      if (argv.includes('--log-failed')) return res({ exitCode: 1, stderr: 'failed to get run log: HTTP 410: Server Error' });
      return res({ stdout: JSON.stringify({ jobs: [{ name: 'build', conclusion: 'failure', steps: [{ name: 'npm test', conclusion: 'failure' }] }] }) });
    });
    expect(await c.failedLogs('55')).toEqual({ status: 'expired', text: '', failedSteps: [{ job: 'build', step: 'npm test' }] });
    const nf = client(async (argv) => (argv.includes('--log-failed') ? res({ exitCode: 1, stderr: 'failed to get run log: log not found' }) : res({ stdout: '{"jobs":[]}' })));
    expect(await nf.failedLogs('55')).toMatchObject({ status: 'not-found' });
    const ok = client(async () => res({ stdout: 'build\tnpm test\t2026-01-01T00:00:00Z boom\n' }));
    expect(await ok.failedLogs('55')).toMatchObject({ status: 'ok' });
    await expect(ok.failedLogs('not-a-number')).rejects.toThrow(/run id/);
  });

  it('validates the repository and head names', async () => {
    expect(() => new GhCliClient({ repo: 'not a repo', env: {} })).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    await expect(client(async () => res({})).findPullRequest('--web')).rejects.toThrow(/head branch/);
  });
});

describe('FakeGitHub', () => {
  let dir: string;
  let fake: FakeGitHub;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orbit-fakegh-'));
    fake = new FakeGitHub({ statePath: join(dir, 'gh.json') });
    fake.setHead('orbit/r1', 'd'.repeat(40));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('creates one PR per open head and refuses a duplicate like gh does', async () => {
    const pr = await fake.createPullRequest({ head: 'orbit/r1', base: 'main', title: 't', body: 'b', draft: true });
    expect(pr).toMatchObject({ number: 1, state: 'OPEN', isDraft: true, headRefOid: 'd'.repeat(40) });
    await expect(fake.createPullRequest({ head: 'orbit/r1', base: 'main', title: 't', body: 'b', draft: true })).rejects.toThrow(/already exists/);
    expect((await fake.findPullRequest('orbit/r1'))?.number).toBe(1);
    expect(await fake.findPullRequest('orbit/other')).toBeNull();
  });

  it('marks a draft ready (counted once), refuses a closed PR and can lose the response after doing it', async () => {
    await fake.createPullRequest({ head: 'orbit/r1', base: 'main', title: 't', body: 'b', draft: true });
    fake.setFaults({ loseReadyResponse: 1 });
    await expect(fake.markPullRequestReady(1)).rejects.toMatchObject({ code: 'PROVIDER_TRANSIENT' });
    expect((await fake.findPullRequest('orbit/r1'))?.isDraft).toBe(false);
    expect((await fake.markPullRequestReady(1)).isDraft).toBe(false);
    expect(fake.state.readies).toBe(1);
    await expect(fake.markPullRequestReady(99)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    fake.setPullRequestState(1, 'CLOSED');
    await expect(fake.markPullRequestReady(1)).rejects.toMatchObject({ code: 'DELIVERY_FAILED' });
  });

  it('shares state across instances on the same file (a restarted controller)', async () => {
    await fake.createPullRequest({ head: 'orbit/r1', base: 'main', title: 't', body: 'b', draft: false });
    const again = new FakeGitHub({ statePath: join(dir, 'gh.json') });
    expect((await again.findPullRequest('orbit/r1'))?.number).toBe(1);
  });

  it('can lose the create response after creating', async () => {
    fake.setFaults({ loseCreateResponse: 1 });
    await expect(fake.createPullRequest({ head: 'orbit/r1', base: 'main', title: 't', body: 'b', draft: true })).rejects.toMatchObject({ code: 'PROVIDER_TRANSIENT' });
    expect(fake.state.prs).toHaveLength(1);
    expect(fake.state.creates).toBe(1);
  });

  it('rate limits a number of calls with a retry-after hint, then recovers', async () => {
    fake.setFaults({ rateLimit: 2, rateLimitRetryAfterMs: 4000 });
    await expect(fake.findPullRequest('orbit/r1')).rejects.toMatchObject({ code: 'PROVIDER_TRANSIENT', details: { retryAfterMs: 4000 } });
    await expect(fake.findPullRequest('orbit/r1')).rejects.toMatchObject({ code: 'PROVIDER_TRANSIENT' });
    expect(await fake.findPullRequest('orbit/r1')).toBeNull();
  });

  it('fails every call with AUTH_EXPIRED once auth expires, and says so in authStatus', async () => {
    fake.setFaults({ authExpired: true });
    await expect(fake.findPullRequest('orbit/r1')).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
    await expect(fake.listChecks({ sha: 'x' })).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
    expect(await fake.authStatus()).toMatchObject({ ok: false });
    fake.setFaults({ authExpired: false });
    expect(await fake.authStatus()).toMatchObject({ ok: true });
  });

  it('scripts CI per commit: a sequence of snapshots, the last repeating', async () => {
    const sha = 'd'.repeat(40);
    fake.scriptCi(sha, [[{ name: 'build', bucket: 'pending' }], [{ name: 'build', bucket: 'fail', runId: '9' }]]);
    expect((await fake.listChecks({ sha })).checks[0]!.bucket).toBe('pending');
    const second = await fake.listChecks({ sha });
    expect(second.checks[0]).toMatchObject({ bucket: 'fail', runId: '9', jobId: '1' });
    expect((await fake.listChecks({ sha })).checks[0]!.bucket).toBe('fail');
    expect(await fake.listChecks({ sha: 'e'.repeat(40) })).toEqual({ checks: [], absent: true, headSha: 'e'.repeat(40) });
    await fake.createPullRequest({ head: 'orbit/r1', base: 'main', title: 't', body: 'b', draft: true });
    expect((await fake.listChecks({ pr: 1 })).checks[0]!.bucket).toBe('fail');
  });

  it('updates a PR and scripts logs', async () => {
    await fake.createPullRequest({ head: 'orbit/r1', base: 'main', title: 't', body: 'b', draft: true });
    expect(await fake.updatePullRequest(1, { title: 'new' })).toMatchObject({ title: 'new', body: 'b' });
    await expect(fake.updatePullRequest(99, { title: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    fake.scriptLog('9', { text: 'boom' });
    expect(await fake.failedLogs('9')).toMatchObject({ status: 'ok', text: 'boom' });
    expect(await fake.failedLogs('10')).toMatchObject({ status: 'not-found' });
  });
});

describe('GhCliClient.listChecks binds checks to the commit asked about', () => {
  const TOKEN = 'github_pat_scopedtokenvalue0123456789';
  const SHA = 'c'.repeat(40);

  it('when the PR head is another commit, never uses the PR rollup: the asked commit has only its own runs', async () => {
    const calls: string[] = [];
    const c = new GhCliClient({ repo: 'acme/app', env: { PATH: '/bin', GH_TOKEN: TOKEN }, runner: async (argv) => {
      calls.push(`${argv[1]} ${argv[2]}`);
      if (argv[2] === 'view') return res({ stdout: JSON.stringify(PR) }); // head is a...a
      if (argv[2] === 'checks') return res({ stdout: JSON.stringify([{ name: 'build', state: 'SUCCESS', bucket: 'pass', link: '' }]) });
      if (argv[1] === 'api') return res({ exitCode: 1, stderr: 'Resource not accessible by personal access token (HTTP 403)' });
      return res({ stdout: JSON.stringify([{ databaseId: 9, status: 'in_progress', conclusion: '', workflowName: 'ci', url: 'u', headSha: SHA }]) });
    } });
    const r = await c.listChecks({ pr: 7, sha: SHA });
    expect(calls).toEqual(['api -H', 'run list']);
    expect(r).toMatchObject({ headSha: SHA, absent: false, checks: [{ bucket: 'pending', runId: '9' }] });
  });

  it('when the PR head is the asked commit, reads that commit and says which commit the checks are for', async () => {
    const calls: string[] = [];
    const c = new GhCliClient({ repo: 'acme/app', env: { PATH: '/bin', GH_TOKEN: TOKEN }, runner: async (argv) => {
      const path = argv.find((a) => a.startsWith('repos/')) ?? '';
      calls.push(path.includes('/check-runs') ? 'check-runs' : path.includes('/status') ? 'status' : `${argv[1]} ${argv[2]}`);
      if (path.includes('/check-runs')) return res({ stdout: JSON.stringify({ total_count: 1, check_runs: [{ name: 'build', head_sha: SHA, status: 'completed', conclusion: 'failure', html_url: '' }] }) });
      return res({ stdout: JSON.stringify({ state: 'failure', sha: SHA, total_count: 0, statuses: [] }) });
    } });
    const r = await c.listChecks({ pr: 7, sha: SHA });
    expect(calls).toEqual(['check-runs', 'status']);
    expect(r).toMatchObject({ headSha: SHA, checks: [{ bucket: 'fail' }] });
  });

  it('ignores a workflow run that reports another commit', async () => {
    const c = new GhCliClient({ repo: 'acme/app', env: { PATH: '/bin', GH_TOKEN: TOKEN }, runner: async (argv) => {
      if (argv[1] === 'api') return res({ exitCode: 1, stderr: 'HTTP 403' });
      return res({ stdout: JSON.stringify([{ databaseId: 9, status: 'completed', conclusion: 'success', workflowName: 'ci', url: 'u', headSha: 'e'.repeat(40) }]) });
    } });
    expect(await c.listChecks({ sha: SHA })).toEqual({ checks: [], absent: true, headSha: SHA });
  });

  it('FakeGitHub reports which commit its PR checks are for', async () => {
    const d = mkdtempSync(join(tmpdir(), 'orbit-fake-'));
    try {
      const f = new FakeGitHub({ statePath: join(d, 's.json') });
      await f.createPullRequest({ head: 'orbit/r1', base: 'main', title: 't', body: 'b', draft: true });
      f.setHead('orbit/r1', SHA);
      expect((await f.listChecks({ pr: 1, sha: 'd'.repeat(40) })).headSha).toBe(SHA);
      expect((await f.listChecks({ sha: 'd'.repeat(40) })).headSha).toBe('d'.repeat(40));
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('GhCliClient.listChecks reads checks per commit and labels them from the response', () => {
  const TOKEN = 'github_pat_scopedtokenvalue0123456789';
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  const run = (sha: string, conclusion: string, over: Record<string, unknown> = {}) => ({ id: 1, name: 'build', head_sha: sha, status: 'completed', conclusion, html_url: 'https://github.com/acme/app/actions/runs/5/job/6', started_at: 's', completed_at: 'c', ...over });

  /** The branch moved from A to B between the head lookup and a PR-level checks read: B's green checks must not count for A. */
  function movingBranch(calls: string[]): GhRunner {
    return async (argv) => {
      calls.push(argv.slice(1).join(' '));
      if (argv[1] === 'pr' && argv[2] === 'view') return res({ stdout: JSON.stringify({ ...PR, headRefOid: A }) });
      if (argv[1] === 'pr' && argv[2] === 'checks') return res({ stdout: JSON.stringify([{ name: 'build', state: 'SUCCESS', bucket: 'pass', link: '' }]) });
      const path = argv.find((a) => a.startsWith('repos/')) ?? '';
      if (path.startsWith(`repos/acme/app/commits/${A}/check-runs`)) return res({ stdout: JSON.stringify({ total_count: 1, check_runs: [run(A, 'failure')] }) });
      if (path.startsWith(`repos/acme/app/commits/${A}/status`)) return res({ stdout: JSON.stringify({ state: 'pending', sha: A, total_count: 0, statuses: [] }) });
      if (argv[1] === 'run') return res({ stdout: '[]' });
      return res({ exitCode: 1, stderr: `unexpected: ${argv.join(' ')}` });
    };
  }

  it("never reports another commit's green checks as the asked commit's", async () => {
    const calls: string[] = [];
    const c = new GhCliClient({ repo: 'acme/app', env: { PATH: '/bin', GH_TOKEN: TOKEN }, runner: movingBranch(calls) });
    const r = await c.listChecks({ pr: 7, sha: A });
    expect(r.headSha).toBe(A);
    expect(r.checks).toEqual([expect.objectContaining({ name: 'build', bucket: 'fail', runId: '5', jobId: '6' })]);
    expect(calls.some((l) => l.startsWith('pr checks'))).toBe(false);
    expect(calls.some((l) => l.includes(`repos/acme/app/commits/${A}/check-runs`))).toBe(true);
  });

  it('labels the result with the commit the response reports, not the one asked about', async () => {
    const c = new GhCliClient({ repo: 'acme/app', env: { PATH: '/bin', GH_TOKEN: TOKEN }, runner: async (argv) => {
      const path = argv.find((a) => a.startsWith('repos/')) ?? '';
      if (path.includes('/check-runs')) return res({ stdout: JSON.stringify({ total_count: 1, check_runs: [run(B, 'success')] }) });
      return res({ stdout: JSON.stringify({ state: 'success', sha: B, total_count: 0, statuses: [] }) });
    } });
    const r = await c.listChecks({ sha: A });
    expect(r.headSha).toBe(B);
    expect(r.checks.filter((x) => x.bucket === 'pass')).toEqual([]);
  });

  it('merges the combined status contexts with the check runs, paging through every check run', async () => {
    const calls: string[] = [];
    const c = new GhCliClient({ repo: 'acme/app', env: { PATH: '/bin', GH_TOKEN: TOKEN }, runner: async (argv) => {
      const path = argv.find((a) => a.startsWith('repos/')) ?? '';
      calls.push(path);
      if (path.includes('/check-runs') && /[?&]page=1(&|$)/.test(path)) return res({ stdout: JSON.stringify({ total_count: 101, check_runs: Array.from({ length: 100 }, (_, i) => run(A, 'success', { id: i, name: `job-${i}` })) }) });
      if (path.includes('/check-runs')) return res({ stdout: JSON.stringify({ total_count: 101, check_runs: [run(A, 'in_progress', { id: 100, name: 'slow', status: 'in_progress', conclusion: null })] }) });
      return res({ stdout: JSON.stringify({ state: 'failure', sha: A, total_count: 2, statuses: [{ context: 'ext/scan', state: 'failure', target_url: 'https://ci.example/1', description: 'found 1' }, { context: 'ext/lint', state: 'success', target_url: null, description: null }] }) });
    } });
    const r = await c.listChecks({ sha: A });
    expect(r.headSha).toBe(A);
    expect(r.checks).toHaveLength(103);
    expect(r.checks.find((x) => x.name === 'slow')!.bucket).toBe('pending');
    expect(r.checks.find((x) => x.name === 'ext/scan')).toMatchObject({ bucket: 'fail', description: 'found 1' });
    expect(r.checks.find((x) => x.name === 'ext/lint')!.bucket).toBe('pass');
    expect(calls.filter((p) => p.includes('/check-runs'))).toHaveLength(2);
  });
  describe('combined commit status pagination and aggregate state', () => {
    const ctx = (i: number, state = 'success') => ({ context: `job-${i}`, state, target_url: null, description: null });
    const page = (path: string): number => Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? '1');

    /** A host with `contexts` status contexts (page size 100), the given aggregate state and an empty check-run list. */
    function host(contexts: ReturnType<typeof ctx>[], aggregate: string, calls: string[] = [], total = contexts.length): GhRunner {
      return async (argv) => {
        const path = argv.find((a) => a.startsWith('repos/')) ?? '';
        calls.push(path);
        if (argv[1] === 'run') return res({ stdout: '[]' });
        if (path.includes('/check-runs')) return res({ stdout: JSON.stringify({ total_count: 0, check_runs: [] }) });
        const n = page(path);
        return res({ stdout: JSON.stringify({ sha: A, state: aggregate, total_count: total, statuses: contexts.slice((n - 1) * 100, n * 100) }) });
      };
    }
    const client = (runner: GhRunner) => new GhCliClient({ repo: 'acme/app', env: { PATH: '/bin', GH_TOKEN: TOKEN }, runner });

    it('keeps the aggregate state and total_count of the page, and ignores values that are not a state and a count', () => {
      expect(parseCombinedStatus(JSON.stringify({ sha: A, state: 'FAILURE', total_count: 101, statuses: [ctx(1)] }))).toMatchObject({ sha: A, state: 'failure', total: 101 });
      const bare = parseCombinedStatus(JSON.stringify({ sha: A, state: '', total_count: -1, statuses: [] }));
      expect(bare).not.toHaveProperty('state');
      expect(bare).not.toHaveProperty('total');
    });

    it('does not turn a failing aggregate green when the failing context is beyond the first page (reviewer scenario)', async () => {
      // Every request answers with the same first 100 successful contexts, the aggregate failure and total_count 101.
      const c = client(async (argv) => {
        const path = argv.find((a) => a.startsWith('repos/')) ?? '';
        const payload = path.includes('/check-runs')
          ? { total_count: 0, check_runs: [] }
          : { sha: A, state: 'failure', total_count: 101, statuses: Array.from({ length: 100 }, (_, i) => ctx(i)) };
        return res({ stdout: JSON.stringify(payload) });
      });
      const result = await c.listChecks({ sha: A });
      expect(result.checks.some((check) => check.bucket === 'fail')).toBe(true);
    });

    it('reads every page and sees the failing context on the second', async () => {
      const calls: string[] = [];
      const contexts = [...Array.from({ length: 100 }, (_, i) => ctx(i)), { ...ctx(100, 'failure'), context: 'security/scan' }];
      const r = await client(host(contexts, 'failure', calls)).listChecks({ sha: A });
      expect(calls.filter((p) => p.includes('/status'))).toHaveLength(2);
      expect(r.checks).toHaveLength(101);
      expect(r.checks.find((x) => x.name === 'security/scan')).toMatchObject({ bucket: 'fail' });
      expect(r.checks.filter((x) => x.bucket === 'fail')).toHaveLength(1);
    });

    it('reads all pages of a commit with only successful contexts and reports it green', async () => {
      const contexts = Array.from({ length: 230 }, (_, i) => ctx(i));
      const calls: string[] = [];
      const r = await client(host(contexts, 'success', calls)).listChecks({ sha: A });
      expect(calls.filter((p) => p.includes('/status'))).toHaveLength(3);
      expect(r.checks).toHaveLength(230);
      expect(r.checks.every((x) => x.bucket === 'pass')).toBe(true);
    });

    it('keeps an incomplete read pending: fewer contexts than total_count are never a pass', async () => {
      // The host claims 150 contexts but serves 100 and then an empty page.
      const r = await client(host(Array.from({ length: 100 }, (_, i) => ctx(i)), 'pending', [], 150)).listChecks({ sha: A });
      expect(r.checks.some((x) => x.bucket === 'pending')).toBe(true);
      expect(r.checks.some((x) => x.bucket === 'fail')).toBe(false);
    });

    it('maps an aggregate error to a fail bucket even when every read context is green', async () => {
      const r = await client(host([ctx(1), ctx(2)], 'error')).listChecks({ sha: A });
      expect(r.checks.filter((x) => x.bucket === 'fail')).toHaveLength(1);
    });

    it('does not pass when the aggregate is pending although every read context is green', async () => {
      const r = await client(host([ctx(1), ctx(2)], 'pending')).listChecks({ sha: A });
      expect(r.checks.some((x) => x.bucket === 'pending')).toBe(true);
    });

    it('adds nothing for a complete, consistent read, or for a commit with no statuses at all', async () => {
      expect((await client(host([ctx(1), ctx(2)], 'success')).listChecks({ sha: A })).checks).toHaveLength(2);
      expect((await client(host([], 'pending')).listChecks({ sha: A })).checks).toHaveLength(0);
    });

    it('is judged failed by observeCi, not passed, for the reviewer scenario', async () => {
      const contexts = [...Array.from({ length: 100 }, (_, i) => ctx(i)), { ...ctx(100, 'failure'), context: 'security/scan' }];
      const r = await observeCi({ client: client(host(contexts, 'failure')), sha: A, clock: new ManualClock(), timeoutMs: 0, readLogs: false });
      expect(r.state).toBe('failed');
    });

    it('is never passed by observeCi while the read is incomplete', async () => {
      const r = await observeCi({ client: client(host(Array.from({ length: 100 }, (_, i) => ctx(i)), 'pending', [], 150)), sha: A, clock: new ManualClock(), timeoutMs: 0, readLogs: false });
      expect(r.state).toBe('pending');
    });

    it('keeps a check-run list pending when a short page ends the read before total_count', async () => {
      const calls: string[] = [];
      const c = client(async (argv) => {
        const path = argv.find((a) => a.startsWith('repos/')) ?? '';
        calls.push(path);
        if (path.includes('/check-runs')) return res({ stdout: JSON.stringify({ total_count: 150, check_runs: Array.from({ length: 10 }, (_, i) => run(A, 'success', { id: i, name: `job-${i}` })) }) });
        return res({ stdout: JSON.stringify({ sha: A, state: 'success', total_count: 0, statuses: [] }) });
      });
      const r = await c.listChecks({ sha: A });
      expect(r.checks.some((x) => x.bucket === 'pending')).toBe(true);
    });
  });
});
