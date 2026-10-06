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
 * With the Orbit home known, each toolchain the checks or the repository use is started too, and its line says where
 * the repository's dependency caches live. An existing cache is mounted read-only, as a check gets it; one that does
 * not exist yet is replaced by an empty stand-in in the scratch directory, so doctor never creates it.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { execCapture } from '../../core/exec.ts';
import { OrbitError } from '../../core/errors.ts';
import { redact } from '../../core/redact.ts';
import { environmentFix } from '../../controller/environment-block.ts';
import { classifyCouldNotRun, classifyNotExecuted, type EnvironmentFailure } from '../../evidence/environment-failure.ts';
import { checkEnv, prepareCheckHome } from '../../evidence/runner.ts';
import { prepareWorkerTmpDir, profileForCheck } from '../../isolation/profiles.ts';
import { detectToolchains, removeScratch, TOOLCHAIN_PROFILES, toolchainCacheRoot, toolchainLayout, type ToolchainId } from '../../isolation/toolchains.ts';
import type { IsolationProvider } from '../../isolation/types.ts';
import { isWithin, which } from '../../isolation/util.ts';
import { defaultCheck } from '../../policy/config.ts';
import type { CheckDefinition, OrbitConfig, PolicySnapshot } from '../../policy/types.ts';
import { repoKeyFor } from '../../storage/retention.ts';
import { oneLine } from '../io.ts';
import type { DoctorCheck } from './doctor.ts';

/** Runs a wrapped command and reports how it ended; the real one is execCapture, tests pass their own. */
export type ProbeLaunch = (argv: string[], opts: { cwd: string; env: Record<string, string>; timeoutMs: number }) => Promise<{ exitCode: number | null; output: string }>;

const launchWrapped: ProbeLaunch = async (argv, opts) => {
  const r = await execCapture(argv, { ...opts, maxOutputBytes: 256 * 1024 });
  return { exitCode: r.timedOut ? null : r.exitCode, output: `${r.stdout}\n${r.stderr}`.trim() };
};

const PROBE_TIMEOUT_MS = 60_000;

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
}

/** How one probe went, without the label of what was probed (a check id, or "toolchain go"). */
type Outcome = { kind: 'ran'; detail: string } | { kind: 'refused'; detail: string; failure: EnvironmentFailure };

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

/** One probe in a scratch directory of its own. `cwd` is the check's directory in the repository, for its markers. */
async function probe(input: CheckSandboxInput & { provider: IsolationProvider }, check: CheckDefinition, exe: string, args: readonly string[], cwd: string | null): Promise<Outcome> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-doctor-check-')));
  let tmp: string | null = null;
  try {
    const checkout = join(scratch, 'checkout');
    const home = join(scratch, 'home');
    const artifacts = join(scratch, 'artifacts');
    for (const d of [checkout, home, artifacts]) mkdirSync(d, { recursive: true, mode: 0o700 });
    prepareCheckHome(home);
    tmp = prepareWorkerTmpDir(scratch);
    const snapshot: PolicySnapshot = { schema: 'orbit.policy/1', run_id: 'doctor', created_at: '', repo_root: input.repo ?? scratch, config: input.config, effective_protected_paths: [], check_config_hashes: {} };
    const ids = detectToolchains({ command: check.command, shell: check.shell, roots: [...(input.repo ? [input.repo] : []), ...(cwd ? [cwd] : [])] });
    const toolchains = toolchainLayout({ toolchains: ids, mode: 'check', cacheRoot: probeCacheRoot(input, ids, scratch), scratchRoot: join(scratch, 'toolchains'), tmpDir: tmp, hostHome: input.homeDir, hostEnv: input.env });
    // Only what is missing is created: an existing cache is the repository's and stays untouched.
    for (const d of toolchains.directories) if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
    const profile = profileForCheck({ worktree: checkout, check, snapshot, extraWritable: [artifacts, home, tmp, ...toolchains.writable], readablePaths: toolchains.readOnly, homeDir: input.homeDir, env: { ...input.env } });
    const env = checkEnv(check, { homeDir: home, tmpDir: tmp, artifactsDir: artifacts }, input.env.PATH, toolchains.env);
    const shown = [basename(exe), ...args].join(' ');
    const wrapped = input.provider.wrap([exe, ...args], profile, { cwd: checkout, env });
    let r: { exitCode: number | null; output: string };
    try {
      r = await (input.launch ?? launchWrapped)(wrapped.argv, { cwd: checkout, env: wrapped.env, timeoutMs: PROBE_TIMEOUT_MS });
    } finally {
      wrapped.cleanup();
    }
    if (r.exitCode === 0) return { kind: 'ran', detail: `"${shown}" ran in the sandbox` };
    const output = redact(r.output);
    const failure = classifyNotExecuted({ checkId: check.id, output }) ?? classifyCouldNotRun({ checkId: check.id, output, insideRoots: [scratch, ...(tmp ? [tmp] : [])] });
    if (failure) return { kind: 'refused', failure, detail: `"${shown}" was refused in the sandbox: ${failure.cause}${failure.lines[0] ? ` (${JSON.stringify(failure.lines[0])})` : ''}` };
    return { kind: 'ran', detail: `"${shown}" ${r.exitCode === null ? 'timed out' : `exited ${r.exitCode}`} in the sandbox, with no sandbox denial in its output${output ? `: ${oneLine(output, 160)}` : ''}` };
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
  const refused: { check: CheckDefinition; failure: EnvironmentFailure }[] = [];
  let started = 0;
  const used = new Set<ToolchainId>(repo ? detectToolchains({ roots: [repo] }) : []);
  for (const check of checks) {
    if (repo) for (const id of detectToolchains({ command: check.command, shell: check.shell, roots: [resolve(repo, check.cwd)] })) used.add(id);
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
    const out = await probeOrRefuse(probeInput, check, exe, PROBE_ARGS[basename(exe)] ?? DEFAULT_PROBE_ARGS, repo ? resolve(repo, check.cwd) : null);
    details.push(`${check.id}: ${out.detail}`);
    if (out.kind === 'refused') refused.push({ check, failure: out.failure });
  }
  const refusedToolchains: { id: ToolchainId; failure: EnvironmentFailure }[] = [];
  if (repo && input.orbitHome) {
    for (const id of [...used].sort()) {
      const line = await toolchainLine({ ...probeInput, repo }, input.orbitHome, id);
      details.push(line.detail);
      if (line.failure) refusedToolchains.push({ id, failure: line.failure });
    }
  }
  const fixFor = (failures: EnvironmentFailure[]) => environmentFix(failures) ?? 'see the line above and docs/troubleshooting.md, "A check cannot run in the sandbox"';
  if (refused.length === 0 && refusedToolchains.length === 0) return result('pass', started === 0 ? 'no check executable outside the repository to start' : `${started} check executable(s) start in the sandbox`, details);
  if (refused.length === 0) {
    const names = refusedToolchains.map((r) => r.id);
    const listed = names.length === 1 ? `the ${names[0]} toolchain` : `the ${names.slice(0, -1).join(', ')} and ${names.at(-1)} toolchains`;
    return result('warn', `the sandbox refuses ${listed}; checks that use ${names.length === 1 ? 'it' : 'them'} would block at their baseline`, details, 'a toolchain that can start in the check sandbox', fixFor(refusedToolchains.map((r) => r.failure)));
  }
  const status = refused.some((r) => r.check.mandatory) ? 'fail' : 'warn';
  const ids = refused.map((r) => r.check.id).join(', ');
  return result(
    status,
    `the sandbox refuses ${refused.length === 1 ? 'the executable' : 'the executables'} of ${refused.length === 1 ? 'check' : 'checks'} ${ids}; a run would block at its baseline`,
    details,
    'a check executable that can start in the check sandbox',
    fixFor([...refused, ...refusedToolchains].map((r) => r.failure)),
  );
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
async function probeOrRefuse(input: CheckSandboxInput & { provider: IsolationProvider }, check: CheckDefinition, exe: string, args: readonly string[], cwd: string | null): Promise<Outcome> {
  try {
    return await probe(input, check, exe, args, cwd);
  } catch (err) {
    const why = err instanceof OrbitError ? err.message : oneLine(err instanceof Error ? err.message : String(err), 200);
    return { kind: 'refused', detail: `could not be started in the sandbox: ${why}`, failure: { checkId: check.id, fingerprint: null, signals: ['start-failed'], cause: 'the check could not be started', lines: [why] } };
  }
}

/** One toolchain's line: whether its executable starts in the check sandbox, and where its caches and build state live. */
async function toolchainLine(input: CheckSandboxInput & { provider: IsolationProvider; repo: string }, orbitHome: string, id: ToolchainId): Promise<{ detail: string; failure: EnvironmentFailure | null }> {
  const p = TOOLCHAIN_PROFILES[id];
  const root = toolchainCacheRoot(orbitHome, repoKeyFor(input.repo));
  const caches = p.caches.map((c) => join(root, c));
  const state = caches.every((c) => existsSync(c)) ? 'read-only for checks and workers, written by the dependency install' : 'not created yet; the first dependency install creates it';
  const where = `${caches.length === 1 ? 'dependency cache' : 'dependency caches'} ${caches.join(', ')} (${state}); private per check attempt: ${p.scratchVars.join(', ')}`;
  const label = `toolchain ${id}`;
  const found = p.probe.executables.map((e) => which(e, input.env.PATH)).find((x): x is string => x !== null);
  if (!found) return { detail: `${label}: not started ("${p.probe.executables[0]}" was not found); ${where}`, failure: null };
  const exe = launchPath(found, input.repo);
  if (!exe) return { detail: `${label}: not started ("${basename(found)}" is the repository's own code, which only a run executes); ${where}`, failure: null };
  const check: CheckDefinition = { ...defaultCheck(`toolchain-${id}`), command: [exe, ...p.probe.args], mandatory: false };
  const out = await probeOrRefuse(input, check, exe, p.probe.args, null);
  return { detail: `${label}: ${out.detail}; ${where}`, failure: out.kind === 'refused' ? out.failure : null };
}

