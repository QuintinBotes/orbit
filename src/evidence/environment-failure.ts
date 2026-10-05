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
 *
 * A check that could not execute at all is the other kind (classifyNotExecuted):
 * its process was killed by a fatal signal before it printed anything of its own
 * (node aborting at startup under the sandbox, the first live run of the demo app),
 * or the runner could not start it. Nothing of the repository ran, so no change to
 * the repository can have caused it, and no base-revision comparison is needed.
 */

export type EnvironmentSignal = 'sandbox-violation' | 'eperm' | 'operation-not-permitted' | 'eacces-outside-worktree' | 'process-aborted' | 'start-failed' | 'browser-isolation';

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
  /** The failure's fingerprint; null for a check that could not execute, which has no result to fingerprint. */
  fingerprint: string | null;
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
  'process-aborted': 'the process was killed by a fatal signal before it printed anything of its own',
  'start-failed': 'the check could not be started',
  'browser-isolation': 'the browser could not start under sandbox-runtime',
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

// ---------------------------------------------------------------------------
// A check that could not execute at all

export interface NotExecutedInput {
  checkId: string;
  /** The output of the process that did not run: a check's log or the application's log (already redacted). */
  output: string;
  /** The signal that ended the process, when the runner knows it. */
  signal?: string | null;
  /** The runner's own note that the check could not be started (the command was not found, the sandbox refused to launch it). */
  startFailure?: string | null;
  /**
   * The UI runner's finding that the browser could not start under sandbox-runtime (Chromium's Mach rendezvous denied,
   * the srt preload refusing, a browser other than Playwright's Chromium on macOS), with the line that shows it.
   * Playwright prints its own output around such a failure, so the log alone cannot show that nothing ran.
   */
  browserIsolation?: string | null;
}

/**
 * Signals that mean the process itself crashed. SIGKILL, SIGTERM and the limit signals (SIGXCPU, SIGXFSZ) are not here:
 * they come from a deadline, a person or a configured limit, each of which has its own record.
 */
const CRASH_SIGNALS: ReadonlySet<string> = new Set(['SIGABRT', 'SIGSEGV', 'SIGBUS', 'SIGILL', 'SIGTRAP', 'SIGSYS']);

// What node prints when it aborts, and what srt and the check runner add around it. None of it is the program's own output.
const TRACE_HEADER = /^-{3,}\s*(Native|JavaScript) stack trace\s*-{3,}$/i;
// Frames of the JavaScript section (process.abort() from a script prints one): "1: file:///app/main.mjs:3:9".
const JS_FRAME = /^\d+:\s+\S/;
// A frame node cannot name prints as the bare address once the line is trimmed ("2: 0x7f3a1c2e4b50"), as the Linux x64 runner does.
const TRACE_FRAME = /^\d+:\s+0x[0-9a-f]+(?:\s|$)/i;
const KILLED_BY_SIGNAL = /^Process killed by signal: (SIG[A-Z0-9]+)$/;
const RUNNER_FOOTER = /^\[orbit\] check=\S+ status=\S+ exit=(\S+)/;

/**
 * The environment cause of a check that could not execute, or null when it did. Two shapes count:
 * the runner could not start the check at all, or the process was killed by a crash signal (SIGABRT, SIGSEGV...) and
 * printed nothing but the crash itself. A process that printed anything else did run: a test run that segfaults after
 * reporting results, an application that throws while loading, a failing assertion all keep the normal repair loop.
 */
export function classifyNotExecuted(input: NotExecutedInput): EnvironmentFailure | null {
  const browser = input.browserIsolation?.trim();
  if (browser) return { checkId: input.checkId, fingerprint: null, signals: ['browser-isolation'], cause: CAUSES['browser-isolation'], lines: [browser.slice(0, MAX_LINE_CHARS)] };
  const start = input.startFailure?.trim();
  if (start) return { checkId: input.checkId, fingerprint: null, signals: ['start-failed'], cause: CAUSES['start-failed'], lines: [start.slice(0, MAX_LINE_CHARS)] };

  let crash = input.signal !== undefined && input.signal !== null && CRASH_SIGNALS.has(input.signal) ? input.signal : null;
  // The line that names the signal first, then where node was when it died.
  const kills: string[] = [];
  const frames: string[] = [];
  // node prints a native stack trace only when it dies from a crash signal, so the header is evidence even when the signal itself is not.
  let traced = false;
  let own = 0;
  let inJsTrace = false;
  for (const raw of stripAnsi(input.output).split('\n', MAX_SCANNED_LINES)) {
    const line = raw.trim();
    if (line === '') continue;
    const killed = KILLED_BY_SIGNAL.exec(line);
    const footer = RUNNER_FOOTER.exec(line);
    const header = TRACE_HEADER.exec(line);
    if (header) {
      inJsTrace = header[1]!.toLowerCase() === 'javascript';
      traced = true;
    } else if (inJsTrace && JS_FRAME.test(line)) {
      // part of the crash report, not the program's own output
    } else if (TRACE_FRAME.test(line)) {
      if (frames.length === 0) frames.push(line.slice(0, MAX_LINE_CHARS));
    } else if (killed) {
      if (CRASH_SIGNALS.has(killed[1]!)) {
        crash = killed[1]!;
        if (kills.length === 0) kills.push(line);
      } else {
        own += 1;
      }
    } else if (footer) {
      if (CRASH_SIGNALS.has(footer[1]!)) crash = footer[1]!;
    } else {
      own += 1;
    }
  }
  if ((crash === null && !traced) || own > 0) return null;
  return { checkId: input.checkId, fingerprint: null, signals: ['process-aborted'], cause: crash === null ? CAUSES['process-aborted'] : `${CAUSES['process-aborted']} (${crash})`, lines: [...kills, ...frames] };
}
