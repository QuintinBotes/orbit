import { basename, isAbsolute } from 'node:path';
import { directInvocation, startedProgram, startedPrograms, type DirectInvocation } from './check-command.ts';
import { showsCodeFailure, type EnvironmentFailure, type EnvironmentSignal } from './environment-failure.ts';
import { stripAnsi } from './fingerprint.ts';

/**
 * Telling a check whose command is wrong from a failure of the repository's code (pure, no I/O; issue #23,
 * docs/decisions/0010-base-failure-classification.md).
 *
 * A check whose command is wrong fails on the base revision in under a second: `dotnet build A.csproj B.csproj` is
 * refused by MSBuild before it reads either project. That is not a pre-existing failure of the repository, and accepting
 * it as a baseline exception would let a run pass with a check that never tested anything. The table below has two
 * kinds of such errors:
 *
 * - an argument error (MSBuild's unknown switch or second project, go's undefined flag, cargo's unexpected argument):
 *   the command line itself is wrong, whatever the repository holds. PREFLIGHT blocks on it as a misconfigured check
 *   (`checks.<id>.command`).
 * - a missing target (no project for MSBuild, or more than one, npm's missing script, pytest's missing test file or
 *   unknown option, dotnet test's unknown switch, a dotnet or cargo command nothing provides yet, a script of the
 *   repository that does not exist): the command names something the base revision does not have, which the goal may be
 *   to create (a pytest plugin's option, a test platform's, a project, one solution of two). It stays eligible for P18: a contract that names the
 *   check as the proof of a criterion expects it to flip (controller/steps/baseline-questions.ts); one that does not
 *   blocks the run as misconfigured at CONTRACTING. Either way it is never accepted as a baseline exception: a check
 *   whose target does not exist would be a meaningless check made green.
 *
 * A program the check runs that is not installed where it runs (exit 127, a bare name or an absolute path), or that the
 * sandbox does not let it start (exit 126, "Operation not permitted", by an absolute path or found on PATH), is neither:
 * it is the environment's (classifyProgramNotFound), like a program the runner could not start at all.
 *
 * The rule is conservative on purpose: a fast exit proves nothing. A usage error counts only when all of these hold:
 *
 * - its output has a signature from the table: the tool's own words for a command line it rejected, each verified
 *   against the real tool;
 * - it comes from the check's own direct invocation of the tool (evidence/check-command.ts): the command's program
 *   (after a leading env assignment, env or an npx-style runner) is the tool, and the command is not a shell chain or
 *   pipeline. `npm test` whose script runs a missing `npm run lint` (or `cd client && npm test` in a package with no
 *   test script), a chain such as `dotnet restore && npm test`, and `dotnet run --project build/Build.csproj` whose
 *   program runs a wrong `dotnet build` put the error in code of the repository, which a change may fix: those stay
 *   pre-existing failures;
 * - what the error names is what the command names: the script npm reports missing is the one the command runs, and
 *   npm ran no script before it (it prints no lifecycle banner), the switch MSBuild rejects is one the command passes
 *   (not one from a response file of the repository), the arguments pytest does not know are the command's (not the
 *   repository's addopts);
 * - the check exited, with the exit code the tool gives that error where it has one (pytest 4, go 2, cargo's unknown
 *   command 101, a shell's command not found 127), and a second line the tool always prints with it where the same words
 *   could come from another program (go's and cargo's usage lines: a test binary or the repository's own program
 *   rejects a flag in the same words);
 * - and nothing in the output shows the repository's code was compiled or tested and failed (a compiler diagnostic or a
 *   failing test next to it means the tool did run).
 */

export interface MisconfiguredInput {
  checkId: string;
  /** The check's command as the policy defines it: an argv, or one shell script when `shell` is set. */
  command: readonly string[];
  /** The check's `shell` setting: its command is one script, run by /bin/sh. */
  shell?: boolean;
  /** How the check exited; null when it did not exit by itself (a timeout). */
  exitCode: number | null;
  /** The check's output, as logged (already redacted). */
  output: string;
}

/** An argument error is the command line's; a missing target is something the command names that does not exist yet. */
export type CommandErrorKind = 'argument' | 'missing-target';

export interface MisconfiguredCheck {
  checkId: string;
  kind: CommandErrorKind;
  /** The usage-error signature that matched (an id of USAGE_ERRORS). */
  signature: string;
  /** The tool that rejected the command, as a person names it. */
  tool: string;
  /** The cause in a phrase, for the outcome reason. */
  cause: string;
  /** The tool's error line (the first error line it printed), then the line that names what it rejected, when it prints one. */
  lines: string[];
  /** Where the command is configured. */
  configKey: string;
}

export interface UsageErrorSignature {
  id: string;
  kind: CommandErrorKind;
  /** The tool, as a person names it. */
  tool: string;
  /** Whether the check's direct invocation runs the tool that prints this error. */
  runs: (inv: DirectInvocation) => boolean;
  /** The tool's own error line. */
  line: RegExp;
  /** Exit codes the tool gives this error; any non-zero one when absent. */
  exitCodes?: readonly number[];
  /** A line the tool always prints with it, required too. */
  with?: RegExp;
  /** A line the tool never prints with it when the error is the command's own: when present, the error came from elsewhere. */
  without?: RegExp;
  /** A line after it that names what was rejected, shown with it when present. */
  detail?: RegExp;
  /** Whether what the error names (from its line, and its detail line when present) is what the command names. */
  names?: (inv: DirectInvocation, m: RegExpExecArray, detail: string | undefined) => boolean;
  /** What the error means, for the cause. */
  meaning: string;
}

/** dotnet commands that hand their arguments to MSBuild, which parses them. `dotnet run` builds too, then runs a program of the repository. */
const MSBUILD_COMMANDS: ReadonlySet<string> = new Set(['build', 'test', 'pack', 'publish', 'restore', 'clean', 'msbuild']);
/** The dotnet CLI's own commands (SDK 8 to 10). A first argument that is none of them is a tool, a program or a DLL it looks for. */
const DOTNET_COMMANDS: ReadonlySet<string> = new Set([
  'add', 'build', 'build-server', 'clean', 'completions', 'dev-certs', 'dnx', 'exec', 'format', 'fsi', 'help', 'list', 'msbuild', 'new', 'nuget', 'pack', 'package',
  'project', 'publish', 'reference', 'remove', 'restore', 'run', 'sdk', 'sln', 'solution', 'store', 'test', 'tool', 'user-jwts', 'user-secrets', 'vstest', 'watch', 'workload',
]);
const PYTEST = ['pytest', 'py.test'];
// What go prints after an argument it rejects: the usage of the go command, never that of a test binary or a program.
const GO_USAGE = /^usage: go\b|^Run 'go help\b|^\s*go <command> \[arguments\]$/m;
const MSBUILD_SWITCH = /^Switch: \S/;
/** npm's lifecycle banner for a script it runs: "> acme@1.0.0 test", then "> " and the script's command. */
const NPM_BANNER = /^> \S/m;
/**
 * A shell, env or Orbit's limits wrapper (`orbit-limits`, isolation/limits.ts, a bash that execs the command, as every
 * check runs by default) reporting a program it could not find: `/bin/sh: x: command not found`, dash's `sh: 1: x: not
 * found`, bash 5's `orbit-limits: line 1: /x/python: No such file or directory` (Linux, exit 127) and `orbit-limits: line
 * 1: exec: x: not found`, bash 3.2's `orbit-limits: line 0: exec: /x/python: cannot execute: No such file or directory`
 * (macOS, exit 126), zsh's and env's. The program is captured as the line spells it, spaces included: a caller compares it
 * with the words of the check's command.
 */
const SHELL_NOT_FOUND =
  /^(?:\S*\/)?(?:sh|bash|dash|ksh|ash|orbit-limits)(?::\s*line \d+)?:\s*(?:\d+:\s*)?(?:exec:\s*)?(\S.*?): (?:cannot execute: )?(?:command not found|not found|No such file or directory)$|^(?:\S*\/)?zsh:\d+: (?:command not found|no such file or directory): (\S.*)$|^(?:\S*\/)?env: ['‘]?(\S.*?)['’]?: No such file or directory$/;
/**
 * A shell, env or Orbit's limits wrapper (`orbit-limits`, isolation/limits.ts, a bash that execs the command) reporting
 * that the operating system refused to start a program (exit 126): `/bin/sh: /x/python: Operation not permitted`,
 * `orbit-limits: line 0: exec: /x/python: cannot execute: Operation not permitted`, `env: /x/python: Operation not
 * permitted`, and bash's `/bin/sh: /x/pytest: /x/python: bad interpreter: Operation not permitted` for a script (a tool
 * environment's console script; captured under Seatbelt with bash 3.2 and 5). The program is captured as the line spells
 * it, spaces included (`/x/my venvs/bin/python`): a caller compares it with the words of the check's command.
 */
const SHELL_NOT_PERMITTED =
  /^(?:\S*\/)?(?:sh|bash|dash|ksh|ash|orbit-limits)(?::\s*line \d+)?:\s*(?:\d+:\s*)?(?:exec:\s*)?(\S.*?): (?:cannot execute: |[^:]+: bad interpreter: )?Operation not permitted$|^(?:\S*\/)?zsh:\d+: operation not permitted: (\S.*)$|^(?:\S*\/)?env: ['‘]?(\S.*?)['’]?: Operation not permitted$/;

const runsMsbuild = (inv: DirectInvocation): boolean => inv.tool === 'msbuild' || (inv.tool === 'dotnet' && MSBUILD_COMMANDS.has(inv.args[0] ?? ''));
/** The switch MSBuild names is one the command passes, when it names one. */
const switchPassed = (inv: DirectInvocation, _m: RegExpExecArray, detail: string | undefined): boolean => detail === undefined || inv.args.includes(detail.replace(/^Switch:\s*/, ''));
const passes = (inv: DirectInvocation, arg: string): boolean => inv.args.some((a) => a === arg || a.startsWith(`${arg}=`));
/** The first argument that is not an option (nor cargo's +toolchain). */
const subcommand = (inv: DirectInvocation): string | undefined => inv.args.find((a) => !a.startsWith('-') && !a.startsWith('+'));

/** The script an npm command runs: `npm run x`, `npm run-script x`, `npm test` (and t, tst), `npm start`, stop and restart. */
export function npmScript(args: readonly string[]): string | undefined {
  const VALUE_OPTIONS = new Set(['--prefix', '-C', '--workspace', '-w', '--userconfig', '--cache', '--loglevel', '--script-shell']);
  const positional = (from: number): number => {
    let i = from;
    while (i < args.length && args[i]!.startsWith('-') && args[i] !== '--') i += VALUE_OPTIONS.has(args[i]!) ? 2 : 1;
    return i;
  };
  const c = positional(0);
  const cmd = args[c];
  if (cmd === 'run' || cmd === 'run-script' || cmd === 'rum' || cmd === 'urn') {
    const s = args[positional(c + 1)];
    return s === '--' ? undefined : s;
  }
  if (cmd === 't' || cmd === 'tst' || cmd === 'test') return 'test';
  if (cmd === 'start' || cmd === 'stop' || cmd === 'restart') return cmd;
  return undefined;
}

/** The usage-error signatures, one per tool error, each verified against the real tool (tests/fixtures/misconfigured). */
export const USAGE_ERRORS: readonly UsageErrorSignature[] = [
  {
    id: 'dotnet-test-unknown-switch',
    kind: 'missing-target',
    tool: 'dotnet test (MSBuild)',
    // dotnet test hands MSBuild every option it does not know itself, and a test platform's option is one of them until
    // the repository runs its tests on that platform (SDK 9.0.305: `dotnet test A.csproj --report-trx` is MSB1001,
    // "Switch: --report-trx"). A change to the repository may be what makes it right, so the goal may be to.
    runs: (inv) => inv.tool === 'dotnet' && inv.args[0] === 'test',
    line: /^MSBUILD : error MSB1001: /,
    detail: MSBUILD_SWITCH,
    names: switchPassed,
    meaning: 'MSBuild does not know a switch on it: a misspelled one, or an option of a test platform the repository does not run its tests on yet (Microsoft.Testing.Platform\'s --report-trx), which dotnet test hands to MSBuild',
  },
  { id: 'msbuild-unknown-switch', kind: 'argument', tool: 'dotnet (MSBuild)', runs: (inv) => runsMsbuild(inv) && !(inv.tool === 'dotnet' && inv.args[0] === 'test'), line: /^MSBUILD : error MSB1001: /, detail: MSBUILD_SWITCH, names: switchPassed, meaning: 'MSBuild does not know a switch on it' },
  { id: 'msbuild-one-project', kind: 'argument', tool: 'dotnet (MSBuild)', runs: runsMsbuild, line: /^MSBUILD : error MSB1008: /, detail: MSBUILD_SWITCH, names: switchPassed, meaning: 'it names more than one project, and MSBuild builds one project or solution per command' },
  // A folder with two projects or solutions is one a change may leave with one (an old .sln next to its .slnx).
  { id: 'msbuild-ambiguous-project', kind: 'missing-target', tool: 'dotnet (MSBuild)', runs: runsMsbuild, line: /^MSBUILD : error MSB1011: /, meaning: 'it names no project or solution, and its working directory holds more than one' },
  { id: 'msbuild-no-project', kind: 'missing-target', tool: 'dotnet (MSBuild)', runs: runsMsbuild, line: /^MSBUILD : error MSB1003: /, meaning: 'it names no project or solution, and its working directory holds none' },
  { id: 'msbuild-project-missing', kind: 'missing-target', tool: 'dotnet (MSBuild)', runs: runsMsbuild, line: /^MSBUILD : error MSB1009: /, detail: MSBUILD_SWITCH, names: switchPassed, meaning: 'the project or solution file it names does not exist' },
  {
    id: 'dotnet-no-such-command',
    kind: 'missing-target',
    tool: 'dotnet',
    // dotnet's own words for a first argument that is no command of its own: a misspelling, a local tool the repository
    // has not declared or restored, or a program it has not built yet. A command of its own (dotnet run) ran a program of
    // the repository, whose output this may be.
    runs: (inv) => inv.tool === 'dotnet' && inv.args[0] !== undefined && !inv.args[0].startsWith('-') && !DOTNET_COMMANDS.has(inv.args[0]),
    line: /^Could not execute because the specified command or file was not found\.$/,
    meaning: 'dotnet has no such command (a misspelled command, a local tool the repository has not declared or restored, or a program not built yet)',
  },
  {
    id: 'npm-missing-script',
    kind: 'missing-target',
    tool: 'npm',
    runs: (inv) => inv.tool === 'npm',
    line: /^npm (?:error|ERR!) Missing script: "(.*)"$/,
    // npm prints a script's lifecycle banner ("> acme@1.0.0 test", or "> test" for a package with no name) only when it
    // found the script and ran it, and checks for the command's own script before it runs anything. With a banner the
    // missing script is a nested npm's, run by a script of the repository ("test": "cd client && npm test").
    without: NPM_BANNER,
    names: (inv, m) => npmScript(inv.args) === m[1],
    meaning: 'package.json has no script of that name',
  },
  {
    id: 'pytest-unrecognized-arguments',
    // pytest says the same for an option of a plugin it has not loaded or of a conftest.py that does not add it yet
    // (pytest 8.4.1: --cov without pytest-cov, -n without pytest-xdist), and the goal may be to add that plugin or
    // option, as cargo's no such command may be a plugin not provided yet.
    kind: 'missing-target',
    tool: 'pytest',
    runs: (inv) => PYTEST.includes(inv.tool),
    line: /^\S+: error: unrecognized arguments: (.+)$/,
    exitCodes: [4],
    // Every argument pytest did not know is one the command passes, not one of the repository's addopts.
    names: (inv, m) => m[1]!.trim().split(/\s+/).every((a) => inv.args.includes(a)),
    meaning: 'pytest does not know an option on it: a misspelled one, or an option of a plugin or a conftest.py that is not there yet (--cov without pytest-cov, -n without pytest-xdist), which the repository\'s dependencies or its conftest.py add',
  },
  {
    id: 'pytest-path-not-found',
    kind: 'missing-target',
    tool: 'pytest',
    runs: (inv) => PYTEST.includes(inv.tool),
    line: /^ERROR: file or directory not found: (.+)$/,
    exitCodes: [4],
    names: (inv, m) => inv.args.includes(m[1]!),
    meaning: 'a test file or directory it names does not exist',
  },
  {
    id: 'go-flag',
    kind: 'argument',
    tool: 'go',
    runs: (inv) => inv.tool === 'go',
    line: /^(?:flag provided but not defined: (-[^\s=]+)|flag needs an argument: (-[^\s=]+)|invalid value ".*" for flag (-[^\s:=]+))/,
    exitCodes: [2],
    with: GO_USAGE,
    names: (inv, m) => passes(inv, (m[1] ?? m[2] ?? m[3])!),
    meaning: 'the go command does not accept a flag on it',
  },
  {
    id: 'go-unknown-command',
    kind: 'argument',
    tool: 'go',
    runs: (inv) => inv.tool === 'go',
    // "go tset: unknown command", and for a command of a command the one it was given to: "go mod: unknown command".
    line: /^go((?: [\w-]+)*): unknown (?:sub)?command\b/,
    exitCodes: [2],
    names: (inv, m) => {
      const path = m[1]!.trim().split(' ').filter((w) => w !== '');
      return path.length > 0 && path.every((w, i) => inv.args[i] === w);
    },
    meaning: 'go has no such command',
  },
  {
    id: 'cargo-unexpected-argument',
    kind: 'argument',
    tool: 'cargo',
    runs: (inv) => inv.tool === 'cargo',
    line: /^error: unexpected argument '(.*)' found$/,
    exitCodes: [1],
    with: /^Usage: cargo\b/m,
    names: (inv, m) => passes(inv, m[1]!),
    meaning: 'cargo does not know an argument on it',
  },
  {
    id: 'cargo-no-such-command',
    kind: 'missing-target',
    tool: 'cargo',
    runs: (inv) => inv.tool === 'cargo',
    line: /^error: no such command: `(.*)`$/,
    exitCodes: [101],
    names: (inv, m) => subcommand(inv) === m[1],
    meaning: 'cargo has no such command (a misspelled command, or a cargo plugin or alias the repository does not provide yet)',
  },
  {
    id: 'script-not-found',
    kind: 'missing-target',
    tool: 'the shell',
    // sh and bash ("/bin/sh: ./x: No such file or directory", "bash: line 1: ./x: ..."), dash ("sh: 1: ./x: not
    // found"), zsh ("zsh:1: no such file or directory: ./x") and env, which Orbit's sandbox launch goes through.
    runs: () => true,
    line: SHELL_NOT_FOUND,
    exitCodes: [127],
    // A path relative to the check's cwd: a file of the repository, which the goal may add.
    names: (inv, m) => {
      const missing = m.slice(1).find((g) => g !== undefined);
      return missing === inv.program && missing.includes('/') && !isAbsolute(missing);
    },
    meaning: 'the script it runs does not exist',
  },
];

/** Lines read at most, so a runaway log cannot make this slow. */
const MAX_SCANNED_LINES = 200_000;
const MAX_LINE_CHARS = 200;

function outputLines(text: string): string[] {
  return text.split('\n', MAX_SCANNED_LINES).map((l) => l.replace(/\r$/, ''));
}

/**
 * The misconfiguration a failing check's output shows, or null when it does not show one (module comment for the
 * rule). Only a check that failed on the base revision is judged this way: on a candidate the same error is the change's.
 */
export function classifyMisconfigured(input: MisconfiguredInput): MisconfiguredCheck | null {
  if (input.exitCode === null || input.exitCode === 0) return null;
  const inv = directInvocation(input.command, input.shell === true);
  if (inv === null) return null;
  const text = stripAnsi(input.output);
  if (showsCodeFailure(text)) return null;
  const lines = outputLines(text);
  for (const sig of USAGE_ERRORS) {
    if (sig.exitCodes && !sig.exitCodes.includes(input.exitCode)) continue;
    if (!sig.runs(inv)) continue;
    if (sig.with && !sig.with.test(text)) continue;
    if (sig.without && sig.without.test(text)) continue;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      const m = sig.line.exec(line);
      if (!m) continue;
      const detail = sig.detail ? lines.slice(i + 1, i + 6).map((l) => l.trim()).find((l) => sig.detail!.test(l)) : undefined;
      if (sig.names && !sig.names(inv, m, detail)) continue;
      const shown = [line.slice(0, MAX_LINE_CHARS), ...(detail !== undefined ? [detail.slice(0, MAX_LINE_CHARS)] : [])];
      const cause = sig.kind === 'argument' ? `${sig.tool} rejected the check's command line: ${sig.meaning}` : `${sig.tool} could not find what the check's command names: ${sig.meaning}`;
      return { checkId: input.checkId, kind: sig.kind, signature: sig.id, tool: sig.tool, cause, lines: shown, configKey: `checks.${input.checkId}.command` };
    }
  }
  return null;
}

/**
 * A program the check's own command runs that could not be started where the check runs, or null (ADR 0010). Two kinds:
 *
 * - not found: the shell's, env's or Orbit's limits wrapper's "not found" for a program of the command, with exit 127
 *   (program-not-found). It is not installed there, not on the check's PATH, misspelled, or in a folder the check
 *   sandbox hides (on Linux srt lays an empty folder over a denied one; on macOS a bare name whose PATH folder the
 *   sandbox denies is not found either). The program is the one a direct invocation starts or the one a runner or
 *   `python -m` runs, by a bare name or an absolute path, or one any command of the check's starts (a chain's, a nested
 *   shell's, one `exec` starts): an absolute path, or with exit 127 a bare name (`cd tests && pytest -q`). A name only a
 *   script of the repository runs (`cd client && npm test` whose script runs a missing jest) is none of them. macOS's
 *   bash 3.2 gives a path its limits wrapper cannot find exit 126 ("cannot execute: No such file or directory"), read the
 *   same way. A path relative to the check's cwd is a script of the repository (script-not-found).
 * - refused: the shell's, env's or Orbit's limits wrapper's "Operation not permitted" for a program the command starts
 *   (evidence/check-command.ts startedPrograms: a chain's, a pipeline's, one `exec` starts), by its absolute path as the
 *   command writes it, spaces included, or the path the shell found a bare name at on PATH, with exit 126
 *   (program-denied): the sandbox does not let the check start it, as Seatbelt refuses a program in a folder the check
 *   profile denies (the repository, the folder beside it), whatever it links to. Captured under srt 0.0.78 on macOS.
 *   EACCES ("Permission denied") is a file without its execute bit, and a relative path a file of the checkout: both
 *   stay the code's.
 *
 * Either is the environment's, as when the runner cannot start the program at all. The failure carries the program as
 * the line names it (`program`), so that PREFLIGHT can tell where it lies.
 */
export function classifyProgramNotFound(input: MisconfiguredInput): EnvironmentFailure | null {
  const exit = input.exitCode;
  if (exit !== 127 && exit !== 126) return null;
  const shell = input.shell === true;
  const programs = startedPrograms(input.command, shell);
  if (programs.length === 0) return null;
  const inv = directInvocation(input.command, shell);
  const started = startedProgram(input.command, shell);
  const text = stripAnsi(input.output);
  if (showsCodeFailure(text)) return null;
  // An absolute path a command of the check starts, as written; for exit 126, also the path a shell found a bare name at.
  const startsPath = (path: string): boolean => isAbsolute(path) && programs.includes(path);
  const startsFound = (path: string): boolean => isAbsolute(path) && programs.some((p) => p === path || (!p.includes('/') && basename(path) === p));
  for (const raw of outputLines(text)) {
    const line = raw.trim();
    if (exit === 126) {
      const m = SHELL_NOT_PERMITTED.exec(line);
      const denied = m?.slice(1).find((g) => g !== undefined);
      if (denied !== undefined && startsFound(denied)) {
        return {
          checkId: input.checkId,
          fingerprint: null,
          signals: ['program-denied'],
          cause: `the sandbox or the operating system refused to start the program "${denied}" the check runs (exit 126, "operation not permitted")`,
          lines: [line.slice(0, MAX_LINE_CHARS)],
          program: denied,
        };
      }
    }
    const m = SHELL_NOT_FOUND.exec(line);
    const missing = m?.slice(1).find((g) => g !== undefined);
    if (missing === undefined) continue;
    const direct = exit === 127 && inv !== null && (missing === inv.program || missing === started) && !(missing.includes('/') && !isAbsolute(missing));
    // A bare name any command of the check's starts, which its shell looked up on the check's PATH (second review of the 0.3.0 retest fix).
    const bare = exit === 127 && !missing.includes('/') && programs.includes(missing);
    if (!direct && !bare && !startsPath(missing)) continue;
    return {
      checkId: input.checkId,
      fingerprint: null,
      signals: ['program-not-found'],
      cause: `the program "${missing}" was not found where the check runs (exit ${exit}): it is not installed there, not on the check's PATH, or misspelled`,
      lines: [line.slice(0, MAX_LINE_CHARS)],
      program: missing,
    };
  }
  return null;
}

/**
 * Where a check's program would lie for the backstop (classifyDeniedFolderProgram): the folder the check sandbox denies
 * because of where the repository is that holds a path (the repository, or the folder that holds it and its sibling
 * projects; never the check's own checkout), and where the check's PATH finds a bare name.
 */
export interface DeniedFolders {
  /** The denied folder that holds `path`, as a reason names it ("the repository (/x)"), or null when none does. */
  holding: (path: string) => string | null;
  /** The path of the first folder of the check's PATH that holds an executable of that name, or null. */
  onPath: (name: string) => string | null;
}

/** The operating system refusing an operation: "Operation not permitted", EPERM. */
const REFUSAL = /operation not permitted|\bEPERM\b/i;
/**
 * A launcher refusing to start a program, which it names as the command wrote it (a path, spaces included, or a bare
 * name): a shell's, eval's, exec's, env's or Orbit's limits wrapper's `<who>: <program>: Operation not permitted`
 * (`exec: <program>: cannot execute: ...`, dash's `sh: 1: eval: <program>: ...`), bash's `<program>: <interpreter>: bad
 * interpreter: Operation not permitted` for a script, zsh's `operation not permitted: <program>`, node's `spawn
 * <program> EPERM`. Captured under Seatbelt on macOS (bash 3.2 and 5, dash, zsh, env, node). A tool's refusal of a file
 * it works on (`mkdir: /x: Operation not permitted`) is no launcher's.
 */
const LAUNCHER_REFUSAL =
  /^(?:\S*\/)?(?:sh|bash|dash|ksh|ash|zsh|orbit-limits|env|xargs|nohup|nice|timeout)(?::\s*line \d+)?:\s*(?:\d+:\s*)?(?:(?:eval|exec):\s*)?['\u2018]?([^:\s'\u2018][^:]*?)['\u2019]?: (?:cannot execute: |[^:]+: bad interpreter: )?operation not permitted$|^(?:\S*\/)?(?:zsh|\(eval\)):\d+: operation not permitted: (\S.*)$|\bspawn(?:Sync)? (\/\S+) EPERM\b/i;
/** An absolute path a line quotes ('/x y', "/x", ‘/x’), spaces included, or writes as one word. */
const QUOTED_PATH = /['"\u2018\u201C](\/[^'"\u2019\u201D]+)['"\u2019\u201D]/g;
const PATH_WORD = /(?<![\w./~-])\/[^\s'"`\u2018\u2019\u201C\u201D:,;()<>[\]{}|]+/g;
/**
 * A program a launcher did not find, as it names it: a shell's (`/bin/sh: 1: pytest: not found`, `bash: line 1: x:
 * command not found`, `/x: No such file or directory`), eval's, env's or zsh's (`command not found: x`).
 */
const NOT_FOUND = /(?:^|:\s)(?:exec:\s*)?['\u2018]?([^:\s'\u2018][^:]*?)['\u2019]?: (?:cannot execute: )?(?:command not found|not found|No such file or directory)$|(?:command not found|no such file or directory): (\S.*)$/;

/**
 * The backstop for a check the sandbox stopped at a folder it denies, whatever the check's command looks like (second
 * review of the 0.3.0 retest fix; ADR 0010): `eval "$CMD"`, a script of the repository, a launcher whose words the
 * parser does not follow. classifyProgramNotFound reads a program the command starts; this reads the output alone, and
 * needs where what was refused lies to be sure:
 *
 * - a launcher refusing to start a program (LAUNCHER_REFUSAL) that lies in such a folder, by its path or by a bare name
 *   the check's PATH finds there (program-denied), whatever the exit code (a launcher such as npm passes on its own);
 * - any other refusal ("Operation not permitted", EPERM) of a path in such a folder, which the line quotes or writes
 *   (filesystem-denied: a check runs in a checkout of its own, and may not use the repository or the folder beside it);
 * - with exit 127, a launcher's "not found" for a path in such a folder (on Linux srt lays an empty folder over a denied
 *   one) or for a bare name the check's PATH finds there (program-not-found).
 *
 * A check whose own tests or build ran and failed (showsCodeFailure) is the code's, whatever its output quotes: a test
 * whose assertion message names such a refusal is a failing test. Null too for a check that passed or did not exit.
 */
export function classifyDeniedFolderProgram(input: MisconfiguredInput, folders: DeniedFolders): EnvironmentFailure | null {
  const exit = input.exitCode;
  if (exit === null || exit === 0) return null;
  const text = stripAnsi(input.output);
  if (showsCodeFailure(text)) return null;
  /** Where a program the line names (a path, or a bare name the check's PATH finds) lies, when that is a denied folder. */
  const located = (named: string): string | null => {
    const at = isAbsolute(named) ? named : named.includes('/') ? null : folders.onPath(named);
    return at === null ? null : folders.holding(at);
  };
  const failure = (signal: EnvironmentSignal, cause: string, line: string, program?: string): EnvironmentFailure => ({
    checkId: input.checkId,
    fingerprint: null,
    signals: [signal],
    cause,
    lines: [line.slice(0, MAX_LINE_CHARS)],
    ...(program !== undefined ? { program } : {}),
  });
  for (const raw of outputLines(text)) {
    const line = raw.trim();
    if (REFUSAL.test(line)) {
      const program = LAUNCHER_REFUSAL.exec(line)?.slice(1).find((g) => g !== undefined);
      const where = program !== undefined ? located(program) : null;
      if (program !== undefined && where !== null) {
        return failure('program-denied', `the sandbox or the operating system refused to start the program "${program}" the check runs ("operation not permitted"), which lies in ${where}, a folder the check sandbox denies`, line, program);
      }
      for (const path of [...[...line.matchAll(QUOTED_PATH)].map((q) => q[1]!), ...(line.match(PATH_WORD) ?? [])]) {
        const held = folders.holding(path);
        if (held !== null) return failure('filesystem-denied', `the sandbox or the operating system refused "${path}" ("operation not permitted"), which lies in ${held}, a folder the check sandbox denies: a check runs in a checkout of its own and may not use it`, line);
      }
    }
    if (exit !== 127) continue;
    const missing = NOT_FOUND.exec(line)?.slice(1).find((g) => g !== undefined);
    const where = missing !== undefined ? located(missing) : null;
    if (missing === undefined || where === null) continue;
    return failure('program-not-found', `the program "${missing}" was not found where the check runs (exit 127): it lies in ${where}, a folder the check sandbox denies`, line, missing);
  }
  return null;
}
