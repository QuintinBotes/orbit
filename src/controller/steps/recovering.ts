/**
 * RECOVERING: the previous owner died mid-step. recovery/reconcile has
 * already run for this run when the lease was taken (workers reattached or
 * collected, lost ones restarted within budget, orphans stopped, in-flight
 * external actions flagged), and spent one recovery attempt. What remains is
 * to resume the stage the crash interrupted; that stage's step is idempotent
 * and picks up from durable state.
 */
import type { RunContext } from '../context.ts';
import type { RunState } from '../states.ts';
import { move, safePoint, type StepResult } from './common.ts';

export async function recoveringStep(ctx: RunContext): Promise<StepResult> {
  const stop = await safePoint(ctx);
  if (stop) return stop;
  const target: RunState = ctx.run.resumeState ?? (ctx.candidate ? 'VERIFYING' : ctx.contract ? 'PLANNING' : 'PREFLIGHT');
  return move(ctx, target, `recovered after a controller crash; resuming ${target}`);
}

export async function createdStep(ctx: RunContext): Promise<StepResult> {
  const stop = await safePoint(ctx);
  if (stop) return stop;
  return move(ctx, 'PREFLIGHT', 'run started');
}
