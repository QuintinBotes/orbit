import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Clock } from '../core/clock.ts';
import { nullLogger, type Logger } from '../core/log.ts';
import { OrbitError } from '../core/errors.ts';
import { TERMINAL_STATES } from '../core/run-states.ts';
import type { OrbitDb } from '../storage/db.ts';
import { worktreeRootFor } from '../controller/context.ts';
import { acquireLease, getRun, releaseLease, type RunRecord } from '../controller/run-store.ts';
import { releaseWorktrees, retainWorktrees, WORKTREES_RELEASED_EVENT, WORKTREES_RETAINED_EVENT, type WorktreesReleased, type WorktreesRetained } from '../controller/worktree-cleanup.ts';

/** The terminal states that release their checkouts, as `finishRun` does. EXHAUSTED and IMPOSSIBLE retain theirs. */
const RELEASING_STATES: ReadonlySet<string> = new Set(['SUCCEEDED', 'CANCELLED']);
/** The terminal states that keep their checkouts, on record, until `orbit gc` removes them after retention. */
const RETAINING_STATES: ReadonlySet<string> = new Set(['EXHAUSTED', 'IMPOSSIBLE']);

export interface SettledWorktrees {
  released: WorktreesReleased | null;
  retained: WorktreesRetained | null;
}

/**
 * Settle a finished run's checkouts the way its end does: SUCCEEDED and CANCELLED release theirs, EXHAUSTED and
 * IMPOSSIBLE keep theirs with a `worktrees.retained` record. A run the recovery budget ended EXHAUSTED never reaches
 * `finishRun`, so recovery settles them itself, and so does a later pass whose release or retention is due again
 * (releaseDue, retainDue). Call it after the run's workers and checks are stopped: the release keeps the checkout of
 * any worker or check still active. A no-op without the orbit home (the callers that pass none keep the checkouts, as
 * before) and for a run that is not finished or is BLOCKED. Never throws: cleanup must not change an outcome.
 */
export async function settleEndedRunWorktrees(input: { db: OrbitDb; clock: Clock; ownerId: string; runId: string; orbitHome: string | undefined; log?: Logger | undefined }): Promise<SettledWorktrees> {
  const none: SettledWorktrees = { released: null, retained: null };
  if (input.orbitHome === undefined) return none;
  const log = input.log ?? nullLogger;
  try {
    const run = getRun(input.db, input.runId);
    if (!TERMINAL_STATES.has(run.state) || run.state === 'BLOCKED') return none;
    if (RETAINING_STATES.has(run.state)) return { released: null, retained: retainWorktrees({ db: input.db, clock: input.clock, ownerId: input.ownerId, run, orbitHome: input.orbitHome }) };
    if (!RELEASING_STATES.has(run.state)) return none;
    return { released: await releaseRunCheckouts({ ...input, orbitHome: input.orbitHome, log }), retained: null };
  } catch (err) {
    log.warn('could not settle the worktrees of a finished run', { run_id: input.runId, error: err instanceof Error ? err.message : String(err) });
    return none;
  }
}

/**
 * What a release of a finished run recorded, or null when it recorded nothing. A run that ended EXHAUSTED or
 * IMPOSSIBLE records a retention instead and so returns null here; callers that only need the checkouts settled (the
 * watchdog) get that either way.
 */
export async function releaseEndedRunWorktrees(input: { db: OrbitDb; clock: Clock; ownerId: string; runId: string; orbitHome: string | undefined; log?: Logger | undefined }): Promise<WorktreesReleased | null> {
  return (await settleEndedRunWorktrees(input)).released;
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
 * Settle a finished run's checkouts when its release or retention is due (releaseDue, retainDue), under the run's
 * lease: the controller that ended the run holds it until its own settling is done, and a run another live controller
 * holds is left to it. True when a release or a retention was recorded, so a report written before it is stale.
 * Never throws.
 */
export async function releaseIfDue(input: { db: OrbitDb; clock: Clock; ownerId: string; runId: string; orbitHome: string | undefined; leaseTtlMs: number; log?: Logger | undefined }): Promise<boolean> {
  try {
    const run = getRun(input.db, input.runId);
    if (!releaseDue(input.db, run, input.orbitHome) && !retainDue(input.db, run, input.orbitHome)) return false;
    if (!acquireLease(input.db, input.runId, input.ownerId, input.leaseTtlMs, input.clock)) return false;
  } catch (err) {
    (input.log ?? nullLogger).warn('could not resume the release of a finished run', { run_id: input.runId, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
  try {
    const settled = await settleEndedRunWorktrees(input);
    return settled.released !== null || settled.retained !== null;
  } finally {
    releaseLease(input.db, input.runId, input.ownerId);
  }
}

/**
 * Whether a finished run's release is due (again) at a controller start: the run ended SUCCEEDED or CANCELLED, its
 * worktree directory is still there, and either no release completed (the controller died between the terminal
 * transition and the release, or the release failed) or the last one kept a checkout that may go now: the worker or
 * check it waited for has ended, or edits that could not be pinned (or a checkout that could not be removed) may be
 * now. A release that waited only for a worker or check that is still open is not due: it would wait again. An
 * EXHAUSTED or IMPOSSIBLE run never releases here: it retains (retainDue), and `orbit gc` removes its checkouts
 * after retention.
 */
export function releaseDue(db: OrbitDb, run: Pick<RunRecord, 'id' | 'state' | 'repoRoot'>, orbitHome: string | undefined): boolean {
  if (orbitHome === undefined || !RELEASING_STATES.has(run.state)) return false;
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

/**
 * Whether a run that ended EXHAUSTED or IMPOSSIBLE still owes its `worktrees.retained` record at a controller start:
 * its worktree directory is still there and no retention is on record (the controller died between the terminal
 * transition and the record, or the record failed). Once recorded it is not due again: the checkouts stay until
 * `orbit gc` removes them after retention.
 */
export function retainDue(db: OrbitDb, run: Pick<RunRecord, 'id' | 'state' | 'repoRoot'>, orbitHome: string | undefined): boolean {
  if (orbitHome === undefined || !RETAINING_STATES.has(run.state)) return false;
  if (!existsSync(worktreeRootFor(orbitHome, run))) return false;
  return db.get('SELECT 1 AS x FROM events WHERE run_id = ? AND type = ? LIMIT 1', run.id, WORKTREES_RETAINED_EVENT) === undefined;
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
