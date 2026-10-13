import type { Clock } from '../core/clock.ts';
import { nullLogger, type Logger } from '../core/log.ts';
import type { OrbitDb } from '../storage/db.ts';
import { getRun } from '../controller/run-store.ts';
import { releaseWorktrees } from '../controller/worktree-cleanup.ts';

/**
 * A run the recovery budget ended EXHAUSTED never reaches `finishRun`, which is what releases a finished run's
 * worktrees, so recovery releases them itself (the result lives in the candidate refs; an EXHAUSTED run has no way
 * back). Call it after the run's workers and checks are stopped. A no-op without the orbit home (the callers that
 * pass none keep the checkouts, as before) and for a run that is not EXHAUSTED. Never throws: cleanup must not change
 * an outcome.
 */
export async function releaseExhaustedRunWorktrees(input: { db: OrbitDb; clock: Clock; ownerId: string; runId: string; orbitHome: string | undefined; log?: Logger | undefined }): Promise<void> {
  if (input.orbitHome === undefined) return;
  const log = input.log ?? nullLogger;
  try {
    const run = getRun(input.db, input.runId);
    if (run.state !== 'EXHAUSTED') return;
    const used = input.db.get<{ used: number }>("SELECT used FROM budget_counters WHERE run_id = ? AND counter = 'implementation_attempts'", run.id)?.used;
    await releaseWorktrees({ db: input.db, clock: input.clock, log, ownerId: input.ownerId, run, orbitHome: input.orbitHome, attempt: Math.max(1, used ?? 1) });
  } catch (err) {
    log.warn('could not release the worktrees of an exhausted run', { run_id: input.runId, error: err instanceof Error ? err.message : String(err) });
  }
}
