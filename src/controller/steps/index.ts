/**
 * One step for one run: load the context from durable state, dispatch on
 * the run's state, and turn errors into outcomes. A step that fails for an
 * infrastructure reason is retried on the next tick, a bounded number of
 * times (infrastructure_retries, counted from events), and then the run
 * blocks with the error rather than looping forever.
 */
import { OrbitError, isOrbitError } from '../../core/errors.ts';
import { redact } from '../../core/redact.ts';
import { appendEvent } from '../../storage/events.ts';
import { lenientContext, loadRunContext, type ControllerDeps, type RunContext } from '../context.ts';
import { isTerminal, type RunState } from '../states.ts';
import { getRun } from '../run-store.ts';
import { finalizeRun } from '../report.ts';
import { finishRun, outcomeForError, type StepResult } from './common.ts';
import { awaitingCiStep } from './awaiting-ci.ts';
import { contractingStep } from './contracting.ts';
import { deliveringStep } from './delivering.ts';
import { diagnosingStep } from './diagnosing.ts';
import { implementingStep } from './implementing.ts';
import { inquisitionStep } from './inquisition.ts';
import { planningStep } from './planning.ts';
import { preflightStep } from './preflight.ts';
import { createdStep, recoveringStep } from './recovering.ts';
import { reviewingStep } from './reviewing.ts';
import { verifyingStep } from './verifying.ts';

export type StepFn = (ctx: RunContext) => Promise<StepResult>;

export const STEPS: Readonly<Partial<Record<RunState, StepFn>>> = {
  CREATED: createdStep,
  PREFLIGHT: preflightStep,
  CONTRACTING: contractingStep,
  PLANNING: planningStep,
  IMPLEMENTING: implementingStep,
  REPAIRING: implementingStep,
  VERIFYING: verifyingStep,
  DIAGNOSING: diagnosingStep,
  REVIEWING: reviewingStep,
  DELIVERING: deliveringStep,
  AWAITING_CI: awaitingCiStep,
  INQUISITION: inquisitionStep,
  RECOVERING: recoveringStep,
};

/** Consecutive failed steps in one state tolerated before the run blocks, when the budget has no counter yet. */
const DEFAULT_STEP_ERRORS = 5;
export const STEP_ERROR_EVENT = 'step.error';

export async function step(deps: ControllerDeps, runId: string, signal: AbortSignal): Promise<StepResult> {
  let ctx: RunContext;
  try {
    ctx = loadRunContext(deps, runId, signal);
  } catch (err) {
    return loadFailure(deps, runId, signal, err);
  }
  if (isTerminal(ctx.run.state)) return { progressed: false, done: true };
  const fn = STEPS[ctx.run.state];
  if (!fn) throw new OrbitError('INTERNAL', `no step for state ${ctx.run.state}`);
  try {
    return await fn(ctx);
  } catch (err) {
    if (signal.aborted || isOrbitError(err, 'LEASE_LOST')) throw err;
    // A cancellation that landed mid-step: the next safe point turns it into CANCELLED.
    if (isOrbitError(err, 'CANCELLED') || isOrbitError(err, 'CONCURRENT_UPDATE')) return { progressed: false, waiting: (err as Error).message };
    ctx.refresh();
    if (isTerminal(ctx.run.state)) return { progressed: false, done: true };
    const mapped = await outcomeForError(ctx, err);
    if (mapped) return mapped;
    return retryOrBlock(ctx, err);
  }
}

/** A policy snapshot or contract that no longer verifies cannot authorize anything: the run blocks. */
async function loadFailure(deps: ControllerDeps, runId: string, signal: AbortSignal, err: unknown): Promise<StepResult> {
  if (!isOrbitError(err, 'POLICY_TAMPERED') && !isOrbitError(err, 'CONTRACT_INVALID')) throw err;
  if (isTerminal(getRun(deps.db, runId).state)) return { progressed: false, done: true };
  // Enough to stop workers and record the outcome; nothing read here grants authority.
  const ctx = lenientContext(deps, runId, signal);
  return finishRun(ctx, 'BLOCKED', `${err.code}: ${err.message}`);
}

async function retryOrBlock(ctx: RunContext, err: unknown): Promise<StepResult> {
  const message = redact(err instanceof Error ? err.message : String(err)).slice(0, 1000);
  const code = isOrbitError(err) ? err.code : 'INTERNAL';
  const since = ctx.db.get<{ id: number | null }>("SELECT MAX(id) AS id FROM events WHERE run_id = ? AND type = 'state.transition'", ctx.run.id)?.id ?? 0;
  const prior = Number(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND type = ? AND id > ?', ctx.run.id, STEP_ERROR_EVENT, since)?.n ?? 0);
  ctx.db.tx(() => appendEvent(ctx.db, ctx.run.id, STEP_ERROR_EVENT, ctx.ownerId, { state: ctx.run.state, code, message }, ctx.clock.now()));
  ctx.log.warn('step failed', { state: ctx.run.state, code, error: message });
  let limit = DEFAULT_STEP_ERRORS;
  if (ctx.ledger) {
    try {
      ctx.ledger.consume('infrastructure_retries', 1);
      return { progressed: false, waiting: `step failed (${code}); retrying: ${message}` };
    } catch (e) {
      if (!isOrbitError(e, 'BUDGET_EXHAUSTED')) throw e;
      limit = 0;
    }
  }
  if (prior + 1 >= limit) return finishRun(ctx, 'BLOCKED', `${ctx.run.state} failed ${prior + 1} time(s); last error ${code}: ${message}`, { data: { code } });
  return { progressed: false, waiting: `step failed (${code}); retrying: ${message}` };
}

export { finalizeRun };
