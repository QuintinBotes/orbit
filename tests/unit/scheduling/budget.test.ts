import { describe, expect, it } from 'vitest';
import { openDb, type OrbitDb } from '../../../src/storage/db.ts';
import { ManualClock } from '../../../src/core/clock.ts';
import { isOrbitError, type OrbitError } from '../../../src/core/errors.ts';
import { createRun } from '../../../src/controller/run-store.ts';
import { BudgetLedger, ROLE_COST_CEILING_USD, extensionDecisionRecord, type BudgetPolicy } from '../../../src/scheduling/budget.ts';
import { recordUsage } from '../../../src/routing/usage.ts';
import type { ExtensionRequest } from '../../../src/scheduling/types.ts';

function policy(patch: { hard?: Partial<BudgetPolicy['scheduler']['hard_limits']>; ext?: Partial<BudgetPolicy['scheduler']['extension']>; reserve?: number; ci?: number } = {}): BudgetPolicy {
  return {
    scheduler: {
      hard_limits: {
        implementation_attempts: 12,
        diagnostic_experiments: 16,
        review_rounds: 4,
        ci_repair_cycles: 3,
        worker_turns_per_session: 30,
        wall_minutes: 120,
        model_cost_usd: 30,
        parallel_workers: 4,
        changed_files: 40,
        changed_lines: 2000,
        infrastructure_retries: 5,
        recovery_attempts: 3,
        ...patch.hard,
      },
      initial_allowances: { simple_attempts: 2, medium_attempts: 4, complex_attempts: 6 },
      extension: {
        attempts_per_extension: 1,
        require_measurable_progress: true,
        require_new_hypothesis: true,
        preserve_final_verification_reserve: true,
        ...patch.ext,
      },
      final_reserve_fraction: patch.reserve ?? 0.2,
    },
    delivery: { max_ci_repair_cycles: patch.ci ?? 2 },
  };
}

function setup(p: BudgetPolicy = policy(), difficulty: 'simple' | 'medium' | 'complex' = 'medium') {
  const db = openDb(':memory:');
  const clock = new ManualClock();
  createRun(db, { id: 'run-1', repoRoot: '/repo/acme', goal: 'g', mode: 'autonomous', policyHash: 'sha256:x', policyPath: '/p' }, clock);
  const ledger = new BudgetLedger(db, clock).init('run-1', { config: p }, difficulty);
  return { db, clock, ledger, p };
}

function caught(fn: () => unknown): OrbitError {
  try {
    fn();
  } catch (err) {
    if (isOrbitError(err)) return err;
    throw err;
  }
  throw new Error('expected an OrbitError');
}

function events(db: OrbitDb, type: string): unknown[] {
  return db.all<{ data_json: string }>('SELECT data_json FROM events WHERE run_id = ? AND type = ? ORDER BY id', 'run-1', type).map((e) => JSON.parse(e.data_json));
}

const progress = { newly_supported_criteria: ['AC-2'] };

function ext(patch: Partial<ExtensionRequest> = {}): ExtensionRequest {
  return { counter: 'implementation_attempts', progress, hypothesisIsNew: true, withinScope: true, nextExperiment: 'Run a multi-page filtered fixture.', estimatedCostUsd: 1, estimatedWallMs: 60_000, ...patch };
}

describe('BudgetLedger.init', () => {
  it('creates every counter with allowances from the difficulty class and caps from the snapshot', () => {
    const { ledger, db } = setup(policy(), 'simple');
    const s = ledger.snapshot();
    const byName = Object.fromEntries(s.counters.map((c) => [c.counter, c]));
    expect(Object.keys(byName)).toEqual([
      'implementation_attempts',
      'diagnostic_experiments',
      'review_rounds',
      'ci_repair_cycles',
      'infrastructure_retries',
      'recovery_attempts',
      'worker_turns_per_session',
      'wall_ms',
      'cost_usd',
    ]);
    expect(byName.implementation_attempts).toMatchObject({ allowance: 2, hard_cap: 12, used: 0 });
    expect(byName.diagnostic_experiments).toMatchObject({ allowance: 4, hard_cap: 16 });
    expect(byName.ci_repair_cycles).toMatchObject({ allowance: 2, hard_cap: 3 });
    expect(byName.wall_ms).toMatchObject({ allowance: 7_200_000, hard_cap: 7_200_000 });
    expect(byName.cost_usd).toMatchObject({ allowance: 30, hard_cap: 30 });
    expect(ledger.maxTurnsPerSession()).toBe(30);
    expect(s.reserve).toEqual({ fraction: 0.2, cost_usd: 6, wall_ms: 1_440_000, shares: { final_verification: 0.4, review: 0.45, reporting: 0.15 } });
    const [init] = events(db, 'budget.initialized') as { difficulty: string; counters: Record<string, { reason: string }> }[];
    expect(init?.difficulty).toBe('simple');
    expect(init?.counters.implementation_attempts?.reason).toBe('simple difficulty starts with 2 attempt(s)');
  });

  it('records the difficulty assessment and clamps an allowance to its hard cap', () => {
    const { ledger, db } = setup(policy({ hard: { implementation_attempts: 3 } }), 'complex');
    expect(ledger.state('implementation_attempts')).toMatchObject({ allowance: 3, hard_cap: 3 });
    const [init] = events(db, 'budget.initialized') as { counters: Record<string, { reason: string }> }[];
    expect(init?.counters.implementation_attempts?.reason).toMatch(/clamped to the hard cap of 3/);
    const db2 = openDb(':memory:');
    const clock = new ManualClock();
    createRun(db2, { id: 'r2', repoRoot: '/repo/acme', goal: 'g', mode: 'autonomous', policyHash: 'sha256:x', policyPath: '/p' }, clock);
    new BudgetLedger(db2, clock).init('r2', { config: policy() }, { class: 'medium', score: 6, max_score: 20, reasons: ['class medium'], factors: [] });
    const row = db2.get<{ data_json: string }>("SELECT data_json FROM events WHERE type = 'budget.initialized'")!;
    expect(JSON.parse(row.data_json)).toMatchObject({ difficulty: 'medium', difficulty_score: 6, difficulty_reasons: ['class medium'] });
  });

  it('is idempotent on restart and refuses changed hard caps', () => {
    const { db, clock, ledger } = setup();
    ledger.consume('implementation_attempts', 1);
    const again = new BudgetLedger(db, clock).init('run-1', { config: policy() }, 'complex');
    expect(again.state('implementation_attempts')).toMatchObject({ used: 1, allowance: 4 });
    expect(events(db, 'budget.initialized')).toHaveLength(1);
    expect(caught(() => new BudgetLedger(db, clock).init('run-1', { config: policy({ hard: { model_cost_usd: 60 } }) }, 'medium')).code).toBe('POLICY_TAMPERED');
    expect(caught(() => new BudgetLedger(db, clock).attach('run-1', { config: policy({ hard: { review_rounds: 9 } }) })).code).toBe('POLICY_TAMPERED');
    expect(new BudgetLedger(db, clock).attach('run-1', { config: policy() }).state('implementation_attempts').used).toBe(1);
  });

  it('refuses invalid configuration and use before binding', () => {
    const { db, clock } = setup();
    expect(caught(() => new BudgetLedger(db, clock).attach('missing', { config: policy() })).code).toBe('NOT_FOUND');
    expect(caught(() => new BudgetLedger(db, clock).state('cost_usd')).code).toBe('INTERNAL');
    expect(caught(() => new BudgetLedger(db, clock).init('run-1', { config: policy({ hard: { recovery_attempts: undefined as never } }) }, 'simple')).code).toBe('CONFIG_INVALID');
    expect(caught(() => new BudgetLedger(db, clock).init('run-1', { config: policy({ reserve: 1 }) }, 'simple')).code).toBe('CONFIG_INVALID');
    expect(caught(() => new BudgetLedger(db, clock).init('run-1', { config: policy() }, 'trivial' as never)).code).toBe('SCHEMA_INVALID');
  });
});

describe('BudgetLedger.consume', () => {
  it('refuses a discrete counter at its allowance, without recording, and says it can be extended', () => {
    const { ledger, db } = setup(policy(), 'simple');
    ledger.consume('implementation_attempts', 1);
    ledger.consume('implementation_attempts', 1);
    const err = caught(() => ledger.consume('implementation_attempts', 1));
    expect(err.code).toBe('BUDGET_EXHAUSTED');
    expect(err.details).toMatchObject({ counter: 'implementation_attempts', used: 2, allowance: 2, hard_cap: 12, limit: 'allowance', extendable: true });
    expect(ledger.state('implementation_attempts').used).toBe(2);
    expect(events(db, 'budget.exhausted')).toHaveLength(1);
  });

  it('reports a hard cap as not extendable', () => {
    const { ledger } = setup();
    for (let i = 0; i < 4; i++) ledger.consume('review_rounds', 1);
    expect(caught(() => ledger.consume('review_rounds', 1)).details).toMatchObject({ limit: 'hard_cap', extendable: false });
  });

  it('keeps infrastructure retries apart from implementation attempts', () => {
    const { ledger } = setup();
    for (let i = 0; i < 5; i++) ledger.consume('infrastructure_retries', 1);
    expect(ledger.state('implementation_attempts').used).toBe(0);
    expect(caught(() => ledger.consume('infrastructure_retries', 1)).code).toBe('BUDGET_EXHAUSTED');
  });

  it('records measured spend even when it overshoots, stopping ordinary work at the reserve', () => {
    const { ledger, db } = setup();
    ledger.consume('cost_usd', 20);
    const err = caught(() => ledger.consume('cost_usd', 5));
    expect(err.details).toMatchObject({ limit: 'reserve', used: 25, extendable: false, phase: 'work' });
    expect(ledger.state('cost_usd').used).toBe(25);
    // Closing phases may spend the reserve, up to the hard cap.
    expect(ledger.consume('cost_usd', 4, { phase: 'final' }).used).toBe(29);
    expect(caught(() => ledger.consume('cost_usd', 2, { phase: 'final' })).details).toMatchObject({ limit: 'hard_cap', used: 31 });
    expect(events(db, 'budget.exhausted')).toHaveLength(2);
  });

  it('caps worker turns per session, not per run', () => {
    const { ledger } = setup();
    ledger.consume('worker_turns_per_session', 20, { sessionId: 's1' });
    ledger.consume('worker_turns_per_session', 25, { sessionId: 's2' });
    expect(ledger.consume('worker_turns_per_session', 10, { sessionId: 's1' })).toMatchObject({ used: 30, hard_cap: 30, remaining: 0 });
    const err = caught(() => ledger.consume('worker_turns_per_session', 1, { sessionId: 's1' }));
    expect(err.details).toMatchObject({ counter: 'worker_turns_per_session:s1', limit: 'hard_cap' });
    expect(ledger.state('worker_turns_per_session').used).toBe(30);
    expect(ledger.snapshot().sessions.map((s) => s.counter).sort()).toEqual(['worker_turns_per_session:s1', 'worker_turns_per_session:s2']);
    expect(caught(() => ledger.consume('worker_turns_per_session', 1)).code).toBe('SCHEMA_INVALID');
  });

  it('rejects unknown counters and invalid amounts', () => {
    const { ledger } = setup();
    expect(caught(() => ledger.consume('tokens' as never, 1)).code).toBe('SCHEMA_INVALID');
    expect(caught(() => ledger.consume('cost_usd', -1)).code).toBe('SCHEMA_INVALID');
    expect(caught(() => ledger.consume('cost_usd', Number.NaN)).code).toBe('SCHEMA_INVALID');
  });

  it('syncs wall time from the clock', () => {
    const { ledger, clock } = setup();
    clock.advance(10 * 60_000);
    expect(ledger.syncWall().used).toBe(600_000);
    ledger.consume('wall_ms', 60_000);
    clock.advance(30_000);
    expect(ledger.syncWall().used).toBe(660_000);
    clock.advance(100 * 60_000);
    expect(caught(() => ledger.syncWall()).details).toMatchObject({ counter: 'wall_ms', limit: 'reserve' });
  });
});

describe('cost measurement and admission control', () => {
  it('charges a conservative role ceiling when cost is unavailable and says spend is unmeasured', () => {
    const { ledger, db, clock } = setup();
    expect(ledger.costMeasurement().state).toBe('no_usage');
    recordUsage(db, { runId: 'run-1', workerId: 'w1', provider: 'codex', model: 'codex-alpha', usage: null, durationMs: null }, clock);
    const charge = ledger.consumeCost({ costUsd: null }, 'reviewer');
    expect(charge).toMatchObject({ charged: ROLE_COST_CEILING_USD.reviewer, basis: 'ceiling' });
    const m = ledger.costMeasurement();
    expect(m).toMatchObject({ state: 'unmeasured', unavailable_records: 1, ceiling_charges: 1, ceiling_charged_usd: 4 });
    expect(m.note).toMatch(/not an exact spend guarantee/);
    recordUsage(db, { runId: 'run-1', workerId: 'w2', usage: { provider: 'claude', model: 'claude-sonnet-5-5', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.1, costSource: 'reported' }, durationMs: 1 }, clock);
    ledger.consumeCost({ costUsd: 0.1, costSource: 'reported' }, 'implementer');
    expect(ledger.costMeasurement().state).toBe('partially_unmeasured');
    expect(ledger.state('cost_usd').used).toBeCloseTo(4.1, 9);
  });

  it('distinguishes estimated from reported spend', () => {
    const { ledger, db, clock } = setup();
    const pricing = { input: 2, output: 10, cache_write_5m: 2.5, cache_write_1h: 4, cache_read: 0.2 };
    recordUsage(db, { runId: 'run-1', workerId: 'w1', usage: { provider: 'claude', model: 'claude-sonnet-5-5', inputTokens: 1000, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, costSource: 'unavailable' }, durationMs: 1, pricing }, clock);
    expect(ledger.costMeasurement().state).toBe('estimated');
    expect(ledger.consumeCost({ costUsd: 0.002, costSource: 'estimated' }, 'implementer').basis).toBe('estimated');
  });

  it('admits work that fits under the cap less the reserve, and uses ceilings for unknown estimates', () => {
    const { ledger } = setup();
    const ok = ledger.admit({ estimatedCostUsd: 2, estimatedWallMs: 60_000 });
    expect(ok.admitted).toBe(true);
    expect(ok.cost).toMatchObject({ used: 0, estimate: 2, basis: 'estimate', limit: 24, remaining_after: 22 });
    const unknown = ledger.admit({ role: 'implementer' });
    expect(unknown.cost).toMatchObject({ estimate: ROLE_COST_CEILING_USD.implementer, basis: 'ceiling' });
    expect(unknown.wall.basis).toBe('ceiling');
    ledger.consume('cost_usd', 20);
    const tight = ledger.admit({ estimatedCostUsd: 5, estimatedWallMs: 0 });
    expect(tight.admitted).toBe(false);
    expect(tight.reasons[0]).toMatch(/cost exceeds: used \$20.00 \+ estimate \$5.00 against \$24.00/);
    expect(ledger.admit({ estimatedCostUsd: 5, estimatedWallMs: 0, phase: 'final' }).admitted).toBe(true);
  });

  it('refuses admission on wall time too', () => {
    const { ledger } = setup();
    ledger.consume('wall_ms', 90 * 60_000);
    const d = ledger.admit({ estimatedCostUsd: 0, estimatedWallMs: 10 * 60_000 });
    expect(d.admitted).toBe(false);
    expect(d.reasons[1]).toMatch(/wall time exceeds/);
  });
});

describe('worker spend cap', () => {
  it('holds back one worst-case request because the CLI budget flag overshoots', () => {
    const { ledger } = setup();
    expect(ledger.workerSpendCapUsd(6.56)).toBe(17.44);
    expect(ledger.workerSpendCapUsd(6.56, 'final')).toBe(23.44);
    ledger.consume('cost_usd', 20);
    expect(ledger.workerSpendCapUsd(6.56)).toBe(0);
    expect(caught(() => ledger.workerSpendCapUsd(-1)).code).toBe('SCHEMA_INVALID');
  });
});

describe('BudgetLedger.requestExtension (spec section 7)', () => {
  it('grants one attempt with measurable progress, a new hypothesis, scope and reserve, in the spec shape', () => {
    const { ledger, db } = setup();
    const d = ledger.requestExtension(ext({ reason: 'The failure is isolated to pagination handling.' }));
    expect(d).toMatchObject({
      decision: 'extend_attempt_allowance',
      previous_allowance: 4,
      new_allowance: 5,
      reason: 'The failure is isolated to pagination handling.',
      progress: { newly_supported_criteria: ['AC-2'] },
      next_experiment: 'Run a multi-page filtered fixture.',
      within_hard_limits: true,
      reserve_preserved: true,
      denied_because: [],
    });
    expect(ledger.state('implementation_attempts').allowance).toBe(5);
    expect(events(db, 'budget.extension')).toEqual([d]);
    expect(extensionDecisionRecord(d)).toEqual({ kind: 'allowance.extend', summary: 'implementation_attempts allowance 4 -> 5', data: d });
  });

  it('does not count more tokens or a bigger diff as progress', () => {
    const { ledger, db } = setup();
    const d = ledger.requestExtension(ext({ progress: { tokens_spent: 900_000, diff_lines: 400, fixed_checks: [] } }));
    expect(d.decision).toBe('deny_extension');
    expect(d.new_allowance).toBe(4);
    expect(d.denied_because[0]).toMatch(/no measurable progress/);
    expect(d.ignored_progress).toEqual([
      'tokens_spent: not a progress kind; more tokens or a larger diff are not progress',
      'diff_lines: not a progress kind; more tokens or a larger diff are not progress',
    ]);
    expect(ledger.state('implementation_attempts').allowance).toBe(4);
    expect(events(db, 'budget.extension-denied')).toHaveLength(1);
    expect(extensionDecisionRecord(d)).toMatchObject({ kind: 'allowance.deny', summary: 'implementation_attempts extension denied at 4' });
  });

  it('requires a new hypothesis, authorized scope and a remaining failure', () => {
    const { ledger } = setup();
    expect(ledger.requestExtension(ext({ hypothesisIsNew: false })).denied_because).toEqual(['no materially new, evidence-backed hypothesis']);
    expect(ledger.requestExtension(ext({ withinScope: false })).denied_because).toEqual(['the next experiment is outside authorized scope']);
    expect(ledger.requestExtension(ext({ failureRemains: false })).denied_because).toEqual(['no specific failure remains']);
    expect(ledger.requestExtension(ext({ progress: { localized_fault: 'src/export.ts:42' } })).decision).toBe('extend_attempt_allowance');
  });

  it('never extends past the hard cap', () => {
    const { ledger } = setup(policy({ hard: { implementation_attempts: 5 } }));
    expect(ledger.requestExtension(ext()).new_allowance).toBe(5);
    const d = ledger.requestExtension(ext({ progress: { fixed_checks: ['lint'] } }));
    expect(d).toMatchObject({ decision: 'deny_extension', within_hard_limits: false, new_allowance: 5 });
    expect(d.denied_because[0]).toMatch(/would exceed the hard cap of 5/);
  });

  it('protects the closing reserve, estimating the next attempt from spend so far', () => {
    const { ledger } = setup();
    for (let i = 0; i < 2; i++) ledger.consume('implementation_attempts', 1);
    ledger.consume('cost_usd', 19);
    const d = ledger.requestExtension(ext({ estimatedCostUsd: undefined, estimatedWallMs: undefined }));
    // No usage rows, so spend per attempt is not measured and the implementer ceiling ($6) applies: 19 + 6 > 30 - 6.
    expect(d.reserve_preserved).toBe(false);
    expect(d.denied_because[0]).toMatch(/final verification, review and reporting reserve/);
    expect(ledger.requestExtension(ext({ estimatedCostUsd: 1 })).decision).toBe('extend_attempt_allowance');
  });

  it('estimates the next attempt from measured spend per attempt when spend is measured', () => {
    const { ledger, db, clock } = setup();
    recordUsage(db, { runId: 'run-1', workerId: 'w1', usage: { provider: 'claude', model: 'claude-sonnet-5-5', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 17, costSource: 'reported' }, durationMs: 1 }, clock);
    for (let i = 0; i < 2; i++) ledger.consume('implementation_attempts', 1);
    ledger.consume('cost_usd', 17);
    // $8.50 per attempt so far: 17 + 8.5 > 24, although the $6 ceiling alone would have fitted.
    const d = ledger.requestExtension(ext({ estimatedCostUsd: undefined, estimatedWallMs: 0 }));
    expect(d.reserve_preserved).toBe(false);
    expect(d.denied_because[0]).toMatch(/about \$8.50/);
  });

  it('honours policy switches that waive a requirement, saying so', () => {
    const { ledger } = setup(policy({ ext: { require_new_hypothesis: false } }));
    const d = ledger.requestExtension(ext({ hypothesisIsNew: false }));
    expect(d.decision).toBe('extend_attempt_allowance');
    expect(d.reason).toMatch(/new hypothesis not required by policy/);
  });

  it('extends other discrete counters by the configured step and rejects measured ones', () => {
    const { ledger } = setup(policy({ ext: { attempts_per_extension: 2 } }));
    const d = ledger.requestExtension(ext({ counter: 'diagnostic_experiments', progress: { eliminated_hypotheses: ['H1'] } }));
    expect(d).toMatchObject({ decision: 'extend_allowance', counter: 'diagnostic_experiments', previous_allowance: 8, new_allowance: 10 });
    expect(caught(() => ledger.requestExtension(ext({ counter: 'cost_usd' as never }))).code).toBe('SCHEMA_INVALID');
  });
});
