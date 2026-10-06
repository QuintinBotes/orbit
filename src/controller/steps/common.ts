/**
 * What every step shares: safe points (cancellation, pause, hard budget
 * caps), transitions through run-store with the lease and an optimistic
 * expectation, terminal outcomes that stop workers and always end in a
 * written report, and decisions recorded through storage/decisions.ts.
 */
import { OrbitError, isOrbitError } from '../../core/errors.ts';
import { orbitHint } from '../../core/invocation.ts';
import { isSessionRefusal } from '../../adapters/types.ts';
import { classifyFailure, decideRetry } from '../../recovery/backoff.ts';
import { appendEvent } from '../../storage/events.ts';
import { recordDecision, type DecisionRecord } from '../../storage/decisions.ts';
import { heartbeatController } from '../../storage/controllers.ts';
import { authBlocker, blockRunOnCredentials, type BlockedCredentialState } from '../../recovery/credentials.ts';
import type { RunContext } from '../context.ts';
import { isTerminal, type RunState } from '../states.ts';
import { markProgress, transition, type TransitionRequest } from '../run-store.ts';
import { raiseOutputCap, stopActiveWorkers } from '../workers.ts';
import { closeMootBaselineQuestions } from './baseline-questions.ts';
import { releaseRunWorktrees } from '../worktree-cleanup.ts';
import { finalizeRun } from '../report.ts';
import { blockingQuestions } from '../gates.ts';
import { applyAmendmentAnswers } from '../../inquisition/amendment-answers.ts';

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
export async function finishRun(ctx: RunContext, to: Extract<RunState, 'SUCCEEDED' | 'BLOCKED' | 'EXHAUSTED' | 'IMPOSSIBLE' | 'CANCELLED'>, reason: string, opts: { data?: Record<string, unknown>; outcome?: Record<string, unknown>; frozenAdvice?: string } = {}): Promise<StepResult> {
  let advice = '';
  if (to === 'BLOCKED') {
    // A block whose cause lives in the frozen policy cannot be cleared by editing the config and resuming: say so. A block
    // that knows better than the generic advice (a missing target, which a fix of the config may not even be) brings its own.
    const setting = frozenPolicyCause(reason, typeof opts.data?.code === 'string' ? opts.data.code : undefined);
    if (setting !== null) {
      advice = opts.frozenAdvice ?? frozenPolicyAdvice(ctx.run.id, setting);
      reason = withSentence(reason, advice);
      opts = { ...opts, outcome: { ...(opts.outcome ?? {}), frozen_policy: { setting } } };
    }
  }
  const unstoppable = await stopActiveWorkers(ctx, `run ${to.toLowerCase()}: ${reason}`.slice(0, 300));
  if (unstoppable.length > 0) note(ctx, 'workers.stop-failed', { workers: unstoppable });
  const outcome = { state: to, reason, ...(opts.outcome ?? {}), ...(unstoppable.length > 0 ? { workers_not_stopped: unstoppable } : {}) };
  ctx.refresh();
  // A durable cancellation outranks every other outcome: only CANCELLED is reachable once it is recorded.
  const target = ctx.run.cancelRequested && to !== 'CANCELLED' ? 'CANCELLED' : to;
  if (target === 'SUCCEEDED') closeMootBaselineQuestions(ctx);
  const why = target === to ? reason : `cancelled by request (the step had decided ${to}: ${reason})`;
  const result = move(ctx, target, why, { patch: { outcomeReason: cappedReason(why, target === to ? advice : ''), outcomeJson: JSON.stringify(target === to ? outcome : { ...outcome, state: target, decided: to }) }, data: opts.data });
  await finalizeRun(ctx);
  // The result lives in the branch and the candidate refs; a finished run does not keep a checkout (BLOCKED and EXHAUSTED do).
  if (target === 'SUCCEEDED' || target === 'CANCELLED') await releaseRunWorktrees(ctx);
  return result;
}

/** The longest outcome reason a run row keeps; outcome_json keeps the whole text. */
const OUTCOME_REASON_MAX = 2000;

/**
 * `why` as the run row keeps it: cut to the cap, but never in the advice that ends it (the way forward of a frozen-policy
 * block), which is what a person who reads only the row needs. Several checks with long log paths make the evidence
 * longer than the cap, so it is the evidence that gives way.
 */
function cappedReason(why: string, advice: string): string {
  if (why.length <= OUTCOME_REASON_MAX) return why;
  if (advice === '' || !why.endsWith(advice) || advice.length > OUTCOME_REASON_MAX / 2) return why.slice(0, OUTCOME_REASON_MAX);
  const head = why.slice(0, why.length - advice.length - 1);
  return `${head.slice(0, OUTCOME_REASON_MAX - advice.length - 5)}... ${advice}`;
}

/**
 * The policy setting a block comes from, when the cause is fixed in the run's frozen policy snapshot rather than in
 * the environment: the run keeps the policy it started with, so editing .orbit/config.yaml cannot clear it and
 * `orbit resume` would only block again. Null for blocks a person can clear outside the policy (a login, CI).
 */
export function frozenPolicyCause(reason: string, code?: string): string | null {
  if (code === 'POLICY_TAMPERED' || /^POLICY_TAMPERED\b/.test(reason)) return 'the policy snapshot (it no longer matches its recorded hash)';
  if (code === 'CONFIG_INVALID' || /^CONFIG_INVALID\b/.test(reason)) return 'the configuration the run started with';
  const eligible = /providers\.([\w-]+)\.data_policy_eligible is not true/.exec(reason);
  if (eligible) return `providers.${eligible[1]}.data_policy_eligible`;
  const notOffered = /providers\.([\w-]+)\.model "[^"]*" is not offered/.exec(reason);
  if (notOffered) return `providers.${notOffered[1]}.model`;
  const noModel = /"([\w-]+)" has no model qualified for review|no model of "([\w-]+)" is qualified for review/.exec(reason);
  if (noModel) return `providers.${noModel[1] ?? noModel[2]}.model (or a refreshed model catalog: orbit models refresh)`;
  if (/no proposed path lies inside the policy scope|the policy allows no paths/.test(reason)) return 'scope.allowed_paths';
  if (/execution needs isolation; the policy selects none/.test(reason)) return 'isolation.provider';
  // Workers loading a plugin the policy does not allow (at run start, or a session refused after it started): the allowance is a policy key.
  // agents.allow_managed_plugins admits only managed plugins, so it is named only when doctor's fix line offers it.
  if (/plugin\(s\)[^.;]*\bthe policy does not allow/.test(reason)) return /agents\.allow_managed_plugins/.test(reason) ? 'agents.allowed_plugins or agents.allow_managed_plugins' : 'agents.allowed_plugins';
  if (/differs from the frozen policy mode/.test(reason)) return 'mode';
  // A misconfigured check at PREFLIGHT or CONTRACTING (environment-block.ts baselineBlockReason, missingTargetBlockReason): its command is in the policy.
  const misconfigured = /^[Cc]hecks? ([\w.-]+(?:, [\w.-]+)*) (?:is|are) misconfigured\b/.exec(reason);
  if (misconfigured) return misconfigured[1]!.split(', ').map((id) => `checks.${id}.command`).join(', ');
  return null;
}

/** `next` as its own sentence after `reason`, which may or may not end with a full stop. */
export function withSentence(reason: string, next: string): string {
  const r = reason.trimEnd();
  return `${/[.!?]$/.test(r) ? r : `${r}.`} ${next}`;
}

/**
 * Whether a fix outside the policy can clear a block on `setting`, so that `orbit resume --force` is a way forward. Not
 * offered for a misconfigured check (`checks.<id>.command`): its command is the policy's, and a forced resume runs the
 * same command again (a PREFLIGHT block leaves the baseline incomplete, so the check runs again; at CONTRACTING the
 * recorded baseline is read and blocks again), so it blocks again unless the tool changed outside the policy. A new
 * run, which the advice names, clears the block whatever the cause (ADR 0010).
 */
export function frozenPolicyForceHelps(setting: string): boolean {
  return !/^checks\.[\w.-]+\.command(?:, checks\.[\w.-]+\.command)*$/.test(setting);
}

/** What to do about a frozen-policy block: the config change applies only to a new run. */
export function frozenPolicyAdvice(runId: string, setting: string): string {
  const advice = `This comes from the run's frozen policy (${setting}): a run keeps the policy it started with, so editing .orbit/config.yaml does not change it and resuming would block again. Fix the config, then cancel this run (orbit cancel ${runId}) and start a new run with orbit run.`;
  return frozenPolicyForceHelps(setting) ? `${advice} If what you fixed is outside the policy (for example orbit models refresh), resume with orbit resume ${runId} --force.` : advice;
}

export async function blockOnAuth(ctx: RunContext, provider: string, state: BlockedCredentialState, detail: string | null): Promise<StepResult> {
  // The workers get the controller's host environment, so that is where an exported key would override a login.
  const blocker = authBlocker({ provider, state, detail, runId: ctx.run.id, env: ctx.deps.hostEnv ?? process.env });
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
  applyAnsweredAmendments(ctx);
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

/**
 * A person's answer to a contract amendment's approval question takes effect before any step reasons about the
 * contract: `orbit decide` applies it, and this applies one whose application was interrupted or failed there.
 */
function applyAnsweredAmendments(ctx: RunContext): void {
  if (!ctx.policyVerified || !ctx.contract) return;
  const waiting = ctx.db.get("SELECT 1 AS x FROM amendments a JOIN questions q ON q.id = 'q-amd-' || a.id WHERE a.run_id = ? AND a.status = 'pending-approval' AND q.status = 'answered' LIMIT 1", ctx.run.id);
  if (!waiting) return;
  const applied = applyAmendmentAnswers({ db: ctx.db, clock: ctx.clock, runId: ctx.run.id, runDir: ctx.runDir }, { snapshot: ctx.snapshot });
  if (applied.contract) ctx.contract = applied.contract;
  if (applied.changed) ctx.refresh();
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

/**
 * Criteria an open material question blocks keep the run from delivery and success (spec section 10): the
 * independent work was verified, the rest waits for a person. BLOCKED, naming the questions, or null.
 */
export async function blockOnOpenQuestions(ctx: RunContext, stage: string, opts: { detail?: string; outcome?: Record<string, unknown> } = {}): Promise<StepResult | null> {
  const { criteria, questions } = blockingQuestions(ctx.db, ctx.run.id);
  if (criteria.length === 0) return null;
  const listed = questions.slice(0, 5).map((q) => `${q.id}: ${q.question}`).join(' | ');
  const detail = opts.detail ? ` ${opts.detail}` : '';
  return finishRun(ctx, 'BLOCKED', `${criteria.join(', ')} ${criteria.length === 1 ? 'waits' : 'wait'} for a decision before ${stage}; open questions: ${listed}.${detail} Answer with orbit decide ${ctx.run.id} <question-id> <answer>, then orbit resume ${ctx.run.id}`, {
    outcome: { ...(opts.outcome ?? {}), blocked_criteria: criteria, questions: questions.map((q) => q.id) },
  });
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
 * A worker session Orbit refused after it started: its environment broke the policy (a plugin the policy does not allow,
 * an MCP server, another permission mode). The next session would start in the same environment and be refused the same
 * way, so it is not transient and not one more attempt to spend: the run ends BLOCKED now. The refusal is quoted whole
 * (it names each plugin and the line that allows it; cut at 200 characters it ended mid-sentence), and the outcome says
 * which command shows the cause. `worker_refusal` marks the outcome: the curator, a session in this same environment,
 * would be refused too, so a run that ended this way and produced nothing is not curated (report.ts).
 */
export async function blockOnRefusedSession(ctx: RunContext, what: string, error: string | null): Promise<StepResult> {
  const cause = error?.trim() || 'no detail was recorded';
  return finishRun(ctx, 'BLOCKED', `${what}: its session was refused after it started and was not retried (a new session would run in the same environment and be refused the same way); ${orbitHint('doctor')} shows what a worker would load and how to fix it. Cause: ${cause}`, {
    outcome: { worker_refusal: { kind: 'session', what, error: cause.slice(0, 4000) } },
  });
}

export const WORKER_RETRY_EVENT = 'worker.retry';

export interface RetryRecord {
  what: string;
  /** The work unit family (`plan`, `implement:3`); waits are per family. */
  base: string;
  /** The purpose of the worker that failed; one record per failed worker. */
  purpose: string;
  status: string;
  retry: number;
  delay_ms: number;
  ceiling_ms: number;
  retry_after_ms: number | null;
  not_before: number;
}

function retryRecords(ctx: RunContext, base: string): RetryRecord[] {
  return ctx.db
    .all<{ data_json: string | null }>("SELECT data_json FROM events WHERE run_id = ? AND type = ? AND json_extract(data_json, '$.base') = ? ORDER BY id", ctx.run.id, WORKER_RETRY_EVENT, base)
    .map((r) => (r.data_json ? (JSON.parse(r.data_json) as RetryRecord) : null))
    .filter((r): r is RetryRecord => r !== null && typeof r.not_before === 'number');
}

/**
 * The backoff wait before the next worker of `base` may start (spec section 14: bounded backoff with jitter).
 * WAIT while the newest retry's not_before is in the future; null once it has passed.
 */
export function retryWait(ctx: RunContext, base: string): StepResult | null {
  const last = retryRecords(ctx, base).at(-1);
  if (!last) return null;
  const left = last.not_before - ctx.clock.now();
  return left > 0 ? WAIT(`${last.what}: backing off ${left} ms after a transient failure (retry ${last.retry})`) : null;
}

/** A provider's retry-after, when its error text names one ("retry after 30s", "retry-after: 1500 ms"). */
export function retryAfterHintMs(text: string | null): number | null {
  if (!text) return null;
  const m = /retry[- ]after[:= ]+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?)?/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  return /^m/i.test(m[2] ?? 's') ? Math.round(n) : Math.round(n * 1000);
}

/**
 * A transient provider failure of one worker: spend one infrastructure retry and record when the next worker
 * of the same unit may start (full-jitter exponential backoff, a provider retry-after honoured), once per failed
 * worker, so a step that observes the same failure again after waiting neither charges nor waits twice.
 * Returns a terminal result when no retry is left.
 */
export async function scheduleTransientRetry(ctx: RunContext, failed: { base: string; purpose: string; what: string; status: string; error: string | null }): Promise<StepResult | null> {
  const prior = retryRecords(ctx, failed.base);
  if (prior.some((r) => r.purpose === failed.purpose)) return null;
  // The caller saw a transient failure; the classification adds the provider's retry-after when it named one.
  const classification = { ...classifyFailure({ status: 'transient_error', retryAfterMs: retryAfterHintMs(failed.error) }), kind: 'transient' as const };
  let wallRemainingMs: number | null = null;
  if (ctx.ledger) {
    const wall = ctx.ledger.state('wall_ms');
    wallRemainingMs = Math.max(0, wall.hard_cap - wall.used);
  }
  const decision = decideRetry({ classification, attempt: prior.length + 1, infrastructureRetriesRemaining: ctx.ledger ? ctx.ledger.state('infrastructure_retries').remaining : Number.POSITIVE_INFINITY, wallRemainingMs, costRemainingUsd: null, ...(ctx.deps.random ? { random: ctx.deps.random } : {}) });
  if (decision.action !== 'retry') {
    if (decision.action === 'stop' && (decision.limit === 'infrastructure_retries' || decision.limit === 'wall')) {
      return finishRun(ctx, 'EXHAUSTED', `${failed.what}: the provider kept failing transiently and ${decision.reason} (last: ${failed.error?.slice(0, 200) ?? failed.status})`, { data: { counter: decision.limit === 'wall' ? 'wall_ms' : 'infrastructure_retries' } });
    }
    return finishRun(ctx, 'BLOCKED', `${failed.what}: the provider kept failing transiently (${decision.reason}; last: ${failed.error?.slice(0, 200) ?? failed.status})`);
  }
  const record: RetryRecord = { what: failed.what, base: failed.base, purpose: failed.purpose, status: failed.status, retry: prior.length + 1, delay_ms: decision.delayMs, ceiling_ms: decision.ceilingMs, retry_after_ms: classification.retryAfterMs, not_before: ctx.clock.now() + decision.delayMs };
  // The retry is charged with its record: a crash between the two can neither charge it twice nor lose the wait.
  const refusal = ctx.db.tx((): OrbitError | null => {
    if (ctx.ledger) {
      try {
        ctx.ledger.consume('infrastructure_retries', 1);
      } catch (err) {
        if (isOrbitError(err, 'BUDGET_EXHAUSTED')) return err;
        throw err;
      }
    }
    appendEvent(ctx.db, ctx.run.id, WORKER_RETRY_EVENT, ctx.ownerId, record, ctx.clock.now());
    return null;
  });
  if (refusal) return finishRun(ctx, 'EXHAUSTED', `${failed.what}: ${refusal.message}`, { data: { ...(refusal.details ?? {}) } });
  return null;
}

/**
 * What to do after a worker ended without a usable result. Authentication
 * failures and refused sessions block at once (never retried); transient provider failures spend
 * an infrastructure retry and back off; malformed or failed output is
 * regenerated within `maxAttempts` (spec section 14); beyond that the
 * caller's `exhausted` outcome applies.
 */
export async function handleWorkerFailure(
  ctx: RunContext,
  failed: { provider: string; status: string; error: string | null; reason?: string | null },
  opts: { attemptsUsed: number; maxAttempts: number; what: string; base?: string; purpose?: string; exhausted?: () => Promise<StepResult> },
): Promise<FailureHandling> {
  if (failed.status === 'auth_failed') return { retry: false, result: await blockOnAuth(ctx, failed.provider, 'auth_failed', failed.error) };
  if (isSessionRefusal({ status: failed.status, reason: failed.reason })) return { retry: false, result: await blockOnRefusedSession(ctx, opts.what, failed.error) };
  if (failed.status === 'cancelled') {
    const stop = await safePoint(ctx);
    if (stop) return { retry: false, result: stop };
  }
  if (failed.status === 'transient_error') {
    const base = opts.base ?? opts.what;
    const stop = await scheduleTransientRetry(ctx, { base, purpose: opts.purpose ?? `${base}#${opts.attemptsUsed}`, what: opts.what, status: failed.status, error: failed.error });
    if (stop) return { retry: false, result: stop };
    return { retry: true };
  }
  // A response that exceeded the output cap fails the same way every time at the same cap: retry the unit once
  // with the cap doubled (a recorded decision), without spending a regeneration on it.
  if (failed.status === 'failed' && opts.purpose && raiseOutputCap(ctx, opts.purpose, failed.error) !== null) return { retry: true };
  if (opts.attemptsUsed < opts.maxAttempts) {
    note(ctx, 'worker.regenerate', { what: opts.what, status: failed.status, attempts: opts.attemptsUsed, error: failed.error?.slice(0, 300) ?? null });
    return { retry: true };
  }
  if (opts.exhausted) return { retry: false, result: await opts.exhausted() };
  return { retry: false, result: await finishRun(ctx, 'BLOCKED', `${opts.what}: no usable result after ${opts.attemptsUsed} attempt(s) (last: ${failed.status}${failed.error ? `, ${failed.error.slice(0, 200)}` : ''})`) };
}

/** The regeneration bound for malformed model output (spec section 14). */
export const MAX_REGENERATIONS = 2;
