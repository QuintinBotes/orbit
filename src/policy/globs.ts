/**
 * Glob handling shared by config validation, authorization and diff
 * inspection, so the three can never disagree about what a pattern means.
 *
 * Paths are repository-relative POSIX strings. `dot: true` because a scope
 * glob such as `apps/**` is expected to include `apps/.storybook/x`, and a
 * protection such as `**\/.env*` must reach into dot directories.
 */
import picomatch from 'picomatch';

export type PathMatcher = (relPath: string) => boolean;

const NEVER: PathMatcher = () => false;

/**
 * Compile a glob list into one predicate. `nocase` is used for protections
 * (fail closed on case-insensitive filesystems); allowed scope is matched
 * case-sensitively because git, and so the diff the controller inspects,
 * treats differently cased paths as different files.
 */
export function compileGlobs(globs: readonly string[], opts: { nocase: boolean }): PathMatcher {
  if (globs.length === 0) return NEVER;
  const matchers = globs.map((g) => picomatch(g, { dot: true, nocase: opts.nocase, windows: false }));
  return (relPath: string) => {
    const p = stripDotSlash(relPath);
    for (const m of matchers) if (m(p)) return true;
    return false;
  };
}

/** The literal leading directory of each glob (`.git/**` -> `.git`); empty when the glob starts with a wildcard. */
export function globBases(globs: readonly string[]): string[] {
  const out: string[] = [];
  for (const g of globs) {
    const scan = picomatch.scan(g);
    const base = scan.isGlob ? scan.base : g;
    if (base && !out.includes(base)) out.push(base);
  }
  return out;
}

/**
 * Why a config glob is unacceptable, or null. Leading `!` is refused because
 * picomatch would read it as negation, turning "allow apps" into "allow
 * everything except apps".
 */
export function globProblem(glob: unknown): string | null {
  if (typeof glob !== 'string' || glob.length === 0) return 'must be a non-empty string';
  if (glob.includes('\0')) return 'contains a NUL byte';
  if (glob.includes('\\')) return 'must use forward slashes';
  if (glob.startsWith('/') || /^[A-Za-z]:/.test(glob)) return 'must be relative to the repository root';
  if (glob.startsWith('~')) return 'must be relative to the repository root, not the home directory';
  if (glob.startsWith('!')) return 'negation is not supported; list what is allowed or protected';
  if (glob.startsWith('./')) return "must not start with './'";
  const segments = glob.split('/');
  if (segments.includes('..')) return "must not contain a '..' segment";
  if (segments.some((s, i) => s === '' && i !== segments.length - 1)) return 'must not contain empty segments';
  try {
    picomatch.makeRe(glob, { dot: true });
  } catch (err) {
    return `is not a valid glob (${(err as Error).message})`;
  }
  return null;
}

export function stripDotSlash(p: string): string {
  let out = p;
  while (out.startsWith('./')) out = out.slice(2);
  return out;
}

/** Shell-style glob test (no dotfiles unless the pattern names them), for redirection targets like `rm .g*`. */
export function shellGlobMatches(pattern: string, literal: string): boolean {
  try {
    return picomatch(pattern, { dot: false, windows: false })(literal);
  } catch {
    return false;
  }
}

export function hasGlobChars(text: string): boolean {
  return /[*?[]/.test(text);
}
