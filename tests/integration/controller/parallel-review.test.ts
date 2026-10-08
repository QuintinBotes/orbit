// Within-run parallel units (spec section 8; docs/gaps.md G14): a security-sensitive change that touches UI
// paths gets a security review and a UI review as separate read-only units that run at the same time, each
// bound to the candidate tree; a new candidate cancels both.
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultUi } from '../../../src/policy/config.ts';
import { loadRunContext } from '../../../src/controller/context.ts';
import { cancelObsoleteWork } from '../../../src/controller/steps/reviewing.ts';
import { step } from '../../../src/controller/steps/index.ts';
import { listWorkers, type WorkerRecord } from '../../../src/storage/workers.ts';
import { listReviews } from '../../../src/review/store.ts';
import { APPROVE, baseScenario, canStripTypes, drive, events, FIXED_PROBE, implementMul, PLANNER_OUTPUT, runState, startLabRun, stepTo, tracker, waitFor, writeScenario } from '../../fault-injection/helpers.ts';

const t = tracker();
afterEach(() => t.cleanup());

// The objective names a permission check, so planning classifies the change as security-sensitive; apps/** is a UI path.
const PLANNER = { structured: { ...PLANNER_OUTPUT, objective: 'Add a mul function to the calculator behind the existing permission check.' } };
// A roomy machine, so capacity is decided by the units and not by whatever else this host is running.
const ROOMY = { schedulerProbe: FIXED_PROBE };
const lab = () => t.lab({ tweak: (c) => void (c.ui = { ...defaultUi(), ui_paths: ['apps/**'], required_when_ui_changes: false, journey_check_ids: [] }) });
/** Each reviewer session as purpose, state and error, for a failure message that says why a unit ran twice. */
const sessions = (ws: readonly WorkerRecord[]): string => ws.map((w) => `${w.purpose} ${w.state}${w.error ? ` (${w.error})` : ''}`).join('; ');

describe.skipIf(!canStripTypes)('controller: parallel review units', () => {
  it('starts the security and the UI review together, records both, and succeeds once both approve', async () => {
    const l = lab();
    const slow = { ...APPROVE, sleepMs: 1_500 };
    writeScenario(l, baseScenario({ planner: [PLANNER], implementer: [implementMul('*')], reviewer: [slow, slow] }));
    const run = startLabRun(l);
    await drive(l, run.id, ROOMY);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const reviewers = listWorkers(l.db(), { runId: run.id, role: 'reviewer' });
    // One session per unit: nothing here fails, so a second session of a unit would be a defect (the rows say which).
    expect(reviewers.map((w) => w.purpose!.split(':')[0]).sort(), sessions(reviewers)).toEqual(['review-security', 'review-ui']);
    expect(events(l, run.id, 'worker.regenerate')).toEqual([]);
    // Together: each started before the other ended.
    const [a, b] = reviewers;
    expect(a!.spawnedAt!).toBeLessThan(b!.endedAt!);
    expect(b!.spawnedAt!).toBeLessThan(a!.endedAt!);
    const tree = listReviews(l.db(), run.id)[0]!.treeHash;
    expect(listReviews(l.db(), run.id).map((r) => [r.verdict, r.treeHash])).toEqual([
      ['APPROVE', tree],
      ['APPROVE', tree],
    ]);
    const prompts = reviewers.map((w) => readFileSync(join(w.workerDir, 'prompt.md'), 'utf8'));
    expect(prompts.some((p) => p.includes('Focus: security.'))).toBe(true);
    expect(prompts.some((p) => p.includes('Focus: the user interface.'))).toBe(true);
    // Two sessions on one revision: the second was admitted with the cost of re-reading the shared context.
    expect(events(l, run.id, 'scheduler.context-duplication')).toHaveLength(1);
    expect(l.db().get<{ used: number }>("SELECT used FROM budget_counters WHERE run_id = ? AND counter = 'review_rounds'", run.id)?.used).toBe(2);
  }, 90_000);

  it('a unit whose session fails gets one more session of its own, recorded with why; the other unit runs once', async () => {
    const l = lab();
    const slow = { ...APPROVE, sleepMs: 1_500 };
    // The security unit's first session exits 1 with no result, as the fake did when it read a torn scenario.
    writeScenario(l, baseScenario({ planner: [PLANNER], implementer: [implementMul('*')], 'reviewer@security': [{ outcome: 'no_result' }, slow], 'reviewer@ui': [slow] }));
    const run = startLabRun(l);
    await drive(l, run.id, ROOMY);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const reviewers = listWorkers(l.db(), { runId: run.id, role: 'reviewer' });
    const byPurpose = new Map(reviewers.map((w) => [w.purpose!.replace(/:cand-[^#]+/, ''), w]));
    expect([...byPurpose.keys()].sort(), sessions(reviewers)).toEqual(['review-security#1', 'review-security#2', 'review-ui#1']);
    // The record says why there are two: the first session failed, and the regeneration names its status and error.
    const failed = byPurpose.get('review-security#1')!;
    expect([failed.state, failed.resultStatus, failed.exitCode]).toEqual(['FAILED', 'failed', 1]);
    expect(failed.error).toMatch(/exited 1/);
    const regen = events(l, run.id, 'worker.regenerate').map((e) => JSON.parse(e.data_json!) as { what: string; status: string; attempts: number; error: string });
    expect(regen).toHaveLength(1);
    expect(regen[0]).toMatchObject({ status: 'failed', attempts: 1, error: failed.error });
    expect(regen[0]!.what).toMatch(/ security reviewer$/);
    // A failed session reviews nothing: the two reviews are the second security session's and the UI session's.
    const tree = listReviews(l.db(), run.id)[0]!.treeHash;
    expect(listReviews(l.db(), run.id).map((r) => [r.workerId, r.verdict, r.treeHash]).sort()).toEqual(
      [
        [byPurpose.get('review-security#2')!.id, 'APPROVE', tree],
        [byPurpose.get('review-ui#1')!.id, 'APPROVE', tree],
      ].sort(),
    );
    // Every session started costs a review round, the failed one included.
    expect(l.db().get<{ used: number }>("SELECT used FROM budget_counters WHERE run_id = ? AND counter = 'review_rounds'", run.id)?.used).toBe(3);
  }, 90_000);

  it('a new candidate cancels both running reviewers', async () => {
    const l = lab();
    const stuck = { ...APPROVE, sleepMs: 60_000 };
    writeScenario(l, baseScenario({ planner: [PLANNER], implementer: [implementMul('*')], reviewer: [stuck, stuck] }));
    const run = startLabRun(l);
    const deps = await stepTo(l, run.id, 'REVIEWING', 'controller-a', ROOMY);
    const r = await step(deps, run.id, new AbortController().signal);
    expect(r.waiting).toBeDefined();
    const running = await waitFor(() => {
      const ws = listWorkers(l.db(), { runId: run.id, role: 'reviewer' });
      return ws.length === 2 && ws.every((w) => w.state === 'RUNNING') ? ws : null;
    }, 20_000);
    for (const w of running) t.group(w.pgid);

    const ctx = loadRunContext(deps, run.id, new AbortController().signal);
    const stopped = await cancelObsoleteWork(ctx, 'f'.repeat(40));
    expect(stopped.sort()).toEqual(running.map((w) => w.id).sort());
    expect(listWorkers(l.db(), { runId: run.id, role: 'reviewer' }).map((w) => w.state)).toEqual(['CANCELLED', 'CANCELLED']);
    expect(events(l, run.id, 'workers.obsolete-cancelled')).toHaveLength(1);
    // Work on the current tree is left alone.
    expect(await cancelObsoleteWork(ctx, ctx.candidate!.treeHash)).toEqual([]);
  }, 90_000);
});
