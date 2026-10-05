// A transient provider failure of the implementer is retried within the same attempt, after a recorded
// backoff, and the next session does not start before it (spec section 14; docs/gaps.md G13).
import { afterEach, describe, expect, it } from 'vitest';
import { Controller } from '../../../src/controller/loop.ts';
import { listWorkers } from '../../../src/storage/workers.ts';
import { baseScenario, implementMul, labDeps, makeLab, runState, startLabRun, writeScenario, type Lab } from './harness.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

const labs: Lab[] = [];
afterEach(() => {
  for (const l of labs.splice(0)) l.close();
});

describe.skipIf(!canStripTypes)('controller: worker retry backoff', () => {
  it('a transient implementer failure waits out a recorded backoff, then a new session of the same attempt succeeds', async () => {
    const l = makeLab();
    labs.push(l);
    writeScenario(l, baseScenario({ implementer: [{ outcome: 'transient' }, implementMul('*')] }));
    const run = startLabRun(l);
    await new Controller({ mode: 'foreground', runId: run.id, deps: labDeps(l), tickIntervalMs: 20, leaseTtlMs: 30_000, graceMs: 300 }).start();

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const retries = l.db().all<{ ts: number; data_json: string }>("SELECT ts, data_json FROM events WHERE run_id = ? AND type = 'worker.retry' ORDER BY id", run.id);
    expect(retries).toHaveLength(1);
    const r = JSON.parse(retries[0]!.data_json) as { base: string; purpose: string; retry: number; delay_ms: number; ceiling_ms: number; not_before: number };
    expect(r).toMatchObject({ base: 'implement:1', purpose: 'implement:1#1', retry: 1 });
    expect(r.delay_ms).toBeLessThanOrEqual(r.ceiling_ms);
    // not_before is computed just before the event is appended, so the event is stamped the same millisecond or a few later.
    const stamped = retries[0]!.ts - (r.not_before - r.delay_ms);
    expect(stamped).toBeGreaterThanOrEqual(0);
    expect(stamped).toBeLessThan(1_000);
    const workers = listWorkers(l.db(), { runId: run.id, role: 'implementer' });
    expect(workers.map((w) => [w.purpose, w.attempt, w.resultStatus])).toEqual([
      ['implement:1#1', 1, 'transient_error'],
      ['implement:1#2', 1, 'succeeded'],
    ]);
    expect(workers[1]!.createdAt).toBeGreaterThanOrEqual(r.not_before);
    // Infrastructure retries do not consume implementation attempts.
    expect(l.db().get<{ used: number }>("SELECT used FROM budget_counters WHERE run_id = ? AND counter = 'implementation_attempts'", run.id)?.used).toBe(1);
    expect(l.db().get<{ used: number }>("SELECT used FROM budget_counters WHERE run_id = ? AND counter = 'infrastructure_retries'", run.id)?.used).toBe(1);
  }, 60_000);
});
