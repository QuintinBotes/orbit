import { lstatSync, readFileSync } from 'node:fs';
import { basename, dirname, join, posix, relative, isAbsolute } from 'node:path';
import type { CheckDefinition } from '../policy/types.ts';
import { chainOf, commandsOf, isDotnet, type JudgedCheck, msbuildFix, type MsbuildFix, msbuildFixReason, msbuildNodeFix, msbuildNodes, type MsbuildFixWhere, onOneProcessor, pasted, shellLine, shellWord, shown, simple, type Simple, verbOf, words } from './msbuild.ts';

/**
 * dotnet format under the check sandbox (issue #10; docs/decisions/0009-toolchain-profiles.md, addendum). Every form of
 * `dotnet format` but `dotnet format whitespace --folder` loads the project through Roslyn's MSBuildWorkspace, which
 * with SDK 9 and later evaluates it in a build host: a separate process that binds a named pipe its parent connects to.
 * Roslyn puts that pipe at /tmp/<guid> whatever TMPDIR says (its NamedPipeUtil, as MSBuild does /tmp/MSBuild<pid>),
 * which the sandbox refuses: Seatbelt denied the file-write-create of /tmp/<guid> (macOS, SDK 9.0.305), and the format
 * waited out the build host's 60 s connect timeout before failing with a TimeoutException; srt's seccomp filter refused
 * the socket (Linux, SDK 10.0.401), and it failed at once. Opening Unix sockets in the check's private temp directory
 * would not reach that path, and /tmp is shared by every process of the user, so nothing is opened: `orbit doctor`
 * fails such a check before any probe, with the form that loads no project, and the runner's records of the failure
 * read as the environment's (evidence/environment-failure.ts), never as a pre-existing failure. Its implicit restore is
 * a `dotnet restore` without -m:1, refused its MSBuild worker nodes when it has two projects to work on at once
 * (evidence/msbuild.ts), and no switch of dotnet format reaches it.
 *
 * SDK 8 evaluates the project in dotnet format's own process, so with a global.json that pins it (sdkFormatsInProcess)
 * only that implicit restore is refused. Measured under srt through the runner on macOS with SDK 8.0.303: a format of a
 * project with two references failed in about a second, its restore refused a worker node; a `dotnet restore -m:1`
 * first and `--no-restore` passed, and so did the plain form with DOTNET_PROCESSOR_COUNT=1 in the check's env.
 *
 * The folder form does not run everywhere either (review of #10). It lists every folder above the one it formats for
 * .editorconfig files (Roslyn's EditorConfigFinder, DirectoryInfo.GetFiles on each, a root = true file included), and a
 * run's checkout sits in <orbit home>/worktrees/<repo key>/<run>/, which the check profile read-denies but for the
 * checkout itself (isolation/profiles.ts checkoutBelowDenied). On macOS Seatbelt refuses the listing, and dotnet format
 * dies at once with "System.UnauthorizedAccessException: Access to the path '<orbit home>/worktrees/<key>/<run>' is
 * denied" (measured under the runner and srt 0.0.78 with SDK 9.0.305; it passed where nothing above the checkout was
 * denied); on Linux srt lays an empty tmpfs over a denied directory, which lists. So where the folder form cannot list
 * (`folderForm` false: macOS, a checkout below a denied directory), no form of dotnet format that SDK 9 and later run
 * works in the check sandbox, and the fix is to run it outside Orbit (formatOutsideFix); a format with SDK 8 pinned
 * keeps its own fix, a pinned restore first, which passed in such a run.
 */

/** The form of dotnet format that reads the files of a folder and loads no project, measured to run under srt. */
const FOLDER_FORM = ['format', 'whitespace', '--folder', '--verify-no-changes'];
const FOLDER_TEXT = `dotnet ${FOLDER_FORM.join(' ')}`;
/** Options after which dotnet format prints and loads nothing. */
const LOADS_NOTHING = new Set(['--version', '-h', '--help', '-?', '/?', '/h']);
const SUBCOMMANDS = new Set(['whitespace', 'style', 'analyzers']);
/** Options of dotnet format that take one value, and those that take every word up to the next option. */
const ONE_VALUE = new Set(['--severity', '-v', '--verbosity', '--binarylog', '--report']);
const MANY_VALUES = new Set(['--diagnostics', '--exclude-diagnostics', '--include', '--exclude']);
/** What the folder form keeps: which files it reads (--include, --exclude, --include-generated) and how it reports. */
const KEPT = new Set(['--include', '--exclude', '--include-generated', '-v', '--verbosity', '--binarylog', '--report']);
/** A workspace argument that names a solution or project file, whose folder whitespace --folder reads. */
const WORKSPACE_FILE = /\.(?:slnx?|slnf|csproj|fsproj|vbproj)$/i;
/** global.json rollForward values that may pick a later major SDK than the one it pins. */
const ROLLS_MAJOR = new Set(['major', 'latestmajor']);
/** Why the SDK 8 fix restores first, said with the fixed command. */
const RESTORE_FIRST = '(dotnet format passes no -m:1 to the restore it runs first, so restore with -m:1 first and format with --no-restore)';

/**
 * Why, said once after any number of fixes. The wait is the build host's connect timeout, measured on macOS with SDK 9;
 * on Linux the refusal is at once.
 */
export const DOTNET_FORMAT_REASON =
  '(dotnet format loads the project through a build host, a separate process whose named pipe .NET binds under /tmp, which the check sandbox refuses, so the check fails, on macOS only after a 60 s wait (SDK 9 and later; SDK 8, pinned by global.json, loads it in its own process); ' +
  `${FOLDER_TEXT} reads the files without loading the project and checks whitespace only, so run the style and analyzer checks (dotnet format --verify-no-changes) outside Orbit, in CI; ` +
  'docs/troubleshooting.md, "dotnet format under the sandbox")';

/**
 * Why, where the folder form cannot list the folders above the checkout (macOS, in a run's layout), said once after any
 * number of fixes.
 */
export const FORMAT_OUTSIDE_REASON =
  "(on macOS no form of dotnet format runs in a run's check sandbox with SDK 9 and later: every form but dotnet format whitespace --folder loads the project through a build host whose named pipe .NET binds under /tmp, which the sandbox refuses, and whitespace --folder lists every folder above the checkout for .editorconfig files, while the run's checkout sits in the Orbit home, which the sandbox does not let a check read; " +
  "with SDK 8 pinned by global.json, which loads the project in dotnet format's own process, a dotnet restore -m:1 first and dotnet format with --no-restore run; " +
  'docs/troubleshooting.md, "dotnet format under the sandbox")';

/**
 * The fix for a dotnet format check that cannot run in the check sandbox (FORMAT_OUTSIDE_REASON): run it outside Orbit.
 * For another command Orbit starts in such a sandbox (`where`: a release environment's deploy_command, say), dotnet
 * format comes out of that command.
 */
export function formatOutsideFix(check: Pick<CheckDefinition, 'id'>, where: MsbuildFixWhere | null = null): string {
  if (where) return `remove dotnet format from ${where.command} and run it in CI`;
  return `remove checks.${check.id} from .orbit/config.yaml, or set checks.${check.id}.mandatory: false, and run dotnet format in CI`;
}

export interface DotnetFormatUse {
  /** The dotnet format command as the check writes it, its program by its base name; "dotnet format" for a shell line doctor cannot split. */
  shown: string;
}

/** Whether a dotnet argv is `dotnet format` in a form that loads the project. */
function loadsProject(argv: readonly string[]): boolean {
  if (!isDotnet(argv[0] ?? '') || verbOf(argv) !== 'format') return false;
  const rest = argv.slice(argv.indexOf('format') + 1);
  if (rest.some((w) => LOADS_NOTHING.has(w))) return false;
  return !(rest.includes('whitespace') && rest.includes('--folder'));
}

/** Whether a dotnet argv is `dotnet format whitespace --folder`, which lists the folders above the one it formats. */
function readsFolder(argv: readonly string[]): boolean {
  if (!isDotnet(argv[0] ?? '') || verbOf(argv) !== 'format') return false;
  const rest = argv.slice(argv.indexOf('format') + 1);
  return !rest.some((w) => LOADS_NOTHING.has(w)) && rest.includes('whitespace') && rest.includes('--folder');
}

/** Whether a dotnet argv is `dotnet format` that loads the project and restores it first (no --no-restore). */
const restoresFirst = (argv: readonly string[]): boolean => loadsProject(argv) && !argv.includes('--no-restore');

/**
 * What a dotnet format command names: its workspace (the solution, project or folder it formats, null for the current
 * directory) and the options the folder form keeps, as written.
 */
function formatArgs(argv: readonly string[]): { workspace: string | null; kept: string[] } {
  const rest = argv.slice(argv.indexOf('format') + 1);
  let workspace: string | null = null;
  const kept: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i]!;
    const name = w.split(/[=:]/, 1)[0]!;
    const inline = name !== w;
    let end = i + 1;
    if (ONE_VALUE.has(name) && !inline) end = Math.min(i + 2, rest.length);
    else if (MANY_VALUES.has(name) && !inline) while (end < rest.length && !rest[end]!.startsWith('-')) end++;
    if (KEPT.has(name)) kept.push(...rest.slice(i, end));
    else if (!w.startsWith('-') && !SUBCOMMANDS.has(w)) workspace ??= w;
    i = end - 1;
  }
  return { workspace, kept };
}

/** A dotnet format argv as the folder form: the workspace's folder (a solution's or project's own), and the options it keeps. */
function folderArgs(argv: readonly string[]): string[] {
  const { workspace, kept } = formatArgs(argv);
  const folder = workspace !== null && WORKSPACE_FILE.test(workspace) ? posix.dirname(workspace) : workspace;
  return [argv[0]!, 'format', 'whitespace', ...(folder !== null && folder !== '.' ? [folder] : []), '--folder', '--verify-no-changes', ...kept];
}

/** A dotnet format argv that loads the project, restoring it first: a pinned restore of the same workspace, then the format with --no-restore. */
function restoreFirstArgs(argv: readonly string[]): { restore: string[]; format: string[] } {
  const { workspace } = formatArgs(argv);
  return { restore: [argv[0]!, 'restore', ...(workspace !== null ? [workspace] : []), '-m:1'], format: [...argv, '--no-restore'] };
}

const shownOf = (argv: readonly string[]): string => [basename(argv[0]!), ...argv.slice(1)].join(' ');

/**
 * The first dotnet format command of a check that loads the project, or null: its argv (through `env` too), or a
 * command of a shell line or `sh -c` script that is a chain of simple commands; for another shell line, its words. What
 * make or a script runs is not in the definition: the runner reads such a failure from its output instead.
 */
export function formatLoadsProject(check: JudgedCheck): DotnetFormatUse | null {
  const commands = commandsOf(check);
  if (commands !== null) {
    const found = commands.find((c) => loadsProject(c.argv));
    return found ? { shown: shownOf(found.argv) } : null;
  }
  const ws = words(check.command);
  for (let i = 0; i < ws.length; i++) {
    if (!isDotnet(ws[i]!) || verbOf(ws.slice(i)) !== 'format') continue;
    // The words of a line doctor cannot split run on to the next command; its first dotnet format decides.
    const next = ws.findIndex((w, j) => j > i && isDotnet(w));
    if (loadsProject(ws.slice(i, next < 0 ? undefined : next))) return { shown: 'dotnet format' };
  }
  return null;
}

/**
 * The first dotnet format command of a check in the folder form (whitespace --folder), or null; read as
 * formatLoadsProject reads a check.
 */
export function formatReadsFolder(check: JudgedCheck): DotnetFormatUse | null {
  const commands = commandsOf(check);
  if (commands !== null) {
    const found = commands.find((c) => readsFolder(c.argv));
    return found ? { shown: shownOf(found.argv) } : null;
  }
  const ws = words(check.command);
  for (let i = 0; i < ws.length; i++) {
    if (!isDotnet(ws[i]!) || verbOf(ws.slice(i)) !== 'format') continue;
    const next = ws.findIndex((w, j) => j > i && isDotnet(w));
    if (readsFolder(ws.slice(i, next < 0 ? undefined : next))) return { shown: 'dotnet format' };
  }
  return null;
}

/**
 * The first dotnet format command of a check that loads the project and restores it first, where its env does not give
 * MSBuild one node (DOTNET_PROCESSOR_COUNT=1), or null: what the sandbox refuses of a format with SDK 8, which loads
 * the project in its own process. Read as formatLoadsProject reads a check.
 */
export function formatRestoresUnpinned(check: JudgedCheck): DotnetFormatUse | null {
  if (onOneProcessor(check.env)) return null;
  const commands = commandsOf(check);
  if (commands !== null) {
    const found = commands.find((c) => restoresFirst(c.argv));
    return found ? { shown: shownOf(found.argv) } : null;
  }
  const ws = words(check.command);
  for (let i = 0; i < ws.length; i++) {
    if (!isDotnet(ws[i]!) || verbOf(ws.slice(i)) !== 'format') continue;
    const next = ws.findIndex((w, j) => j > i && isDotnet(w));
    if (restoresFirst(ws.slice(i, next < 0 ? undefined : next))) return { shown: 'dotnet format' };
  }
  return null;
}

/**
 * Whether the SDK a check in `dir` gets formats in dotnet format's own process: the nearest global.json from `dir` up to
 * `root` (the repository, or the run's checkout) pins SDK 8 or earlier, with a rollForward that keeps its major
 * version. Without such a file the SDK is whichever is newest, so the check is judged as SDK 9 and later.
 */
export function sdkFormatsInProcess(dir: string, root: string): boolean {
  const rel = relative(root, dir);
  if (rel.startsWith('..') || isAbsolute(rel)) return false;
  for (let at = dir; ; at = dirname(at)) {
    const text = readGlobalJson(join(at, 'global.json'));
    if (text !== null) return pinsInProcessSdk(text);
    if (at === root || dirname(at) === at) return false;
  }
}

function readGlobalJson(path: string): string | null {
  try {
    const st = lstatSync(path);
    return st.isFile() && st.size <= 64 * 1024 ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
}

/** Whether a global.json's text pins an SDK before 9 that cannot roll forward to another major version. JSON with comments, as dotnet reads it. */
function pinsInProcessSdk(text: string): boolean {
  try {
    const json = JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')) as { sdk?: { version?: unknown; rollForward?: unknown } };
    const version = json.sdk?.version;
    const roll = json.sdk?.rollForward;
    if (typeof version !== 'string' || (typeof roll === 'string' && ROLLS_MAJOR.has(roll.toLowerCase()))) return false;
    const major = Number(/^(\d+)\./.exec(version)?.[1]);
    return major > 0 && major < 9;
  } catch {
    return false;
  }
}

/** One command of a chain with a dotnet format that loads the project rewritten, spacing and the words in front kept. */
function rewriteIn(part: string, rewrite: (c: Simple) => string | null): string {
  const c: Simple = simple(part);
  const fixed = rewrite(c);
  if (fixed === null) return part;
  const lead = part.slice(0, part.length - part.trimStart().length);
  const trail = part.slice(part.trimEnd().length);
  return `${lead}${fixed}${trail}`;
}

/**
 * A check's command with each dotnet format rewritten, ready to paste: an argv's (after `env` and its assignments), as
 * an argv when `argvForm` gives one, else as a shell line; a chain's, or `sh -c`'s, in place. Null for a shell line
 * doctor cannot split. `shell`: whether the result is a shell line where the check's command was not.
 */
function rewritten(check: JudgedCheck, argvForm: (argv: readonly string[]) => string[] | null, lineForm: (c: Simple, quote: boolean) => string | null): { command: string[]; shell: boolean } | null {
  const line = shellLine(check);
  if (line !== null) {
    const chain = chainOf(line);
    if (!chain) return null;
    const fixed = chain.parts.map((p) => rewriteIn(p, (c) => lineForm(c, false))).map((p, i) => p + (chain.separators[i] ?? '')).join('');
    return { command: check.shell ? [fixed] : [...check.command.slice(0, 2), fixed, ...check.command.slice(3)], shell: false };
  }
  const [c] = commandsOf(check) ?? [];
  if (!c) return null;
  const argv = argvForm(c.argv);
  if (argv !== null) return { command: [...c.prefix, ...argv], shell: false };
  const text = lineForm(c, true);
  return text === null ? null : { command: [text], shell: true };
}

/** A check with each dotnet format that loads the project in the folder form. */
const withFolderForm = (check: JudgedCheck) =>
  rewritten(
    check,
    (argv) => (loadsProject(argv) ? folderArgs(argv) : [...argv]),
    (c) => (loadsProject(c.argv) ? [...c.prefix, ...folderArgs(c.argv)].join(' ') : null),
  );

/** A check with each dotnet format that restores first preceded by a pinned restore and given --no-restore (SDK 8). */
const withRestoreFirst = (check: JudgedCheck) =>
  rewritten(
    check,
    (argv) => (restoresFirst(argv) ? null : [...argv]),
    (c, quote) => {
      if (!restoresFirst(c.argv)) return null;
      const { restore, format } = restoreFirstArgs(c.argv);
      const w = (ws: readonly string[]) => (quote ? ws.map(shellWord) : ws);
      return [...w(c.prefix), ...w(restore), '&&', ...w(c.prefix), ...w(format)].join(' ');
    },
  );

/**
 * The fix for a check whose dotnet format loads the project, without the reason (DOTNET_FORMAT_REASON): its command
 * with the folder form in place of each such dotnet format, ready to paste (an argv keeps its program and what `env`
 * sets; a chain, or `sh -c`, is rewritten in place), or, for a shell line doctor cannot split, the form to run instead.
 * The folder form reads the folder of the solution or project the check formats, with its --include and --exclude.
 * `where` names another field than the check's command (a release environment's deploy_command, say).
 */
export function dotnetFormatFix(check: JudgedCheck & Pick<CheckDefinition, 'id'>, where: MsbuildFixWhere | null = null): string {
  const field = where?.command ?? `checks.${check.id}.command`;
  const fixed = withFolderForm(check);
  return fixed ? pasted(field, fixed.command, fixed.shell && !check.shell) : `in ${field}, run "${FOLDER_TEXT}" in place of its dotnet format command`;
}

/**
 * The fix for a check that runs MSBuild without -m:1 and a dotnet format that loads the project (SDK 9 and later): one
 * command with both changes, the folder form and -m:1, as an MSBuild fix; its reason is both msbuildFixReason and
 * DOTNET_FORMAT_REASON.
 */
export function formatAndNodeFix(check: JudgedCheck & Pick<CheckDefinition, 'id'>, where: MsbuildFixWhere | null): MsbuildFix {
  const fixed = withFolderForm(check);
  return msbuildFix(fixed ? { ...check, command: fixed.command } : check, where);
}

/**
 * The fix for a check whose dotnet format restores the project on MSBuild worker nodes, with SDK 8 (which loads the
 * project in its own process): a `dotnet restore <workspace> -m:1` before each such format, which gets --no-restore,
 * and -m:1 on the check's other dotnet builds; its reason is msbuildFixReason, since DOTNET_PROCESSOR_COUNT=1 in the
 * check's env works too (measured).
 */
export function formatRestoreFix(check: JudgedCheck & Pick<CheckDefinition, 'id'>, where: MsbuildFixWhere | null): MsbuildFix {
  const fixed = withRestoreFirst(check);
  if (fixed?.shell) {
    // An argv, now a shell line of its own restore, pinned, and its format: nothing else to pin, and its words quoted.
    const field = where?.command ?? `checks.${check.id}.command`;
    return { change: `${pasted(field, fixed.command, true)} ${RESTORE_FIRST}`, env: msbuildFix(check, where).env };
  }
  const fix = msbuildFix(fixed ? { ...check, command: fixed.command } : check, where);
  return { ...fix, change: `${fix.change} ${RESTORE_FIRST}` };
}

/**
 * The fix the runner names for a check it stopped because the sandbox refused an MSBuild worker node. For a check whose
 * dotnet format loads the project: with SDK 8 (`inProcess`), a pinned restore first and --no-restore; else the folder
 * form, which restores nothing, with -m:1 on the check's other builds and both reasons when one is unpinned, or, where
 * the folder form cannot list the folders above the checkout (`folderForm` false), running dotnet format outside Orbit,
 * with -m:1 on the check's builds when one is unpinned. For any other check, -m:1 on its dotnet commands that build, or
 * on every MSBuild call it starts (msbuildNodeFix).
 */
export function nodeDenialFix(check: JudgedCheck & Pick<CheckDefinition, 'id'>, where: MsbuildFixWhere | null, inProcess = false, folderForm = true): string {
  if (where || !formatLoadsProject(check)) return msbuildNodeFix(check, where);
  if (inProcess) {
    const fix = formatRestoreFix(check, where);
    return `${fix.change} ${msbuildFixReason([fix])}`;
  }
  if (!folderForm) {
    const nodes = msbuildNodes(check, true)?.kind === 'unpinned' ? msbuildFix(check, where) : null;
    return `${nodes ? `${nodes.change} ${msbuildFixReason([nodes])}; ` : ''}${formatOutsideFix(check)} ${FORMAT_OUTSIDE_REASON}`;
  }
  if (msbuildNodes(check, true)?.kind !== 'unpinned') return `${dotnetFormatFix(check)} ${DOTNET_FORMAT_REASON}`;
  const fix = formatAndNodeFix(check, where);
  return `${fix.change} ${msbuildFixReason([fix])} ${DOTNET_FORMAT_REASON}`;
}

/**
 * dotnet format's own report of a project it could not load: it catches MSBuildWorkspace's error and says the project's
 * language is unsupported, of a C# or Visual Basic project file, and exits 0. Measured under the runner and srt on Linux
 * (arm64 Ubuntu 24.04, SDK 10.0.401, verbosity diagnostic included): with the build host's pipe refused, `dotnet format
 * --verify-no-changes --no-restore` of a console project failed with the build host's unhandled exception in most runs,
 * and in 8 of 40 (more often with other tests running beside it) printed "Could not format '<checkout>/acme.csproj'.
 * Format currently supports only C# and Visual Basic projects." and exited 0, having loaded no project and checked
 * nothing (CI of #26 found it as a pass).
 */
const LOADED_NO_PROJECT = /^\s*Could not format '[^'\r\n]+\.(?:cs|vb)proj'\. Format currently supports only C# and Visual Basic projects\.\s*$/m;

/** Whether a check's output shows a dotnet format that loaded no project of the C# or Visual Basic project file it named. */
export function formatLoadedNoProject(output: string): boolean {
  return LOADED_NO_PROJECT.test(output);
}

/**
 * The note on a check the runner records as FAILED although it exited 0: its dotnet format loaded no project
 * (formatLoadedNoProject) because the check sandbox refused the build host's pipe, so it checked nothing. PREFLIGHT reads
 * it as the environment's failure (evidence/environment-failure.ts, pipe-denied), as it reads the build host's crash.
 */
export function buildHostDenialNote(fix: string): string {
  return `the check sandbox denied dotnet format's build host its named pipe under /tmp, so dotnet format loaded no project and checked nothing, though it exited 0 (it reports a project it could not load as "Format currently supports only C# and Visual Basic projects"). Fix: ${fix}`;
}

/**
 * The fix for a check whose dotnet format could not reach its build host: the form that loads no project, or, where that
 * form cannot list the folders above the checkout (`folderForm` false: macOS, a run's checkout), running it outside Orbit.
 */
export function buildHostFix(check: JudgedCheck & Pick<CheckDefinition, 'id'>, where: MsbuildFixWhere | null, folderForm = true): string {
  return folderForm ? `${dotnetFormatFix(check, where)} ${DOTNET_FORMAT_REASON}` : `${formatOutsideFix(check, where)} ${FORMAT_OUTSIDE_REASON}`;
}
