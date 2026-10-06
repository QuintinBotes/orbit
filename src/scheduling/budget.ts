import type { OrbitDb } from '../storage/db.ts';
import type { Clock } from '../core/clock.ts';
import { OrbitError } from '../core/errors.ts';
import type { OrbitConfig } from '../policy/types.ts';
import type { ModelPricing } from '../routing/types.ts';
import {
  BUDGET_COUNTERS,
  DISCRETE_COUNTERS,
  MEASURED_COUNTERS,
  SESSION_COUNTER,
  type AdmissionDecision,
  type AdmissionRequest,
  type BudgetCounter,
  type BudgetPhase,
  type BudgetRole,
  type CommittedWork,
  type CostMeasurement,
  type CounterState,
  type DifficultyAssessment,
  type DifficultyClass,
  type DiscreteCounter,
  type ExtensionDecision,
  type ExtensionRequest,
  type MeasuredCounter,
  type ProgressReport,
  type ReserveState,
} from './types.ts';

/**
 * Budget ledger over `budget_counters` (spec section 7).
 *
 * Hard caps are copied from the frozen policy snapshot when the run starts
 * and never change; a restarted controller that presents different caps is
 * refused. Allowances start from the difficulty class and grow by one
 * extension at a time, only with measurable progress, a new hypothesis,
 * authorized scope, room under the hard cap and the closing reserve intact.
 *
 * Discrete counters (attempts, experiments, rounds, cycles, retries,
 * recoveries) are consumed before the work starts and refused at the
 * allowance. Wall time and cost are measured after the fact: the spend is
 * recorded even when it overshoots, and the ledger then reports exhaustion.
 * Ordinary work stops at the hard cap less the reserve; the closing phases
 * (final verification, review, reporting) may use the reserve.
 */

export interface BudgetPolicy {
  scheduler: Pick<OrbitConfig['scheduler'], 'hard_limits' | 'initial_allowances' | 'extension' | 'final_reserve_fraction'>;
  delivery?: Pick<OrbitConfig['delivery'], 'max_ci_repair_cycles'>;
}

/**
 * Conservative per-session ceilings used when a provider reports no cost and
 * none can be estimated. Deliberately high: an unmeasured session is charged
 * as if it were expensive, so the cap still bounds real spend.
 */
export const ROLE_COST_CEILING_USD: Readonly<Record<BudgetRole, number>> = {
  planner: 2,
  implementer: 6,
  verifier: 2,
  reviewer: 4,
  inquisitor: 2,
  curator: 1,
  explorer: 3,
};

/**
 * A session with no measured cost is never presumed to cost more than this fraction of the whole cost cap: the
 * provider's own spend cap (workerSpendCapUsd) bounds it anyway, and on a $2 or $4 cap the full role ceiling
 * ($6 for the implementer) would refuse every first session before any work.
 */
export const MAX_CEILING_FRACTION_OF_CAP = 0.5;
/**
 * The least an unmeasured session is presumed to cost, however small the cap. A cap below this (after the closing
 * reserve) is too small for an honest session, so admission still refuses it (spec section 7: stop EXHAUSTED before
 * spending); a $0.50 cap is refused and a $2 cap is not.
 */
export const MIN_SESSION_CEILING_USD = 1;

export const ROLE_WALL_CEILING_MS: Readonly<Record<BudgetRole, number>> = {
  planner: 15 * 60_000,
  implementer: 30 * 60_000,
  verifier: 20 * 60_000,
  reviewer: 20 * 60_000,
  inquisitor: 10 * 60_000,
  curator: 5 * 60_000,
  explorer: 20 * 60_000,
};

/** How the reserve is apportioned for reporting; enforcement uses the total. */
const RESERVE_SHARES = { final_verification: 0.4, review: 0.45, reporting: 0.15 } as const;
/** A repair cycle typically needs a reproduction and one discriminating experiment. */
const EXPERIMENTS_PER_ATTEMPT = 2;
const PROGRESS_KINDS = ['newly_supported_criteria', 'fixed_checks', 'eliminated_hypotheses', 'localized_fault', 'resolved_ambiguity'] as const;
const EPS = 1e-9;

interface CounterRow {
  counter: string;
  used: number;
  allowance: number;
  hard_cap: number;
}

export interface ConsumeOptions {
  phase?: BudgetPhase;
  /** Required for worker_turns_per_session, which is capped per session. */
  sessionId?: string;
}

/**
 * The dearest rate listed for each token kind across the given models: a price no known model exceeds, used to
 * charge a session whose own model has no pricing (Codex bills by plan or API depending on the login). Null when
 * none of them has a price.
 */
export function dearestPricing(all: ReadonlyArray<ModelPricing | null>): ModelPricing | null {
  const priced = all.filter((p): p is ModelPricing => p !== null);
  if (priced.length === 0) return null;
  const top = (k: keyof ModelPricing): number => Math.max(...priced.map((p) => p[k]));
  return { input: top('input'), output: top('output'), cache_write_5m: top('cache_write_5m'), cache_write_1h: top('cache_write_1h'), cache_read: top('cache_read') };
}

/** A cost priced from reported token counts, for a session whose provider reported tokens but no cost. */
export interface TokenEstimate {
  costUsd: number;
  /** How the price was chosen, e.g. the model's own pricing or the dearest listed pricing. */
  basis: string;
  model: string | null;
}

export interface CostCharge {
  charged: number;
  basis: 'reported' | 'estimated' | 'ceiling';
  state: CounterState;
}

export interface BudgetSnapshot {
  run_id: string;
  counters: CounterState[];
  sessions: CounterState[];
  reserve: ReserveState;
  cost_measurement: CostMeasurement;
}

export interface RoleCeilings {
  costUsd: Readonly<Record<BudgetRole, number>>;
  wallMs: Readonly<Record<BudgetRole, number>>;
}

export class BudgetLedger {
  private readonly db: OrbitDb;
  private readonly clock: Clock;
  private readonly ceilings: RoleCeilings;
  private runId: string | null = null;
  private policy: BudgetPolicy | null = null;

  constructor(db: OrbitDb, clock: Clock, ceilings: RoleCeilings = { costUsd: ROLE_COST_CEILING_USD, wallMs: ROLE_WALL_CEILING_MS }) {
    this.db = db;
    this.clock = clock;
    this.ceilings = ceilings;
  }

  /**
   * Create the run's counters from the snapshot and difficulty, and bind the
   * ledger to the run. Idempotent across restarts: existing counters are kept,
   * provided their hard caps still match the snapshot.
   */
  init(runId: string, snapshot: { config: BudgetPolicy }, difficulty: DifficultyClass | DifficultyAssessment): this {
    const policy = snapshot.config;
    const caps = capsFrom(policy);
    const cls = typeof difficulty === 'string' ? difficulty : difficulty.class;
    const plan = allowancesFrom(policy, caps, cls);
    const reserve = reserveFrom(policy, caps);
    const now = this.clock.now();
    this.db.tx(() => {
      const existing = this.db.all<CounterRow>('SELECT counter, used, allowance, hard_cap FROM budget_counters WHERE run_id = ?', runId);
      if (existing.length > 0) {
        verifyCaps(runId, existing, caps);
        return;
      }
      for (const c of BUDGET_COUNTERS) {
        this.db.run('INSERT INTO budget_counters (run_id, counter, used, allowance, hard_cap) VALUES (?, ?, 0, ?, ?)', runId, c, plan[c].allowance, caps[c]);
      }
      this.event(runId, 'budget.initialized', {
        difficulty: cls,
        difficulty_score: typeof difficulty === 'string' ? null : difficulty.score,
        difficulty_reasons: typeof difficulty === 'string' ? [] : difficulty.reasons,
        counters: Object.fromEntries(BUDGET_COUNTERS.map((c) => [c, { allowance: plan[c].allowance, hard_cap: caps[c], reason: plan[c].reason }])),
        reserve,
      }, now);
    });
    this.runId = runId;
    this.policy = policy;
    return this;
  }

  /** Bind to a run whose counters already exist (controller restart). */
  attach(runId: string, snapshot: { config: BudgetPolicy }): this {
    const caps = capsFrom(snapshot.config);
    const existing = this.db.all<CounterRow>('SELECT counter, used, allowance, hard_cap FROM budget_counters WHERE run_id = ?', runId);
    if (existing.length === 0) throw new OrbitError('NOT_FOUND', `run ${runId} has no budget counters; call init first`);
    verifyCaps(runId, existing, caps);
    this.runId = runId;
    this.policy = snapshot.config;
    return this;
  }

  state(counter: BudgetCounter): CounterState {
    return toState(this.row(this.bound().runId, counter));
  }

  /** The per-session turn cap, for the provider's own max-turns flag. */
  maxTurnsPerSession(): number {
    return this.state(SESSION_COUNTER).hard_cap;
  }

  consume(counter: BudgetCounter, amount: number, opts: ConsumeOptions = {}): CounterState {
    assertCounter(counter);
    if (!Number.isFinite(amount) || amount < 0) throw new OrbitError('SCHEMA_INVALID', `consume ${counter}: amount must be a non-negative number`);
    if ((MEASURED_COUNTERS as readonly string[]).includes(counter)) return this.consumeMeasured(counter as MeasuredCounter, amount, opts.phase ?? 'work').state;
    // Attempts, rounds and turns are whole events; a fractional charge would
    // let a caller run more of them than the allowance says.
    if (!Number.isInteger(amount)) throw new OrbitError('SCHEMA_INVALID', `consume ${counter}: amount must be a whole number`);
    if (counter === SESSION_COUNTER) return this.consumeSession(amount, opts.sessionId);
    return this.consumeDiscrete(counter as DiscreteCounter, amount);
  }

  /**
   * Charge one worker session's cost. Reported and estimated costs are charged
   * as given. With neither, a conservative ceiling is charged and recorded, so
   * the report can say spend is unmeasured: the provider-enforced cap the
   * session ran under when the caller knows it (spec section 7: use supported
   * provider caps), otherwise the role's ceiling. A session started with
   * `--max-budget-usd 17` can spend that much plus one request even though
   * the implementer ceiling is lower, so the role ceiling alone would let the
   * ledger believe in budget that was already spent.
   */
  consumeCost(
    cost: { costUsd: number | null; costSource?: string },
    role: BudgetRole,
    opts: { phase?: BudgetPhase; ceilingUsd?: number | null; tokenEstimate?: TokenEstimate | null } = {},
  ): CostCharge {
    const phase = opts.phase ?? 'work';
    if (opts.ceilingUsd !== undefined && opts.ceilingUsd !== null && !isAmount(opts.ceilingUsd)) {
      throw new OrbitError('SCHEMA_INVALID', 'consumeCost: ceilingUsd must be a non-negative number');
    }
    if (typeof cost.costUsd === 'number' && Number.isFinite(cost.costUsd) && cost.costUsd >= 0) {
      const r = this.consumeMeasured('cost_usd', cost.costUsd, phase);
      return { charged: cost.costUsd, basis: cost.costSource === 'estimated' ? 'estimated' : 'reported', state: r.state };
    }
    // Tokens were reported but no cost (Codex under a ChatGPT login): what the tokens would cost is a far closer
    // charge than a ceiling several times larger, and it is still priced at or above any known model's rate.
    const est = opts.tokenEstimate;
    if (est && isAmount(est.costUsd)) {
      const r = this.consumeMeasured('cost_usd', est.costUsd, phase, {
        type: 'budget.cost-token-estimated',
        data: { role, charged_usd: est.costUsd, basis: est.basis, model: est.model },
      });
      return { charged: est.costUsd, basis: 'estimated', state: r.state };
    }
    const sessionCap = isAmount(opts.ceilingUsd) ? opts.ceilingUsd : null;
    const ceiling = sessionCap ?? this.costCeiling(role);
    const r = this.consumeMeasured('cost_usd', ceiling, phase, {
      type: 'budget.cost-ceiling-charged',
      data: { role, ceiling_usd: ceiling, ceiling_basis: sessionCap !== null ? 'session-cap' : 'role-ceiling' },
    });
    return { charged: ceiling, basis: 'ceiling', state: r.state };
  }

  /** Bring wall_ms up to the time elapsed since the budget was initialized. */
  syncWall(opts: { phase?: BudgetPhase } = {}): CounterState {
    const { runId } = this.bound();
    const init = this.db.get<{ ts: number }>("SELECT ts FROM events WHERE run_id = ? AND type = 'budget.initialized' ORDER BY id LIMIT 1", runId);
    if (!init) throw new OrbitError('NOT_FOUND', `run ${runId} has no budget.initialized event`);
    const elapsed = Math.max(0, this.clock.now() - init.ts);
    const delta = Math.max(0, elapsed - this.state('wall_ms').used);
    return this.consumeMeasured('wall_ms', delta, opts.phase ?? 'work').state;
  }

  reserve(): ReserveState {
    const { policy } = this.bound();
    return reserveFrom(policy, capsFrom(policy));
  }

  snapshot(): BudgetSnapshot {
    const { runId } = this.bound();
    const rows = this.db.all<CounterRow>('SELECT counter, used, allowance, hard_cap FROM budget_counters WHERE run_id = ? ORDER BY counter', runId);
    const order = new Map<string, number>(BUDGET_COUNTERS.map((c, i) => [c, i]));
    return {
      run_id: runId,
      counters: rows.filter((r) => order.has(r.counter)).sort((a, b) => (order.get(a.counter) as number) - (order.get(b.counter) as number)).map(toState),
      sessions: rows.filter((r) => r.counter.startsWith(`${SESSION_COUNTER}:`)).map(toState),
      reserve: this.reserve(),
      cost_measurement: this.costMeasurement(),
    };
  }

  /**
   * Admission control for a new worker or phase. Work outside the closing
   * phases must fit under the hard cap less the reserve. An unknown estimate
   * is replaced by the role's conservative ceiling rather than treated as free.
   */
  admit(req: AdmissionRequest = {}): AdmissionDecision {
    const phase = req.phase ?? 'work';
    const role = req.role ?? 'implementer';
    const reserve = this.reserve();
    const cost = this.state('cost_usd');
    const wall = this.state('wall_ms');
    const costLimit = phase === 'final' ? cost.hard_cap : Math.max(0, cost.hard_cap - reserve.cost_usd);
    const wallLimit = phase === 'final' ? wall.hard_cap : Math.max(0, wall.hard_cap - reserve.wall_ms);
    const costKnown = isAmount(req.estimatedCostUsd);
    const wallKnown = isAmount(req.estimatedWallMs);
    const costEst = costKnown ? (req.estimatedCostUsd as number) : this.costCeiling(role);
    const wallEst = wallKnown ? (req.estimatedWallMs as number) : this.wallCeiling(role);
    const committed = roundUsd((req.committed ?? []).reduce((n, c) => n + this.committedCost(c), 0));
    const limitName = phase === 'final' ? 'the hard cap' : 'the hard cap less the closing reserve';
    const reasons: string[] = [];
    const costOk = cost.used + committed + costEst <= costLimit + EPS;
    const wallOk = wall.used + wallEst <= wallLimit + EPS;
    reasons.push(
      `cost ${costOk ? 'fits' : 'exceeds'}: used $${usd(cost.used)}${committed > 0 ? ` + committed $${usd(committed)}` : ''} + ${costKnown ? 'estimate' : `${role} ceiling`} $${usd(costEst)} against $${usd(costLimit)} (${limitName})`,
    );
    reasons.push(`wall time ${wallOk ? 'fits' : 'exceeds'}: used ${mins(wall.used)} + ${wallKnown ? 'estimate' : `${role} ceiling`} ${mins(wallEst)} against ${mins(wallLimit)} (${limitName})`);
    const measurement = this.costMeasurement();
    if (measurement.state === 'unmeasured' || measurement.state === 'partially_unmeasured') reasons.push(measurement.note);
    return {
      admitted: costOk && wallOk,
      phase,
      reasons,
      cost: { used: cost.used, committed, estimate: costEst, basis: costKnown ? 'estimate' : 'ceiling', limit: costLimit, remaining_after: roundUsd(costLimit - cost.used - committed - costEst) },
      wall: { used: wall.used, estimate: wallEst, basis: wallKnown ? 'estimate' : 'ceiling', limit: wallLimit, remaining_after: wallLimit - wall.used - wallEst },
      reserve,
      cost_measurement: measurement,
    };
  }

  /**
   * The spend cap to pass to a worker's own budget flag (`--max-budget-usd`).
   * That flag is checked after each request and overshoots by up to one
   * request, so the cap is what remains under the phase limit less one
   * worst-case request. Sessions already running are charged only when they
   * end, so `committedUsd` (the sum of their caps plus overshoot) is held back
   * too; otherwise parallel workers would each be given the same headroom.
   * Zero means the worker should not start.
   */
  workerSpendCapUsd(worstCaseRequestUsd: number, phase: BudgetPhase = 'work', committedUsd = 0): number {
    if (!isAmount(worstCaseRequestUsd)) throw new OrbitError('SCHEMA_INVALID', 'worstCaseRequestUsd must be a non-negative number');
    if (!isAmount(committedUsd)) throw new OrbitError('SCHEMA_INVALID', 'committedUsd must be a non-negative number');
    const cost = this.state('cost_usd');
    const limit = phase === 'final' ? cost.hard_cap : cost.hard_cap - this.reserve().cost_usd;
    return Math.max(0, roundUsd(limit - cost.used - committedUsd - worstCaseRequestUsd));
  }

  /** Whether spend is measured, estimated or unmeasured, with the wording the final report uses. */
  costMeasurement(): CostMeasurement {
    const { runId } = this.bound();
    const counts = { reported: 0, estimated: 0, unavailable: 0 };
    for (const r of this.db.all<{ src: string; n: number }>(
      "SELECT CASE WHEN cost_usd IS NULL THEN 'unavailable' ELSE cost_source END AS src, COUNT(*) AS n FROM usage WHERE run_id = ? GROUP BY src",
      runId,
    )) {
      if (r.src === 'reported' || r.src === 'estimated') counts[r.src] += r.n;
      else counts.unavailable += r.n;
    }
    // A session charged from its tokens (no cost reported, none in the usage row) is an estimate, not unmeasured.
    const tokenEstimated = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND type = 'budget.cost-token-estimated'", runId)?.n ?? 0;
    const moved = Math.min(tokenEstimated, counts.unavailable);
    counts.unavailable -= moved;
    counts.estimated += moved;
    let charged = 0;
    let charges = 0;
    for (const e of this.db.all<{ data_json: string | null }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'budget.cost-ceiling-charged'", runId)) {
      const data = e.data_json ? (JSON.parse(e.data_json) as { ceiling_usd?: number }) : {};
      charged += typeof data.ceiling_usd === 'number' ? data.ceiling_usd : 0;
      charges += 1;
    }
    const measured = counts.reported + counts.estimated;
    const unmeasured = counts.unavailable + charges;
    let state: CostMeasurement['state'];
    let note: string;
    const caveat = 'admission control charges conservative per-role ceilings instead, so the cost cap bounds spend but is not an exact spend guarantee';
    if (measured === 0 && unmeasured === 0) {
      state = 'no_usage';
      note = 'no usage recorded yet';
    } else if (measured === 0) {
      state = 'unmeasured';
      note = `spend is unmeasured: no provider reported cost and none could be estimated; ${caveat}`;
    } else if (unmeasured > 0) {
      state = 'partially_unmeasured';
      note = `spend is partly unmeasured (${counts.unavailable} usage record(s) without cost, ${charges} ceiling charge(s)); ${caveat}`;
    } else if (counts.estimated > 0) {
      state = 'estimated';
      note = `spend includes ${counts.estimated} estimate(s) priced from tokens and list pricing`;
    } else {
      state = 'measured';
      note = 'spend reported by providers';
    }
    return {
      state,
      reported_records: counts.reported,
      estimated_records: counts.estimated,
      unavailable_records: counts.unavailable,
      ceiling_charged_usd: roundUsd(charged),
      ceiling_charges: charges,
      note,
    };
  }

  /**
   * Spec section 7 adaptive extension. Granted only with measurable progress
   * not already credited to an earlier extension of the same counter, a
   * materially new hypothesis, authorized scope, room under the hard cap (and,
   * for CI repair, under delivery.max_ci_repair_cycles) and the closing
   * reserve preserved. Every request is recorded, granted or not.
   */
  requestExtension(req: ExtensionRequest): ExtensionDecision {
    const { runId, policy } = this.bound();
    if (!(DISCRETE_COUNTERS as readonly string[]).includes(req.counter)) {
      throw new OrbitError('SCHEMA_INVALID', `allowance extensions apply to discrete counters only, not ${String(req.counter)}`);
    }
    const ext = policy.scheduler.extension;
    const step = ext.attempts_per_extension;
    if (!Number.isInteger(step) || step < 1) throw new OrbitError('CONFIG_INVALID', 'scheduler.extension.attempts_per_extension must be a positive integer');
    const { kept, ignored, measurable } = filterProgress(req.progress, this.creditedProgress(runId, req.counter));
    const row = this.state(req.counter);
    // delivery.max_ci_repair_cycles is a configured limit of its own; an
    // adaptive extension may not carry CI repair past it.
    const ciMax = policy.delivery?.max_ci_repair_cycles;
    const configuredMax = req.counter === 'ci_repair_cycles' && isAmount(ciMax) && ciMax < row.hard_cap ? ciMax : null;
    const denied: string[] = [];
    const waived: string[] = [];
    if (req.failureRemains === false) denied.push('no specific failure remains');
    if (!measurable) {
      if (ext.require_measurable_progress) denied.push('no measurable progress (a newly supported criterion, fixed check, eliminated hypothesis, localized fault or resolved ambiguity)');
      else waived.push('measurable progress not required by policy');
    }
    if (!req.hypothesisIsNew) {
      if (ext.require_new_hypothesis) denied.push('no materially new, evidence-backed hypothesis');
      else waived.push('new hypothesis not required by policy');
    }
    if (!req.withinScope) denied.push('the next experiment is outside authorized scope');
    const newAllowance = row.allowance + step;
    const withinHardLimits = newAllowance <= (configuredMax ?? row.hard_cap) + EPS;
    if (!withinHardLimits) {
      denied.push(
        configuredMax !== null
          ? `a new allowance of ${newAllowance} would exceed delivery.max_ci_repair_cycles (${configuredMax})`
          : `a new allowance of ${newAllowance} would exceed the hard cap of ${row.hard_cap}`,
      );
    }
    const next = this.estimateNextAttempt(req);
    const reserve = this.reserve();
    const cost = this.state('cost_usd');
    const wall = this.state('wall_ms');
    const reservePreserved = cost.used + next.costUsd <= cost.hard_cap - reserve.cost_usd + EPS && wall.used + next.wallMs <= wall.hard_cap - reserve.wall_ms + EPS;
    if (!reservePreserved) {
      if (ext.preserve_final_verification_reserve) denied.push(`another attempt (about $${usd(next.costUsd)}, ${mins(next.wallMs)}) would eat into the final verification, review and reporting reserve`);
      else waived.push('reserve preservation not required by policy');
    }
    const granted = denied.length === 0;
    const progressText = Object.keys(kept).join(', ');
    const decision: ExtensionDecision = {
      decision: granted ? (req.counter === 'implementation_attempts' ? 'extend_attempt_allowance' : 'extend_allowance') : 'deny_extension',
      counter: req.counter,
      previous_allowance: row.allowance,
      new_allowance: granted ? newAllowance : row.allowance,
      hard_cap: row.hard_cap,
      reason: granted
        ? [req.reason ?? `measurable progress (${progressText || 'none required'}) with a new hypothesis inside scope`, ...waived].join('; ')
        : `denied: ${denied.join('; ')}`,
      progress: kept,
      ignored_progress: ignored,
      hypothesis_is_new: req.hypothesisIsNew,
      within_scope: req.withinScope,
      next_experiment: req.nextExperiment ?? null,
      within_hard_limits: withinHardLimits,
      reserve_preserved: reservePreserved,
      denied_because: denied,
    };
    const now = this.clock.now();
    this.db.tx(() => {
      if (granted) {
        const res = this.db.run('UPDATE budget_counters SET allowance = ? WHERE run_id = ? AND counter = ? AND allowance = ?', newAllowance, runId, req.counter, row.allowance);
        if (res.changes !== 1) throw new OrbitError('CONCURRENT_UPDATE', `${req.counter} allowance changed while the extension was decided`);
      }
      this.event(runId, granted ? 'budget.extension' : 'budget.extension-denied', decision, now);
    });
    return decision;
  }

  // -------------------------------------------------------------------------

  private consumeDiscrete(counter: DiscreteCounter, amount: number): CounterState {
    const { runId } = this.bound();
    const now = this.clock.now();
    const out = this.db.tx(() => {
      const row = this.row(runId, counter);
      if (row.used + amount > row.allowance + EPS) {
        const limit: 'allowance' | 'hard_cap' = row.allowance < row.hard_cap ? 'allowance' : 'hard_cap';
        this.event(runId, 'budget.exhausted', { counter, used: row.used, requested: amount, allowance: row.allowance, hard_cap: row.hard_cap, limit }, now);
        return { refused: true as const, row, limit };
      }
      this.db.run('UPDATE budget_counters SET used = used + ? WHERE run_id = ? AND counter = ?', amount, runId, counter);
      return { refused: false as const, row: this.row(runId, counter) };
    });
    if (out.refused) throw exhausted(counter, out.row, amount, out.limit, 'work');
    return toState(out.row);
  }

  private consumeSession(amount: number, sessionId: string | undefined): CounterState {
    const { runId } = this.bound();
    if (!sessionId) throw new OrbitError('SCHEMA_INVALID', `${SESSION_COUNTER} is capped per session; pass sessionId`);
    const key = `${SESSION_COUNTER}:${sessionId}`;
    const now = this.clock.now();
    const out = this.db.tx(() => {
      const base = this.row(runId, SESSION_COUNTER);
      let row = this.db.get<CounterRow>('SELECT counter, used, allowance, hard_cap FROM budget_counters WHERE run_id = ? AND counter = ?', runId, key);
      if (!row) {
        this.db.run('INSERT INTO budget_counters (run_id, counter, used, allowance, hard_cap) VALUES (?, ?, 0, ?, ?)', runId, key, base.hard_cap, base.hard_cap);
        row = { counter: key, used: 0, allowance: base.hard_cap, hard_cap: base.hard_cap };
      }
      if (row.used + amount > row.hard_cap + EPS) {
        this.event(runId, 'budget.exhausted', { counter: SESSION_COUNTER, session: sessionId, used: row.used, requested: amount, hard_cap: row.hard_cap, limit: 'hard_cap' }, now);
        return { refused: true as const, row };
      }
      this.db.run('UPDATE budget_counters SET used = used + ? WHERE run_id = ? AND counter = ?', amount, runId, key);
      // The base row reports the busiest session, so the snapshot shows how close any session came.
      this.db.run('UPDATE budget_counters SET used = MAX(used, ?) WHERE run_id = ? AND counter = ?', row.used + amount, runId, SESSION_COUNTER);
      return { refused: false as const, row: this.row(runId, key) };
    });
    if (out.refused) throw exhausted(`${SESSION_COUNTER}:${sessionId}`, out.row, amount, 'hard_cap', 'work');
    return toState(out.row);
  }

  private consumeMeasured(counter: MeasuredCounter, amount: number, phase: BudgetPhase, extra?: { type: string; data: unknown }): { state: CounterState } {
    const { runId } = this.bound();
    const reserve = this.reserve();
    const held = counter === 'cost_usd' ? reserve.cost_usd : reserve.wall_ms;
    const now = this.clock.now();
    const out = this.db.tx(() => {
      this.db.run('UPDATE budget_counters SET used = used + ? WHERE run_id = ? AND counter = ?', amount, runId, counter);
      if (extra) this.event(runId, extra.type, extra.data, now);
      const row = this.row(runId, counter);
      const hardHit = row.used >= row.hard_cap - EPS;
      const reserveHit = phase === 'work' && row.used >= row.hard_cap - held - EPS;
      const limit = hardHit ? ('hard_cap' as const) : reserveHit ? ('reserve' as const) : null;
      if (limit) this.event(runId, 'budget.exhausted', { counter, used: row.used, recorded: amount, hard_cap: row.hard_cap, reserve: held, phase, limit }, now);
      return { row, limit };
    });
    if (out.limit) throw exhausted(counter, out.row, amount, out.limit, phase);
    return { state: toState(out.row) };
  }

  private estimateNextAttempt(req: ExtensionRequest): { costUsd: number; wallMs: number } {
    const role = req.role ?? 'implementer';
    const attempts = this.state('implementation_attempts').used;
    const measured = ['measured', 'estimated'].includes(this.costMeasurement().state);
    const costUsd = isAmount(req.estimatedCostUsd)
      ? (req.estimatedCostUsd as number)
      : attempts > 0 && measured
        ? this.state('cost_usd').used / attempts
        : this.costCeiling(role);
    const wallMs = isAmount(req.estimatedWallMs) ? (req.estimatedWallMs as number) : attempts > 0 ? this.state('wall_ms').used / attempts : this.wallCeiling(role);
    return { costUsd, wallMs };
  }

  /**
   * Progress items already credited to a granted extension of this counter.
   * "Newly supported" means new since the last extension: progress that has
   * bought an extension once cannot buy another, so a loop that re-reports
   * the same finding stops instead of ratcheting the allowance to the cap.
   */
  private creditedProgress(runId: string, counter: DiscreteCounter): Set<string> {
    const credited = new Set<string>();
    for (const e of this.db.all<{ data_json: string | null }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'budget.extension' ORDER BY id", runId)) {
      const d = e.data_json ? (JSON.parse(e.data_json) as Partial<ExtensionDecision>) : {};
      if (d.counter !== counter || !d.progress) continue;
      for (const [kind, value] of Object.entries(d.progress)) {
        for (const item of Array.isArray(value) ? value : [value]) if (typeof item === 'string') credited.add(progressKey(kind, item));
      }
    }
    return credited;
  }

  private committedCost(c: CommittedWork): number {
    if (isAmount(c.estimatedCostUsd)) return c.estimatedCostUsd;
    // A check runs no model; every other unit is charged as if expensive.
    return c.role === 'check' ? 0 : this.costCeiling(c.role ?? 'implementer');
  }

  /**
   * What a session of `role` with no measured cost is presumed to cost: the role's ceiling, but never more than
   * half the whole cost cap (and never less than MIN_SESSION_CEILING_USD), so a small cap can still admit work.
   */
  roleCostCeiling(role: BudgetRole): number {
    return this.costCeiling(role);
  }

  private costCeiling(role: BudgetRole): number {
    const v = this.ceilings.costUsd[role];
    if (v === undefined) throw new OrbitError('SCHEMA_INVALID', `no cost ceiling for role ${String(role)}`);
    const cap = this.state('cost_usd').hard_cap;
    return Math.min(v, Math.max(MIN_SESSION_CEILING_USD, roundUsd(cap * MAX_CEILING_FRACTION_OF_CAP)));
  }

  private wallCeiling(role: BudgetRole): number {
    const v = this.ceilings.wallMs[role];
    if (v === undefined) throw new OrbitError('SCHEMA_INVALID', `no wall-time ceiling for role ${String(role)}`);
    return v;
  }

  private bound(): { runId: string; policy: BudgetPolicy } {
    if (this.runId === null || this.policy === null) throw new OrbitError('INTERNAL', 'BudgetLedger is not bound to a run; call init or attach first');
    return { runId: this.runId, policy: this.policy };
  }

  private row(runId: string, counter: string): CounterRow {
    const row = this.db.get<CounterRow>('SELECT counter, used, allowance, hard_cap FROM budget_counters WHERE run_id = ? AND counter = ?', runId, counter);
    if (!row) throw new OrbitError('NOT_FOUND', `run ${runId} has no budget counter ${counter}`);
    return row;
  }

  /** Budget changes are recorded as events (spec section 16); this module may not import the controller. */
  private event(runId: string, type: string, data: unknown, ts: number): void {
    this.db.run('INSERT INTO events (run_id, ts, type, from_state, to_state, actor, data_json) VALUES (?, ?, ?, NULL, NULL, ?, ?)', runId, ts, type, 'budget', JSON.stringify(data));
  }
}

/** The decisions-table shape for an extension request, granted or denied. */
export function extensionDecisionRecord(d: ExtensionDecision): { kind: string; summary: string; data: ExtensionDecision } {
  const granted = d.decision !== 'deny_extension';
  return {
    kind: granted ? 'allowance.extend' : 'allowance.deny',
    summary: granted ? `${d.counter} allowance ${d.previous_allowance} -> ${d.new_allowance}` : `${d.counter} extension denied at ${d.previous_allowance}`,
    data: d,
  };
}

function capsFrom(policy: BudgetPolicy): Record<BudgetCounter, number> {
  const hl = policy.scheduler?.hard_limits;
  if (!hl) throw new OrbitError('CONFIG_INVALID', 'scheduler.hard_limits is missing');
  const caps: Record<BudgetCounter, number> = {
    implementation_attempts: hl.implementation_attempts,
    diagnostic_experiments: hl.diagnostic_experiments,
    review_rounds: hl.review_rounds,
    ci_repair_cycles: hl.ci_repair_cycles,
    infrastructure_retries: hl.infrastructure_retries,
    recovery_attempts: hl.recovery_attempts,
    worker_turns_per_session: hl.worker_turns_per_session,
    wall_ms: hl.wall_minutes * 60_000,
    cost_usd: hl.model_cost_usd,
  };
  for (const [name, v] of Object.entries(caps)) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new OrbitError('CONFIG_INVALID', `scheduler.hard_limits for ${name} must be a non-negative number`);
  }
  return caps;
}

function allowancesFrom(policy: BudgetPolicy, caps: Record<BudgetCounter, number>, cls: DifficultyClass): Record<BudgetCounter, { allowance: number; reason: string }> {
  if (!['simple', 'medium', 'complex'].includes(cls)) throw new OrbitError('SCHEMA_INVALID', `unknown difficulty class ${String(cls)}`);
  const initial = policy.scheduler.initial_allowances?.[`${cls}_attempts`];
  if (typeof initial !== 'number' || !Number.isInteger(initial) || initial < 1) throw new OrbitError('CONFIG_INVALID', `scheduler.initial_allowances.${cls}_attempts must be a positive integer`);
  const attempts = Math.min(initial, caps.implementation_attempts);
  const experiments = Math.min(caps.diagnostic_experiments, attempts * EXPERIMENTS_PER_ATTEMPT);
  const ciMax = policy.delivery?.max_ci_repair_cycles;
  const ci = typeof ciMax === 'number' && Number.isFinite(ciMax) && ciMax >= 0 ? Math.min(ciMax, caps.ci_repair_cycles) : caps.ci_repair_cycles;
  const atCap = (c: BudgetCounter, why: string) => ({ allowance: caps[c], reason: why });
  return {
    implementation_attempts: {
      allowance: attempts,
      reason: `${cls} difficulty starts with ${initial} attempt(s)${attempts < initial ? `, clamped to the hard cap of ${caps.implementation_attempts}` : ''}`,
    },
    diagnostic_experiments: { allowance: experiments, reason: `${EXPERIMENTS_PER_ATTEMPT} experiments per allowed attempt, within the hard cap of ${caps.diagnostic_experiments}` },
    review_rounds: atCap('review_rounds', 'not adaptive; bounded by the hard cap'),
    ci_repair_cycles: { allowance: ci, reason: ci < caps.ci_repair_cycles ? `delivery.max_ci_repair_cycles is ${ci}` : 'bounded by the hard cap' },
    infrastructure_retries: atCap('infrastructure_retries', 'not adaptive; bounded by the hard cap; does not consume implementation attempts'),
    recovery_attempts: atCap('recovery_attempts', 'not adaptive; bounded by the hard cap'),
    worker_turns_per_session: atCap('worker_turns_per_session', 'cap applies to each worker session separately'),
    wall_ms: atCap('wall_ms', 'hard cap; ordinary work stops at the cap less the closing reserve'),
    cost_usd: atCap('cost_usd', 'hard cap; ordinary work stops at the cap less the closing reserve'),
  };
}

function reserveFrom(policy: BudgetPolicy, caps: Record<BudgetCounter, number>): ReserveState {
  const fraction = policy.scheduler.final_reserve_fraction;
  if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction < 0 || fraction >= 1) {
    throw new OrbitError('CONFIG_INVALID', 'scheduler.final_reserve_fraction must be a number in [0, 1)');
  }
  return {
    fraction,
    cost_usd: roundUsd(caps.cost_usd * fraction),
    wall_ms: Math.round(caps.wall_ms * fraction),
    shares: { ...RESERVE_SHARES },
  };
}

function verifyCaps(runId: string, rows: CounterRow[], caps: Record<BudgetCounter, number>): void {
  for (const c of BUDGET_COUNTERS) {
    const row = rows.find((r) => r.counter === c);
    if (!row) throw new OrbitError('INTERNAL', `run ${runId} is missing budget counter ${c}`);
    if (Math.abs(row.hard_cap - caps[c]) > EPS) {
      throw new OrbitError('POLICY_TAMPERED', `run ${runId}: hard cap for ${c} is ${row.hard_cap} but the snapshot says ${caps[c]}; hard caps never change during a run`, {
        counter: c,
        stored: row.hard_cap,
        snapshot: caps[c],
      });
    }
  }
}

function filterProgress(progress: ProgressReport, credited: ReadonlySet<string>): { kept: ProgressReport; ignored: string[]; measurable: boolean } {
  const kept: ProgressReport = {};
  const ignored: string[] = [];
  const fresh = (key: string, item: string): boolean => {
    if (!credited.has(progressKey(key, item))) return true;
    ignored.push(`${key}: ${item} was already credited to an earlier extension`);
    return false;
  };
  for (const [key, value] of Object.entries(progress ?? {})) {
    if (!(PROGRESS_KINDS as readonly string[]).includes(key)) {
      ignored.push(`${key}: not a progress kind; more tokens or a larger diff are not progress`);
      continue;
    }
    if (key === 'localized_fault') {
      if (typeof value === 'string' && value.trim() && fresh(key, value.trim())) kept.localized_fault = value.trim();
      continue;
    }
    const items = Array.isArray(value)
      ? [...new Set(value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim()))].filter((v) => fresh(key, v))
      : [];
    if (items.length) kept[key] = items;
  }
  return { kept, ignored, measurable: Object.keys(kept).length > 0 };
}

function progressKey(kind: string, item: string): string {
  return `${kind}\u0000${item.trim()}`;
}

function exhausted(counter: string, row: CounterRow, amount: number, limit: 'allowance' | 'hard_cap' | 'reserve', phase: BudgetPhase): OrbitError {
  // Dollars are summed floats; the message shows cents (the data keeps the exact values).
  const v = (n: number): string => (counter === 'cost_usd' ? `$${usd(n)}` : String(n));
  const what = limit === 'allowance' ? `allowance ${v(row.allowance)} (hard cap ${v(row.hard_cap)})` : limit === 'reserve' ? `hard cap ${v(row.hard_cap)} less the closing reserve` : `hard cap ${v(row.hard_cap)}`;
  return new OrbitError('BUDGET_EXHAUSTED', `${counter} exhausted at the ${what}: used ${v(row.used)}, requested ${v(amount)}`, {
    counter,
    used: row.used,
    requested: amount,
    allowance: row.allowance,
    hard_cap: row.hard_cap,
    limit,
    phase,
    // Only an allowance below its hard cap can be extended; caps and the reserve cannot.
    extendable: limit === 'allowance',
  });
}

function toState(r: CounterRow): CounterState {
  return { counter: r.counter, used: r.used, allowance: r.allowance, hard_cap: r.hard_cap, remaining: r.allowance - r.used };
}

function assertCounter(counter: string): void {
  if (!(BUDGET_COUNTERS as readonly string[]).includes(counter)) throw new OrbitError('SCHEMA_INVALID', `unknown budget counter ${counter}`);
}

function isAmount(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function roundUsd(v: number): number {
  return Math.round(v * 1_000_000) / 1_000_000;
}

function usd(v: number): string {
  return v.toFixed(2);
}

function mins(ms: number): string {
  return `${Math.round((ms / 60_000) * 10) / 10} min`;
}
