/**
 * What every step shares: safe points (cancellation, pause, hard budget
 * caps), transitions through run-store with the lease and an optimistic
 * expectation, terminal outcomes that stop workers and always end in a
 * written report, and decisions recorded through storage/decisions.ts.
 */
import { OrbitError, isOrbitError } from '../../core/errors.ts';
import { appendEvent } from '../../storage/events.ts';
import { recordDecision, type DecisionRecord } from '../../storage/decisions.ts';
import { heartbeatController } from '../../storage/controllers.ts';
import { authBlocker, blockRunOnCredentials, type BlockedCredentialState } from '../../recovery/credentials.ts';
import type { RunContext } from '../context.ts';
import { isTerminal, type RunState } from '../states.ts';
import { markProgress, transition, type TransitionRequest } from '../run-store.ts';
import { stopActiveWorkers } from '../workers.ts';
import { finalizeRun } from '../report.ts';

export interface StepResult {
  /** The run changed state or recorded progress. */
  progressed: boolean;
  /** Waiting on something outside the controller (a worker, CI, a person). */
  waiting?: string;
  /** Nothing more to do for this run in this controller (terminal, paused, cancelled). */
  done?: boolean;
}

export const WAIT = (why: string): StepResult => ({ progressed: false, waiting: why });
export const MOVED: StepResult = { progressed: true };
export const DONE: StepResult = { progressed: true, done: true };

export interface MoveOptions {
  patch?: TransitionRequest['patch'];
  data?: unknown;
}

/** One transition, with the lease and an optimistic check that the run is still where this step found it. */
export function move(ctx: RunContext, to: RunState, reason: string, opts: MoveOptions = {}): StepResult {
  const from = ctx.run.state;
  ctx.run = transition(ctx.db, { runId: ctx.run.id, to, ownerId: ctx.ownerId, reason, actor: ctx.ownerId, expectedFrom: from, ...(opts.patch ? { patch: opts.patch } : {}), ...(opts.data === undefined ? {} : { data: opts.data }) }, ctx.clock);
  heartbeatController(ctx.db, ctx.ownerId, ctx.clock, { progress: true });
  ctx.log.info('transition', { from, to, reason: reason.slice(0, 300) });
  return isTerminal(to) ? DONE : MOVED;
}

export function progress(ctx: RunContext, kind: string, detail: unknown): void {
  markProgress(ctx.db, ctx.run.id, kind, detail, ctx.clock);
  heartbeatController(ctx.db, ctx.ownerId, ctx.clock, { progress: true });
}

export function note(ctx: RunContext, type: string, data: unknown): void {
  ctx.db.tx(() => appendEvent(ctx.db, ctx.run.id, type, ctx.ownerId, data, ctx.clock.now()));
}

export function decide(ctx: RunContext, input: { id?: string; kind: string; summary: string; data?: unknown }): DecisionRecord {
  return recordDecision(ctx.db, ctx.runDir, { ...input, runId: ctx.run.id, summary: input.summary.slice(0, 1000) }, ctx.clock, { actor: ctx.ownerId });
}

/**
 * A terminal outcome. Workers are stopped first (spec section 14: budget
 * exhaustion stops workers and preserves artifacts), then the transition,
 * then the final report and the learning hook, which never change the
 * outcome. BLOCKED keeps nothing running either: it waits for a person.
 */
export async function finishRun(ctx: RunContext, to: Extract<RunState, 'SUCCEEDED' | 'BLOCKED' | 'EXHAUSTED' | 'IMPOSSIBLE' | 'CANCELLED'>, reason: string, opts: { data?: Record<string, unknown>; outcome?: Record<string, unknown> } = {}): Promise<StepResult> {
  const unstoppable = await stopActiveWorkers(ctx, `run ${to.toLowerCase()}: ${reason}`.slice(0, 300));
  if (unstoppable.length > 0) note(ctx, 'workers.stop-failed', { workers: unstoppable });
  const outcome = { state: to, reason, ...(opts.outcome ?? {}), ...(unstoppable.length > 0 ? { workers_not_stopped: unstoppable } : {}) };
  ctx.refresh();
  // A durable cancellation outranks every other outcome: only CANCELLED is reachable once it is recorded.
  const target = ctx.run.cancelRequested && to !== 'CANCELLED' ? 'CANCELLED' : to;
  const why = target === to ? reason : `cancelled by request (the step had decided ${to}: ${reason})`;
  const result = move(ctx, target, why, { patch: { outcomeReason: why.slice(0, 2000), outcomeJson: JSON.stringify(target === to ? outcome : { ...outcome, state: target, decided: to }) }, data: opts.data });
  await finalizeRun(ctx);
  return result;
}

export async function blockOnAuth(ctx: RunContext, provider: string, state: BlockedCredentialState, detail: string | null): Promise<StepResult> {
  const blocker = authBlocker({ provider, state, detail, runId: ctx.run.id });
  await stopActiveWorkers(ctx, blocker.message.slice(0, 300));
  const out = blockRunOnCredentials(ctx.db, ctx.clock, ctx.ownerId, ctx.run.id, blocker);
  ctx.refresh();
  if (out.outcome === 'cancel-pending') return finishRun(ctx, 'CANCELLED', 'cancelled by request');
  if (out.outcome === 'blocked') await finalizeRun(ctx);
  return DONE;
}

/**
 * The checks every step makes before acting. Returns a result when the step
 * must not continue: the run ended, was cancelled (made CANCELLED here),
 * paused, or hit a hard cap on wall time or cost (made EXHAUSTED).
 */
export async function safePoint(ctx: RunContext): Promise<StepResult | null> {
  if (ctx.signal.aborted) return { progressed: false, done: true };
  const run = ctx.refresh();
  if (isTerminal(run.state)) return { progressed: false, done: true };
  if (run.cancelRequested) return finishRun(ctx, 'CANCELLED', 'cancelled by request');
  if (run.paused) return { progressed: false, done: true, waiting: 'paused' };
  if (ctx.ledger) {
    ctx.ledger.syncWall();
    for (const counter of ['wall_ms', 'cost_usd'] as const) {
      const s = ctx.ledger.state(counter);
      if (s.used >= s.hard_cap) {
        return finishRun(ctx, 'EXHAUSTED', `${counter === 'wall_ms' ? 'wall time' : 'model cost'} hard cap reached (${round(s.used)} of ${round(s.hard_cap)})`, { data: { counter, used: s.used, hard_cap: s.hard_cap } });
      }
    }
  }
  return null;
}

function round(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** Map an error a step could not handle to an outcome, or rethrow it for the loop's bounded retry. */
export async function outcomeForError(ctx: RunContext, err: unknown): Promise<StepResult | null> {
  if (!isOrbitError(err)) return null;
  switch (err.code) {
    case 'BUDGET_EXHAUSTED':
      return finishRun(ctx, 'EXHAUSTED', err.message, { data: { ...(err.details ?? {}) } });
    case 'AUTH_EXPIRED':
    case 'AUTH_MISSING': {
      const provider = typeof err.details?.provider === 'string' ? err.details.provider : 'claude';
      return blockOnAuth(ctx, provider, err.code === 'AUTH_MISSING' ? 'missing' : 'expired', err.message);
    }
    case 'POLICY_TAMPERED':
    case 'POLICY_DENIED':
    case 'SCOPE_VIOLATION':
    case 'ISOLATION_UNAVAILABLE':
    case 'CONFIG_INVALID':
    case 'CONTRACT_INVALID':
    case 'PROVIDER_UNAVAILABLE':
      return finishRun(ctx, 'BLOCKED', `${err.code}: ${err.message}`, { data: { code: err.code } });
    default:
      return null;
  }
}

export function assertContract(ctx: RunContext): NonNullable<RunContext['contract']> {
  if (!ctx.contract) throw new OrbitError('CONTRACT_INVALID', `run ${ctx.run.id} reached ${ctx.run.state} without a contract`);
  return ctx.contract;
}

/** The controller-written summary of a worker's authority (spec section 21: "policy summary"). */
export function policySummary(ctx: RunContext, opts: { readOnly: boolean }): string {
  const c = ctx.snapshot.config;
  const scope = ctx.contract?.allowed_paths ?? c.scope.allowed_paths;
  const lines = [
    `- mode: ${c.mode}${opts.readOnly ? '; you are read-only: do not edit any file' : ''}`,
    `- you may edit only: ${scope.join(', ')}`,
    `- protected (never edit): ${ctx.snapshot.effective_protected_paths.join(', ')}`,
    `- dependencies: add packages ${c.dependencies.add_packages ? 'allowed' : 'not allowed'}; lockfile changes ${c.dependencies.change_lockfile ? 'allowed' : 'not allowed'}`,
    `- network: ${c.network.allowed_hosts.length > 0 ? c.network.allowed_hosts.join(', ') : 'none'}`,
    `- trusted checks (run by the controller, not you): ${Object.keys(c.checks).join(', ') || 'none'}`,
    '- you cannot commit, push, open pull requests, change policy, or decide completion',
  ];
  return lines.join('\n');
}

export type FailureHandling = { retry: true } | { retry: false; result: StepResult };

/**
 * What to do after a worker ended without a usable result. Authentication
 * failures block at once (never retried); transient provider failures spend
 * an infrastructure retry; malformed or failed output is regenerated within
 * `maxAttempts` (spec section 14); beyond that the caller's `exhausted`
 * outcome applies.
 */
export async function handleWorkerFailure(
  ctx: RunContext,
  failed: { provider: string; status: string; error: string | null },
  opts: { attemptsUsed: number; maxAttempts: number; what: string; exhausted?: () => Promise<StepResult> },
): Promise<FailureHandling> {
  if (failed.status === 'auth_failed') return { retry: false, result: await blockOnAuth(ctx, failed.provider, 'auth_failed', failed.error) };
  if (failed.status === 'cancelled') {
    const stop = await safePoint(ctx);
    if (stop) return { retry: false, result: stop };
  }
  if (failed.status === 'transient_error') {
    if (ctx.ledger) ctx.ledger.consume('infrastructure_retries', 1);
    else if (opts.attemptsUsed >= opts.maxAttempts + 2) return { retry: false, result: await finishRun(ctx, 'BLOCKED', `${opts.what}: the provider kept failing transiently (${failed.error ?? 'no detail'})`) };
    note(ctx, 'worker.retry', { what: opts.what, status: failed.status, attempts: opts.attemptsUsed });
    return { retry: true };
  }
  if (opts.attemptsUsed < opts.maxAttempts) {
    note(ctx, 'worker.regenerate', { what: opts.what, status: failed.status, attempts: opts.attemptsUsed, error: failed.error?.slice(0, 300) ?? null });
    return { retry: true };
  }
  if (opts.exhausted) return { retry: false, result: await opts.exhausted() };
  return { retry: false, result: await finishRun(ctx, 'BLOCKED', `${opts.what}: no usable result after ${opts.attemptsUsed} attempt(s) (last: ${failed.status}${failed.error ? `, ${failed.error.slice(0, 200)}` : ''})`) };
}

/** The regeneration bound for malformed model output (spec section 14). */
export const MAX_REGENERATIONS = 2;
