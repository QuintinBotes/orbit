/**
 * What Orbit does itself between a scope denial and the next attempt (issue #280): the paths the candidate changed
 * outside the authorized scope are put back to the base revision in the implementer's worktree, so the repair does not
 * depend on the implementer reverting them. A path a criterion needs is not restored: the run blocks on it instead.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrbitError } from '../core/errors.ts';
import type { PlannerOutput } from '../contract/model-outputs.ts';
import type { GoalContract } from '../contract/types.ts';
import { adminDirFor, git, resolveCommit } from '../evidence/git.ts';
import { safePath } from './gates.ts';

/** Pathspecs per git call, so a large denial stays within the argument limit. */
const BATCH = 200;

export interface RestoreInput {
  repoRoot: string;
  /** The implementer's worktree: the only checkout written. */
  worktree: string;
  base: string;
  /** Repository-relative file paths, taken literally. */
  paths: readonly string[];
}

/**
 * Make each of `paths` in the worktree what it is on the base revision: checked out from it, or removed when the base
 * does not have the file. Git does both, through a private index read from the base, so the worktree's own index, HEAD
 * and branch are left alone, a path is never a pattern, and a symlink in the way is not followed. Running it again
 * changes nothing.
 */
export async function restoreToBase(input: RestoreInput): Promise<void> {
  if (input.paths.length === 0) return;
  const base = await resolveCommit(input.repoRoot, input.base);
  const { gitDir, worktree } = await adminDirFor(input.repoRoot, input.worktree);
  if (worktree === realpathSync(input.repoRoot)) throw new OrbitError('GIT_FAILED', `refusing to restore paths in ${worktree}: it is the repository's own checkout, not an implementer worktree`, { worktree });
  const scratch = mkdtempSync(join(tmpdir(), 'orbit-restore-'));
  try {
    const opts = { env: { GIT_DIR: gitDir, GIT_WORK_TREE: worktree, GIT_INDEX_FILE: join(scratch, 'index'), GIT_LITERAL_PATHSPECS: '1' } };
    await git(worktree, ['read-tree', base], opts);
    const onBase = new Set((await git(worktree, ['ls-files', '-z'], opts)).split('\0').filter(Boolean));
    // Removals first: a file the base does not have may stand where it has a directory.
    const added = input.paths.filter((p) => !onBase.has(p));
    const kept = input.paths.filter((p) => onBase.has(p));
    // Never without a pathspec: `git clean` would then remove everything the base does not have.
    for (let i = 0; i < added.length; i += BATCH) await git(worktree, ['clean', '-q', '-f', '-x', '--', ...added.slice(i, i + BATCH)], opts);
    for (let i = 0; i < kept.length; i += BATCH) await git(worktree, ['checkout-index', '-q', '-f', '--', ...kept.slice(i, i + BATCH)], opts);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Every file of the revision. */
export async function filesOfRevision(repoRoot: string, rev: string): Promise<Set<string>> {
  const commit = await resolveCommit(repoRoot, rev);
  return new Set((await git(repoRoot, ['ls-tree', '-r', '-z', '--full-tree', '--name-only', commit])).split('\0').filter(Boolean));
}

export interface NeededPath {
  path: string;
  /** The criteria that name it. */
  criteria: string[];
}

/**
 * The paths of `denied` a criterion needs: one of its mapped tests, or a change the stored planner output plans for it
 * (planner criterion n is AC-n, contract/draft). A keep criterion's test the base already has is not needed changed:
 * restoring it is what that criterion asks for.
 */
export function neededPaths(denied: readonly string[], contract: GoalContract, plan: PlannerOutput | null, onBase: ReadonlySet<string>): NeededPath[] {
  const plain = (p: string): string => p.trim().replace(/^\.\//, '');
  const named = contract.acceptance_criteria.map((c) => {
    const tests = (c.tests ?? []).map(plain).filter((p) => !(c.kind === 'keep' && onBase.has(p)));
    const planned = plan?.criteria.find((_, i) => `AC-${i + 1}` === c.id)?.changes.map((x) => plain(x.path)) ?? [];
    return { id: c.id, paths: new Set([...tests, ...planned]) };
  });
  return denied.flatMap((path) => {
    const criteria = named.filter((n) => n.paths.has(path)).map((n) => n.id);
    return criteria.length > 0 ? [{ path, criteria }] : [];
  });
}

/** Paths as a reason or a brief names them: safe to print, at most `limit` of them, and how many more there are. */
export function listPaths(paths: readonly string[], limit: number): string {
  const shown = paths.slice(0, limit).map(safePath).join(', ');
  return paths.length > limit ? `${shown} and ${paths.length - limit} more` : shown;
}
