import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../../../src/core/clock.ts';
import { nullLogger } from '../../../src/core/log.ts';
import { openDb, type OrbitDb } from '../../../src/storage/db.ts';
import { createRun } from '../../../src/controller/run-store.ts';
import type { RunContext } from '../../../src/controller/context.ts';
import { checkLiveOverlays } from '../../../src/controller/knowledge-hooks.ts';
import { liveWindow, measureRun } from '../../../src/controller/eval-runner.ts';
import { KnowledgeStore } from '../../../src/knowledge/store.ts';
import { completeEvaluation, createCandidateOverlay, distillOverlay, startEvaluation } from '../../../src/knowledge/overlays.ts';
import type { EvalMetrics, PromptOverlay } from '../../../src/knowledge/types.ts';
import { ev, makeLesson } from '../../unit/knowledge/helpers.ts';

const clock = new ManualClock(Date.parse('2026-10-03T08:00:00.000Z'));
const opened: { db: OrbitDb; store: KnowledgeStore }[] = [];
afterEach(() => {
  for (const o of opened.splice(0)) {
    o.db.close();
    o.store.close();
  }
});

function setup() {
  const db = openDb(':memory:');
  const store = KnowledgeStore.open(':memory:', { clock });
  opened.push({ db, store });
  const lesson = store.upsertLesson(makeLesson({ status: 'validated', evidence: [ev('r1'), ev('r2')], applicability: { roles: ['implementer'] } })).lesson;
  const draft = () => distillOverlay('implementer', [{ lesson, stats: store.stats(lesson.id) }]);
  return { db, store, draft };
}

const metrics = (pass: number, attempts = 1, cost: number | null = 0.1, falsePass = 0): EvalMetrics => ({ verified_pass_rate: pass, mean_attempts: attempts, mean_cost_usd: cost, false_pass_rate: falsePass });

/** Adopt a candidate on replay evidence, as `orbit learn eval` or a finished run would. */
function adopt(store: KnowledgeStore, overlay: PromptOverlay, baseline: EvalMetrics, candidate: EvalMetrics): PromptOverlay {
  startEvaluation(store, overlay.id);
  const prior = store.activeOverlay(overlay.role, overlay.scope);
  const out = completeEvaluation(store, overlay.id, { cases: 4, suite_id: 'suite-test', baseline, candidate, baseline_overlay_id: prior?.id ?? null });
  expect(out.decision.adopt, out.decision.reason).toBe(true);
  return out.overlay;
}

/** Settled runs created now (after the overlay's activation), in the given state. */
function liveRuns(db: OrbitDb, states: string[]): string[] {
  const ids: string[] = [];
  for (const [i, state] of states.entries()) {
    const id = `live-${clock.now()}-${i}`;
    createRun(db, { id, repoRoot: '/repo', goal: 'g', mode: 'autonomous', policyHash: 'sha256:x', policyPath: '/p' }, clock);
    db.run('UPDATE runs SET state = ? WHERE id = ?', state, id);
    ids.push(id);
    clock.advance(10);
  }
  return ids;
}

function ctxFor(db: OrbitDb, runId: string): RunContext {
  return { db, ownerId: 'test-controller', clock, run: { id: runId }, log: nullLogger } as unknown as RunContext;
}

describe('live regression check of an adopted overlay', () => {
  it('rolls an adopted overlay back when the runs settled since its activation regress, restoring the one it replaced', () => {
    const { db, store, draft } = setup();
    const v1 = adopt(store, createCandidateOverlay(store, draft(), 'repo'), metrics(0.5, 2), metrics(0.9));
    clock.advance(1_000);
    // v2 was adopted against v1's replay metrics: 90% verified.
    const v2 = adopt(store, createCandidateOverlay(store, draft(), 'repo'), metrics(0.9), metrics(1));
    expect(store.activeOverlay('implementer', 'repo')?.id).toBe(v2.id);
    clock.advance(1_000);

    // Live, six tasks later: none of them verified.
    const ids = liveRuns(db, ['EXHAUSTED', 'EXHAUSTED', 'IMPOSSIBLE', 'EXHAUSTED', 'EXHAUSTED', 'EXHAUSTED']);
    const checks = checkLiveOverlays(ctxFor(db, ids[0]!), store);

    expect(checks).toEqual([expect.objectContaining({ overlay_id: v2.id, tasks: 6, rollback: true, restored: v1.id })]);
    expect(store.getOverlay(v2.id)?.status).toBe('rolled_back');
    expect(store.activeOverlay('implementer', 'repo')?.id).toBe(v1.id);
    expect(store.getOverlay(v1.id)?.status).toBe('active');
    expect(db.get("SELECT 1 AS x FROM events WHERE type = 'learning.overlay-rolled-back'")).toBeTruthy();
  });

  it('decides nothing on too few settled tasks, and ignores runs that settle nothing (blocked, cancelled) or predate the overlay', () => {
    const { db, store, draft } = setup();
    const [early] = liveRuns(db, ['EXHAUSTED']);
    clock.advance(1_000);
    const v1 = adopt(store, createCandidateOverlay(store, draft(), 'repo'), metrics(0.9), metrics(1));
    clock.advance(1_000);
    const ids = liveRuns(db, ['EXHAUSTED', 'EXHAUSTED', 'EXHAUSTED', 'EXHAUSTED', 'BLOCKED', 'CANCELLED']);
    expect(liveWindow(db, Date.parse(v1.activated_at!))?.tasks).toBe(4);
    expect(checkLiveOverlays(ctxFor(db, early!), store)).toEqual([expect.objectContaining({ overlay_id: v1.id, tasks: 4, rollback: false, reason: expect.stringMatching(/only 4 settled task/) })]);
    expect(store.activeOverlay('implementer', 'repo')?.id).toBe(v1.id);
    expect(ids).toHaveLength(6);
  });

  it('does nothing for an overlay that was never adopted on evidence, or before any task has settled', () => {
    const { db, store, draft } = setup();
    const candidate = createCandidateOverlay(store, draft(), 'repo');
    const [run] = liveRuns(db, ['EXHAUSTED']);
    expect(checkLiveOverlays(ctxFor(db, run!), store)).toEqual([]);
    expect(store.getOverlay(candidate.id)?.status).toBe('candidate');
  });
});

describe('measuring a run', () => {
  it('reports attempts, cost and an unverified state for a run that never produced evidence', () => {
    const { db } = setup();
    const [id] = liveRuns(db, ['EXHAUSTED']);
    expect(measureRun(db, id!)).toMatchObject({ state: 'EXHAUSTED', verified: false, attempts: 0, falsePass: false });
  });
});
