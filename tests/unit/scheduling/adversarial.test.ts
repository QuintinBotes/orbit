import { describe, expect, it } from 'vitest';
import { openDb } from '../../../src/storage/db.ts';
import { ManualClock } from '../../../src/core/clock.ts';
import { isOrbitError, type OrbitError } from '../../../src/core/errors.ts';
import { createRun } from '../../../src/controller/run-store.ts';
import { BudgetLedger, ROLE_COST_CEILING_USD, type BudgetPolicy } from '../../../src/scheduling/budget.ts';
import { AgentScheduler, budgetAdmission, globsOverlap, type SchedulerConfig, type SystemProbe } from '../../../src/scheduling/scheduler.ts';
import type { ExtensionRequest, WorkUnit } from '../../../src/scheduling/types.ts';

/**
 * Defects found by the adversarial verification pass. Each test failed
 * against the first implementation.
 */

function budgetPolicy(patch: { cost?: number; ci?: number; ciCap?: number } = {}): BudgetPolicy {
  return {
    scheduler: {
      hard_limits: {
        implementation_attempts: 12,
        diagnostic_experiments: 16,
        review_rounds: 4,
        ci_repair_cycles: patch.ciCap ?? 3,
        worker_turns_per_session: 30,
        wall_minutes: 120,
        model_cost_usd: patch.cost ?? 30,
        parallel_workers: 4,
        changed_files: 40,
        changed_lines: 2000,
        infrastructure_retries: 5,
        recovery_attempts: 3,
      },
      initial_allowances: { simple_attempts: 2, medium_attempts: 4, complex_attempts: 6 },
      extension: { attempts_per_extension: 1, require_measurable_progress: true, require_new_hypothesis: true, preserve_final_verification_reserve: true },
      final_reserve_fraction: 0.2,
    },
    delivery: { max_ci_repair_cycles: patch.ci ?? 3 },
  };
}

function ledgerFor(p: BudgetPolicy = budgetPolicy()) {
  const db = openDb(':memory:');
  const clock = new ManualClock();
  createRun(db, { id: 'run-1', repoRoot: '/repo/acme', goal: 'g', mode: 'autonomous', policyHash: 'sha256:x', policyPath: '/p' }, clock);
  return { db, clock, ledger: new BudgetLedger(db, clock).init('run-1', { config: p }, 'medium') };
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

function ext(patch: Partial<ExtensionRequest> = {}): ExtensionRequest {
  return { counter: 'implementation_attempts', progress: { newly_supported_criteria: ['AC-2'] }, hypothesisIsNew: true, withinScope: true, estimatedCostUsd: 0.5, estimatedWallMs: 60_000, ...patch };
}

const MB = 1024 * 1024;

function schedConfig(parallel = 4, defaultParallelism = 1): SchedulerConfig {
  return { agents: { default_parallelism: defaultParallelism, cancel_obsolete_workers: true }, scheduler: { hard_limits: { parallel_workers: parallel } } };
}

function sys(cores: number, freeMb: number): SystemProbe {
  return { availableParallelism: () => cores, freemem: () => freeMb * MB };
}

function unit(id: string, patch: Partial<WorkUnit> = {}): WorkUnit {
  return { id, role: 'implementer', writer: false, ownedPaths: [], dependsOn: [], revision: null, cancelWhen: [], budget: {}, ...patch };
}

describe('extensions cannot be bought twice with the same progress', () => {
  it('denies a second extension that re-reports progress already credited, so non-progress terminates', () => {
    const { ledger } = ledgerFor();
    expect(ledger.requestExtension(ext()).decision).toBe('extend_attempt_allowance');
    const again = ledger.requestExtension(ext());
    expect(again.decision).toBe('deny_extension');
    expect(again.new_allowance).toBe(5);
    expect(again.denied_because[0]).toMatch(/no measurable progress/);
    expect(again.ignored_progress).toEqual(['newly_supported_criteria: AC-2 was already credited to an earlier extension']);
    expect(ledger.state('implementation_attempts').allowance).toBe(5);
  });

  it('credits only the new part of cumulative progress, and keeps a re-localized fault from counting twice', () => {
    const { ledger } = ledgerFor();
    ledger.requestExtension(ext({ progress: { newly_supported_criteria: ['AC-2'], localized_fault: 'src/export.ts:42' } }));
    const next = ledger.requestExtension(ext({ progress: { newly_supported_criteria: ['AC-2', 'AC-3'], localized_fault: 'src/export.ts:42' } }));
    expect(next.decision).toBe('extend_attempt_allowance');
    expect(next.progress).toEqual({ newly_supported_criteria: ['AC-3'] });
    expect(ledger.requestExtension(ext({ progress: { localized_fault: 'src/export.ts:42' } })).decision).toBe('deny_extension');
  });

  it('keeps credit per counter, so one finding may justify both an attempt and an experiment', () => {
    const { ledger } = ledgerFor();
    ledger.requestExtension(ext({ progress: { eliminated_hypotheses: ['H1'] } }));
    expect(ledger.requestExtension(ext({ counter: 'diagnostic_experiments', progress: { eliminated_hypotheses: ['H1'] } })).decision).toBe('extend_allowance');
  });
});

describe('ci repair cycles stay within delivery.max_ci_repair_cycles', () => {
  it('never extends ci repair cycles past the configured delivery maximum', () => {
    const { ledger } = ledgerFor(budgetPolicy({ ci: 2, ciCap: 5 }));
    expect(ledger.state('ci_repair_cycles').allowance).toBe(2);
    const d = ledger.requestExtension(ext({ counter: 'ci_repair_cycles', progress: { fixed_checks: ['ci:unit'] } }));
    expect(d.decision).toBe('deny_extension');
    expect(d.within_hard_limits).toBe(false);
    expect(d.denied_because[0]).toMatch(/delivery.max_ci_repair_cycles \(2\)/);
  });
});

describe('discrete counters count whole units', () => {
  it('rejects fractional amounts for attempts and turns', () => {
    const { ledger } = ledgerFor();
    expect(caught(() => ledger.consume('implementation_attempts', 0.5)).code).toBe('SCHEMA_INVALID');
    expect(caught(() => ledger.consume('worker_turns_per_session', 1.5, { sessionId: 's1' })).code).toBe('SCHEMA_INVALID');
    expect(ledger.consume('cost_usd', 0.25).used).toBe(0.25);
  });
});

describe('unmeasured sessions are charged at the provider cap they ran under', () => {
  it('charges the session cap, not the smaller role ceiling, when a capped session reports no cost', () => {
    const { ledger, db } = ledgerFor(budgetPolicy({ cost: 60 }));
    // The worker ran with --max-budget-usd 17.44, which can overshoot by one request (gaps V1).
    const charge = ledger.consumeCost({ costUsd: null }, 'implementer', { ceilingUsd: 17.44 + 10.56 });
    expect(charge).toMatchObject({ charged: 28, basis: 'ceiling' });
    expect(charge.charged).toBeGreaterThan(ROLE_COST_CEILING_USD.implementer);
    const row = db.get<{ data_json: string }>("SELECT data_json FROM events WHERE type = 'budget.cost-ceiling-charged'")!;
    expect(JSON.parse(row.data_json)).toMatchObject({ role: 'implementer', ceiling_usd: 28, ceiling_basis: 'session-cap' });
    expect(ledger.costMeasurement().ceiling_charged_usd).toBe(28);
  });

  it('falls back to the role ceiling without a session cap and rejects a nonsense cap', () => {
    const { ledger } = ledgerFor();
    expect(ledger.consumeCost({ costUsd: null }, 'reviewer').charged).toBe(ROLE_COST_CEILING_USD.reviewer);
    expect(caught(() => ledger.consumeCost({ costUsd: null }, 'reviewer', { ceilingUsd: -1 })).code).toBe('SCHEMA_INVALID');
  });
});

describe('admission counts work already admitted but not yet charged', () => {
  it('refuses a worker whose cost only fits if running workers spend nothing', () => {
    const { ledger } = ledgerFor();
    // Limit is 30 less the 6 reserve = 24. Nothing charged yet, but three implementers are running.
    const d = ledger.admit({ estimatedCostUsd: 6, role: 'implementer', committed: [{ role: 'implementer' }, { role: 'implementer' }, { estimatedCostUsd: 7, role: 'implementer' }] });
    expect(d.admitted).toBe(false);
    expect(d.cost.committed).toBe(19);
    expect(d.reasons[0]).toMatch(/\+ committed \$19.00/);
    // Checks cost no model spend.
    expect(ledger.admit({ estimatedCostUsd: 6, committed: [{ role: 'check' }, { role: 'check' }] }).admitted).toBe(true);
  });

  it('lets the scheduler start parallel workers only while their combined budget fits', () => {
    const { ledger } = ledgerFor(budgetPolicy({ cost: 20 }));
    // Limit is 20 less the 4 reserve = 16; each implementer is estimated at $6.
    const s = new AgentScheduler(schedConfig(4), { system: sys(16, 64_000), clock: new ManualClock() });
    const units = ['a', 'b', 'c', 'd'].map((id) => unit(id, { writer: true, ownedPaths: [`pkg/${id}/**`], budget: { costUsd: 6 } }));
    const plan = s.plan(units, { parallelism: 4, admit: budgetAdmission(ledger) });
    expect(plan.start.map((u) => u.id)).toEqual(['a', 'b']);
    expect(plan.deferred.map((d) => d.id)).toEqual(['c', 'd']);
    expect(plan.deferred[0]?.reason).toMatch(/not admitted by budget: cost exceeds/);
    // A running unit's budget is committed too.
    const after = s.plan([{ ...units[0]!, status: 'running' }, units[1]!, units[2]!], { parallelism: 4, admit: budgetAdmission(ledger) });
    expect(after.start.map((u) => u.id)).toEqual(['b']);
  });
});

describe('capacity never fails open', () => {
  it('treats an unreadable core count or free memory as the most conservative value', () => {
    const nan = new AgentScheduler(schedConfig(4, 4), { system: { availableParallelism: () => Number.NaN, freemem: () => Number.NaN }, clock: new ManualClock() });
    const c = nan.capacity();
    expect(c.slots).toBe(1);
    expect(c.notes.join(' ')).toMatch(/could not read/);
    const plan = nan.plan([unit('a'), unit('b'), unit('c')], { parallelism: 4 });
    expect(plan.start.map((u) => u.id)).toEqual(['a']);
  });
});

describe('writers never share a worktree, however its path is spelled', () => {
  const s = () => new AgentScheduler(schedConfig(4), { system: sys(16, 64_000), clock: new ManualClock() });
  const running = (wt: string) => unit('w1', { writer: true, ownedPaths: ['src/a/**'], worktree: wt, status: 'running' });
  it.each([
    ['/wt/1', '/wt/1/'],
    ['/wt/1', '/wt/./1'],
    ['/wt/1', '/wt/x/../1'],
    ['/wt/1', '/WT/1'],
    ['/wt/1', '/wt/1/nested'],
  ])('%s and %s are the same mutable worktree', (a, b) => {
    const plan = s().plan([running(a), unit('w2', { writer: true, ownedPaths: ['src/b/**'], worktree: b })], { parallelism: 4 });
    expect(plan.start).toEqual([]);
    expect(plan.deferred[0]?.reason).toMatch(/writers never share a worktree/);
  });

  it('still runs writers in genuinely separate worktrees', () => {
    const plan = s().plan([running('/wt/1'), unit('w2', { writer: true, ownedPaths: ['src/b/**'], worktree: '/wt/10' })], { parallelism: 4 });
    expect(plan.start.map((u) => u.id)).toEqual(['w2']);
  });
});

describe('glob overlap is not fooled by path spelling', () => {
  it.each([
    ['src/./a.ts', 'src/a.ts'],
    ['src/a/./**', 'src/a/b.ts'],
    ['Src/A.ts', 'src/a.ts'],
    ['SRC/**', 'src/a.ts'],
    ['src/*.TS', 'src/a.ts'],
    ['docs/café.md', 'docs/café.md'],
  ])('%s overlaps %s', (a, b) => {
    expect(globsOverlap(a, b)).toBe(true);
    expect(globsOverlap(b, a)).toBe(true);
  });
});

describe('ownership outside the repository-relative form is never assumed disjoint', () => {
  it.each([
    ['/Users/acme/repo/src/**', 'src/a.ts'],
    ['~/repo/src/**', 'src/a.ts'],
    ['C:/repo/src/**', 'src/a.ts'],
  ])('%s overlaps %s', (a, b) => {
    expect(globsOverlap(a, b)).toBe(true);
    expect(globsOverlap(b, a)).toBe(true);
  });
});

describe('worker spend caps account for sessions already running', () => {
  it('gives a second parallel worker only what the first one cannot spend', () => {
    const { ledger } = ledgerFor();
    // Limit 24 (30 less the 6 reserve); one worst-case request is $10.56.
    const first = ledger.workerSpendCapUsd(10.56);
    expect(first).toBe(13.44);
    // The first session may spend its cap plus one overshooting request.
    const second = ledger.workerSpendCapUsd(10.56, 'work', first + 10.56);
    expect(second).toBe(0);
    expect(ledger.workerSpendCapUsd(1, 'work', 10)).toBe(13);
    expect(caught(() => ledger.workerSpendCapUsd(1, 'work', -1)).code).toBe('SCHEMA_INVALID');
  });
});
