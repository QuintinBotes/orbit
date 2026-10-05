/**
 * A worker result a step can use, with bounded regeneration. Attempts are
 * numbered purposes (`plan#1`, `plan#2`), so each one keeps its own worker
 * row and directory, a restart resumes the newest, and the bound is counted
 * from durable rows rather than from memory.
 */
import { isOrbitError } from '../../core/errors.ts';
import type { TaskResult } from '../../adapters/types.ts';
import type { WorkerRecord } from '../../storage/workers.ts';
import type { RunContext } from '../context.ts';
import { ensureWorker, type WorkerRequest } from '../workers.ts';
import { handleWorkerFailure, WAIT, type StepResult } from './common.ts';

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

export async function obtain<T>(ctx: RunContext, opts: ObtainOptions<T>): Promise<Obtained<T>> {
  let n = Math.max(1, latestAttempt(ctx, opts.base));
  for (;;) {
    const purpose = `${opts.base}#${n}`;
    const fresh = ctx.db.get('SELECT 1 AS x FROM workers WHERE run_id = ? AND purpose = ?', ctx.run.id, purpose) === undefined;
    if (fresh) opts.beforeStart?.(n);
    const st = await ensureWorker(ctx, opts.request(purpose, n));
    if (st.status === 'running') return { ok: false, step: WAIT(`${opts.what} (${st.worker.id}) is running`) };
    const r = st.result;
    let failure: { status: string; error: string | null } | null = null;
    if (r.status === 'succeeded') {
      try {
        return { ok: true, value: opts.accept(r, st.worker), worker: st.worker, attempt: n };
      } catch (err) {
        if (!isOrbitError(err, 'MALFORMED_OUTPUT') && !isOrbitError(err, 'SCHEMA_INVALID')) throw err;
        failure = { status: 'malformed_output', error: err.message };
      }
    } else failure = { status: r.status, error: r.error };
    const h = await handleWorkerFailure(ctx, { provider: st.worker.provider, ...failure }, { attemptsUsed: n, maxAttempts: opts.maxAttempts, what: opts.what, ...(opts.exhausted ? { exhausted: opts.exhausted } : {}) });
    if (!h.retry) return { ok: false, step: h.result };
    n++;
  }
}
