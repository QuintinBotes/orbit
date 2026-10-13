import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Clock } from '../core/clock.ts';
import { nullLogger, type Logger } from '../core/log.ts';
import { OrbitError } from '../core/errors.ts';
import { TERMINAL_STATES } from '../core/run-states.ts';
import type { OrbitDb } from '../storage/db.ts';
import { worktreeRootFor } from '../controller/context.ts';
import { acquireLease, getRun, releaseLease, type RunRecord } from '../controller/run-store.ts';
import { releaseWorktrees, WORKTREES_RELEASED_EVENT, type WorktreesReleased } from '../controller/worktree-cleanup.ts';

/**
 * A run the recovery budget ended EXHAUSTED never reaches `finishRun`, which is what releases a finished run's
 * worktrees, so recovery releases them itself (the result lives in the candidate refs; an EXHAUSTED run has no way
 * back). So does a later pass for a finished run whose release is due again (releaseDue). Call it after the run's
 * workers and checks are stopped: the release keeps the checkout of any worker or check still active. A no-op without
 * the orbit home (the callers that pass none keep the checkouts, as before) and for a run that is not finished or is
 * BLOCKED. Never throws: cleanup must not change an outcome. Returns what the release recorded, or null when it
 * recorded nothing (no checkouts, nothing to do, or a failure, which is logged).
 */
export async function releaseEndedRunWorktrees(input: { db: OrbitDb; clock: Clock; ownerId: string; runId: string; orbitHome: string | undefined; log?: Logger | undefined }): Promise<WorktreesReleased | null> {
  if (input.orbitHome === undefined) return null;
  const log = input.log ?? nullLogger;
  try {
    const run = getRun(input.db, input.runId);
    if (!TERMINAL_STATES.has(run.state) || run.state === 'BLOCKED') return null;
    return await releaseRunCheckouts({ ...input, orbitHome: input.orbitHome, log });
  } catch (err) {
    log.warn('could not release the worktrees of a finished run', { run_id: input.runId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * Release a finished run's checkouts the way its end does (worktree-cleanup): every implementer checkout's unfinished
 * edits pinned in a ref first, and a checkout that must stay kept with why. Throws when the release cannot run, and,
 * with `root`, when the run's worktree directory is not that one (retention removes `root` and nothing else).
 */
export async function releaseRunCheckouts(input: { db: OrbitDb; clock: Clock; ownerId: string; runId: string; orbitHome: string; log?: Logger | undefined; root?: string }): Promise<WorktreesReleased | null> {
  const run = getRun(input.db, input.runId);
  if (input.root !== undefined && resolve(worktreeRootFor(input.orbitHome, run)) !== resolve(input.root)) {
    throw new OrbitError('INTERNAL', `the run's worktree directory is ${worktreeRootFor(input.orbitHome, run)}, not ${input.root}`, { runId: run.id });
  }
  const used = input.db.get<{ used: number }>("SELECT used FROM budget_counters WHERE run_id = ? AND counter = 'implementation_attempts'", run.id)?.used;
  return releaseWorktrees({ db: input.db, clock: input.clock, log: input.log ?? nullLogger, ownerId: input.ownerId, run, orbitHome: input.orbitHome, attempt: Math.max(1, used ?? 1) });
}

/**
 * Release a finished run's checkouts when its release is due (releaseDue), under the run's lease: the controller that
 * ended the run holds it until its own release is done, and a run another live controller holds is left to it. True
 * when a release was recorded. Never throws.
 */
export async function releaseIfDue(input: { db: OrbitDb; clock: Clock; ownerId: string; runId: string; orbitHome: string | undefined; leaseTtlMs: number; log?: Logger | undefined }): Promise<boolean> {
  try {
    if (!releaseDue(input.db, getRun(input.db, input.runId), input.orbitHome)) return false;
    if (!acquireLease(input.db, input.runId, input.ownerId, input.leaseTtlMs, input.clock)) return false;
  } catch (err) {
    (input.log ?? nullLogger).warn('could not resume the release of a finished run', { run_id: input.runId, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
  try {
    return (await releaseEndedRunWorktrees(input)) !== null;
  } finally {
    releaseLease(input.db, input.runId, input.ownerId);
  }
}

/**
 * Whether a finished run's release is due (again) at a controller start: the run ended (not BLOCKED), its worktree
 * directory is still there, and either no release completed (the controller died between the terminal transition and
 * the release, or the release failed) or the last one kept a checkout that may go now: the worker or check it waited
 * for has ended, or edits that could not be pinned (or a checkout that could not be removed) may be now. A release that
 * waited only for a worker or check that is still open is not due: it would wait again.
 */
export function releaseDue(db: OrbitDb, run: Pick<RunRecord, 'id' | 'state' | 'repoRoot'>, orbitHome: string | undefined): boolean {
  if (orbitHome === undefined || !TERMINAL_STATES.has(run.state) || run.state === 'BLOCKED') return false;
  if (!existsSync(worktreeRootFor(orbitHome, run))) return false;
  const row = db.get<{ data_json: string | null }>('SELECT data_json FROM events WHERE run_id = ? AND type = ? ORDER BY id DESC LIMIT 1', run.id, WORKTREES_RELEASED_EVENT);
  if (!row?.data_json) return true;
  let last: Partial<WorktreesReleased>;
  try {
    last = JSON.parse(row.data_json) as Partial<WorktreesReleased>;
  } catch {
    return true;
  }
  const retained = last.retained ?? [];
  const waiting = retained.length > 0 && retained.every((r) => r.cause === 'active-worker' || r.cause === 'active-check');
  return !(waiting && stillActive(db, run.id));
}

/** Whether a worker of the run is PLANNED or RUNNING, or a check run or fail-before probe attempt of it is still open. */
function stillActive(db: OrbitDb, runId: string): boolean {
  return (
    db.get(
      "SELECT 1 AS x FROM workers WHERE run_id = ? AND state IN ('PLANNED', 'RUNNING') UNION ALL SELECT 1 AS x FROM check_runs WHERE run_id = ? AND status IN ('PLANNED', 'RUNNING') UNION ALL SELECT 1 AS x FROM fail_before_probes WHERE run_id = ? AND status IN ('PLANNED', 'RUNNING') LIMIT 1",
      runId,
      runId,
      runId,
    ) !== undefined
  );
}
