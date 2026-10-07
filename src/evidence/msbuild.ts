import { closeSync, constants, type Dir, fstatSync, lstatSync, opendirSync, openSync, readSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { CheckDefinition } from '../policy/types.ts';

/**
 * MSBuild worker nodes under the check sandbox (issue #10, reopened; docs/decisions/0009-toolchain-profiles.md,
 * addendum). With more than one node, MSBuild starts each worker node as a process that binds a named pipe, which .NET
 * implements as a Unix socket at /tmp/MSBuild<pid> (a path MSBuild fixes, whatever TMPDIR says). The sandbox refuses
 * that bind: Seatbelt denies the file-write-create of the socket (macOS), srt's seccomp filter denies every AF_UNIX
 * socket (Linux). The node dies with SocketException at startup. On macOS its parent, whose connect only finds no
 * socket yet, waits 30 s for it before starting the next one, ten times: five minutes, then the build fails, with
 * nothing in the output for `dotnet build` and MSB1025 for `dotnet test`. On Linux the parent's own socket is refused
 * too, and the build fails within a second, as silently.
 *
 * The dotnet CLI passes MSBuild a bare -maxcpucount (one node per processor) for every command that builds, so a check
 * pins one node in its own command: -m:1. Orbit never changes a check's processor count: DOTNET_PROCESSOR_COUNT=1 also
 * gives MSBuild one node, but it reaches the test host, where xunit before 2.8 deadlocks a test that blocks on async
 * code, and it would silently change how a repository's tests run. A check may still set it in its own env: doctor
 * accepts that as one node (onOneProcessor), and its checks.dotnet-tests names the test projects on such an xunit. So
 * `orbit doctor` judges each check's command and env (msbuildNodes) and names the exact fix (msbuildFix), and the runner
 * stops a check as soon as MSBuild records a denied node (it writes a crash report into the check's private TMPDIR,
 * findMsbuildNodeDenial), which also covers what doctor cannot judge from a definition (make, a script, a shell line
 * with a pipe).
 */

export interface MsbuildNodeDenial {
  /** The node's process id, from its crash report's name. */
  pid: number;
  /** The pipe it could not bind: /tmp/MSBuild<pid> for a build node, null for another pipe server (the MSBuild server). */
  pipe: string | null;
  /** The exception line, "System.Net.Sockets.SocketException (13): Permission denied". */
  exception: string;
}

/**
 * Where MSBuild writes a node's unhandled exception: `<TMPDIR>/MSBuildTemp<user>/MSBuild_pid-<pid>_<id>.failure.txt`
 * (MSBuild 17, .NET SDK 8 and 9), `<TMPDIR>/MSBuildTemp<random>/...` (MSBuild 18, .NET SDK 10).
 */
const REPORT_DIR = /^MSBuildTemp/;
const REPORT_FILE = /^MSBuild_pid-(\d+)_[0-9a-f]+\.failure\.txt$/i;
const MAX_REPORTS = 32;
/**
 * How many names of the temp directory, and of each report directory, one look reads: the scan runs on the controller's
 * event loop every second, and the check decides how many files its temp directory holds. A check that buries its
 * reports under more only loses the early stop; its timeout still ends it.
 */
const MAX_TMP_ENTRIES = 4096;
const MAX_REPORT_DIR_ENTRIES = 256;
/**
 * How many names one look reads in all, the temp directory's and every report directory's: without it a check could
 * make it list 4096 directories of 256 names each (about a million names, a second of the event loop every second).
 */
const MAX_SCANNED_NAMES = 8192;
const MAX_REPORT_BYTES = 64 * 1024;
const MAX_EXCEPTION_CHARS = 200;
const SOCKET_EXCEPTION = /System\.Net\.Sockets\.SocketException \(\d+\): [^\r\n]+/;
const PIPE_SERVER = /System\.IO\.Pipes\.NamedPipeServerStream/;
const BUILD_NODE = /Microsoft\.Build\.BackEnd\.NodeEndpointOutOfProc/;

/** A file or directory as the file system knows it, whatever name it is reached by. */
interface Identity {
  dev: number;
  ino: number;
}

/** The identity of `path` itself when it is of the kind wanted, or null; a link is neither, and is not followed. */
function identity(path: string, kind: 'dir' | 'file'): Identity | null {
  try {
    const st = lstatSync(path);
    return (kind === 'dir' ? st.isDirectory() : st.isFile()) ? { dev: st.dev, ino: st.ino } : null;
  } catch {
    return null;
  }
}

const same = (a: Identity | null, b: Identity | null): boolean => a !== null && b !== null && a.dev === b.dev && a.ino === b.ino;

/**
 * The start of a regular file, opened without following a link and without waiting (the check owns the directory it
 * sits in, and can swap a FIFO in after the lstat: opened for reading, a FIFO waits for a writer with no time limit,
 * which froze the controller). Non-blocking, a FIFO opens at once and fstat turns it away. `opened` must accept the file
 * that was opened before anything of it is read.
 */
function readHead(path: string, opened: (file: Identity) => boolean = () => true): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || !opened({ dev: st.dev, ino: st.ino })) return null;
    const buf = Buffer.alloc(MAX_REPORT_BYTES);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** At most `max` names of a directory, in the order the file system gives them, sorted; none when it cannot be read. */
function list(dir: string, max: number): string[] {
  let d: Dir;
  try {
    d = opendirSync(dir);
  } catch {
    return [];
  }
  const names: string[] = [];
  try {
    for (let e = d.readSync(); e !== null && names.length < max; e = d.readSync()) names.push(e.name);
  } catch {
    /* unreadable part way: what was read */
  } finally {
    d.closeSync();
  }
  return names.sort();
}

/**
 * The first node MSBuild recorded as unable to bind its named pipe, among the crash reports in a process's private
 * temp directory, or null. Nothing else about those reports counts: another crash is MSBuild's own business. The
 * directory is the sandboxed process's, so nothing is waited for, at most MAX_REPORTS reports and MAX_SCANNED_NAMES names
 * in all are read, and a link it plants is not followed: neither a report nor a report directory that is one when looked
 * at is read. A report directory the check swaps for a link between that look and the open (the open follows a link in
 * the middle of its path, and Node has no way to open a name in a directory it holds open) is caught after the open,
 * before anything is read: the directory must still be the one looked at, and its name for the report must still name
 * the file opened, checked on both sides. That narrows the swap to four exact moments; it cannot close it, and what it
 * could show is one line of a file named like a report, cut to MAX_EXCEPTION_CHARS. `maxNames` is for tests.
 */
export function findMsbuildNodeDenial(tmpDir: string, maxNames = MAX_SCANNED_NAMES): MsbuildNodeDenial | null {
  let seen = 0;
  const top = list(tmpDir, Math.min(MAX_TMP_ENTRIES, maxNames));
  let budget = maxNames - top.length;
  for (const sub of top.filter((n) => REPORT_DIR.test(n))) {
    const dir = join(tmpDir, sub);
    const looked = identity(dir, 'dir');
    if (looked === null) continue;
    if (budget <= 0) return null;
    const names = list(dir, Math.min(MAX_REPORT_DIR_ENTRIES, budget));
    budget -= names.length;
    // A listing taken through a link swapped in for the directory names what is elsewhere: read nothing of it.
    if (!same(identity(dir, 'dir'), looked)) continue;
    for (const name of names) {
      const m = REPORT_FILE.exec(name);
      const path = join(dir, name);
      if (!m || identity(path, 'file') === null) continue;
      if (++seen > MAX_REPORTS) return null;
      const text = readHead(path, (file) => same(identity(dir, 'dir'), looked) && same(identity(path, 'file'), file) && same(identity(dir, 'dir'), looked));
      const exception = text === null ? null : SOCKET_EXCEPTION.exec(text);
      if (!text || !exception || !PIPE_SERVER.test(text)) continue;
      const pid = Number(m[1]);
      return { pid, pipe: BUILD_NODE.test(text) ? `/tmp/MSBuild${pid}` : null, exception: exception[0].trim().slice(0, MAX_EXCEPTION_CHARS) };
    }
  }
  return null;
}

/** "MSBuild node (pid 4242) could not bind its named pipe /tmp/MSBuild4242 (System.Net.Sockets.SocketException (13): Permission denied)". */
export function msbuildNodeDenialText(d: MsbuildNodeDenial): string {
  return `MSBuild node (pid ${d.pid}) could not bind its named pipe${d.pipe ? ` ${d.pipe}` : ''} (${d.exception})`;
}

/**
 * The note on the record of a check the runner stopped for a denied node, with the fix for that check (msbuildNodeFix).
 * `stopped` false: the check had failed on its own before the runner's next look found the record (MSBuild fails at
 * once on Linux), so the note does not say Orbit stopped it.
 */
export function msbuildNodeDenialNote(d: MsbuildNodeDenial, fix: string, stopped = true): string {
  const pipe = d.pipe ? ` ${d.pipe}` : '';
  const how = stopped ? '; MSBuild waits 30 s for each of ten node starts before it fails, so Orbit stopped the check' : ", and the check failed on it before the runner's next look";
  return `the check sandbox denied MSBuild node (pid ${d.pid}) its named pipe${pipe} (${d.exception})${how}. Fix: ${fix}`;
}

// -m, -m:4, /m:4, -maxcpucount:4, --maxCpuCount:4; MSBuild switches are case-insensitive.
const NODE_SWITCH = /^(?:--?|\/)(?:m|maxcpucount)(?::(\d+))?$/i;
const ONE_NODE = '-m:1';
/**
 * The dotnet commands that run MSBuild, each of which the dotnet CLI starts with a bare -maxcpucount. `run` builds too,
 * but hands every word it does not know, -m:1 included, to the program (measured under srt: `dotnet run -m:1` starts
 * worker nodes), so it is pinned by building first and running with --no-build.
 */
const MSBUILD_VERBS = new Set(['build', 'test', 'publish', 'pack', 'restore', 'msbuild', 'run', 'clean']);
const VERB_LIST = 'build, test, publish, pack, restore, clean or msbuild';
const RUN_CLAUSE = 'and build before dotnet run --no-build';
const RUN_REASON = 'runs "dotnet run", which builds on a worker node per processor and hands -m:1 to the program, not to MSBuild';
const CANNOT_TELL = 'so doctor cannot tell whether each of its MSBuild calls passes -m:1';
/** Programs that run other commands: a check that starts one may run dotnet without naming it. */
const RUNNERS = new Set(['make', 'gmake', 'just', 'task', 'sh', 'bash', 'zsh', 'dash', 'pwsh', 'powershell', 'env', 'xargs', 'nuke', 'cake']);
const SCRIPT = /\.(?:sh|bash|ps1|cmd|bat)$/i;
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);
/**
 * What makes a part of a shell line more than one simple command: an operator (a pipe, ||, a background job), a
 * subshell, a substitution, a redirection. What joins the commands of a chain doctor reads one by one: &&, ; or a new line.
 */
const SHELL_SYNTAX = /[;&|()<>`$\n]/;
const CHAIN_SEPARATOR = /(&&|;|\n)/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const MAX_SHOWN_CHARS = 160;

/** What doctor reads of a check: its command, whether a shell runs it, and its own env. */
export type JudgedCheck = Pick<CheckDefinition, 'command' | 'shell'> & { env?: Readonly<Record<string, string>> };

/**
 * Whether a check's own env gives every process it starts one processor (DOTNET_PROCESSOR_COUNT=1), so that MSBuild's
 * default, one node per processor, is one node: the alternative to -m:1 that the fix names and the runner passes. The
 * test host gets one processor too, which `orbit doctor`'s checks.dotnet-tests warns about for xunit before 2.8.
 */
export function onOneProcessor(env: Readonly<Record<string, string>> | undefined): boolean {
  return env?.DOTNET_PROCESSOR_COUNT?.trim() === '1';
}

/** Every word of a command, a shell script split on whitespace and operators. */
export function words(command: readonly string[]): string[] {
  return command.flatMap((part) => part.split(/[\s;&|()<>`]+/)).filter((w) => w !== '');
}

export const isDotnet = (word: string): boolean => basename(word) === 'dotnet';

/** The node switches among some words; a bare -m counts as null (one node per processor). */
function nodeSwitches(ws: readonly string[]): { word: string; n: number | null }[] {
  return ws.flatMap((w) => {
    const m = NODE_SWITCH.exec(w);
    return m ? [{ word: w, n: m[1] === undefined ? null : Number(m[1]) }] : [];
  });
}

/** The words of a dotnet command before a `--`, whose arguments belong to the program or the test runner. */
function ownWords(argv: readonly string[]): readonly string[] {
  const end = argv.indexOf('--');
  return end < 0 ? argv : argv.slice(0, end);
}

/** A dotnet command's verb: its first word that is not an option. */
export const verbOf = (argv: readonly string[]): string | undefined => argv.slice(1).find((w) => !w.startsWith('-'));

/**
 * The words of a dotnet command that reach MSBuild. `dotnet test` hands what follows `--` to the test runner as
 * RunSettings (measured under srt: `dotnet test P -- -m:1` is refused a worker node); the other verbs hand it to
 * MSBuild (`dotnet build P -- -m:1` builds on one node).
 */
const msbuildWords = (argv: readonly string[], verb: string): readonly string[] => (verb === 'test' ? ownWords(argv) : argv);

/** One simple command: the words in front of its program that only set variables (assignments, `env` and its options), and its own words. */
export interface Simple {
  prefix: string[];
  argv: string[];
}

/** The words of one command of a shell line, split on whitespace, with the assignments in front apart. */
export function simple(text: string): Simple {
  const ws = text.trim().split(/\s+/).filter((w) => w !== '');
  const at = ws.findIndex((w) => !ASSIGNMENT.test(w));
  return at < 0 ? { prefix: ws, argv: [] } : { prefix: ws.slice(0, at), argv: ws.slice(at) };
}

/** A shell line as the commands of a chain and the separators between them (`a && b; c`), or null when a command has other shell syntax. */
export function chainOf(line: string): { parts: string[]; separators: string[] } | null {
  const split = line.split(CHAIN_SEPARATOR);
  const parts = split.filter((_, i) => i % 2 === 0);
  return parts.some((p) => SHELL_SYNTAX.test(p)) ? null : { parts, separators: split.filter((_, i) => i % 2 === 1) };
}

/**
 * The command `env` starts, after its options and assignments (`env -u X CI=1 dotnet test`); null when env has an
 * option doctor does not read (`-S` splits a string into words, `-C` changes directory).
 */
function unwrapEnv(argv: readonly string[]): Simple | null {
  let i = 1;
  for (; i < argv.length; i++) {
    const w = argv[i]!;
    if (w === '-u' || w === '--unset') i++;
    else if (w === '--') {
      i++;
      break;
    } else if (w.startsWith('-') && !['-i', '-', '--ignore-environment'].includes(w) && !w.startsWith('--unset=')) return null;
    else if (!w.startsWith('-') && !ASSIGNMENT.test(w)) break;
  }
  return { prefix: argv.slice(0, i), argv: argv.slice(i) };
}

/** The shell line a check runs: its command with `shell: true`, or the script of an argv that is a shell's `-c` (`["sh", "-c", "dotnet test -m:1"]`); else null. */
export function shellLine(check: Pick<CheckDefinition, 'command' | 'shell'>): string | null {
  if (check.shell) return check.command[0] ?? '';
  const [program, flag, script] = check.command;
  return program !== undefined && SHELLS.has(basename(program)) && flag === '-c' && script !== undefined ? script : null;
}

/**
 * The simple commands a check runs, when its definition shows them: its argv (the command `env` starts, for env), or
 * the commands of a shell line, or of `sh -c`, that is a chain of simple commands. Null for a shell line with other syntax.
 */
export function commandsOf(check: Pick<CheckDefinition, 'command' | 'shell'>): Simple[] | null {
  const line = shellLine(check);
  if (line !== null) {
    const chain = chainOf(line);
    return chain && chain.parts.map(simple).filter((c) => c.argv.length > 0);
  }
  const [program] = check.command;
  if (program === undefined) return [];
  return [(basename(program) === 'env' ? unwrapEnv(check.command) : null) ?? { prefix: [], argv: [...check.command] }];
}

/** The program each command of a shell line starts: the first word of each that is not an assignment. */
function programs(line: string): string[] {
  return line
    .split(/[;&|()\n`]+/)
    .map((part) => part.trim().split(/\s+/).find((w) => w !== '' && !ASSIGNMENT.test(w)))
    .filter((w): w is string => w !== undefined);
}

/** Whether a program runs other commands: make, a shell, a wrapper, or a script (a path, or a script's extension). */
const runsOthers = (program: string): boolean => RUNNERS.has(basename(program)) || SCRIPT.test(program) || program.includes('/');

export type MsbuildNodes = { kind: 'pinned' } | { kind: 'unpinned'; reason: string } | { kind: 'indirect'; reason: string };
const PINNED: MsbuildNodes = { kind: 'pinned' };

/**
 * How one dotnet command runs MSBuild; null when it runs none (a verb that does not build, `dotnet run --no-build`).
 * `oneProcessor`: the check's env sets DOTNET_PROCESSOR_COUNT=1, so a bare -maxcpucount is one node.
 */
function judgeDotnet(argv: readonly string[], oneProcessor: boolean): MsbuildNodes | null {
  const verb = verbOf(argv);
  if (verb === undefined || !MSBUILD_VERBS.has(verb)) return null;
  if (verb === 'run') {
    if (ownWords(argv).includes('--no-build')) return null;
    return oneProcessor ? PINNED : { kind: 'unpinned', reason: RUN_REASON };
  }
  const switches = nodeSwitches(msbuildWords(argv, verb));
  const many = switches.find((s) => s.n !== null && s.n > 1);
  if (many) return { kind: 'unpinned', reason: `asks MSBuild for ${many.n} nodes (${many.word})` };
  const bare = switches.find((s) => s.n === null);
  if (bare && !oneProcessor) return { kind: 'unpinned', reason: `passes ${bare.word}, which asks MSBuild for a worker node per processor` };
  if (oneProcessor || switches.some((s) => s.n === 1)) return PINNED;
  return { kind: 'unpinned', reason: `runs "dotnet ${verb}" without -m:1, so MSBuild starts a worker node per processor` };
}

/** How one simple command runs MSBuild: as a dotnet command itself, or through a program that runs others. */
function judgeCommand(argv: readonly string[], oneProcessor: boolean, usesDotnet: boolean): MsbuildNodes | null {
  const [program] = argv;
  if (program === undefined) return null;
  if (isDotnet(program)) return judgeDotnet(argv, oneProcessor);
  if (words(argv.slice(1)).some(isDotnet)) return { kind: 'indirect', reason: `runs dotnet through ${basename(program)}, ${CANNOT_TELL}` };
  return usesDotnet && runsOthers(program) ? { kind: 'indirect', reason: `may run dotnet through ${program}, ${CANNOT_TELL}` } : null;
}

/**
 * How a check runs MSBuild, as far as its definition tells (doctor's static rule):
 * - pinned: each dotnet command that builds (MSBUILD_VERBS) that it runs itself passes -m:1 and no switch asking for
 *   more, or its own env sets DOTNET_PROCESSOR_COUNT=1, which gives every MSBuild it starts, through make or a script
 *   too, one node unless a switch asks for more;
 * - unpinned: it runs one itself without -m:1, or asks for more nodes: the sandbox refuses its build the worker nodes;
 * - indirect: it may run MSBuild through make, a script, a wrapper or a shell line, which no definition shows;
 * - null: it runs no MSBuild Orbit can see (another tool, a dotnet command that does not build, or a program that runs
 *   others in a repository without .NET).
 * A check runs a dotnet command itself as its argv (through `env` too), or as a command of a shell line, or of `sh -c`,
 * that is a chain of simple commands joined by &&, ; or a new line; the first unpinned command decides, then the first
 * indirect one. `usesDotnet`: whether the check gets the .NET toolchain (its command, or .NET markers at the checkout
 * root or its cwd).
 */
export function msbuildNodes(check: JudgedCheck, usesDotnet: boolean): MsbuildNodes | null {
  const one = onOneProcessor(check.env);
  const commands = commandsOf(check);
  const judged = commands ? commands.map((c) => judgeCommand(c.argv, one, usesDotnet)) : [complexLine(check, usesDotnet)];
  const found = judged.find((j) => j?.kind === 'unpinned') ?? judged.find((j) => j?.kind === 'indirect') ?? judged.find((j) => j?.kind === 'pinned') ?? null;
  return found?.kind === 'indirect' && one ? PINNED : found;
}

/** A shell line doctor cannot split into simple commands: whether it runs dotnet, or a program that may. */
function complexLine(check: Pick<CheckDefinition, 'command' | 'shell'>, usesDotnet: boolean): MsbuildNodes | null {
  if (words(check.command).some(isDotnet)) return { kind: 'indirect', reason: `runs dotnet in a shell line, ${CANNOT_TELL}` };
  const runner = usesDotnet ? programs(shellLine(check) ?? '').find(runsOthers) : undefined;
  return runner === undefined ? null : { kind: 'indirect', reason: `may run dotnet through ${runner}, ${CANNOT_TELL}` };
}

/** A word as a POSIX shell reads it back: bare when it is plain, else single-quoted. */
export function shellWord(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * The shell line that pins `dotnet run`: a build of the same project with -m:1, then the run itself without its node
 * switches and with --no-build (before a `--`), each after the same `prefix` (assignments, `env`). `quote`: the words
 * are an argv, to be quoted for the shell; otherwise they are a shell line's, kept as written.
 */
function runInTwoSteps(prefix: readonly string[], argv: readonly string[], quote: boolean): string {
  const ws = quote ? argv.map(shellWord) : [...argv];
  const pre = quote ? prefix.map(shellWord) : [...prefix];
  const end = argv.indexOf('--');
  const own = (end < 0 ? ws : ws.slice(0, end)).filter((w) => !NODE_SWITCH.test(w));
  const rest = end < 0 ? [] : ws.slice(end);
  const at = argv.indexOf('--project');
  const project = at > 0 && (end < 0 || at < end) ? ws[at + 1] : undefined;
  return [...pre, ws[0], 'build', ...(project ? [project] : []), ONE_NODE, '&&', ...pre, ...own, '--no-build', ...rest].join(' ');
}

/** A dotnet argv with -m:1 in place of the node switches MSBuild gets, before a `--` (kept after it for dotnet test, whose runner gets those). */
function pinnedArgv(argv: readonly string[], verb: string): string[] {
  const end = argv.indexOf('--');
  const kept = argv.filter((w, i) => !NODE_SWITCH.test(w) || (verb === 'test' && end >= 0 && i > end));
  const at = kept.indexOf('--');
  return at < 0 ? [...kept, ONE_NODE] : [...kept.slice(0, at), ONE_NODE, ...kept.slice(at)];
}

/**
 * A dotnet argv with -m:1 in place of the node switches MSBuild gets, as a check's fix writes it; unchanged when it pins
 * one node already or builds nothing (`dotnet tool restore`). `dotnet run` is kept as it is: it cannot be pinned in one
 * command.
 */
export function withOneMsbuildNode(argv: readonly string[]): string[] {
  const verb = verbOf(argv);
  if (verb === undefined || verb === 'run' || judgeDotnet(argv, false)?.kind !== 'unpinned') return [...argv];
  return pinnedArgv(argv, verb);
}

/** The node switches of some shell text, with the space before each, removed. */
const stripSwitches = (text: string): string => text.replace(/(^|\s)(?:--?|\/)(?:m|maxcpucount)(?::\d+)?(?=\s|$)/gi, '').trimEnd();

/** One dotnet command of a shell line with -m:1 in place of its node switches, as written otherwise (quotes kept). */
function pinnedText(text: string, verb: string): string {
  const end = text.search(/(?:^|\s)--(?:\s|$)/);
  if (end < 0) return `${stripSwitches(text)} ${ONE_NODE}`;
  const tail = text.slice(end);
  return `${stripSwitches(text.slice(0, end))} ${ONE_NODE}${verb === 'test' ? tail : stripSwitches(tail)}`;
}

/**
 * A shell line that is a chain of simple commands, with each dotnet command the sandbox would refuse worker nodes pinned
 * (spacing, quotes and separators kept), and whether one was a `dotnet run`; null when the line is no such chain, runs
 * no dotnet build, or also runs a program that may start one (make, a script), which no rewrite of the line reaches.
 */
function chainWithOneNode(line: string, oneProcessor: boolean): { line: string; run: boolean } | null {
  const chain = chainOf(line);
  if (!chain) return null;
  let builds = false;
  let run = false;
  const parts = chain.parts.map((part) => {
    const c = simple(part);
    const verb = verbOf(c.argv);
    const judged = c.argv[0] !== undefined && isDotnet(c.argv[0]) ? judgeDotnet(c.argv, oneProcessor) : null;
    builds ||= judged !== null;
    if (judged?.kind !== 'unpinned' || verb === undefined) return part;
    const lead = part.slice(0, part.length - part.trimStart().length);
    const trail = part.slice(part.trimEnd().length);
    run ||= verb === 'run';
    return `${lead}${verb === 'run' ? runInTwoSteps(c.prefix, c.argv, false) : pinnedText(part.trim(), verb)}${trail}`;
  });
  const others = chain.parts.some((part) => judgeCommand(simple(part).argv, oneProcessor, true)?.kind === 'indirect');
  if (!builds || others) return null;
  return { line: parts.map((p, i) => p + (chain.separators[i] ?? '')).join(''), run };
}

/**
 * A check's command pinned to one MSBuild node, or null when it is not one plain dotnet command or a chain of them: the
 * argv with -m:1 in place of its node switches (after `env` and its assignments), a shell line or `sh -c` script with
 * each unpinned dotnet command so fixed. `dotnet run` becomes a build and a run (runInTwoSteps), a shell line for an
 * argv; `shell` says whether the result is a shell line.
 */
function withOneNode(check: JudgedCheck): { command: string[]; shell: boolean; run: boolean } | null {
  const line = shellLine(check);
  if (line !== null) {
    const fixed = chainWithOneNode(line, onOneProcessor(check.env));
    if (!fixed) return null;
    return check.shell ? { command: [fixed.line], shell: true, run: fixed.run } : { command: [...check.command.slice(0, 2), fixed.line, ...check.command.slice(3)], shell: false, run: fixed.run };
  }
  const [c] = commandsOf(check) ?? [];
  const verb = c ? verbOf(c.argv) : undefined;
  if (!c || !isDotnet(c.argv[0] ?? '') || verb === undefined || !MSBUILD_VERBS.has(verb)) return null;
  if (verb === 'run') return { command: [runInTwoSteps(c.prefix, c.argv, true)], shell: true, run: true };
  return { command: [...c.prefix, ...pinnedArgv(c.argv, verb)], shell: false, run: false };
}

/** A command as a YAML flow sequence of JSON strings, as `orbit init` writes it, ready to paste into .orbit/config.yaml. */
export function shown(command: readonly string[]): string {
  return `[${command.map((w) => JSON.stringify(w)).join(', ')}]`;
}

/** Where a command is configured, for a fix that names it: a check's `checks.<id>.command` and `.env`, or the install's. */
export interface MsbuildFixWhere {
  command: string;
  /** Where DOTNET_PROCESSOR_COUNT could be set instead; null for Orbit's dependency install, which has no env of its own. */
  env: string | null;
}

/** The fix for one command the sandbox refuses MSBuild worker nodes, without the reason, which several share (msbuildFixReason). */
export interface MsbuildFix {
  /** The command with -m:1, ready to paste, or -m:1 on every MSBuild call it starts, naming it. */
  change: string;
  /** Where DOTNET_PROCESSOR_COUNT=1 could go instead; null for the dependency install, or a check whose env already sets it. */
  env: string | null;
}

/**
 * The exact fix for a check whose MSBuild the sandbox refuses worker nodes: its command with -m:1, ready to paste, when
 * doctor can rewrite it (a plain dotnet command, a chain of them, `sh -c`, `env`); otherwise -m:1 on every MSBuild call
 * it starts, naming its command. Without a check (a toolchain probe of a repository whose checks do not use .NET), the
 * fix is said of every check.
 */
export function msbuildFix(check: (JudgedCheck & Pick<CheckDefinition, 'id'>) | null, where: MsbuildFixWhere | null = null): MsbuildFix {
  const env = check && onOneProcessor(check.env) ? null : where ? where.env : check ? `checks.${check.id}.env` : "a check's env";
  if (!check) return { change: `pass -m:1 to every dotnet ${VERB_LIST} a check starts, ${RUN_CLAUSE}`, env };
  const field = where?.command ?? `checks.${check.id}.command`;
  const fixed = withOneNode(check);
  if (fixed) {
    // A check's `shell` sits beside its `command`; the dependency install has no shell form.
    const shellToo = fixed.shell && !check.shell && field.endsWith('.command') ? ` with ${field.slice(0, -'.command'.length)}.shell: true` : '';
    const why = fixed.run ? ' (dotnet run hands -m:1 to the program, so build with it first, with the same configuration and framework, and run without building)' : '';
    return { change: `${field}: ${shown(fixed.command)}${shellToo}${why}`, env };
  }
  const current = shown(check.command);
  const cut = current.length > MAX_SHOWN_CHARS ? `${current.slice(0, MAX_SHOWN_CHARS - 3)}...` : current;
  return { change: `pass -m:1 to every dotnet ${VERB_LIST} that ${field} (${cut}) starts, ${RUN_CLAUSE}`, env };
}

/**
 * Why, said once after any number of fixes: worker nodes cannot run in the sandbox, and DOTNET_PROCESSOR_COUNT=1 in the
 * env of each check that does not set it already works too, at a cost to the test host.
 */
export function msbuildFixReason(fixes: readonly MsbuildFix[]): string {
  const envs = [...new Set(fixes.flatMap((f) => (f.env ? [f.env] : [])))];
  const named = envs.length > 1 ? `${envs.slice(0, -1).join(', ')} and ${envs.at(-1)}` : envs[0];
  const alternative = named ? `; DOTNET_PROCESSOR_COUNT=1 in ${named} also works, but the test host then gets one processor too, where xunit before 2.8 deadlocks a test that blocks on async code` : '';
  return `(MSBuild worker nodes cannot run in the check sandbox: each binds a named pipe under /tmp, which the sandbox refuses${alternative}; docs/troubleshooting.md, ".NET builds and MSBuild worker nodes")`;
}

/** msbuildFix with its reason, for one command (the runner's note on a stopped check). */
export function msbuildNodeFix(check: (JudgedCheck & Pick<CheckDefinition, 'id'>) | null, where: MsbuildFixWhere | null = null): string {
  const fix = msbuildFix(check, where);
  return `${fix.change} ${msbuildFixReason([fix])}`;
}

/**
 * The node switches `orbit doctor`'s .NET build probe passes for a check, so doctor builds as the runner would: those
 * MSBuild gets from the dotnet commands the check runs that build (-m:1, -maxcpucount:1, a bare -m, or none; none
 * after the `--` of dotnet test, none of dotnet run), and -m:1, the fix doctor names, when it runs none it shows (make,
 * a script, dotnet format) or there is no check, since whether those pass it is what doctor cannot tell. The probe gets
 * the check's env too, so DOTNET_PROCESSOR_COUNT=1 there gives it one node as it gives the check.
 */
export function probeNodeSwitches(check: Pick<CheckDefinition, 'command' | 'shell'> | null): string[] {
  if (!check) return [ONE_NODE];
  const commands = commandsOf(check);
  if (commands === null) {
    const all = words(check.command);
    return all.some(isDotnet) ? [...new Set(nodeSwitches(all).map((s) => s.word))] : [ONE_NODE];
  }
  const builds = commands.filter((c) => isDotnet(c.argv[0] ?? '') && judgeDotnet(c.argv, false) !== null);
  if (builds.length === 0) return [ONE_NODE];
  return [...new Set(builds.flatMap((c) => (verbOf(c.argv) === 'run' ? [] : nodeSwitches(msbuildWords(c.argv, verbOf(c.argv)!)).map((s) => s.word))))];
}
