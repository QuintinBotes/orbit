/**
 * Issue #168 in the controller: routeFor reads the measured outcomes of the task class inside the learning window (or
 * none when learning is switched off), and settleRouteOutcome writes one row per settled attempt.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { routeFor } from '../../../src/controller/workers.ts';
import { implementRouteDecisionId, settleRouteOutcome } from '../../../src/controller/route-outcome.ts';
import { createRun, getRun } from '../../../src/controller/run-store.ts';
import { buildRunStatus, renderRunStatus } from '../../../src/cli/commands/status.ts';
import { recordRouteOutcome, recordUsage } from '../../../src/routing/usage.ts';
import type { RouteDecision } from '../../../src/routing/types.ts';
import { getDecision } from '../../../src/storage/decisions.ts';
import { planWorker } from '../../../src/storage/workers.ts';
import { addCandidate, makeUnitLab, OWNER, type UnitLab, type UnitLabOptions } from './coverage-helpers.ts';

let lab: UnitLab;
afterEach(() => lab?.cleanup());

const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-5-5';
const DAY = 86_400_000;
const signals = { difficulty: 'medium' as const, attempt: 1, repeatedFingerprints: 0 };

function start(tweak?: UnitLabOptions['tweak']): void {
  lab = makeUnitLab({ path: ['PREFLIGHT'], ...(tweak ? { tweak } : {}) });
  lab.deps.registry.seed();
  for (const e of lab.deps.registry.list()) if (e.provider === 'claude' && e.family !== 'fable') lab.deps.registry.markAvailability(e.modelId, 'claude-cli', true, 'test');
}

/** Outcomes of earlier runs of this repository, as their own controllers recorded them. */
function seed(n: number, outcome: 'verified' | 'failed', over: { model?: string; difficulty?: string; run?: string } = {}): void {
  const run = over.run ?? 'orb-earlier';
  if (!lab.db.get('SELECT 1 AS x FROM runs WHERE id = ?', run)) createRun(lab.db, { id: run, repoRoot: lab.repo, goal: 'earlier', mode: 'autonomous', policyHash: 'sha256:x', policyPath: '/p' }, lab.clock);
  for (let i = 0; i < n; i++) {
    recordRouteOutcome(lab.db, { runId: run, workKind: 'routine-code', provider: 'claude', modelId: over.model ?? HAIKU, outcome, costUsd: 0.05, tokens: 1000, role: 'implementer', effort: 'medium', difficulty: over.difficulty ?? 'medium' }, lab.clock);
  }
}

const decisionOf = (purpose: string): RouteDecision & { learning_disabled?: string } => getDecision(lab.db, `dec-route-${lab.runId}-${purpose.replace(/[^A-Za-z0-9_-]/g, '_')}`)!.data as RouteDecision & { learning_disabled?: string };

describe('routeFor reads measured outcomes', () => {
  it('routes the class to the cheaper tier once twenty outcomes show it passing, and records why', () => {
    start();
    expect(routeFor(lab.ctx(), 'plan', 'routine-code', signals).model).toBe(SONNET);
    seed(20, 'verified');
    const choice = routeFor(lab.ctx(), 'implement:1', 'routine-code', signals);
    expect(choice.model).toBe(HAIKU);
    const d = decisionOf('implement:1');
    expect(d.learning).toMatchObject({ applied: true, table_choice: { model: SONNET }, task_class: { work_kind: 'routine-code', difficulty: 'medium' } });
    expect(d.learning!.reason).toMatch(/measured pass rate 100% over 20 outcomes of routine-code \(medium\) in the last 90 days/);
    expect(d.learning!.measured[0]).toMatchObject({ model: HAIKU, judged: 20, verified: 20, runs: 1 });
    expect(d.learning!.measured[0]!.last_ts).toBe(lab.clock.now());
  });

  it('restores the table default when the measured pass rate falls below the threshold', () => {
    start();
    seed(20, 'verified');
    seed(6, 'failed');
    expect(routeFor(lab.ctx(), 'implement:1', 'routine-code', signals).model).toBe(SONNET);
    expect(decisionOf('implement:1').learning).toMatchObject({ applied: false });
    expect(decisionOf('implement:1').reason).toMatch(/table default kept: measured pass rate 77% over 26 outcomes is below 80%/);
  });

  it('ignores outcomes older than the configured window', () => {
    start((c) => void (c.routing.learning = { ...c.routing.learning, window_days: 30 }));
    seed(20, 'verified');
    lab.clock.advance(29 * DAY);
    expect(routeFor(lab.ctx(), 'implement:1', 'routine-code', signals).model).toBe(HAIKU);
    lab.clock.advance(2 * DAY);
    expect(routeFor(lab.ctx(), 'implement:2', 'routine-code', signals).model).toBe(SONNET);
    expect(decisionOf('implement:2').learning).toBeUndefined();
  });

  it('a route recovers: failures that left the window no longer hold the cheaper tier back', () => {
    start();
    seed(20, 'failed');
    lab.clock.advance(91 * DAY);
    seed(20, 'verified');
    expect(routeFor(lab.ctx(), 'implement:1', 'routine-code', signals).model).toBe(HAIKU);
  });

  it('reads only the outcomes of the same difficulty class', () => {
    start();
    seed(20, 'verified', { difficulty: 'simple' });
    expect(routeFor(lab.ctx(), 'implement:1', 'routine-code', signals).model).toBe(SONNET);
    expect(routeFor(lab.ctx(), 'implement:2', 'routine-code', { ...signals, difficulty: 'simple' }).model).toBe(HAIKU);
  });

  it('routing.learning.enabled false switches it off: the table decides and the decision says outcomes were not read', () => {
    start((c) => void (c.routing.learning = { ...c.routing.learning, enabled: false }));
    seed(40, 'verified');
    expect(routeFor(lab.ctx(), 'implement:1', 'routine-code', signals).model).toBe(SONNET);
    const d = decisionOf('implement:1');
    expect(d.learning).toBeUndefined();
    expect(d.cost_basis).toBe('prior');
    expect(d.learning_disabled).toBe('routing.learning.enabled is false: measured outcomes were not read');
  });

  it('never widens the policy: a proven model outside routing.allowed_models is not chosen', () => {
    start((c) => void (c.routing.allowed_models = ['sonnet', 'opus']));
    seed(40, 'verified');
    expect(routeFor(lab.ctx(), 'implement:1', 'routine-code', signals).model).toBe(SONNET);
  });

  it('an explicit routing.overrides entry wins over measured outcomes', () => {
    start((c) => void (c.routing.overrides = { 'routine-code': 'sonnet' }));
    seed(40, 'verified');
    expect(routeFor(lab.ctx(), 'implement:1', 'routine-code', signals).model).toBe(SONNET);
    expect(decisionOf('implement:1').learning).toMatchObject({ applied: false, reason: 'routing.overrides.routine-code is an explicit choice, so measured outcomes do not displace it' });
  });
});

describe('orbit status explains a learned route', () => {
  const status = () => buildRunStatus({ clock: lab.clock }, lab.db, getRun(lab.db, lab.runId));

  it('says nothing about routing when no measured outcome was read', () => {
    start();
    routeFor(lab.ctx(), 'implement:1', 'routine-code', signals);
    expect(status().routing).toBeUndefined();
    expect(renderRunStatus(status(), lab.clock.now())).not.toMatch(/^routing:/m);
  });

  it('names the model the outcomes moved the work to, the table\'s choice it displaced, the reason and the switch', () => {
    start();
    seed(20, 'verified');
    routeFor(lab.ctx(), 'implement:1', 'routine-code', signals);
    expect(status().routing).toMatchObject({ purpose: 'implement:1', provider: 'claude', model: HAIKU, displaced_table: true, table_model: SONNET });
    const text = renderRunStatus(status(), lab.clock.now());
    expect(text).toMatch(new RegExp(`^routing:   implement:1 -> claude/${HAIKU} instead of ${SONNET} from the routing table: measured pass rate 100% over 20 outcomes of routine-code \\(medium\\) in the last 90 days`, 'm'));
    expect(text).toContain('measured outcomes per route: orbit stats; switch off with routing.learning.enabled: false');
  });

  it('says when the table\'s choice was kept because the measured pass rate fell below the threshold, for the newest attempt', () => {
    start();
    seed(20, 'verified');
    routeFor(lab.ctx(), 'implement:1', 'routine-code', signals);
    lab.clock.advance(1000);
    seed(6, 'failed');
    routeFor(lab.ctx(), 'implement:2', 'routine-code', { ...signals, attempt: 2 });
    expect(status().routing).toMatchObject({ purpose: 'implement:2', model: SONNET, displaced_table: false });
    expect(renderRunStatus(status(), lab.clock.now())).toMatch(new RegExp(`^routing:   implement:2 -> claude/${SONNET} \\(the routing table's choice\\): measured pass rate 77% over 26 outcomes is below 80%`, 'm'));
  });
});

describe('settleRouteOutcome', () => {
  function attempt(n: number, usage: ({ cost: number | null } | null)[]): ReturnType<typeof addCandidate> {
    const route = routeFor(lab.ctx(), `implement:${n}`, 'routine-code', { ...signals, attempt: n });
    usage.forEach((u, i) => {
      const w = planWorker(lab.db, { id: `wrk-${n}-${i}`, runId: lab.runId, role: 'implementer', purpose: `implement:${n}#${i + 1}`, provider: route.provider, model: route.model, effort: route.effort, attempt: n, workerDir: join(lab.base, 'w', `${n}-${i}`), cwd: lab.repo }, lab.clock, OWNER);
      if (u) {
        recordUsage(lab.db, { runId: lab.runId, workerId: w.id, usage: { provider: 'claude', model: route.model, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: u.cost, costSource: u.cost === null ? 'unavailable' : 'reported' }, durationMs: 10, pricing: null }, lab.clock);
      }
    });
    return addCandidate(lab, { attempt: n, tree: String(n).repeat(40) });
  }
  const rows = () => lab.db.all<Record<string, unknown>>('SELECT work_kind, provider, model_id, outcome, cost_usd, tokens, role, effort, difficulty, attempt_key, evidence_ref FROM route_outcomes WHERE run_id = ? ORDER BY id', lab.runId);

  it('records role, provider, model, effort, task class, result and cost, once per attempt', () => {
    start();
    lab.db.run("UPDATE runs SET difficulty = 'medium' WHERE id = ?", lab.runId);
    const c1 = attempt(1, [{ cost: 0.25 }, { cost: 0.5 }]);
    const id = settleRouteOutcome(lab.ctx(), c1, { outcome: 'failed', evidenceRef: 'ev-1' });
    expect(id).not.toBeNull();
    // The step is retried after a crash, and later the same candidate is judged again: still one row, the first.
    expect(settleRouteOutcome(lab.ctx(), c1, { outcome: 'failed', evidenceRef: 'ev-1' })).toBe(id);
    expect(settleRouteOutcome(lab.ctx(), c1, { outcome: 'verified', evidenceRef: 'review-gate:x' })).toBe(id);
    const c2 = attempt(2, [{ cost: 0.1 }]);
    settleRouteOutcome(lab.ctx(), c2, { outcome: 'verified', evidenceRef: `review-gate:${c2.treeHash}` });
    expect(rows()).toEqual([
      { work_kind: 'routine-code', provider: 'claude', model_id: SONNET, outcome: 'failed', cost_usd: 0.75, tokens: 2400, role: 'implementer', effort: 'medium', difficulty: 'medium', attempt_key: c1.id, evidence_ref: 'ev-1' },
      { work_kind: 'routine-code', provider: 'claude', model_id: SONNET, outcome: 'verified', cost_usd: 0.1, tokens: 1200, role: 'implementer', effort: 'medium', difficulty: 'medium', attempt_key: c2.id, evidence_ref: `review-gate:${c2.treeHash}` },
    ]);
  });

  it('an attempt whose cost is not fully known is recorded with no cost, never with zero or a partial sum', () => {
    start();
    const c1 = attempt(1, [{ cost: 0.25 }, { cost: null }]);
    settleRouteOutcome(lab.ctx(), c1, { outcome: 'verified', evidenceRef: 'g' });
    const c2 = attempt(2, [{ cost: 0.25 }, null]);
    settleRouteOutcome(lab.ctx(), c2, { outcome: 'verified', evidenceRef: 'g' });
    const c3 = attempt(3, []);
    settleRouteOutcome(lab.ctx(), c3, { outcome: 'verified', evidenceRef: 'g' });
    expect(rows().map((r) => [r.cost_usd, r.tokens])).toEqual([[null, 2400], [null, null], [null, null]]);
  });

  it('records nothing for an environment result, or for an attempt without a route decision', () => {
    start();
    const c1 = attempt(1, [{ cost: 0.25 }]);
    expect(settleRouteOutcome(lab.ctx(), c1, { outcome: 'failed', evidenceRef: 'ev-1', environment: true })).toBeNull();
    const orphan = addCandidate(lab, { attempt: 7, tree: '7'.repeat(40) });
    expect(getDecision(lab.db, implementRouteDecisionId(lab.runId, 7))).toBeNull();
    expect(settleRouteOutcome(lab.ctx(), orphan, { outcome: 'failed', evidenceRef: 'ev-7' })).toBeNull();
    expect(rows()).toEqual([]);
  });
});
