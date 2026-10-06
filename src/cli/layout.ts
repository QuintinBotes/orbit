/**
 * What the repository's own layout says about `scope.allowed_paths`. The
 * starter template names apps/, packages/, tests/ and docs/, which match
 * nothing in a repository laid out under src/; `orbit init` derives the paths
 * from the tracked files instead, and `orbit doctor` warns when none match.
 */
import { execCapture } from '../core/exec.ts';
import { gitEnv, type CliContext } from './context.ts';

/** Top-level directories that hold generated, vendored or protected-by-default material, never a sensible default scope. */
const NOT_SOURCE = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', 'target', 'infra', 'tmp', 'temp']);

/** Extensions that mark a top-level file as source in a flat layout (configuration formats such as json and yaml are left out). */
const SOURCE_EXTENSIONS = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cc', 'cpp', 'cs', 'php', 'swift', 'sh']);

/** At most this many directories are written; a repository with more is better scoped by hand. */
const MAX_DIRS = 8;

export async function trackedFiles(ctx: CliContext, repo: string): Promise<string[]> {
  try {
    const r = await execCapture(['git', 'ls-files', '-z'], { cwd: repo, env: gitEnv(ctx.env), timeoutMs: 30_000 });
    if (r.exitCode !== 0) return [];
    return r.stdout.split('\0').filter((f) => f.length > 0);
  } catch {
    return [];
  }
}

/**
 * `<dir>/**` for each top-level directory of the tracked files that looks like source, tests or documentation; for a flat
 * layout (no such directory) `*.<ext>` for the source extensions at the top level; [] when there is neither.
 */
export function suggestAllowedPaths(files: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const f of files) {
    const slash = f.indexOf('/');
    if (slash <= 0) continue;
    const top = f.slice(0, slash);
    if (top.startsWith('.') || NOT_SOURCE.has(top)) continue;
    // A glob metacharacter in a directory name would change what the glob means; leave such directories to a person.
    if (/[*?[\]{}()!\\]/.test(top)) continue;
    dirs.add(top);
  }
  const sorted = [...dirs].sort();
  if (sorted.length > MAX_DIRS) return [];
  if (sorted.length > 0) return sorted.map((d) => `${d}/**`);
  // A flat layout has no directory to scope to: the source files sit at the top level, so scope by their extensions.
  const exts = new Set<string>();
  for (const f of files) {
    if (f.includes('/') || f.startsWith('.')) continue;
    const dot = f.lastIndexOf('.');
    const ext = dot > 0 ? f.slice(dot + 1).toLowerCase() : '';
    if (SOURCE_EXTENSIONS.has(ext)) exts.add(ext);
  }
  return [...exts].sort().map((e) => `*.${e}`);
}
