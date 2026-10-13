// One spend explanation (0.3.0 retest): the report, the timeline footer and status said "cost_usd 3.65", "model cost
// $1.9985" and "measured $2.00 ... estimated $1.66; charged $3.65" without saying which figure the cost cap is checked
// against or what it adds to the reported spend. spendBreakdown says it once, for all three.
import { describe, expect, it } from 'vitest';
import { openDb, type OrbitDb } from '../../../src/storage/db.ts';
import { ManualClock } from '../../../src/core/clock.ts';
import { createRun } from '../../../src/controller/run-store.ts';
import { BudgetLedger, spendBreakdown, type BudgetPolicy } from '../../../src/scheduling/budget.ts';
import { recordUsage } from '../../../src/routing/usage.ts';
import { appendEvent } from '../../../src/storage/events.ts';
import { planWorker } from '../../../src/storage/workers.ts';
import type { UsageReport } from '../../../src/adapters/types.ts';

const POLICY: BudgetPolicy = {
  scheduler: {
    hard_limits: {
      implementation_attempts: 6,
      diagnostic_experiments: 8,
      review_rounds: 3,
      ci_repair_cycles: 3,
      worker_turns_per_session: 30,
      wall_minutes: 60,
      model_cost_usd: 30,
      parallel_workers: 4,
      changed_files: 40,
      changed_lines: 2000,
      infrastructure_retries: 3,
      recovery_attempts: 3,
    },
    initial_allowances: { simple_attempts: 2, medium_attempts: 4, complex_attempts: 5 },
    extension: { attempts_per_extension: 1, require_measurable_progress: true, require_new_hypothesis: true, preserve_final_verification_reserve: true },
    final_reserve_fraction: 0.2,
  },
};

function setup(): { db: OrbitDb; clock: ManualClock } {
  const db = openDb(':memory:');
  const clock = new ManualClock();
  createRun(db, { id: 'run-1', repoRoot: '/repo/acme', goal: 'g', mode: 'autonomous', policyHash: 'sha256:x', policyPath: '/p' }, clock);
  return { db, clock };
}

const usage = (over: Partial<UsageReport> = {}): UsageReport => ({ provider: 'claude', model: null, inputTokens: 10, outputTokens: 10, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null, costSource: 'unavailable', ...over });

function session(db: OrbitDb, clock: ManualClock, workerId: string, cost: number | null, provider = 'claude'): void {
  recordUsage(db, { runId: 'run-1', workerId, provider, model: null, usage: usage({ provider, costUsd: cost, costSource: cost === null ? 'unavailable' : 'reported' }), durationMs: 1, pricing: null }, clock);
}

describe('spendBreakdown: which figure the cap is checked against, and what it adds to the reported spend', () => {
  it('the demo ui run: the charge is the reported spend plus token estimates for the sessions that reported no cost', () => {
    const { db, clock } = setup();
    const ledger = new BudgetLedger(db, clock).init('run-1', { config: POLICY }, 'complex');
    for (const [id, cost] of [['wrk-plan', 0.2196], ['wrk-impl-1', 1.3292], ['wrk-impl-2', 0.2107], ['wrk-impl-3', 0.2], ['wrk-cur', 0.039]] as const) {
      ledger.consumeCost({ costUsd: cost, costSource: 'reported' }, 'implementer', { workerId: id });
      session(db, clock, id, cost);
    }
    for (const [id, est] of [['wrk-rev-1', 0.527], ['wrk-rev-2', 0.561], ['wrk-rev-3', 0.566]] as const) {
      ledger.consumeCost({ costUsd: null }, 'reviewer', { phase: 'final', workerId: id, tokenEstimate: { costUsd: est, basis: 'dearest listed pricing', model: 'gpt-6.1-sol' } });
      session(db, clock, id, null, 'codex');
    }
    const s = spendBreakdown(db, 'run-1');
    expect(s).toMatchObject({ charged_usd: 3.6525, reported_usd: 1.9985, reported_sessions: 5, estimated_usd: 1.654, estimated_sessions: 3, ceiling_usd: 0, ceiling_sessions: 0, unpriced_sessions: 0, unmatched_usd: 0, uncharged_usd: 0 });
    expect(s.explanation).toBe('$3.65 charged to the cost budget (the figure the cost cap is checked against): $2.00 reported by providers (5 sessions) + $1.65 estimated from tokens for 3 sessions that reported no cost');
  });

  it('before PLANNING creates the budget, the spend is reported as measured and not charged, with the reason', () => {
    const { db, clock } = setup();
    session(db, clock, 'wrk-plan', 0.0456);
    session(db, clock, 'wrk-cur', 0.011);
    const s = spendBreakdown(db, 'run-1');
    expect(s).toMatchObject({ charged_usd: null, reported_usd: 0.0566, uncharged_usd: 0.0566, uncharged_reason: 'PLANNING has not created the budget yet' });
    expect(s.explanation).toBe('nothing charged to the cost budget yet: PLANNING creates it and then charges what was spent before; spent so far: $0.06 reported by providers (2 sessions)');
    // The dotnet run blocked at PLANNING: the spend stays measured and uncharged, and the reason says why.
    db.run("UPDATE runs SET state = 'BLOCKED' WHERE id = 'run-1'");
    expect(spendBreakdown(db, 'run-1')).toMatchObject({
      uncharged_reason: 'the run blocked before PLANNING created the budget',
      explanation: 'nothing charged to the cost budget: the run blocked before PLANNING created the budget, so this spend is measured and not charged; PLANNING charges it if the run is resumed: $0.06 reported by providers (2 sessions)',
    });
  });

  it('says so when a session before the budget reported no cost, and when nothing was recorded at all', () => {
    const { db, clock } = setup();
    expect(spendBreakdown(db, 'run-1').explanation).toBe('no usage recorded yet');
    session(db, clock, 'wrk-plan', null);
    expect(spendBreakdown(db, 'run-1').explanation).toBe('nothing charged to the cost budget yet: PLANNING creates it and then charges what was spent before; spent so far: 1 session with no reported cost');
  });

  it('names the precharge, ceiling stand-ins, a charge with no usage record and spend the budget never charged', () => {
    const { db, clock } = setup();
    session(db, clock, 'wrk-plan', 0.05);
    const ledger = new BudgetLedger(db, clock).init('run-1', { config: POLICY }, 'medium');
    ledger.consumeCost({ costUsd: 0.05, costSource: 'reported' }, 'planner', { workerId: 'wrk-plan' });
    appendEvent(db, 'run-1', 'budget.precharged', 'test', { usage_rows: 1, charged_usd: 0.05 }, clock.now());
    // A session with neither cost nor tokens is charged at a ceiling; its usage row has no cost.
    ledger.consumeCost({ costUsd: null }, 'implementer', { workerId: 'wrk-impl', ceilingUsd: 2.5 });
    session(db, clock, 'wrk-impl', null);
    // The same reviewer charged twice (a crash between the charge and its usage record).
    ledger.consumeCost({ costUsd: 0.3, costSource: 'reported' }, 'reviewer', { workerId: 'wrk-rev' });
    ledger.consumeCost({ costUsd: 0.3, costSource: 'reported' }, 'reviewer', { workerId: 'wrk-rev' });
    session(db, clock, 'wrk-rev', 0.3);
    const twice = spendBreakdown(db, 'run-1');
    expect(twice).toMatchObject({ charged_usd: 3.15, reported_usd: 0.35, ceiling_usd: 2.5, ceiling_sessions: 1, precharged_usd: 0.05, unmatched_usd: 0.3, uncharged_usd: 0 });
    expect(twice.explanation).toBe(
      '$3.15 charged to the cost budget (the figure the cost cap is checked against): $0.35 reported by providers (2 sessions) + $2.50 at conservative ceilings for 1 session that reported no cost and could not be priced + $0.30 charged with no matching usage record; $0.05 of it was spent before PLANNING and charged when the budget was created',
    );
    // An inquisitor recorded by another component and never charged (0.3.0): the charge falls short of the spend.
    session(db, clock, 'wrk-inq', 0.5);
    const short = spendBreakdown(db, 'run-1');
    expect(short).toMatchObject({ charged_usd: 3.15, reported_usd: 0.85, unmatched_usd: 0, uncharged_usd: 0.2 });
    expect(short.explanation).toMatch(/; \$0\.20 of the recorded spend was never charged to the budget$/);
  });

  it('a charge recorded before charges named their session stands for one session with no cost, as the old note counted it', () => {
    const { db, clock } = setup();
    const ledger = new BudgetLedger(db, clock).init('run-1', { config: POLICY }, 'medium');
    ledger.consumeCost({ costUsd: 0.12, costSource: 'reported' }, 'implementer');
    session(db, clock, 'w-1', 0.12);
    appendEvent(db, 'run-1', 'budget.cost-ceiling-charged', 'budget', { role: 'implementer', ceiling_usd: 1 }, clock.now());
    db.run("UPDATE budget_counters SET used = used + 1 WHERE run_id = 'run-1' AND counter = 'cost_usd'");
    session(db, clock, 'w-2', null);
    session(db, clock, 'w-3', null);
    const s = spendBreakdown(db, 'run-1');
    expect(s).toMatchObject({ charged_usd: 1.12, ceiling_usd: 1, ceiling_sessions: 1, unpriced_sessions: 1 });
    expect(s.explanation).toBe('$1.12 charged to the cost budget (the figure the cost cap is checked against): $0.12 reported by providers (1 session) + $1.00 at conservative ceilings for 1 session that reported no cost and could not be priced; 1 session with no reported cost was never charged');
  });

  // Adversarial review of fix/031-budget: before 0.3.1 a session charged from its tokens left a charge event naming no
  // session, and recordUsage priced the same session's usage record from the registry. Only records without a cost were
  // matched to such a charge, so one $0.51 session read as $1.02 across two sessions, $0.51 of it "never charged".
  it('a charge recorded before charges named their session is matched to its session\'s priced usage record, once', () => {
    const { db, clock } = setup();
    const ledger = new BudgetLedger(db, clock).init('run-1', { config: POLICY }, 'medium');
    const worker = (id: string, role: 'implementer' | 'reviewer' | 'inquisitor'): void => {
      planWorker(db, { id, runId: 'run-1', role, provider: 'codex', workerDir: `/w/${id}`, cwd: '/repo' }, clock);
    };
    // 0.3.0 accountWorker: the charge first (no worker_id), then the usage record, which recordUsage priced itself.
    worker('w-rev', 'reviewer');
    ledger.consumeCost({ costUsd: null }, 'reviewer', { phase: 'final', tokenEstimate: { costUsd: 0.51, basis: 'model pricing', model: 'gpt-x' } });
    recordUsage(db, { runId: 'run-1', workerId: 'w-rev', provider: 'codex', model: 'gpt-x', usage: usage({ provider: 'codex', costUsd: 0.51, costSource: 'estimated' }), durationMs: 1 }, clock);
    const one = spendBreakdown(db, 'run-1');
    expect(one).toMatchObject({ charged_usd: 0.51, estimated_usd: 0.51, estimated_sessions: 1, reported_sessions: 0, unpriced_sessions: 0, unmatched_usd: 0, uncharged_usd: 0 });
    expect(one.explanation).toBe('$0.51 charged to the cost budget (the figure the cost cap is checked against): $0.51 estimated from tokens for 1 session that reported no cost');
    // More of the same run: a session priced only at the dearest rate (its record has no cost), one charged at a
    // ceiling, one reported, and an inquisitor 0.3.0 recorded and never charged, which is still said to be uncharged.
    worker('w-impl', 'implementer');
    ledger.consumeCost({ costUsd: null }, 'implementer', { tokenEstimate: { costUsd: 0.8, basis: 'dearest listed pricing', model: null } });
    recordUsage(db, { runId: 'run-1', workerId: 'w-impl', provider: 'codex', model: null, usage: usage({ provider: 'codex' }), durationMs: 1, pricing: null }, clock);
    worker('w-impl-2', 'implementer');
    ledger.consumeCost({ costUsd: null }, 'implementer', { ceilingUsd: 2 });
    recordUsage(db, { runId: 'run-1', workerId: 'w-impl-2', provider: 'codex', model: null, usage: usage({ provider: 'codex', inputTokens: null, outputTokens: null }), durationMs: 1, pricing: null }, clock);
    worker('w-rev-2', 'reviewer');
    ledger.consumeCost({ costUsd: 0.2, costSource: 'reported' }, 'reviewer', { phase: 'final' });
    recordUsage(db, { runId: 'run-1', workerId: 'w-rev-2', provider: 'codex', model: null, usage: usage({ provider: 'codex', costUsd: 0.2, costSource: 'reported' }), durationMs: 1 }, clock);
    worker('w-inq', 'inquisitor');
    recordUsage(db, { runId: 'run-1', workerId: 'w-inq', provider: 'codex', model: 'gpt-x', usage: usage({ provider: 'codex', costUsd: 0.05, costSource: 'estimated' }), durationMs: 1 }, clock);
    const all = spendBreakdown(db, 'run-1');
    expect(all).toMatchObject({ charged_usd: 3.51, reported_usd: 0.2, reported_sessions: 1, estimated_usd: 1.36, estimated_sessions: 3, ceiling_usd: 2, ceiling_sessions: 1, unpriced_sessions: 0, unmatched_usd: 0, uncharged_usd: 0.05 });
    expect(all.explanation).toMatch(/; \$0\.05 of the recorded spend was never charged to the budget$/);
  });

  it('a budget with nothing charged and no usage says so plainly', () => {
    const { db, clock } = setup();
    new BudgetLedger(db, clock).init('run-1', { config: POLICY }, 'medium');
    expect(spendBreakdown(db, 'run-1').explanation).toBe('$0.00 charged to the cost budget (the figure the cost cap is checked against); no usage recorded yet');
  });

  it('a usage record the registry priced counts as an estimate, unless the budget charged that session from its tokens', () => {
    const { db, clock } = setup();
    const ledger = new BudgetLedger(db, clock).init('run-1', { config: POLICY }, 'medium');
    recordUsage(db, { runId: 'run-1', workerId: 'w-a', provider: 'claude', model: null, usage: usage({ costUsd: 0.4, costSource: 'estimated' }), durationMs: 1 }, clock);
    ledger.consumeCost({ costUsd: 0.4, costSource: 'estimated' }, 'implementer', { workerId: 'w-a' });
    // A lost Claude session: charged from its tokens, and its usage row priced again from the registry.
    ledger.consumeCost({ costUsd: null }, 'implementer', { workerId: 'w-b', tokenEstimate: { costUsd: 0.7, basis: 'model pricing', model: 'm' } });
    recordUsage(db, { runId: 'run-1', workerId: 'w-b', provider: 'claude', model: null, usage: usage({ costUsd: 0.69, costSource: 'estimated' }), durationMs: 1 }, clock);
    const s = spendBreakdown(db, 'run-1');
    expect(s).toMatchObject({ charged_usd: 1.1, estimated_usd: 1.1, estimated_sessions: 2, reported_sessions: 0, unmatched_usd: 0, uncharged_usd: 0 });
    expect(s.explanation).toBe('$1.10 charged to the cost budget (the figure the cost cap is checked against): $1.10 estimated from tokens for 2 sessions that reported no cost');
  });
});
