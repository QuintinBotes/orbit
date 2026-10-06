/**
 * `orbit doctor`'s checks.sandbox (issue #10): every configured command check's executable, started inside the sandbox
 * the check would get, with a harmless argument. A tool the sandbox refuses at start (the .NET SDK asking for
 * /tmp/.dotnet on its first run, say) then shows here, before any run, instead of as a failure of the base revision.
 *
 * Only executables outside the repository are started (an installed tool: dotnet, node, npm, make...): the
 * repository's own scripts are its code, which only a run executes. The profile is the check's own, built from the
 * configuration (its hosts, every credential read-denied, the repository denied), with an empty scratch checkout, a
 * private HOME prepared as a run prepares it, and the environment a check gets, its toolchains' included
 * (docs/decisions/0009-toolchain-profiles.md). Nothing is written outside the scratch directory, which is removed
 * afterwards.
 *
 * With the Orbit home known, each toolchain the checks or the repository use is started too, in the sandbox of the check
 * that uses it, and its line says where the repository's dependency caches live. An existing cache is mounted
 * read-only, as a check gets it; one that does not exist yet is replaced by an empty stand-in in the scratch directory,
 * so doctor never creates it. Starting a tool can prove too little: `dotnet help` ran where every build of two projects
 * was refused an MSBuild worker node (#10, reopened), so the .NET line builds three generated projects instead
 * (isolation/toolchains.ts DOTNET_PROBE_PROJECT), with the node switch of the check whose sandbox it uses, stopped early
 * once MSBuild records a refused node.
 *
 * Before any probe, each check's command (and the dependency install's) is judged as MSBuild would run it
 * (evidence/msbuild.ts): one that runs a dotnet build, test, publish, pack, restore, msbuild or run itself (an argv, or
 * a command of a chain) without -m:1, and without DOTNET_PROCESSOR_COUNT=1 in its own env, is refused and not started,
 * with its command fixed; one that may run MSBuild through make, a script or a shell line with a pipe is a warning,
 * since no definition shows whether those pass -m:1. A check that runs dotnet format in a form that loads the project
 * (every form but `dotnet format whitespace --folder`) is refused too, with that form as its fix: the build host it
 * loads the project with binds its named pipe under /tmp, which the sandbox refuses (evidence/dotnet-format.ts). With
 * SDK 8, pinned by a global.json, dotnet format loads the project in its own process, so only a format that restores
 * first (no --no-restore, and no DOTNET_PROCESSOR_COUNT=1) is refused, with a pinned restore first as its fix. A check
 * refused for both, a build without -m:1 and a format, gets one fixed command with both changes.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { execCapture } from '../../core/exec.ts';
import { OrbitError } from '../../core/errors.ts';
import { redact } from '../../core/redact.ts';
import { environmentFix } from '../../controller/environment-block.ts';
import { DOTNET_FORMAT_REASON, dotnetFormatFix, formatAndNodeFix, formatLoadsProject, formatRestoreFix, formatRestoresUnpinned, sdkFormatsInProcess } from '../../evidence/dotnet-format.ts';
import { classifyCouldNotRun, classifyNotExecuted, type EnvironmentFailure } from '../../evidence/environment-failure.ts';
import { findMsbuildNodeDenial, msbuildFix, msbuildFixReason, msbuildNodeDenialText, msbuildNodes, probeNodeSwitches, type MsbuildFix, type MsbuildFixWhere, type MsbuildNodeDenial } from '../../evidence/msbuild.ts';
import { checkEnv, INSTALL_CHECK_ID, prepareCheckHome } from '../../evidence/runner.ts';
import { prepareWorkerTmpDir, profileForCheck } from '../../isolation/profiles.ts';
import { detectToolchains, removeScratch, TOOLCHAIN_PROFILES, toolchainCacheRoot, toolchainLayout, type ToolchainId } from '../../isolation/toolchains.ts';
import type { IsolationProvider } from '../../isolation/types.ts';
import { isWithin, which } from '../../isolation/util.ts';
import { defaultCheck } from '../../policy/config.ts';
import type { CheckDefinition, OrbitConfig, PolicySnapshot } from '../../policy/types.ts';
import { repoKeyFor } from '../../storage/retention.ts';
import { oneLine } from '../io.ts';
import type { DoctorCheck } from './doctor.ts';

/**
 * Runs a wrapped command and reports how it ended; the real one is execCapture, tests pass their own. `stop`, polled
 * while the command runs, ends it early once it returns true: the sandbox denied something the tool would wait out.
 */
export type ProbeLaunch = (argv: string[], opts: { cwd: string; env: Record<string, string>; timeoutMs: number; stop?: () => boolean }) => Promise<{ exitCode: number | null; output: string }>;

const STOP_POLL_MS = 500;

const launchWrapped: ProbeLaunch = async (argv, opts) => {
  const abort = new AbortController();
  const poll = opts.stop ? setInterval(() => opts.stop!() && abort.abort(), STOP_POLL_MS) : null;
  try {
    const r = await execCapture(argv, { cwd: opts.cwd, env: opts.env, timeoutMs: opts.timeoutMs, maxOutputBytes: 256 * 1024, abortSignal: abort.signal });
    return { exitCode: r.timedOut || r.cancelled ? null : r.exitCode, output: `${r.stdout}\n${r.stderr}`.trim() };
  } finally {
    if (poll) clearInterval(poll);
  }
};

const PROBE_TIMEOUT_MS = 60_000;
/** A probe that builds a generated project: a cold restore and build on a slow host, with room to spare. */
const BUILD_PROBE_TIMEOUT_MS = 180_000;

/**
 * The harmless argument each tool is started with: its version, unless that skips what the sandbox refuses. `dotnet
 * --version` and `--info` skip the SDK's first-run steps, where the sandbox stopped it, and `dotnet help` runs them and
 * prints the help; `go` has no `--version`.
 */
export const PROBE_ARGS: Readonly<Record<string, readonly string[]>> = { dotnet: ['help'], go: ['version'] };
const DEFAULT_PROBE_ARGS: readonly string[] = ['--version'];

const SHELL_BUILTINS = new Set(['cd', 'export', 'set', 'test', '[', 'true', 'false', 'echo', 'exit', 'exec', ':', 'source', '.', 'eval', 'unset']);

/** The word a check runs: its command, or a shell script's first word that is not an assignment. */
function checkWord(check: CheckDefinition): string | null {
  if (!check.shell) return check.command[0] ?? null;
  return (check.command[0] ?? '').trim().split(/\s+/).find((w) => w !== '' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) ?? null;
}

export interface CheckSandboxInput {
  config: OrbitConfig;
  repo: string | null;
  provider: IsolationProvider | null;
  available: boolean;
  env: Readonly<Record<string, string | undefined>>;
  /** The account's home directory: what the profile hides is computed from it. */
  homeDir: string;
  /** The Orbit home: where the repository's toolchain caches live. Without it no toolchain line is reported. */
  orbitHome?: string;
  launch?: ProbeLaunch;
  /** The host's platform, for what the .NET line says of NuGet on macOS; process.platform unless a test says otherwise. */
  platform?: NodeJS.Platform;
  /** Whether the repository's tracked files show NuGet packages (doctor-dotnet.ts hasNugetPackages), for the same line. */
  nugetPackages?: boolean;
}

/**
 * How one probe went, without the label of what was probed (a check id, or "toolchain go"). A refusal may carry its own
 * fix, when Orbit knows the setting that makes the check runnable; one of MSBuild worker nodes carries the fix for its
 * command (`msbuild`), whose reason doctor gives once for every such fix (msbuildFixReason).
 */
type Refusal = { kind: 'refused'; detail: string; failure: EnvironmentFailure; fix?: string; msbuild?: MsbuildFix };
type Outcome = { kind: 'ran'; detail: string } | Refusal;

/** What a probe starts beyond the executable: the files of a generated project to put in its checkout, and what they are. */
interface ProbeProject {
  files: Readonly<Record<string, string>>;
  about: string;
}

/** A denial MSBuild recorded in a probe's private temp directory, as a refusal with its fix. */
function msbuildRefusal(checkId: string, shown: string, d: MsbuildNodeDenial, msbuild: MsbuildFix): Refusal {
  const text = msbuildNodeDenialText(d);
  return { kind: 'refused', detail: `"${shown}" was refused in the sandbox: ${text}`, failure: { checkId, fingerprint: null, signals: ['sandbox-violation'], cause: text, lines: [d.exception] }, msbuild };
}

/**
 * The repository's cache root for the probe: the real one when every cache the probe's toolchains use already exists
 * (mounted read-only, never written), else an empty stand-in in the scratch directory; null without an Orbit home.
 */
function probeCacheRoot(input: CheckSandboxInput, toolchains: readonly ToolchainId[], scratch: string): string | null {
  if (!input.orbitHome || !input.repo) return null;
  const real = toolchainCacheRoot(input.orbitHome, repoKeyFor(input.repo));
  const all = toolchains.every((id) => TOOLCHAIN_PROFILES[id].caches.every((c) => existsSync(join(real, c))));
  return all ? real : join(scratch, 'cache-stand-in');
}

/**
 * One probe in a scratch directory of its own. `cwd` is the check's directory in the repository, for its markers;
 * `project`, a generated project the probe's checkout holds; `nodeFix`, the fix to name when MSBuild records a refused
 * worker node (the check's command with -m:1).
 */
async function probe(input: CheckSandboxInput & { provider: IsolationProvider }, check: CheckDefinition, exe: string, args: readonly string[], cwd: string | null, project: ProbeProject | null, nodeFix: MsbuildFix): Promise<Outcome> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-doctor-check-')));
  let tmp: string | null = null;
  try {
    const checkout = join(scratch, 'checkout');
    const home = join(scratch, 'home');
    const artifacts = join(scratch, 'artifacts');
    for (const d of [checkout, home, artifacts]) mkdirSync(d, { recursive: true, mode: 0o700 });
    for (const [rel, text] of Object.entries(project?.files ?? {})) {
      mkdirSync(dirname(join(checkout, rel)), { recursive: true, mode: 0o700 });
      writeFileSync(join(checkout, rel), text, { mode: 0o600 });
    }
    prepareCheckHome(home);
    tmp = prepareWorkerTmpDir(scratch);
    const snapshot: PolicySnapshot = { schema: 'orbit.policy/1', run_id: 'doctor', created_at: '', repo_root: input.repo ?? scratch, config: input.config, effective_protected_paths: [], check_config_hashes: {} };
    const ids = detectToolchains({ command: check.command, shell: check.shell, roots: [...(input.repo ? [input.repo] : []), ...(cwd ? [cwd] : [])] });
    const toolchains = toolchainLayout({ toolchains: ids, mode: 'check', cacheRoot: probeCacheRoot(input, ids, scratch), scratchRoot: join(scratch, 'toolchains'), tmpDir: tmp, hostHome: input.homeDir, hostEnv: input.env });
    // Only what is missing is created: an existing cache is the repository's and stays untouched.
    for (const d of toolchains.directories) if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
    const profile = profileForCheck({ worktree: checkout, check, snapshot, extraWritable: [artifacts, home, tmp, ...toolchains.writable], readablePaths: toolchains.readOnly, nisDomainName: toolchains.nisDomainName, homeDir: input.homeDir, env: { ...input.env } });
    const env = checkEnv(check, { homeDir: home, tmpDir: tmp, artifactsDir: artifacts }, input.env.PATH, toolchains.env);
    const shown = [basename(exe), ...args].join(' ');
    const wrapped = input.provider.wrap([exe, ...args], profile, { cwd: checkout, env });
    // MSBuild records a worker node the sandbox denied its pipe in the probe's temp directory, then waits minutes.
    const probeTmp = tmp;
    const denied = () => findMsbuildNodeDenial(probeTmp);
    let r: { exitCode: number | null; output: string };
    try {
      r = await (input.launch ?? launchWrapped)(wrapped.argv, { cwd: checkout, env: wrapped.env, timeoutMs: project ? BUILD_PROBE_TIMEOUT_MS : PROBE_TIMEOUT_MS, stop: () => denied() !== null });
    } finally {
      wrapped.cleanup();
    }
    const denial = denied();
    if (denial) return msbuildRefusal(check.id, shown, denial, nodeFix);
    if (r.exitCode === 0) return { kind: 'ran', detail: `"${shown}" ran in the sandbox${project ? ` (${project.about})` : ''}` };
    const output = redact(r.output);
    const ended = r.exitCode === null ? 'timed out' : `exited ${r.exitCode}`;
    // On Linux the sandbox refuses a worker node's socket so early that MSBuild may fail before the node records it. A
    // probe on one processor (DOTNET_PROCESSOR_COUNT=1 in the check's env) builds on one node, so its failure is another.
    const nodes = project ? msbuildNodes({ command: [exe, ...args], shell: false, env: check.env }, true) : null;
    if (nodes?.kind === 'unpinned') {
      const cause = `${nodes.reason}, and the build failed (${ended}) with no record of which node was refused`;
      return { kind: 'refused', detail: `"${shown}" was refused in the sandbox: ${cause}`, failure: { checkId: check.id, fingerprint: null, signals: ['sandbox-violation'], cause, lines: [oneLine(output, 160)] }, msbuild: nodeFix };
    }
    const failure = classifyNotExecuted({ checkId: check.id, output }) ?? classifyCouldNotRun({ checkId: check.id, output, insideRoots: [scratch, ...(tmp ? [tmp] : [])] });
    if (failure) return { kind: 'refused', failure, detail: `"${shown}" was refused in the sandbox: ${failure.cause}${failure.lines[0] ? ` (${JSON.stringify(failure.lines[0])})` : ''}` };
    // A generated project builds offline from the toolchain alone, so its failure is the sandbox's or the installation's.
    if (project) {
      const cause = `the generated project did not build (${ended})`;
      return {
        kind: 'refused',
        detail: `"${shown}" ${ended} in the sandbox: ${project.about.split(':')[0]} did not build${output ? `: ${oneLine(output, 160)}` : ''}`,
        failure: { checkId: check.id, fingerprint: null, signals: ['start-failed'], cause, lines: output ? [oneLine(output, 160)] : [] },
        fix: `the generated project needs nothing but the toolchain, so build it outside the sandbox to tell a broken installation from a sandbox denial (the line above shows the output; docs/troubleshooting.md, "A check cannot run in the sandbox")`,
      };
    }
    return { kind: 'ran', detail: `"${shown}" ${ended} in the sandbox, with no sandbox denial in its output${output ? `: ${oneLine(output, 160)}` : ''}` };
  } finally {
    removeScratch(scratch);
    if (tmp) removeScratch(tmp);
  }
}

/** checks.sandbox: each command check's executable started in its sandbox, a denial reported before any run. */
export async function checkSandboxCheck(input: CheckSandboxInput): Promise<DoctorCheck> {
  const id = 'checks.sandbox';
  const result = (status: DoctorCheck['status'], summary: string, details: string[] = [], missing: string | null = null, fix: string | null = null): DoctorCheck => ({ id, area: 'checks', status, summary, details, missing, fix });
  const checks = Object.values(input.config.checks).filter((c) => c.kind === 'command');
  if (checks.length === 0) return result('pass', 'not needed: no command check is defined');
  const provider = input.provider;
  if (!provider || !input.available) return result('warn', 'not checked: isolation is unavailable (see the isolation check)', [], 'an available isolation provider');
  if (provider.kind !== 'sandbox-runtime') return result('pass', `not needed: checks run under ${provider.kind}, not in an OS sandbox on this host`);

  const repo = input.repo ? realpathSync(input.repo) : null;
  const probeInput = { ...input, repo, provider };
  const details: string[] = [];
  // `label`: what the summary calls it when it is not a check (the dependency install's command). `format`: the fix of a
  // dotnet format that loads the project, whose reason doctor gives once; `formatReason`: an MSBuild fix that also puts
  // such a format in the folder form, so that reason is given too.
  const refused: { check: CheckDefinition; failure: EnvironmentFailure; fix?: string; msbuild?: MsbuildFix; format?: string; formatReason?: boolean; label?: string }[] = [];
  // Checks whose MSBuild calls no definition shows (make, a script, a shell line): a warning with the fix.
  const undetermined: { check: CheckDefinition; msbuild: MsbuildFix; label?: string }[] = [];
  let started = 0;
  const used = new Set<ToolchainId>(repo ? detectToolchains({ roots: [repo] }) : []);
  // The checks that get each toolchain's profile, found as the runner finds them (their command, the checkout root and their cwd).
  const users = new Map<ToolchainId, CheckDefinition[]>();
  /**
   * Doctor's static rules (evidence/msbuild.ts, evidence/dotnet-format.ts): a command that runs MSBuild itself without
   * -m:1 is refused before any probe, since no probe of a single tool shows the denial and its build would wait out
   * MSBuild's node retries; one that may run MSBuild through something else is noted; a check that runs dotnet format in
   * a form that loads the project is refused, since its build host's pipe under /tmp is refused whatever the check
   * does. True when the command was refused.
   */
  const judge = (check: CheckDefinition, usesDotnet: boolean, label: string | null = null, where: MsbuildFixWhere | null = null): boolean => {
    const nodes = msbuildNodes(check, usesDotnet);
    const named = label ? { label } : {};
    const id = label ?? check.id;
    // A dotnet format that loads the project: SDK 8 (pinned by global.json) loads it in its own process, so only its
    // implicit restore's worker nodes are refused; SDK 9 and later load it through the build host the sandbox refuses.
    const loads = label ? null : formatLoadsProject(check);
    const inProcess = loads !== null && repo !== null && sdkFormatsInProcess(resolve(repo, check.cwd), repo);
    const restore = inProcess ? formatRestoresUnpinned(check) : null;
    const host = inProcess || !loads ? null : `runs "${loads.shown}", which loads the project through a build host whose named pipe .NET binds under /tmp`;
    if (nodes?.kind === 'unpinned' || restore) {
      // One fix for all of it, so the pasted command is not refused again for what it did not fix.
      const causes = [...(nodes?.kind === 'unpinned' ? [nodes.reason] : []), ...(restore ? [`runs "${restore.shown}", which restores the project first with a worker node per processor (SDK 8, which global.json pins, loads the project in its own process)`] : [])];
      for (const cause of causes) details.push(`${id}: ${cause}, and the check sandbox refuses every MSBuild worker node its named pipe under /tmp`);
      if (host) details.push(`${id}: ${host}, and the check sandbox refuses it`);
      const msbuild = restore ? formatRestoreFix(check, where) : host ? formatAndNodeFix(check, where) : msbuildFix(check, where);
      refused.push({ check, failure: { checkId: check.id, fingerprint: null, signals: host ? ['sandbox-violation', 'pipe-denied'] : ['sandbox-violation'], cause: causes[0]!, lines: [...causes, ...(host ? [host] : [])] }, msbuild, ...(host ? { formatReason: true } : {}), ...named });
      return true;
    }
    if (nodes?.kind === 'indirect') {
      details.push(`${id}: ${nodes.reason}`);
      undetermined.push({ check, msbuild: msbuildFix(check, where), ...named });
    }
    if (host) {
      details.push(`${check.id}: ${host}, and the check sandbox refuses it`);
      refused.push({ check, failure: { checkId: check.id, fingerprint: null, signals: ['pipe-denied'], cause: host, lines: [host] }, format: dotnetFormatFix(check) });
      return true;
    }
    return false;
  };
  for (const check of checks) {
    const ids = detectToolchains({ command: check.command, shell: check.shell, roots: repo ? [repo, resolve(repo, check.cwd)] : [] });
    if (repo) {
      for (const id of ids) {
        used.add(id);
        users.set(id, [...(users.get(id) ?? []), check]);
      }
    }
    if (judge(check, ids.includes('dotnet'))) continue;
    const word = checkWord(check);
    if (!word || (check.shell && SHELL_BUILTINS.has(word))) {
      details.push(`${check.id}: not started (${word ? `shell builtin "${word}"` : 'no command'})`);
      continue;
    }
    const cwd = repo ? resolve(repo, check.cwd) : process.cwd();
    const found = word.includes('/') ? which(isAbsolute(word) ? word : resolve(cwd, word), input.env.PATH) : which(word, input.env.PATH);
    if (!found) {
      details.push(`${check.id}: not started ("${word}" was not found; see the checks entry)`);
      continue;
    }
    const exe = launchPath(found, repo);
    if (!exe) {
      details.push(`${check.id}: not started ("${word}" is the repository's own code, which only a run executes)`);
      continue;
    }
    started++;
    const out = await probeOrRefuse(probeInput, check, exe, PROBE_ARGS[basename(exe)] ?? DEFAULT_PROBE_ARGS, repo ? resolve(repo, check.cwd) : null, null, msbuildFix(check));
    details.push(`${check.id}: ${out.detail}`);
    if (out.kind === 'refused') refused.push({ check, failure: out.failure, ...(out.fix ? { fix: out.fix } : {}), ...(out.msbuild ? { msbuild: out.msbuild } : {}) });
  }
  // The dependency install runs MSBuild too when it restores a .NET repository (`dotnet restore`), in the same sandbox.
  const deps = input.config.dependencies;
  if (deps.install_existing_lockfile && deps.install_command) {
    const install: CheckDefinition = { ...defaultCheck(INSTALL_CHECK_ID), command: [...deps.install_command], shell: false, mandatory: true };
    judge(install, detectToolchains({ command: install.command, roots: repo ? [repo] : [] }).includes('dotnet'), 'dependencies.install_command', { command: 'dependencies.install_command', env: null });
  }
  const refusedToolchains: { id: ToolchainId; failure: EnvironmentFailure; fix?: string; msbuild?: MsbuildFix; mandatory: boolean }[] = [];
  if (repo && input.orbitHome) {
    for (const id of [...used].sort()) {
      const base = baseCheck(id, users.get(id) ?? []);
      const line = await toolchainLine({ ...probeInput, repo }, input.orbitHome, id, base);
      details.push(line.detail);
      // A refused toolchain fails doctor when a mandatory check runs the toolchain's executable itself; a check that
      // only sits in a repository with its marker files may never start it.
      if (line.refusal) refusedToolchains.push({ id, failure: line.refusal.failure, ...(line.refusal.fix ? { fix: line.refusal.fix } : {}), ...(line.refusal.msbuild ? { msbuild: line.refusal.msbuild } : {}), mandatory: base !== null && base.mandatory && runsToolchain(base, id) });
    }
  }
  /**
   * Every MSBuild fix first, each command once, with their shared reason once; then the dotnet format fixes alike; then
   * the other fixes. An MSBuild fix that also puts a dotnet format in the folder form gets the format's reason too, once.
   */
  const fixFor = (items: readonly { failure: EnvironmentFailure; fix?: string; msbuild?: MsbuildFix; format?: string; formatReason?: boolean }[]): string => {
    const nodes = [...items.flatMap((i) => (i.msbuild ? [i.msbuild] : [])), ...undetermined.map((u) => u.msbuild)];
    const changes = [...new Set(nodes.map((n) => n.change))];
    const formats = [...new Set(items.flatMap((i) => (i.format ? [i.format] : [])))];
    const formatReason = formats.length === 0 && items.some((i) => i.formatReason) ? ` ${DOTNET_FORMAT_REASON}` : '';
    const msbuild = changes.length > 0 ? [`${changes.join('; ')} ${msbuildFixReason(nodes)}${formatReason}`] : [];
    const format = formats.length > 0 ? [`${formats.join('; ')} ${DOTNET_FORMAT_REASON}`] : [];
    const own = [...new Set(items.flatMap((i) => (i.fix ? [i.fix] : [])))];
    const rest = items.filter((i) => !i.fix && !i.msbuild && !i.format).map((i) => i.failure);
    const generic = rest.length > 0 ? (environmentFix(rest) ?? 'see the line above and docs/troubleshooting.md, "A check cannot run in the sandbox"') : null;
    return [...msbuild, ...format, ...own, ...(generic ? [generic] : [])].join('; ');
  };
  /** "check a", "checks a, b", "dependencies.install_command", "check a and dependencies.install_command". */
  const subject = (items: readonly { check: CheckDefinition; label?: string }[]): string => {
    const ids = items.filter((i) => !i.label).map((i) => i.check.id);
    return [...(ids.length > 0 ? [`${ids.length === 1 ? 'check' : 'checks'} ${ids.join(', ')}`] : []), ...items.flatMap((i) => (i.label ? [i.label] : []))].join(' and ');
  };
  if (refused.length === 0 && refusedToolchains.length === 0) {
    if (undetermined.length > 0) {
      return result(
        'warn',
        `doctor cannot tell whether ${subject(undetermined)} ${undetermined.length === 1 ? 'runs' : 'run'} MSBuild on one node; one that does not is stopped as soon as MSBuild records the refused node`,
        details,
        'dotnet commands that pin one MSBuild node (-m:1)',
        fixFor([]),
      );
    }
    return result('pass', started === 0 ? 'no check executable outside the repository to start' : `${started} check executable(s) start in the sandbox`, details);
  }
  if (refused.length === 0) {
    const names = refusedToolchains.map((r) => r.id);
    const listed = names.length === 1 ? `the ${names[0]} toolchain` : `the ${names.slice(0, -1).join(', ')} and ${names.at(-1)} toolchains`;
    const status = refusedToolchains.some((r) => r.mandatory) ? 'fail' : 'warn';
    return result(status, `the sandbox refuses ${listed}; checks that use ${names.length === 1 ? 'it' : 'them'} would block at their baseline`, details, 'a toolchain that can start in the check sandbox', fixFor(refusedToolchains));
  }
  const status = refused.some((r) => r.check.mandatory) || refusedToolchains.some((r) => r.mandatory) ? 'fail' : 'warn';
  // What the sandbox refuses: MSBuild's worker nodes, dotnet format's build host, or both, when that is all it refuses
  // the checks, else their executables.
  const nodes = refused.every((r) => r.msbuild && !r.formatReason);
  const formats = refused.every((r) => r.format);
  const pipes = refused.every((r) => r.msbuild || r.format);
  const one = 'dotnet commands that pin one MSBuild node (-m:1)';
  const loadsNothing = 'dotnet format checks that load no project (dotnet format whitespace --folder)';
  return result(
    status,
    nodes
      ? `${subject(refused)} would start MSBuild worker nodes, which the sandbox refuses; a run would block at its baseline`
      : formats
        ? `${subject(refused)} ${refused.length === 1 ? 'runs' : 'run'} dotnet format, which loads the project through a build host the sandbox refuses its named pipe; a run would block at its baseline`
        : pipes
          ? `${subject(refused)} would start MSBuild worker nodes or dotnet format's build host, whose named pipes the sandbox refuses; a run would block at its baseline`
          : `the sandbox refuses ${refused.length === 1 ? 'the executable' : 'the executables'} of ${subject(refused)}; a run would block at its baseline`,
    details,
    nodes ? one : formats ? loadsNothing : pipes ? `${one}, and ${loadsNothing}` : 'a check executable that can start in the check sandbox',
    fixFor([...refused, ...refusedToolchains]),
  );
}

/** Whether a check's own command runs one of the toolchain's executables (`dotnet test`, `cd app && go test`). */
function runsToolchain(check: CheckDefinition, id: ToolchainId): boolean {
  return detectToolchains({ command: check.command, shell: check.shell }).includes(id);
}

/**
 * The check whose sandbox a toolchain's probe runs in: a mandatory check that runs the toolchain's executable, else any
 * check that runs it, else a mandatory one that uses it, else the first that uses it; null when none does (the toolchain
 * is only in the repository). Its env, hosts and loopback setting are what a run would give the toolchain.
 */
function baseCheck(id: ToolchainId, users: readonly CheckDefinition[]): CheckDefinition | null {
  const rank = (c: CheckDefinition) => (runsToolchain(c, id) ? 2 : 0) + (c.mandatory ? 1 : 0);
  return [...users].sort((a, b) => rank(b) - rank(a))[0] ?? null;
}

/**
 * The path to start a found executable by, or null when it is the repository's own code (it, or the file a link
 * resolves to, is inside the repository). An installed tool starts by the name PATH gave it, not by its link's target:
 * a multi-call binary picks the tool it runs from that name, and rustup's proxies (cargo, rustc) are links to rustup
 * itself, where `rustup --version` succeeds although `cargo` cannot choose a toolchain. A link inside the repository
 * starts by its target, which is outside it.
 */
function launchPath(found: string, repo: string | null): string | null {
  const target = realpathSync(found);
  if (repo && isWithin(target, repo)) return null;
  const named = join(realpathSync(dirname(found)), basename(found));
  return repo && isWithin(named, repo) ? target : named;
}

/** A probe, with a provider that could not even wrap the command counted as a refusal. */
async function probeOrRefuse(input: CheckSandboxInput & { provider: IsolationProvider }, check: CheckDefinition, exe: string, args: readonly string[], cwd: string | null, project: ProbeProject | null, nodeFix: MsbuildFix): Promise<Outcome> {
  try {
    return await probe(input, check, exe, args, cwd, project, nodeFix);
  } catch (err) {
    const why = err instanceof OrbitError ? err.message : oneLine(err instanceof Error ? err.message : String(err), 200);
    return { kind: 'refused', detail: `could not be started in the sandbox: ${why}`, failure: { checkId: check.id, fingerprint: null, signals: ['start-failed'], cause: 'the check could not be started', lines: [why] } };
  }
}

/**
 * One toolchain's line: whether its executable starts (for .NET: builds a generated project) in the sandbox of the check
 * that uses it, and where its caches and build state live.
 */
async function toolchainLine(input: CheckSandboxInput & { provider: IsolationProvider; repo: string }, orbitHome: string, id: ToolchainId, base: CheckDefinition | null): Promise<{ detail: string; refusal: Refusal | null }> {
  const p = TOOLCHAIN_PROFILES[id];
  const root = toolchainCacheRoot(orbitHome, repoKeyFor(input.repo));
  const caches = p.caches.map((c) => join(root, c));
  // On macOS the install cannot download NuGet packages (srt keeps the system trust service out of reach), so a .NET
  // repository with packages fills the cache outside the sandbox (checks.dotnet-packages gives the command).
  const outside = id === 'dotnet' && input.nugetPackages === true && (input.platform ?? process.platform) === 'darwin';
  const nuget = "on macOS the dependency install cannot download NuGet packages, so this repository's are restored into it outside the sandbox, as checks.dotnet-packages says";
  const exists = caches.every((c) => existsSync(c));
  const state = exists ? `read-only for checks and workers${outside ? `; ${nuget}` : ', written by the dependency install'}` : `not created yet${outside ? `: ${nuget}` : '; the first dependency install creates it'}`;
  const where = `${caches.length === 1 ? 'dependency cache' : 'dependency caches'} ${caches.join(', ')} (${state}); private per check attempt: ${p.scratchVars.join(', ')}`;
  const label = `toolchain ${id}`;
  const found = p.probe.executables.map((e) => which(e, input.env.PATH)).find((x): x is string => x !== null);
  if (!found) return { detail: `${label}: not started ("${p.probe.executables[0]}" was not found); ${where}`, refusal: null };
  const exe = launchPath(found, input.repo);
  if (!exe) return { detail: `${label}: not started ("${basename(found)}" is the repository's own code, which only a run executes); ${where}`, refusal: null };
  // The sandbox of the check that uses the toolchain (its env, hosts and loopback), starting the probe instead of its
  // command. The .NET probe builds with the node switches MSBuild gets from that check's command, in its env, so doctor
  // and the runner agree: -m:1, or DOTNET_PROCESSOR_COUNT=1 in its env, passes; no switch is refused as the check would
  // be (evidence/msbuild.ts probeNodeSwitches).
  const args = id === 'dotnet' ? [...p.probe.args, ...probeNodeSwitches(base)] : p.probe.args;
  const check: CheckDefinition = { ...(base ?? defaultCheck(`toolchain-${id}`)), id: `toolchain-${id}`, command: [exe, ...args], shell: false, cwd: '.', mandatory: false };
  const project = p.probe.files ? { files: p.probe.files, about: p.probe.about ?? 'a generated project' } : null;
  const out = await probeOrRefuse(input, check, exe, args, null, project, msbuildFix(base));
  return { detail: `${label}: ${out.detail}; ${where}`, refusal: out.kind === 'refused' ? out : null };
}

