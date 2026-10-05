import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Clock } from '../core/clock.ts';
import { systemClock } from '../core/clock.ts';
import { OrbitError, isOrbitError } from '../core/errors.ts';
import { readJsonIfExists } from '../core/fsx.ts';
import { isAlive, isGroupAlive, terminateGroup } from '../core/proc.ts';
import { redact } from '../core/redact.ts';
import { TERMINAL_STATES, type RunState } from '../core/run-states.ts';
import type { OrbitDb } from '../storage/db.ts';
import { appendEvent } from '../storage/events.ts';
import { finishWorker, listWorkers, markWorkerRunning, planWorkerRestart, requestWorkerCancel, type WorkerRecord, type WorkerOutcome } from '../storage/workers.ts';
import { acquireLease, getRun, listRuns, type RunRecord } from '../controller/run-store.ts';
import { ROLE_OUTPUT_KIND } from '../adapters/prompt.ts';
import { MODEL_OUTPUT_SCHEMAS } from '../contract/model-outputs.ts';
import { EXIT_FILE, readExitRecord, readPidRecord } from '../adapters/shim.ts';
import { LAUNCH_FILE, archiveAttempt, cancelShim, handleFromWorkerDir, taskState, type LaunchRecord, type TaskState } from '../adapters/supervise.ts';
import type { ProviderAdapter, TaskHandle, TaskResult, TaskStatus } from '../adapters/types.ts';
import { ActionLedger } from '../delivery/actions.ts';
import { finishCheckRun, isFinalCheckStatus } from '../evidence/store.ts';
import { readJsonFile, shimPath, type ShimExit, type ShimIntent, type ShimLaunch, type ShimPid } from '../evidence/check-shim.ts';
import { APP_STATE_FILE, reconcileApp, type ReconcileOutcome } from '../ui/app-fixture.ts';
import { enterRecovery, exhaustRecovery, recoveryAttemptsRemaining, spendRecoveryAttempt, type EnterRecoveryOutcome, type LedgerFor } from './budget.ts';
import { classifyFailure, decideRetry } from './backoff.ts';
import { groupOwnership, processOwnership } from './identity.ts';

/**
 * Reconciliation on controller start and on lease takeover (spec section 4
 * "Persistent execution", section 14).
 *
 * The principle is the one in docs/architecture.md: a worker or a check is a
 * detached process that records itself in files, so any controller
 * incarnation can tell, from files and the process table alone, whether it is
 * still running, finished, or lost, and never needs to spawn a duplicate to
 * find out. For each run this pass
 *
 *   - takes the run's lease (a run another live controller holds is skipped),
 *   - moves a run whose previous owner died mid-step to RECOVERING, spending
 *     one recovery attempt, or to EXHAUSTED when none are left,
 *   - reattaches to running workers, collects the results of finished ones,
 *     and marks lost ones LOST and plans a bounded restart in the same
 *     worktree,
 *   - stops processes that outlived their run (workers, checks, UI app
 *     fixtures of a run that is terminal or has a durable cancellation),
 *   - flags external actions that were mid-flight so nothing is retried
 *     before the remote has been asked what happened (delivery/actions.ts).
 *
 * It must run before the owner starts any new work for these runs and must
 * not run while the same owner has in-flight workers, checks or UI runs for
 * them that it started itself: it reattaches to workers, but treats an app
 * fixture or a check shim it did not just see start as left over.
 * Everything it does is recorded as run events with the owner as actor.
 */

export type WorkerObservation =
  /** Running and recorded; nothing to do. */
  | 'running'
  /** The worker's result was collected and recorded. */
  | 'finished'
  /** Finished, but its provider has no adapter here, so the controller must collect it. */
  | 'finished-uncollected'
  /** The process is gone without exit.json. */
  | 'lost'
  /** Intent persisted, nothing launched yet: the controller may still spawn it. */
  | 'unlaunched'
  /** Launch recorded moments ago, pid not written yet. */
  | 'starting'
  /** The run is over (or cancelling) and a live process was stopped. */
  | 'orphan-terminated';

export interface WorkerReport {
  workerId: string;
  runId: string;
  role: string;
  provider: string;
  previousState: string;
  observation: WorkerObservation;
  /** The worker row's state after reconciliation. */
  state: string;
  /** For a lost worker: whether a restart was planned (row is PLANNED again). */
  restartPlanned: boolean;
  /** Why no restart was planned, when one was due. */
  restartRefused: 'cancelled' | 'restart-limit' | 'budget' | 'archive-failed' | null;
  /** The record was reconstructed from pid.json (the controller died between spawn and bookkeeping). */
  adoptedFromPidFile: boolean;
  detail: string | null;
}

export type CheckObservation = 'running' | 'finished' | 'lost' | 'not-started' | 'orphan-terminated';

export interface CheckReport {
  checkRunId: string;
  runId: string;
  checkId: string;
  observation: CheckObservation;
  /** The check row was closed (CANCELLED) because its run is over. */
  closed: boolean;
  /** Leftover processes were signalled. */
  terminated: boolean;
  detail: string | null;
}

export interface AppReport {
  runId: string;
  stateFile: string;
  outcome: ReconcileOutcome;
}

export interface ActionReport {
  actionId: string;
  runId: string;
  kind: string;
  previousState: string;
  /** Persisted as UNKNOWN: delivery must query the remote before any retry. */
  flagged: boolean;
}

export interface RunReconcileReport {
  runId: string;
  state: string;
  /** Why the run was not touched, when it was not. */
  skipped: 'leased-by-other' | null;
  /** The outcome of the crash-recovery step, when the previous owner died mid-step. */
  recovery: EnterRecoveryOutcome['outcome'] | null;
  workers: WorkerReport[];
  checks: CheckReport[];
  apps: AppReport[];
  actions: ActionReport[];
}

export interface ReconcileReport {
  ownerId: string;
  at: number;
  runs: RunReconcileReport[];
  /** Every worker result collected, for the controller's cost and usage accounting. */
  collected: { workerId: string; runId: string; result: TaskResult }[];
  /** Problems that did not stop the pass (one run's failure must not block the others). */
  errors: { runId: string; message: string }[];
  /** Counts for logs and `orbit status`. */
  summary: {
    runs: number;
    workersRunning: number;
    workersFinished: number;
    workersLost: number;
    restartsPlanned: number;
    orphansTerminated: number;
    actionsFlagged: number;
    runsRecovering: number;
    runsExhausted: number;
  };
}

export interface ReconcileOptions {
  db: OrbitDb;
  ownerId: string;
  clock: Clock;
  /** By provider id (WorkerRecord.provider). */
  adapters: Readonly<Record<string, ProviderAdapter>>;
  /** Only these runs; default every non-terminal run plus terminal runs that left something behind. */
  runIds?: readonly string[];
  /** Lease time to live for the leases taken. Default 60 s. */
  leaseTtlMs?: number;
  /** Run artifact directory; default the directory of the run's policy snapshot (.orbit/runs/<id>). */
  runDirFor?: (run: RunRecord) => string;
  /** Wait between escalation signals when stopping a process group. Real time. Default 2 s. */
  graceMs?: number;
  /** Restarts of one worker before it is given up on. Default 2. */
  maxWorkerRestarts?: number;
  /** A launch with no pid.json younger than this is still starting. Default 20 s. */
  startGraceMs?: number;
  /** Terminal runs that ended within this window are scanned for leftover app fixtures. Default 24 h. */
  orphanScanWindowMs?: number;
  /** The controller's bound budget ledger for a run, so recovery spends the same counter. */
  ledgerFor?: LedgerFor;
  /** Bound on recoveries for a run with no budget counters yet. */
  fallbackRecoveries?: number;
  /** Output schema to validate a worker's result against; default by role (adapters/prompt ROLE_OUTPUT_KIND). */
  outputSchemaFor?: (worker: WorkerRecord) => object;
}

interface Ctx extends Required<Pick<ReconcileOptions, 'db' | 'ownerId' | 'clock' | 'adapters' | 'graceMs' | 'maxWorkerRestarts' | 'startGraceMs' | 'leaseTtlMs'>> {
  opts: ReconcileOptions;
  report: ReconcileReport;
}

const DEFAULT_LEASE_TTL_MS = 60_000;
const DEFAULT_GRACE_MS = 2_000;
const DEFAULT_MAX_WORKER_RESTARTS = 2;
const DEFAULT_START_GRACE_MS = 20_000;
const DEFAULT_SCAN_WINDOW_MS = 24 * 60 * 60 * 1000;
const TERMINAL: ReadonlySet<string> = TERMINAL_STATES;

export const isRunTerminal = (state: string): boolean => TERMINAL.has(state);

export async function reconcileOnStart(opts: ReconcileOptions): Promise<ReconcileReport> {
  const ctx: Ctx = {
    db: opts.db,
    ownerId: opts.ownerId,
    clock: opts.clock,
    adapters: opts.adapters,
    graceMs: opts.graceMs ?? DEFAULT_GRACE_MS,
    maxWorkerRestarts: opts.maxWorkerRestarts ?? DEFAULT_MAX_WORKER_RESTARTS,
    startGraceMs: opts.startGraceMs ?? DEFAULT_START_GRACE_MS,
    leaseTtlMs: opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
    opts,
    report: {
      ownerId: opts.ownerId,
      at: opts.clock.now(),
      runs: [],
      collected: [],
      errors: [],
      summary: { runs: 0, workersRunning: 0, workersFinished: 0, workersLost: 0, restartsPlanned: 0, orphansTerminated: 0, actionsFlagged: 0, runsRecovering: 0, runsExhausted: 0 },
    },
  };
  for (const run of selectRuns(ctx)) {
    try {
      ctx.report.runs.push(await reconcileRun(ctx, run));
    } catch (err) {
      // One run's trouble (a lost lease, a database busy timeout) must not leave the others unreconciled.
      ctx.report.errors.push({ runId: run.id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  const s = ctx.report.summary;
  s.runs = ctx.report.runs.length;
  for (const r of ctx.report.runs) {
    if (r.recovery === 'recovering' || r.recovery === 'already-recovering') s.runsRecovering++;
    if (r.recovery === 'exhausted') s.runsExhausted++;
    for (const w of r.workers) {
      if (w.observation === 'running') s.workersRunning++;
      if (w.observation === 'finished') s.workersFinished++;
      if (w.observation === 'lost') s.workersLost++;
      if (w.restartPlanned) s.restartsPlanned++;
      if (w.observation === 'orphan-terminated') s.orphansTerminated++;
    }
    for (const c of r.checks) if (c.observation === 'orphan-terminated' || c.terminated) s.orphansTerminated++;
    for (const a of r.apps) if (a.outcome === 'stopped') s.orphansTerminated++;
    s.actionsFlagged += r.actions.filter((a) => a.flagged).length;
  }
  return ctx.report;
}

function selectRuns(ctx: Ctx): RunRecord[] {
  const { db } = ctx;
  const only = ctx.opts.runIds ? new Set(ctx.opts.runIds) : null;
  const nonTerminal = listRuns(db, { states: nonTerminalStates(), limit: 1_000_000 });
  const ids = new Set(nonTerminal.map((r) => r.id));
  const extra: string[] = [];
  // Terminal runs that still own something: a live process or an open check row.
  for (const row of db.all<{ run_id: string }>("SELECT DISTINCT run_id FROM workers WHERE state IN ('PLANNED', 'RUNNING') UNION SELECT DISTINCT run_id FROM check_runs WHERE status IN ('PLANNED', 'RUNNING')")) {
    if (!ids.has(row.run_id)) extra.push(row.run_id);
  }
  // And recently ended ones, whose UI app fixture may have outlived them.
  const since = ctx.clock.now() - (ctx.opts.orphanScanWindowMs ?? DEFAULT_SCAN_WINDOW_MS);
  for (const row of db.all<{ id: string }>('SELECT id FROM runs WHERE ended_at IS NOT NULL AND ended_at >= ?', since)) if (!ids.has(row.id)) extra.push(row.id);
  const out = [...nonTerminal];
  for (const id of new Set(extra)) {
    const run = getRun(db, id);
    if (isRunTerminal(run.state)) out.push(run);
  }
  return out.filter((r) => only === null || only.has(r.id)).sort((a, b) => a.createdAt - b.createdAt);
}

function nonTerminalStates(): RunState[] {
  return ['CREATED', 'PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'DELIVERING', 'AWAITING_CI', 'INQUISITION', 'DIAGNOSING', 'REPAIRING', 'RECOVERING'];
}

function runDir(ctx: Ctx, run: RunRecord): string {
  return ctx.opts.runDirFor ? ctx.opts.runDirFor(run) : dirname(run.policyPath);
}

function note(ctx: Ctx, runId: string, type: string, data: unknown): void {
  const now = ctx.clock.now();
  ctx.db.tx(() => appendEvent(ctx.db, runId, type, ctx.ownerId, data, now));
}

async function reconcileRun(ctx: Ctx, initial: RunRecord): Promise<RunReconcileReport> {
  const { db } = ctx;
  let run = initial;
  const rep: RunReconcileReport = { runId: run.id, state: run.state, skipped: null, recovery: null, workers: [], checks: [], apps: [], actions: [] };
  const ended = isRunTerminal(run.state);

  if (!ended) {
    // A run another live controller holds is theirs to reconcile.
    if (!acquireLease(db, run.id, ctx.ownerId, ctx.leaseTtlMs, ctx.clock)) {
      rep.skipped = 'leased-by-other';
      return rep;
    }
    if (crashEvidence(ctx, run.id)) {
      const outcome = db.tx(() => {
        const r = enterRecovery(db, ctx.clock, {
          runId: run.id,
          ownerId: ctx.ownerId,
          reason: 'the previous owner of this run stopped without releasing its lease; reconciling its processes before resuming',
          ledgerFor: ctx.opts.ledgerFor,
          fallbackMax: ctx.opts.fallbackRecoveries,
        });
        // Marks the takeover as handled even when nothing changed (cancel pending), so a later pass is not misled.
        appendEvent(db, run.id, 'recovery.crash-handled', ctx.ownerId, { outcome: r.outcome, resume_state: r.run.resumeState }, ctx.clock.now());
        return r;
      });
      rep.recovery = outcome.outcome;
      run = outcome.run;
    }
  }

  const seen = new Set<string>();
  // Two passes at most: a lost worker the recovery budget cannot restart ends the run (EXHAUSTED), and then
  // every worker the first pass left running belongs to an ended run and is stopped too.
  for (let pass = 0; pass < 2; pass++) {
    const stop = isRunTerminal(run.state) || run.cancelRequested;
    for (const w of listWorkers(db, { runId: run.id, states: ['PLANNED', 'RUNNING'] })) {
      if (seen.has(w.id) && !stop) continue;
      seen.add(w.id);
      try {
        const wr = await reconcileWorker(ctx, run, w, stop || w.cancelRequested);
        const prior = rep.workers.findIndex((x) => x.workerId === wr.workerId);
        if (prior >= 0) rep.workers[prior] = wr;
        else rep.workers.push(wr);
        if (wr.restartRefused === 'budget' && !stop) run = getRun(db, run.id);
      } catch (err) {
        // One damaged worker directory must not leave the run's checks, app fixtures and in-flight actions unreconciled.
        const message = `worker ${w.id}: ${redact(err instanceof Error ? err.message : String(err)).slice(0, 500)}`;
        ctx.report.errors.push({ runId: run.id, message });
        note(ctx, run.id, 'recovery.worker-error', { worker_id: w.id, error: message });
      }
    }
    if (stop || !isRunTerminal(run.state)) break;
  }
  // The restart planning above may not have changed the run, but a worker pass can race a cancellation: read it again.
  run = getRun(db, run.id);

  rep.checks = await reconcileChecks(ctx, run);
  rep.apps = await reconcileApps(ctx, run);
  rep.actions = flagActions(ctx, run);
  rep.state = run.state;

  if (rep.workers.length + rep.checks.length + rep.apps.length + rep.actions.length > 0 || rep.recovery) {
    note(ctx, run.id, 'recovery.reconciled', {
      recovery: rep.recovery,
      workers: rep.workers.map((w) => ({ id: w.workerId, observation: w.observation, restart_planned: w.restartPlanned, restart_refused: w.restartRefused })),
      checks: rep.checks.map((c) => ({ id: c.checkRunId, observation: c.observation, terminated: c.terminated })),
      apps: rep.apps.map((a) => a.outcome),
      actions_flagged: rep.actions.filter((a) => a.flagged).map((a) => a.actionId),
    });
  }
  return rep;
}

/**
 * The previous owner died mid-step when the lease was taken over (an expired
 * lease of another owner) and nothing has happened to the run since: no
 * state transition by a live owner, and no earlier recovery already handled it.
 */
function crashEvidence(ctx: Ctx, runId: string): boolean {
  const last = (type: string): number =>
    Number(ctx.db.get<{ id: number | null }>('SELECT MAX(id) AS id FROM events WHERE run_id = ? AND type = ?', runId, type)?.id ?? 0);
  const takeover = last('lease.takeover');
  return takeover > 0 && takeover > last('recovery.crash-handled') && takeover > last('state.transition');
}

// ---------------------------------------------------------------------------
// workers

interface Observed {
  kind: 'running' | 'exited' | 'lost' | 'unlaunched' | 'starting';
  handle: TaskHandle | null;
  task: TaskState | null;
  detail: string | null;
}

function observeWorker(ctx: Ctx, w: WorkerRecord): Observed {
  const fromPid = handleFromWorkerDir(w.provider, w.workerDir);
  const handle = fromPid ? { ...fromPid, workerId: w.id } : null;
  if (handle) {
    const task = taskState(handle);
    return { kind: task.state === 'exited' ? 'exited' : task.state, handle, task, detail: null };
  }
  const exit = readExitRecord(w.workerDir);
  if (exit) {
    // exit.json without pid.json: the shim always writes pid.json first, so this is a damaged directory; the exit record is still the truth.
    const synthetic: TaskHandle = { provider: w.provider, workerId: w.id, workerDir: w.workerDir, pid: 0, pgid: 0, procStart: null, logPath: join(w.workerDir, 'log.jsonl'), exitPath: join(w.workerDir, EXIT_FILE) };
    return { kind: 'exited', handle: synthetic, task: { state: 'exited', exit, pid: null }, detail: 'pid.json missing' };
  }
  let launch: LaunchRecord | null = null;
  try {
    launch = readJsonIfExists<LaunchRecord>(join(w.workerDir, LAUNCH_FILE));
  } catch {
    launch = null;
  }
  if (!launch) {
    if (w.state === 'PLANNED') return { kind: 'unlaunched', handle: null, task: null, detail: null };
    return { kind: 'lost', handle: null, task: null, detail: 'the worker is recorded RUNNING but its directory holds no launch or pid record' };
  }
  if (ctx.clock.now() - launch.requestedAt < ctx.startGraceMs) return { kind: 'starting', handle: null, task: null, detail: null };
  return { kind: 'lost', handle: null, task: null, detail: 'a launch was recorded but the shim never wrote pid.json' };
}

async function reconcileWorker(ctx: Ctx, run: RunRecord, w: WorkerRecord, stop: boolean): Promise<WorkerReport> {
  const { db, clock } = ctx;
  const rep: WorkerReport = {
    workerId: w.id,
    runId: w.runId,
    role: w.role,
    provider: w.provider,
    previousState: w.state,
    observation: 'running',
    state: w.state,
    restartPlanned: false,
    restartRefused: null,
    adoptedFromPidFile: false,
    detail: null,
  };
  const obs = observeWorker(ctx, w);
  rep.detail = obs.detail;
  const why = isRunTerminal(run.state) ? `run is ${run.state}` : run.cancelRequested ? 'run has a durable cancellation request' : 'worker has a durable cancellation request';

  // The controller died between spawn and bookkeeping: the PLANNED row catches up from pid.json.
  const pid = obs.handle ? readPidRecord(w.workerDir) : null;
  const adopt = (): WorkerRecord => {
    if (w.state !== 'PLANNED' || !pid) return w;
    rep.adoptedFromPidFile = true;
    return markWorkerRunning(db, w.id, { pid: pid.shimPid, pgid: pid.pgid, procStart: pid.shimStart, spawnedAt: pid.startedAt }, clock, ctx.ownerId);
  };

  switch (obs.kind) {
    case 'unlaunched':
    case 'starting': {
      if (stop) {
        finish(ctx, w.id, { state: 'CANCELLED', resultStatus: 'cancelled', error: `never started: ${why}` });
        rep.observation = 'orphan-terminated';
        rep.state = 'CANCELLED';
        break;
      }
      rep.observation = obs.kind;
      break;
    }
    case 'running': {
      const cur = adopt();
      rep.state = cur.state;
      if (!stop) {
        rep.observation = 'running';
        break;
      }
      await cancelShim(obs.handle!, ctx.graceMs);
      const result = await collect(ctx, cur, obs.handle!);
      finish(ctx, w.id, { state: 'CANCELLED', resultStatus: 'cancelled', exitCode: result?.exitCode ?? null, result, error: `process group terminated: ${why}` });
      rep.observation = 'orphan-terminated';
      rep.state = 'CANCELLED';
      break;
    }
    case 'exited': {
      const cur = adopt();
      const adapter = ctx.adapters[w.provider];
      if (!adapter) {
        rep.observation = 'finished-uncollected';
        rep.state = cur.state;
        rep.detail = `no adapter for provider ${w.provider}; the controller must collect this result`;
        break;
      }
      const result = await collect(ctx, cur, obs.handle!);
      if (!result) {
        rep.observation = 'finished-uncollected';
        rep.state = cur.state;
        rep.detail = 'the adapter could not collect the result';
        break;
      }
      const row = finish(ctx, w.id, outcomeOf(result));
      rep.observation = 'finished';
      rep.state = row.state;
      break;
    }
    case 'lost': {
      rep.observation = 'lost';
      await restartOrGiveUp(ctx, run, w, obs, rep, stop, why);
      break;
    }
  }
  return rep;
}

function outcomeOf(result: TaskResult): WorkerOutcome {
  const state = result.status === 'succeeded' ? 'SUCCEEDED' : result.status === 'cancelled' ? 'CANCELLED' : result.status === 'lost' ? 'LOST' : 'FAILED';
  return { state, exitCode: result.exitCode, resultStatus: result.status satisfies TaskStatus, result, error: result.error === null ? null : redact(result.error).slice(0, 2000) };
}

function finish(ctx: Ctx, workerId: string, outcome: WorkerOutcome): WorkerRecord {
  return finishWorker(ctx.db, workerId, outcome, ctx.clock, ctx.ownerId);
}

function schemaFor(ctx: Ctx, w: WorkerRecord): object {
  if (ctx.opts.outputSchemaFor) return ctx.opts.outputSchemaFor(w);
  return MODEL_OUTPUT_SCHEMAS[ROLE_OUTPUT_KIND[w.role]];
}

/** Collect through the adapter and remember the result for the controller's accounting; null when it cannot be collected. */
async function collect(ctx: Ctx, w: WorkerRecord, handle: TaskHandle): Promise<TaskResult | null> {
  const adapter = ctx.adapters[w.provider];
  if (!adapter) return null;
  try {
    const result = await adapter.collectResult(handle, { outputSchema: schemaFor(ctx, w) });
    if (result) ctx.report.collected.push({ workerId: w.id, runId: w.runId, result });
    return result;
  } catch (err) {
    note(ctx, w.runId, 'recovery.collect-failed', { worker_id: w.id, error: redact(err instanceof Error ? err.message : String(err)).slice(0, 500) });
    return null;
  }
}

/**
 * A worker whose process is gone without exit.json. Its worktree is the only
 * thing worth keeping, and it is never touched here. A bounded restart is
 * planned unless the run or worker is being cancelled, the worker has used its
 * restarts, or the recovery budget is spent.
 *
 * Order matters for crash safety: orphaned children are stopped, the attempt's
 * files are archived (so the directory can host a new attempt and a stale
 * result can never be read as the next one's), and only then do the row's
 * LOST and PLANNED states commit together with the budget spend. A crash
 * before that commit leaves the row RUNNING with an empty directory, which the
 * next pass classifies as lost again and finishes the same way.
 */
async function restartOrGiveUp(ctx: Ctx, run: RunRecord, w: WorkerRecord, obs: Observed, rep: WorkerReport, stop: boolean, why: string): Promise<void> {
  const { db, clock } = ctx;
  const handle = obs.handle;
  const partial = handle ? await collect(ctx, w, handle) : null;
  const lostDetail = obs.detail ?? (obs.task?.state === 'lost' ? 'the worker shim ended without writing exit.json' : 'worker lost');

  if (!handle && w.pid !== null) {
    // No pid.json, but the row names a process (pid, group, start time): files can vanish while the process lives on.
    // Restarting beside it would be a second worker in the same worktree, so it is stopped first, by its recorded identity only.
    const proc = await stopRowProcess(ctx.graceMs, w);
    if (proc === 'unknown') {
      rep.state = w.state;
      rep.restartRefused = 'archive-failed';
      rep.detail = `the worker's files are gone but process ${w.pid} may still be it and could not be verified or stopped; left ${w.state} for a later pass`;
      note(ctx, w.runId, 'recovery.restart-refused', { worker_id: w.id, reason: 'unverified-process', pid: w.pid });
      return;
    }
    if (proc === 'stopped') rep.detail = `the worker's files were gone but its recorded process ${w.pid} was still running; its group was stopped`;
  }

  if (handle && obs.task?.state === 'lost' && obs.task.orphans) {
    // The shim died but its provider still runs: stop it before anything else may start in the worktree.
    await cancelShim(handle, ctx.graceMs);
    rep.detail = 'the shim was gone but its provider process was still running; its group was stopped';
  }

  const giveUp = (reason: NonNullable<WorkerReport['restartRefused']>, state: 'LOST' | 'CANCELLED'): void => {
    const row = finish(ctx, w.id, { state, resultStatus: state === 'LOST' ? 'lost' : 'cancelled', exitCode: partial?.exitCode ?? null, result: partial, error: state === 'LOST' ? lostDetail : `cancelled: ${why}` });
    rep.state = row.state;
    rep.restartRefused = reason;
    note(ctx, w.runId, 'recovery.restart-refused', { worker_id: w.id, reason, restart_count: w.restartCount });
  };

  if (stop) return giveUp('cancelled', 'CANCELLED');
  if (w.role === 'inquisitor') {
    // The Inquisition engine owns its worker: the INQUISITION step starts a fresh one (counting what this one
    // spent) when it resumes, so recovery neither restarts it nor spends recovery budget on it.
    const row = finish(ctx, w.id, { state: 'LOST', resultStatus: 'lost', exitCode: partial?.exitCode ?? null, result: partial, error: lostDetail });
    rep.state = row.state;
    rep.detail = `${lostDetail}; the inquisition step starts its own worker when it resumes`;
    return;
  }
  if (w.restartCount >= ctx.maxWorkerRestarts) return giveUp('restart-limit', 'LOST');

  // Recovery has a budget: the retry decision is told what is left of it, and a refusal ends the run.
  const decision = decideRetry({
    classification: classifyFailure({ status: 'lost' }),
    provider: w.provider,
    runId: run.id,
    attempt: w.restartCount + 1,
    infrastructureRetriesRemaining: Number.POSITIVE_INFINITY,
    wallRemainingMs: null,
    costRemainingUsd: null,
    recoveryAttemptsRemaining: recoveryAttemptsRemaining(db, run.id, ctx.opts.fallbackRecoveries),
  });
  if (decision.action !== 'restart') {
    giveUp('budget', 'LOST');
    exhaust(ctx, run, `lost worker ${w.id} cannot be restarted: ${decision.reason}`);
    return;
  }

  try {
    archiveAttempt(w.provider, w.workerDir);
  } catch (err) {
    rep.detail = `could not archive the lost attempt: ${err instanceof Error ? err.message : String(err)}`;
    return giveUp('archive-failed', 'LOST');
  }

  try {
    db.tx(() => {
      finish(ctx, w.id, { state: 'LOST', resultStatus: 'lost', exitCode: partial?.exitCode ?? null, result: partial, error: lostDetail });
      spendRecoveryAttempt(db, run.id, clock, { ledgerFor: ctx.opts.ledgerFor, fallbackMax: ctx.opts.fallbackRecoveries, actor: ctx.ownerId, why: `restart of lost worker ${w.id}` });
      const row = planWorkerRestart(db, w.id, clock, ctx.ownerId);
      appendEvent(db, run.id, 'recovery.worker-restart', ctx.ownerId, { worker_id: w.id, restart_count: row.restartCount, cwd_preserved: w.cwd }, clock.now());
    });
    rep.restartPlanned = true;
    rep.state = 'PLANNED';
  } catch (err) {
    if (isOrbitError(err, 'BUDGET_EXHAUSTED')) {
      giveUp('budget', 'LOST');
      exhaust(ctx, run, `lost worker ${w.id} cannot be restarted: ${err.message}`);
      return;
    }
    // Cancelled between the pass starting and now: nothing may be planned for a cancelled run.
    if (isOrbitError(err, 'CANCELLED') || isOrbitError(err, 'TRANSITION_INVALID')) return giveUp('cancelled', 'LOST');
    throw err;
  }
}

/** The recovery budget refused a restart: the run ends EXHAUSTED (reason recovery_attempts) unless it already ended. */
function exhaust(ctx: Ctx, run: RunRecord, why: string): void {
  try {
    const ended = ctx.db.tx(() => exhaustRecovery(ctx.db, ctx.clock, { runId: run.id, ownerId: ctx.ownerId, why }));
    if (ended) ctx.report.summary.runsExhausted++;
  } catch (err) {
    ctx.report.errors.push({ runId: run.id, message: `could not end the run after a refused restart: ${err instanceof Error ? err.message : String(err)}` });
  }
}

/** Stop the process a worker row records, when its recorded start time proves it is that process. */
export async function stopRowProcess(graceMs: number, w: WorkerRecord): Promise<'gone' | 'stopped' | 'unknown'> {
  const state = (): 'alive' | 'gone' | 'unknown' => {
    if (w.pid === null) return 'gone';
    try {
      if (!isAlive(w.pid)) return 'gone';
      if (w.procStart === null) return 'unknown';
      return isAlive(w.pid, w.procStart) ? 'alive' : 'gone';
    } catch {
      return 'unknown';
    }
  };
  const first = state();
  if (first !== 'alive') return first;
  if (w.pgid === null || w.pgid <= 1) return 'unknown';
  try {
    await terminateGroup(w.pgid, graceMs);
  } catch {
    return 'unknown';
  }
  return state() === 'gone' ? 'stopped' : 'unknown';
}

/**
 * Stop one worker on request (the watchdog abandoning a step, a controller
 * cancelling): terminate its process group, record a result when the adapter
 * can read one, and finish the row CANCELLED. Never restarts.
 */
export async function stopWorker(
  ctx: { db: OrbitDb; clock: Clock; ownerId: string; adapters: Readonly<Record<string, ProviderAdapter>>; graceMs?: number },
  worker: WorkerRecord,
  reason: string,
): Promise<WorkerRecord> {
  requestWorkerCancel(ctx.db, worker.id, ctx.clock, ctx.ownerId, reason);
  const fromPid = handleFromWorkerDir(worker.provider, worker.workerDir);
  let result: TaskResult | null = null;
  const graceMs = ctx.graceMs ?? DEFAULT_GRACE_MS;
  if (fromPid) {
    const handle = { ...fromPid, workerId: worker.id };
    await cancelShim(handle, graceMs);
    // cancelShim signals nothing it cannot identify. A worker recorded CANCELLED while its process still runs would let the
    // next attempt start beside it, so a process that survived is an error for the caller, and the row stays active.
    const after = taskState(handle);
    if (after.state === 'running' || (after.state === 'lost' && after.orphans)) {
      throw new OrbitError('TRANSITION_INVALID', `worker ${worker.id} could not be stopped (its process could not be verified or did not exit); it stays ${worker.state} with a cancellation request`, { workerId: worker.id });
    }
    try {
      result = (await ctx.adapters[worker.provider]?.collectResult(handle, { outputSchema: MODEL_OUTPUT_SCHEMAS[ROLE_OUTPUT_KIND[worker.role]] })) ?? null;
    } catch {
      result = null;
    }
  } else if ((await stopRowProcess(graceMs, worker)) === 'unknown') {
    throw new OrbitError('TRANSITION_INVALID', `worker ${worker.id} has no pid.json and its recorded process ${worker.pid} could not be verified or stopped; it stays ${worker.state} with a cancellation request`, { workerId: worker.id });
  }
  return finishWorker(ctx.db, worker.id, { state: 'CANCELLED', resultStatus: 'cancelled', exitCode: result?.exitCode ?? null, result, error: reason }, ctx.clock, ctx.ownerId);
}

// ---------------------------------------------------------------------------
// checks

interface CheckDir {
  dir: string;
  intent: ShimIntent;
}

/** Check directories by check_runs id, found from each directory's intent.json (the layout is evidence/<seq>/<check>[~n] and baseline/<check>[~n]). */
function findCheckDirs(root: string): Map<string, CheckDir> {
  const found = new Map<string, CheckDir>();
  const visit = (parent: string): void => {
    for (const name of safeDirs(parent)) {
      const dir = join(parent, name);
      const intent = readJsonFile<ShimIntent>(shimPath(dir, 'intent'));
      if (intent && typeof intent.checkRunId === 'string') found.set(intent.checkRunId, { dir, intent });
    }
  };
  visit(join(root, 'baseline'));
  for (const seq of safeDirs(join(root, 'evidence'))) visit(join(root, 'evidence', seq));
  return found;
}

function safeDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function reconcileChecks(ctx: Ctx, run: RunRecord): Promise<CheckReport[]> {
  const { db } = ctx;
  const open = db.all<{ id: string; check_id: string; status: string }>("SELECT id, check_id, status FROM check_runs WHERE run_id = ? AND status IN ('PLANNED', 'RUNNING') ORDER BY started_at, rowid", run.id);
  if (open.length === 0) return [];
  const ended = isRunTerminal(run.state) || run.cancelRequested;
  const dirs = findCheckDirs(runDir(ctx, run));
  const out: CheckReport[] = [];
  for (const row of open) {
    const rep: CheckReport = { checkRunId: row.id, runId: run.id, checkId: row.check_id, observation: 'running', closed: false, terminated: false, detail: null };
    const found = dirs.get(row.id);
    if (!found) {
      rep.observation = 'not-started';
    } else {
      const { dir, intent } = found;
      const exit = readJsonFile<ShimExit>(shimPath(dir, 'exit'));
      const launch = readJsonFile<ShimLaunch>(shimPath(dir, 'launch'));
      const pidFile = readJsonFile<ShimPid>(shimPath(dir, 'pid'));
      const shimPid = launch && launch.token === intent.token ? launch.pid : pidFile && pidFile.token === intent.token ? pidFile.shimPid : null;
      const shimStart = launch && launch.token === intent.token ? launch.procStart : null;
      const childPgid = pidFile && pidFile.token === intent.token ? pidFile.childPgid : null;
      const startedAt = pidFile && pidFile.token === intent.token ? pidFile.startedAt : null;
      // Without launch.json's start time, the shim is identified by when it recorded itself (pid.json) or was asked for (intent.json).
      const identity = shimPid === null ? 'dead' : shimIdentity(shimPid, shimStart, startedAt ?? intent.writtenAt);

      if (exit && exit.token === intent.token) {
        rep.observation = 'finished';
      } else if (shimPid !== null && identity !== 'dead') {
        rep.observation = 'running';
        if (ended && identity === 'ours') {
          rep.terminated = await stopCheck(ctx, dir, shimPid, () => shimIdentity(shimPid, shimStart, startedAt ?? intent.writtenAt) === 'ours', childPgid);
          rep.observation = 'orphan-terminated';
        } else if (ended) {
          rep.detail = `process ${shimPid} may be this check's shim, but its identity cannot be established, so it was not signalled`;
        }
      } else if (shimPid === null) {
        rep.observation = 'not-started';
      } else {
        // The shim is gone without exit.json. Its check may still be running; a rerun in the same checkout must not race it.
        rep.observation = 'lost';
        if (childPgid !== null && startedAt !== null) rep.terminated = await stopOrphanGroup(ctx, childPgid, startedAt);
      }
    }
    if (ended && !isFinalCheckStatus(row.status)) {
      finishCheckRun(db, row.id, {
        status: 'CANCELLED',
        exitCode: null,
        timedOut: false,
        cancelled: true,
        logPath: null,
        logSha256: null,
        fingerprint: null,
        excerpt: `closed by recovery: run ${isRunTerminal(run.state) ? `is ${run.state}` : 'has a durable cancellation request'}`,
        artifacts: [],
        endedAt: ctx.clock.now(),
      });
      rep.closed = true;
    }
    out.push(rep);
  }
  return out;
}

type ShimIdentity = 'ours' | 'unknown' | 'dead';

/**
 * Whether `pid` is still the check shim that was started. With launch.json's
 * start time, core/proc compares it exactly. Without it (the controller died
 * before writing launch.json), a bare pid proves nothing: a recycled pid would
 * read as a live shim and be signalled, so the process start is compared with
 * the time the record was written instead. 'unknown' (no ps) is treated as
 * running but never signalled.
 */
function shimIdentity(pid: number, start: string | null, recordedAtMs: number): ShimIdentity {
  if (start !== null) {
    try {
      return isAlive(pid, start) ? 'ours' : 'dead';
    } catch {
      return 'unknown';
    }
  }
  const own = processOwnership(pid, recordedAtMs);
  return own === 'ours' ? 'ours' : own === 'unknown' ? 'unknown' : 'dead';
}

/** SIGTERM the shim (it stops its check's group and writes exit.json), then make sure both are gone. */
async function stopCheck(ctx: Ctx, dir: string, shimPid: number, stillOurs: () => boolean, childPgid: number | null): Promise<boolean> {
  try {
    process.kill(shimPid, 'SIGTERM');
  } catch {
    /* exited in between */
  }
  const deadline = Date.now() + ctx.graceMs * 2 + 1_000;
  // Real time: the wait is for a real process, whatever clock the caller injected.
  while (Date.now() < deadline && !existsSync(shimPath(dir, 'exit')) && stillOurs()) await systemClock.sleep(25);
  // Identity again, not bare liveness: the shim may have exited and its pid been reused during the wait.
  if (stillOurs()) {
    try {
      process.kill(shimPid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  // The shim was verified alive moments ago, so its check's group is ours.
  if (childPgid !== null && isGroupAlive(childPgid)) await terminateGroup(childPgid, ctx.graceMs);
  return true;
}

async function stopOrphanGroup(ctx: Ctx, pgid: number, startedAt: number): Promise<boolean> {
  const own = groupOwnership(pgid, startedAt);
  if (own !== 'ours') return false;
  try {
    await terminateGroup(pgid, ctx.graceMs);
  } catch (err) {
    if (isOrbitError(err, 'INTERNAL')) return false;
    throw err;
  }
  return true;
}

// ---------------------------------------------------------------------------
// UI app fixtures

/** app/app.json files under the run's evidence directory (evidence/<seq>/ui/app/app.json). */
function findAppStateFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;
    for (const name of safeDirs(dir)) {
      const child = join(dir, name);
      if (name === 'app' && existsSync(join(child, APP_STATE_FILE))) out.push(join(child, APP_STATE_FILE));
      else walk(child, depth + 1);
    }
  };
  walk(join(root, 'evidence'), 0);
  return out;
}

async function reconcileApps(ctx: Ctx, run: RunRecord): Promise<AppReport[]> {
  const out: AppReport[] = [];
  for (const stateFile of findAppStateFiles(runDir(ctx, run))) {
    // reconcileApp stops the app only when the recorded pid, group and start time identify it; a recycled pid is left alone.
    const outcome = await reconcileApp(stateFile, { graceMs: ctx.graceMs });
    if (outcome !== 'none' && outcome !== 'already-stopped') note(ctx, run.id, 'recovery.app-fixture', { state_file: stateFile.slice(runDir(ctx, run).length + 1), outcome });
    out.push({ runId: run.id, stateFile, outcome });
  }
  return out;
}

// ---------------------------------------------------------------------------
// external actions

/**
 * An action that was EXECUTING when its owner died may or may not have taken
 * effect on the remote. It is persisted as UNKNOWN so that delivery's
 * performAction queries the remote before any retry, which it already does
 * for both states; the point here is to make the doubt explicit in the ledger,
 * the events and the report instead of leaving a state that reads as in-progress.
 * Rows of ended runs are reported but not changed: nothing owns them.
 */
function flagActions(ctx: Ctx, run: RunRecord): ActionReport[] {
  const ledger = new ActionLedger(ctx.db, ctx.clock, { actor: ctx.ownerId });
  const out: ActionReport[] = [];
  const ended = isRunTerminal(run.state);
  for (const action of ledger.list(run.id)) {
    if (action.state !== 'EXECUTING' && action.state !== 'UNKNOWN') continue;
    let flagged = false;
    if (action.state === 'EXECUTING' && !ended) {
      ledger.markUnknown(action, 'the controller stopped while this action was executing; the remote must be queried before any retry');
      flagged = true;
    }
    if (!ended) note(ctx, run.id, 'recovery.action-flagged', { action_id: action.id, kind: action.kind, previous_state: action.state, attempts: action.attempts });
    out.push({ actionId: action.id, runId: run.id, kind: action.kind, previousState: action.state, flagged: flagged || (action.state === 'UNKNOWN' && !ended) });
  }
  return out;
}
