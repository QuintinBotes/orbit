import type { OrbitDb } from '../storage/db.ts';
import type { Clock } from '../core/clock.ts';
import { OrbitError, isOrbitError } from '../core/errors.ts';
import { appendEvent } from '../storage/events.ts';
import { transition, getRun, type RunRecord } from '../controller/run-store.ts';
import type { RunState } from '../core/run-states.ts';

/**
 * Recovery has a budget (spec section 14: "Recovery itself has a budget",
 * section 6: "No unlimited recovery"). Every crash recovery, every restart of
 * a lost worker and every abandoned step spends one `recovery_attempts`.
 * When the run's counters exist the spend goes through them; before the
 * budget is initialized (a crash during PREFLIGHT, say) a count of recorded
 * attempts bounds it instead, so a crash loop in the earliest states still
 * ends.
 */

/** Matches BudgetLedger.consume, which satisfies it structurally. */
export interface RecoveryLedger {
  consume(counter: 'recovery_attempts', amount: number): unknown;
}

/** The controller's way of handing recovery the run's bound ledger; null when none is available. */
export type LedgerFor = (runId: string) => RecoveryLedger | null;

/** Same as the policy default for scheduler.hard_limits.recovery_attempts. */
export const DEFAULT_FALLBACK_RECOVERIES = 3;
const EPS = 1e-9;

export const RECOVERY_ATTEMPT_EVENT = 'recovery.attempt';

export interface SpendOptions {
  ledgerFor?: LedgerFor | undefined;
  /** Bound used while the run has no budget counters. */
  fallbackMax?: number | undefined;
  actor: string;
  why: string;
}

/**
 * Spend one recovery attempt or throw BUDGET_EXHAUSTED. Call it inside the
 * transaction that performs the recovery step, so a refused spend leaves no
 * half-done change and an accepted one is recorded with the change.
 */
export function spendRecoveryAttempt(db: OrbitDb, runId: string, clock: Clock, opts: SpendOptions): void {
  const now = clock.now();
  // The refusal is returned out of the transaction and thrown after it commits: thrown inside, it would roll back its own audit event.
  const refusal = db.tx((): OrbitError | null => {
    const ledger = opts.ledgerFor?.(runId) ?? null;
    if (ledger) {
      try {
        ledger.consume('recovery_attempts', 1);
      } catch (err) {
        if (isOrbitError(err, 'BUDGET_EXHAUSTED')) return err;
        throw err;
      }
    } else {
      const row = db.get<{ used: number; allowance: number; hard_cap: number }>("SELECT used, allowance, hard_cap FROM budget_counters WHERE run_id = ? AND counter = 'recovery_attempts'", runId);
      let used: number;
      let allowance: number;
      let hardCap: number;
      if (row) {
        ({ used, allowance, hard_cap: hardCap } = row);
      } else {
        used = Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND type = ?', runId, RECOVERY_ATTEMPT_EVENT)?.n ?? 0);
        allowance = hardCap = opts.fallbackMax ?? DEFAULT_FALLBACK_RECOVERIES;
      }
      if (used + 1 > allowance + EPS) {
        appendEvent(db, runId, 'budget.exhausted', opts.actor, { counter: 'recovery_attempts', used, requested: 1, allowance, hard_cap: hardCap, limit: 'hard_cap', ...(row ? {} : { counted_from: 'events' }) }, now);
        return new OrbitError('BUDGET_EXHAUSTED', `recovery_attempts exhausted at ${allowance}: used ${used}, requested 1`, { counter: 'recovery_attempts', used, allowance, hard_cap: hardCap, limit: 'hard_cap', extendable: false });
      }
      if (row) db.run("UPDATE budget_counters SET used = used + 1 WHERE run_id = ? AND counter = 'recovery_attempts'", runId);
    }
    // The audit trail and the fallback counter in one: one row per spent attempt.
    appendEvent(db, runId, RECOVERY_ATTEMPT_EVENT, opts.actor, { why: opts.why }, now);
    return null;
  });
  if (refusal) throw refusal;
}

export type EnterRecoveryOutcome =
  /** The run is now RECOVERING; its resume_state names the stage to return to. */
  | { outcome: 'recovering'; run: RunRecord }
  /** The run was already RECOVERING (a crash during recovery); the attempt was still spent. */
  | { outcome: 'already-recovering'; run: RunRecord }
  /** The recovery budget is spent; the run was moved to EXHAUSTED. */
  | { outcome: 'exhausted'; run: RunRecord; error: OrbitError }
  /** A durable cancellation request wins: only CANCELLED is reachable, so nothing was changed. */
  | { outcome: 'cancel-pending'; run: RunRecord }
  /** The run is terminal, new, or otherwise has nothing to recover. */
  | { outcome: 'not-applicable'; run: RunRecord };

/**
 * Working stages a crash can interrupt. CREATED has made no progress to
 * recover. INQUISITION is left out on purpose: a run there waits on a
 * question, and RECOVERING would resume the stage before it (transition()
 * keeps the pre-inquisition resume_state), acting on an unresolved question.
 * A controller restart while a person takes their time must also never spend
 * recovery budget. The controller resumes INQUISITION from its durable ledger.
 */
const RECOVERABLE: ReadonlySet<RunState> = new Set(['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'DELIVERING', 'AWAITING_CI', 'DIAGNOSING', 'REPAIRING', 'RECOVERING']);

export interface EnterRecoveryInput {
  runId: string;
  /** The lease holder; transition() refuses anyone else. */
  ownerId: string;
  reason: string;
  data?: unknown;
  ledgerFor?: LedgerFor | undefined;
  fallbackMax?: number | undefined;
}

/**
 * Spend one recovery attempt and move the run to RECOVERING in one
 * transaction (transition() records the stage to resume as `resume_state`).
 * With the budget spent the run goes to EXHAUSTED instead, because a crash
 * loop must end.
 */
export function enterRecovery(db: OrbitDb, clock: Clock, input: EnterRecoveryInput): EnterRecoveryOutcome {
  const actor = input.ownerId;
  const spend: SpendOptions = { ledgerFor: input.ledgerFor, fallbackMax: input.fallbackMax, actor, why: input.reason };
  try {
    return db.tx(() => {
      const run = getRun(db, input.runId);
      if (!RECOVERABLE.has(run.state)) return { outcome: 'not-applicable', run } as const;
      if (run.cancelRequested) return { outcome: 'cancel-pending', run } as const;
      spendRecoveryAttempt(db, run.id, clock, spend);
      if (run.state === 'RECOVERING') return { outcome: 'already-recovering', run } as const;
      const next = transition(db, { runId: run.id, to: 'RECOVERING', ownerId: input.ownerId, reason: input.reason, actor, expectedFrom: run.state, ...(input.data === undefined ? {} : { data: input.data }) }, clock);
      return { outcome: 'recovering', run: next } as const;
    });
  } catch (err) {
    if (!isOrbitError(err, 'BUDGET_EXHAUSTED')) throw err;
    // The refusal rolled back with the transaction, event included, so the refusal and the end of the run are recorded afresh.
    const run = getRun(db, input.runId);
    if (!RECOVERABLE.has(run.state) || run.cancelRequested) return { outcome: 'not-applicable', run };
    appendEvent(db, run.id, 'budget.exhausted', actor, { ...err.details }, clock.now());
    const ended = transition(
      db,
      {
        runId: run.id,
        to: 'EXHAUSTED',
        ownerId: input.ownerId,
        reason: `recovery budget exhausted: ${err.message}`,
        actor,
        expectedFrom: run.state,
        data: { counter: 'recovery_attempts', trigger: input.reason },
        patch: { outcomeReason: `recovery budget exhausted after repeated failures (${input.reason})` },
      },
      clock,
    );
    return { outcome: 'exhausted', run: ended, error: err };
  }
}
