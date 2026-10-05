import { stripAnsi } from './fingerprint.ts';

/**
 * Telling an environment failure from a code failure (pure, no I/O).
 *
 * A mandatory check that fails on the candidate exactly as it failed on the
 * base revision, with output that shows the sandbox or the host refusing an
 * operation, is not something the change can have caused or a repair can fix:
 * the same refusal happens on code the run never touched. Repairing it burns
 * implementation attempts on a tree that comes out identical, so the
 * controller stops and asks for the environment, the check definition or a
 * documented baseline exception instead (controller/environment-block.ts).
 *
 * Both halves are required. The same fingerprint alone could be an ordinary
 * pre-existing bug, which keeps the normal repair loop; a denial alone could be
 * something the change introduced, which is the change's to fix.
 */

export type EnvironmentSignal = 'sandbox-violation' | 'eperm' | 'operation-not-permitted' | 'eacces-outside-worktree';

export interface EnvironmentFailureInput {
  checkId: string;
  /** The check's failure fingerprint on the candidate; null when it has none. */
  fingerprint: string | null;
  /** The fingerprint the same check had on the base revision (the preflight baseline); null when it did not fail there. */
  baselineFingerprint: string | null;
  /** The check's output, as logged (already redacted). */
  output: string;
  /**
   * Directories the check may legitimately touch: its checkout, as given and resolved, and its own scratch directories.
   * An EACCES inside them is the code's; one anywhere else is the host refusing.
   */
  insideRoots: readonly string[];
}

export interface EnvironmentFailure {
  checkId: string;
  fingerprint: string;
  /** Each kind of signal seen, once, in the order first seen. */
  signals: EnvironmentSignal[];
  /** The cause in a phrase, for the outcome reason. */
  cause: string;
  /** At most MAX_EVIDENCE_LINES distinct output lines that show it, each cut to MAX_LINE_CHARS. */
  lines: string[];
}

export const MAX_EVIDENCE_LINES = 3;
const MAX_LINE_CHARS = 200;

/** Lines scanned at most, so a runaway log cannot make this slow. */
const MAX_SCANNED_LINES = 200_000;

// What srt and the macOS sandbox leave in output: the annotated violations block, a sandbox deny log line, the proxy's
// refusal tags for a host outside the allowlist.
const VIOLATION = /<\/?sandbox_violations>|\bSandbox:.*\bdeny\(|X-Proxy-Error|Connection blocked by network allowlist/i;
const EPERM = /\bEPERM\b/;
const NOT_PERMITTED = /operation not permitted/i;
const DENIED = /\bEACCES\b|permission denied/i;
// An absolute path in prose or quotes. The character before it must not be part of a word or a relative path (./x).
const ABSOLUTE_PATH = /(?<![\w./~<>-])\/[^\s'"`:,;()<>[\]{}|]+/g;

const CAUSES: Record<EnvironmentSignal, string> = {
  'sandbox-violation': 'the sandbox reported a denied operation',
  eperm: 'an operation the sandbox does not permit failed with EPERM',
  'operation-not-permitted': 'the operating system answered "operation not permitted"',
  'eacces-outside-worktree': 'permission was denied (EACCES) on a path outside the worktree',
};

function within(path: string, root: string): boolean {
  const r = root.length > 1 ? root.replace(/\/+$/, '') : root;
  return path === r || path.startsWith(`${r}/`);
}

function deniedOutside(line: string, roots: readonly string[]): boolean {
  if (!DENIED.test(line)) return false;
  const paths = line.match(ABSOLUTE_PATH) ?? [];
  return paths.some((p) => !roots.some((root) => within(p.replace(/[.]+$/, ''), root)));
}

/**
 * The environment cause of a failing check, or null when the failure is not shown to be one: it must equal the base
 * revision's, and the output must show a denial (EPERM, "operation not permitted", an srt violation marker, or EACCES
 * on a path outside `insideRoots`).
 */
export function classifyEnvironmentFailure(input: EnvironmentFailureInput): EnvironmentFailure | null {
  const { fingerprint, baselineFingerprint } = input;
  if (!fingerprint || !baselineFingerprint || fingerprint !== baselineFingerprint) return null;

  const signals: EnvironmentSignal[] = [];
  const lines: string[] = [];
  const see = (signal: EnvironmentSignal): void => {
    if (!signals.includes(signal)) signals.push(signal);
  };
  for (const raw of stripAnsi(input.output).split('\n', MAX_SCANNED_LINES)) {
    const line = raw.replace(/\r$/, '');
    const found: EnvironmentSignal[] = [];
    if (VIOLATION.test(line)) found.push('sandbox-violation');
    if (EPERM.test(line)) found.push('eperm');
    if (NOT_PERMITTED.test(line)) found.push('operation-not-permitted');
    if (deniedOutside(line, input.insideRoots)) found.push('eacces-outside-worktree');
    if (found.length === 0) continue;
    for (const s of found) see(s);
    const shown = line.trim().slice(0, MAX_LINE_CHARS);
    if (lines.length < MAX_EVIDENCE_LINES && !lines.includes(shown)) lines.push(shown);
  }
  if (signals.length === 0) return null;
  return { checkId: input.checkId, fingerprint, signals, cause: signals.map((s) => CAUSES[s]).join('; '), lines };
}
