import { isAbsolute } from 'node:path';
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
 *
 * A check the environment refused before it ran anything of the repository is the third
 * (classifyCouldNotRun): a filesystem operation outside its checkout, a socket in the tool's own
 * startup, a .NET named pipe under /tmp, or a connection the sandbox's proxy refused, with no
 * compile error or failing test in its output. PREFLIGHT reads every failure of the base
 * revision this way, and a misconfigured check (evidence/check-misconfigured.ts) next, before it
 * may call one a pre-existing failure (docs/decisions/0010-base-failure-classification.md).
 */

export type EnvironmentSignal =
  | 'sandbox-violation'
  | 'eperm'
  | 'operation-not-permitted'
  | 'eacces-outside-worktree'
  | 'process-aborted'
  | 'start-failed'
  | 'browser-isolation'
  | 'filesystem-denied'
  | 'permission-denied'
  | 'socket-denied'
  | 'network-denied'
  | 'nuget-http-denied'
  | 'nuget-tls-denied'
  | 'program-not-found'
  | 'pipe-denied';

/**
 * The signals added for the base revision by ADR 0010 and by ADR 0009's addendum (`pipe-denied`). On a candidate they
 * count only when the same check showed the same one on the base revision (CouldNotRunInput.baseSignals): a change can
 * introduce a denial of its own (a test that opens a file it may not read, a package from a host the check may not
 * reach, a second project under a check whose command has no -m:1, a test that runs dotnet build), and that is a
 * failure for the repair loop. `pipe-denied` is gated although the runner writes the note it is read from: the note
 * relays MSBuild's crash report from the check's own temp directory, about a node the repository's projects or tests
 * made MSBuild start, and it is the same refusal `socket-denied` reads from `dotnet test`'s MSB1025, so both get one rule.
 */
export const BASE_GATED_SIGNALS: ReadonlySet<EnvironmentSignal> = new Set<EnvironmentSignal>(['permission-denied', 'socket-denied', 'network-denied', 'nuget-http-denied', 'nuget-tls-denied', 'program-not-found', 'pipe-denied']);

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
// An absolute path in prose or quotes, GNU's curly ones included (coreutils prints ‘/x’ under a UTF-8 locale, as checks
// get on Linux). The character before it must not be part of a word or a relative path (./x).
const ABSOLUTE_PATH = /(?<![\w./~<>-])\/[^\s'"`\u2018\u2019\u201C\u201D:,;()<>[\]{}|]+/g;

const CAUSES: Record<EnvironmentSignal, string> = {
  'sandbox-violation': 'the sandbox reported a denied operation',
  eperm: 'an operation the sandbox does not permit failed with EPERM',
  'operation-not-permitted': 'the operating system answered "operation not permitted"',
  'eacces-outside-worktree': 'permission was denied (EACCES) on a path outside the worktree',
  'process-aborted': 'the process was killed by a fatal signal before it printed anything of its own',
  'start-failed': 'the check could not be started',
  'browser-isolation': 'the browser could not start under sandbox-runtime',
  'filesystem-denied': 'the sandbox or the operating system refused a filesystem operation outside the check\'s checkout (EPERM, "operation not permitted", or EROFS, "read-only file system")',
  'permission-denied': 'the sandbox or the operating system refused a filesystem operation outside the check\'s checkout with EACCES ("permission denied")',
  'socket-denied': 'the sandbox or the operating system refused the tool a socket (permission denied) in its own startup, before it ran anything of the repository',
  'network-denied': "the sandbox's network proxy refused a connection to a host the check may not reach",
  'nuget-http-denied': "NuGet's HTTP client could not start in the sandbox (the type initializer of System.Net.CookieContainer failed to read the host's domain name, GetDomainName: -1), so the restore could reach no package source",
  'nuget-tls-denied': "NuGet could not establish the SSL connection to its package source in the sandbox (on macOS srt keeps the system trust service out of reach, so .NET cannot verify nuget.org's certificate there), so the restore could reach no package source",
  'program-not-found': 'a program the check runs was not found where it runs (exit 127)',
  'pipe-denied': 'the sandbox refused a .NET process the named pipe it binds under /tmp (an MSBuild worker node, or the build host dotnet format loads the project with), so nothing was built or formatted',
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
  const all = stripAnsi(input.output).split('\n', MAX_SCANNED_LINES);
  // The runner writes its footer as the log's last line, after everything the check printed: a footer-like line
  // anywhere else is the check's own output, so a check cannot print one that reads as a crash.
  let last = all.length - 1;
  while (last >= 0 && all[last]!.trim() === '') last--;
  for (const [i, raw] of all.entries()) {
    const line = raw.trim();
    if (line === '') continue;
    const killed = KILLED_BY_SIGNAL.exec(line);
    const footer = i === last ? RUNNER_FOOTER.exec(line) : null;
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

// ---------------------------------------------------------------------------
// A check the environment refused before it ran anything of the repository

export interface CouldNotRunInput {
  checkId: string;
  /** The check's output, as logged (already redacted). */
  output: string;
  /** Directories the check may write: its checkout, as given and resolved, and its own scratch directories. A denial inside them is the code's. */
  insideRoots: readonly string[];
  /**
   * On a candidate: the environment signals the same check showed on the base revision (its baseline failure's
   * classification). A signal of BASE_GATED_SIGNALS counts only when it is among them; with none recorded it does not
   * count, and the failure goes to repair. Absent: the base revision itself is judged (or a probe), and every signal counts.
   */
  baseSignals?: readonly EnvironmentSignal[];
}

// A filesystem call, by the name a runtime, the C library or a shell tool gives it, or the error type that reports one.
const FS_CALL = /\b(?:mkdir|mkdtemp|mkstemp|open|openat|creat|rename|unlink|rmdir|chmod|chown|lchown|symlink|link|copyfile|clonefile|scandir|opendir|access|stat|lstat|utimes?|truncate|shm_open|sem_open|realpath|readlink|mkfifo|bind|connect|touch|cp|mv|rm|ln|PermissionError|IOException|errno)\b/i;
/**
 * node's name for a server's bind of a Unix socket (`listen EACCES: permission denied /tmp/x.pipe`). It counts with
 * EACCES only, the gated permission-denied: Seatbelt refuses a Unix socket server anywhere with EPERM (`listen EPERM:
 * operation not permitted /tmp/claude/acme.sock`, captured under srt on macOS), and an ungated reading of that would take
 * a candidate that adds such a server out of the repair loop.
 */
const LISTEN_CALL = /\blisten\b/i;
// macOS's Seatbelt refuses a write with EPERM; srt on Linux mounts everything outside the writable paths read-only, so
// the same write fails there with EROFS.
const DENIAL = /\bEPERM\b|operation not permitted|\bEROFS\b|read-only file system/i;
// A Unix socket or a file the host's permissions (or the sandbox) forbid: EACCES, "permission denied", and .NET's
// "Access to the path '/x' is denied".
const PERMISSION_DENIAL = /\bEACCES\b|permission denied|access to the path '[^']*' is denied/i;
// A Seatbelt deny line, as macOS logs it ("Sandbox: dotnet(4242) deny(1) file-write-create /private/tmp/.dotnet") and as
// srt repeats it in its violations block: the operation, then the path of a file operation.
const SEATBELT_DENY = /\bdeny\(\d+\)\s+([a-z][\w-]*)(?:\s+(\S+))?/i;
/**
 * The sandbox's network proxy refusing a connection: srt's own refusal (its 403 body and X-Proxy-Error tag, which a
 * verbose client prints) and the way clients report a proxy's 403 to the tunnel they asked for (curl and everything on
 * libcurl, git included; .NET's HttpClient, so NuGet). Under srt every proxy a check talks to is srt's.
 */
const NETWORK_DENIAL = /Connection blocked by network allowlist|\bX-Proxy-Error\b|\bblocked-by-allowlist\b|\bCONNECT tunnel failed, response 403\b|\bproxy tunnel request to proxy '[^']*' failed with status code '403'/i;
/**
 * NuGet's HTTP client failing to start in the sandbox on macOS, before it reaches the network: the type initializer of
 * System.Net.CookieContainer reads the host's domain name, which srt's profile does not let it read (captured under the
 * real runner and srt 0.0.78 with the .NET 9 SDK, tests/fixtures/environment/dotnet-build-nuget-cookiecontainer.log).
 * Counted only in NuGet's own restore error (NU1301) and with the failed read next to it.
 */
const NUGET_HTTP_DENIAL = /\berror NU1301:.*\bThe type initializer for 'System\.Net\.CookieContainer' threw an exception\b/;
/**
 * NuGet's restore that reached its package source and could not establish the SSL connection: on macOS under srt,
 * .NET verifies a certificate through the system trust service, which srt keeps out of reach (captured under the real
 * runner and srt 0.0.78 with the .NET 9 SDK and api.nuget.org in the check's network_hosts,
 * tests/fixtures/environment/dotnet-build-nuget-ssl.log). Counted only in NuGet's own restore error (NU1301): a test
 * that reports the same HttpRequestException is a test that failed.
 */
const NUGET_TLS_DENIAL = /\berror NU1301:\s+The SSL connection could not be established\b/;
const DOMAIN_NAME_DENIED = /\bGetDomainName: -1\b/;
/**
 * A permission denial on a socket: .NET's SocketException with errno 13 (EACCES) or 1 (EPERM), or a bind, listen or
 * connect refused with EACCES or EPERM. It names no path when the socket is a TCP one or .NET's, so on its own it cannot
 * show whose socket it was; it counts only inside the tool's own crash (TOOL_CRASH).
 */
const SOCKET_DENIAL = /\bSocketException \((?:1|13)\): (?:Permission denied|Operation not permitted)\b|\b(?:bind|listen|connect)\b.*(?:\bEACCES\b|\bEPERM\b|permission denied|operation not permitted)|(?:\bEACCES\b|\bEPERM\b|permission denied|operation not permitted).*\b(?:bind|listen|connect)\b/i;
/** MSBuild's own report of an exception it did not expect: the build engine crashed, it did not build anything. */
const MSBUILD_INTERNAL_FAILURE = /\bMSBUILD : error MSB1025\b/;
/**
 * The tool's own crash, not a test's: MSBuild's internal-failure error, or a stack frame in the .NET SDK's own
 * assemblies (MSBuild, the dotnet CLI, NuGet, the compiler server, the test platform's host). The repository's own code
 * crashing shows its own frames (Program.Main...), and a test that fails shows the test runner's failure report.
 */
const TOOL_CRASH = [MSBUILD_INTERNAL_FAILURE, /^\s*at (?:Microsoft\.Build|Microsoft\.DotNet|NuGet|Microsoft\.CodeAnalysis|Microsoft\.TestPlatform|Microsoft\.VisualStudio\.TestPlatform\.(?:CommandLine|CrossPlatEngine|Client|Common|CommunicationUtilities))\./m];

/**
 * Output that shows the repository's code was compiled or tested and failed: a compiler diagnostic or a test runner's
 * failure report. A denial next to it does not show that the check could not run, so the failure stays the code's.
 */
const CODE_FAILURE: readonly RegExp[] = [
  /\berror (?:CS|FS|BC|TS)\d{4}\b/, // C#, F#, Visual Basic, TypeScript
  /\berror\[E\d{4}\]/, // Rust
  /:\d+(?::\d+)?: (?:fatal )?error:/, // C, C++, Swift, Java
  /\bSyntaxError\b/,
  /\bAssertionError\b|\bAssert\.\w+\(\) Failure\b|\bassertion failed\b/i,
  /\bFailed!\s+-\s+Failed:\s*[1-9]/, // dotnet test
  /^\s*(?:not ok \d+|FAIL\b|--- FAIL:|FAILED\s+\S+::)/m, // TAP, Jest and Vitest, Go, pytest
  /^FAILED \((?:failures|errors)=/m, // Python's unittest summary
  /^ERROR: \w+ \(/m, // a test unittest reports as erroring: "ERROR: test_reads (test_config.ConfigTests.test_reads)"
  /\btest result: FAILED\b/, // cargo test
  /^\s*(?:#|ℹ)\s*fail\s+[1-9]/m, // node:test
  // A count and its word share a line in every runner's summary; across a line break "-1" and "Failed to restore" are no count.
  /\b[1-9]\d*[ \t]+(?:failed|failing|failures?)\b/i,
  // A summary that puts the word first and ends the count there: Microsoft.Testing.Platform's "  failed: 1" (the report
  // of xunit v3, MSTest's runner and TUnit), xunit's own "Total: 2, Errors: 0, Failed: 1, ...", VSTest's "Failed:     1,
  // Passed: ...". An errno after a failed call ("failed: 1 (Operation not permitted)") is no count.
  /\b(?:failed|failures):[ \t]*[1-9]\d*(?:[,.]|[ \t]*\r?$)/im,
  // Microsoft.Testing.Platform's line for each failing test, with its duration: "failed WritesCache (12ms)".
  /^[ \t]*failed \S.*\((?:\d+(?:ms|[smhd])[ \t]?)+\)[ \t]*\r?$/m,
  // xunit's own runner's line for each failing test: "Acme.Tests.CacheTests.WritesCache [FAIL]".
  /\[FAIL\][ \t]*\r?$/m,
  // go test -json's event for a test or package that failed: {"Action":"fail",...}.
  /"Action":\s*"fail"/,
  // bun test's line for each failing test, "(fail) reads the config [0.31ms]", and its summary's " 1 fail".
  /^[ \t]*\(fail\) \S/m,
  /^[ \t]*[1-9]\d* fail[ \t]*\r?$/m,
  // dart test's last line when a test failed: "00:01 +3 -1: Some tests failed.".
  /\bSome tests failed\.[ \t]*\r?$/m,
];

/** Compilers' and MSBuild's error counts ("2 errors", "1 Error(s)"). */
const ERROR_COUNT = /\b[1-9]\d*[ \t]+errors?\b|\b[1-9]\d* Error\(s\)/i;
const MSBUILD_ERROR_SUMMARY = /\b[1-9]\d* Error\(s\)/;
/** An MSBuild error line: its origin, then `error`, then its code when it has one ("Acme.csproj : error NU1301: ...", "MSBUILD : error MSB1025: ..."). */
const MSBUILD_ERROR_LINE = /^(.*?)\s*:\s+error(?:\s+([A-Za-z]+\d+))?\s*:/;
/** NuGet's restore: its errors (NUxxxx) and the restore task's own uncoded ones from NuGet.targets. */
const NUGET_TARGETS = /\bNuGet\.targets\(\d+,\d+\)$/;

/**
 * Whether every error MSBuild counted is one that compiled nothing of the repository: NuGet's restore errors (NUxxxx, or
 * the restore task's own from NuGet.targets) and MSBuild's internal failure (MSB1025). MSBuild's "N Error(s)" summary then
 * counts a restore the sandbox or its network proxy refused, not a build that failed on the code.
 */
function onlyRestoreErrors(text: string): boolean {
  if (!MSBUILD_ERROR_SUMMARY.test(text)) return false;
  let seen = 0;
  for (const raw of text.split('\n', MAX_SCANNED_LINES)) {
    const m = MSBUILD_ERROR_LINE.exec(raw.trim());
    if (!m) continue;
    const code = m[2];
    const restore = code !== undefined ? /^NU\d{4}$/.test(code) || code === 'MSB1025' : NUGET_TARGETS.test(m[1]!);
    if (!restore) return false;
    seen += 1;
  }
  return seen > 0;
}

/**
 * Whether `text` shows the repository's code was compiled or tested and failed (a compiler diagnostic or a test runner's
 * failure report). An error count shows it too, unless every error MSBuild counted is a restore error or its internal
 * failure (onlyRestoreErrors). With `countRestoreErrors` that count shows it too, as every count did before ADR 0010:
 * on a candidate whose base revision showed no environment failure, a change that adds a package brought the restore
 * failure, and it goes to repair.
 */
export function showsCodeFailure(text: string, opts: { countRestoreErrors?: boolean } = {}): boolean {
  return CODE_FAILURE.some((re) => re.test(text)) || (ERROR_COUNT.test(text) && (opts.countRestoreErrors === true || !onlyRestoreErrors(text)));
}

/** A line cut to MAX_LINE_CHARS that keeps position `at` in view: a runtime names the failed call at the end of a long line. */
function excerpt(line: string, at: number): string {
  if (line.length <= MAX_LINE_CHARS) return line;
  const start = Math.max(0, Math.min(at - (MAX_LINE_CHARS - 40), line.length - (MAX_LINE_CHARS - 3)));
  return start === 0 ? line.slice(0, MAX_LINE_CHARS) : `...${line.slice(start, start + MAX_LINE_CHARS - 3)}`;
}

/**
 * The runner's record of a check it stopped because MSBuild recorded a worker node the sandbox refused its named pipe,
 * or of a check whose dotnet format exited 0 having loaded no project because the sandbox refused its build host's pipe
 * (evidence/runner.ts): the note on the footer it writes as the log's last line, which no output of the check can follow.
 */
const RUNNER_NODE_DENIAL = /^\[orbit\] check=\S+ status=FAILED exit=\S+ note=(the check sandbox denied (?:MSBuild node \(pid \d+\)|dotnet format's build host) its named pipe .*)$/;
/**
 * dotnet format's MSBuildWorkspace that could not reach its build host, whose named pipe Roslyn binds under /tmp
 * (evidence/dotnet-format.ts): a frame of its build host manager, and a pipe connect that timed out (macOS, SDK 9) or was
 * refused ("unable to connect to it's pipe", Linux, SDK 10). The line shown is the unhandled exception's.
 */
const BUILD_HOST_FRAME = /\bMicrosoft\.CodeAnalysis\.MSBuild\.BuildHostProcessManager\b/;
const BUILD_HOST_PIPE = /\bSystem\.IO\.Pipes\.NamedPipeClientStream\.(?:ConnectInternal|TryConnect)\b|unable to connect to it'?s pipe/;
const UNHANDLED = /^Unhandled exception[.:]\s/;

/** The lines that show a .NET named pipe the sandbox refused under /tmp, at most one per kind; empty when there is none. */
function pipeDenials(lines: readonly string[]): string[] {
  const out: string[] = [];
  const last = [...lines].reverse().find((l) => l.trim() !== '')?.trim() ?? '';
  const node = RUNNER_NODE_DENIAL.exec(last);
  if (node) out.push(node[1]!.slice(0, MAX_LINE_CHARS));
  const text = lines.join('\n');
  if (BUILD_HOST_FRAME.test(text) && BUILD_HOST_PIPE.test(text)) {
    const shown = lines.map((l) => l.trim()).find((l) => UNHANDLED.test(l)) ?? lines.map((l) => l.trim()).find((l) => BUILD_HOST_PIPE.test(l));
    if (shown) out.push(shown.slice(0, MAX_LINE_CHARS));
  }
  return out;
}

/**
 * The environment cause of a check that could not run because the sandbox or the operating system refused it something
 * before it ran anything of the repository, or null. It needs no base-revision comparison, so it can judge the baseline
 * itself (docs/decisions/0010-base-failure-classification.md). Both halves are required:
 *
 * - a refusal that is not the repository's to fix, one of:
 *   - a denial on a filesystem call that names a path outside `insideRoots`: EPERM or "operation not permitted"
 *     (macOS), EROFS or "read-only file system" (Linux): the .NET runtime's `mkdir("/tmp/.dotnet/shm/...") == -1;
 *     errno == EPERM`, node's `EPERM: operation not permitted, mkdir '/x'`, a shell tool's `mkdir: /x: Operation not
 *     permitted` or `mkdir: cannot create directory ‘/x’: Read-only file system` (filesystem-denied); or EACCES or
 *     "permission denied" (the host's permissions, or a Unix socket the sandbox refuses: node's `listen EACCES:
 *     permission denied /tmp/x.pipe`; permission-denied);
 *   - a Seatbelt deny line (one for a file operation only on such a path);
 *   - the sandbox's network proxy refusing a connection (NETWORK_DENIAL), NuGet's HTTP client failing to start in
 *     the sandbox (NUGET_HTTP_DENIAL), or NuGet's restore that could not establish the SSL connection to its source
 *     (NUGET_TLS_DENIAL);
 *   - a .NET named pipe the sandbox refused under /tmp (pipeDenials, pipe-denied): the runner's note on a check it
 *     stopped for a refused MSBuild worker node or whose dotnet format loaded no project, or dotnet format's build host
 *     that could not be reached;
 *   - a permission denial on a socket (SOCKET_DENIAL) inside the tool's own crash (TOOL_CRASH): MSBuild's internal
 *     failure on the named pipe it opens for its nodes, a Unix socket, is the tool being refused; the same denial in
 *     the repository's own program, or with no crash of the tool around it, is not shown to be. When pipeDenials has
 *     read the refusal, the socket denial in the same crash is that pipe, and is not read again;
 * - and no sign that the repository's code was compiled or tested and failed (showsCodeFailure): a compile error or a
 *   failing test next to a denial is still the code's failure, and keeps the normal path. A test whose assertion message
 *   says "permission denied" is a failing test.
 *
 * On a candidate (`baseSignals` given) the signals of BASE_GATED_SIGNALS count only when the same check showed the same
 * one on the base revision, and MSBuild's count of restore errors reads as a code failure unless the base revision showed
 * an environment failure: a denial or a restore failure the change introduced is the change's to repair.
 */
export function classifyCouldNotRun(input: CouldNotRunInput): EnvironmentFailure | null {
  const text = stripAnsi(input.output);
  // On a candidate whose base revision showed no environment failure, MSBuild's count of restore errors is the change's.
  if (showsCodeFailure(text, { countRestoreErrors: input.baseSignals !== undefined && input.baseSignals.length === 0 })) return null;
  const outside = (path: string): boolean => !input.insideRoots.some((root) => within(path.replace(/[.]+$/, ''), root));
  const counts = (signal: EnvironmentSignal): boolean => input.baseSignals === undefined || !BASE_GATED_SIGNALS.has(signal) || input.baseSignals.includes(signal);
  const all = text.split('\n', MAX_SCANNED_LINES).map((raw) => raw.replace(/\r$/, ''));
  const pipes = counts('pipe-denied') ? pipeDenials(all) : [];
  // A .NET named pipe is a Unix socket: once pipeDenials has read the refusal, a SocketException in the same crash is it.
  const toolCrashed = pipes.length === 0 && TOOL_CRASH.some((re) => re.test(text));
  const domainNameDenied = DOMAIN_NAME_DENIED.test(text);
  const signals: EnvironmentSignal[] = pipes.length > 0 ? ['pipe-denied'] : [];
  const lines: string[] = [];
  const show = (line: string, at: number): void => {
    const shown = excerpt(line, at);
    if (lines.length < MAX_EVIDENCE_LINES && !lines.includes(shown)) lines.push(shown);
  };
  for (const pipe of pipes) show(pipe, 0);
  for (const raw of all) {
    const line = raw.trim();
    const deny = SEATBELT_DENY.exec(line);
    const denial = DENIAL.exec(line);
    const permission = PERMISSION_DENIAL.exec(line);
    const network = NETWORK_DENIAL.exec(line);
    const nuget = domainNameDenied ? NUGET_HTTP_DENIAL.exec(line) : null;
    const tls = NUGET_TLS_DENIAL.exec(line);
    const socket = toolCrashed ? SOCKET_DENIAL.exec(line) : null;
    const pathOutside = (): boolean => (line.match(ABSOLUTE_PATH) ?? []).some(outside);
    const candidates: { signal: EnvironmentSignal; at: number }[] = [];
    if (deny && (!deny[1]!.toLowerCase().startsWith('file-') || (deny[2] !== undefined && isAbsolute(deny[2]) && outside(deny[2])))) candidates.push({ signal: 'sandbox-violation', at: deny.index });
    if (denial && FS_CALL.test(line) && pathOutside()) candidates.push({ signal: 'filesystem-denied', at: denial.index });
    if (permission && (FS_CALL.test(line) || LISTEN_CALL.test(line)) && pathOutside()) candidates.push({ signal: 'permission-denied', at: permission.index });
    if (network) candidates.push({ signal: 'network-denied', at: network.index });
    if (nuget) candidates.push({ signal: 'nuget-http-denied', at: nuget.index });
    if (tls) candidates.push({ signal: 'nuget-tls-denied', at: tls.index });
    if (socket) candidates.push({ signal: 'socket-denied', at: socket.index });
    const found = candidates.find((c) => counts(c.signal));
    if (found === undefined) continue;
    // One line shows a refused socket: the crash repeats it for every node MSBuild starts.
    if (found.signal === 'socket-denied' && signals.includes('socket-denied')) continue;
    if (!signals.includes(found.signal)) signals.push(found.signal);
    // The tool's own first error line goes before the denial it reports, so the reason starts where the log does.
    if (found.signal === 'socket-denied' && lines.length === 0) {
      const first = text.split('\n', MAX_SCANNED_LINES).find((l) => MSBUILD_INTERNAL_FAILURE.test(l));
      if (first !== undefined) show(first.replace(/\r$/, '').trim(), 0);
    }
    show(line, found.at);
  }
  if (signals.length === 0) return null;
  return { checkId: input.checkId, fingerprint: null, signals, cause: signals.map((s) => CAUSES[s]).join('; '), lines };
}
