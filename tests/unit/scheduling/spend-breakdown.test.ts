// One spend explanation (0.3.0 retest): the report, the timeline footer and status said "cost_usd 3.65", "model cost
// $1.9985" and "measured $2.00 ... estimated $1.66; charged $3.65" without saying which figure the cost cap is checked
// against or what it adds to the reported spend. spendBreakdown says it once, for all three. In a run started on 0.3.1
// each usage record counts as the charge its mark names; a run started before is given as recorded.
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

function session(db: OrbitDb, clock: ManualClock, workerId: string, cost: number | null, provider = 'claude'): number {
  return recordUsage(db, { runId: 'run-1', workerId, provider, model: null, usage: usage({ provider, costUsd: cost, costSource: cost === null ? 'unavailable' : 'reported' }), durationMs: 1, pricing: null }, clock).id;
}

/** The mark a 0.3.1 controller writes with each charge: the usage record it covers, the amount and its basis. */
function mark(db: OrbitDb, clock: ManualClock, usageId: number, chargedUsd: number, basis: 'reported' | 'estimated' | 'ceiling', source = 'collected'): void {
  appendEvent(db, 'run-1', 'budget.usage-charged', 'controller', { usage_ids: [usageId], charged_usd: chargedUsd, basis, source }, clock.now());
}

/** The run as 0.3.0 created it: its run.created event names no accounting. */
function startedOn030(db: OrbitDb): void {
  db.run("UPDATE events SET data_json = json_remove(data_json, '$.accounting') WHERE run_id = 'run-1' AND type = 'run.created'");
}

describe('spendBreakdown: which figure the cap is checked against, and what it adds to the reported spend', () => {
  it('the demo ui run: the charge is the reported spend plus token estimates for the sessions that reported no cost', () => {
    const { db, clock } = setup();
    const ledger = new BudgetLedger(db, clock).init('run-1', { config: POLICY }, 'complex');
    for (const [id, cost] of [['wrk-plan', 0.2196], ['wrk-impl-1', 1.3292], ['wrk-impl-2', 0.2107], ['wrk-impl-3', 0.2], ['wrk-cur', 0.039]] as const) {
      ledger.consumeCost({ costUsd: cost, costSource: 'reported' }, 'implementer', { workerId: id });
      mark(db, clock, session(db, clock, id, cost), cost, 'reported');
    }
    for (const [id, est] of [['wrk-rev-1', 0.527], ['wrk-rev-2', 0.561], ['wrk-rev-3', 0.566]] as const) {
      ledger.consumeCost({ costUsd: null }, 'reviewer', { phase: 'final', workerId: id, tokenEstimate: { costUsd: est, basis: 'dearest listed pricing', model: 'gpt-6.1-sol' } });
      mark(db, clock, session(db, clock, id, null, 'codex'), est, 'estimated');
    }
    const s = spendBreakdown(db, 'run-1');
    expect(s).toMatchObject({ accounting: 'current', charged_usd: 3.6525, reported_usd: 1.9985, reported_sessions: 5, estimated_usd: 1.654, estimated_sessions: 3, ceiling_usd: 0, ceiling_sessions: 0, unpriced_sessions: 0, unmatched_usd: 0, uncharged_usd: 0 });
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
    expect(spendBreakdown(db, 'run-1').explanation).toBe('nothing charged to the cost budget yet: PLANNING creates it and then charges what was spent before; spent so far: 1 session with no reported cost (session wrk-plan)');
  });

  it('names the precharge, ceiling stand-ins, a charge with no usage record and spend the budget never charged', () => {
    const { db, clock } = setup();
    const plan = session(db, clock, 'wrk-plan', 0.05);
    const ledger = new BudgetLedger(db, clock).init('run-1', { config: POLICY }, 'medium');
    ledger.consumeCost({ costUsd: 0.05, costSource: 'reported' }, 'planner', { workerId: 'wrk-plan' });
    mark(db, clock, plan, 0.05, 'reported', 'precharge');
    appendEvent(db, 'run-1', 'budget.precharged', 'test', { usage_rows: 1, charged_usd: 0.05, usage_marked: true }, clock.now());
    // A session with neither cost nor tokens is charged at a ceiling; its usage row has no cost, its mark says what was charged.
    planWorker(db, { id: 'wrk-impl', runId: 'run-1', role: 'implementer', provider: 'claude', workerDir: '/w/wrk-impl', cwd: '/repo' }, clock);
    ledger.consumeCost({ costUsd: null }, 'implementer', { workerId: 'wrk-impl', ceilingUsd: 2.5 });
    mark(db, clock, session(db, clock, 'wrk-impl', null), 2.5, 'ceiling');
    // A reviewer charged once with its mark, and once more with none: a charge no mark names.
    ledger.consumeCost({ costUsd: 0.3, costSource: 'reported' }, 'reviewer', { workerId: 'wrk-rev' });
    ledger.consumeCost({ costUsd: 0.3, costSource: 'reported' }, 'reviewer', { workerId: 'wrk-rev' });
    mark(db, clock, session(db, clock, 'wrk-rev', 0.3), 0.3, 'reported');
    const twice = spendBreakdown(db, 'run-1');
    expect(twice).toMatchObject({ charged_usd: 3.15, reported_usd: 0.35, ceiling_usd: 2.5, ceiling_sessions: 1, precharged_usd: 0.05, unmatched_usd: 0.3, uncharged_usd: 0 });
    expect(twice.unmeasured_sessions).toEqual([{ usage_id: 2, worker_id: 'wrk-impl', role: 'implementer', charged_usd: 2.5 }]);
    expect(twice.explanation).toBe(
      '$3.15 charged to the cost budget (the figure the cost cap is checked against): $0.35 reported by providers (2 sessions) + $2.50 at conservative ceilings for 1 session that reported no cost and could not be priced (implementer wrk-impl) + $0.30 charged with no matching usage record; $0.05 of it was spent before PLANNING and charged when the budget was created',
    );
    // An inquisitor recorded by another component and never charged (0.3.0): the charge falls short of the spend.
    session(db, clock, 'wrk-inq', 0.5);
    const short = spendBreakdown(db, 'run-1');
    expect(short).toMatchObject({ charged_usd: 3.15, reported_usd: 0.85, unmatched_usd: 0, uncharged_usd: 0.2 });
    expect(short.explanation).toMatch(/; \$0\.20 of the recorded spend was never charged to the budget$/);
  });

  // Third adversarial review of fix/031-budget: a run started before 0.3.1 recorded no charge marks, and matching its
  // charges to usage records by role and order was a guess. Its figures are given as recorded, with nothing matched.
  it('a run started before 0.3.1 gives its figures as recorded, matches nothing and says which rules account for it', () => {
    const { db, clock } = setup();
    startedOn030(db);
    const ledger = new BudgetLedger(db, clock).init('run-1', { config: POLICY }, 'medium');
    const worker = (id: string, role: 'implementer' | 'reviewer'): void => {
      planWorker(db, { id, runId: 'run-1', role, provider: 'codex', workerDir: `/w/${id}`, cwd: '/repo' }, clock);
    };
    // 0.3.0 accountWorker: the charge first (no worker_id), then the usage record, which recordUsage priced itself.
    worker('w-rev', 'reviewer');
    ledger.consumeCost({ costUsd: null }, 'reviewer', { phase: 'final', tokenEstimate: { costUsd: 0.51, basis: 'model pricing', model: 'gpt-x' } });
    recordUsage(db, { runId: 'run-1', workerId: 'w-rev', provider: 'codex', model: 'gpt-x', usage: usage({ provider: 'codex', costUsd: 0.51, costSource: 'estimated' }), durationMs: 1 }, clock);
    worker('w-impl', 'implementer');
    ledger.consumeCost({ costUsd: 0.12, costSource: 'reported' }, 'implementer');
    session(db, clock, 'w-impl', 0.12);
    worker('w-impl-2', 'implementer');
    ledger.consumeCost({ costUsd: null }, 'implementer', { ceilingUsd: 1 });
    session(db, clock, 'w-impl-2', null);
    const s = spendBreakdown(db, 'run-1');
    expect(s).toMatchObject({
      accounting: 'legacy',
      charged_usd: 1.63,
      reported_usd: 0.12,
      reported_sessions: 1,
      estimated_usd: 0.51,
      estimated_sessions: 1,
      ceiling_usd: 0,
      ceiling_sessions: 0,
      unpriced_sessions: 1,
      unmatched_usd: null,
      uncharged_usd: null,
      legacy_charges: { ceiling_usd: 1, ceiling_charges: 1, token_estimated_usd: 0.51, token_estimated_charges: 1 },
    });
    expect(s.explanation).toBe(
      '$1.63 charged to the cost budget (the figure the cost cap is checked against); recorded usage: $0.12 reported by providers (1 session), $0.51 estimated from tokens for 1 session that reported no cost, 1 session with no reported cost (implementer w-impl-2); charged for sessions that reported no cost: $1.00 at conservative ceilings (1 charge), $0.51 estimated from tokens (1 charge); this run was started before Orbit 0.3.1 and is accounted under the rules of the version that started it, which did not record the session each charge covers, so these figures are as recorded',
    );
  });

  it('a run started before 0.3.1 with no budget yet says what PLANNING will charge, and which rules account for it', () => {
    const { db, clock } = setup();
    startedOn030(db);
    session(db, clock, 'wrk-plan', 0.05);
    expect(spendBreakdown(db, 'run-1')).toMatchObject({
      accounting: 'legacy',
      uncharged_usd: 0.05,
      explanation: 'nothing charged to the cost budget yet: PLANNING creates it and then charges what was spent before; spent so far: $0.05 reported by providers (1 session); this run was started before Orbit 0.3.1 and is accounted under the rules of the version that started it, which did not record the session each charge covers, so these figures are as recorded',
    });
  });

  it('a budget with nothing charged and no usage says so plainly', () => {
    const { db, clock } = setup();
    new BudgetLedger(db, clock).init('run-1', { config: POLICY }, 'medium');
    expect(spendBreakdown(db, 'run-1').explanation).toBe('$0.00 charged to the cost budget (the figure the cost cap is checked against); no usage recorded yet');
  });

  it('a usage record the registry priced counts as an estimate, and as its charge when the budget charged it from its tokens', () => {
    const { db, clock } = setup();
    const ledger = new BudgetLedger(db, clock).init('run-1', { config: POLICY }, 'medium');
    const a = recordUsage(db, { runId: 'run-1', workerId: 'w-a', provider: 'claude', model: null, usage: usage({ costUsd: 0.4, costSource: 'estimated' }), durationMs: 1 }, clock).id;
    ledger.consumeCost({ costUsd: 0.4, costSource: 'estimated' }, 'implementer', { workerId: 'w-a' });
    mark(db, clock, a, 0.4, 'estimated');
    // A lost Claude session: charged from its tokens, and its usage row priced again from the registry; it counts as its charge.
    ledger.consumeCost({ costUsd: null }, 'implementer', { workerId: 'w-b', tokenEstimate: { costUsd: 0.7, basis: 'model pricing', model: 'm' } });
    mark(db, clock, recordUsage(db, { runId: 'run-1', workerId: 'w-b', provider: 'claude', model: null, usage: usage({ costUsd: 0.69, costSource: 'estimated' }), durationMs: 1 }, clock).id, 0.7, 'estimated');
    const s = spendBreakdown(db, 'run-1');
    expect(s).toMatchObject({ charged_usd: 1.1, estimated_usd: 1.1, estimated_sessions: 2, reported_sessions: 0, unmatched_usd: 0, uncharged_usd: 0 });
    expect(s.explanation).toBe('$1.10 charged to the cost budget (the figure the cost cap is checked against): $1.10 estimated from tokens for 2 sessions that reported no cost');
  });
});
