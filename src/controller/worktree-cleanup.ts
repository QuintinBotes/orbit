/**
 * Worktree cleanup for finished runs (P19). A run keeps its checkouts under `<orbit home>/worktrees/<repo>/<run>/`
 * (the implementer's worktree, the baseline checkout, review and verify checkouts). Nothing used to remove them, so
 * every finished run left an entry in `git worktree list` for good.
 *
 * Removed when a run ends SUCCEEDED or CANCELLED: the result lives in the run's branch and in its candidate refs
 * (`refs/orbit/<run>/candidates/<n>`), not in the checkout. An edit in the implementer's worktree that never became
 * a candidate (a run cancelled mid-work) is first snapshotted as one, so removal never loses work, and when that
 * snapshot fails the worktree is kept. A BLOCKED, EXHAUSTED or paused run keeps its worktree: a person resumes or
 * continues from it (spec section 14: stops preserve the worktree). `orbit gc --keep-days 0` removes those too.
 */
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { snapshotCandidate, cleanupCandidateCheckout } from '../evidence/candidate.ts';
import { adminDirFor, git } from '../evidence/git.ts';
import type { RunContext } from './context.ts';
import { runWorktreeRoot } from './context.ts';
import { messageOf } from './workers.ts';
import { appendEvent } from '../storage/events.ts';

export const WORKTREES_RELEASED_EVENT = 'worktrees.released';

/** Whether the checkout has files changed or added against its HEAD (the base revision), ignored files excluded. */
async function hasUnsavedEdits(worktree: string, repoRoot: string): Promise<boolean> {
  const admin = await adminDirFor(repoRoot, worktree);
  const out = await git(admin.worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], { env: { GIT_DIR: admin.gitDir, GIT_WORK_TREE: admin.worktree, GIT_LITERAL_PATHSPECS: '1' } });
  return out.split('\0').some((e) => e.length > 3 && !/(^|\/)(\.DS_Store|Thumbs\.db)$/.test(e.slice(3)) && !e.slice(3).startsWith('node_modules/'));
}

/** Remove the run's checkouts after SUCCEEDED or CANCELLED. Never throws: a cleanup problem must not change an outcome. */
export async function releaseRunWorktrees(ctx: RunContext): Promise<void> {
  const root = runWorktreeRoot(ctx);
  if (!existsSync(root)) return;
  const repoRoot = ctx.run.repoRoot;
  const kept: string[] = [];
  const removed: string[] = [];
  const implementer = ctx.run.worktreePath;
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    try {
      if (implementer && dir === implementer && ctx.run.baseRevision) {
        if (await hasUnsavedEdits(dir, repoRoot)) {
          await snapshotCandidate({ db: ctx.db, clock: ctx.clock, repoRoot, worktree: dir, runId: ctx.run.id, baseRev: ctx.run.baseRevision, attempt: Math.max(1, ctx.ledger?.state('implementation_attempts').used ?? 1), workerId: null });
        }
      }
      await cleanupCandidateCheckout(repoRoot, dir);
      removed.push(name);
    } catch (err) {
      kept.push(name);
      ctx.log.warn('could not remove a finished run\'s worktree; it is kept', { run_id: ctx.run.id, worktree: name, error: messageOf(err) });
    }
  }
  if (kept.length === 0) rmSync(root, { recursive: true, force: true });
  ctx.db.tx(() => appendEvent(ctx.db, ctx.run.id, WORKTREES_RELEASED_EVENT, ctx.ownerId, { removed, kept }, ctx.clock.now()));
}
