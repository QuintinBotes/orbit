/**
 * Worker supervision for steps. A step describes the work unit it needs (a
 * stable `purpose` such as `implement:3`); `ensureWorker` either starts it,
 * finds it still running, or returns its finished result. It never blocks on
 * a running worker: the step returns and the next tick looks again, which is
 * what lets a controller that died mid-worker be replaced by one that
 * reattaches instead of spawning a duplicate.
 *
 * Order on a fresh unit: the worker row is written PLANNED (intent) and
 * committed, only then is the process started, and only then is it marked
 * RUNNING. A crash between any two of those is repaired from the worker
 * directory (launch.json, pid.json, exit.json) on the next pass.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { OrbitError, isOrbitError } from '../core/errors.ts';
import { faultPoint } from '../core/faults.ts';
import { newId } from '../core/ids.ts';
import { appendEvent } from '../storage/events.ts';
import { getDecision, recordDecision } from '../storage/decisions.ts';
import { finishWorker, getWorker, listActiveWorkers, listWorkers, markWorkerRunning, planWorker, type WorkerOutcome, type WorkerRecord } from '../storage/workers.ts';
import type { ProviderAdapter, TaskHandle, TaskResult, TaskSpec, UsageReport, WorkerRole } from '../adapters/types.ts';
import { archiveAttempt, handleFromWorkerDir, LAUNCH_FILE, readLogLines } from '../adapters/supervise.ts';
import { LOG_FILE, readExitRecord } from '../adapters/shim.ts';
import { renderSystemPrompt, ROLE_OUTPUT_KIND } from '../adapters/prompt.ts';
import { MODEL_OUTPUT_SCHEMAS } from '../contract/model-outputs.ts';
import { profileForWorker, workerTmpDir } from '../isolation/profiles.ts';
import { detectToolchains, prepareToolchainLayout, toolchainLayout } from '../isolation/toolchains.ts';
import { stopWorker } from '../recovery/reconcile.ts';
import { route, toDecisionRecord } from '../routing/router.ts';
import { allowMatch, fundedSessionCap, tierOf, worstCaseRequestUsd } from '../routing/registry.ts';
import { recordUsage, routeStats } from '../routing/usage.ts';
import type { RouteSignals, WorkKind } from '../routing/types.ts';
import { dearestPricing, ROLE_COST_CEILING_USD, ROLE_WALL_CEILING_MS, type TokenEstimate } from '../scheduling/budget.ts';
import { estimateCost, inputIncludesCacheRead } from '../routing/pricing.ts';
import type { BudgetPhase } from '../scheduling/types.ts';
import type { PolicySnapshot } from '../policy/types.ts';
import { DEFAULT_OUTPUT_BUDGETS, outputBudgets } from '../policy/config.ts';
import { homeOf, toolchainCacheRootFor, type RunContext } from './context.ts';
import { assertLeaseHeld } from './run-store.ts';
import { activeOverlayFor } from './knowledge-hooks.ts';
import { ingestWorkerDenials } from './denials.ts';

export interface WorkerRequest {
  role: WorkerRole;
  /** Stable name of the work unit; one live worker per purpose. */
  purpose: string;
  attempt?: number | null;
  candidateId?: string | null;
  provider: string;
  model: string | null;
  effort: string | null;
  cwd: string;
  readOnly: boolean;
  /** A read-only worker that runs experiments (diagnosis): Bash inside its sandbox, worktree read-only. */
  experiments?: boolean;
  /** Built at spawn time, once the worker id exists (retrieval is recorded against it). */
  prompt: (workerId: string) => string;
  /** Spend cap for the provider's own budget flag; null when the provider has none. */
  maxBudgetUsd?: number | null;
  ownedPaths?: string[] | null;
  phase?: BudgetPhase;
  /** A structured-output schema other than the role's (a strict-compatible JSON schema); the result is validated against it. */
  outputSchema?: object;
}

export type WorkerStatus =
  | { status: 'running'; worker: WorkerRecord }
  | { status: 'finished'; worker: WorkerRecord; result: TaskResult };

/** The workers of a purpose, oldest first. */
export function workersFor(ctx: RunContext, purpose: string): WorkerRecord[] {
  return listWorkers(ctx.db, { runId: ctx.run.id }).filter((w) => w.purpose === purpose);
}

export function adapterFor(ctx: RunContext, provider: string): ProviderAdapter {
  const a = ctx.deps.adapters[provider];
  if (!a) throw new OrbitError('PROVIDER_UNAVAILABLE', `no adapter is configured for provider "${provider}"`, { provider });
  return a;
}

/**
 * Start, observe or collect the worker for `req.purpose`. A finished worker
 * stays finished: a step that wants another try uses a new purpose, so the
 * history of every attempt is kept.
 */
export async function ensureWorker(ctx: RunContext, req: WorkerRequest): Promise<WorkerStatus> {
  // A step whose lease is gone or whose watchdog fired must not start anything: another controller may own the run now.
  ctx.signal.throwIfAborted();
  const existing = workersFor(ctx, req.purpose).at(-1) ?? null;
  if (existing && (existing.state === 'PLANNED' || existing.state === 'RUNNING')) return observe(ctx, existing, req);
  if (existing) return { status: 'finished', worker: existing, result: accountFinished(ctx, existing, req.phase) };

  const id = newId('wrk');
  // The intent is fenced by the lease in the same transaction: a controller that lost the run (paused, slept,
  // renewal not yet noticed) cannot record a second worker for a purpose the new owner is about to start.
  const worker = ctx.db.tx(() => {
    assertLeaseHeld(ctx.db, ctx.run.id, ctx.ownerId, ctx.clock.now());
    return planWorker(
      ctx.db,
      {
        id,
        runId: ctx.run.id,
        role: req.role,
        purpose: req.purpose,
        provider: req.provider,
        model: req.model,
        effort: req.effort,
        attempt: req.attempt ?? null,
        candidateId: req.candidateId ?? null,
        workerDir: join(ctx.runDir, 'workers', id),
        cwd: req.cwd,
        ownedPaths: req.ownedPaths ?? null,
      },
      ctx.clock,
      ctx.ownerId,
    );
  });
  faultPoint('controller.worker.after-plan');
  return spawn(ctx, worker, req);
}

async function observe(ctx: RunContext, w: WorkerRecord, req: WorkerRequest): Promise<WorkerStatus> {
  if (w.cancelRequested) {
    const stopped = await stopWorker({ db: ctx.db, clock: ctx.clock, ownerId: ctx.ownerId, adapters: ctx.deps.adapters, graceMs: ctx.timing.killGraceMs }, w, 'cancellation requested');
    return { status: 'finished', worker: stopped, result: accountFinished(ctx, stopped, req.phase) };
  }
  if (w.state === 'PLANNED') {
    // Intent without a launch: the controller died before spawning. A launch without a pid: it died mid-spawn.
    return spawn(ctx, w, req);
  }
  const adapter = adapterFor(ctx, w.provider);
  const handle = handleOf(adapter, w);
  if (!handle) {
    // RUNNING with no pid.json: the files are gone. Recovery decides about the process; this worker produced nothing usable.
    const row = finishWorker(ctx.db, w.id, { state: 'LOST', resultStatus: 'lost', error: 'the worker directory has no pid.json' }, ctx.clock, ctx.ownerId);
    return { status: 'finished', worker: row, result: accountFinished(ctx, row, req.phase) };
  }
  const result = await adapter.collectResult(handle, { outputSchema: req.outputSchema ?? schemaFor(w.role) });
  if (!result) return { status: 'running', worker: w };
  const row = finishWorker(ctx.db, w.id, outcomeOf(result), ctx.clock, ctx.ownerId);
  return { status: 'finished', worker: row, result: accountFinished(ctx, row, req.phase, result) };
}

function handleOf(adapter: ProviderAdapter, w: WorkerRecord): TaskHandle | null {
  const reattach = (adapter as { reattach?: (dir: string) => TaskHandle | null }).reattach;
  const h = typeof reattach === 'function' ? reattach.call(adapter, w.workerDir) : handleFromWorkerDir(w.provider, w.workerDir);
  return h ? { ...h, workerId: w.id } : null;
}

/** Starting a process is an external effect: only the current lease holder, in a step that is still live, may do it. */
function assertMayStart(ctx: RunContext): void {
  ctx.signal.throwIfAborted();
  assertLeaseHeld(ctx.db, ctx.run.id, ctx.ownerId, ctx.clock.now());
}

async function spawn(ctx: RunContext, w: WorkerRecord, req: WorkerRequest): Promise<WorkerStatus> {
  assertMayStart(ctx);
  const adapter = adapterFor(ctx, w.provider);
  // Private: prompts, settings and transcripts live here.
  mkdirSync(w.workerDir, { recursive: true, mode: 0o700 });
  let spec: TaskSpec;
  try {
    spec = taskSpec(ctx, w, req);
  } catch (err) {
    finishWorker(ctx.db, w.id, { state: 'FAILED', resultStatus: 'failed', error: messageOf(err) }, ctx.clock, ctx.ownerId);
    throw err;
  }
  let handle: TaskHandle;
  try {
    handle = await adapter.startTask(spec);
  } catch (err) {
    if (isOrbitError(err, 'TRANSITION_INVALID') && existsSync(join(w.workerDir, LAUNCH_FILE))) {
      // Launched earlier and already gone. Its exit record, if any, is the result; otherwise archive and start again.
      const h = handleOf(adapter, w);
      if (h) {
        markWorkerRunning(ctx.db, w.id, { pid: h.pid, pgid: h.pgid, procStart: h.procStart }, ctx.clock, ctx.ownerId);
        return observe(ctx, getWorker(ctx.db, w.id), req);
      }
      archiveAttempt(w.provider, w.workerDir);
      assertMayStart(ctx);
      handle = await adapter.startTask(spec);
    } else {
      finishWorker(ctx.db, w.id, { state: 'FAILED', resultStatus: isOrbitError(err, 'AUTH_EXPIRED') || isOrbitError(err, 'AUTH_MISSING') ? 'auth_failed' : 'failed', error: messageOf(err) }, ctx.clock, ctx.ownerId);
      throw err;
    }
  }
  faultPoint('controller.worker.after-spawn');
  const row = markWorkerRunning(ctx.db, w.id, { pid: handle.pid, pgid: handle.pgid, procStart: handle.procStart }, ctx.clock, ctx.ownerId);
  ctx.log.info('worker started', { worker_id: w.id, role: w.role, purpose: w.purpose, provider: w.provider, model: w.model });
  return { status: 'running', worker: row };
}

function taskSpec(ctx: RunContext, w: WorkerRecord, req: WorkerRequest): TaskSpec & { maxBudgetUsd?: number | null } {
  const home = homeOf(ctx.deps);
  const env = ctx.deps.hostEnv ?? process.env;
  const provider = w.provider.startsWith('codex') ? 'codex' : 'claude';
  const timeoutMs = workerTimeoutMs(ctx, w.role);
  const outputCap = raisedOutputCap(ctx, req.purpose);
  // Every session runs under the run's frozen snapshot; nothing (an approve-once grant included) widens a worker.
  const policy = { path: ctx.run.policyPath, hash: ctx.run.policyHash, snapshot: ctx.snapshot };
  // The toolchains the worktree uses: the repository's dependency caches read-only, build state private to the worker
  // (docs/decisions/0009-toolchain-profiles.md). The worker keeps the real HOME its provider CLI needs.
  const toolchains = toolchainLayout({
    toolchains: detectToolchains({ roots: [req.cwd] }),
    mode: 'worker',
    cacheRoot: toolchainCacheRootFor(ctx),
    scratchRoot: join(w.workerDir, 'toolchains'),
    tmpDir: workerTmpDir(w.workerDir),
    hostHome: home,
    hostEnv: env,
  });
  prepareToolchainLayout(toolchains);
  const sandbox = profileForWorker({
    worktree: req.cwd,
    workerDir: w.workerDir,
    snapshot: policy.snapshot,
    provider,
    claudeConfigDir: env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'),
    homeDir: home,
    policyPath: policy.path,
    readablePaths: [ctx.deps.orbitInstallDir, ...toolchains.readOnly],
    timeoutMs,
    env,
  });
  return {
    runId: ctx.run.id,
    workerId: w.id,
    role: w.role,
    model: w.model,
    effort: w.effort,
    cwd: req.cwd,
    workerDir: w.workerDir,
    prompt: req.prompt(w.id),
    systemPrompt: systemPromptFor(ctx, w.role),
    outputSchema: req.outputSchema ?? schemaFor(w.role),
    readOnly: req.readOnly,
    ...(req.experiments ? { experiments: true } : {}),
    maxTurns: ctx.ledger?.maxTurnsPerSession() ?? ctx.snapshot.config.scheduler.hard_limits.worker_turns_per_session,
    timeoutMs,
    sandbox,
    policyPath: policy.path,
    policyHash: policy.hash,
    env: toolchains.env,
    ...(outputCap === null ? {} : { outputTokens: outputCap }),
    ...(req.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: req.maxBudgetUsd }),
  };
}

// ---------------------------------------------------------------------------
// Output cap overflow

/** Decision kind recorded when a unit's per-response output cap is raised after a response exceeded it. */
export const OUTPUT_CAP_DECISION_KIND = 'worker.output-cap-raised';
/**
 * The most a retry may raise a per-response output cap to. 32000 is Claude Code's own interactive default and
 * below the output limit of every model Orbit routes to, so a doubled cap never asks for more than a model can emit.
 */
export const OUTPUT_CAP_CEILING = 32_000;
const OUTPUT_CAP_ERROR = /exceeded the (?:([\d,]+) )?output token maximum/i;

/**
 * Whether a worker's error says its response exceeded the per-response output cap (the Claude CLI reports
 * "API Error: Claude's response exceeded the 4000 output token maximum."), and the cap it ran under when it says so.
 */
export function outputCapExceeded(error: string | null | undefined): { cap: number | null } | null {
  const m = typeof error === 'string' ? OUTPUT_CAP_ERROR.exec(error) : null;
  if (!m) return null;
  const cap = m[1] === undefined ? null : Number(m[1].replace(/,/g, ''));
  return { cap: cap !== null && Number.isSafeInteger(cap) && cap > 0 ? cap : null };
}

/** A unit is a purpose without its attempt number: `plan#2` and `plan#1` are tries of the unit `plan`. */
function unitOf(purpose: string): string {
  return purpose.replace(/#\d+$/, '');
}

function outputCapDecisionId(ctx: RunContext, purpose: string): string {
  return `dec-${ctx.run.id}-outcap-${unitOf(purpose).replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

/** The raised output cap recorded for the unit of `purpose`, or null when its cap was never raised. */
export function raisedOutputCap(ctx: RunContext, purpose: string): number | null {
  const d = getDecision(ctx.db, outputCapDecisionId(ctx, purpose));
  const cap = (d?.data as { new_cap?: unknown } | null | undefined)?.new_cap;
  return typeof cap === 'number' ? cap : null;
}

/**
 * A worker failed with `error`. When that is an output cap overflow and the unit has not been raised before,
 * record a decision doubling the cap (bounded by OUTPUT_CAP_CEILING) and return the new cap: the caller retries
 * the unit, and every later session of it starts under the new cap. A unit is raised once; a cap already at the
 * ceiling cannot be raised. Returns null when the failure is anything else or no raise is possible.
 */
export function raiseOutputCap(ctx: RunContext, purpose: string, error: string | null | undefined): number | null {
  const over = outputCapExceeded(error);
  if (!over) return null;
  if (raisedOutputCap(ctx, purpose) !== null) return null;
  const role = (ctx.db.get<{ role: string }>('SELECT role FROM workers WHERE run_id = ? AND purpose = ? ORDER BY rowid DESC LIMIT 1', ctx.run.id, purpose)?.role ?? null) as WorkerRole | null;
  const configured = role ? (ctx.snapshot.config.routing.output_budgets?.[role as keyof typeof DEFAULT_OUTPUT_BUDGETS] ?? DEFAULT_OUTPUT_BUDGETS[role as keyof typeof DEFAULT_OUTPUT_BUDGETS]) : undefined;
  const previous = over.cap ?? configured;
  if (previous === undefined || previous >= OUTPUT_CAP_CEILING) return null;
  const next = Math.min(previous * 2, OUTPUT_CAP_CEILING);
  const base = unitOf(purpose);
  recordDecision(
    ctx.db,
    ctx.runDir,
    {
      id: outputCapDecisionId(ctx, purpose),
      runId: ctx.run.id,
      kind: OUTPUT_CAP_DECISION_KIND,
      summary: `${role ?? 'worker'} ${base}: a response exceeded its ${previous} output token cap; retrying once with ${next}`,
      data: { base, role, previous_cap: previous, new_cap: next, ceiling: OUTPUT_CAP_CEILING },
    },
    ctx.clock,
    { actor: ctx.ownerId },
  );
  return next;
}

function workerTimeoutMs(ctx: RunContext, role: WorkerRole): number {
  const ceiling = Math.min(ctx.timing.workerTimeoutMs, ROLE_WALL_CEILING_MS[role]);
  if (!ctx.ledger) return ceiling;
  const wall = ctx.ledger.state('wall_ms');
  return Math.max(60_000, Math.min(ceiling, wall.hard_cap - wall.used));
}

export function schemaFor(role: WorkerRole): object {
  return MODEL_OUTPUT_SCHEMAS[ROLE_OUTPUT_KIND[role]];
}

export function systemPromptFor(ctx: RunContext, role: WorkerRole): string {
  const overlay = activeOverlayFor(ctx, role);
  try {
    return renderSystemPrompt(role, { overlay, ...(ctx.deps.agentsDir ? { agentsDir: ctx.deps.agentsDir } : {}) });
  } catch (err) {
    // A malformed overlay is advisory text that failed its own checks; the base role prompt still stands.
    if (overlay && !isOrbitError(err, 'NOT_FOUND')) return renderSystemPrompt(role, ctx.deps.agentsDir ? { agentsDir: ctx.deps.agentsDir } : {});
    throw err;
  }
}

/** Same mapping recovery uses, so a result collected by either reads the same. */
export function outcomeOf(result: TaskResult): WorkerOutcome {
  const state = result.status === 'succeeded' ? 'SUCCEEDED' : result.status === 'cancelled' ? 'CANCELLED' : result.status === 'lost' ? 'LOST' : 'FAILED';
  return { state, exitCode: result.exitCode, resultStatus: result.status, result, error: result.error === null ? null : result.error.slice(0, 2000) };
}

/** The stored result of a finished worker, charged to the budget once. */
function accountFinished(ctx: RunContext, w: WorkerRecord, phase: BudgetPhase | undefined, fresh?: TaskResult): TaskResult {
  const result = fresh ?? storedResult(w);
  accountWorker(ctx, w, result, phase ?? 'work');
  return result;
}

export function storedResult(w: WorkerRecord): TaskResult {
  if (w.resultJson) {
    try {
      const r = JSON.parse(w.resultJson) as TaskResult | null;
      if (r && typeof r === 'object' && typeof r.status === 'string') return r;
    } catch {
      /* fall through to a synthetic result */
    }
  }
  return {
    status: w.resultStatus ?? (w.state === 'CANCELLED' ? 'cancelled' : 'lost'),
    structured: null,
    text: null,
    error: w.error,
    exitCode: w.exitCode,
    usage: emptyUsage(w.provider),
    durationMs: null,
  };
}

function emptyUsage(provider: string): UsageReport {
  return { provider, model: null, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null, costSource: 'unavailable' };
}

/**
 * Charge a finished worker's cost and record its usage, once. The ledger is
 * charged first: a crash between the two charges again on the next pass,
 * which overstates spend rather than hiding it. Before PLANNING initializes
 * the ledger, usage is only recorded; PLANNING charges it (prechargeUsage).
 */
export function accountWorker(ctx: RunContext, w: WorkerRecord, result: TaskResult, phase: BudgetPhase = 'work'): void {
  if (ctx.db.get('SELECT 1 AS x FROM usage WHERE run_id = ? AND worker_id = ? LIMIT 1', ctx.run.id, w.id)) return;
  // Denials inside the session (guard hook, permission rules) become policy.deny decisions before anything else.
  try {
    ingestWorkerDenials({ db: ctx.db, clock: ctx.clock, runId: ctx.run.id, runDir: ctx.runDir, actor: ctx.ownerId }, w);
  } catch (err) {
    ctx.log.warn('could not read the worker transcript for policy denials', { worker_id: w.id, error: messageOf(err) });
  }
  let usage = result.usage ?? emptyUsage(w.provider);
  // A session that failed before any request reached a model (refused at authentication, crashed at launch, exited
  // before any output) ran no model: its spend is a measured zero, not unknown. Charging it the session ceiling
  // let a reviewer outage exhaust the cap on spend that never happened (e2e retest NB2).
  if (ZERO_COST_STATUSES.has(result.status) && usage.costUsd === null && sessionSpentNothing(w, usage)) {
    usage = { ...usage, costUsd: 0, costSource: 'reported' };
    ctx.db.tx(() => appendEvent(ctx.db, ctx.run.id, 'budget.cost-zero-no-model', ctx.ownerId, { worker_id: w.id, role: w.role, status: result.status, provider: w.provider }, ctx.clock.now()));
  }
  if (ctx.ledger) {
    const cap = spendCapOf(ctx, w.id);
    // A lost session is charged its measured usage or at most the role ceiling: the restart that replaces it runs
    // under a cap of its own, and charging both at the full session cap would count one piece of work twice.
    const ceilingUsd = cap === null ? null : result.status === 'lost' ? Math.min(cap.ceilingUsd, ctx.ledger.roleCostCeiling(w.role)) : cap.ceilingUsd;
    try {
      ctx.ledger.consumeCost({ costUsd: usage.costUsd, costSource: usage.costSource }, w.role, { phase, ceilingUsd, tokenEstimate: tokenEstimateFor(ctx, w, usage) });
    } catch (err) {
      // The charge is recorded (and so is the exhaustion); an authentication failure still blocks on credentials,
      // which is the truthful cause, rather than ending the run EXHAUSTED on spend nobody can show happened.
      if (!(result.status === 'auth_failed' && isOrbitError(err, 'BUDGET_EXHAUSTED'))) throw err;
      ctx.log.warn('budget exhausted while charging an auth-failed session; blocking on credentials', { worker_id: w.id });
    }
  }
  recordUsage(ctx.db, { runId: ctx.run.id, workerId: w.id, provider: w.provider, model: usage.model ?? w.model, usage, durationMs: result.durationMs }, ctx.clock);
  // A model the provider actually ran on is validated on that surface; nothing else marks a model available.
  const observed = usage.model;
  if (observed && result.status === 'succeeded') {
    try {
      if (ctx.deps.registry.get(observed)) ctx.deps.registry.markAvailability(observed, w.provider.startsWith('codex') ? 'codex-cli' : 'claude-cli', true, `observed in worker ${w.id}`);
    } catch {
      /* the registry is advisory here; a failure to update it never fails the step */
    }
  }
}

/**
 * What a session's reported tokens would cost, for a provider that reported no cost: priced at the model's own
 * registry rate, or at the dearest listed rate when the model has none (never below what any known model charges).
 * Null when there is nothing to price (no tokens, or no model in the registry has a price).
 */
export function tokenEstimateFor(ctx: RunContext, w: Pick<WorkerRecord, 'provider' | 'model'>, usage: UsageReport): TokenEstimate | null {
  if (usage.costUsd !== null) return null;
  const model = usage.model ?? w.model;
  const own = model ? (ctx.deps.registry.get(model)?.pricing ?? null) : null;
  const pricing = own ?? dearestPricing(ctx.deps.registry.list().map((e) => e.pricing));
  const est = estimateCost(
    { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens },
    pricing,
    { inputIncludesCacheRead: inputIncludesCacheRead(w.provider.startsWith('codex') ? 'codex' : w.provider) },
  );
  if (est.costUsd === null) return null;
  return { costUsd: est.costUsd, basis: own ? 'model pricing' : 'dearest listed pricing', model };
}

/** Ends of a session that can come before any request reached a model; any other end may have spent. */
const ZERO_COST_STATUSES: ReadonlySet<string> = new Set(['auth_failed', 'failed', 'transient_error']);

/** Same test as sessionSpentNothing, kept under the name the authentication path has always used. */
export function authFailureSpentNothing(w: Pick<WorkerRecord, 'workerDir'>, usage: UsageReport): boolean {
  return sessionSpentNothing(w, usage);
}

/**
 * True when a session's transcripts show no request reached a model: no reported tokens and, in every transcript of
 * the worker (archived attempts included), no model output. For Claude that is no assistant message other than the
 * provider's API error message (or a result line reporting total_cost_usd 0 with empty modelUsage); for Codex, no
 * item other than an error and no completed turn. Without any transcript, a session whose exit record shows no
 * output at all (or that has none, because it never launched) spent nothing either.
 */
export function sessionSpentNothing(w: Pick<WorkerRecord, 'workerDir'>, usage: UsageReport): boolean {
  if ((usage.inputTokens ?? 0) > 0 || (usage.outputTokens ?? 0) > 0) return false;
  const logs = [join(w.workerDir, LOG_FILE)];
  for (let n = 1; existsSync(join(w.workerDir, 'attempts', String(n))); n++) logs.push(join(w.workerDir, 'attempts', String(n), LOG_FILE));
  const present = logs.filter((p) => existsSync(p));
  if (present.length === 0) return typeof readExitRecord(w.workerDir)?.firstOutputAt !== 'number';
  return present.every((p) => transcriptSpentNothing(readLogLines(p).events));
}

function transcriptSpentNothing(events: Record<string, unknown>[]): boolean {
  const result = events.filter((e) => e.type === 'result').at(-1);
  if (result) {
    const mu = result.modelUsage;
    const emptyUsageMap = mu === undefined || (typeof mu === 'object' && mu !== null && Object.keys(mu).length === 0);
    if (result.total_cost_usd === 0 && emptyUsageMap) return true;
    if (typeof result.total_cost_usd === 'number' && result.total_cost_usd > 0) return false;
  }
  return !events.some((e) => {
    if (e.type === 'assistant') return e.error === undefined && e.is_api_error_message !== true;
    if (e.type === 'stream_event' || e.type === 'turn.completed') return true;
    if (typeof e.type === 'string' && e.type.startsWith('item.')) {
      const item = e.item as { type?: unknown } | undefined;
      return !(item && typeof item === 'object' && item.type === 'error');
    }
    return false;
  });
}

/** Record a worker's spend cap before it starts, so the cost charged without a report is that cap plus one request. */
export function recordSpendCap(ctx: RunContext, purpose: string, capUsd: number, worstCaseUsd: number): void {
  ctx.db.tx(() => appendEvent(ctx.db, ctx.run.id, 'worker.spend-cap', ctx.ownerId, { purpose, cap_usd: capUsd, worst_case_usd: worstCaseUsd }, ctx.clock.now()));
}

function spendCapOf(ctx: RunContext, workerId: string): { ceilingUsd: number } | null {
  const w = ctx.db.get<{ purpose: string | null }>('SELECT purpose FROM workers WHERE id = ?', workerId);
  if (!w?.purpose) return null;
  const rows = ctx.db.all<{ data_json: string | null }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'worker.spend-cap' ORDER BY id DESC", ctx.run.id);
  for (const r of rows) {
    const d = r.data_json ? (JSON.parse(r.data_json) as { purpose?: string; cap_usd?: number; worst_case_usd?: number }) : {};
    if (d.purpose === w.purpose && typeof d.cap_usd === 'number') return { ceilingUsd: d.cap_usd + (d.worst_case_usd ?? 0) };
  }
  return null;
}

/** Caps (plus one worst-case request) of the run's sessions still running: spend already committed but not yet charged. */
export function committedSpendUsd(ctx: RunContext): number {
  let total = 0;
  for (const w of listActiveWorkers(ctx.db, ctx.run.id)) {
    const cap = spendCapOf(ctx, w.id);
    total += cap ? cap.ceilingUsd : (ctx.ledger?.roleCostCeiling(w.role) ?? ROLE_COST_CEILING_USD[w.role]);
  }
  return total;
}

/**
 * The spend cap for a new session and the worst-case request it may overshoot
 * by. Zero means the budget cannot fund the session. For a priced model the worst request is what that session
 * can really carry (worstCaseRequestUsd at its own cap and output cap), so the cap is solved for rather than a
 * full-window request subtracted (e2e retest NB3: that refused every implementer under a cap of about $7.50).
 */
export function sessionSpendCap(ctx: RunContext, model: string | null, role: WorkerRole, phase: BudgetPhase = 'work'): { capUsd: number | null; worstCaseUsd: number } {
  const entry = model ? ctx.deps.registry.get(model) : null;
  const outputTokens = entry ? sessionOutputTokens(ctx, entry, role) : null;
  if (!ctx.ledger) return { capUsd: null, worstCaseUsd: (entry ? worstCaseRequestUsd(entry, { outputTokens }) : null) ?? fallbackWorstCase(ctx, role) };
  const available = ctx.ledger.workerSpendCapUsd(0, phase, committedSpendUsd(ctx));
  const funded = entry ? fundedSessionCap(entry, available, { outputTokens }) : null;
  if (funded) return { capUsd: funded.capUsd, worstCaseUsd: funded.worstCaseUsd };
  const worst = fallbackWorstCase(ctx, role);
  return { capUsd: ctx.ledger.workerSpendCapUsd(worst, phase, committedSpendUsd(ctx)), worstCaseUsd: worst };
}

/**
 * Why a session of `model` cannot be funded, in dollars, for the stop reason: either the cap itself is below one
 * session's worst case (with nothing spent it could never start one), or what is left of it after spend, committed
 * sessions and the closing reserve is.
 */
export function unfundedSessionReason(ctx: RunContext, model: string | null, role: WorkerRole, phase: BudgetPhase = 'work'): string {
  const entry = model ? ctx.deps.registry.get(model) : null;
  const funded = entry ? fundedSessionCap(entry, 0, { outputTokens: sessionOutputTokens(ctx, entry, role) }) : null;
  const worst = funded ? funded.minimumUsd : fallbackWorstCase(ctx, role);
  if (!ctx.ledger) return `no model budget left, below one session's worst case $${dollars(worst)}`;
  const cost = ctx.ledger.state('cost_usd');
  const reserve = phase === 'final' ? 0 : ctx.ledger.reserve().cost_usd;
  const committed = committedSpendUsd(ctx);
  const plusReserve = reserve > 0 ? ` plus the $${dollars(reserve)} closing reserve` : '';
  if (cost.hard_cap - reserve < worst) return `cap $${dollars(cost.hard_cap)} is below one session's worst case $${dollars(worst)}${plusReserve}`;
  const left = Math.max(0, cost.hard_cap - reserve - cost.used - committed);
  const after = [`$${dollars(cost.used)} spent`, ...(committed > 0 ? [`$${dollars(committed)} committed to running sessions`] : []), ...(reserve > 0 ? [`the $${dollars(reserve)} closing reserve`] : [])];
  const list = after.length > 1 ? `${after.slice(0, -1).join(', ')} and ${after.at(-1)}` : after[0];
  return `no model budget left: $${dollars(left)} of the $${dollars(cost.hard_cap)} cap remains after ${list}, below one session's worst case $${dollars(worst)}`;
}

/** Without pricing for the model, a quarter of the role's cost ceiling stands in for one request. */
function fallbackWorstCase(ctx: RunContext, role: WorkerRole): number {
  return (ctx.ledger?.roleCostCeiling(role) ?? ROLE_COST_CEILING_USD[role]) / 4;
}

/**
 * The most one response of a session of `role` may produce: its configured output budget, raised at most once (a
 * doubled cap after an overflow, up to OUTPUT_CAP_CEILING). Claude Code enforces it per request; other providers
 * have no verified output cap, so their model's own limit stands.
 */
function sessionOutputTokens(ctx: RunContext, entry: { provider: string }, role: WorkerRole): number | null {
  if (entry.provider !== 'claude') return null;
  const configured = outputBudgets(ctx.snapshot.config)[role];
  if (typeof configured !== 'number' || !Number.isSafeInteger(configured) || configured < 1) return null;
  return Math.max(configured, Math.min(configured * 2, OUTPUT_CAP_CEILING));
}

function dollars(v: number): string {
  return v.toFixed(2);
}

/** Stop every live worker of the run (cancellation, a terminal outcome). Workers that cannot be stopped are reported, not hidden. */
export async function stopActiveWorkers(ctx: RunContext, reason: string): Promise<string[]> {
  const failed: string[] = [];
  for (const w of listActiveWorkers(ctx.db, ctx.run.id)) {
    try {
      await stopWorker({ db: ctx.db, clock: ctx.clock, ownerId: ctx.ownerId, adapters: ctx.deps.adapters, graceMs: ctx.timing.killGraceMs }, w, reason);
    } catch (err) {
      failed.push(`${w.id}: ${messageOf(err)}`);
    }
  }
  return failed;
}

// ---------------------------------------------------------------------------
// Routing

export interface RouteChoice {
  provider: string;
  model: string | null;
  effort: string | null;
  workKind: WorkKind;
  decisionId: string;
}

/**
 * Route a work unit once and record why. The decision id is derived from the
 * purpose, so a retried step reuses the recorded route instead of routing
 * again on a registry that may have changed meanwhile.
 */
export function routeFor(ctx: RunContext, purpose: string, workKind: WorkKind, signals: RouteSignals): RouteChoice {
  const decisionId = `dec-route-${ctx.run.id}-${purpose.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const prior = getDecision(ctx.db, decisionId);
  if (prior) {
    const d = prior.data as { provider: string; model: string | null; effort: string | null };
    return { provider: d.provider, model: d.model, effort: d.effort, workKind, decisionId };
  }
  const config = ctx.snapshot.config;
  try {
    const decision = route({ workKind, signals, registry: ctx.deps.registry, policy: config, outcomes: routeStats(ctx.db, { workKind }) });
    const rec = toDecisionRecord(decision);
    recordDecision(ctx.db, ctx.runDir, { id: decisionId, runId: ctx.run.id, kind: rec.kind, summary: `${purpose}: ${rec.summary}`.slice(0, 500), data: { ...rec.data, purpose } }, ctx.clock);
    return { provider: decision.provider, model: decision.model, effort: decision.effort, workKind, decisionId };
  } catch (err) {
    if (!isOrbitError(err, 'PROVIDER_UNAVAILABLE')) throw err;
    // No model is validated on the CLI yet (nothing has run). Choose an allowed, seeded model and say it is
    // unvalidated; the first successful run validates it from the model the provider reports.
    const fallback = unvalidatedChoice(ctx, signals);
    if (!fallback) throw err;
    recordDecision(
      ctx.db,
      ctx.runDir,
      {
        id: decisionId,
        runId: ctx.run.id,
        kind: 'route',
        summary: `${purpose}: ${fallback.model} (allowed but not yet validated on claude-cli; ${messageOf(err)})`.slice(0, 500),
        data: { kind: 'route', provider: 'claude', model: fallback.model, effort: fallback.effort, work_kind: workKind, purpose, unvalidated: true, reason: messageOf(err) },
      },
      ctx.clock,
    );
    return { provider: 'claude', model: fallback.model, effort: fallback.effort, workKind, decisionId };
  }
}

function unvalidatedChoice(ctx: RunContext, signals: RouteSignals): { model: string; effort: string | null } | null {
  const config = ctx.snapshot.config;
  const configured = config.providers.claude?.model ?? null;
  const entries = ctx.deps.registry
    .list()
    .filter((e) => e.provider === 'claude' && e.surfaces.some((s) => s.surface === 'claude-cli' && s.available !== false))
    .filter((e) => allowMatch(e, config.routing.allowed_models) === 'explicit');
  if (configured) {
    const hit = entries.find((e) => e.modelId === configured || e.eligibility.aliases.includes(configured) || e.eligibility.cliAlias === configured);
    if (hit) return { model: hit.modelId, effort: config.providers.claude?.reasoning_effort ?? null };
  }
  // Sonnet-class first (spec section 8 default for routine work), escalating only on repeated evidence-backed failures.
  const wanted = signals.repeatedFingerprints >= (config.scheduler.repeated_failure_threshold ?? 2) && (signals.evidence?.length ?? 0) > 0 ? 3 : 2;
  const ranked = [...entries].sort((a, b) => Math.abs((tierOf(a) ?? 9) - wanted) - Math.abs((tierOf(b) ?? 9) - wanted) || a.modelId.localeCompare(b.modelId));
  const pick = ranked[0];
  return pick ? { model: pick.modelId, effort: config.providers.claude?.reasoning_effort ?? null } : null;
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Collect a worker some other component started (the Inquisition engine
 * runs its own inquisitor workers). After a controller restart nothing else
 * would notice it finished. Returns true while it is still running.
 */
export async function collectIfFinished(ctx: RunContext, w: WorkerRecord): Promise<boolean> {
  if (w.state === 'PLANNED') {
    // Intent without a launch: nothing ran, so the owner may simply start over.
    if (!existsSync(join(w.workerDir, LAUNCH_FILE))) {
      finishWorker(ctx.db, w.id, { state: 'CANCELLED', resultStatus: 'cancelled', error: 'never started before the controller restarted' }, ctx.clock, ctx.ownerId);
      return false;
    }
    if (!handleOf(adapterFor(ctx, w.provider), w)) return true;
    const h = handleOf(adapterFor(ctx, w.provider), w)!;
    markWorkerRunning(ctx.db, w.id, { pid: h.pid, pgid: h.pgid, procStart: h.procStart }, ctx.clock, ctx.ownerId);
    return collectIfFinished(ctx, getWorker(ctx.db, w.id));
  }
  if (w.state !== 'RUNNING') return false;
  const adapter = adapterFor(ctx, w.provider);
  const handle = handleOf(adapter, w);
  if (!handle) {
    finishWorker(ctx.db, w.id, { state: 'LOST', resultStatus: 'lost', error: 'the worker directory has no pid.json' }, ctx.clock, ctx.ownerId);
    return false;
  }
  const result = await adapter.collectResult(handle, { outputSchema: schemaFor(w.role) });
  if (!result) return true;
  const row = finishWorker(ctx.db, w.id, outcomeOf(result), ctx.clock, ctx.ownerId);
  accountWorker(ctx, row, result);
  return false;
}
