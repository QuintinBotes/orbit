/**
 * `orbit doctor`'s checks.sandbox (issue #10): every configured command check's executable, started inside the sandbox
 * the check would get, with a harmless argument. A tool the sandbox refuses at start (the .NET SDK asking for
 * /tmp/.dotnet on its first run, say) then shows here, before any run, instead of as a failure of the base revision.
 *
 * Only executables outside the repository are started (an installed tool: dotnet, node, npm, make...): the
 * repository's own scripts are its code, which only a run executes. The profile is the check's own, built from the
 * configuration (its hosts, every credential read-denied, the repository denied), with an empty scratch checkout, a
 * private HOME prepared as a run prepares it, and the environment a check gets. Nothing is written outside the
 * scratch directory, which is removed afterwards.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { execCapture } from '../../core/exec.ts';
import { OrbitError } from '../../core/errors.ts';
import { redact } from '../../core/redact.ts';
import { environmentFix } from '../../controller/environment-block.ts';
import { classifyCouldNotRun, classifyNotExecuted, type EnvironmentFailure } from '../../evidence/environment-failure.ts';
import { checkEnv, prepareCheckHome } from '../../evidence/runner.ts';
import { prepareWorkerTmpDir, profileForCheck } from '../../isolation/profiles.ts';
import type { IsolationProvider } from '../../isolation/types.ts';
import { isWithin, which } from '../../isolation/util.ts';
import type { CheckDefinition, OrbitConfig, PolicySnapshot } from '../../policy/types.ts';
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
  launch?: ProbeLaunch;
}

type Outcome = { kind: 'ran'; detail: string } | { kind: 'refused'; detail: string; failure: EnvironmentFailure } | { kind: 'skipped'; detail: string };

/** One check's probe in a scratch directory of its own. */
async function probe(input: CheckSandboxInput & { provider: IsolationProvider }, check: CheckDefinition, exe: string, args: readonly string[]): Promise<Outcome> {
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
    const profile = profileForCheck({ worktree: checkout, check, snapshot, extraWritable: [artifacts, home, tmp], homeDir: input.homeDir, env: { ...input.env } });
    const env = checkEnv(check, { homeDir: home, tmpDir: tmp, artifactsDir: artifacts }, input.env.PATH);
    const shown = [basename(exe), ...args].join(' ');
    const wrapped = input.provider.wrap([exe, ...args], profile, { cwd: checkout, env });
    let r: { exitCode: number | null; output: string };
    try {
      r = await (input.launch ?? launchWrapped)(wrapped.argv, { cwd: checkout, env: wrapped.env, timeoutMs: PROBE_TIMEOUT_MS });
    } finally {
      wrapped.cleanup();
    }
    if (r.exitCode === 0) return { kind: 'ran', detail: `${check.id}: "${shown}" ran in the sandbox` };
    const output = redact(r.output);
    const failure = classifyNotExecuted({ checkId: check.id, output }) ?? classifyCouldNotRun({ checkId: check.id, output, insideRoots: [scratch, ...(tmp ? [tmp] : [])] });
    if (failure) return { kind: 'refused', failure, detail: `${check.id}: "${shown}" was refused in the sandbox: ${failure.cause}${failure.lines[0] ? ` (${JSON.stringify(failure.lines[0])})` : ''}` };
    return { kind: 'ran', detail: `${check.id}: "${shown}" ${r.exitCode === null ? 'timed out' : `exited ${r.exitCode}`} in the sandbox, with no sandbox denial in its output${output ? `: ${oneLine(output, 160)}` : ''}` };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    if (tmp) rmSync(tmp, { recursive: true, force: true });
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
  const details: string[] = [];
  const refused: { check: CheckDefinition; failure: EnvironmentFailure }[] = [];
  let started = 0;
  for (const check of checks) {
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
    const exe = realpathSync(found);
    if (repo && isWithin(exe, repo)) {
      details.push(`${check.id}: not started ("${word}" is the repository's own code, which only a run executes)`);
      continue;
    }
    started++;
    try {
      const out = await probe({ ...input, provider }, check, exe, PROBE_ARGS[basename(exe)] ?? DEFAULT_PROBE_ARGS);
      details.push(out.detail);
      if (out.kind === 'refused') refused.push({ check, failure: out.failure });
    } catch (err) {
      const why = err instanceof OrbitError ? err.message : oneLine(err instanceof Error ? err.message : String(err), 200);
      details.push(`${check.id}: could not be started in the sandbox: ${why}`);
      refused.push({ check, failure: { checkId: check.id, fingerprint: null, signals: ['start-failed'], cause: 'the check could not be started', lines: [why] } });
    }
  }
  if (refused.length === 0) return result('pass', started === 0 ? 'no check executable outside the repository to start' : `${started} check executable(s) start in the sandbox`, details);
  const status = refused.some((r) => r.check.mandatory) ? 'fail' : 'warn';
  const ids = refused.map((r) => r.check.id).join(', ');
  return result(
    status,
    `the sandbox refuses ${refused.length === 1 ? 'the executable' : 'the executables'} of ${refused.length === 1 ? 'check' : 'checks'} ${ids}; a run would block at its baseline`,
    details,
    'a check executable that can start in the check sandbox',
    environmentFix(refused.map((r) => r.failure)) ?? 'see the line above and docs/troubleshooting.md, "A check cannot run in the sandbox"',
  );
}
