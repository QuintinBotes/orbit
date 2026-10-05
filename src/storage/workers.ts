import type { OrbitDb } from './db.ts';
import type { Clock } from '../core/clock.ts';
import type { TaskStatus, WorkerRole } from '../adapters/types.ts';
import { OrbitError } from '../core/errors.ts';
import { normalizeStart } from '../core/proc.ts';
import { TERMINAL_STATES } from '../core/run-states.ts';
import { appendEvent } from './events.ts';

/**
 * The workers table: one row per provider process (planner, implementer,
 * reviewer...). The row is written PLANNED before anything is spawned, so a
 * controller that crashes between spawn and bookkeeping finds the intent on
 * restart and reconciles it from the worker directory's pid.json instead of
 * spawning a duplicate.
 *
 *   PLANNED -> RUNNING -> SUCCEEDED | FAILED | CANCELLED | LOST
 *   PLANNED -> FAILED | CANCELLED | LOST        (spawn failed, cancelled first, or never started)
 *   FAILED | LOST -> PLANNED                    (bounded restart; restart_count + 1)
 *
 * `state` is the controller's view of the process; `resultStatus` carries the
 * adapter's finer classification (max_turns, auth_failed, malformed_output...).
 * Every change appends a run event in the same transaction. Functions nest
 * inside a caller's `db.tx`, so the controller can check its lease and update
 * a worker atomically.
 *
 * Planning (or re-planning) a worker is new work for the run, so it is refused
 * once the run has a durable cancellation request or has ended (the end-of-run
 * curator, and only that role, may still be planned on an ended run), checked in the
 * same transaction as the insert: a cancellation that commits after the
 * controller last read the run still stops the spawn. Recording a process that
 * already exists stays allowed, so it can be stopped.
 */

export const WORKER_STATES = ['PLANNED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'LOST'] as const;
export type WorkerState = (typeof WORKER_STATES)[number];
export type FinishedWorkerState = Exclude<WorkerState, 'PLANNED' | 'RUNNING'>;

export const ACTIVE_WORKER_STATES: readonly WorkerState[] = ['PLANNED', 'RUNNING'];
const FINISHED_WORKER_STATES: ReadonlySet<string> = new Set<FinishedWorkerState>(['SUCCEEDED', 'FAILED', 'CANCELLED', 'LOST']);

const TERMINAL_RUN_STATES: ReadonlySet<string> = TERMINAL_STATES;

export function isWorkerState(value: string): value is WorkerState {
  return (WORKER_STATES as readonly string[]).includes(value);
}

export function isWorkerActive(state: WorkerState): boolean {
  return state === 'PLANNED' || state === 'RUNNING';
}

export interface WorkerRecord {
  id: string;
  runId: string;
  role: WorkerRole;
  purpose: string | null;
  provider: string;
  model: string | null;
  effort: string | null;
  state: WorkerState;
  attempt: number | null;
  candidateId: string | null;
  workerDir: string;
  cwd: string;
  /** Paths this worker may write, for the scheduler's ownership checks. */
  ownedPaths: string[] | null;
  pid: number | null;
  pgid: number | null;
  /** Start time from core/proc.processStartTime, to tell the worker from a recycled pid. */
  procStart: string | null;
  spawnedAt: number | null;
  endedAt: number | null;
  exitCode: number | null;
  signal: string | null;
  resultStatus: TaskStatus | null;
  resultJson: string | null;
  error: string | null;
  restartCount: number;
  cancelRequested: boolean;
  createdAt: number;
}

interface WorkerRow {
  id: string;
  run_id: string;
  role: string;
  purpose: string | null;
  provider: string;
  model: string | null;
  effort: string | null;
  state: string;
  attempt: number | null;
  candidate_id: string | null;
  worker_dir: string;
  cwd: string;
  owned_paths_json: string | null;
  pid: number | null;
  pgid: number | null;
  proc_start: string | null;
  spawned_at: number | null;
  ended_at: number | null;
  exit_code: number | null;
  signal: string | null;
  result_status: string | null;
  result_json: string | null;
  error: string | null;
  restart_count: number;
  cancel_requested: number;
  created_at: number;
}

function toRecord(r: WorkerRow): WorkerRecord {
  if (!isWorkerState(r.state)) throw new OrbitError('INTERNAL', `worker ${r.id} has unknown state ${r.state}`);
  return {
    id: r.id,
    runId: r.run_id,
    role: r.role as WorkerRole,
    purpose: r.purpose,
    provider: r.provider,
    model: r.model,
    effort: r.effort,
    state: r.state,
    attempt: r.attempt,
    candidateId: r.candidate_id,
    workerDir: r.worker_dir,
    cwd: r.cwd,
    ownedPaths: r.owned_paths_json === null ? null : (JSON.parse(r.owned_paths_json) as string[]),
    pid: r.pid,
    pgid: r.pgid,
    procStart: r.proc_start,
    spawnedAt: r.spawned_at,
    endedAt: r.ended_at,
    exitCode: r.exit_code,
    signal: r.signal,
    resultStatus: r.result_status as TaskStatus | null,
    resultJson: r.result_json,
    error: r.error,
    restartCount: r.restart_count,
    cancelRequested: r.cancel_requested === 1,
    createdAt: r.created_at,
  };
}

export interface NewWorker {
  id: string;
  runId: string;
  role: WorkerRole;
  purpose?: string | null;
  provider: string;
  model?: string | null;
  effort?: string | null;
  attempt?: number | null;
  candidateId?: string | null;
  workerDir: string;
  cwd: string;
  ownedPaths?: readonly string[] | null;
}

/** Persist the intent to start a worker. Must commit before the process is spawned. */
export function planWorker(db: OrbitDb, input: NewWorker, clock: Clock, actor = 'controller'): WorkerRecord {
  const now = clock.now();
  return db.tx(() => {
    assertRunAcceptsWork(db, input.runId, input.id, input.role === 'curator');
    if (db.get('SELECT 1 AS x FROM workers WHERE id = ?', input.id)) {
      throw new OrbitError('CONCURRENT_UPDATE', `worker ${input.id} already exists`, { workerId: input.id });
    }
    db.run(
      `INSERT INTO workers (id, run_id, role, purpose, provider, model, effort, state, attempt, candidate_id, worker_dir, cwd, owned_paths_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'PLANNED', ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.runId,
      input.role,
      input.purpose ?? null,
      input.provider,
      input.model ?? null,
      input.effort ?? null,
      input.attempt ?? null,
      input.candidateId ?? null,
      input.workerDir,
      input.cwd,
      input.ownedPaths ? JSON.stringify(input.ownedPaths) : null,
      now,
    );
    appendRunEvent(db, input.runId, 'worker.planned', actor, { worker_id: input.id, role: input.role, provider: input.provider, model: input.model ?? null, attempt: input.attempt ?? null }, now);
    return getWorker(db, input.id);
  });
}

export function getWorker(db: OrbitDb, id: string): WorkerRecord {
  const row = db.get<WorkerRow>('SELECT * FROM workers WHERE id = ?', id);
  if (!row) throw new OrbitError('NOT_FOUND', `no worker ${id}`);
  return toRecord(row);
}

export function findWorker(db: OrbitDb, id: string): WorkerRecord | null {
  const row = db.get<WorkerRow>('SELECT * FROM workers WHERE id = ?', id);
  return row ? toRecord(row) : null;
}

export interface WorkerQuery {
  runId?: string;
  states?: readonly WorkerState[];
  role?: WorkerRole;
  limit?: number;
}

/** Oldest first, the order they were planned in. */
export function listWorkers(db: OrbitDb, query: WorkerQuery = {}): WorkerRecord[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (query.runId !== undefined) {
    where.push('run_id = ?');
    params.push(query.runId);
  }
  if (query.states) {
    if (query.states.length === 0) return [];
    where.push(`state IN (${query.states.map(() => '?').join(',')})`);
    params.push(...query.states);
  }
  if (query.role !== undefined) {
    where.push('role = ?');
    params.push(query.role);
  }
  const sql = `SELECT * FROM workers ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at, rowid LIMIT ?`;
  return db.all<WorkerRow>(sql, ...params, query.limit ?? -1).map(toRecord);
}

/** PLANNED or RUNNING workers, across all runs unless `runId` is given. */
export function listActiveWorkers(db: OrbitDb, runId?: string): WorkerRecord[] {
  return listWorkers(db, { ...(runId === undefined ? {} : { runId }), states: ACTIVE_WORKER_STATES });
}

export function countActiveWorkers(db: OrbitDb, runId?: string): number {
  const row =
    runId === undefined
      ? db.get<{ n: number }>("SELECT COUNT(*) AS n FROM workers WHERE state IN ('PLANNED', 'RUNNING')")
      : db.get<{ n: number }>("SELECT COUNT(*) AS n FROM workers WHERE run_id = ? AND state IN ('PLANNED', 'RUNNING')", runId);
  return Number(row?.n ?? 0);
}

export interface WorkerProcess {
  pid: number;
  pgid: number;
  procStart: string | null;
  /** When the process was spawned, if known (from pid.json); defaults to now. */
  spawnedAt?: number;
}

/**
 * PLANNED -> RUNNING once the process exists. Idempotent for the same pid, so
 * reconciliation after a crash can replay it from pid.json.
 */
export function markWorkerRunning(db: OrbitDb, id: string, proc: WorkerProcess, clock: Clock, actor = 'controller'): WorkerRecord {
  const now = clock.now();
  // Raw `ps -o lstart=` pads with extra spaces; stored and compared collapsed,
  // as core/proc.isAlive compares them.
  const procStart = proc.procStart === null ? null : normalizeStart(proc.procStart);
  return db.tx(() => {
    const w = getWorker(db, id);
    if (w.state === 'RUNNING' && w.pid === proc.pid && w.procStart === procStart) return w;
    if (w.state !== 'PLANNED') {
      throw new OrbitError('TRANSITION_INVALID', `worker ${id} is ${w.state}; only a PLANNED worker can start`, { workerId: id, state: w.state });
    }
    const res = db.run(
      "UPDATE workers SET state = 'RUNNING', pid = ?, pgid = ?, proc_start = ?, spawned_at = ? WHERE id = ? AND state = 'PLANNED'",
      proc.pid,
      proc.pgid,
      procStart,
      proc.spawnedAt ?? now,
      id,
    );
    if (res.changes !== 1) throw new OrbitError('CONCURRENT_UPDATE', `worker ${id} changed while starting`);
    appendRunEvent(db, w.runId, 'worker.started', actor, { worker_id: id, pid: proc.pid, pgid: proc.pgid }, now);
    return getWorker(db, id);
  });
}

export interface WorkerOutcome {
  state: FinishedWorkerState;
  exitCode?: number | null;
  signal?: string | null;
  resultStatus?: TaskStatus | null;
  /** Stored as JSON. */
  result?: unknown;
  error?: string | null;
}

/**
 * Record how a worker ended. Repeating the same final state is a no-op (a
 * restarted controller may collect the same exit.json twice); a different
 * final state for a finished worker is rejected.
 */
export function finishWorker(db: OrbitDb, id: string, outcome: WorkerOutcome, clock: Clock, actor = 'controller'): WorkerRecord {
  if (!FINISHED_WORKER_STATES.has(outcome.state)) {
    throw new OrbitError('INTERNAL', `${String(outcome.state)} is not a final worker state`, { workerId: id, state: outcome.state });
  }
  const now = clock.now();
  return db.tx(() => {
    const w = getWorker(db, id);
    if (!isWorkerActive(w.state)) {
      if (w.state === outcome.state) return w;
      throw new OrbitError('TRANSITION_INVALID', `worker ${id} already finished as ${w.state}; cannot record ${outcome.state}`, { workerId: id, state: w.state });
    }
    if (outcome.state === 'SUCCEEDED' && w.state !== 'RUNNING') {
      throw new OrbitError('TRANSITION_INVALID', `worker ${id} never started; it cannot have succeeded`, { workerId: id });
    }
    const res = db.run(
      `UPDATE workers SET state = ?, ended_at = ?, exit_code = ?, signal = ?, result_status = ?, result_json = ?, error = ?
       WHERE id = ? AND state = ?`,
      outcome.state,
      now,
      outcome.exitCode ?? null,
      outcome.signal ?? null,
      outcome.resultStatus ?? null,
      outcome.result === undefined ? null : JSON.stringify(outcome.result),
      outcome.error ?? null,
      id,
      w.state,
    );
    if (res.changes !== 1) throw new OrbitError('CONCURRENT_UPDATE', `worker ${id} changed while finishing`);
    appendRunEvent(
      db,
      w.runId,
      'worker.finished',
      actor,
      { worker_id: id, state: outcome.state, result_status: outcome.resultStatus ?? null, exit_code: outcome.exitCode ?? null, signal: outcome.signal ?? null },
      now,
    );
    return getWorker(db, id);
  });
}

/** Durable cancellation request; the controller stops the process at its next step. No-op once finished. */
export function requestWorkerCancel(db: OrbitDb, id: string, clock: Clock, actor = 'controller', reason?: string): WorkerRecord {
  const now = clock.now();
  return db.tx(() => {
    const w = getWorker(db, id);
    if (!isWorkerActive(w.state) || w.cancelRequested) return w;
    db.run('UPDATE workers SET cancel_requested = 1 WHERE id = ?', id);
    appendRunEvent(db, w.runId, 'worker.cancel-requested', actor, { worker_id: id, ...(reason ? { reason } : {}) }, now);
    return getWorker(db, id);
  });
}

/**
 * Plan another attempt in the same row after a crash (FAILED or LOST):
 * process and result fields are cleared and restart_count goes up, which is
 * what bounds restarts. A cancelled or succeeded worker is never restarted.
 */
export function planWorkerRestart(db: OrbitDb, id: string, clock: Clock, actor = 'controller'): WorkerRecord {
  const now = clock.now();
  return db.tx(() => {
    const w = getWorker(db, id);
    if (w.state !== 'FAILED' && w.state !== 'LOST') {
      throw new OrbitError('TRANSITION_INVALID', `worker ${id} is ${w.state}; only a FAILED or LOST worker can restart`, { workerId: id, state: w.state });
    }
    if (w.cancelRequested) throw new OrbitError('CANCELLED', `worker ${id} was cancelled; it will not restart`, { workerId: id });
    assertRunAcceptsWork(db, w.runId, id);
    const res = db.run(
      `UPDATE workers SET state = 'PLANNED', restart_count = restart_count + 1, pid = NULL, pgid = NULL, proc_start = NULL,
         spawned_at = NULL, ended_at = NULL, exit_code = NULL, signal = NULL, result_status = NULL, result_json = NULL, error = NULL
       WHERE id = ? AND state = ?`,
      id,
      w.state,
    );
    if (res.changes !== 1) throw new OrbitError('CONCURRENT_UPDATE', `worker ${id} changed while restarting`);
    appendRunEvent(db, w.runId, 'worker.restart-planned', actor, { worker_id: id, previous_state: w.state, restart_count: w.restartCount + 1 }, now);
    return getWorker(db, id);
  });
}

/**
 * `endOfRun` is true only for the curator (ADR 0002): learning runs after the
 * terminal transition, as a recorded worker, and is the one role a terminal
 * run still takes. A durable cancellation request refuses it like any other.
 */
function assertRunAcceptsWork(db: OrbitDb, runId: string, workerId: string, endOfRun = false): void {
  const run = db.get<{ state: string; cancel_requested: number }>('SELECT state, cancel_requested FROM runs WHERE id = ?', runId);
  if (!run) throw new OrbitError('NOT_FOUND', `no run ${runId}`);
  if (run.cancel_requested === 1) {
    throw new OrbitError('CANCELLED', `run ${runId} has a durable cancellation request; worker ${workerId} will not be planned`, { runId, workerId });
  }
  if (TERMINAL_RUN_STATES.has(run.state) && !endOfRun) {
    throw new OrbitError('TRANSITION_INVALID', `run ${runId} is ${run.state}; it takes no new workers`, { runId, workerId, state: run.state });
  }
}

function appendRunEvent(db: OrbitDb, runId: string, type: string, actor: string, data: unknown, ts: number): void {
  appendEvent(db, runId, type, actor, data, ts);
}
