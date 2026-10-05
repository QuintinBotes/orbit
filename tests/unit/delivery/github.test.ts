import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExecResult } from '../../../src/core/exec.ts';
import {
  FakeGitHub,
  GhCliClient,
  classifyGhFailure,
  parseAuthStatus,
  parseChecks,
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
      calls.push(`${argv[1]} ${argv[2]}`);
      if (argv[2] === 'view') return res({ stdout: JSON.stringify({ ...PR, headRefOid: sha }) });
      if (argv[1] === 'pr') return res({ exitCode: 1, stderr: "no checks reported on the 'orbit/r1' branch" });
      return res({ stdout: JSON.stringify([{ databaseId: 5, status: 'in_progress', conclusion: '', workflowName: 'ci', url: 'u' }]) });
    });
    const r = await c.listChecks({ pr: 7, sha });
    expect(calls).toEqual(['pr view', 'pr checks', 'run list']);
    expect(r).toMatchObject({ absent: false, headSha: sha, checks: [{ bucket: 'pending', runId: '5' }] });
    const none = await client(async () => res({ exitCode: 1, stderr: "no checks reported on the 'b' branch" })).listChecks({ pr: 7 });
    expect(none).toEqual({ checks: [], absent: true, headSha: null });
  });

  it('falls back to workflow runs when the token cannot read check runs', async () => {
    const c = client(async (argv) => {
      if (argv[2] === 'view') return res({ stdout: JSON.stringify({ ...PR, headRefOid: 'c'.repeat(40) }) });
      if (argv[1] === 'pr') return res({ exitCode: 1, stderr: 'Resource not accessible by personal access token (HTTP 403)' });
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

  it('when the PR head is another commit, reads workflow runs for the asked commit instead of the PR rollup', async () => {
    const calls: string[] = [];
    const c = new GhCliClient({ repo: 'acme/app', env: { PATH: '/bin', GH_TOKEN: TOKEN }, runner: async (argv) => {
      calls.push(`${argv[1]} ${argv[2]}`);
      if (argv[2] === 'view') return res({ stdout: JSON.stringify(PR) }); // head is a...a
      if (argv[2] === 'checks') return res({ stdout: JSON.stringify([{ name: 'build', state: 'SUCCESS', bucket: 'pass', link: '' }]) });
      return res({ stdout: JSON.stringify([{ databaseId: 9, status: 'in_progress', conclusion: '', workflowName: 'ci', url: 'u', headSha: SHA }]) });
    } });
    const r = await c.listChecks({ pr: 7, sha: SHA });
    expect(calls).toEqual(['pr view', 'run list']);
    expect(r).toMatchObject({ headSha: SHA, absent: false, checks: [{ bucket: 'pending', runId: '9' }] });
  });

  it('when the PR head is the asked commit, uses the PR checks and says which commit they are for', async () => {
    const calls: string[] = [];
    const c = new GhCliClient({ repo: 'acme/app', env: { PATH: '/bin', GH_TOKEN: TOKEN }, runner: async (argv) => {
      calls.push(`${argv[1]} ${argv[2]}`);
      if (argv[2] === 'view') return res({ stdout: JSON.stringify({ ...PR, headRefOid: SHA }) });
      return res({ stdout: JSON.stringify([{ name: 'build', state: 'FAILURE', bucket: 'fail', link: '' }]) });
    } });
    const r = await c.listChecks({ pr: 7, sha: SHA });
    expect(calls).toEqual(['pr view', 'pr checks']);
    expect(r).toMatchObject({ headSha: SHA, checks: [{ bucket: 'fail' }] });
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
