import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../../src/core/clock.ts';
import { OrbitError } from '../../../src/core/errors.ts';
import { ciRepairBrief, observeCi, sanitizeLog, type CiFailure } from '../../../src/delivery/ci.ts';
import type { CheckInfo, ChecksResult, FailedLogs, GitHubClient } from '../../../src/delivery/github.ts';

const SHA = 'a'.repeat(40);

function check(name: string, bucket: CheckInfo['bucket'], runId: string | null = null): CheckInfo {
  return { name, bucket, state: bucket.toUpperCase(), link: null, workflow: null, runId, jobId: null, startedAt: null, completedAt: null, description: null };
}

/** Only the two calls observeCi makes. */
function stub(over: { listChecks?: () => Promise<ChecksResult>; failedLogs?: (runId: string) => Promise<FailedLogs> }): GitHubClient {
  const nope = async (): Promise<never> => {
    throw new Error('not used by observeCi');
  };
  return { findPullRequest: nope, createPullRequest: nope, updatePullRequest: nope, markPullRequestReady: nope, mergePullRequest: nope, getMergeState: nope, authStatus: nope, listChecks: nope, failedLogs: nope, ...over } as unknown as GitHubClient;
}

describe('observeCi: waiting out transient errors', () => {
  it('waits one poll interval when the host gives no retry-after hint, then reads the checks', async () => {
    const clock = new ManualClock();
    let calls = 0;
    const client = stub({
      listChecks: async () => {
        if (++calls === 1) throw new OrbitError('PROVIDER_TRANSIENT', 'HTTP 502');
        return { checks: [check('build', 'pass')], absent: false };
      },
    });
    const t0 = clock.now();
    const obs = await observeCi({ client, sha: SHA, timeoutMs: 60_000, clock, pollMs: 2_000 });
    expect(obs.state).toBe('passed');
    expect(obs.polls).toBe(1);
    expect(clock.now() - t0).toBe(2_000);
  });

  it('gives up after the allowed run of transient errors and rethrows the last one', async () => {
    const client = stub({
      listChecks: async () => {
        throw new OrbitError('PROVIDER_TRANSIENT', 'HTTP 503');
      },
    });
    await expect(observeCi({ client, sha: SHA, timeoutMs: 60_000, clock: new ManualClock(), pollMs: 10, maxTransientErrors: 1 })).rejects.toMatchObject({ code: 'PROVIDER_TRANSIENT' });
  });
});

describe('observeCi: no checks at all', () => {
  const none = stub({ listChecks: async () => ({ checks: [], absent: true }) });

  it('with a zero timeout reports pending, never passed', async () => {
    const obs = await observeCi({ client: none, sha: SHA, timeoutMs: 0, clock: new ManualClock() });
    expect(obs).toMatchObject({ state: 'pending', absent: true, polls: 1 });
  });

  it('after the grace period reports timeout, or passed only when the caller said a repository without CI passes', async () => {
    const t = await observeCi({ client: none, sha: SHA, timeoutMs: 5_000, absentGraceMs: 1_000, pollMs: 500, clock: new ManualClock() });
    expect(t.state).toBe('timeout');
    const p = await observeCi({ client: none, sha: SHA, timeoutMs: 5_000, absentGraceMs: 1_000, pollMs: 500, treatAbsentAsPassed: true, clock: new ManualClock() });
    expect(p.state).toBe('passed');
  });
});

describe('observeCi: failure logs', () => {
  const failing = (runs: (string | null)[]): ChecksResult => ({ checks: runs.map((r, i) => check(`job-${i}`, 'fail', r)), absent: false });

  it('fetches at most maxLogFetches distinct runs and marks the rest skipped', async () => {
    const fetched: string[] = [];
    const client = stub({
      listChecks: async () => failing(['1', '2', '3', null]),
      failedLogs: async (runId) => {
        fetched.push(runId);
        return { status: 'ok', text: `error in run ${runId}`, failedSteps: [] };
      },
    });
    const obs = await observeCi({ client, sha: SHA, timeoutMs: 1_000, clock: new ManualClock(), maxLogFetches: 2 });
    expect(obs.state).toBe('failed');
    expect(fetched).toEqual(['1', '2']);
    expect(obs.failures.map((f) => f.logStatus)).toEqual(['ok', 'ok', 'skipped', 'skipped']);
    expect(obs.failures[2]!.logExcerpt).toBe('');
  });

  it('reads no log when readLogs is false', async () => {
    let called = false;
    const client = stub({
      listChecks: async () => failing(['9']),
      failedLogs: async () => {
        called = true;
        return { status: 'ok', text: 'x', failedSteps: [] };
      },
    });
    const obs = await observeCi({ client, sha: SHA, timeoutMs: 0, clock: new ManualClock(), readLogs: false });
    expect(called).toBe(false);
    expect(obs.failures[0]).toMatchObject({ logStatus: 'skipped', logExcerpt: '' });
  });

  it('falls back to the failed step names, with or without a step, when the log itself is empty', async () => {
    const client = stub({
      listChecks: async () => failing(['7']),
      failedLogs: async () => ({ status: 'expired', text: '', failedSteps: [{ job: 'build', step: 'npm test' }, { job: 'lint', step: '' }] }),
    });
    const obs = await observeCi({ client, sha: SHA, timeoutMs: 0, clock: new ManualClock() });
    expect(obs.failures[0]).toMatchObject({ logStatus: 'expired', logExcerpt: 'build: step "npm test" failed\nlint failed' });
  });

  it('treats a log that cannot be read as unavailable, but never hides an authentication failure', async () => {
    const broken = stub({
      listChecks: async () => failing(['7']),
      failedLogs: async () => {
        throw new OrbitError('PROVIDER_TRANSIENT', 'HTTP 500');
      },
    });
    const obs = await observeCi({ client: broken, sha: SHA, timeoutMs: 0, clock: new ManualClock() });
    expect(obs.failures[0]).toMatchObject({ logStatus: 'unavailable', logExcerpt: '' });

    const plain = stub({
      listChecks: async () => failing(['7']),
      failedLogs: async () => {
        throw new Error('boom');
      },
    });
    expect((await observeCi({ client: plain, sha: SHA, timeoutMs: 0, clock: new ManualClock() })).failures[0]!.logStatus).toBe('unavailable');

    for (const code of ['AUTH_EXPIRED', 'AUTH_MISSING'] as const) {
      const auth = stub({
        listChecks: async () => failing(['7']),
        failedLogs: async () => {
          throw new OrbitError(code, 'no credentials');
        },
      });
      await expect(observeCi({ client: auth, sha: SHA, timeoutMs: 0, clock: new ManualClock() })).rejects.toMatchObject({ code });
    }
  });
});

describe('sanitizeLog and the repair brief with missing pieces', () => {
  it('prints a job without a step as "job: text"', () => {
    expect(sanitizeLog('build\t\tcompiling failed', { maxChars: 500 })).toBe('build: compiling failed');
    expect(sanitizeLog('build\tnpm test\tcompiling failed', { maxChars: 500 })).toBe('build / npm test: compiling failed');
  });

  it('omits the run id from evidence and fences when a check has none', () => {
    const f: CiFailure = { name: 'external', runId: null, logExcerpt: '', fingerprint: 'ci:abc', logStatus: 'skipped' };
    const brief = ciRepairBrief([f]);
    expect(brief.evidence).toEqual(['ci check "external": ci:abc']);
    expect(brief.untrustedLogs).toContain('label="CI failure: external"');
    expect(brief.untrustedLogs).toContain('(no log available: skipped)');
    const withRun = ciRepairBrief([{ ...f, runId: '55' }]);
    expect(withRun.evidence).toEqual(['ci check "external" (run 55): ci:abc']);
    expect(withRun.untrustedLogs).toContain('label="CI failure: external run 55"');
  });
});
