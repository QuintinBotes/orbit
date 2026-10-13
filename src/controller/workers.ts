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
import { findWorker, finishWorker, getWorker, isWorkerActive, listActiveWorkers, listWorkers, markWorkerRunning, planWorker, type WorkerOutcome, type WorkerRecord } from '../storage/workers.ts';
import type { OrbitDb } from '../storage/db.ts';
import type { ProviderAdapter, TaskHandle, TaskResult, TaskSpec, UsageReport, WorkerRole } from '../adapters/types.ts';
import { claudeModelRequests, claudeSessionId, type ClaudeTaskResult } from '../adapters/claude-transcript.ts';
import { archiveAttempt, handleFromWorkerDir, LAUNCH_FILE, readLogLines } from '../adapters/supervise.ts';
import { LOG_FILE, readExitRecord } from '../adapters/shim.ts';
import { renderSystemPrompt, ROLE_OUTPUT_KIND } from '../adapters/prompt.ts';
import { MODEL_OUTPUT_SCHEMAS } from '../contract/model-outputs.ts';
import { PROVIDER_HOSTS, profileForWorker, workerAllowedHosts, workerTmpDir } from '../isolation/profiles.ts';
import { detectToolchains, prepareToolchainLayout, toolchainLayout } from '../isolation/toolchains.ts';
import { stopLaunch, stopWorker, WORKER_RESTART_EVENT } from '../recovery/reconcile.ts';
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
    const stopped = await stopAndSettle(ctx, w, 'cancellation requested', req.phase ?? 'work');
    return { status: 'finished', worker: stopped, result: storedResult(stopped) };
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
  // The result, its usage record and its charge commit together: a controller that dies between them leaves the worker
  // to be collected again, never a stored result with its spend unrecorded.
  const row = settleSession(ctx, w, result, req.phase ?? 'work', { finish: () => finishWorker(ctx.db, w.id, outcomeOf(result), ctx.clock, ctx.ownerId) });
  return { status: 'finished', worker: row, result };
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
      // A shim that never wrote pid.json may still run: it is stopped before a second one starts beside it.
      if ((await stopLaunch(ctx.timing.killGraceMs, w.workerDir)) === 'unknown') {
        throw new OrbitError('TRANSITION_INVALID', `worker ${w.id}: the shim of its earlier launch never wrote pid.json and could not be verified or stopped; nothing is started beside it`, { workerId: w.id });
      }
      archiveAttempt(w.provider, w.workerDir);
      assertMayStart(ctx);
      handle = await adapter.startTask(spec);
    } else {
      // A launch whose shim never wrote pid.json (launchShim stops one it can identify) must not leave it running: a row
      // recorded FAILED while it runs on would let its checkout be released beneath it. One that cannot be confirmed
      // stopped keeps the row PLANNED, for the next observation or recovery to settle.
      if ((await stopLaunch(ctx.timing.killGraceMs, w.workerDir)) === 'unknown') throw err;
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
  // (docs/decisions/0009-toolchain-profiles.md). The worker keeps the real HOME its provider CLI needs. The hosts its
  // sandbox allows decide whether NuGet's vulnerability audit can run there; a Codex worker, a read-only reviewer, is
  // confined to its provider's hosts by its adapter (codexReviewerProfile).
  const toolchains = toolchainLayout({
    toolchains: detectToolchains({ roots: [req.cwd] }),
    mode: 'worker',
    cacheRoot: toolchainCacheRootFor(ctx),
    scratchRoot: join(w.workerDir, 'toolchains'),
    tmpDir: workerTmpDir(w.workerDir),
    hostHome: home,
    hostEnv: env,
    networkHosts: provider === 'codex' ? PROVIDER_HOSTS.codex : workerAllowedHosts(provider, policy.snapshot),
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
    nisDomainName: toolchains.nisDomainName,
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
 * Record a finished session's usage and charge it to the budget, once. The usage record, the charge and the mark that
 * says the record is charged (USAGE_CHARGED_EVENT) commit together, also when the charge exhausts the budget: the
 * session whose charge crossed the cap is the one the spend line most needs to name. A session whose usage is already
 * recorded (by the Inquisition, or before PLANNING created the budget) is charged from that record, if no charge mark
 * covers it yet. Before PLANNING initializes the ledger, usage is only recorded; PLANNING charges it (prechargeUsage).
 */
export function accountWorker(ctx: RunContext, w: WorkerRecord, result: TaskResult, phase: BudgetPhase = 'work'): void {
  settleSession(ctx, w, result, phase);
}

/**
 * accountWorker, and when `finish` is given, the call that records the session's result too, in the same transaction:
 * a controller that dies between them leaves either neither (the worker is collected again) or both. Returns the
 * worker as `finish` left it.
 */
function settleSession(ctx: RunContext, w: WorkerRecord, result: TaskResult, phase: BudgetPhase, opts: { finish?: () => WorkerRecord; charge?: boolean } = {}): WorkerRecord {
  const out = settle(ctx, w, result, phase, opts);
  if (out.refused) throw out.refused;
  return out.row;
}

/**
 * Record a finished session's result, usage and charge in one transaction: `outcome` is what the row is finished with,
 * `result` what the session reported (a lost session's is an empty report, charged as unmeasured). For a component that
 * ends a session itself (the curator) and has no worker request to go through ensureWorker with.
 */
export function finishAndSettle(ctx: RunContext, w: WorkerRecord, result: TaskResult, outcome: WorkerOutcome, phase: BudgetPhase = 'work'): WorkerRecord {
  return settleSession(ctx, w, result, phase, { finish: () => finishWorker(ctx.db, w.id, outcome, ctx.clock, ctx.ownerId) });
}

/**
 * Stop a worker (stopWorker) and settle it in the transaction that records it stopped: its result, its usage and its
 * charge, also for a session with nothing to collect, which is charged as unmeasured (its cap). A worker stopped
 * mid-run (obsolete work, a cancelled unit, an exploration out of time) is no longer counted as committed spend once it
 * stops, so it is charged then, before the next session is funded, not when the run ends. A charge that exhausts the
 * budget is raised after the stop is recorded.
 */
export async function stopAndSettle(ctx: RunContext, w: WorkerRecord, reason: string, phase: BudgetPhase = 'work'): Promise<WorkerRecord> {
  let refused: OrbitError | null = null;
  const row = await stopWorker({ db: ctx.db, clock: ctx.clock, ownerId: ctx.ownerId, adapters: ctx.deps.adapters, graceMs: ctx.timing.killGraceMs }, w, reason, {
    finish: (outcome, result) => {
      const out = settle(ctx, w, result ?? endedWithoutResult(w, outcome), phase, { finish: () => finishWorker(ctx.db, w.id, outcome, ctx.clock, ctx.ownerId) });
      refused = out.refused;
      return out.row;
    },
  });
  if (refused) throw refused;
  return row;
}

/** What a session ended with when nothing could be collected: the result storedResult reads back for its row. */
function endedWithoutResult(w: WorkerRecord, outcome: WorkerOutcome): TaskResult {
  return { status: outcome.resultStatus ?? 'lost', structured: null, text: null, error: outcome.error ?? null, exitCode: outcome.exitCode ?? null, usage: emptyUsage(w.provider), durationMs: null };
}

interface Settled {
  row: WorkerRecord;
  /** Whether a usage record was written or a charge made. */
  changed: boolean;
  refused: OrbitError | null;
}

function settle(ctx: RunContext, w: WorkerRecord, result: TaskResult, phase: BudgetPhase, opts: { finish?: () => WorkerRecord; charge?: boolean } = {}): Settled {
  accountWorkerTurns(ctx, w, result);
  if (!hasUsage(ctx, w.id)) {
    // Denials inside the session (guard hook, permission rules) become policy.deny decisions before anything else.
    try {
      ingestWorkerDenials({ db: ctx.db, clock: ctx.clock, runId: ctx.run.id, runDir: ctx.runDir, actor: ctx.ownerId }, w);
    } catch (err) {
      ctx.log.warn('could not read the worker transcript for policy denials', { worker_id: w.id, error: messageOf(err) });
    }
  }
  const ledger = opts.charge === false ? null : ctx.ledger;
  const out = ctx.db.tx((): { row: WorkerRecord; usage: UsageReport | null; changed: boolean; refused: OrbitError | null } => {
    // Before this session's record is written: a budget from before 0.3.1 has its charged records marked first, so the
    // record written here is never read as one of them.
    adoptLegacyCharges(ctx);
    const row = opts.finish ? opts.finish() : w;
    let fresh: { id: number; usage: UsageReport } | null = null;
    // Asked again inside the transaction: another controller settling the same ended run may have recorded it.
    if (!hasUsage(ctx, w.id)) {
      const usage = measuredUsage(ctx, row, result.status, result.usage ?? emptyUsage(w.provider));
      fresh = { id: recordUsage(ctx.db, { runId: ctx.run.id, workerId: w.id, provider: w.provider, model: usage.model ?? w.model, usage, durationMs: result.durationMs }, ctx.clock).id, usage };
    }
    let refused: OrbitError | null = null;
    let charged = 0;
    if (ledger) {
      for (const r of unchargedUsageRows(ctx, ' AND u.worker_id = ?', w.id)) {
        // The record just written is charged from the session's own usage, as reported: recordUsage may have priced it
        // from the registry, and a charge from tokens says so (budget.cost-token-estimated).
        const e = chargeUsageRow(ctx, ledger, r, phase, { status: result.status, usage: r.id === fresh?.id ? fresh.usage : null, source: r.id === fresh?.id ? 'collected' : 'recorded' });
        refused ??= e;
        charged++;
      }
    }
    return { row, usage: fresh?.usage ?? null, changed: fresh !== null || charged > 0, refused };
  });
  // A model the provider actually ran on is validated on that surface; nothing else marks a model available.
  const observed = out.usage?.model;
  if (observed && result.status === 'succeeded') {
    try {
      if (ctx.deps.registry.get(observed)) ctx.deps.registry.markAvailability(observed, w.provider.startsWith('codex') ? 'codex-cli' : 'claude-cli', true, `observed in worker ${w.id}`);
    } catch {
      /* the registry is advisory here; a failure to update it never fails the step */
    }
  }
  return { row: out.row, changed: out.changed, refused: out.refused };
}

/**
 * Whether the worker's current session has its usage recorded. A record of an attempt that was lost and restarted on the
 * same row (WORKER_RESTART_EVENT names it) is an earlier session's.
 */
function hasUsage(ctx: RunContext, workerId: string): boolean {
  const earlier = lostAttemptUsageIds(ctx.db, ctx.run.id, workerId);
  return ctx.db.all<{ id: number }>('SELECT id FROM usage WHERE run_id = ? AND worker_id = ?', ctx.run.id, workerId).some((r) => !earlier.has(r.id));
}

/** The usage records of lost attempts reconciliation restarted on the same row, of one worker or of the whole run. */
function lostAttemptUsageIds(db: OrbitDb, runId: string, workerId?: string): Set<number> {
  const rows = db.all<{ id: unknown }>(
    `SELECT json_extract(data_json, '$.usage_id') AS id FROM events WHERE run_id = ? AND type = ? AND json_extract(data_json, '$.usage_id') IS NOT NULL${workerId === undefined ? '' : " AND json_extract(data_json, '$.worker_id') = ?"}`,
    runId,
    WORKER_RESTART_EVENT,
    ...(workerId === undefined ? [] : [workerId]),
  );
  return new Set(rows.map((r) => r.id).filter((id): id is number => typeof id === 'number'));
}

/**
 * The usage a finished session is charged and recorded with. A session that failed before any request reached a
 * model (refused at authentication, crashed at launch, exited before any output) ran no model: its spend is a
 * measured zero, not unknown, recorded as budget.cost-zero-no-model. Charging it the session ceiling let a reviewer
 * outage exhaust the cap on spend that never happened (e2e retest NB2).
 */
function measuredUsage(ctx: RunContext, w: WorkerRecord, status: string, usage: UsageReport): UsageReport {
  if (!(ZERO_COST_STATUSES.has(status) && usage.costUsd === null && sessionSpentNothing(w, usage))) return usage;
  ctx.db.tx(() => appendEvent(ctx.db, ctx.run.id, 'budget.cost-zero-no-model', ctx.ownerId, { worker_id: w.id, role: w.role, status, provider: w.provider }, ctx.clock.now()));
  return { ...usage, costUsd: 0, costSource: 'reported' };
}

/**
 * The spend cap a session ran under, which a session that reported neither cost nor tokens is charged. A lost
 * session is charged at most the role ceiling: the restart that replaces it runs under a cap of its own, and
 * charging both at the full session cap would count one piece of work twice. Null when none was recorded.
 */
function sessionCeilingUsd(ctx: RunContext, w: WorkerRecord, status: string): number | null {
  const cap = spendCapOf(ctx, w.id);
  if (cap === null || !ctx.ledger) return null;
  return status === 'lost' ? Math.min(cap.ceilingUsd, ctx.ledger.roleCostCeiling(w.role)) : cap.ceilingUsd;
}

/**
 * Whether a charge that exhausted the budget still leaves the session's own outcome standing: the charge is
 * recorded (and so is the exhaustion), but an authentication failure blocks on credentials, which is the truthful
 * cause, rather than ending the run EXHAUSTED on spend nobody can show happened.
 */
function blocksOnCredentials(ctx: RunContext, w: WorkerRecord, status: string): boolean {
  if (status !== 'auth_failed') return false;
  ctx.log.warn('budget exhausted while charging an auth-failed session; blocking on credentials', { worker_id: w.id });
  return true;
}

/**
 * A Claude session's turns are its model requests, the count --max-turns limits; the result's num_turns counts the
 * prompt and every tool result, so a session with parallel tool calls reported 61 under a cap of 30 it kept. A result
 * stored without a request count (before 0.3.1, which recorded num_turns as the session's turns) is counted from the
 * session's transcript, and that count replaces what was recorded. Only without a transcript is num_turns kept, and
 * then as num_turns, never as model requests or against the cap. Missing counts stay unmeasured.
 */
export function accountWorkerTurns(ctx: Pick<RunContext, 'ledger'>, w: WorkerRecord, result: TaskResult): void {
  const ledger = ctx.ledger;
  const { numTurns, modelRequests, sessionId } = result as Partial<ClaudeTaskResult>;
  // Only a classified Claude result has turns; one synthesized for a worker without a stored result has none.
  if (!ledger || !/^claude(?:$|[-_])/.test(w.provider) || numTurns === undefined) return;
  const session = `${w.id}:${typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : `restart-${w.restartCount}`}`;
  const endedByCap = result.status === 'max_turns';
  if (isCount(modelRequests)) {
    ledger.recordSessionTurns(session, modelRequests, { endedByCap });
    return;
  }
  const counted = transcriptModelRequests(w, sessionId ?? null);
  if (isCount(counted)) ledger.recordSessionTurns(session, counted, { endedByCap, recount: true });
  else if (isCount(numTurns)) ledger.recordSessionNumTurns(session, numTurns);
}

/**
 * The model requests in the transcript of session `sessionId`: the worker's own log, or an archived attempt's, whose
 * session it is (the current log when the result named no session). Null without one, or without any message in it.
 */
function transcriptModelRequests(w: Pick<WorkerRecord, 'workerDir'>, sessionId: string | null): number | null {
  const [current, ...archived] = workerLogs(w);
  for (const p of sessionId ? [current!, ...archived] : [current!]) {
    if (!existsSync(p)) continue;
    const { events } = readLogLines(p);
    if (sessionId && claudeSessionId(events) !== sessionId) continue;
    return claudeModelRequests(events);
  }
  return null;
}

/** Every transcript a worker left: its current log first, then each archived attempt's. */
function workerLogs(w: Pick<WorkerRecord, 'workerDir'>): string[] {
  const logs = [join(w.workerDir, LOG_FILE)];
  for (let n = 1; existsSync(join(w.workerDir, 'attempts', String(n))); n++) logs.push(join(w.workerDir, 'attempts', String(n), LOG_FILE));
  return logs;
}

function isCount(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

/**
 * Marks usage records as charged to cost_usd, with the usage ids it covers. Every charge of a usage record appends one
 * in the transaction that charges it, whichever path charged it, so it is the one answer to "already charged?".
 */
export const USAGE_CHARGED_EVENT = 'budget.usage-charged';

/**
 * Which path charged a record: `collected` when its session's usage was recorded and charged together, `recorded` when
 * the record was written earlier (by the Inquisition, which records its inquisitors' usage itself, or by reconciliation
 * for a lost attempt it restarted) and charged later, `precharge` when PLANNING charged it on creating the budget.
 * `legacy` marks, once, the records a budget from before 0.3.1 charged without marking them (adoptLegacyCharges); it
 * charges nothing.
 */
export type ChargeSource = 'collected' | 'recorded' | 'precharge' | 'legacy';

export interface UsageRow {
  id: number;
  worker_id: string | null;
  provider: string;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
  cost_source: string;
  role: string | null;
}

/** The run's usage records with their worker's role, oldest first; `where` narrows them further. */
export function usageRows(ctx: RunContext, where = '', ...params: (string | number)[]): UsageRow[] {
  return ctx.db.all<UsageRow>(
    `SELECT u.id, u.worker_id, u.provider, u.model, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens, u.cost_usd, u.cost_source, w.role FROM usage u LEFT JOIN workers w ON w.id = u.worker_id WHERE u.run_id = ?${where} ORDER BY u.id`,
    ctx.run.id,
    ...params,
  );
}

/** The run's usage records no charge covers yet (chargedUsageIds), oldest first; `where` narrows them further. */
export function unchargedUsageRows(ctx: RunContext, where = '', ...params: (string | number)[]): UsageRow[] {
  const charged = chargedUsageIds(ctx);
  return usageRows(ctx, where, ...params).filter((r) => !charged.has(r.id));
}

/**
 * The usage records already charged to cost_usd: those a USAGE_CHARGED_EVENT marks. A budget from before 0.3.1 has the
 * records it charged marked first (adoptLegacyCharges), so marks are the only answer.
 */
export function chargedUsageIds(ctx: RunContext): Set<number> {
  adoptLegacyCharges(ctx);
  return markedUsageIds(ctx.db, ctx.run.id);
}

function markedUsageIds(db: OrbitDb, runId: string): Set<number> {
  const ids = new Set<number>();
  for (const e of db.all<{ data_json: string | null }>('SELECT data_json FROM events WHERE run_id = ? AND type = ?', runId, USAGE_CHARGED_EVENT)) {
    const d = e.data_json ? (JSON.parse(e.data_json) as { usage_ids?: unknown }) : {};
    for (const id of Array.isArray(d.usage_ids) ? d.usage_ids : []) if (typeof id === 'number') ids.add(id);
  }
  return ids;
}

/**
 * Mark, once, the usage records a budget created before 0.3.1 charged without marking them: one USAGE_CHARGED_EVENT
 * with source `legacy`, which is also the sign that it was done. From then on only marks say what is charged, so a
 * record written after the upgrade is charged like any other (0.3.0's rule, read for every record, took each later
 * record but an inquisitor's as charged and never charged it). Two budgets are from before 0.3.1:
 *
 *   - PLANNING's precharge recorded without `usage_marked`. It charged every record written by then (its `usage_rows`
 *     records, oldest first), and afterwards 0.3.0 charged each session it collected and then recorded it, which was
 *     every session but an inquisitor's (the Inquisition recorded those, and nothing charged them).
 *   - A 0.3.0 precharge cut short: no budget.precharged, no marks, cost_usd already used, and the run never past
 *     PLANNING. 0.3.0 committed each record's charge on its own, oldest first, so the oldest records whose charges add
 *     up to what was used are charged.
 *
 * A record reconciliation wrote for a lost attempt it restarted is 0.3.1's and never one of them. Idempotent; runs in a
 * transaction of its own or the caller's.
 */
export function adoptLegacyCharges(ctx: RunContext): void {
  const { db } = ctx;
  const runId = ctx.run.id;
  const pre = db.get<{ ts: number; data_json: string | null }>("SELECT ts, data_json FROM events WHERE run_id = ? AND type = 'budget.precharged' ORDER BY id LIMIT 1", runId);
  const data = pre?.data_json ? (JSON.parse(pre.data_json) as { through_usage_id?: unknown; usage_rows?: unknown; usage_marked?: unknown }) : {};
  if (pre && data.usage_marked === true) return;
  // Without budget.precharged, a precharge cut short is the only way cost_usd has spend no mark accounts for, and only
  // on a run that never got past PLANNING (every run past it has budget.precharged).
  const spent = pre ? null : (db.get<{ used: number }>("SELECT used FROM budget_counters WHERE run_id = ? AND counter = 'cost_usd'", runId)?.used ?? 0);
  if (spent !== null && !(spent > 1e-9)) return;
  if (legacyAdopted(db, runId)) return;
  if (!pre && db.get("SELECT 1 AS x FROM events WHERE run_id = ? AND type = 'state.transition' AND from_state = 'PLANNING' AND to_state = 'IMPLEMENTING' LIMIT 1", runId)) return;
  db.tx(() => {
    if (legacyAdopted(db, runId)) return;
    const marked = markedUsageIds(db, runId);
    // Charges that marked their records are 0.3.1's: nothing was cut short.
    if (!pre && marked.size > 0) return;
    const restarted = lostAttemptUsageIds(db, runId);
    const all = usageRows(ctx).filter((r) => !restarted.has(r.id));
    const rows = all.filter((r) => !marked.has(r.id));
    let ids: number[];
    let basis: Record<string, unknown>;
    if (pre) {
      const through = prechargeThrough(ctx, all, pre.ts, data);
      ids = rows.filter((r) => r.id <= through || r.role !== 'inquisitor').map((r) => r.id);
      basis = { basis: 'precharge-unmarked', through_usage_id: through };
    } else {
      const through = oldestCovering(ctx, rows, spent!);
      ids = rows.filter((r) => r.id <= through).map((r) => r.id);
      basis = { basis: 'precharge-cut-short', used_usd: Math.round(spent! * 1e6) / 1e6 };
    }
    appendEvent(db, runId, USAGE_CHARGED_EVENT, ctx.ownerId, { worker_id: null, role: null, usage_ids: ids, charged_usd: null, source: 'legacy' satisfies ChargeSource, ...basis }, ctx.clock.now());
  });
}

function legacyAdopted(db: OrbitDb, runId: string): boolean {
  return db.get("SELECT 1 AS x FROM events WHERE run_id = ? AND type = ? AND json_extract(data_json, '$.source') = 'legacy' LIMIT 1", runId, USAGE_CHARGED_EVENT) !== undefined;
}

/**
 * The newest usage id a precharge recorded before 0.3.1 covered. It charged every record the run had, oldest first: the
 * one it names; else the oldest records whose charges add up to what it says it charged (`charged_usd`), or the
 * `usage_rows` oldest it says it charged, whichever reaches further; else every record written by then.
 */
function prechargeThrough(ctx: RunContext, rows: readonly UsageRow[], ts: number, d: { through_usage_id?: unknown; usage_rows?: unknown; charged_usd?: unknown }): number {
  if (typeof d.through_usage_id === 'number') return d.through_usage_id;
  const counted = typeof d.usage_rows === 'number' && Number.isSafeInteger(d.usage_rows) && d.usage_rows > 0 ? (rows[Math.min(d.usage_rows, rows.length) - 1]?.id ?? 0) : 0;
  if (typeof d.charged_usd === 'number' && Number.isFinite(d.charged_usd)) return Math.max(counted, oldestCovering(ctx, rows, d.charged_usd));
  const written = ctx.db.get<{ id: number | null }>('SELECT MAX(id) AS id FROM usage WHERE run_id = ? AND ts <= ?', ctx.run.id, ts)?.id ?? 0;
  return Math.max(counted, written);
}

/**
 * The newest of the oldest records whose 0.3.0 charges add up to `amount` (0 when none does): 0.3.0's precharge charged
 * the records in order, each its cost, else what its tokens would cost, else its role's ceiling. A record that costs
 * nothing right after them is covered too, which charges nothing either way.
 */
function oldestCovering(ctx: RunContext, rows: readonly UsageRow[], amount: number): number {
  let sum = 0;
  let through = 0;
  for (const r of rows) {
    const est = r.cost_usd === null ? tokenEstimateFor(ctx, r, { provider: r.provider, model: r.model, inputTokens: r.input_tokens, outputTokens: r.output_tokens, cacheReadTokens: r.cache_read_tokens, cacheWriteTokens: r.cache_write_tokens, costUsd: null, costSource: 'unavailable' }) : null;
    const role = (r.role as WorkerRole | null) ?? 'planner';
    const charge = r.cost_usd ?? est?.costUsd ?? (ctx.ledger ? ctx.ledger.roleCostCeiling(role) : ROLE_COST_CEILING_USD[role]);
    if (sum + charge > amount + 1e-6) break;
    sum += charge;
    through = r.id;
  }
  return through;
}

/**
 * Charge `rows` and mark each one charged, inside the caller's transaction. Returns the first charge that exhausted the
 * budget for the caller to raise once its transaction commits, so every charge, its mark and the caller's own records
 * commit together and none is replayed.
 */
export function chargeUsageRows(ctx: RunContext, ledger: NonNullable<RunContext['ledger']>, rows: readonly UsageRow[], phase: BudgetPhase, source: ChargeSource): OrbitError | null {
  let refused: OrbitError | null = null;
  for (const r of rows) {
    // Every record is charged, also after one exhausted the budget: each is spend that happened.
    const e = chargeUsageRow(ctx, ledger, r, phase, { source });
    refused ??= e;
  }
  return refused;
}

/**
 * Charge one usage record as accountWorker charges a session, and mark it charged: its cost, a measured zero for a
 * session that never reached a model (the record is corrected to say so, as accountWorker records it), else what its
 * tokens would cost, else the spend cap it ran under or the role ceiling. The correction, the charge and the mark commit
 * together. A charge that exhausts the budget is returned, not thrown, so it commits; one for an auth-failed session is
 * not returned at all, so the run blocks on credentials. `usage` is the session's own report, for a record just written
 * from it; `status` is the session's end when the caller has it.
 */
function chargeUsageRow(ctx: RunContext, ledger: NonNullable<RunContext['ledger']>, r: UsageRow, phase: BudgetPhase, opts: { source: ChargeSource; status?: string; usage?: UsageReport | null }): OrbitError | null {
  const w = r.worker_id === null ? null : findWorker(ctx.db, r.worker_id);
  // A lost attempt's record (reconciliation restarted the row) ended lost, whatever the row's current session did.
  const lostAttempt = r.worker_id !== null && lostAttemptUsageIds(ctx.db, ctx.run.id, r.worker_id).has(r.id);
  const status = lostAttempt ? 'lost' : (opts.status ?? (w ? storedResult(w).status : null));
  return ctx.db.tx((): OrbitError | null => {
    let usage: UsageReport = opts.usage ?? { provider: r.provider, model: r.model, inputTokens: r.input_tokens, outputTokens: r.output_tokens, cacheReadTokens: r.cache_read_tokens, cacheWriteTokens: r.cache_write_tokens, costUsd: r.cost_usd, costSource: r.cost_source as UsageReport['costSource'] };
    if (!opts.usage && w && status !== null) {
      usage = measuredUsage(ctx, w, status, usage);
      if (usage.costUsd !== r.cost_usd) ctx.db.run('UPDATE usage SET cost_usd = ?, cost_source = ? WHERE id = ?', usage.costUsd, usage.costSource, r.id);
    }
    let charged: number | null = null;
    let refused: OrbitError | null = null;
    try {
      charged = ledger.consumeCost({ costUsd: usage.costUsd, costSource: usage.costSource }, (r.role as WorkerRole | null) ?? 'planner', {
        phase,
        ceilingUsd: w && status !== null ? sessionCeilingUsd(ctx, w, status) : null,
        tokenEstimate: tokenEstimateFor(ctx, r, usage),
        workerId: r.worker_id,
      }).charged;
    } catch (err) {
      // Returned, not thrown: the charge the ledger recorded and its mark must commit.
      if (!isOrbitError(err, 'BUDGET_EXHAUSTED')) throw err;
      // A cost charge is recorded before the exhaustion is raised; the error carries what it recorded.
      const requested = err.details?.requested;
      charged = typeof requested === 'number' ? requested : null;
      refused = w && status !== null && blocksOnCredentials(ctx, w, status) ? null : err;
    }
    appendEvent(ctx.db, ctx.run.id, USAGE_CHARGED_EVENT, ctx.ownerId, { worker_id: r.worker_id, role: r.role, usage_ids: [r.id], charged_usd: charged === null ? null : Math.round(charged * 1e6) / 1e6, source: opts.source }, ctx.clock.now());
    return refused;
  });
}

/**
 * Record and charge, once, the usage of a session some other component ended: the Inquisition, which records its
 * inquisitors' usage itself and never charged it (0.3.0: every python run's charge fell short of its measured spend by
 * exactly its inquisitors), or reconciliation and the watchdog, which store a collected result and record no usage (a
 * $0.75 inquisitor reconciliation collected on restart, whose result the engine then reused, was never recorded or
 * charged). A session with a stored result and no usage record has its usage recorded from that result first. Before
 * PLANNING creates the budget nothing is charged here; PLANNING charges it, and what it charged is not charged again.
 */
export function chargeRecordedUsage(ctx: RunContext, w: WorkerRecord, phase: BudgetPhase = 'work'): void {
  if (!hasUsage(ctx, w.id) && !hasCollectedResult(w)) return;
  settleSession(ctx, w, storedResult(w), phase);
}

/**
 * Record, without charging, the usage of a session whose result was stored with no usage record (one reconciliation
 * collected after a restart); before PLANNING creates the budget, whose precharge then charges it with the rest.
 */
export function recordStoredUsage(ctx: RunContext, w: WorkerRecord): void {
  if (hasUsage(ctx, w.id) || !hasCollectedResult(w)) return;
  settleSession(ctx, w, storedResult(w), 'work', { charge: false });
}

/**
 * Every session of the run recorded and charged, whatever collected it: one no step looked at again (a worker the
 * watchdog or reconciliation stopped and stored as the run ended, an inquiry's charge pass a crash cut short, the lost
 * attempt of a worker whose restart the run's end stopped) is settled when the run's report is written. A charge that
 * crosses the cap is recorded; the outcome already stands. Returns whether anything was recorded or charged, for the
 * caller to write the report again.
 */
export function settleRunUsage(ctx: RunContext, phase: BudgetPhase = 'final'): boolean {
  let changed = false;
  for (const w of listWorkers(ctx.db, { runId: ctx.run.id })) {
    if (!hasUsage(ctx, w.id) && !hasCollectedResult(w)) continue;
    try {
      changed = settle(ctx, w, storedResult(w), phase).changed || changed;
    } catch (err) {
      ctx.log.warn('could not record or charge a session\'s usage', { worker_id: w.id, error: messageOf(err) });
    }
  }
  try {
    changed = chargeOutstanding(ctx, phase).changed || changed;
  } catch (err) {
    ctx.log.warn('could not charge the run\'s recorded usage', { error: messageOf(err) });
  }
  return changed;
}

/**
 * The backstop at the start of each step: a session that ended with its result stored and no usage record (stopped by
 * the watchdog, collected by reconciliation) whose purpose no step asks for again, and a usage record no charge marks
 * (a lost attempt reconciliation restarted), are recorded and charged before the step funds anything. Nothing to do
 * before PLANNING creates the budget, whose precharge charges what was spent before. A charge that exhausts the budget
 * is raised after all of them are settled.
 */
export function settleUnsettledSessions(ctx: RunContext, phase: BudgetPhase = 'work'): void {
  if (!ctx.ledger || !hasUnsettledSessions(ctx.db, ctx.run.id)) return;
  let refused: OrbitError | null = null;
  for (const w of listWorkers(ctx.db, { runId: ctx.run.id })) {
    if (!hasCollectedResult(w) || hasUsage(ctx, w.id)) continue;
    refused ??= settle(ctx, w, storedResult(w), phase).refused;
  }
  refused ??= chargeOutstanding(ctx, phase).refused;
  if (refused) throw refused;
}

/** Charge every usage record of the run no charge marks yet, as recorded, in one transaction. */
function chargeOutstanding(ctx: RunContext, phase: BudgetPhase): { changed: boolean; refused: OrbitError | null } {
  const ledger = ctx.ledger;
  if (!ledger) return { changed: false, refused: null };
  return ctx.db.tx(() => {
    const rows = unchargedUsageRows(ctx);
    return { changed: rows.length > 0, refused: rows.length > 0 ? chargeUsageRows(ctx, ledger, rows, phase, 'recorded') : null };
  });
}

/**
 * Whether some session of the run is not settled: a stored result with no usage record of its session, or, once the
 * budget exists, a usage record no charge marks. Read-only and cheap, for the checks that run on every step and on every
 * ended run of the last day.
 */
export function hasUnsettledSessions(db: OrbitDb, runId: string): boolean {
  // A finished worker with a collected result (hasCollectedResult) and no usage record of its own session.
  const unrecorded = db.get(
    `SELECT 1 AS x FROM workers w
     WHERE w.run_id = ? AND w.state NOT IN ('PLANNED', 'RUNNING') AND w.result_json IS NOT NULL
       AND (CASE WHEN json_valid(w.result_json) THEN json_type(w.result_json, '$.status') END) = 'text'
       AND NOT EXISTS (
         SELECT 1 FROM usage u WHERE u.run_id = w.run_id AND u.worker_id = w.id
           AND u.id NOT IN (SELECT json_extract(e.data_json, '$.usage_id') FROM events e WHERE e.run_id = w.run_id AND e.type = ? AND json_extract(e.data_json, '$.usage_id') IS NOT NULL))
     LIMIT 1`,
    runId,
    WORKER_RESTART_EVENT,
  );
  if (unrecorded) return true;
  if (!db.get('SELECT 1 AS x FROM budget_counters WHERE run_id = ? LIMIT 1', runId)) return false;
  // A usage record no charge mark names.
  const unmarked = db.get(
    `SELECT 1 AS x FROM usage u WHERE u.run_id = ?
       AND NOT EXISTS (SELECT 1 FROM events e, json_each(e.data_json, '$.usage_ids') j WHERE e.run_id = u.run_id AND e.type = ? AND j.value = u.id)
     LIMIT 1`,
    runId,
    USAGE_CHARGED_EVENT,
  );
  return unmarked !== undefined;
}

/**
 * A finished worker whose result was collected and stored. One stopped with nothing to collect stores a null result:
 * what it spent is unknown, and it is charged only when a step asks for it, as before.
 */
function hasCollectedResult(w: WorkerRecord): boolean {
  if (isWorkerActive(w.state) || w.resultJson === null) return false;
  try {
    const r = JSON.parse(w.resultJson) as { status?: unknown } | null;
    return r !== null && typeof r === 'object' && typeof r.status === 'string';
  } catch {
    return false;
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
  const present = workerLogs(w).filter((p) => existsSync(p));
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
    // The router found no eligible model, usually because none is validated on the CLI yet (nothing has run). Choose an
    // allowed, seeded model; the first successful run validates it from the model the provider reports.
    const fallback = unvalidatedChoice(ctx, signals);
    if (!fallback) throw err;
    // "Nothing is validated yet" is one reason for a router that found nothing eligible, not the only one (a validated model
    // the router did not take, such as one whose tier it does not justify): the reason says which it was (issue #33).
    const validated = ctx.deps.registry
      .list()
      .some((e) => e.provider === 'claude' && allowMatch(e, config.routing.allowed_models) !== null && e.surfaces.some((s) => s.surface === 'claude-cli' && s.available === true));
    const chosenValidated = ctx.deps.registry.get(fallback.model)?.surfaces.some((s) => s.surface === 'claude-cli' && s.available === true) === true;
    // Where nothing is validated the reason is not the router's own failure message ("no eligible claude-cli model for
    // routine-code"), which read as a reason against the choice it was made despite.
    const summary = validated ? `${purpose}: ${fallback.model} (allowed, and chosen although the router reported: ${messageOf(err)})` : `${purpose}: ${fallback.model} (allowed but not yet validated on claude-cli; the first successful session validates it)`;
    const reason = validated ? `${fallback.model} was chosen although the router reported: ${messageOf(err)}` : `no claude-cli model is validated for ${workKind} yet; the first successful session validates the allowed ${fallback.model}, which was chosen`;
    recordDecision(
      ctx.db,
      ctx.runDir,
      {
        id: decisionId,
        runId: ctx.run.id,
        kind: 'route',
        summary: summary.slice(0, 500),
        data: { kind: 'route', provider: 'claude', model: fallback.model, effort: fallback.effort, work_kind: workKind, purpose, unvalidated: !chosenValidated, reason },
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
export async function collectIfFinished(ctx: RunContext, w: WorkerRecord, phase: BudgetPhase = 'work'): Promise<boolean> {
  if (w.state === 'PLANNED') {
    // Intent without a launch: nothing ran, so the owner may simply start over.
    if (!existsSync(join(w.workerDir, LAUNCH_FILE))) {
      finishWorker(ctx.db, w.id, { state: 'CANCELLED', resultStatus: 'cancelled', error: 'never started before the controller restarted' }, ctx.clock, ctx.ownerId);
      return false;
    }
    if (!handleOf(adapterFor(ctx, w.provider), w)) return true;
    const h = handleOf(adapterFor(ctx, w.provider), w)!;
    markWorkerRunning(ctx.db, w.id, { pid: h.pid, pgid: h.pgid, procStart: h.procStart }, ctx.clock, ctx.ownerId);
    return collectIfFinished(ctx, getWorker(ctx.db, w.id), phase);
  }
  if (w.state !== 'RUNNING') return false;
  const adapter = adapterFor(ctx, w.provider);
  const handle = handleOf(adapter, w);
  if (!handle) {
    // Nothing to collect, so what it spent is unknown: recorded unmeasured and charged its cap with the row, as a lost
    // worker a step collects is (accountFinished), never left uncharged.
    const outcome: WorkerOutcome = { state: 'LOST', resultStatus: 'lost', error: 'the worker directory has no pid.json' };
    settleSession(ctx, w, endedWithoutResult(w, outcome), phase, { finish: () => finishWorker(ctx.db, w.id, outcome, ctx.clock, ctx.ownerId) });
    return false;
  }
  const result = await adapter.collectResult(handle, { outputSchema: schemaFor(w.role) });
  if (!result) return true;
  // Its result, usage record and charge commit together, as for a worker a step collects.
  settleSession(ctx, w, result, phase, { finish: () => finishWorker(ctx.db, w.id, outcomeOf(result), ctx.clock, ctx.ownerId) });
  return false;
}
