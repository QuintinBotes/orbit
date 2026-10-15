/**
 * Worktree cleanup for finished runs (P19). A run keeps its checkouts under `<orbit home>/worktrees/<repo>/<run>/`
 * (the implementer's worktree, a worktree per parallel work unit, the baseline checkout, review and verify checkouts).
 * Nothing used to remove them, so every finished run left an entry in `git worktree list` for good.
 *
 * Removed when a run ends SUCCEEDED or CANCELLED: the result lives in the run's branch and in its candidate refs
 * (`refs/orbit/<run>/candidates/<n>`), not in the checkout. A run that ends EXHAUSTED or IMPOSSIBLE keeps its
 * checkouts instead (as in 0.3.0): `retainWorktrees` below records a `worktrees.retained` event naming each one, and
 * `orbit gc` removes them after retention, through the same release, once they expire. Removal never loses work and
 * never deletes beneath a process:
 *
 * - A checkout in which a worker of the run is still active (PLANNED or RUNNING: stopping it failed, so its
 *   termination is not confirmed and it may still be writing), or a check run or fail-before probe attempt of it is
 *   still open (PLANNED or RUNNING: its detached shim, or its check, may still run there), is kept, with why. Recovery
 *   releases it once a later controller start confirms the worker stopped or closes the check (recovery/release).
 * - Every implementer checkout (the run's worktree and each `unit-*` worktree of a parallel attempt, found from the
 *   worker records) first has its unfinished work pinned in a ref: edits (tracked changes and untracked files the
 *   repository does not ignore), and commits made in the checkout that no ref holds (each checkout is a detached HEAD,
 *   so removing it would drop them). The run's worktree is saved as a candidate, a unit's under
 *   `refs/orbit/<run>/unsaved/<worker>` (its partial work is not an attempt's result). Each is recorded in a
 *   `worktree.preserved` event, and a checkout whose work could not be pinned is kept.
 *
 * The `worktrees.released` event lists what was removed, where each preserved edit is, and every kept checkout with
 * why; the final report's next action names them. A release that did not complete (the controller died after the
 * terminal transition, or the release failed) or that kept a checkout is tried again at a controller start
 * (recovery/release releaseDue), and `orbit gc` releases a run this way before it removes anything, and skips a run
 * whose release keeps a checkout. A BLOCKED or paused run keeps its worktree: a person resumes from it (spec section
 * 14: stops preserve the worktree), until it is resumed to an end or cancelled (`orbit cancel <run-id>`); `orbit gc`
 * never removes it (retention prunes only SUCCEEDED, EXHAUSTED, IMPOSSIBLE and CANCELLED runs).
 */
import { existsSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { candidateRef, cleanupCandidateCheckout, pinCheckout, snapshotCandidate, unsavedRef } from '../evidence/candidate.ts';
import { adminDirFor, git } from '../evidence/git.ts';
import type { RunContext } from './context.ts';
import { worktreeRootFor } from './context.ts';
import type { Clock } from '../core/clock.ts';
import { clipAtWord } from '../core/text.ts';
import type { Logger } from '../core/log.ts';
import type { OrbitDb } from '../storage/db.ts';
import type { RunRecord } from './run-store.ts';
import { appendEvent } from '../storage/events.ts';
import { isWorkerActive, listWorkers, type WorkerRecord } from '../storage/workers.ts';

export const WORKTREES_RELEASED_EVENT = 'worktrees.released';
export const WORKTREES_RETAINED_EVENT = 'worktrees.retained';
export const WORKTREE_PRESERVED_EVENT = 'worktree.preserved';

/** Where the unfinished edits of a removed checkout were pinned. */
export interface PreservedEdits {
  /** The checkout's directory name under the run's worktree root. */
  worktree: string;
  ref: string;
  commit: string;
  /** The implementer that worked in it; null for the run's own worktree (saved as a candidate) and a unit without a record. */
  worker_id: string | null;
}

/** Why a checkout was kept: a worker may still be writing in it, a check may still run in it, its edits could not be pinned, or it could not be removed. */
export type RetainCause = 'active-worker' | 'active-check' | 'preservation-failed' | 'removal-failed';

export interface RetainedCheckout {
  worktree: string;
  path: string;
  cause: RetainCause;
  why: string;
}

/** The data of a `worktrees.released` event. `kept` (the names of the retained checkouts) predates `retained` and `preserved`. */
export interface WorktreesReleased {
  removed: string[];
  kept: string[];
  preserved: PreservedEdits[];
  retained: RetainedCheckout[];
}

/** One checkout kept because the run ended EXHAUSTED or IMPOSSIBLE. */
export interface RetainedWorktree {
  worktree: string;
  path: string;
  why: string;
}

/** The data of a `worktrees.retained` event: the checkouts a run that ended EXHAUSTED or IMPOSSIBLE keeps. */
export interface WorktreesRetained {
  state: string;
  worktrees: string[];
  retained: RetainedWorktree[];
}

/**
 * Whether the checkout holds work no ref keeps: files changed or added against its HEAD (ignored files excluded), or a
 * HEAD other than the base that no ref contains. Every checkout starts as a detached HEAD at the base or at a
 * candidate, so a commit made in it (isolation `none`, or a commit made indirectly) is held by that HEAD alone, and
 * removing the checkout would drop it.
 */
async function hasUnsavedWork(worktree: string, repoRoot: string, baseRevision: string | null): Promise<boolean> {
  const admin = await adminDirFor(repoRoot, worktree);
  const opts = { env: { GIT_DIR: admin.gitDir, GIT_WORK_TREE: admin.worktree, GIT_LITERAL_PATHSPECS: '1' } };
  const out = await git(admin.worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], opts);
  // The noise exclusion is for untracked files only: a tracked modification is work, even under a noise path.
  const isNoise = (p: string): boolean => /(^|\/)(\.DS_Store|Thumbs\.db)$/.test(p) || p.startsWith('node_modules/');
  if (out.split('\0').some((e) => e.length > 3 && !(e.slice(0, 2) === '??' && isNoise(e.slice(3))))) return true;
  const head = (await git(admin.worktree, ['rev-parse', '--verify', 'HEAD^{commit}'], opts)).trim();
  if (head === baseRevision) return false;
  // Any ref will do (the run's candidates, a branch, a tag): a commit a ref contains outlives the checkout.
  return (await git(repoRoot, ['for-each-ref', '--count=1', '--contains', head, '--format=%(refname)', 'refs/'])).trim() === '';
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

/** Remove the run's checkouts after SUCCEEDED or CANCELLED. Never throws: a cleanup problem must not change an outcome. */
export async function releaseRunWorktrees(ctx: RunContext): Promise<void> {
  try {
    await releaseWorktrees({ db: ctx.db, clock: ctx.clock, log: ctx.log, ownerId: ctx.ownerId, run: ctx.run, orbitHome: ctx.deps.orbitHome, attempt: Math.max(1, ctx.ledger?.state('implementation_attempts').used ?? 1) });
  } catch (err) {
    ctx.log.warn('could not release a finished run\'s worktrees; they are kept', { run_id: ctx.run.id, error: messageOf(err) });
  }
}

/** Keep the run's checkouts after EXHAUSTED or IMPOSSIBLE, on record. Never throws: a record problem must not change an outcome. */
export async function retainRunWorktrees(ctx: RunContext): Promise<void> {
  try {
    retainWorktrees({ db: ctx.db, clock: ctx.clock, ownerId: ctx.ownerId, run: ctx.run, orbitHome: ctx.deps.orbitHome });
  } catch (err) {
    ctx.log.warn('could not record a finished run\'s retained worktrees; they are kept', { run_id: ctx.run.id, error: messageOf(err) });
  }
}

/**
 * Record that a run that ended EXHAUSTED or IMPOSSIBLE keeps its checkouts, naming each one. Nothing is removed:
 * `orbit gc` releases them through `releaseWorktrees` after retention. Null when the run has no worktree directory;
 * a second call that would name the same checkouts records nothing and returns what is already on record.
 */
export function retainWorktrees(input: { db: OrbitDb; clock: Clock; ownerId: string; run: RunRecord; orbitHome: string }): WorktreesRetained | null {
  const { run } = input;
  const root = worktreeRootFor(input.orbitHome, run);
  if (!existsSync(root)) return null;
  const why = `the run ended ${run.state}, so the worktree and evidence are preserved; orbit gc removes them after retention`;
  const names = readdirSync(root).sort();
  const out: WorktreesRetained = { state: run.state, worktrees: names, retained: names.map((name) => ({ worktree: name, path: join(root, name), why })) };
  const last = input.db.get<{ data_json: string | null }>('SELECT data_json FROM events WHERE run_id = ? AND type = ? ORDER BY id DESC LIMIT 1', run.id, WORKTREES_RETAINED_EVENT);
  if (last?.data_json) {
    try {
      const prior = JSON.parse(last.data_json) as Partial<WorktreesRetained>;
      if (JSON.stringify(prior.worktrees ?? []) === JSON.stringify(names)) return { state: typeof prior.state === 'string' ? prior.state : run.state, worktrees: names, retained: prior.retained ?? out.retained };
    } catch {
      /* a record that cannot be read does not stand in for this one */
    }
  }
  input.db.tx(() => appendEvent(input.db, run.id, WORKTREES_RETAINED_EVENT, input.ownerId, out, input.clock.now()));
  return out;
}

/** What happened to the run's checkouts (also recorded as a `worktrees.released` event); null when it has none. */
export async function releaseWorktrees(input: ReleaseWorktreesInput): Promise<WorktreesReleased | null> {
  const { run, log } = input;
  const root = worktreeRootFor(input.orbitHome, run);
  if (!existsSync(root)) return null;
  const out: WorktreesReleased = { removed: [], kept: [], preserved: [], retained: [] };
  const workers = listWorkers(input.db, { runId: run.id });
  // Open check runs and fail-before probe attempts: the shim of each, and its check, may still run in their checkout.
  const checks = input.db.all<{ id: string; check_id: string; status: string; cwd: string; what: string }>(
    "SELECT id, check_id, status, cwd, 'check run' AS what, started_at FROM check_runs WHERE run_id = ? AND status IN ('PLANNED', 'RUNNING') UNION ALL SELECT id, check_id, status, cwd, 'fail-before probe attempt' AS what, started_at FROM fail_before_probes WHERE run_id = ? AND status IN ('PLANNED', 'RUNNING') ORDER BY started_at, id",
    run.id,
    run.id,
  );
  const keep = (name: string, dir: string, cause: RetainCause, why: string): void => {
    out.retained.push({ worktree: name, path: dir, cause, why });
    log.warn('a finished run\'s worktree is kept', { run_id: run.id, worktree: name, cause, why });
  };
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    const users = workers.filter((w) => within(w.cwd, dir));
    // Deleting beneath a process that may still run would lose what it writes next and leave it writing nowhere.
    const live = users.filter((w) => isWorkerActive(w.state));
    if (live.length > 0) {
      keep(name, dir, 'active-worker', `${live.map((w) => `worker ${w.id} (${w.role}, ${w.state})`).join(', ')} may still be writing in it: ${live.length === 1 ? 'its' : 'their'} termination is not confirmed; the checkout is released once a later controller start confirms ${live.length === 1 ? 'it' : 'them'} stopped`);
      continue;
    }
    // A check's shim is detached and outlives a controller, and finishing a run does not stop checks.
    const open = checks.filter((c) => within(c.cwd, dir));
    if (open.length > 0) {
      keep(name, dir, 'active-check', `${open.map((c) => `${c.what} ${c.id} (${c.check_id}, ${c.status})`).join(', ')} may still be running in it; the checkout is released once a later controller start closes ${open.length === 1 ? 'it' : 'them'}`);
      continue;
    }
    const main = run.worktreePath !== null && samePath(run.worktreePath, dir);
    const writers = users.filter((w) => w.role === 'implementer');
    if (main || writers.length > 0 || name.startsWith('unit-')) {
      try {
        const kept = await preserveEdits(input, dir, name, main, writers);
        if (kept) out.preserved.push(kept);
      } catch (err) {
        keep(name, dir, 'preservation-failed', `its unfinished edits could not be preserved in a ref (${clipAtWord(messageOf(err), 200)}); recover them from the checkout, then remove it with git worktree remove`);
        continue;
      }
    }
    try {
      await cleanupCandidateCheckout(run.repoRoot, dir);
      out.removed.push(name);
    } catch (err) {
      keep(name, dir, 'removal-failed', `it could not be removed (${clipAtWord(messageOf(err), 200)})`);
    }
  }
  out.kept = out.retained.map((r) => r.worktree);
  if (out.retained.length === 0) rmSync(root, { recursive: true, force: true });
  input.db.tx(() => appendEvent(input.db, run.id, WORKTREES_RELEASED_EVENT, input.ownerId, out, input.clock.now()));
  return out;
}

/**
 * Pin an implementer checkout's unfinished work (edits, and commits only its HEAD holds) before it goes; null when it
 * has none. The run's own worktree becomes a candidate (the report names the newest; its content, staged against the
 * base), a unit's partial work an unsaved ref named after its implementer (a commit on the checkout's HEAD, so the
 * unit's own commits are kept with it).
 */
async function preserveEdits(input: ReleaseWorktreesInput, dir: string, name: string, main: boolean, writers: readonly WorkerRecord[]): Promise<PreservedEdits | null> {
  const { run } = input;
  if (!(await hasUnsavedWork(dir, run.repoRoot, run.baseRevision))) return null;
  let kept: PreservedEdits;
  if (main && run.baseRevision) {
    const cand = await snapshotCandidate({ db: input.db, clock: input.clock, repoRoot: run.repoRoot, worktree: dir, runId: run.id, baseRev: run.baseRevision, attempt: input.attempt, workerId: null });
    kept = { worktree: name, ref: candidateRef(run.id, cand.seq), commit: cand.commitSha, worker_id: null };
  } else {
    const workerId = writers.at(-1)?.id ?? null;
    const ref = unsavedRef(run.id, workerId ?? name);
    const pinned = await pinCheckout({ repoRoot: run.repoRoot, worktree: dir, ref, clock: input.clock, message: `orbit unsaved edits ${run.id}/${name}\n\nworker: ${workerId ?? 'none'}\n` });
    kept = { worktree: name, ref, commit: pinned.commit, worker_id: workerId };
  }
  // Recorded before the checkout is removed, so a crash between the two still leaves the ref on record.
  input.db.tx(() => appendEvent(input.db, run.id, WORKTREE_PRESERVED_EVENT, input.ownerId, kept, input.clock.now()));
  return kept;
}

function realOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function samePath(a: string, b: string): boolean {
  return realOrResolved(a) === realOrResolved(b);
}

/** Whether `path` is `dir` or lies inside it. */
function within(path: string, dir: string): boolean {
  const p = realOrResolved(path);
  const d = realOrResolved(dir);
  return p === d || p.startsWith(d.endsWith(sep) ? d : d + sep);
}

/** The error on one line: a git failure carries its stderr, several lines of it. */
function messageOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
}
