import { describe, expect, it, vi } from 'vitest';
import { ManualClock } from '../../../src/core/clock.ts';
import { OrbitError } from '../../../src/core/errors.ts';
import {
  DEFAULT_BACKOFF,
  backoffCeilingMs,
  backoffDelayMs,
  classifyFailure,
  decideRetry,
  retryWithBackoff,
  type BackoffPolicy,
  type RetryContext,
} from '../../../src/recovery/backoff.ts';

const policy: BackoffPolicy = { baseMs: 100, maxMs: 1_000, factor: 2, maxAttempts: 4 };

describe('backoff bounds', () => {
  it('grows exponentially to the ceiling and stays there', () => {
    expect([1, 2, 3, 4, 5, 6, 40, 1000].map((n) => backoffCeilingMs(n, policy))).toEqual([100, 200, 400, 800, 1000, 1000, 1000, 1000]);
  });

  it('full jitter spans [0, ceiling]: the extremes of the random source reach both ends and never exceed them', () => {
    expect(backoffDelayMs(3, policy, () => 0)).toBe(0);
    expect(backoffDelayMs(3, policy, () => 0.999999999)).toBe(400);
    expect(backoffDelayMs(3, policy, () => 0.5)).toBe(200);
    // Property: for any random value in [0, 1) the wait is an integer within the ceiling.
    for (let retry = 1; retry <= 12; retry++) {
      for (const r of [0, 0.001, 0.25, 0.5, 0.75, 0.999999]) {
        const d = backoffDelayMs(retry, policy, () => r);
        expect(Number.isInteger(d)).toBe(true);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(backoffCeilingMs(retry, policy));
      }
    }
  });

  it('uses Math.random by default and stays within bounds', () => {
    for (let i = 0; i < 50; i++) expect(backoffDelayMs(2)).toBeLessThanOrEqual(backoffCeilingMs(2, DEFAULT_BACKOFF));
  });

  it('rejects a broken random source and broken policies', () => {
    expect(() => backoffDelayMs(1, policy, () => 1)).toThrow(/\[0, 1\)/);
    expect(() => backoffDelayMs(1, policy, () => Number.NaN)).toThrow();
    expect(() => backoffCeilingMs(0, policy)).toThrow(/positive integer/);
    expect(() => backoffCeilingMs(1, { ...policy, maxMs: 10 })).toThrow(/invalid backoff policy/);
    expect(() => backoffCeilingMs(1, { ...policy, factor: 0.5 })).toThrow(/invalid backoff policy/);
    expect(() => backoffCeilingMs(1, { ...policy, maxAttempts: 0 })).toThrow(/invalid backoff policy/);
  });
});

describe('classifyFailure', () => {
  const kind = (s: Parameters<typeof classifyFailure>[0]) => classifyFailure(s).kind;

  it('classifies adapter task statuses', () => {
    expect(kind({ status: 'auth_failed' })).toBe('authentication');
    expect(kind({ status: 'transient_error' })).toBe('transient');
    expect(kind({ status: 'malformed_output' })).toBe('malformed_output');
    expect(kind({ status: 'timeout' })).toBe('timeout');
    expect(kind({ status: 'lost' })).toBe('crash');
    expect(kind({ status: 'max_turns' })).toBe('permanent');
    expect(kind({ status: 'cancelled' })).toBe('permanent');
  });

  it('classifies OrbitError codes', () => {
    expect(kind({ error: new OrbitError('AUTH_EXPIRED', 'x') })).toBe('authentication');
    expect(kind({ error: new OrbitError('AUTH_MISSING', 'x') })).toBe('authentication');
    expect(kind({ error: new OrbitError('PROVIDER_TRANSIENT', 'x') })).toBe('transient');
    expect(kind({ error: new OrbitError('MALFORMED_OUTPUT', 'x') })).toBe('malformed_output');
    expect(kind({ error: new OrbitError('PROVIDER_UNAVAILABLE', 'x') })).toBe('unavailable');
    expect(kind({ error: new OrbitError('POLICY_DENIED', 'x') })).toBe('permanent');
    expect(kind({ error: new OrbitError('BUDGET_EXHAUSTED', 'x') })).toBe('permanent');
  });

  it('classifies HTTP statuses: 401/403 are authentication, 429 and 5xx transient, other 4xx permanent', () => {
    for (const s of [401, 403]) expect(kind({ httpStatus: s })).toBe('authentication');
    for (const s of [408, 425, 429, 500, 502, 503, 504, 529, 599]) expect(kind({ httpStatus: s })).toBe('transient');
    for (const s of [400, 404, 422]) expect(kind({ httpStatus: s })).toBe('permanent');
  });

  it('classifies provider text, authentication before transient, unknown as permanent', () => {
    expect(kind({ message: 'Invalid API key · Fix external API key' })).toBe('authentication');
    expect(kind({ message: 'authentication_error: invalid x-api-key' })).toBe('authentication');
    expect(kind({ message: 'Not logged in. Run claude auth login' })).toBe('authentication');
    expect(kind({ message: 'OAuth token has expired' })).toBe('authentication');
    expect(kind({ message: '401 Unauthorized, please retry later' })).toBe('authentication');
    expect(kind({ message: 'Overloaded' })).toBe('transient');
    expect(kind({ message: 'read ECONNRESET' })).toBe('transient');
    expect(kind({ message: 'HTTP 429 rate limit exceeded' })).toBe('transient');
    expect(kind({ message: 'output is not valid JSON' })).toBe('malformed_output');
    expect(kind({ message: 'the build is broken' })).toBe('permanent');
    expect(kind({})).toBe('permanent');
  });

  it('carries a retry-after hint from the signal or the error details', () => {
    expect(classifyFailure({ status: 'transient_error', retryAfterMs: 5_000 }).retryAfterMs).toBe(5_000);
    expect(classifyFailure({ error: new OrbitError('PROVIDER_TRANSIENT', 'x', { retryAfterMs: 7_000 }) }).retryAfterMs).toBe(7_000);
    expect(classifyFailure({ status: 'transient_error' }).retryAfterMs).toBeNull();
  });
});

describe('decideRetry', () => {
  const base = (over: Partial<RetryContext> = {}): RetryContext => ({
    classification: { kind: 'transient', reason: 't', retryAfterMs: null },
    attempt: 1,
    policy,
    random: () => 0.5,
    infrastructureRetriesRemaining: 5,
    wallRemainingMs: 600_000,
    costRemainingUsd: 10,
    ...over,
  });
  const cls = (kind: RetryContext['classification']['kind'], retryAfterMs: number | null = null) => ({ kind, reason: kind, retryAfterMs });

  it('retries a transient failure within the ceiling and counts the next attempt', () => {
    const d = decideRetry(base({ attempt: 2 }));
    expect(d).toMatchObject({ action: 'retry', ceilingMs: 200, nextAttempt: 3, delayMs: 100 });
  });

  it('stops at the attempt limit, the infrastructure retry budget, the wall budget and the cost budget, naming the one that bound', () => {
    expect(decideRetry(base({ attempt: 4 }))).toMatchObject({ action: 'stop', limit: 'attempts' });
    expect(decideRetry(base({ infrastructureRetriesRemaining: 0 }))).toMatchObject({ action: 'stop', limit: 'infrastructure_retries' });
    expect(decideRetry(base({ attempt: 3, wallRemainingMs: 200 }))).toMatchObject({ action: 'stop', limit: 'wall' });
    expect(decideRetry(base({ costRemainingUsd: 0 }))).toMatchObject({ action: 'stop', limit: 'cost' });
    expect(decideRetry(base({ costRemainingUsd: 1, estimatedCostUsd: 2 }))).toMatchObject({ action: 'stop', limit: 'cost' });
    expect(decideRetry(base({ costRemainingUsd: null, wallRemainingMs: null }))).toMatchObject({ action: 'retry' });
  });

  it('honours a provider retry-after beyond the ceiling, and refuses a wait the wall budget cannot afford', () => {
    expect(decideRetry(base({ classification: cls('transient', 30_000) }))).toMatchObject({ action: 'retry', delayMs: 30_000 });
    expect(decideRetry(base({ classification: cls('transient', 30_000), wallRemainingMs: 20_000 }))).toMatchObject({ action: 'stop', limit: 'wall' });
  });

  it('never retries authentication: it blocks with a message naming the provider and the command', () => {
    const d = decideRetry(base({ classification: cls('authentication'), provider: 'claude', runId: 'orb-1', attempt: 1 }));
    expect(d.action).toBe('block');
    if (d.action !== 'block') return;
    expect(d.blocker.provider).toBe('claude');
    expect(d.blocker.command).toBe('claude auth login');
    expect(d.blocker.message).toMatch(/claude/);
    expect(d.blocker.message).toMatch(/orbit resume orb-1/);
    expect(d.blocker.message).toMatch(/does not retry/);
  });

  it('regenerates malformed output a bounded number of times, then stops', () => {
    expect(decideRetry(base({ classification: cls('malformed_output'), regenerationsUsed: 0 }))).toMatchObject({ action: 'regenerate', regeneration: 1, remaining: 1 });
    expect(decideRetry(base({ classification: cls('malformed_output'), regenerationsUsed: 1 }))).toMatchObject({ action: 'regenerate', regeneration: 2, remaining: 0 });
    expect(decideRetry(base({ classification: cls('malformed_output'), regenerationsUsed: 2 }))).toMatchObject({ action: 'stop', limit: 'regenerations' });
    expect(decideRetry(base({ classification: cls('malformed_output'), regenerationsUsed: 0, maxRegenerations: 0 }))).toMatchObject({ action: 'stop', limit: 'regenerations' });
    // Regeneration costs a model call, so the cost budget still binds it.
    expect(decideRetry(base({ classification: cls('malformed_output'), costRemainingUsd: 0 }))).toMatchObject({ action: 'stop', limit: 'cost' });
  });

  it('routes the remaining kinds without a retry loop', () => {
    expect(decideRetry(base({ classification: cls('crash') })).action).toBe('restart');
    expect(decideRetry(base({ classification: cls('timeout') })).action).toBe('diagnose');
    expect(decideRetry(base({ classification: cls('unavailable') }))).toMatchObject({ action: 'stop', limit: 'unavailable' });
    expect(decideRetry(base({ classification: cls('permanent') }))).toMatchObject({ action: 'stop', limit: 'permanent' });
  });

  it('is bounded: following retry decisions until stop never exceeds maxAttempts', () => {
    let attempt = 1;
    let waits = 0;
    for (;;) {
      const d = decideRetry(base({ attempt, random: () => 0.999 }));
      if (d.action !== 'retry') break;
      expect(d.delayMs).toBeLessThanOrEqual(policy.maxMs);
      waits++;
      attempt = d.nextAttempt;
    }
    expect(waits).toBe(policy.maxAttempts - 1);
  });
});

describe('retryWithBackoff', () => {
  const budget = (remaining: number) => {
    const state = { remaining, consumed: 0 };
    return {
      state,
      b: {
        consume: () => {
          state.consumed++;
          state.remaining--;
        },
        infrastructureRetriesRemaining: () => state.remaining,
      },
    };
  };

  it('retries transient failures with jittered waits on the injected clock, charging the budget once per retry', async () => {
    const clock = new ManualClock();
    const t0 = clock.now();
    const { state, b } = budget(5);
    const waits: number[] = [];
    const result = await retryWithBackoff(
      async (attempt) => {
        if (attempt < 3) throw new OrbitError('PROVIDER_TRANSIENT', 'overloaded');
        return `ok after ${attempt}`;
      },
      { clock, budget: b, policy, random: () => 0.5, onRetry: (i) => waits.push(i.delayMs) },
    );
    expect(result).toBe('ok after 3');
    expect(waits).toEqual([50, 100]);
    expect(clock.now() - t0).toBe(150);
    expect(state.consumed).toBe(2);
  });

  it('gives up with the original error when the infrastructure budget runs out', async () => {
    const { state, b } = budget(1);
    const err = new OrbitError('PROVIDER_TRANSIENT', 'overloaded');
    let calls = 0;
    await expect(
      retryWithBackoff(async () => { calls++; throw err; }, { clock: new ManualClock(), budget: b, policy, random: () => 0 }),
    ).rejects.toBe(err);
    expect(calls).toBe(2);
    expect(state.consumed).toBe(1);
  });

  it('does not retry an authentication failure: one call, AUTH_EXPIRED carrying the blocker', async () => {
    const clock = new ManualClock();
    const t0 = clock.now();
    const { state, b } = budget(5);
    let calls = 0;
    const p = retryWithBackoff(async () => { calls++; throw new Error('Invalid API key · Fix external API key'); }, { clock, budget: b, provider: 'claude', runId: 'orb-9' });
    await expect(p).rejects.toMatchObject({ code: 'AUTH_EXPIRED', details: { blocker: { provider: 'claude', command: 'claude auth login' } } });
    expect(calls).toBe(1);
    expect(state.consumed).toBe(0);
    expect(clock.now()).toBe(t0);
  });

  it('rethrows non-transient failures untouched', async () => {
    const { b } = budget(5);
    const err = new OrbitError('POLICY_DENIED', 'no');
    let calls = 0;
    await expect(retryWithBackoff(async () => { calls++; throw err; }, { clock: new ManualClock(), budget: b })).rejects.toBe(err);
    expect(calls).toBe(1);
  });
});

describe('authentication advice follows the environment the workers get', () => {
  it('decideRetry and retryWithBackoff advise unsetting a key exported in the given environment, not the process one', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
    try {
      const env = { ANTHROPIC_API_KEY: 'sk-ant-acme-not-valid' };
      const auth = { kind: 'authentication', reason: '401', retryAfterMs: null } as const;
      const d = decideRetry({ classification: auth, provider: 'claude', attempt: 1, infrastructureRetriesRemaining: 3, wallRemainingMs: null, costRemainingUsd: null, env });
      expect(d.action === 'block' ? d.blocker.command : d.action).toMatch(/^unset ANTHROPIC_API_KEY/);
      const clock = new ManualClock(0);
      let caught: unknown;
      try {
        await retryWithBackoff(async () => { throw new OrbitError('AUTH_EXPIRED', 'expired'); }, { clock, provider: 'claude', env, budget: { consume: () => {}, infrastructureRetriesRemaining: () => 3 } });
      } catch (err) {
        caught = err;
      }
      expect((caught as OrbitError).message).toContain('ANTHROPIC_API_KEY is set');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
