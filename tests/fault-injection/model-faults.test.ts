// Provider and model faults (spec sections 12, 14 and 17): malformed model output, expired
// credentials, and a mandatory independent reviewer that is not available.
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { listDecisions } from '../../src/storage/decisions.ts';
import { listWorkers } from '../../src/storage/workers.ts';
import { listReviews } from '../../src/review/store.ts';
import { MAX_REGENERATIONS } from '../../src/controller/steps/common.ts';
import { APPROVE, baseScenario, calls, canStripTypes, drive, events, implementMul, PLANNER_OUTPUT, readText, runState, startLabRun, tracker, transitions, writeScenario } from './helpers.ts';

const t = tracker();
afterEach(() => t.cleanup());

describe.skipIf(!canStripTypes)('fault: malformed model output', () => {
  it('a planner that keeps returning malformed output is regenerated a bounded number of times, then the run blocks', async () => {
    const l = t.lab();
    // A torn result line, then structured output that is valid JSON but not the planner schema, then more of the same.
    writeScenario(l, baseScenario({ planner: [{ outcome: 'malformed' }, { structured: { objective: 42, criteria: 'none' } }, { outcome: 'malformed' }], implementer: [implementMul('*')] }));
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state).toBe('BLOCKED');
    expect(done.outcomeReason).toMatch(new RegExp(`no usable result after ${MAX_REGENERATIONS} attempt`));
    expect(calls(l, 'planner')).toHaveLength(MAX_REGENERATIONS);
    expect(events(l, run.id, 'worker.regenerate')).toHaveLength(MAX_REGENERATIONS - 1);
    // Nothing downstream ran on output that never validated.
    expect(listWorkers(l.db(), { runId: run.id, role: 'implementer' })).toEqual([]);
    expect(runState(l, run.id).contractJson).toBeNull();
  }, 30_000);

  it('one malformed answer is regenerated and the run carries on', async () => {
    const l = t.lab();
    writeScenario(l, baseScenario({ planner: [{ outcome: 'malformed' }, { structured: PLANNER_OUTPUT }], implementer: [implementMul('*')] }));
    const run = startLabRun(l);
    await drive(l, run.id);
    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(calls(l, 'planner')).toHaveLength(2);
    expect(events(l, run.id, 'worker.regenerate')).toHaveLength(1);
  }, 30_000);
});

describe.skipIf(!canStripTypes)('fault: expired credentials', () => {
  // DEFECT: controller/workers.ts:132 (accountFinished) charges the unreported cost of the auth-failed session at its ceiling (spend cap plus a worst-case request) before blockOnAuth runs; the charge reaches the cap less the reserve, so the run ends EXHAUSTED instead of BLOCKED on credentials.
  it.fails('an implementer whose credentials expire mid-run blocks the run with a truthful blocker and is not retried', async () => {
    const l = t.lab();
    // hangAfterRetry: the provider would keep retrying for a long time; the shim must stop it on the first auth retry.
    writeScenario(l, baseScenario({ implementer: [{ outcome: 'auth_failure', hangAfterRetry: 60_000 }, implementMul('*')] }));
    const run = startLabRun(l);
    const t0 = Date.now();
    await drive(l, run.id);
    expect(Date.now() - t0).toBeLessThan(20_000);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    expect(done.outcomeReason).toMatch(/Blocked: the claude credentials/);
    expect(done.outcomeReason).toMatch(/does not retry authentication failures/);
    expect(done.outcomeReason).toContain(`orbit resume ${run.id}`);
    expect(calls(l, 'implementer')).toHaveLength(1);
    expect(listWorkers(l.db(), { runId: run.id, role: 'implementer' }).map((w) => w.resultStatus)).toEqual(['auth_failed']);
    expect(events(l, run.id, 'worker.retry')).toEqual([]);
    expect(listWorkers(l.db(), { runId: run.id, role: 'reviewer' })).toEqual([]);
    expect(readText(join(l.repo, '.orbit', 'runs', run.id, 'final.md'))).toMatch(/credentials/);
  }, 30_000);

  it('a reviewer whose credentials expire blocks the run; review is not retried and no other reviewer stands in', async () => {
    const l = t.lab();
    writeScenario(l, baseScenario({ implementer: [implementMul('*')], reviewer: [{ outcome: 'auth_failure' }, APPROVE] }));
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state).toBe('BLOCKED');
    expect(done.outcomeReason).toMatch(/Blocked: the codex credentials/);
    expect(calls(l, 'reviewer')).toHaveLength(1);
    expect(calls(l, 'reviewer')[0]!.tool).toBe('codex');
    expect(listReviews(l.db(), run.id).filter((r) => r.verdict === 'APPROVE')).toEqual([]);
    expect(transitions(l, run.id)).not.toContain('REVIEWING>DELIVERING');
  }, 30_000);
});

describe.skipIf(!canStripTypes)('fault: unavailable reviewer', () => {
  it('a mandatory independent reviewer that is missing blocks the run with the reason; nothing is substituted', async () => {
    const l = t.lab({
      tweak: (c) => {
        c.providers.codex = { ...c.providers.codex!, command: '/nonexistent/acme/bin/codex' };
        c.review = { ...c.review, independent_provider_required: true, fallback_same_provider_allowed: false, preferred_provider: 'codex' };
      },
    });
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state).toBe('BLOCKED');
    expect(done.outcomeReason).toMatch(/codex/);
    expect(done.outcomeReason).toMatch(/unavailable|not available|not found|missing/i);
    // No substitution: no reviewer of any provider ran, and no review was recorded.
    expect(calls(l, 'reviewer')).toEqual([]);
    expect(listWorkers(l.db(), { runId: run.id, role: 'reviewer' })).toEqual([]);
    expect(listReviews(l.db(), run.id)).toEqual([]);
    expect(transitions(l, run.id)).not.toContain('REVIEWING>DELIVERING');
    expect(listDecisions(l.db(), run.id).map((d) => d.kind)).not.toContain('gate.completion');
  }, 30_000);
});
