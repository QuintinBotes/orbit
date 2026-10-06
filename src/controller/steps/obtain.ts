/**
 * A worker result a step can use, with bounded regeneration. Attempts are
 * numbered purposes (`plan#1`, `plan#2`), so each one keeps its own worker
 * row and directory, a restart resumes the newest, and the bound is counted
 * from durable rows rather than from memory.
 */
import { isOrbitError, type OrbitError } from '../../core/errors.ts';
import { appendEvent } from '../../storage/events.ts';
import { spendRecoveryAttempt } from '../../recovery/budget.ts';
import type { TaskResult } from '../../adapters/types.ts';
import type { WorkerRecord } from '../../storage/workers.ts';
import type { RunContext } from '../context.ts';
import { ensureWorker, type WorkerRequest } from '../workers.ts';
import { finishRun, handleWorkerFailure, retryWait, WAIT, type StepResult } from './common.ts';

export interface ObtainOptions<T> {
  base: string;
  maxAttempts: number;
  what: string;
  request: (purpose: string, attempt: number) => WorkerRequest;
  /** Turn a succeeded result into the value the step needs; throw MALFORMED_OUTPUT or SCHEMA_INVALID to regenerate. */
  accept: (result: TaskResult, worker: WorkerRecord) => T;
  /** Runs before a new attempt's worker is planned (budget counters are consumed here). */
  beforeStart?: (attempt: number) => void;
  exhausted?: () => Promise<StepResult>;
}

export type Obtained<T> = { ok: true; value: T; worker: WorkerRecord; attempt: number } | { ok: false; step: StepResult };

export function latestAttempt(ctx: RunContext, base: string): number {
  const prefix = `${base}#`;
  let n = 0;
  for (const row of ctx.db.all<{ purpose: string | null }>('SELECT purpose FROM workers WHERE run_id = ?', ctx.run.id)) {
    if (!row.purpose?.startsWith(prefix)) continue;
    const k = Number(row.purpose.slice(prefix.length));
    if (Number.isInteger(k) && k > n) n = k;
  }
  return n;
}

export const RESUME_RESET_EVENT = 'resume.reset';

export interface ResumeReset {
  base: string;
  what: string;
  /** The `run.resumed` event this reset answers; one reset per unit per resume. */
  resumed_event_id: number;
  /** The failed attempt the run blocked on. */
  after_attempt: number;
  /** The first attempt of the fresh series; attempts are counted against the bound from here. */
  next_attempt: number;
}

export type AttemptStart = { ok: true; n: number; first: number } | { ok: false; step: StepResult };

/**
 * Where a unit's attempts continue. Normally at the newest attempt, so a restart collects the worker it already has.
 * A run resumed from BLOCKED after a person fixed the cause (a login, a broken provider wrapper) must not replay the
 * stored failure it blocked on: when the newest attempt failed before the most recent `orbit resume`, a fresh series
 * starts at the next attempt number. That reset is recorded once per resume and spends one recovery attempt, so a
 * resume loop stays bounded by scheduler.hard_limits.recovery_attempts; with none left the run ends EXHAUSTED.
 */
export async function attemptStart(ctx: RunContext, base: string, what: string): Promise<AttemptStart> {
  const latest = latestAttempt(ctx, base);
  const resets = ctx.db
    .all<{ data_json: string | null }>("SELECT data_json FROM events WHERE run_id = ? AND type = ? AND json_extract(data_json, '$.base') = ? ORDER BY id", ctx.run.id, RESUME_RESET_EVENT, base)
    .map((r) => JSON.parse(r.data_json ?? '{}') as ResumeReset);
  let first = resets.at(-1)?.next_attempt ?? 1;
  const resumed = ctx.db.get<{ id: number | null }>("SELECT MAX(id) AS id FROM events WHERE run_id = ? AND type = 'run.resumed'", ctx.run.id)?.id ?? null;
  if (latest > 0 && latest >= first && resumed !== null && !resets.some((r) => r.resumed_event_id === resumed)) {
    const failed = ctx.db.get<{ id: string; state: string }>("SELECT id, state FROM workers WHERE run_id = ? AND purpose = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", ctx.run.id, `${base}#${latest}`);
    const planned = failed ? ctx.db.get<{ id: number }>("SELECT id FROM events WHERE run_id = ? AND type = 'worker.planned' AND json_extract(data_json, '$.worker_id') = ? ORDER BY id DESC LIMIT 1", ctx.run.id, failed.id) : undefined;
    const finishedUnusable = failed !== undefined && failed.state !== 'SUCCEEDED' && failed.state !== 'PLANNED' && failed.state !== 'RUNNING';
    if (finishedUnusable && planned !== undefined && planned.id < resumed) {
      const reset: ResumeReset = { base, what, resumed_event_id: resumed, after_attempt: latest, next_attempt: latest + 1 };
      try {
        ctx.db.tx(() => {
          spendRecoveryAttempt(ctx.db, ctx.run.id, ctx.clock, { ledgerFor: () => ctx.ledger, actor: ctx.ownerId, why: `resume after a block: fresh ${what} (attempt ${latest} failed before the resume)` });
          appendEvent(ctx.db, ctx.run.id, RESUME_RESET_EVENT, ctx.ownerId, reset, ctx.clock.now());
        });
      } catch (err) {
        if (!isOrbitError(err, 'BUDGET_EXHAUSTED')) throw err;
        return { ok: false, step: await finishRun(ctx, 'EXHAUSTED', `recovery_attempts exhausted: the run was resumed after ${what} failed (attempt ${latest}), and no recovery attempt is left to start it again (${err.message})`, { data: { counter: 'recovery_attempts' } }) };
      }
      first = reset.next_attempt;
    }
  }
  return { ok: true, n: Math.max(1, first, latest), first };
}

export async function obtain<T>(ctx: RunContext, opts: ObtainOptions<T>): Promise<Obtained<T>> {
  const start = await attemptStart(ctx, opts.base, opts.what);
  if (!start.ok) return start;
  const first = start.first;
  let n = start.n;
  for (;;) {
    const purpose = `${opts.base}#${n}`;
    const fresh = ctx.db.get('SELECT 1 AS x FROM workers WHERE run_id = ? AND purpose = ?', ctx.run.id, purpose) === undefined;
    if (fresh) {
      // A transient failure set a backoff: nothing new starts for this unit before it passes.
      const wait = retryWait(ctx, opts.base);
      if (wait) return { ok: false, step: wait };
    }
    if (fresh && opts.beforeStart) chargeOnce(ctx, purpose, () => opts.beforeStart!(n));
    const st = await ensureWorker(ctx, opts.request(purpose, n));
    if (st.status === 'running') return { ok: false, step: WAIT(`${opts.what} (${st.worker.id}) is running`) };
    const r = st.result;
    let failure: { status: string; error: string | null; reason?: string | null } | null = null;
    if (r.status === 'succeeded') {
      try {
        return { ok: true, value: opts.accept(r, st.worker), worker: st.worker, attempt: n };
      } catch (err) {
        if (!isOrbitError(err, 'MALFORMED_OUTPUT') && !isOrbitError(err, 'SCHEMA_INVALID')) throw err;
        failure = { status: 'malformed_output', error: err.message };
      }
    } else failure = { status: r.status, error: r.error, reason: r.reason ?? null };
    const h = await handleWorkerFailure(ctx, { provider: st.worker.provider, ...failure }, { attemptsUsed: n - first + 1, maxAttempts: opts.maxAttempts, what: opts.what, base: opts.base, purpose, ...(opts.exhausted ? { exhausted: opts.exhausted } : {}) });
    if (!h.retry) return { ok: false, step: h.result };
    n++;
  }
}

export const START_CHARGE_EVENT = 'worker.start-charged';

/**
 * The budget charge for starting a purpose's worker, made at most once. The charge comes before the worker
 * row exists (a refused charge must leave no intent behind), so a crash between the two would otherwise charge
 * the same start again on the next pass. The charge and its marker commit together, keyed by the purpose,
 * which names exactly one worker.
 */
export function chargeOnce(ctx: RunContext, purpose: string, charge: () => void): void {
  const refusal = ctx.db.tx((): OrbitError | null => {
    if (ctx.db.get("SELECT 1 AS x FROM events WHERE run_id = ? AND type = ? AND json_extract(data_json, '$.purpose') = ? LIMIT 1", ctx.run.id, START_CHARGE_EVENT, purpose)) return null;
    try {
      charge();
    } catch (err) {
      // Returned, not thrown: the ledger's own record of the refusal must commit.
      if (isOrbitError(err, 'BUDGET_EXHAUSTED')) return err;
      throw err;
    }
    appendEvent(ctx.db, ctx.run.id, START_CHARGE_EVENT, ctx.ownerId, { purpose }, ctx.clock.now());
    return null;
  });
  if (refusal) throw refusal;
}
