import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync, type Dirent } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { OrbitError } from '../core/errors.ts';
import { BUILTIN_CREDENTIAL_PATHS } from '../policy/builtin.ts';
import { compileGlobs } from '../policy/globs.ts';
import type { SandboxProfile } from './types.ts';

/**
 * A SandboxProfile that also names read-only paths: the process may read
 * them and never write them. A read-only path inside a denied region (the
 * repository's git directory under a denied projects directory, Orbit's own
 * install directory for the guard hook) is re-allowed for reading; one
 * inside a writable region (the worker's settings and result files in its
 * worker directory, hooks and plugins in a provider's config directory) is
 * write-denied. The contract type has no field for this yet, so it travels as
 * an optional extra property. A caller that drops it loses both effects, and
 * the second one loosens the sandbox, so every caller must pass profiles
 * through unchanged until SandboxProfile gains the field.
 */
export type IsolationProfile = SandboxProfile & { readablePaths?: string[] };

export function readablePathsOf(profile: SandboxProfile): string[] {
  const extra = (profile as IsolationProfile).readablePaths;
  return Array.isArray(extra) ? extra : [];
}

export function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true;
  const prefix = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(prefix);
}

/**
 * Absolute, normalized, symlinks resolved. Sandbox rules are matched against
 * real paths (on macOS /tmp is /private/tmp and /var is /private/var), so a
 * rule written with the link spelling would silently match nothing. A path
 * that does not exist yet keeps its missing tail under its nearest existing,
 * resolved ancestor.
 */
export function canonicalPath(p: string): string {
  if (!isAbsolute(p)) throw new OrbitError('INTERNAL', `isolation paths must be absolute, got ${JSON.stringify(p)}`);
  const normalized = resolve(p);
  const tail: string[] = [];
  let current = normalized;
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return normalized;
      tail.push(basename(current));
      current = parent;
    }
  }
}

export function uniq<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}

/** Drop paths already covered by another entry, so rule lists stay minimal and readable. */
export function withoutNested(paths: string[]): string[] {
  const unique = uniq(paths);
  return unique.filter((p) => !unique.some((other) => other !== p && isWithin(p, other)));
}

export function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * PATH lookup without a shell. Returns the first executable regular file.
 * Relative entries (".", "bin", and the empty entry, which means ".") are
 * skipped, and a name with a slash must be absolute: either would resolve
 * against the current directory, which for Orbit is usually a repository, so
 * a committed file named `srt` or `docker` would be run as the trusted tool.
 */
export function which(name: string, pathEnv: string | undefined): string | null {
  if (name.includes('/')) return isAbsolute(name) && isExecutableFile(name) ? name : null;
  for (const dir of (pathEnv ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * The shared git directory of a linked worktree (`.git` is a file holding
 * `gitdir: <repo>/.git/worktrees/<name>`, whose `commondir` points back at
 * `<repo>/.git`). Git inside the worktree reads objects and refs from there,
 * so a sandbox that denies the repository's parent directory must re-allow
 * it. Returns null for an ordinary checkout, whose git directory is already
 * inside the worktree, and for anything unreadable.
 */
export function gitCommonDir(worktree: string): string | null {
  const dotGit = join(worktree, '.git');
  try {
    if (!statSync(dotGit).isFile()) return null;
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
    if (!match?.[1]) return null;
    const gitdir = resolve(worktree, match[1]);
    const commondirFile = join(gitdir, 'commondir');
    const common = existsSync(commondirFile) ? resolve(gitdir, readFileSync(commondirFile, 'utf8').trim()) : gitdir;
    return canonicalPath(common);
  } catch {
    return null;
  }
}

// Characters srt would read as a glob (macOS) or that cannot survive the
// settings and mount syntaxes. A literal path containing them would turn a
// deny rule into a pattern that matches nothing, which fails open.
const UNSAFE_PATH = /[*?[\]{}\n\r\0]/;

export function assertRepresentablePath(p: string, what: string): void {
  if (UNSAFE_PATH.test(p)) {
    throw new OrbitError('ISOLATION_UNAVAILABLE', `${what} ${JSON.stringify(p)} contains characters the sandbox would treat as a pattern; refusing rather than weakening the rule`, { path: p });
  }
}

export function assertArgv(argv: string[]): void {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== 'string') || !argv[0]) {
    throw new OrbitError('INTERNAL', 'isolation wrap needs a non-empty argv of strings');
  }
}

export interface BoundedResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the process could not be started at all (ENOENT, EACCES...). */
  spawnError: string | null;
}

/**
 * Run a short probe (`docker info`, `srt --version`) with a hard deadline.
 * The probe gets its own process group so a timeout kills whatever it
 * started, not just the direct child.
 */
export function runBounded(
  file: string,
  args: string[],
  opts: { timeoutMs: number; env?: NodeJS.ProcessEnv; cwd?: string; maxBytes?: number },
): Promise<BoundedResult> {
  const maxBytes = opts.maxBytes ?? 64 * 1024;
  return new Promise((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (r: Omit<BoundedResult, 'stdout' | 'stderr' | 'timedOut'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ ...r, stdout, stderr, timedOut });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (err) {
      resolvePromise({ code: null, signal: null, stdout, stderr, timedOut, spawnError: (err as Error).message });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }, opts.timeoutMs);
    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < maxBytes) stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < maxBytes) stderr += d.toString('utf8');
    });
    child.on('error', (err) => finish({ code: null, signal: null, spawnError: err.message }));
    child.on('close', (code, signal) => finish({ code, signal, spawnError: null }));
  });
}

/** One line of diagnostic text for a failed probe, without dumping whole logs into `orbit doctor`. */
export function probeFailure(r: BoundedResult): string {
  if (r.spawnError) return r.spawnError;
  if (r.timedOut) return 'timed out';
  const text = (r.stderr || r.stdout).trim().split('\n').filter(Boolean).slice(-1)[0] ?? '';
  const status = r.signal ? `signal ${r.signal}` : `exit ${r.code}`;
  return text ? `${status}: ${text.slice(0, 300)}` : status;
}

// `.git` is the repository's own store (the worker needs it readable and preflight inspects its configuration).
// `node_modules` is deliberately not skipped: a vendored package can ship a `.env` or a key, and a shell reads it
// as easily as any other file.
const CREDENTIAL_WALK_SKIP = new Set(['.git']);
export const CREDENTIAL_WALK_LIMIT = 1_000_000;

/**
 * Credential files present in a worktree: files matching the credential globs (by default the built-in ones:
 * .env*, *.pem, SSH keys, .npmrc, .netrc; profiles also pass the policy's protected credential globs), as
 * canonical absolute paths for the OS read-deny list. The Read tool refuses them by policy; this keeps a shell
 * (`cat .env`) from reading them either. A directory a glob names is denied as a whole. A symlink counts by the
 * file it reaches, and one that leaves the worktree is left to the rules for where it points. `.git` is not
 * walked; `node_modules` is.
 *
 * The walk is bounded, and a bound it cannot finish within fails closed: an unfinished enumeration would leave
 * credential files readable without anyone knowing, so it throws ISOLATION_UNAVAILABLE instead of returning
 * what it had.
 */
export function credentialFilesIn(worktree: string, globs: readonly string[] = BUILTIN_CREDENTIAL_PATHS, opts: { limit?: number } = {}): string[] {
  const root = canonicalPath(worktree);
  const limit = opts.limit ?? CREDENTIAL_WALK_LIMIT;
  const isCredential = compileGlobs(globs, { nocase: true });
  const found: string[] = [];
  const stack = [root];
  let visited = 0;
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++visited > limit) {
        throw new OrbitError(
          'ISOLATION_UNAVAILABLE',
          `credential enumeration of ${root} stopped after ${limit} entries; refusing to build a sandbox profile that could leave credential files readable (an unfinished walk cannot show that none is; remove or relocate large generated trees such as node_modules)`,
          { worktree: root, limit },
        );
      }
      const abs = join(dir, entry.name);
      const rel = abs.slice(root.length + 1);
      let isDir = entry.isDirectory();
      let isLink = entry.isSymbolicLink();
      if (!isDir && !isLink && !entry.isFile()) {
        // The filesystem did not say what this is: ask.
        try {
          const st = lstatSync(abs);
          isDir = st.isDirectory();
          isLink = st.isSymbolicLink();
        } catch {
          continue;
        }
      }
      if (isDir) {
        if (isCredential(rel)) found.push(abs);
        else if (!CREDENTIAL_WALK_SKIP.has(entry.name)) stack.push(abs);
        continue;
      }
      if (!isCredential(rel)) continue;
      if (!isLink) {
        found.push(abs);
        continue;
      }
      const target = canonicalPath(abs);
      if (isWithin(target, root)) found.push(target);
    }
  }
  return uniq(found).sort();
}
