import type { Clock } from '../core/clock.ts';
import { OrbitError, isOrbitError } from '../core/errors.ts';
import type { TaskStatus } from '../adapters/types.ts';
import { authBlocker, type AuthBlocker } from './credentials.ts';

/**
 * Provider failure handling (spec section 14):
 *
 *   temporary provider failure   bounded backoff with jitter
 *   authentication failure       block, never retry
 *   malformed output             schema validation, bounded regeneration
 *
 * Retrying has three bounds that all apply, and the first to bind wins: the
 * per-operation attempt limit, the run's `infrastructure_retries` budget
 * (infrastructure retries do not consume implementation attempts, spec
 * section 7), and the wall-time and cost budgets, which they do consume. A
 * wait that would outlast the remaining wall time is not started.
 */

export type FailureKind =
  /** Rate limit, overload, network trouble: waiting may fix it. */
  | 'transient'
  /** Credentials rejected, expired or missing: waiting cannot fix it. */
  | 'authentication'
  /** The model answered, but not in the required shape. */
  | 'malformed_output'
  /** The worker ran out of time: diagnose performance or environment, do not blindly rerun. */
  | 'timeout'
  /** The worker process died: reconciliation restarts it, within the recovery budget. */
  | 'crash'
  /** The provider cannot be used at all here (CLI missing, not eligible): pick another route. */
  | 'unavailable'
  /** Decided, not retried: a policy denial, a refused request, an exhausted budget. */
  | 'permanent';

export interface FailureSignal {
  /** The adapter's task status, when the failure came from a worker. */
  status?: TaskStatus | string | null;
  /** An OrbitError or any thrown value. */
  error?: unknown;
  /** The HTTP status the provider answered with, when known. */
  httpStatus?: number | null;
  message?: string | null;
  /** A `retry-after` the provider sent. */
  retryAfterMs?: number | null;
}

export interface Classification {
  kind: FailureKind;
  /** Why it was classified so; never contains the raw provider text. */
  reason: string;
  retryAfterMs: number | null;
}

const AUTH_HTTP = new Set([401, 403]);
const TRANSIENT_HTTP = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

// Checked before the transient patterns: a message can mention both ("401 ... please retry").
const AUTH_TEXT =
  /invalid (x-)?api[ _-]?key|authentication[ _-]?(error|failed|required)|failed to authenticate|unauthori[sz]ed|not logged in|login required|please (run|log in).{0,40}login|(token|credentials?|api key|session) (has |have |is |are |was |were )?(expired|invalid|revoked|missing)|expired (oauth )?(token|credentials?)|fix external api key/i;
const TRANSIENT_TEXT =
  /overloaded|rate[ _-]?limit|too many requests|temporarily unavailable|service unavailable|bad gateway|gateway time-?out|etimedout|econnreset|econnrefused|eai_again|enotfound|socket hang up|network (error|is unreachable)|connection (reset|closed|error|refused)|\b(429|500|502|503|504|529)\b/i;
const MALFORMED_TEXT = /malformed|not valid json|invalid json|unexpected token|schema validation|does not match .{0,40}schema|structured output/i;

export function classifyFailure(signal: FailureSignal): Classification {
  const hint = validHint(signal.retryAfterMs) ?? hintOf(signal.error);
  const done = (kind: FailureKind, reason: string): Classification => ({ kind, reason, retryAfterMs: hint });

  const err = signal.error;
  if (isOrbitError(err)) {
    switch (err.code) {
      case 'AUTH_EXPIRED':
      case 'AUTH_MISSING':
        return done('authentication', `error code ${err.code}`);
      case 'PROVIDER_TRANSIENT':
        return done('transient', `error code ${err.code}`);
      case 'MALFORMED_OUTPUT':
        return done('malformed_output', `error code ${err.code}`);
      case 'PROVIDER_UNAVAILABLE':
      case 'ISOLATION_UNAVAILABLE':
        return done('unavailable', `error code ${err.code}`);
      default:
        return done('permanent', `error code ${err.code}`);
    }
  }

  switch (signal.status) {
    case 'auth_failed':
      return done('authentication', 'task status auth_failed');
    case 'transient_error':
      return done('transient', 'task status transient_error');
    case 'malformed_output':
      return done('malformed_output', 'task status malformed_output');
    case 'timeout':
      return done('timeout', 'task status timeout');
    case 'lost':
      return done('crash', 'task status lost');
    case 'cancelled':
      return done('permanent', 'task status cancelled');
    case 'max_turns':
      return done('permanent', 'task status max_turns (a turn cap is a budget, not an infrastructure failure)');
    default:
      break;
  }

  const http = signal.httpStatus ?? null;
  if (http !== null) {
    if (AUTH_HTTP.has(http)) return done('authentication', `HTTP ${http}`);
    if (TRANSIENT_HTTP.has(http) || (http >= 500 && http <= 599)) return done('transient', `HTTP ${http}`);
    return done('permanent', `HTTP ${http}`);
  }

  const text = signal.message ?? (err instanceof Error ? err.message : typeof err === 'string' ? err : null);
  if (text) {
    if (AUTH_TEXT.test(text)) return done('authentication', 'message matches an authentication failure');
    if (TRANSIENT_TEXT.test(text)) return done('transient', 'message matches a transient provider or network failure');
    if (MALFORMED_TEXT.test(text)) return done('malformed_output', 'message matches malformed output');
  }
  // Unknown failures are not retried blindly: a loop on a failure nobody understands is how budgets burn.
  return done('permanent', 'unrecognized failure');
}

function hintOf(err: unknown): number | null {
  if (!isOrbitError(err)) return null;
  return validHint(err.details?.retryAfterMs);
}

/** A retry-after is a finite, non-negative number of milliseconds or nothing: NaN or Infinity as a wait would mean no wait at all under setTimeout. */
function validHint(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

// ---------------------------------------------------------------------------
// backoff

export interface BackoffPolicy {
  /** The ceiling of the first retry's wait. */
  baseMs: number;
  /** No wait exceeds this (a larger provider hint is honoured, see decideRetry). */
  maxMs: number;
  factor: number;
  /** Failed attempts of one operation after which it is given up on. */
  maxAttempts: number;
}

export const DEFAULT_BACKOFF: Readonly<BackoffPolicy> = Object.freeze({ baseMs: 1_000, maxMs: 60_000, factor: 2, maxAttempts: 5 });
/** Regenerations of one malformed output before giving up. */
export const DEFAULT_MAX_REGENERATIONS = 2;
/**
 * The longest provider retry-after that is waited for. A longer one (a daily
 * quota) is a stop, not a sleep: past 2^31 ms Node's timers fire at once, and
 * a run parked for hours on one request is better reported than hidden.
 */
export const DEFAULT_MAX_RETRY_AFTER_MS = 15 * 60_000;

/** Uniform in [0, 1), like Math.random; injected so tests can pin the jitter. */
export type RandomSource = () => number;

function checkPolicy(p: BackoffPolicy): void {
  if (![p.baseMs, p.maxMs, p.factor].every((n) => Number.isFinite(n) && n > 0) || p.maxMs < p.baseMs || p.factor < 1 || !Number.isInteger(p.maxAttempts) || p.maxAttempts < 1) {
    throw new OrbitError('CONFIG_INVALID', 'invalid backoff policy: baseMs, maxMs and factor must be positive (maxMs >= baseMs, factor >= 1) and maxAttempts a positive integer', { policy: p });
  }
}

/** The upper bound of the wait before retry number `retry` (1 = the first retry): min(maxMs, baseMs * factor^(retry - 1)). */
export function backoffCeilingMs(retry: number, policy: BackoffPolicy = DEFAULT_BACKOFF): number {
  checkPolicy(policy);
  if (!Number.isInteger(retry) || retry < 1) throw new OrbitError('SCHEMA_INVALID', 'retry number must be a positive integer');
  // Guard the exponent so a long loop cannot overflow to Infinity before the cap applies.
  const grown = policy.baseMs * policy.factor ** Math.min(retry - 1, 64);
  return Math.min(policy.maxMs, Math.floor(grown));
}

/**
 * Full jitter: a uniform wait between 0 and the ceiling. Compared with a fixed
 * or partially jittered delay it spreads concurrent retries best, so many
 * workers that failed together do not hit the provider together again.
 */
export function backoffDelayMs(retry: number, policy: BackoffPolicy = DEFAULT_BACKOFF, random: RandomSource = Math.random): number {
  const ceiling = backoffCeilingMs(retry, policy);
  const r = random();
  if (!(r >= 0 && r < 1)) throw new OrbitError('INTERNAL', `random source returned ${String(r)}; it must be in [0, 1)`);
  return Math.floor(r * (ceiling + 1));
}

// ---------------------------------------------------------------------------
// the decision

export interface RetryContext {
  classification: Classification;
  /** The provider involved, for the blocker text. */
  provider?: string;
  runId?: string;
  /** Failed attempts of this operation so far, this one included (>= 1). */
  attempt: number;
  policy?: BackoffPolicy;
  random?: RandomSource;
  /** What is left of the run's infrastructure_retries counter. */
  infrastructureRetriesRemaining: number;
  /** Wall time left in the run's budget; null when unknown. */
  wallRemainingMs: number | null;
  /** Spend left in the run's budget; null when unknown. */
  costRemainingUsd: number | null;
  /** What one more attempt is expected to cost; null when unknown (then any remaining spend must be positive). */
  estimatedCostUsd?: number | null;
  regenerationsUsed?: number;
  maxRegenerations?: number;
  /** What is left of the run's recovery_attempts counter; a crash is restarted only while some is left. Null or absent when unknown. */
  recoveryAttemptsRemaining?: number | null;
  /** Longest provider retry-after to wait for; default DEFAULT_MAX_RETRY_AFTER_MS. */
  maxRetryAfterMs?: number;
  /** The environment the workers get, for the authentication advice (an exported key overrides a login); default process.env. */
  env?: Readonly<Record<string, string | undefined>>;
}

export type StopLimit = 'attempts' | 'infrastructure_retries' | 'wall' | 'cost' | 'regenerations' | 'permanent' | 'unavailable' | 'retry_after' | 'recovery_attempts';

export type RetryDecision =
  /** Wait `delayMs`, then try again. */
  | { action: 'retry'; delayMs: number; ceilingMs: number; nextAttempt: number; reason: string }
  /** Ask the model again, handing it the validation errors; no wait. */
  | { action: 'regenerate'; regeneration: number; remaining: number; reason: string }
  /** Credentials are bad: block the run with this message. Never retried. */
  | { action: 'block'; blocker: AuthBlocker; reason: string }
  /** A worker crash: reconciliation restarts it within the recovery budget. */
  | { action: 'restart'; reason: string }
  /** A timeout: diagnose performance or the environment instead of rerunning. */
  | { action: 'diagnose'; reason: string }
  /** Give up: the named limit bound, or the failure is not one to retry. */
  | { action: 'stop'; limit: StopLimit; reason: string };

export function decideRetry(ctx: RetryContext): RetryDecision {
  const policy = ctx.policy ?? DEFAULT_BACKOFF;
  const kind = ctx.classification.kind;
  switch (kind) {
    case 'authentication':
      return {
        action: 'block',
        blocker: authBlocker({ provider: ctx.provider ?? 'the model provider', state: 'auth_failed', ...(ctx.runId ? { runId: ctx.runId } : {}), ...(ctx.env ? { env: ctx.env } : {}) }),
        reason: `authentication failure (${ctx.classification.reason}); not retried`,
      };
    case 'crash':
      // Recovery has a budget (spec section 14): the decision says so instead of leaving it to whoever restarts.
      if (ctx.recoveryAttemptsRemaining != null && ctx.recoveryAttemptsRemaining <= 0) return { action: 'stop', limit: 'recovery_attempts', reason: `${ctx.classification.reason}; the recovery budget is spent` };
      return { action: 'restart', reason: ctx.classification.reason };
    case 'timeout':
      return { action: 'diagnose', reason: ctx.classification.reason };
    case 'unavailable':
      return { action: 'stop', limit: 'unavailable', reason: `provider unavailable (${ctx.classification.reason}); choose another route` };
    case 'permanent':
      return { action: 'stop', limit: 'permanent', reason: `not retried: ${ctx.classification.reason}` };
    case 'malformed_output': {
      const used = ctx.regenerationsUsed ?? 0;
      const max = ctx.maxRegenerations ?? DEFAULT_MAX_REGENERATIONS;
      if (used >= max) return { action: 'stop', limit: 'regenerations', reason: `output still malformed after ${used} regeneration${used === 1 ? '' : 's'}` };
      const spend = spendBound(ctx);
      if (spend) return spend;
      return { action: 'regenerate', regeneration: used + 1, remaining: max - used - 1, reason: ctx.classification.reason };
    }
    case 'transient': {
      if (ctx.attempt >= policy.maxAttempts) return { action: 'stop', limit: 'attempts', reason: `${ctx.attempt} attempts made; the limit is ${policy.maxAttempts}` };
      if (ctx.infrastructureRetriesRemaining <= 0) return { action: 'stop', limit: 'infrastructure_retries', reason: 'the infrastructure retry budget is spent' };
      const retry = ctx.attempt;
      const ceilingMs = backoffCeilingMs(retry, policy);
      const jitter = backoffDelayMs(retry, policy, ctx.random);
      // A provider that says when to come back is believed, even past our ceiling, up to maxRetryAfterMs; the wall budget decides whether to wait that long.
      const hint = validHint(ctx.classification.retryAfterMs);
      const maxHint = ctx.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
      if (hint !== null && hint > maxHint) return { action: 'stop', limit: 'retry_after', reason: `the provider asked to wait ${hint} ms, longer than the ${maxHint} ms Orbit waits for one request` };
      const delayMs = Math.max(jitter, hint ?? 0);
      if (ctx.wallRemainingMs !== null && delayMs >= ctx.wallRemainingMs) {
        return { action: 'stop', limit: 'wall', reason: `waiting ${delayMs} ms would use the ${Math.max(0, ctx.wallRemainingMs)} ms of wall time left` };
      }
      const spend = spendBound(ctx);
      if (spend) return spend;
      return { action: 'retry', delayMs, ceilingMs, nextAttempt: ctx.attempt + 1, reason: ctx.classification.reason };
    }
  }
}

function spendBound(ctx: RetryContext): RetryDecision | null {
  if (ctx.costRemainingUsd === null) return null;
  const need = ctx.estimatedCostUsd ?? null;
  if (ctx.costRemainingUsd <= 0 || (need !== null && need > ctx.costRemainingUsd)) {
    return { action: 'stop', limit: 'cost', reason: `another attempt (${need === null ? 'cost unknown' : `about $${need}`}) does not fit the $${Math.max(0, ctx.costRemainingUsd)} left` };
  }
  return null;
}

// ---------------------------------------------------------------------------
// a loop for callers that are not workers

export interface RetryBudget {
  /** Called once per retry, before the wait; throw to refuse (the caller's ledger.consume('infrastructure_retries', 1)). */
  consume(): void;
  infrastructureRetriesRemaining: () => number;
  wallRemainingMs?: () => number | null;
  costRemainingUsd?: () => number | null;
}

export interface RetryOptions {
  clock: Clock;
  budget: RetryBudget;
  provider?: string;
  runId?: string;
  policy?: BackoffPolicy;
  random?: RandomSource;
  /** Classify a thrown value; default classifyFailure({ error }). */
  classify?: (err: unknown) => Classification;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  /** The environment the workers get (see RetryContext.env). */
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Run `op` until it succeeds or a bound binds. Transient failures retry with
 * jittered backoff; an authentication failure is thrown as AUTH_EXPIRED with
 * the blocker message, never retried; everything else is rethrown as it was.
 * `op` receives the 1-based attempt number.
 */
export async function retryWithBackoff<T>(op: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await op(attempt);
    } catch (err) {
      const classification = (opts.classify ?? ((e) => classifyFailure({ error: e })))(err);
      const decision = decideRetry({
        classification,
        ...(opts.provider ? { provider: opts.provider } : {}),
        ...(opts.runId ? { runId: opts.runId } : {}),
        attempt,
        ...(opts.policy ? { policy: opts.policy } : {}),
        ...(opts.random ? { random: opts.random } : {}),
        ...(opts.env ? { env: opts.env } : {}),
        infrastructureRetriesRemaining: opts.budget.infrastructureRetriesRemaining(),
        wallRemainingMs: opts.budget.wallRemainingMs?.() ?? null,
        costRemainingUsd: opts.budget.costRemainingUsd?.() ?? null,
      });
      if (decision.action === 'block') throw new OrbitError('AUTH_EXPIRED', decision.blocker.message, { blocker: decision.blocker }, { cause: err });
      if (decision.action !== 'retry') throw err;
      opts.budget.consume();
      opts.onRetry?.({ attempt, delayMs: decision.delayMs, error: err });
      await opts.clock.sleep(decision.delayMs);
    }
  }
}
