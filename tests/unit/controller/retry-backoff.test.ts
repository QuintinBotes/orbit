// Worker transient failures back off before the next session starts (spec section 14; docs/gaps.md G13).
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManualClock } from '../../../src/core/clock.ts';
import { nullLogger } from '../../../src/core/log.ts';
import { openDb } from '../../../src/storage/db.ts';
import { createRun, getRun } from '../../../src/controller/run-store.ts';
import type { RunContext } from '../../../src/controller/context.ts';
import { retryAfterHintMs, retryWait, scheduleTransientRetry, WORKER_RETRY_EVENT, type RetryRecord } from '../../../src/controller/steps/common.ts';
import { DEFAULT_BACKOFF } from '../../../src/recovery/backoff.ts';

function context(random: () => number): { ctx: RunContext; clock: ManualClock } {
  const db = openDb(':memory:');
  const clock = new ManualClock();
  createRun(db, { id: 'run-1', repoRoot: '/repo/acme', goal: 'g', mode: 'autonomous', policyHash: 'sha256:x', policyPath: '/p' }, clock);
  const ctx = {
    db,
    clock,
    log: nullLogger,
    ownerId: 'ctl-1',
    run: getRun(db, 'run-1'),
    ledger: null,
    runDir: mkdtempSync(join(tmpdir(), 'orbit-retry-')),
    deps: { random },
  } as unknown as RunContext;
  return { ctx, clock };
}

function records(ctx: RunContext): RetryRecord[] {
  return ctx.db.all<{ data_json: string }>('SELECT data_json FROM events WHERE run_id = ? AND type = ? ORDER BY id', 'run-1', WORKER_RETRY_EVENT).map((r) => JSON.parse(r.data_json) as RetryRecord);
}

const failure = (purpose: string, error: string | null = 'API Error: 529 overloaded') => ({ base: 'implement:1', purpose, what: 'implementer (attempt 1)', status: 'transient_error', error });

describe('worker retry backoff', () => {
  it('two transient failures give two increasing, jittered waits within the ceiling, and nothing starts before each passes', async () => {
    const { ctx, clock } = context(() => 0.5);
    const t0 = clock.now();
    expect(await scheduleTransientRetry(ctx, failure('implement:1#1'))).toBeNull();
    const [first] = records(ctx);
    expect(first).toMatchObject({ retry: 1, ceiling_ms: DEFAULT_BACKOFF.baseMs, not_before: t0 + first!.delay_ms });
    expect(first!.delay_ms).toBeGreaterThan(0);
    expect(first!.delay_ms).toBeLessThanOrEqual(first!.ceiling_ms);
    expect(retryWait(ctx, 'implement:1')?.waiting).toMatch(/backing off \d+ ms after a transient failure \(retry 1\)/);
    clock.advance(first!.delay_ms);
    expect(retryWait(ctx, 'implement:1')).toBeNull();

    expect(await scheduleTransientRetry(ctx, failure('implement:1#2'))).toBeNull();
    const second = records(ctx)[1]!;
    expect(second.retry).toBe(2);
    expect(second.ceiling_ms).toBe(DEFAULT_BACKOFF.baseMs * DEFAULT_BACKOFF.factor);
    expect(second.delay_ms).toBeGreaterThan(first!.delay_ms);
    expect(second.delay_ms).toBeLessThanOrEqual(second.ceiling_ms);
    expect(retryWait(ctx, 'implement:1')).not.toBeNull();
    // Other units are not held back by this one's backoff.
    expect(retryWait(ctx, 'plan')).toBeNull();
  });

  it('the jitter is full: a different random draw gives a different wait under the same ceiling', async () => {
    const low = context(() => 0.1);
    const high = context(() => 0.9);
    await scheduleTransientRetry(low.ctx, failure('implement:1#1'));
    await scheduleTransientRetry(high.ctx, failure('implement:1#1'));
    const a = records(low.ctx)[0]!;
    const b = records(high.ctx)[0]!;
    expect(a.ceiling_ms).toBe(b.ceiling_ms);
    expect(a.delay_ms).toBeLessThan(b.delay_ms);
  });

  it('observing the same failed worker again neither records nor waits twice', async () => {
    const { ctx } = context(() => 0.5);
    await scheduleTransientRetry(ctx, failure('implement:1#1'));
    await scheduleTransientRetry(ctx, failure('implement:1#1'));
    expect(records(ctx)).toHaveLength(1);
  });

  it('a provider retry-after is honoured even past the backoff ceiling', async () => {
    const { ctx, clock } = context(() => 0.5);
    await scheduleTransientRetry(ctx, failure('implement:1#1', 'rate limited; retry after 30s'));
    const [r] = records(ctx);
    expect(r!.retry_after_ms).toBe(30_000);
    expect(r!.delay_ms).toBe(30_000);
    expect(r!.not_before).toBe(clock.now() + 30_000);
  });

  it('reads retry-after hints in seconds and milliseconds, and nothing else', () => {
    expect(retryAfterHintMs('retry-after: 1500 ms')).toBe(1500);
    expect(retryAfterHintMs('Please retry after 2 seconds')).toBe(2000);
    expect(retryAfterHintMs('API Error: 529 overloaded')).toBeNull();
    expect(retryAfterHintMs(null)).toBeNull();
  });
});
