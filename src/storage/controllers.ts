import type { OrbitDb } from './db.ts';
import type { Clock } from '../core/clock.ts';
import { OrbitError } from '../core/errors.ts';

/**
 * The controllers table: one row per controller incarnation (the owner id
 * from core/ids.newOwnerId). Heartbeats and last-progress times are what
 * `orbit status` and `orbit doctor` publish (spec §4), and what tells a
 * watchdog that a controller is wedged rather than idle: heartbeat fresh but
 * progress stale. A row whose heartbeat stops without a stop record is a
 * controller that died; recovery uses `listStaleControllers` to find it.
 */

export type ControllerMode = 'service' | 'foreground';

export interface ControllerRecord {
  id: string;
  pid: number;
  host: string;
  /** Start time from core/proc.processStartTime, so a recycled pid is not mistaken for the controller. */
  procStart: string | null;
  mode: ControllerMode;
  startedAt: number;
  heartbeatAt: number;
  lastProgressAt: number | null;
  stoppedAt: number | null;
  stopReason: string | null;
}

interface ControllerRow {
  id: string;
  pid: number;
  host: string;
  proc_start: string | null;
  mode: string;
  started_at: number;
  heartbeat_at: number;
  last_progress_at: number | null;
  stopped_at: number | null;
  stop_reason: string | null;
}

function toRecord(r: ControllerRow): ControllerRecord {
  return {
    id: r.id,
    pid: r.pid,
    host: r.host,
    procStart: r.proc_start,
    mode: r.mode as ControllerMode,
    startedAt: r.started_at,
    heartbeatAt: r.heartbeat_at,
    lastProgressAt: r.last_progress_at,
    stoppedAt: r.stopped_at,
    stopReason: r.stop_reason,
  };
}

export interface NewController {
  id: string;
  pid: number;
  host: string;
  procStart?: string | null;
  mode: ControllerMode;
}

export function registerController(db: OrbitDb, input: NewController, clock: Clock): ControllerRecord {
  const now = clock.now();
  return db.tx(() => {
    if (db.get('SELECT 1 AS x FROM controllers WHERE id = ?', input.id)) {
      // Owner ids are unique per incarnation; a repeat means two processes share one.
      throw new OrbitError('CONCURRENT_UPDATE', `controller ${input.id} is already registered`, { controllerId: input.id });
    }
    db.run(
      'INSERT INTO controllers (id, pid, host, proc_start, mode, started_at, heartbeat_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      input.id,
      input.pid,
      input.host,
      input.procStart ?? null,
      input.mode,
      now,
      now,
    );
    return getController(db, input.id);
  });
}

/**
 * Publish liveness; with `progress` also record that work moved forward.
 * Returns false when the controller is unknown or already marked stopped, so
 * an incarnation that was declared dead learns it should exit.
 */
export function heartbeatController(db: OrbitDb, id: string, clock: Clock, opts: { progress?: boolean } = {}): boolean {
  const now = clock.now();
  const res = opts.progress
    ? db.run('UPDATE controllers SET heartbeat_at = ?, last_progress_at = ? WHERE id = ? AND stopped_at IS NULL', now, now, id)
    : db.run('UPDATE controllers SET heartbeat_at = ? WHERE id = ? AND stopped_at IS NULL', now, id);
  return res.changes === 1;
}

/** Record a stop (graceful shutdown, or a dead incarnation found by recovery). The first reason wins. */
export function markControllerStopped(db: OrbitDb, id: string, reason: string, clock: Clock): ControllerRecord {
  const now = clock.now();
  return db.tx(() => {
    const c = getController(db, id);
    if (c.stoppedAt !== null) return c;
    db.run('UPDATE controllers SET stopped_at = ?, stop_reason = ? WHERE id = ? AND stopped_at IS NULL', now, reason, id);
    return getController(db, id);
  });
}

export function getController(db: OrbitDb, id: string): ControllerRecord {
  const row = db.get<ControllerRow>('SELECT * FROM controllers WHERE id = ?', id);
  if (!row) throw new OrbitError('NOT_FOUND', `no controller ${id}`);
  return toRecord(row);
}

export function findController(db: OrbitDb, id: string): ControllerRecord | null {
  const row = db.get<ControllerRow>('SELECT * FROM controllers WHERE id = ?', id);
  return row ? toRecord(row) : null;
}

/** Most recent heartbeat first. Stopped incarnations only when asked for. */
export function listControllers(db: OrbitDb, opts: { includeStopped?: boolean; limit?: number } = {}): ControllerRecord[] {
  const where = opts.includeStopped ? '' : 'WHERE stopped_at IS NULL';
  return db.all<ControllerRow>(`SELECT * FROM controllers ${where} ORDER BY heartbeat_at DESC, rowid DESC LIMIT ?`, opts.limit ?? -1).map(toRecord);
}

/**
 * Controllers not marked stopped whose last heartbeat is at least
 * `staleAfterMs` old: crashed, killed, or wedged. Oldest heartbeat first.
 */
export function listStaleControllers(db: OrbitDb, staleAfterMs: number, clock: Clock): ControllerRecord[] {
  const cutoff = clock.now() - staleAfterMs;
  return db.all<ControllerRow>('SELECT * FROM controllers WHERE stopped_at IS NULL AND heartbeat_at <= ? ORDER BY heartbeat_at, rowid', cutoff).map(toRecord);
}
