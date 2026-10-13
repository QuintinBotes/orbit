/**
 * Worktree cleanup for finished runs (P19). A run keeps its checkouts under `<orbit home>/worktrees/<repo>/<run>/`
 * (the implementer's worktree, the baseline checkout, review and verify checkouts). Nothing used to remove them, so
 * every finished run left an entry in `git worktree list` for good.
 *
 * Removed when a run ends in any terminal state but BLOCKED (SUCCEEDED, CANCELLED, EXHAUSTED, IMPOSSIBLE): the result
 * lives in the run's branch and in its candidate refs (`refs/orbit/<run>/candidates/<n>`), not in the checkout, and
 * none of these states has a way back. An edit in the implementer's worktree that never became a candidate (a run
 * cancelled mid-work) is first snapshotted as one, so removal never loses work, and when that snapshot fails the
 * worktree is kept. A BLOCKED or paused run keeps its worktree: a person resumes from it (spec section 14: stops
 * preserve the worktree). `orbit gc --keep-days 0` removes those too.
 */
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { snapshotCandidate, cleanupCandidateCheckout } from '../evidence/candidate.ts';
import { adminDirFor, git } from '../evidence/git.ts';
import type { RunContext } from './context.ts';
import { worktreeRootFor } from './context.ts';
import type { Clock } from '../core/clock.ts';
import type { Logger } from '../core/log.ts';
import type { OrbitDb } from '../storage/db.ts';
import type { RunRecord } from './run-store.ts';
import { appendEvent } from '../storage/events.ts';

export const WORKTREES_RELEASED_EVENT = 'worktrees.released';

/** Whether the checkout has files changed or added against its HEAD (the base revision), ignored files excluded. */
async function hasUnsavedEdits(worktree: string, repoRoot: string): Promise<boolean> {
  const admin = await adminDirFor(repoRoot, worktree);
  const out = await git(admin.worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], { env: { GIT_DIR: admin.gitDir, GIT_WORK_TREE: admin.worktree, GIT_LITERAL_PATHSPECS: '1' } });
  return out.split('\0').some((e) => e.length > 3 && !/(^|\/)(\.DS_Store|Thumbs\.db)$/.test(e.slice(3)) && !e.slice(3).startsWith('node_modules/'));
}

/** What releasing a run's checkouts needs; the recovery paths, which hold no RunContext, supply it too. */
export interface ReleaseWorktreesInput {
  db: OrbitDb;
  clock: Clock;
  log: Pick<Logger, 'warn'>;
  ownerId: string;
  run: RunRecord;
  orbitHome: string;
  /** The attempt number a snapshot of an unsaved edit is recorded under. */
  attempt: number;
}

/** Remove the run's checkouts after a terminal state but BLOCKED. Never throws: a cleanup problem must not change an outcome. */
export async function releaseRunWorktrees(ctx: RunContext): Promise<void> {
  await releaseWorktrees({ db: ctx.db, clock: ctx.clock, log: ctx.log, ownerId: ctx.ownerId, run: ctx.run, orbitHome: ctx.deps.orbitHome, attempt: Math.max(1, ctx.ledger?.state('implementation_attempts').used ?? 1) });
}

export async function releaseWorktrees(input: ReleaseWorktreesInput): Promise<void> {
  const { run, log } = input;
  const root = worktreeRootFor(input.orbitHome, run);
  if (!existsSync(root)) return;
  const repoRoot = run.repoRoot;
  const kept: string[] = [];
  const removed: string[] = [];
  const implementer = run.worktreePath;
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    try {
      if (implementer && dir === implementer && run.baseRevision) {
        if (await hasUnsavedEdits(dir, repoRoot)) {
          await snapshotCandidate({ db: input.db, clock: input.clock, repoRoot, worktree: dir, runId: run.id, baseRev: run.baseRevision, attempt: input.attempt, workerId: null });
        }
      }
      await cleanupCandidateCheckout(repoRoot, dir);
      removed.push(name);
    } catch (err) {
      kept.push(name);
      log.warn('could not remove a finished run\'s worktree; it is kept', { run_id: run.id, worktree: name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (kept.length === 0) rmSync(root, { recursive: true, force: true });
  input.db.tx(() => appendEvent(input.db, run.id, WORKTREES_RELEASED_EVENT, input.ownerId, { removed, kept }, input.clock.now()));
}
