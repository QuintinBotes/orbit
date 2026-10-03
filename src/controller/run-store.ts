import type { OrbitDb } from '../storage/db.ts';
import type { Clock } from '../core/clock.ts';
import { OrbitError } from '../core/errors.ts';
import { faultPoint } from '../core/faults.ts';
import { canTransition, isRunState, isTerminal, type RunState } from './states.ts';
import { appendEvent } from '../storage/events.ts';
import type { RunMode } from '../policy/types.ts';

export { appendEvent };
export type { RunMode };


export interface RunRecord {
  id: string;
  repoRoot: string;
  goal: string;
  mode: RunMode;
  state: RunState;
  /** The working stage to return to after INQUISITION, BLOCKED or RECOVERING. */
  resumeState: RunState | null;
  contractJson: string | null;
  contractHash: string | null;
  policyHash: string;
  policyPath: string;
  baseRevision: string | null;
  baseTree: string | null;
  branch: string | null;
  worktreePath: string | null;
  difficulty: string | null;
  difficultyJson: string | null;
  outcomeReason: string | null;
  outcomeJson: string | null;
  paused: boolean;
  cancelRequested: boolean;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  lastProgressAt: number | null;
  version: number;
}

interface RunRow {
  id: string;
  repo_root: string;
  goal: string;
  mode: string;
  state: string;
  resume_state: string | null;
  contract_json: string | null;
  contract_hash: string | null;
  policy_hash: string;
  policy_path: string;
  base_revision: string | null;
  base_tree: string | null;
  branch: string | null;
  worktree_path: string | null;
  difficulty: string | null;
  difficulty_json: string | null;
  outcome_reason: string | null;
  outcome_json: string | null;
  paused: number;
  cancel_requested: number;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  ended_at: number | null;
  last_progress_at: number | null;
  version: number;
}

function toRecord(r: RunRow): RunRecord {
  if (!isRunState(r.state)) throw new OrbitError('INTERNAL', `run ${r.id} has unknown state ${r.state}`);
  return {
    id: r.id,
    repoRoot: r.repo_root,
    goal: r.goal,
    mode: r.mode as RunMode,
    state: r.state,
    resumeState: r.resume_state && isRunState(r.resume_state) ? r.resume_state : null,
    contractJson: r.contract_json,
    contractHash: r.contract_hash,
    policyHash: r.policy_hash,
    policyPath: r.policy_path,
    baseRevision: r.base_revision,
    baseTree: r.base_tree,
    branch: r.branch,
    worktreePath: r.worktree_path,
    difficulty: r.difficulty,
    difficultyJson: r.difficulty_json,
    outcomeReason: r.outcome_reason,
    outcomeJson: r.outcome_json,
    paused: r.paused === 1,
    cancelRequested: r.cancel_requested === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    lastProgressAt: r.last_progress_at,
    version: r.version,
  };
}

export interface NewRun {
  id: string;
  repoRoot: string;
  goal: string;
  mode: RunMode;
  policyHash: string;
  policyPath: string;
}

export function createRun(db: OrbitDb, input: NewRun, clock: Clock, actor = 'cli'): RunRecord {
  const now = clock.now();
  return db.tx(() => {
    db.run(
      `INSERT INTO runs (id, repo_root, goal, mode, state, policy_hash, policy_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'CREATED', ?, ?, ?, ?)`,
      input.id,
      input.repoRoot,
      input.goal,
      input.mode,
      input.policyHash,
      input.policyPath,
      now,
      now,
    );
    appendEvent(db, input.id, 'run.created', actor, { mode: input.mode, policy_hash: input.policyHash }, now, null, 'CREATED');
    return getRun(db, input.id);
  });
}

export function getRun(db: OrbitDb, id: string): RunRecord {
  const row = db.get<RunRow>('SELECT * FROM runs WHERE id = ?', id);
  if (!row) throw new OrbitError('NOT_FOUND', `no run ${id}`);
  return toRecord(row);
}

export function findRun(db: OrbitDb, id: string): RunRecord | null {
  const row = db.get<RunRow>('SELECT * FROM runs WHERE id = ?', id);
  return row ? toRecord(row) : null;
}

export function listRuns(db: OrbitDb, opts: { states?: RunState[]; limit?: number } = {}): RunRecord[] {
  const limit = opts.limit ?? 50;
  if (opts.states?.length) {
    const marks = opts.states.map(() => '?').join(',');
    return db.all<RunRow>(`SELECT * FROM runs WHERE state IN (${marks}) ORDER BY created_at DESC LIMIT ?`, ...opts.states, limit).map(toRecord);
  }
  return db.all<RunRow>('SELECT * FROM runs ORDER BY created_at DESC LIMIT ?', limit).map(toRecord);
}


export interface TransitionRequest {
  runId: string;
  to: RunState;
  /** Lease holder making the change. Required for every controller-driven transition. */
  ownerId: string;
  reason: string;
  actor?: string;
  data?: unknown;
  /** Optimistic check: fail if the run moved since the caller read it. */
  expectedFrom?: RunState;
  /** Columns to update atomically with the transition. */
  patch?: Partial<Pick<RunRecord, 'outcomeReason' | 'outcomeJson' | 'contractJson' | 'contractHash' | 'baseRevision' | 'baseTree' | 'branch' | 'worktreePath' | 'difficulty' | 'difficultyJson'>>;
}

const PATCH_COLUMNS: Record<string, string> = {
  outcomeReason: 'outcome_reason',
  outcomeJson: 'outcome_json',
  contractJson: 'contract_json',
  contractHash: 'contract_hash',
  baseRevision: 'base_revision',
  baseTree: 'base_tree',
  branch: 'branch',
  worktreePath: 'worktree_path',
  difficulty: 'difficulty',
  difficultyJson: 'difficulty_json',
};

const INTERRUPTING: ReadonlySet<RunState> = new Set(['INQUISITION', 'BLOCKED', 'RECOVERING']);

/**
 * The only way a run changes state. Inside one IMMEDIATE transaction it
 * checks the caller's lease, the durable cancellation flag, the optimistic
 * expectation and the edge table, then updates the run and appends the event.
 */
export function transition(db: OrbitDb, req: TransitionRequest, clock: Clock): RunRecord {
  const now = clock.now();
  const updated = db.tx(() => {
    const run = getRun(db, req.runId);
    assertLeaseHeld(db, req.runId, req.ownerId, now);
    if (req.expectedFrom && run.state !== req.expectedFrom) {
      throw new OrbitError('CONCURRENT_UPDATE', `run ${run.id} is ${run.state}, expected ${req.expectedFrom}`);
    }
    if (run.cancelRequested && req.to !== 'CANCELLED') {
      throw new OrbitError('CANCELLED', `run ${run.id} has a durable cancellation request; only CANCELLED is allowed`);
    }
    if (!canTransition(run.state, req.to)) {
      throw new OrbitError('TRANSITION_INVALID', `run ${run.id}: ${run.state} -> ${req.to} is not an allowed transition`);
    }

    // Remember where to come back to when a working stage is interrupted, and
    // forget it once work resumes. RECOVERING keeps the stage that crashed.
    let resume = run.resumeState;
    if (INTERRUPTING.has(req.to) && !INTERRUPTING.has(run.state)) resume = run.state;
    if (!INTERRUPTING.has(req.to) && !isTerminal(req.to)) resume = null;

    const sets = ['state = ?', 'resume_state = ?', 'updated_at = ?', 'version = version + 1'];
    const params: (string | number | null)[] = [req.to, resume, now];
    if (run.startedAt === null && req.to !== 'CREATED') {
      sets.push('started_at = ?');
      params.push(now);
    }
    if (isTerminal(req.to)) {
      sets.push('ended_at = ?');
      params.push(now);
    }
    for (const [key, value] of Object.entries(req.patch ?? {})) {
      const col = PATCH_COLUMNS[key];
      if (!col) throw new OrbitError('INTERNAL', `cannot patch ${key} in a transition`);
      sets.push(`${col} = ?`);
      params.push((value as string | null | undefined) ?? null);
    }
    const res = db.run(`UPDATE runs SET ${sets.join(', ')} WHERE id = ? AND version = ?`, ...params, run.id, run.version);
    if (res.changes !== 1) throw new OrbitError('CONCURRENT_UPDATE', `run ${run.id} changed during transition`);
    appendEvent(db, run.id, 'state.transition', req.actor ?? 'controller', { reason: req.reason, ...(req.data ? { data: req.data } : {}) }, now, run.state, req.to);
    return getRun(db, run.id);
  });
  faultPoint('controller.transition.after-commit');
  return updated;
}

/** Record measurable progress (spec §7); feeds stall detection and the watchdog. */
export function markProgress(db: OrbitDb, runId: string, kind: string, detail: unknown, clock: Clock): void {
  const now = clock.now();
  db.tx(() => {
    db.run('UPDATE runs SET last_progress_at = ?, updated_at = ? WHERE id = ?', now, now, runId);
    appendEvent(db, runId, 'progress', 'controller', { kind, detail }, now);
  });
}

/** Durable cancellation. Takes effect at the controller's next safe point and survives restarts. */
export function requestCancel(db: OrbitDb, runId: string, actor: string, clock: Clock): RunRecord {
  const now = clock.now();
  return db.tx(() => {
    const run = getRun(db, runId);
    if (isTerminal(run.state) && run.state !== 'BLOCKED') return run;
    db.run('UPDATE runs SET cancel_requested = 1, updated_at = ?, version = version + 1 WHERE id = ?', now, runId);
    appendEvent(db, runId, 'run.cancel-requested', actor, null, now);
    return getRun(db, runId);
  });
}

export function setPaused(db: OrbitDb, runId: string, paused: boolean, actor: string, clock: Clock): RunRecord {
  const now = clock.now();
  return db.tx(() => {
    const run = getRun(db, runId);
    if (isTerminal(run.state) && run.state !== 'BLOCKED') {
      throw new OrbitError('TRANSITION_INVALID', `run ${runId} is ${run.state}; nothing to ${paused ? 'pause' : 'resume'}`);
    }
    db.run('UPDATE runs SET paused = ?, updated_at = ?, version = version + 1 WHERE id = ?', paused ? 1 : 0, now, runId);
    appendEvent(db, runId, paused ? 'run.paused' : 'run.unpaused', actor, null, now);
    return getRun(db, runId);
  });
}

// ---------------------------------------------------------------------------
// Leases

export interface Lease {
  runId: string;
  ownerId: string;
  acquiredAt: number;
  heartbeatAt: number;
  expiresAt: number;
}

/**
 * Take the run's lease if it is free, expired, or already ours. A takeover of
 * an expired lease is recorded as an event naming the previous owner, which is
 * how recovery knows a controller died mid-run.
 */
export function acquireLease(db: OrbitDb, runId: string, ownerId: string, ttlMs: number, clock: Clock): Lease | null {
  const now = clock.now();
  return db.tx(() => {
    const existing = db.get<{ owner_id: string; expires_at: number }>('SELECT owner_id, expires_at FROM leases WHERE run_id = ?', runId);
    if (existing && existing.owner_id !== ownerId && existing.expires_at > now) return null;
    if (existing) {
      db.run('UPDATE leases SET owner_id = ?, acquired_at = ?, heartbeat_at = ?, expires_at = ? WHERE run_id = ?', ownerId, now, now, now + ttlMs, runId);
    } else {
      db.run('INSERT INTO leases (run_id, owner_id, acquired_at, heartbeat_at, expires_at) VALUES (?, ?, ?, ?, ?)', runId, ownerId, now, now, now + ttlMs);
    }
    if (!existing || existing.owner_id !== ownerId) {
      appendEvent(db, runId, existing ? 'lease.takeover' : 'lease.acquired', ownerId, existing ? { previous_owner: existing.owner_id, expired_at: existing.expires_at } : null, now);
    }
    return { runId, ownerId, acquiredAt: now, heartbeatAt: now, expiresAt: now + ttlMs };
  });
}

/** Extend our lease. Returns false when it was lost (expired and taken, or released). */
export function renewLease(db: OrbitDb, runId: string, ownerId: string, ttlMs: number, clock: Clock): boolean {
  const now = clock.now();
  const res = db.run('UPDATE leases SET heartbeat_at = ?, expires_at = ? WHERE run_id = ? AND owner_id = ? AND expires_at > ?', now, now + ttlMs, runId, ownerId, now);
  return res.changes === 1;
}

export function releaseLease(db: OrbitDb, runId: string, ownerId: string): void {
  db.run('DELETE FROM leases WHERE run_id = ? AND owner_id = ?', runId, ownerId);
}

export function assertLeaseHeld(db: OrbitDb, runId: string, ownerId: string, now: number): void {
  const lease = db.get<{ owner_id: string; expires_at: number }>('SELECT owner_id, expires_at FROM leases WHERE run_id = ?', runId);
  if (!lease || lease.owner_id !== ownerId || lease.expires_at <= now) {
    throw new OrbitError('LEASE_LOST', `controller ${ownerId} does not hold the lease for run ${runId}`);
  }
}

export function getLease(db: OrbitDb, runId: string): Lease | null {
  const r = db.get<{ run_id: string; owner_id: string; acquired_at: number; heartbeat_at: number; expires_at: number }>('SELECT * FROM leases WHERE run_id = ?', runId);
  return r ? { runId: r.run_id, ownerId: r.owner_id, acquiredAt: r.acquired_at, heartbeatAt: r.heartbeat_at, expiresAt: r.expires_at } : null;
}
