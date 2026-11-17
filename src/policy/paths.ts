/**
 * Path canonicalization (spec §5 "Resolve symlinks, canonicalize paths, and
 * reject traversal"). Every path a worker names is resolved the way the
 * operating system would resolve it at the moment of the check, then compared
 * with the canonical root:
 *
 * - components are walked left to right, so `link/../x` follows `link` first,
 *   exactly as the kernel does, instead of being collapsed lexically;
 * - every symlink met on the way is replaced by its target, including a
 *   dangling one (writing through it would create the target);
 * - the existing prefix is passed through realpath, which on case-insensitive
 *   filesystems also yields the on-disk spelling;
 * - containment is judged per path segment, case-folded when the root lives
 *   on a case-insensitive filesystem (default macOS APFS).
 *
 * This is a check at one instant; a symlink swapped in afterwards is the OS
 * sandbox's and the diff inspection's problem, not this function's.
 */
import { accessSync, constants, lstatSync, readlinkSync, realpathSync, existsSync, type Stats } from 'node:fs';
import { isAbsolute, parse, sep, dirname, join, basename } from 'node:path';
import { OrbitError } from '../core/errors.ts';
import { CHECK_TOKEN_ENV } from '../evidence/check-shim.ts';

const MAX_SYMLINK_HOPS = 40;

/**
 * Repository-relative POSIX path of `candidate` (absolute, or relative to
 * `root`) after canonicalization. Throws POLICY_DENIED for malformed input
 * and SCOPE_VIOLATION when the resolved path is outside `root`. The root
 * itself resolves to '.'.
 */
export function resolveInside(root: string, candidate: string): string {
  const { rel } = resolveDetailed(root, candidate);
  if (rel === null) {
    throw new OrbitError('SCOPE_VIOLATION', `path resolves outside the root: ${candidate}`, { candidate });
  }
  return rel;
}

export interface Resolution {
  /** Canonical absolute path. */
  abs: string;
  /** Canonical root. */
  root: string;
  /** Repository-relative POSIX path, or null when outside the root. */
  rel: string | null;
}

/** Like resolveInside, but reports outside paths instead of throwing. Malformed input still throws. */
export function resolveDetailed(root: string, candidate: string): Resolution {
  assertPathText(root, 'root');
  assertPathText(candidate, 'path');
  if (!isAbsolute(root)) throw new OrbitError('POLICY_DENIED', `root must be absolute: ${root}`);
  let rootReal: string;
  try {
    rootReal = realpathSync.native(root);
  } catch (err) {
    throw new OrbitError('POLICY_DENIED', `root does not exist: ${root}`, { code: (err as NodeJS.ErrnoException).code });
  }
  // Join by hand: path.join would collapse `..` before symlinks are seen.
  const raw = isAbsolute(candidate) ? candidate : `${rootReal}${sep}${candidate}`;
  const abs = canonicalize(raw);
  return { abs, root: rootReal, rel: relativeInside(rootReal, abs, isCaseInsensitiveFs(rootReal)) };
}

/** Canonical form of an absolute path: symlinks resolved, `.`/`..` applied in order, existing prefix in on-disk spelling. */
export function canonicalize(absPath: string): string {
  assertPathText(absPath, 'path');
  if (!isAbsolute(absPath)) throw new OrbitError('POLICY_DENIED', `expected an absolute path: ${absPath}`);
  const fsRoot = parse(absPath).root;
  let pending = segments(absPath.slice(fsRoot.length));
  let cur = fsRoot;
  let hops = 0;
  while (pending.length > 0) {
    const seg = pending.shift()!;
    if (seg === '.' || seg === '') continue;
    if (seg === '..') {
      cur = dirname(cur);
      continue;
    }
    const next = join(cur, seg);
    const st = lstatOrNull(next);
    if (st?.isSymbolicLink()) {
      hops += 1;
      if (hops > MAX_SYMLINK_HOPS) throw new OrbitError('POLICY_DENIED', `too many symbolic links resolving ${absPath}`);
      const target = readlinkSync(next);
      if (isAbsolute(target)) {
        const targetRoot = parse(target).root;
        cur = targetRoot;
        pending = [...segments(target.slice(targetRoot.length)), ...pending];
      } else {
        pending = [...segments(target), ...pending];
      }
      continue;
    }
    cur = next;
  }
  return withOnDiskSpelling(cur);
}

/**
 * Whether the filesystem holding `dir` folds case. Detected by looking the
 * same entry up with its case swapped and comparing inode numbers; when the
 * path has no letter to swap, the answer is "case-sensitive", which keeps
 * the containment comparison exact (realpath already supplies the on-disk
 * spelling for everything that exists).
 */
export function isCaseInsensitiveFs(dir: string): boolean {
  const cached = caseCache.get(dir);
  if (cached !== undefined) return cached;
  let result = false;
  let probe = dir;
  while (true) {
    const name = basename(probe);
    const swapped = swapCase(name);
    if (swapped !== name) {
      const a = lstatOrNull(probe);
      const b = lstatOrNull(join(dirname(probe), swapped));
      result = a !== null && b !== null && a.ino === b.ino && a.dev === b.dev;
      break;
    }
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  caseCache.set(dir, result);
  return result;
}

const caseCache = new Map<string, boolean>();

/**
 * Longest temp root, in bytes, that Orbit takes from the environment: a worker's temp directory below it (13 bytes
 * more) then stays under 60, so a Unix socket path in it stays under macOS's 104.
 */
const MAX_ENV_TMP_ROOT = 46;

/**
 * Root of every worker's private temp directory: /tmp/orbit-<uid>, the same shape Claude Code uses for its own
 * /tmp/claude-<uid>, so that every Orbit process of a user (a foreground run, the service, `orbit gc`) agrees on it
 * whatever its TMPDIR. It is short on purpose: Claude Code and srt create Unix sockets in temp directories, and a socket
 * path over 104 bytes (macOS) fails. Inside an Orbit check (CHECK_TOKEN_ENV set), whose sandbox may write only the
 * check's own temp directory, Orbit code under test (Orbit's own suite as a check) nests its root there instead (#203).
 * Only the temp directory is resolved (/tmp is a link on macOS): a link planted at the root itself must be seen by
 * lstat, not followed (review of #140).
 */
export function orbitTmpRoot(uid: number | undefined = process.getuid?.(), env: Readonly<Record<string, string | undefined>> = process.env): string {
  return (env[CHECK_TOKEN_ENV] ? envTmpRoot(uid, env) : null) ?? fixedTmpRoot(uid);
}

/**
 * Every root a process of this user may have used: /tmp/orbit-<uid>, and orbit-<uid> in this process's TMPDIR when it
 * qualifies. Read-denials and `orbit gc` cover them all, so a process with another TMPDIR is covered too. Inside an
 * Orbit check that nests its root (orbitTmpRoot), that root alone: the check's TMPDIR lies in /tmp/orbit-<uid>, which
 * is then the root of the Orbit running the check, and counting it made every file in the check's own temp directory
 * another worker's (#206). The check's sandbox read-denies the rest of /tmp/orbit-<uid> itself.
 */
export function orbitTmpRoots(uid: number | undefined = process.getuid?.(), env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  const fixed = fixedTmpRoot(uid);
  const nested = envTmpRoot(uid, env);
  if (nested !== null && env[CHECK_TOKEN_ENV]) return [nested];
  return nested === null || nested === fixed ? [fixed] : [fixed, nested];
}

function fixedTmpRoot(uid: number | undefined): string {
  return join(canonicalize('/tmp'), tmpRootName(uid));
}

/** orbit-<uid> in TMPDIR when that directory is writable here and the root is at most MAX_ENV_TMP_ROOT bytes; else null. */
function envTmpRoot(uid: number | undefined, env: Readonly<Record<string, string | undefined>>): string | null {
  const temp = env.TMPDIR || '/tmp';
  try {
    accessSync(temp, constants.W_OK);
    const root = join(canonicalize(temp), tmpRootName(uid));
    return Buffer.byteLength(root) <= MAX_ENV_TMP_ROOT ? root : null;
  } catch {
    return null; // missing, relative or not writable here
  }
}

function tmpRootName(uid: number | undefined): string {
  return uid === undefined ? 'orbit' : `orbit-${uid}`;
}

/** Repository-relative POSIX path when `abs` is `root` or below it, else null. */
export function relativeInside(root: string, abs: string, caseInsensitive: boolean): string | null {
  const r = segments(root.slice(parse(root).root.length));
  const a = segments(abs.slice(parse(abs).root.length));
  if (parse(root).root !== parse(abs).root) return null;
  if (a.length < r.length) return null;
  for (let i = 0; i < r.length; i++) {
    if (!sameSegment(r[i]!, a[i]!, caseInsensitive)) return null;
  }
  const rest = a.slice(r.length);
  return rest.length === 0 ? '.' : rest.join('/');
}

export function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

function sameSegment(x: string, y: string, caseInsensitive: boolean): boolean {
  if (x === y) return true;
  if (!caseInsensitive) return false;
  // APFS is also normalization-insensitive, so compare composed forms.
  return x.normalize('NFC').toLowerCase() === y.normalize('NFC').toLowerCase();
}

function withOnDiskSpelling(p: string): string {
  let existing = p;
  const tail: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return p;
    tail.unshift(basename(existing));
    existing = parent;
  }
  let real: string;
  try {
    real = realpathSync.native(existing);
  } catch {
    return p;
  }
  return tail.length === 0 ? real : join(real, ...tail);
}

function segments(p: string): string[] {
  return p.split(/[\\/]+/).filter((s) => s.length > 0);
}

function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw err;
  }
}

function assertPathText(p: unknown, what: string): asserts p is string {
  if (typeof p !== 'string') throw new OrbitError('POLICY_DENIED', `${what} must be a string`);
  if (p.includes('\0')) throw new OrbitError('POLICY_DENIED', `${what} contains a NUL byte`);
  if (p.length > 4096) throw new OrbitError('POLICY_DENIED', `${what} is too long`);
}

function swapCase(s: string): string {
  let out = '';
  for (const ch of s) {
    const up = ch.toUpperCase();
    out += up === ch ? ch.toLowerCase() : up;
  }
  return out;
}
