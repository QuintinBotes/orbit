import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, parse, sep } from 'node:path';
import type { Clock } from '../core/clock.ts';
import { OrbitError } from '../core/errors.ts';
import type { OrbitDb } from '../storage/db.ts';
import { adminDirFor, git, resolveCommit, treeOf } from './git.ts';
import { finalizeCandidate, reserveCandidate, type CandidateRecord, type DiffStat } from './store.ts';

/**
 * Candidates (architecture "Evidence binding"). The controller, not the
 * worker, turns a worktree into a candidate: the files are staged into a
 * private temporary index, written as a tree, committed on the base with a
 * fixed identity, and pinned under refs/orbit/<run>/candidates/<seq>. The
 * worktree's own index, HEAD and branch are never touched, so a worker's
 * staging state can neither leak into nor be disturbed by the snapshot.
 */

export const ORBIT_GIT_IDENTITY = { name: 'Orbit', email: 'orbit@orbit.invalid' } as const;

/**
 * Untracked noise that must never become part of a candidate even when the
 * repository forgot to ignore it. Tracked files are unaffected: excludes only
 * apply to untracked paths, and the index starts from the base tree.
 */
const BUILTIN_EXCLUDES = ['.DS_Store', 'Thumbs.db', 'node_modules/'];

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_DIFF_PATHS = 200;

export interface SnapshotCandidateInput {
  db: OrbitDb;
  clock: Clock;
  repoRoot: string;
  worktree: string;
  runId: string;
  baseRev: string;
  attempt: number;
  workerId: string | null;
  /** More gitignore-syntax patterns to leave out, on top of the repository's own ignore rules. */
  extraExcludes?: readonly string[];
}

export interface SnapshotResult extends CandidateRecord {
  /** False when the worktree content matched an existing candidate and that one was returned. */
  created: boolean;
}

export function candidateRef(runId: string, seq: number): string {
  return `refs/orbit/${runId}/candidates/${seq}`;
}

export async function snapshotCandidate(input: SnapshotCandidateInput): Promise<SnapshotResult> {
  const { db, clock, repoRoot, runId } = input;
  if (!RUN_ID.test(runId)) throw new OrbitError('INTERNAL', `run id is not safe in a ref name: ${JSON.stringify(runId)}`);
  const base = await resolveCommit(repoRoot, input.baseRev);
  const { gitDir, worktree } = await adminDirFor(repoRoot, input.worktree);

  const tree = await stageTree({ gitDir, worktree, base, extraExcludes: input.extraExcludes ?? [] });

  // Same content, same tree, same candidate. A CREATING row left by a crash is resumed rather than duplicated.
  const row = reserveCandidate(db, { runId, attempt: input.attempt, workerId: input.workerId, treeHash: tree, parentSha: base }, clock);
  if (row.status !== 'CREATING') return { ...row, created: false };

  const message = `orbit candidate ${runId}/${row.seq}\n\nattempt: ${row.attempt}\nworker: ${row.workerId ?? 'none'}\ntree: ${tree}\n`;
  // Dated from the reserved row, not the clock now, so every snapshot of this tree yields the identical commit.
  const when = `${Math.floor(row.createdAt / 1000)} +0000`;
  const commit = (
    await git(repoRoot, ['commit-tree', tree, '-p', base, '-m', message], {
      env: {
        GIT_AUTHOR_NAME: ORBIT_GIT_IDENTITY.name,
        GIT_AUTHOR_EMAIL: ORBIT_GIT_IDENTITY.email,
        GIT_COMMITTER_NAME: ORBIT_GIT_IDENTITY.name,
        GIT_COMMITTER_EMAIL: ORBIT_GIT_IDENTITY.email,
        GIT_AUTHOR_DATE: when,
        GIT_COMMITTER_DATE: when,
      },
    })
  ).trim();
  // Overwrites a ref a crashed earlier attempt may have left for this seq: the row, not the ref, is the authority.
  await git(repoRoot, ['update-ref', candidateRef(runId, row.seq), commit]);
  const stat = await diffStat(repoRoot, await treeOf(repoRoot, base), tree);
  const done = finalizeCandidate(db, row.id, commit, stat, clock);
  return { ...done, created: true };
}

async function stageTree(o: { gitDir: string; worktree: string; base: string; extraExcludes: readonly string[] }): Promise<string> {
  const scratch = mkdtempSync(join(tmpdir(), 'orbit-index-'));
  try {
    const excludes = join(scratch, 'exclude');
    writeFileSync(excludes, `${[...BUILTIN_EXCLUDES, ...o.extraExcludes].join('\n')}\n`);
    const env = { GIT_DIR: o.gitDir, GIT_WORK_TREE: o.worktree, GIT_INDEX_FILE: join(scratch, 'index') };
    const opts = { env, config: { 'core.excludesFile': excludes } };
    await git(o.worktree, ['read-tree', o.base], opts);
    await git(o.worktree, ['add', '-A', '--', '.'], opts);
    return (await git(o.worktree, ['write-tree'], opts)).trim();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Added/removed line counts between two trees. Parsed from -z output so odd file names cannot confuse it. */
export async function diffStat(repoRoot: string, fromTree: string, toTree: string): Promise<DiffStat> {
  const out = await git(repoRoot, ['diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', fromTree, toTree, '--']);
  const stat: DiffStat = { files: 0, insertions: 0, deletions: 0, binaryFiles: 0, paths: [], truncated: false };
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(rec);
    if (!m) continue;
    stat.files++;
    if (m[1] === '-') stat.binaryFiles++;
    else {
      stat.insertions += Number(m[1]);
      stat.deletions += Number(m[2]);
    }
    if (stat.paths.length < MAX_DIFF_PATHS) stat.paths.push(m[3]!);
    else stat.truncated = true;
  }
  return stat;
}

export interface MaterializeOptions {
  /** Make every file read-only (reviewers, auditors). Checks that build need a writable checkout. Default true. */
  readOnly?: boolean;
}

/**
 * A clean detached checkout of `commit` at `dir`: exactly the candidate, no
 * worker leftovers, no ignored files. Hooks are disabled for the checkout
 * because the commit's repository may carry its own.
 */
export async function materializeCandidate(repoRoot: string, commit: string, dir: string, opts: MaterializeOptions = {}): Promise<string> {
  const sha = await resolveCommit(repoRoot, commit);
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new OrbitError('GIT_FAILED', `checkout directory is not empty: ${dir}`, { dir });
  }
  mkdirSync(dirname(dir), { recursive: true });
  await git(repoRoot, ['worktree', 'add', '--detach', '--force', dir, sha]);
  const real = realpathSync(dir);
  if (opts.readOnly !== false) makeReadOnly(real);
  return real;
}

/** Remove a checkout made by materializeCandidate, including a read-only one, and forget its worktree entry. */
export async function cleanupCandidateCheckout(repoRoot: string, dir: string): Promise<void> {
  assertDisposableCheckout(repoRoot, dir);
  if (existsSync(dir)) makeWritable(dir);
  try {
    await git(repoRoot, ['worktree', 'remove', '--force', dir]);
  } catch {
    rmSync(dir, { recursive: true, force: true });
  }
  rmSync(dir, { recursive: true, force: true });
  await git(repoRoot, ['worktree', 'prune']).catch(() => {});
}

/**
 * Cleanup ends in a recursive delete, so the target must be something only
 * a checkout could be: never the repository, the directory holding it or its
 * git directory, and never a directory with its own `.git` directory (a main
 * working tree; a linked checkout has a `.git` file).
 */
function assertDisposableCheckout(repoRoot: string, dir: string): void {
  if (!existsSync(dir)) return;
  const target = realpathSync(dir);
  const root = realpathSync(repoRoot);
  const refuse = (why: string): never => {
    throw new OrbitError('GIT_FAILED', `refusing to remove ${dir}: ${why}`, { dir, repoRoot });
  };
  if (target === root || root.startsWith(target.endsWith(sep) ? target : target + sep)) refuse('it is or contains the repository');
  if (target === parse(target).root) refuse('it is a filesystem root');
  let dotGit;
  try {
    dotGit = lstatSync(join(target, '.git'));
  } catch {
    return;
  }
  if (dotGit.isDirectory()) refuse('it holds its own .git directory, so it is a repository, not a checkout');
}

function walk(dir: string, visit: (path: string, isDir: boolean) => void): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (name === '.git') continue;
      walk(p, visit);
      visit(p, true);
    } else visit(p, false);
  }
}

function makeReadOnly(dir: string): void {
  walk(dir, (p, isDir) => chmodSync(p, isDir ? 0o555 : lstatSync(p).mode & 0o555));
  chmodSync(dir, 0o555);
}

function makeWritable(dir: string): void {
  try {
    chmodSync(dir, 0o755);
    // Directories first: a read-only parent hides its children from a later walk.
    const stack = [dir];
    while (stack.length) {
      const d = stack.pop()!;
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        const st = lstatSync(p);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) {
          chmodSync(p, 0o755);
          if (name !== '.git') stack.push(p);
        } else chmodSync(p, st.mode | 0o200);
      }
    }
  } catch {
    /* best effort: rmSync reports whatever is left */
  }
}
