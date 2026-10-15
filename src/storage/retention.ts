import { existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Clock } from '../core/clock.ts';
import { execCapture } from '../core/exec.ts';
import { sha256 } from '../core/hash.ts';
import type { OrbitDb } from './db.ts';
import { appendEvent } from './events.ts';
import { releaseRunCheckouts } from '../recovery/release.ts';

/**
 * Artifact retention (spec section 3, `retention.keep_runs_days`). A run that
 * ended longer ago than the retention period loses its artifacts: the run
 * directory `.orbit/runs/<id>/` (snapshot, evidence, worker logs, final.md)
 * and its worktrees under `<orbit home>/worktrees/<repo key>/<id>/`. The
 * SQLite rows stay, so `orbit status` and the statistics still know the run,
 * and the run is marked with a `run.artifacts_pruned` event, which is also
 * what makes a second pass skip it.
 *
 * Only finished runs are touched: SUCCEEDED, EXHAUSTED, IMPOSSIBLE and
 * CANCELLED. A BLOCKED run is never pruned, whatever its age, because it can
 * be resumed and its evidence is what the person resolving it reads. A run
 * still holding an unexpired lease (its controller is writing the report or
 * learning from it) waits for the next pass, and so does a run with a worker
 * still PLANNED or RUNNING (its stop was never confirmed, so it may still be
 * writing in its checkout). A run whose worktree directory is still there is
 * released first, as its end releases it (recovery/release): every
 * implementer checkout's unfinished work is pinned in a ref before anything
 * goes, and a run whose release keeps a checkout (a check that may still run
 * in it, work that could not be pinned, a checkout that could not be removed)
 * is skipped and reported, so its checkout is never deleted unpinned. Nothing
 * outside the two locations above is ever removed: a run whose recorded paths
 * point anywhere else is skipped and reported.
 */

export const PRUNABLE_STATES: readonly string[] = Object.freeze(['SUCCEEDED', 'EXHAUSTED', 'IMPOSSIBLE', 'CANCELLED']);
export const ARTIFACTS_PRUNED_EVENT = 'run.artifacts_pruned';

const DAY_MS = 86_400_000;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface PruneOptions {
  repoRoot: string;
  /** retention.keep_runs_days from the policy; a run is pruned once it ended more than this many days ago. */
  keepDays: number;
  clock: Clock;
  /** Orbit's home (ORBIT_HOME, default ~/.orbit), where worktrees live. */
  orbitHome?: string;
  /** Report what would be pruned without removing anything or writing events. */
  dryRun?: boolean;
}

export interface PrunedRun {
  runId: string;
  state: string;
  endedAt: number;
  /** Paths removed (or, in a dry run, that would be). */
  removed: string[];
}

export interface PruneResult {
  cutoff: number;
  pruned: PrunedRun[];
  /** Expired runs left alone, with the reason. */
  skipped: { runId: string; reason: string }[];
}

interface RunRow {
  id: string;
  state: string;
  policy_path: string;
  ended_at: number | null;
  updated_at: number;
}

/** Short stable id of a repository, for paths under the Orbit home (same derivation as controller/context repoKey). */
export function repoKeyFor(repoRoot: string): string {
  let real = repoRoot;
  try {
    real = realpathSync(repoRoot);
  } catch {
    /* a missing repository keeps its literal path */
  }
  return sha256(real).slice(0, 12);
}

export async function pruneExpiredRuns(db: OrbitDb, opts: PruneOptions): Promise<PruneResult> {
  if (!Number.isInteger(opts.keepDays) || opts.keepDays < 0) throw new RangeError(`keepDays must be a non-negative integer (got ${String(opts.keepDays)})`);
  const now = opts.clock.now();
  const cutoff = now - opts.keepDays * DAY_MS;
  const repoRoot = realOrResolved(opts.repoRoot);
  const runsRoot = join(repoRoot, '.orbit', 'runs');
  const home = opts.orbitHome ?? process.env.ORBIT_HOME ?? join(homedir(), '.orbit');
  const worktreesRoot = join(home, 'worktrees', repoKeyFor(repoRoot));

  const placeholders = PRUNABLE_STATES.map(() => '?').join(', ');
  const rows = db.all<RunRow>(
    `SELECT r.id, r.state, r.policy_path, r.ended_at, r.updated_at FROM runs r
     WHERE r.state IN (${placeholders}) AND COALESCE(r.ended_at, r.updated_at) ${opts.keepDays === 0 ? '<=' : '<'} ?
       AND NOT EXISTS (SELECT 1 FROM events e WHERE e.run_id = r.id AND e.type = ?)
     ORDER BY COALESCE(r.ended_at, r.updated_at), r.id`,
    ...PRUNABLE_STATES,
    cutoff,
    ARTIFACTS_PRUNED_EVENT,
  );

  const result: PruneResult = { cutoff, pruned: [], skipped: [] };
  let removedWorktree = false;
  for (const row of rows) {
    if (!RUN_ID.test(row.id) || row.id.includes('..')) {
      result.skipped.push({ runId: row.id, reason: 'the run id cannot name a directory safely' });
      continue;
    }
    const lease = db.get<{ expires_at: number }>('SELECT expires_at FROM leases WHERE run_id = ?', row.id);
    if (lease && lease.expires_at > now) {
      result.skipped.push({ runId: row.id, reason: 'a controller still holds its lease' });
      continue;
    }
    // A worker whose stop was never confirmed may still be writing in its checkout: nothing is removed beneath it.
    const live = db.all<{ id: string; state: string }>("SELECT id, state FROM workers WHERE run_id = ? AND state IN ('PLANNED', 'RUNNING') ORDER BY created_at, rowid", row.id);
    if (live.length > 0) {
      result.skipped.push({ runId: row.id, reason: `${live.map((w) => `worker ${w.id} (${w.state})`).join(', ')} may still be running: its termination is not confirmed (the next controller start stops it)` });
      continue;
    }
    const runDir = join(runsRoot, row.id);
    // The recorded snapshot must live in this repository's run directory; anything else is not ours to delete.
    const recorded = dirname(row.policy_path);
    const literalRunDir = join(resolve(opts.repoRoot), '.orbit', 'runs', row.id);
    if (![runDir, literalRunDir].includes(resolve(recorded)) && realOrResolved(recorded) !== runDir) {
      result.skipped.push({ runId: row.id, reason: `its recorded run directory ${recorded} is not ${runDir}` });
      continue;
    }
    const worktree = join(worktreesRoot, row.id);
    const targets = [runDir, worktree].filter((p) => isRealDirectory(p));
    if (!opts.dryRun && targets.includes(worktree)) {
      const kept = await releaseBeforePrune(db, row.id, worktree, home, opts.clock);
      if (kept !== null) {
        result.skipped.push({ runId: row.id, reason: kept });
        continue;
      }
    }
    if (!opts.dryRun) {
      for (const t of targets) rmSync(t, { recursive: true, force: true });
      db.tx(() => appendEvent(db, row.id, ARTIFACTS_PRUNED_EVENT, 'gc', { keep_runs_days: opts.keepDays, removed: targets }, now));
      if (targets.some((t) => t.startsWith(worktreesRoot))) removedWorktree = true;
    }
    result.pruned.push({ runId: row.id, state: row.state, endedAt: row.ended_at ?? row.updated_at, removed: targets });
  }
  // Git keeps an administrative entry for every worktree; drop the ones whose directories are gone.
  if (removedWorktree && existsSync(join(repoRoot, '.git'))) {
    await execCapture(['git', 'worktree', 'prune'], { cwd: repoRoot, timeoutMs: 30_000 }).catch(() => undefined);
  }
  return result;
}

/**
 * Release the run's checkouts before its worktree directory is removed, its unfinished work pinned first: null when
 * nothing is left in the way, otherwise why the run is skipped (the release kept a checkout, or could not run).
 */
async function releaseBeforePrune(db: OrbitDb, runId: string, worktree: string, orbitHome: string, clock: Clock): Promise<string | null> {
  try {
    const out = await releaseRunCheckouts({ db, clock, ownerId: 'gc', runId, orbitHome, root: worktree });
    const kept = out?.retained ?? [];
    return kept.length === 0 ? null : `its release kept ${kept.map((r) => `${r.path} (${r.why})`).join('; ')}`;
  } catch (err) {
    return `its checkouts could not be released, so nothing was removed (${(err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 300)})`;
  }
}

function realOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** A directory itself, not a symlink to one: removing through a link would delete what it points at. */
function isRealDirectory(p: string): boolean {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}
