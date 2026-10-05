import { hostname } from 'node:os';
import { join } from 'node:path';
import { statSync } from 'node:fs';
import type { Clock } from '../core/clock.ts';
import { isAlive } from '../core/proc.ts';
import { TERMINAL_STATES, type RunState } from '../core/run-states.ts';
import type { OrbitDb } from '../storage/db.ts';
import { appendEvent } from '../storage/events.ts';
import { listStaleControllers, markControllerStopped } from '../storage/controllers.ts';
import { listWorkers, type WorkerRecord } from '../storage/workers.ts';
import { getLease, getRun, listRuns, transition, type RunRecord } from '../controller/run-store.ts';
import type { ProviderAdapter } from '../adapters/types.ts';
import { LOG_FILE } from '../adapters/shim.ts';
import { enterRecovery, type EnterRecoveryOutcome, type LedgerFor } from './budget.ts';
import { stopWorker } from './reconcile.ts';

/**
 * The watchdog (spec section 4: "Publish heartbeat and last-progress
 * timestamps. Support a watchdog"; section 14 "Timeout").
 *
 * It tells a stalled run from a busy one using what the controller publishes:
 * `runs.last_progress_at` (measurable progress, spec section 7), worker log
 * activity, the age of the current step, and controller heartbeats. It
 * acts on one thing only: a run this owner leases whose step has outlived its
 * timeout is abandoned (its workers stopped) and moved to RECOVERING, where
 * the controller reconciles and resumes within the recovery budget. Everything
 * else is a finding for logs and `orbit status`.
 *
 * It does not steal leases. A stale controller's leases expire on their own
 * clock (a lease is only valid while renewed), after which any controller's
 * reconcileOnStart takes them over; the watchdog just reports who is stale and
 * records dead incarnations as stopped.
 */

export interface WatchdogConfig {
  /** No progress for this long is reported as a stall. Default 10 min. */
  stallMs: number;
  /** A controller whose heartbeat is older than this is stale. Default 90 s. */
  controllerStaleMs: number;
  /** A step this long without activity is abandoned, by state. */
  stepTimeoutMs: Partial<Record<RunState, number>>;
  /** Used for states with no entry. Default 60 min. */
  defaultStepTimeoutMs: number;
  /** Wait between escalation signals when stopping workers. Real time. Default 2 s. */
  graceMs: number;
}

const MIN = 60_000;

export const DEFAULT_WATCHDOG: Readonly<WatchdogConfig> = Object.freeze({
  stallMs: 10 * MIN,
  controllerStaleMs: 90_000,
  stepTimeoutMs: {
    PREFLIGHT: 15 * MIN,
    CONTRACTING: 20 * MIN,
    PLANNING: 30 * MIN,
    IMPLEMENTING: 60 * MIN,
    VERIFYING: 45 * MIN,
    REVIEWING: 30 * MIN,
    DELIVERING: 20 * MIN,
    AWAITING_CI: 75 * MIN,
    DIAGNOSING: 30 * MIN,
    REPAIRING: 60 * MIN,
    // Recovery that does not finish is itself a failure to report, not to retry forever.
    RECOVERING: 15 * MIN,
  },
  defaultStepTimeoutMs: 60 * MIN,
  graceMs: 2_000,
});

export type WatchdogFindingKind = 'stalled-run' | 'stuck-step' | 'stale-controller' | 'wedged-controller' | 'expired-lease' | 'error';

export interface WatchdogFinding {
  kind: WatchdogFindingKind;
  runId?: string;
  controllerId?: string;
  /** Human-readable, without secrets. */
  detail: string;
  /** What the watchdog did about it; null for report-only findings. */
  action: 'abandoned-to-recovering' | 'exhausted' | 'blocked' | 'marked-stopped' | null;
}

export interface WatchdogReport {
  at: number;
  findings: WatchdogFinding[];
}

export interface WatchdogOptions {
  db: OrbitDb;
  clock: Clock;
  /** This controller. Only runs it leases are acted on. */
  ownerId: string;
  adapters: Readonly<Record<string, ProviderAdapter>>;
  config?: Partial<WatchdogConfig>;
  /** Report only; change nothing. */
  dryRun?: boolean;
  ledgerFor?: LedgerFor;
  fallbackRecoveries?: number;
  /** When a worker last wrote to its log (epoch ms), as activity evidence; default the log file's mtime. */
  workerActivityAt?: (worker: WorkerRecord) => number | null;
  /** The host this controller runs on, to decide whether a controller's pid can be inspected. */
  host?: string;
}

/**
 * One pass. Safe to call every few seconds from the controller loop or a
 * service supervisor; it takes no locks beyond the transactions it opens.
 */
export async function watchdogTick(opts: WatchdogOptions): Promise<WatchdogReport> {
  const cfg: WatchdogConfig = { ...DEFAULT_WATCHDOG, ...opts.config, stepTimeoutMs: { ...DEFAULT_WATCHDOG.stepTimeoutMs, ...opts.config?.stepTimeoutMs } };
  const now = opts.clock.now();
  const report: WatchdogReport = { at: now, findings: [] };
  watchControllers(opts, cfg, report);
  const runs = listRuns(opts.db, { states: watchedStates(), limit: 1_000_000 });
  for (const run of runs) {
    try {
      await watchRun(opts, cfg, run, report);
    } catch (err) {
      // One run the watchdog cannot act on (a lease lost mid-tick, a concurrent transition) must not blind it to the others.
      const message = err instanceof Error ? err.message : String(err);
      report.findings.push({ kind: 'error', runId: run.id, detail: `the watchdog could not act on run ${run.id}: ${message}`, action: null });
    }
  }
  return report;
}

/** Not CREATED (nothing has started) and not INQUISITION (waiting for a person is not a stall). */
function watchedStates(): RunState[] {
  return ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'DELIVERING', 'AWAITING_CI', 'DIAGNOSING', 'REPAIRING', 'RECOVERING'];
}

// ---------------------------------------------------------------------------
// controllers and leases

function watchControllers(opts: WatchdogOptions, cfg: WatchdogConfig, report: WatchdogReport): void {
  const { db, clock } = opts;
  const host = opts.host ?? hostname();
  for (const c of listStaleControllers(db, cfg.controllerStaleMs, clock)) {
    if (c.id === opts.ownerId) continue;
    const ageS = Math.round((clock.now() - c.heartbeatAt) / 1000);
    // A heartbeat that stopped while the process lives is a wedged controller: stalled, not dead. Only the service manager may kill it.
    if (c.host === host && controllerProcessAlive(c.pid, c.procStart)) {
      report.findings.push({ kind: 'wedged-controller', controllerId: c.id, detail: `controller ${c.id} (pid ${c.pid}) is alive but has not heartbeat for ${ageS} s`, action: null });
      continue;
    }
    if (!opts.dryRun) markControllerStopped(db, c.id, 'watchdog: heartbeat stale and the process is gone', clock);
    report.findings.push({ kind: 'stale-controller', controllerId: c.id, detail: `controller ${c.id} has not heartbeat for ${ageS} s and its process is gone; its leases expire on their own`, action: opts.dryRun ? null : 'marked-stopped' });
  }
  const terminal = [...TERMINAL_STATES].map((s) => `'${s}'`).join(',');
  const expired = db.all<{ run_id: string; owner_id: string; expires_at: number }>(
    `SELECT l.run_id, l.owner_id, l.expires_at FROM leases l JOIN runs r ON r.id = l.run_id WHERE l.expires_at <= ? AND r.state NOT IN (${terminal}) ORDER BY l.expires_at`,
    clock.now(),
  );
  for (const l of expired) {
    if (l.owner_id === opts.ownerId) continue;
    report.findings.push({ kind: 'expired-lease', runId: l.run_id, controllerId: l.owner_id, detail: `the lease of run ${l.run_id} held by ${l.owner_id} expired ${Math.round((clock.now() - l.expires_at) / 1000)} s ago; any controller may take it over`, action: null });
  }
}

function controllerProcessAlive(pid: number, start: string | null): boolean {
  try {
    return isAlive(pid, start);
  } catch {
    // Cannot inspect the process table: do not declare a controller dead on a guess.
    return true;
  }
}

// ---------------------------------------------------------------------------
// runs

async function watchRun(opts: WatchdogOptions, cfg: WatchdogConfig, run: RunRecord, report: WatchdogReport): Promise<void> {
  const { db, clock } = opts;
  if (run.paused) return;
  const now = clock.now();
  const stepStart = lastTransitionAt(db, run) ?? run.updatedAt;
  const lease = getLease(db, run.id);
  const workers = listWorkers(db, { runId: run.id, states: ['PLANNED', 'RUNNING'] });
  const activity = workers.map((w) => workerActivity(opts, w, now)).filter((t): t is number => t !== null);
  // Activity is the latest evidence of life for this run: progress recorded for it, a worker still writing its log, or the step starting.
  // The owner controller's own last_progress_at is not used: it moves when any of its runs progresses, so it would hide a stuck one.
  const lastActivity = Math.max(stepStart, run.lastProgressAt ?? 0, ...activity);
  const idle = now - lastActivity;
  const timeout = cfg.stepTimeoutMs[run.state] ?? cfg.defaultStepTimeoutMs;

  if (idle >= timeout) {
    const detail = `run ${run.id} has been in ${run.state} for ${minutes(now - stepStart)} min with no activity for ${minutes(idle)} min (the step timeout is ${minutes(timeout)} min)`;
    const ours = lease !== null && lease.ownerId === opts.ownerId && lease.expiresAt > now;
    if (opts.dryRun || !ours) {
      report.findings.push({ kind: 'stuck-step', runId: run.id, detail: ours ? detail : `${detail}; not ours to act on (lease: ${lease?.ownerId ?? 'none'})`, action: null });
      return;
    }
    report.findings.push({ kind: 'stuck-step', runId: run.id, detail, action: await abandon(opts, run, workers, detail) });
    return;
  }

  if (idle >= cfg.stallMs && !alreadyReported(db, run.id, lastActivity)) {
    const detail = `run ${run.id} in ${run.state} has recorded no progress for ${minutes(idle)} min`;
    report.findings.push({ kind: 'stalled-run', runId: run.id, detail, action: null });
    if (!opts.dryRun) db.tx(() => appendEvent(db, run.id, 'watchdog.stall', opts.ownerId, { state: run.state, idle_ms: idle, last_activity_at: lastActivity }, now));
  }
}

const minutes = (ms: number): number => Math.round(ms / MIN);

function lastTransitionAt(db: OrbitDb, run: RunRecord): number | null {
  const row = db.get<{ ts: number }>("SELECT ts FROM events WHERE run_id = ? AND type = 'state.transition' AND to_state = ? ORDER BY id DESC LIMIT 1", run.id, run.state);
  return row?.ts ?? null;
}

/** One stall report per quiet period: a report newer than the last activity already says it. */
function alreadyReported(db: OrbitDb, runId: string, lastActivity: number): boolean {
  const row = db.get<{ ts: number | null }>("SELECT MAX(ts) AS ts FROM events WHERE run_id = ? AND type = 'watchdog.stall'", runId);
  return row?.ts != null && row.ts >= lastActivity;
}

function workerActivity(opts: WatchdogOptions, w: WorkerRecord, now: number): number | null {
  let t: number | null;
  if (opts.workerActivityAt) t = opts.workerActivityAt(w);
  else {
    try {
      t = statSync(join(w.workerDir, LOG_FILE)).mtimeMs;
    } catch {
      t = null;
    }
  }
  // A timestamp from the future (a different clock) says nothing about activity under this one.
  return t !== null && t <= now ? t : null;
}

/**
 * Abandon the step: stop its workers, then RECOVERING (spending a recovery
 * attempt, EXHAUSTED when none are left). A step stuck inside RECOVERING has
 * nothing further to recover to, so the run is BLOCKED for a person.
 */
async function abandon(opts: WatchdogOptions, run: RunRecord, workers: WorkerRecord[], detail: string): Promise<WatchdogFinding['action']> {
  const { db, clock, ownerId } = opts;
  for (const w of workers) {
    await stopWorker({ db, clock, ownerId, adapters: opts.adapters, graceMs: opts.config?.graceMs ?? DEFAULT_WATCHDOG.graceMs }, w, `abandoned by the watchdog: ${detail}`);
  }
  // A durable cancellation leaves only CANCELLED reachable, and that is the controller's step: stopping the workers was all there was to do.
  if (getRun(db, run.id).cancelRequested) return null;
  if (run.state === 'RECOVERING') {
    transition(
      db,
      { runId: run.id, to: 'BLOCKED', ownerId, reason: `recovery did not finish: ${detail}`, actor: ownerId, expectedFrom: 'RECOVERING', patch: { outcomeReason: `Recovery did not finish: ${detail}. Inspect the run with \`orbit status ${run.id}\`, fix the environment, then \`orbit resume ${run.id}\`.` } },
      clock,
    );
    return 'blocked';
  }
  const out: EnterRecoveryOutcome = enterRecovery(db, clock, { runId: run.id, ownerId, reason: `watchdog: ${detail}`, ledgerFor: opts.ledgerFor, fallbackMax: opts.fallbackRecoveries });
  if (out.outcome === 'exhausted') return 'exhausted';
  return out.outcome === 'recovering' || out.outcome === 'already-recovering' ? 'abandoned-to-recovering' : null;
}

export interface WatchdogLoopOptions extends WatchdogOptions {
  intervalMs: number;
  signal: AbortSignal;
  onReport?: (report: WatchdogReport) => void;
  /** A failing tick is reported here and the loop goes on: the watchdog must outlive what it watches. */
  onError?: (err: unknown) => void;
}

/** Tick until aborted. */
export async function watchdogLoop(opts: WatchdogLoopOptions): Promise<void> {
  while (!opts.signal.aborted) {
    try {
      opts.onReport?.(await watchdogTick(opts));
    } catch (err) {
      opts.onError?.(err);
    }
    if (opts.signal.aborted) return;
    await opts.clock.sleep(opts.intervalMs);
  }
}
