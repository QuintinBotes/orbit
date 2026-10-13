import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Clock } from '../core/clock.ts';
import { OrbitError, isOrbitError } from '../core/errors.ts';
import { readJsonIfExists } from '../core/fsx.ts';
import { findProcesses, isAlive, terminateGroup } from '../core/proc.ts';
import { redact } from '../core/redact.ts';
import { TERMINAL_STATES, type RunState } from '../core/run-states.ts';
import type { OrbitDb } from '../storage/db.ts';
import { appendEvent } from '../storage/events.ts';
import { finishWorker, listWorkers, markWorkerRunning, planWorkerRestart, requestWorkerCancel, type WorkerRecord, type WorkerOutcome } from '../storage/workers.ts';
import { acquireLease, getRun, listRuns, type RunRecord } from '../controller/run-store.ts';
import { ROLE_OUTPUT_KIND } from '../adapters/prompt.ts';
import { MODEL_OUTPUT_SCHEMAS } from '../contract/model-outputs.ts';
import { EXIT_FILE, REGISTRATION_FILE, readExitRecord, readPidRecord, readRegistration, type RegistrationRecord } from '../adapters/shim.ts';
import { LAUNCH_FILE, archiveAttempt, cancelShim, handleFromWorkerDir, isShimCommandLine, launchedShimState, stopLaunchedShim, taskState, type LaunchRecord, type TaskState } from '../adapters/supervise.ts';
import type { ProviderAdapter, TaskHandle, TaskResult, TaskStatus } from '../adapters/types.ts';
import { ActionLedger } from '../delivery/actions.ts';
import { recordUsage } from '../routing/usage.ts';
import { finishCheckRun, isFinalCheckStatus } from '../evidence/store.ts';
import { closeInterruptedProbes } from '../evidence/fail-before.ts';
import { readJsonFile, shimPath, type ShimIntent } from '../evidence/check-shim.ts';
import { APP_STATE_FILE, reconcileApp, type ReconcileOutcome } from '../ui/app-fixture.ts';
import type { Logger } from '../core/log.ts';
import { releaseIfDue, settleEndedRunWorktrees } from './release.ts';
import { enterRecovery, exhaustRecovery, recoveryAttemptsRemaining, spendRecoveryAttempt, type EnterRecoveryOutcome, type LedgerFor } from './budget.ts';
import { classifyFailure, decideRetry } from './backoff.ts';
import { processOwnership } from './identity.ts';
import { settleCheckAttempt, type CheckObservation } from './check-attempt.ts';

export type { CheckObservation } from './check-attempt.ts';

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
  /** Fail-before probe attempts closed as interrupted (evidence/fail-before.ts closeInterruptedProbes). */
  probes: string[];
  apps: AppReport[];
  actions: ActionReport[];
  /** This pass settled the run's checkouts (a `worktrees.released` or `worktrees.retained` event was recorded), so a report written before is stale. */
  worktreesReleased: boolean;
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
  /**
   * The orbit home, where run worktrees live. With it, a run reconciliation ends EXHAUSTED has its worktrees retained on
   * record, and a finished SUCCEEDED or CANCELLED run's checkout kept for a worker that might still be writing is
   * released once the worker is confirmed stopped; without it they are kept.
   */
  orbitHome?: string;
  log?: Logger;
}

interface Ctx extends Required<Pick<ReconcileOptions, 'db' | 'ownerId' | 'clock' | 'adapters' | 'graceMs' | 'maxWorkerRestarts' | 'startGraceMs' | 'leaseTtlMs'>> {
  opts: ReconcileOptions;
  report: ReconcileReport;
  /** Runs this pass ended EXHAUSTED through the recovery budget. */
  exhausted: Set<string>;
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
    exhausted: new Set(),
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
  // Terminal runs that still own something: a live process or an open check or probe attempt row.
  for (const row of db.all<{ run_id: string }>("SELECT DISTINCT run_id FROM workers WHERE state IN ('PLANNED', 'RUNNING') UNION SELECT DISTINCT run_id FROM check_runs WHERE status IN ('PLANNED', 'RUNNING') UNION SELECT DISTINCT run_id FROM fail_before_probes WHERE status IN ('PLANNED', 'RUNNING')")) {
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
  const rep: RunReconcileReport = { runId: run.id, state: run.state, skipped: null, recovery: null, workers: [], checks: [], probes: [], apps: [], actions: [], worktreesReleased: false };
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
      if (outcome.outcome === 'exhausted') ctx.exhausted.add(run.id);
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
  // A fail-before probe is never reattached: its open attempts are stopped and closed, and it runs again (ADR 0014). One
  // that may still run stays open, so the release keeps its checkout.
  const probes = await closeInterruptedProbes(db, runDir(ctx, run), run.id, ctx.clock, { graceMs: ctx.graceMs });
  rep.probes = probes.closed;
  for (const k of probes.kept) note(ctx, run.id, 'recovery.stop-unconfirmed', { fail_before_probe_id: k.id, check_id: k.checkId, reason: 'a fail-before probe attempt is never reattached', detail: k.why });
  rep.apps = await reconcileApps(ctx, run);
  rep.actions = flagActions(ctx, run);
  rep.state = run.state;

  if (rep.workers.length + rep.checks.length + rep.probes.length + rep.apps.length + rep.actions.length > 0 || rep.recovery) {
    note(ctx, run.id, 'recovery.reconciled', {
      recovery: rep.recovery,
      workers: rep.workers.map((w) => ({ id: w.workerId, observation: w.observation, restart_planned: w.restartPlanned, restart_refused: w.restartRefused })),
      checks: rep.checks.map((c) => ({ id: c.checkRunId, observation: c.observation, terminated: c.terminated })),
      ...(rep.probes.length > 0 ? { fail_before_probes_closed: rep.probes } : {}),
      apps: rep.apps.map((a) => a.outcome),
      actions_flagged: rep.actions.filter((a) => a.flagged).map((a) => a.actionId),
    });
  }
  // Workers and checks are stopped by now; settle the checkouts as the run's end does (finishRun does the same): released
  // for SUCCEEDED and CANCELLED, retained on record for the EXHAUSTED run this pass ended.
  if (ctx.exhausted.has(run.id)) {
    const settled = await settleEndedRunWorktrees({ db, clock: ctx.clock, ownerId: ctx.ownerId, runId: run.id, orbitHome: ctx.opts.orbitHome, log: ctx.opts.log });
    rep.worktreesReleased = settled.released !== null || settled.retained !== null;
  } else if (isRunTerminal(run.state)) {
    // A release or retention that never completed (the controller died between the terminal transition and it, or it
    // failed) is resumed, and a release that kept a checkout is tried again (its worker or check has ended, or its edits
    // may pin now), under the run's lease. An EXHAUSTED or IMPOSSIBLE run is only ever retained here, never released.
    rep.worktreesReleased = await releaseIfDue({ db, clock: ctx.clock, ownerId: ctx.ownerId, runId: run.id, orbitHome: ctx.opts.orbitHome, leaseTtlMs: ctx.leaseTtlMs, log: ctx.opts.log });
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
        // A starting shim (spawned, pid.json not written yet) is stopped first: a row finished while it runs on would let
        // its checkout be released beneath it, and nothing would ever stop it.
        const { outcome: shim, why: unconfirmed } = await settleLaunch(ctx.graceMs, w.workerDir);
        if (shim === 'unknown') {
          rep.observation = obs.kind;
          rep.detail = `its launch has no pid.json and its shim could not be confirmed stopped or absent: ${unconfirmed} (${why}); left ${w.state} for a later pass`;
          note(ctx, w.runId, 'recovery.stop-unconfirmed', { worker_id: w.id, reason: why, detail: unconfirmed });
          break;
        }
        finish(ctx, w.id, { state: 'CANCELLED', resultStatus: 'cancelled', error: shim === 'stopped' ? `its starting shim was stopped: ${why}` : `never started: ${why}` });
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
      // Only a confirmed end finishes the row: one recorded CANCELLED while its process runs on would let its checkout
      // be released beneath it (cancelShim signals nothing it cannot identify).
      if (stillRunning(obs.handle!)) {
        rep.observation = 'running';
        rep.detail = `its process could not be stopped or verified as stopped (${why}); left ${cur.state} for a later pass`;
        note(ctx, w.runId, 'recovery.stop-unconfirmed', { worker_id: w.id, reason: why });
        break;
      }
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

  if (!handle) {
    // No pid.json, but the launch record may name the shim that was spawned (one that hung or died before writing it):
    // one still running must end before a restart beside it, or a finished row that lets its checkout be released.
    const { outcome: shim, why: unconfirmed } = await settleLaunch(ctx.graceMs, w.workerDir);
    if (shim === 'unknown') {
      rep.state = w.state;
      rep.restartRefused = 'archive-failed';
      rep.detail = `the shim of its launch never wrote pid.json and may still run, but could not be confirmed stopped or absent: ${unconfirmed}; left ${w.state} for a later pass`;
      note(ctx, w.runId, 'recovery.restart-refused', { worker_id: w.id, reason: 'unverified-process', detail: unconfirmed });
      return;
    }
    if (shim === 'stopped') rep.detail = 'the shim never wrote pid.json but was still running; its group was stopped';
  }

  if (handle && obs.task?.state === 'lost' && obs.task.orphans) {
    // The shim died but its provider still runs: stop it before anything else may start in the worktree.
    await cancelShim(handle, ctx.graceMs);
    if (stillRunning(handle)) {
      // Neither a restart beside it nor a finished row (which would let its checkout be released) while it may still write.
      rep.state = w.state;
      rep.restartRefused = 'archive-failed';
      rep.detail = `the shim was gone and its provider process could not be stopped or verified as stopped; left ${w.state} for a later pass`;
      note(ctx, w.runId, 'recovery.restart-refused', { worker_id: w.id, reason: 'unverified-process' });
      return;
    }
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
    // spent) when it resumes, so recovery neither restarts it nor spends recovery budget on it. With nothing collected,
    // what it spent is unknown: an unmeasured usage record, in the same transaction, has it charged its cap or ceiling
    // as any other lost session is (the engine records one for an inquisitor it gives up on, too).
    const row = db.tx(() => {
      const done = finish(ctx, w.id, { state: 'LOST', resultStatus: 'lost', exitCode: partial?.exitCode ?? null, result: partial, error: lostDetail });
      if (!partial) recordLostUsage(ctx, run, w, null);
      return done;
    });
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
      // The restart reuses the row and clears its result, so what the lost attempt spent is recorded now, with the
      // restart that would otherwise lose it; the event names the record as the earlier attempt's, and the controller
      // charges it before the next step funds anything.
      const usageId = recordLostUsage(ctx, run, w, partial);
      spendRecoveryAttempt(db, run.id, clock, { ledgerFor: ctx.opts.ledgerFor, fallbackMax: ctx.opts.fallbackRecoveries, actor: ctx.ownerId, why: `restart of lost worker ${w.id}` });
      const row = planWorkerRestart(db, w.id, clock, ctx.ownerId);
      appendEvent(db, run.id, WORKER_RESTART_EVENT, ctx.ownerId, { worker_id: w.id, restart_count: row.restartCount, cwd_preserved: w.cwd, usage_id: usageId }, clock.now());
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

/**
 * Names, with the usage record of the lost attempt (`usage_id`), a lost worker restarted on the same row: that record
 * is an earlier session's, so the restarted session still records its own.
 */
export const WORKER_RESTART_EVENT = 'recovery.worker-restart';

/**
 * Record the usage of a lost session: what its partial result reports, or an unmeasured record when nothing could be
 * collected (what it spent is unknown, never free). Inside the caller's transaction. Returns the record's id.
 */
function recordLostUsage(ctx: Ctx, run: RunRecord, w: WorkerRecord, partial: TaskResult | null): number {
  return recordUsage(ctx.db, { runId: run.id, workerId: w.id, provider: w.provider, model: partial?.usage?.model ?? w.model, usage: partial?.usage ?? null, durationMs: partial?.durationMs ?? null }, ctx.clock).id;
}

/** The recovery budget refused a restart: the run ends EXHAUSTED (reason recovery_attempts) unless it already ended. */
function exhaust(ctx: Ctx, run: RunRecord, why: string): void {
  try {
    const ended = ctx.db.tx(() => exhaustRecovery(ctx.db, ctx.clock, { runId: run.id, ownerId: ctx.ownerId, why }));
    if (ended) {
      ctx.report.summary.runsExhausted++;
      ctx.exhausted.add(run.id);
    }
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

/** Whether the worker's shim or provider may still run after a cancel: alive, or gone with a process of its group left. */
function stillRunning(handle: TaskHandle): boolean {
  const after = taskState(handle);
  return after.state === 'running' || (after.state === 'lost' && after.orphans);
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
  opts: { finish?: (outcome: WorkerOutcome, result: TaskResult | null) => WorkerRecord } = {},
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
    if (stillRunning(handle)) {
      throw new OrbitError('TRANSITION_INVALID', `worker ${worker.id} could not be stopped (its process could not be verified or did not exit); it stays ${worker.state} with a cancellation request`, { workerId: worker.id });
    }
    try {
      result = (await ctx.adapters[worker.provider]?.collectResult(handle, { outputSchema: MODEL_OUTPUT_SCHEMAS[ROLE_OUTPUT_KIND[worker.role]] })) ?? null;
    } catch {
      result = null;
    }
  } else {
    // No pid.json: the shim of its launch may still be starting (a PLANNED row has no pid of its own yet).
    const launch = await settleLaunch(graceMs, worker.workerDir);
    if (launch.outcome === 'unknown') {
      throw new OrbitError('TRANSITION_INVALID', `worker ${worker.id} has no pid.json and the shim of its launch could not be confirmed stopped or absent (${launch.why}); it stays ${worker.state} with a cancellation request`, { workerId: worker.id });
    }
    if ((await stopRowProcess(graceMs, worker)) === 'unknown') {
      throw new OrbitError('TRANSITION_INVALID', `worker ${worker.id} has no pid.json and its recorded process ${worker.pid} could not be verified or stopped; it stays ${worker.state} with a cancellation request`, { workerId: worker.id });
    }
  }
  const outcome: WorkerOutcome = { state: 'CANCELLED', resultStatus: 'cancelled', exitCode: result?.exitCode ?? null, result, error: reason };
  // A controller records the session's usage and charge with its result, in one transaction (opts.finish).
  return opts.finish ? opts.finish(outcome, result) : finishWorker(ctx.db, worker.id, outcome, ctx.clock, ctx.ownerId);
}

export type LaunchStop = 'none' | 'gone' | 'stopped' | 'unknown';

/** settleLaunch's outcome alone, for callers that only need to know whether the launch may still run ('unknown'). */
export async function stopLaunch(graceMs: number, workerDir: string): Promise<LaunchStop> {
  return (await settleLaunch(graceMs, workerDir)).outcome;
}

/**
 * Stop the shim of a worker's launch while its pid.json is missing (a shim still starting, one that hung or died before
 * writing it, or one spawned before launch.json named it), and confirm nothing of it runs: 'none' when no launch was
 * recorded, otherwise 'gone', 'stopped', or 'unknown' when it may still run, which never closes the worker's row (the
 * release would remove its checkout beneath it). `why` says what kept an 'unknown' from being confirmed.
 *
 * The shim is identified by the pid and start time launch.json records after the spawn, else by the identity it
 * registered itself (registration.json, written before it starts anything in the checkout). Without either (no
 * registration, a damaged one, or one another launch wrote), the process table is searched for its launch token on a
 * shim command line (for a record without one, or unreadable, its worker directory): a process found is a shim that was
 * spawned but has not registered, so it is kept and never signalled, and none found means the spawn never happened or
 * the shim ended before it could start anything, once the process another launch's registration names (and its
 * group) is gone too. A record without a start time judges the process by when it was recorded (recovery/identity),
 * as a check shim is.
 */
export async function settleLaunch(graceMs: number, workerDir: string): Promise<{ outcome: LaunchStop; why: string | null }> {
  const path = join(workerDir, LAUNCH_FILE);
  if (!existsSync(path)) return { outcome: 'none', why: null };
  let launch: Partial<LaunchRecord> | null;
  try {
    const raw = readJsonIfExists<unknown>(path);
    launch = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Partial<LaunchRecord>) : null;
  } catch {
    // Damaged, or archived since: an existing record without a usable identity is never read as no launch.
    launch = null;
  }
  const byIdentity = async (pid: number, start: string | null, recordedAt: number | null, source: string): Promise<{ outcome: LaunchStop; why: string | null }> => {
    const outcome = await stopLaunchedShim(pid, start, graceMs, recordedAt === null ? undefined : (p) => processOwnership(p, recordedAt));
    return outcome === 'unknown' ? { outcome, why: `process ${pid}, which ${source} names, could not be identified as its shim or confirmed stopped` } : { outcome, why: null };
  };
  if (launch && typeof launch.pid === 'number') return byIdentity(launch.pid, launch.procStart ?? null, typeof launch.requestedAt === 'number' ? launch.requestedAt : null, 'launch.json');

  const token = launch && typeof launch.token === 'string' && launch.token !== '' ? launch.token : null;
  const registration = (): { state: 'none' | 'damaged' } | { state: 'ours' | 'foreign'; reg: RegistrationRecord } => {
    const reg = readRegistration(workerDir);
    if (reg) return { state: token === null || reg.token === token ? 'ours' : 'foreign', reg };
    return { state: existsSync(join(workerDir, REGISTRATION_FILE)) ? 'damaged' : 'none' };
  };
  const first = registration();
  if (first.state === 'ours') return byIdentity(first.reg.shimPid, first.reg.shimStart, first.reg.registeredAt, REGISTRATION_FILE);

  // No registration of this launch to go by (none yet, a damaged one, or another launch's): the process table decides.
  let found: number[];
  try {
    found = findProcesses((line) => isShimCommandLine(line, workerDir, token));
  } catch (err) {
    return { outcome: 'unknown', why: `the process table could not be searched for its shim (${err instanceof Error ? err.message : String(err)})` };
  }
  if (found.length > 0) {
    const marker = token !== null ? 'carries its launch token' : 'names its worker directory on a shim command line';
    return { outcome: 'unknown', why: `process ${found.join(', ')} ${marker} but has not registered, so it was not signalled` };
  }
  // A shim that registered and ended between the first read and the search left its record, and its group is judged by it.
  const late = registration();
  if (late.state === 'ours') return byIdentity(late.reg.shimPid, late.reg.shimStart, late.reg.registeredAt, REGISTRATION_FILE);
  if (late.state === 'foreign') {
    // Another launch's shim registered in this directory: it is not signalled, and the launch is closed only once that
    // process and its group are gone too.
    const { shimPid, shimStart, registeredAt } = late.reg;
    const other = launchedShimState(shimPid, shimStart, (p) => processOwnership(p, registeredAt));
    if (other !== 'gone') return { outcome: 'unknown', why: `${REGISTRATION_FILE} names another launch, whose process ${shimPid} ${other === 'ours' ? 'or its group still runs' : 'cannot be identified'}, so it was not signalled` };
  }
  return { outcome: 'gone', why: null };
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
  const reason = isRunTerminal(run.state) ? `run is ${run.state}` : 'run has a durable cancellation request';
  const dirs = findCheckDirs(runDir(ctx, run));
  const out: CheckReport[] = [];
  for (const row of open) {
    const rep: CheckReport = { checkRunId: row.id, runId: run.id, checkId: row.check_id, observation: 'running', closed: false, terminated: false, detail: null };
    // A check that may still run is not closed: its open row is what keeps the run's release from removing its checkout.
    // Only a process confirmed absent (never started, ended, or stopped and confirmed gone) lets it close.
    let mayRun = false;
    const found = dirs.get(row.id);
    if (!found) {
      // No intent.json: the runner writes it before the spawn, so no shim was started for this row.
      rep.observation = 'not-started';
    } else {
      const settled = await settleCheckAttempt(found.dir, found.intent, { stop: ended, graceMs: ctx.graceMs });
      rep.observation = settled.observation;
      rep.terminated = settled.terminated;
      rep.detail = settled.detail;
      mayRun = settled.mayRun;
    }
    if (ended && mayRun) note(ctx, run.id, 'recovery.stop-unconfirmed', { check_run_id: row.id, check_id: row.check_id, reason, detail: rep.detail });
    if (ended && !mayRun && !isFinalCheckStatus(row.status)) {
      finishCheckRun(db, row.id, {
        status: 'CANCELLED',
        exitCode: null,
        timedOut: false,
        cancelled: true,
        logPath: null,
        logSha256: null,
        fingerprint: null,
        excerpt: `closed by recovery: ${reason}`,
        artifacts: [],
        endedAt: ctx.clock.now(),
      });
      rep.closed = true;
    }
    out.push(rep);
  }
  return out;
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
