import type { Clock } from '../core/clock.ts';
import { nullLogger, type Logger } from '../core/log.ts';
import { TERMINAL_STATES } from '../core/run-states.ts';
import type { OrbitDb } from '../storage/db.ts';
import { getRun } from '../controller/run-store.ts';
import { releaseWorktrees, WORKTREES_RELEASED_EVENT, type WorktreesReleased } from '../controller/worktree-cleanup.ts';

/**
 * A run the recovery budget ended EXHAUSTED never reaches `finishRun`, which is what releases a finished run's
 * worktrees, so recovery releases them itself (the result lives in the candidate refs; an EXHAUSTED run has no way
 * back). So does a later pass for a finished run whose release kept a checkout because a worker of it might still be
 * writing there, once no worker of the run is active. Call it after the run's workers and checks are stopped: the
 * release keeps the checkout of any worker still active. A no-op without the orbit home (the callers that pass none
 * keep the checkouts, as before) and for a run that is not finished or is BLOCKED. Never throws: cleanup must not
 * change an outcome.
 */
export async function releaseEndedRunWorktrees(input: { db: OrbitDb; clock: Clock; ownerId: string; runId: string; orbitHome: string | undefined; log?: Logger | undefined }): Promise<void> {
  if (input.orbitHome === undefined) return;
  const log = input.log ?? nullLogger;
  try {
    const run = getRun(input.db, input.runId);
    if (!TERMINAL_STATES.has(run.state) || run.state === 'BLOCKED') return;
    const used = input.db.get<{ used: number }>("SELECT used FROM budget_counters WHERE run_id = ? AND counter = 'implementation_attempts'", run.id)?.used;
    await releaseWorktrees({ db: input.db, clock: input.clock, log, ownerId: input.ownerId, run, orbitHome: input.orbitHome, attempt: Math.max(1, used ?? 1) });
  } catch (err) {
    log.warn('could not release the worktrees of a finished run', { run_id: input.runId, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Whether the run's last release kept a checkout only because a worker of it was still active, and no worker of the
 * run is active now: its termination is confirmed, so the checkout can go (its edits pinned first).
 */
export function releaseAwaitsTermination(db: OrbitDb, runId: string): boolean {
  const row = db.get<{ data_json: string | null }>('SELECT data_json FROM events WHERE run_id = ? AND type = ? ORDER BY id DESC LIMIT 1', runId, WORKTREES_RELEASED_EVENT);
  if (!row?.data_json) return false;
  let last: Partial<WorktreesReleased>;
  try {
    last = JSON.parse(row.data_json) as Partial<WorktreesReleased>;
  } catch {
    return false;
  }
  if (!(last.retained ?? []).some((r) => r.cause === 'active-worker')) return false;
  return db.get("SELECT 1 AS x FROM workers WHERE run_id = ? AND state IN ('PLANNED', 'RUNNING') LIMIT 1", runId) === undefined;
}
