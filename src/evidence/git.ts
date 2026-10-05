import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrbitError } from '../core/errors.ts';
import { execCapture } from '../core/exec.ts';

/**
 * Git invocations for evidence. The environment is fixed: no user or system
 * config (so a tree never depends on the host's autocrlf or excludes) and no
 * prompts. Repository hooks are switched off on every call, because hooks are
 * repository code and the controller must not run it outside isolation.
 */

const HARDENING = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'commit.gpgsign=false'];

export function gitEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: tmpdir(),
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
    ...extra,
  };
}

export interface GitOptions {
  env?: Record<string, string>;
  /** Extra `-c key=value` pairs placed before the subcommand. */
  config?: Record<string, string>;
  timeoutMs?: number;
  input?: string;
}

/** Run git and return stdout. Any failure is GIT_FAILED with the (bounded) stderr in the message. */
export async function git(cwd: string, args: readonly string[], opts: GitOptions = {}): Promise<string> {
  const config = Object.entries(opts.config ?? {}).flatMap(([k, v]) => ['-c', `${k}=${v}`]);
  const argv = ['git', ...HARDENING, ...config, ...args];
  let r;
  try {
    r = await execCapture(argv, { cwd, env: gitEnv(opts.env), timeoutMs: opts.timeoutMs ?? 120_000, input: opts.input });
  } catch (err) {
    throw new OrbitError('GIT_FAILED', `git ${args[0] ?? ''} could not run: ${err instanceof Error ? err.message : String(err)}`, { args: [...args] }, { cause: err });
  }
  if (r.exitCode !== 0) {
    throw new OrbitError('GIT_FAILED', `git ${args.join(' ')} failed (${r.timedOut ? 'timeout' : `exit ${r.exitCode}`}): ${r.stderr.trim().slice(0, 500)}`, {
      args: [...args],
      exitCode: r.exitCode,
    });
  }
  return r.stdout;
}

const REV = /^[A-Za-z0-9._/@^~{}:-]+$/;

/** Resolve a revision to a commit sha. A leading '-' would be read as an option, so it is refused up front. */
export async function resolveCommit(repoRoot: string, rev: string): Promise<string> {
  if (!REV.test(rev) || rev.startsWith('-')) throw new OrbitError('GIT_FAILED', `not a usable revision: ${JSON.stringify(rev)}`, { rev });
  const out = await git(repoRoot, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  return out.trim();
}

export async function treeOf(repoRoot: string, commit: string): Promise<string> {
  return (await git(repoRoot, ['rev-parse', '--verify', `${commit}^{tree}`])).trim();
}

/**
 * The git directory that belongs to `worktree`, found from the repository's
 * own admin data and never from the worktree's `.git` file, which a worker
 * can rewrite to point anywhere. For a linked worktree it is
 * `<common>/worktrees/<name>`, located by the back pointer git stores there.
 */
export async function adminDirFor(repoRoot: string, worktree: string): Promise<{ gitDir: string; worktree: string }> {
  const common = realpathSync(
    (await git(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim(),
  );
  let wt: string;
  let root: string;
  try {
    wt = realpathSync(worktree);
    root = realpathSync(repoRoot);
  } catch (err) {
    throw new OrbitError('NOT_FOUND', `worktree or repository does not exist: ${worktree}`, { worktree }, { cause: err });
  }
  if (wt === root) return { gitDir: common, worktree: wt };
  const admin = join(common, 'worktrees');
  let names: string[] = [];
  try {
    names = readdirSync(admin);
  } catch {
    /* no linked worktrees */
  }
  for (const name of names) {
    try {
      const pointer = readFileSync(join(admin, name, 'gitdir'), 'utf8').trim();
      if (realpathSync(pointer) === join(wt, '.git')) return { gitDir: join(admin, name), worktree: wt };
    } catch {
      /* stale entry */
    }
  }
  throw new OrbitError('GIT_FAILED', `${worktree} is not a registered worktree of ${repoRoot}`, { worktree, repoRoot });
}
