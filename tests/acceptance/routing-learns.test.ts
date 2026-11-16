/**
 * Issue #168: routing learns from measured outcomes. The real controller drives examples/demo-app with the fake
 * providers; the outcomes of earlier runs are seeded as their controllers would have recorded them.
 *
 * SC-001: after a run, route_outcomes holds one row per settled attempt.
 * SC-002: a measured cheaper tier displaces the routing table, and the table's choice comes back when its measured
 * pass rate falls below the threshold.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { systemClock } from '../../src/core/clock.ts';
import { createRun } from '../../src/controller/run-store.ts';
import { listEvidenceReports } from '../../src/evidence/store.ts';
import { recordRouteOutcome } from '../../src/routing/usage.ts';
import type { RouteDecision } from '../../src/routing/types.ts';
import { listDecisions } from '../../src/storage/decisions.ts';
import { listWorkers } from '../../src/storage/workers.ts';
import { drive, makeLab, orbitOnce, READY, startLabRun, writeScenario, type Lab } from './helpers/lab.ts';
import { APPROVE, GOAL, GOOD_IMPLEMENTATION, implementer, REGRESSION_DIAGNOSIS, scenario, SRC_FIX_REGRESSION, SRC_REGRESSION, TEST_TEXT } from './helpers/scenarios.ts';
import { assertRunInvariants } from './helpers/invariants.ts';

const labs: Lab[] = [];
afterEach(() => labs.splice(0).forEach((l) => l.close()));
function lab(opts: Parameters<typeof makeLab>[0] = {}): Lab {
  const l = makeLab(opts);
  labs.push(l);
  return l;
}

const HAIKU = 'claude-haiku-4-5-20251001';

interface OutcomeRow {
  work_kind: string;
  provider: string;
  model_id: string;
  outcome: string;
  cost_usd: number | null;
  role: string;
  effort: string | null;
  difficulty: string | null;
  attempt_key: string;
  evidence_ref: string;
}
const outcomesOf = (l: Lab, runId: string): OutcomeRow[] =>
  l.db().all<OutcomeRow>('SELECT work_kind, provider, model_id, outcome, cost_usd, role, effort, difficulty, attempt_key, evidence_ref FROM route_outcomes WHERE run_id = ? ORDER BY id', runId);
const implementRoute = (l: Lab, runId: string, attempt = 1): RouteDecision =>
  listDecisions(l.db(), runId, { kind: 'route' }).map((d) => d.data as RouteDecision & { purpose: string }).find((d) => d.purpose === `implement:${attempt}`)!;

/** Outcomes of earlier runs in this repository, of the demo goal's task class (routine-code, simple). */
function seed(l: Lab, n: number, outcome: 'verified' | 'failed'): void {
  const db = l.db();
  if (!db.get('SELECT 1 AS x FROM runs WHERE id = ?', 'orb-earlier')) createRun(db, { id: 'orb-earlier', repoRoot: l.repo, goal: 'earlier work', mode: 'autonomous', policyHash: 'sha256:x', policyPath: '/p' }, systemClock);
  for (let i = 0; i < n; i++) {
    recordRouteOutcome(db, { runId: 'orb-earlier', workKind: 'routine-code', provider: 'claude', modelId: HAIKU, outcome, costUsd: 0.02, tokens: 4000, role: 'implementer', effort: 'medium', difficulty: 'simple' }, systemClock);
  }
}

describe.skipIf(!READY)('acceptance: routing learns from measured outcomes (issue #168)', () => {
  it('SC-001: a run records one route outcome per settled attempt, with role, provider, model, effort, task class, result and cost', async () => {
    const l = lab();
    writeScenario(
      l,
      scenario({
        implementer: [implementer([SRC_REGRESSION, TEST_TEXT]), implementer([SRC_FIX_REGRESSION], { summary: 'Restored status 404; kept the new text.', changed: [['src/server.ts', 'modify']] })],
        verifier: [REGRESSION_DIAGNOSIS],
        reviewer: [APPROVE],
      }),
    );
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');

    const db = l.db();
    const reports = listEvidenceReports(db, run.id);
    expect(reports.map((r) => r.verdict)).toEqual(['FAIL', 'PASS']);
    const rows = outcomesOf(l, run.id);
    // Attempt 1 failed a trusted check; attempt 2 passed verification and review cleared its tree.
    expect(rows.map((r) => r.outcome)).toEqual(['failed', 'verified']);
    // One outcome per implementation attempt, keyed by the attempt (not by the candidate its tree became).
    expect(rows.map((r) => r.attempt_key)).toEqual(['attempt:1', 'attempt:2']);
    expect(rows[0]!.evidence_ref).toBe(reports[0]!.id);
    expect(rows[1]!.evidence_ref).toBe(`review-gate:${reports[1]!.treeHash}`);
    const workers = listWorkers(db, { runId: run.id, role: 'implementer' });
    rows.forEach((r, i) => {
      const route = implementRoute(l, run.id, i + 1);
      expect(r).toMatchObject({ work_kind: 'routine-code', role: 'implementer', provider: route.provider, model_id: route.model, effort: route.effort, difficulty: done.difficulty });
      expect(workers.find((w) => w.attempt === i + 1)?.model).toBe(r.model_id);
      // The fake provider reports a cost for every session, so the attempt's cost is known and is what its sessions cost.
      const spent = db.get<{ cost: number }>("SELECT SUM(u.cost_usd) AS cost FROM usage u JOIN workers w ON w.id = u.worker_id WHERE w.run_id = ? AND w.role = 'implementer' AND w.attempt = ?", run.id, i + 1)!.cost;
      expect(spent).toBeGreaterThan(0);
      expect(r.cost_usd).toBeCloseTo(spent, 6);
    });

    // FR-004: orbit stats shows the pass rate and the cost per accepted task of the route.
    const stats = JSON.parse((await orbitOnce(l, ['stats', '--json'])).out) as { routes: { model: string; verified: number; failed: number; pass_rate: { rate: number }; cost_per_accepted_usd: number }[] };
    const mine = stats.routes.filter((r) => rows.some((o) => o.model_id === r.model));
    expect(mine.reduce((a, r) => a + r.verified + r.failed, 0)).toBe(2);
    if (rows[0]!.model_id === rows[1]!.model_id) {
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ verified: 1, failed: 1, pass_rate: { rate: 0.5 } });
      expect(mine[0]!.cost_per_accepted_usd).toBeCloseTo(rows[0]!.cost_usd! + rows[1]!.cost_usd!, 5);
    }
    assertRunInvariants(l, run.id);
  }, 240_000);

  it('SC-002: twenty measured passes route the class to the cheaper tier with the measured rate as justification, and a pass rate below the threshold restores the table default', async () => {
    const l = lab({ tweak: (c) => void (c.routing.allowed_models = ['opus', 'sonnet', 'haiku']) });

    // Scenario 1. Given twenty recorded outcomes where the cheaper tier passed for this task class...
    seed(l, 20, 'verified');
    writeScenario(l, scenario({ implementer: [GOOD_IMPLEMENTATION()] }));
    const first = startLabRun(l, GOAL);
    const done = await drive(l, first.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(done.difficulty).toBe('simple');
    // ...the cheaper tier is chosen, and the recorded justification cites the measured rate.
    const learned = implementRoute(l, first.id);
    expect(learned.model).toBe(HAIKU);
    expect(learned.learning).toMatchObject({ applied: true, task_class: { work_kind: 'routine-code', difficulty: 'simple' }, min_samples: 20, min_pass_rate: 0.8 });
    expect(learned.learning!.table_choice.family).toBe('sonnet');
    expect(learned.learning!.reason).toMatch(/measured pass rate 100% over 20 outcomes of routine-code \(simple\) in the last 90 days/);
    expect(learned.reason).toMatch(/calibrated by measured outcomes: measured pass rate 100% over 20 outcomes/);
    // The implementer really ran on it, and its own verified attempt is the twenty-first outcome of the route.
    expect(listWorkers(l.db(), { runId: first.id, role: 'implementer' }).map((w) => w.model)).toEqual([HAIKU]);
    expect(outcomesOf(l, first.id)).toEqual([expect.objectContaining({ model_id: HAIKU, outcome: 'verified', difficulty: 'simple' })]);
    assertRunInvariants(l, first.id);

    // Scenario 2. Given the cheaper tier's measured pass rate falls below the threshold (21 of 28 is 75%)...
    seed(l, 7, 'failed');
    writeScenario(l, scenario({ implementer: [GOOD_IMPLEMENTATION()] }));
    const second = startLabRun(l, `${GOAL} Keep the wording exact.`);
    const again = await drive(l, second.id);
    expect(again.state, again.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(again.difficulty).toBe('simple');
    // ...the table default is restored, and the decision says why.
    const restored = implementRoute(l, second.id);
    expect(restored.family).toBe('sonnet');
    expect(restored.model).toBe(learned.learning!.table_choice.model);
    expect(restored.learning).toMatchObject({ applied: false });
    expect(restored.learning!.reason).toMatch(/measured pass rate 75% over 28 outcomes is below 80%/);
    expect(restored.reason).toMatch(/table default kept: measured pass rate 75% over 28 outcomes is below 80%/);
    expect(listWorkers(l.db(), { runId: second.id, role: 'implementer' }).map((w) => w.model)).toEqual([restored.model]);
    assertRunInvariants(l, second.id);
  }, 360_000);
});
