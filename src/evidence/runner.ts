import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { Clock } from '../core/clock.ts';
import { isOrbitError, OrbitError } from '../core/errors.ts';
import { atomicWrite, atomicWriteJson } from '../core/fsx.ts';
import { sha256 } from '../core/hash.ts';
import { spawnDetached } from '../core/exec.ts';
import { isAlive, killGroup, processStartTime } from '../core/proc.ts';
import { isSecretEnvName, redact } from '../core/redact.ts';
import { RESOURCE_LIMIT_EXIT_CODE, resourceLimitNote } from '../isolation/memory.ts';
import { checkoutBelowDenied, prepareWorkerTmpDir, profileForCheck, workerTmpDir } from '../isolation/profiles.ts';
import { detectToolchains, NUGET_AUDIT_LIMITATION, prepareToolchainLayout, removeScratch, toolchainLayout, type ToolchainLayout } from '../isolation/toolchains.ts';
import type { IsolationProvider, WrappedCommand } from '../isolation/types.ts';
import { checkConfigHash, snapshotHash } from '../policy/snapshot.ts';
import type { CheckDefinition, PolicySnapshot } from '../policy/types.ts';
import type { OrbitDb } from '../storage/db.ts';
import { fingerprintFailure } from './fingerprint.ts';
import { git } from './git.ts';
import { nodeDenialFix, sdkFormatsInProcess } from './dotnet-format.ts';
import { findMsbuildNodeDenial, msbuildNodeDenialNote, type MsbuildFixWhere, type MsbuildNodeDenial } from './msbuild.ts';
import {
  checkRunToResult,
  finishCheckRun,
  getCandidate,
  getCheckRun,
  isFinalCheckStatus,
  listCheckRuns,
  markCheckRunning,
  planCheckRun,
  recordFailure,
  setCheckFlaky,
  type CheckRunRecord,
  type FailureSource,
} from './store.ts';
import { ensureShim, readJsonFile, shimPath, type ShimExit, type ShimIntent, type ShimLaunch, type ShimPid } from './check-shim.ts';
import type { Candidate, CheckResult, CheckStatus, EvidenceBinding } from './types.ts';

/**
 * Trusted check execution (spec §11). A check is a command from the frozen
 * policy snapshot, never from a contract or a model, run through the
 * isolation provider in a clean checkout of the exact candidate tree, as a
 * detached process owned by a shim that writes pid and exit files. The
 * controller supervises by polling those files, so a restarted controller
 * reattaches instead of rerunning, and cancellation, timeouts and flaky
 * reruns all end in a durable check_runs row bound to the tree, the check
 * configuration and the policy.
 */

const DEFAULT_POLL_MS = 50;
const DEFAULT_KILL_GRACE_MS = 2_000;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
// A shim that has not written its pid file this long after intent was recorded is taken as never started.
const LAUNCH_GRACE_MS = 10_000;
const MAX_ARTIFACTS = 200;
const MAX_RAW_READ = 32 * 1024 * 1024;
const CHECK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface RunnerContext {
  db: OrbitDb;
  /** Only the identity and the hash the snapshot must still match. */
  run: { id: string; policyHash: string };
  snapshot: PolicySnapshot;
  isolation: IsolationProvider;
  /** A clean checkout of the subject tree (see materializeCandidate with readOnly: false). */
  checkoutDir: string;
  runDir: string;
  clock: Clock;
  /**
   * Cancel: the checks are being cancelled for good (a durable run cancellation, a baseline the caller
   * abandons). Running checks are signalled, their groups killed, and their rows end CANCELLED.
   */
  signal?: AbortSignal;
  /**
   * Stop supervising: the caller is going away but the run is not cancelled (its lease was lost, the
   * controller is shutting down, a step watchdog fired). Nothing is killed and no row is finalized:
   * running checks keep running for the run's next owner, which reattaches to them. Nothing new starts.
   * The call rejects with a CANCELLED error whose details carry `detached: true`.
   */
  detachSignal?: AbortSignal;
  /** Checks running at once. Default 1. */
  parallelism?: number;
  pollMs?: number;
  killGraceMs?: number;
  maxOutputBytes?: number;
  /** Real home directory, used only to compute what the sandbox must hide and to find a rustup installation. */
  homeDir?: string;
  /** Orbit-generated definitions (dependency install) that are not in the snapshot's checks, by id. */
  definitions?: Readonly<Record<string, CheckDefinition>>;
  /**
   * The repository's toolchain dependency caches (isolation/toolchains.ts toolchainCacheRoot): writable for Orbit's
   * install step, read-only for every other check. Absent: each attempt keeps its caches in its private scratch.
   */
  toolchainCacheRoot?: string | null;
  /**
   * Recorded check runs (group roots) whose result must not be reused, so their check runs again. PREFLIGHT set them
   * aside when it found the check could not run or was misconfigured on the base revision (ADR 0010): the environment
   * or the missing program may have been fixed since, which the recorded result cannot show.
   */
  setAside?: ReadonlySet<string>;
}

export interface RunChecksInput extends RunnerContext {
  candidate: Candidate;
  checkIds: readonly string[];
}

/** What a set of check runs is bound to: a candidate, or the base revision for a baseline. */
export interface CheckSubject {
  /** check_runs.candidate_id; null for baseline rows. */
  candidateId: string | null;
  /** EvidenceBinding.candidateId. */
  bindingId: string;
  treeHash: string;
  evidenceDir: string;
  source: Extract<FailureSource, 'check' | 'baseline' | 'install'>;
}

export function candidateEvidenceDir(runDir: string, seq: number): string {
  return join(runDir, 'evidence', String(seq));
}

// ---------------------------------------------------------------------------
// public API

/**
 * Run the named checks on a candidate and return one result per check that
 * ran, in request order. Checks not started because the run was cancelled
 * are absent. Results already recorded for the same candidate and check
 * configuration are returned as they are: calling this twice runs nothing
 * twice.
 */
export async function runChecks(input: RunChecksInput): Promise<CheckResult[]> {
  if (input.candidate.runId !== input.run.id) throw new OrbitError('INTERNAL', `candidate ${input.candidate.id} belongs to run ${input.candidate.runId}, not ${input.run.id}`);
  const defs = dedupe(input.checkIds).map((id) => trustedDefinition(input, id));
  const subject = candidateSubject(input.runDir, input.candidate);
  return runCheckSet(input, subject, defs);
}

/**
 * Collect the outcome of a check run that was in flight when the controller
 * died: wait for (or find) its exit record, record the result, and continue
 * the flaky-rerun policy from where it stopped.
 */
export async function reattachCheck(ctx: RunnerContext, checkRunId: string): Promise<CheckResult> {
  assertPolicy(ctx);
  const row = getCheckRun(ctx.db, checkRunId);
  if (row.runId !== ctx.run.id) throw new OrbitError('INTERNAL', `check run ${checkRunId} belongs to run ${row.runId}, not ${ctx.run.id}`);
  const subject = subjectForRow(ctx, row);
  const def = definitionForRow(ctx, subject, row);
  return executeCheckGroup(ctx, subject, def);
}

/** Reattach every check of the run that has no final status. Returns their results. */
export async function resumeChecks(ctx: RunnerContext): Promise<CheckResult[]> {
  assertPolicy(ctx);
  const open = listCheckRuns(ctx.db, { runId: ctx.run.id }).filter((r) => !isFinalCheckStatus(r.status));
  const seen = new Set<string>();
  const results: CheckResult[] = [];
  for (const row of open) {
    const key = `${row.candidateId ?? 'baseline'}/${row.checkId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(await reattachCheck(ctx, row.id));
  }
  return results;
}

/** Shared by runChecks and the baseline: run definitions for one subject with bounded parallelism. */
export async function runCheckSet(ctx: RunnerContext, subject: CheckSubject, defs: readonly CheckDefinition[]): Promise<CheckResult[]> {
  assertPolicy(ctx);
  await assertCheckoutTree(ctx.checkoutDir, subject.treeHash);
  const limit = Math.max(1, Math.floor(ctx.parallelism ?? 1));
  const results: (CheckResult | null)[] = new Array(defs.length).fill(null);
  const errors: unknown[] = [];
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= defs.length) return;
      if (detached(ctx)) {
        errors.push(detachError(ctx));
        return;
      }
      if (cancelRequested(ctx)) return;
      try {
        results[i] = await executeCheckGroup(ctx, subject, defs[i]!);
      } catch (err) {
        // A cancellation that lands between two checks just means the rest never start.
        if (isOrbitError(err, 'CANCELLED') && cancelRequested(ctx)) return;
        errors.push(err);
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, defs.length) }, worker));
  if (errors.length > 0) throw errors[0];
  return results.filter((r): r is CheckResult => r !== null);
}

export function candidateSubject(runDir: string, candidate: Candidate): CheckSubject {
  return { candidateId: candidate.id, bindingId: candidate.id, treeHash: candidate.treeHash, evidenceDir: candidateEvidenceDir(runDir, candidate.seq), source: 'check' };
}

export function baselineSubject(runDir: string, baseTree: string, source: 'baseline' | 'install' = 'baseline'): CheckSubject {
  return { candidateId: null, bindingId: `baseline:${baseTree}`, treeHash: baseTree, evidenceDir: join(runDir, 'baseline'), source };
}

/** The recorded configuration hash for a check, verified against its definition. */
export function configHashFor(snapshot: PolicySnapshot, def: CheckDefinition): string {
  const actual = checkConfigHash(def);
  const recorded = snapshot.check_config_hashes[def.id];
  if (recorded !== undefined && recorded !== actual) {
    throw new OrbitError('POLICY_TAMPERED', `check ${def.id} does not match the hash recorded in the policy snapshot`, { checkId: def.id });
  }
  return actual;
}

// ---------------------------------------------------------------------------
// definitions and guards

function dedupe<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

function assertPolicy(ctx: Pick<RunnerContext, 'db' | 'run' | 'snapshot'>): void {
  assertRunPolicy(ctx.db, ctx.run, ctx.snapshot);
}

/**
 * The snapshot must hash to the policy hash the database recorded for the
 * run. The caller's `run.policyHash` is only a copy; checking against it
 * alone would let a caller holding another snapshot and its hash bind
 * evidence to a policy the run never froze.
 */
export function assertRunPolicy(db: OrbitDb, run: { id: string; policyHash: string }, snapshot: PolicySnapshot): void {
  const row = db.get<{ policy_hash: string }>('SELECT policy_hash FROM runs WHERE id = ?', run.id);
  if (!row) throw new OrbitError('NOT_FOUND', `no run ${run.id}`, { runId: run.id });
  const actual = snapshotHash(snapshot);
  if (actual !== run.policyHash || actual !== row.policy_hash) {
    throw new OrbitError('POLICY_TAMPERED', 'the policy snapshot in memory does not match the hash recorded for the run', { runId: run.id });
  }
}

/** Definitions come only from the snapshot (or Orbit's own generated ones), never from a contract or model output. */
function trustedDefinition(ctx: Pick<RunnerContext, 'snapshot' | 'definitions'>, id: string): CheckDefinition {
  const fromSnapshot = ctx.snapshot.config.checks[id];
  const generated = ctx.definitions?.[id];
  // A generated definition may add a check, never replace one the policy froze.
  if (fromSnapshot && generated) {
    throw new OrbitError('POLICY_DENIED', `check ${JSON.stringify(id)} is defined in the policy snapshot and cannot be redefined by Orbit; the id is reserved`, { checkId: id, rule: 'checks.trusted-only' });
  }
  const def = fromSnapshot ?? generated;
  if (!def) throw new OrbitError('POLICY_DENIED', `check ${JSON.stringify(id)} is not defined in the policy snapshot`, { checkId: id, rule: 'checks.trusted-only' });
  return validDefinition(def, id);
}

function validDefinition(def: CheckDefinition, id: string): CheckDefinition {
  if (def.id !== id) throw new OrbitError('CONFIG_INVALID', `check ${JSON.stringify(id)} carries the id ${JSON.stringify(def.id)}`, { checkId: id });
  if (def.kind !== 'command') throw new OrbitError('INTERNAL', `check ${id} is a ${def.kind} check; the UI runner executes those`, { checkId: id });
  assertSafeId(def.id);
  if (def.command.length === 0) throw new OrbitError('CONFIG_INVALID', `check ${id} has an empty command`, { checkId: id });
  if (def.shell && def.command.length !== 1) throw new OrbitError('CONFIG_INVALID', `check ${id} sets shell: true and must have exactly one command element (the script)`, { checkId: id });
  return def;
}

function assertSafeId(id: string): void {
  if (!CHECK_ID.test(id) || id.includes('..')) throw new OrbitError('CONFIG_INVALID', `check id ${JSON.stringify(id)} is not safe to use in a file name`, { checkId: id });
}

async function assertCheckoutTree(dir: string, treeHash: string): Promise<void> {
  const head = (await git(dir, ['rev-parse', '--verify', 'HEAD^{tree}'])).trim();
  if (head !== treeHash) {
    throw new OrbitError('STALE_EVIDENCE', `checkout ${dir} holds tree ${head}, not the tree ${treeHash} the results would be bound to`, { checkout: dir, head, treeHash });
  }
}

function subjectForRow(ctx: RunnerContext, row: CheckRunRecord): CheckSubject {
  const install = INSTALL_CHECK_IDS.includes(row.checkId);
  if (row.candidateId === null) return baselineSubject(ctx.runDir, row.treeHash, install ? 'install' : 'baseline');
  const subject = candidateSubject(ctx.runDir, getCandidate(ctx.db, row.candidateId));
  return install ? { ...subject, source: 'install' } : subject;
}

/** Check id of the dependency install step; baseline.ts defines its command. */
export const INSTALL_CHECK_ID = 'orbit-install';
/** Check id of the allowlisted lifecycle-script step that follows a script-free install. */
export const INSTALL_SCRIPTS_CHECK_ID = 'orbit-install-scripts';
const INSTALL_CHECK_IDS: readonly string[] = [INSTALL_CHECK_ID, INSTALL_SCRIPTS_CHECK_ID];

const DEFINITION_FILE = 'definition.json';

/**
 * The definition to supervise (and possibly rerun) an existing row with. A
 * restarted controller has the snapshot but not the definitions Orbit
 * generated at launch (the dependency install), so those are read back from
 * the copy written next to the attempt, and accepted only when they hash to
 * the configuration recorded on the row before the process started.
 */
function definitionForRow(ctx: RunnerContext, subject: CheckSubject, row: CheckRunRecord): CheckDefinition {
  if (ctx.snapshot.config.checks[row.checkId] || ctx.definitions?.[row.checkId]) return trustedDefinition(ctx, row.checkId);
  const file = join(dirsFor(subject, row.checkId, attemptIndex(ctx, row)).checkDir, DEFINITION_FILE);
  const stored = readJsonFile<CheckDefinition>(file);
  if (!stored) throw new OrbitError('POLICY_DENIED', `check ${JSON.stringify(row.checkId)} is not defined in the policy snapshot and no generated definition was recorded for it`, { checkId: row.checkId, rule: 'checks.trusted-only' });
  let hash: string;
  try {
    hash = checkConfigHash(stored);
  } catch (err) {
    throw new OrbitError('POLICY_TAMPERED', `the recorded definition of check ${row.checkId} is unreadable`, { checkId: row.checkId, file }, { cause: err });
  }
  if (hash !== row.checkConfigHash) {
    throw new OrbitError('POLICY_TAMPERED', `the recorded definition of check ${row.checkId} does not match the configuration hash stored when it started`, { checkId: row.checkId, file });
  }
  return validDefinition(stored, row.checkId);
}

/** The caller stopped supervising (see RunnerContext.detachSignal); it is not a cancellation. */
function detached(ctx: Pick<RunnerContext, 'detachSignal'>): boolean {
  return ctx.detachSignal?.aborted === true;
}

function detachError(ctx: Pick<RunnerContext, 'detachSignal'>): OrbitError {
  const why = ctx.detachSignal?.reason instanceof Error ? ctx.detachSignal.reason.message : 'supervision stopped';
  return new OrbitError('CANCELLED', `check supervision stopped (${why}); running checks are left for the run's next owner to reattach to`, { detached: true });
}

function cancelRequested(ctx: Pick<RunnerContext, 'db' | 'run' | 'signal'>): boolean {
  if (ctx.signal?.aborted) return true;
  const row = ctx.db.get<{ cancel_requested: number }>('SELECT cancel_requested FROM runs WHERE id = ?', ctx.run.id);
  return row?.cancel_requested === 1;
}

// ---------------------------------------------------------------------------
// one check: attempts, reruns, final result

interface AttemptDirs {
  checkDir: string;
  logPath: string;
  artifactsDir: string;
  homeDir: string;
  tmpDir: string;
  /** Private build state of the attempt's toolchains (isolation/toolchains.ts). */
  toolchainsDir: string;
}

function attemptName(checkId: string, index: number): string {
  // '~' cannot appear in a check id, so attempt names never collide with another check.
  return index === 0 ? checkId : `${checkId}~${index}`;
}

function attemptIndex(ctx: RunnerContext, row: CheckRunRecord): number {
  const rows = listCheckRuns(ctx.db, { runId: row.runId, candidateId: row.candidateId, checkId: row.checkId });
  return Math.max(0, rows.findIndex((r) => r.id === row.id));
}

function dirsFor(subject: CheckSubject, checkId: string, index: number): AttemptDirs {
  const name = attemptName(checkId, index);
  const checkDir = join(subject.evidenceDir, name);
  return {
    checkDir,
    logPath: join(subject.evidenceDir, `${name}.log`),
    artifactsDir: join(checkDir, 'artifacts'),
    homeDir: join(checkDir, 'home'),
    // Short and private: socket paths inside deep run directories exceed the OS limit.
    tmpDir: workerTmpDir(checkDir),
    toolchainsDir: join(checkDir, 'toolchains'),
  };
}

async function executeCheckGroup(ctx: RunnerContext, subject: CheckSubject, def: CheckDefinition): Promise<CheckResult> {
  const configHash = configHashFor(ctx.snapshot, def);
  const binding: EvidenceBinding = { candidateId: subject.bindingId, treeHash: subject.treeHash, checkConfigHash: configHash, policyHash: ctx.run.policyHash };
  const query = { runId: ctx.run.id, candidateId: subject.candidateId, checkId: def.id };

  const loadGroup = (): CheckRunRecord[] => {
    const rows = listCheckRuns(ctx.db, query);
    const root = [...rows].reverse().find((r) => r.rerunOf === null);
    if (!root || ctx.setAside?.has(root.id)) return [];
    // A group recorded under another configuration or policy says nothing about this one.
    if (root.checkConfigHash !== configHash || root.policyHash !== ctx.run.policyHash || root.treeHash !== subject.treeHash) return [];
    return rows.filter((r) => r.id === root.id || r.rerunOf === root.id);
  };

  let group = loadGroup();
  // True once this call has launched or supervised something: an ERROR, CANCELLED or lost run seen before that is old news to redo.
  let touched = false;

  for (;;) {
    const last = group.at(-1);
    if (last && !isFinalCheckStatus(last.status)) {
      touched = true;
      await superviseAttempt(ctx, subject, def, last, null);
      group = loadGroup();
      continue;
    }
    if (last) {
      if (last.status === 'PASSED') break;
      if (last.status === 'FAILED') {
        if (group.length - 1 >= def.flaky_reruns) break;
      } else if (touched || last.status === 'TIMEOUT') {
        break;
      } else {
        // ERROR or CANCELLED from an earlier call: start over with a fresh first attempt.
        group = [];
        continue;
      }
      if (cancelRequested(ctx)) break;
    }
    if (detached(ctx)) throw detachError(ctx);
    touched = true;
    const root = group[0] ?? null;
    const planned = await launchAttempt(ctx, subject, def, configHash, root?.id ?? null);
    group = loadGroup().length > 0 ? loadGroup() : [planned];
  }

  return settleGroup(ctx, subject, def, binding, group);
}

/** Pick the row that represents the group, mark flakiness, record failures, and remove leftovers. */
function settleGroup(ctx: RunnerContext, subject: CheckSubject, def: CheckDefinition, binding: EvidenceBinding, group: CheckRunRecord[]): CheckResult {
  const passed = group.find((r) => r.status === 'PASSED') ?? null;
  const first = group[0]!;
  let chosen: CheckRunRecord;
  if (passed) {
    chosen = passed;
    if (group.length > 1) {
      // A pass that needed a rerun is never a clean pass.
      if (!passed.flaky) setCheckFlaky(ctx.db, passed.id, true);
      if (first.fingerprint) recordFailure(ctx.db, { runId: ctx.run.id, candidateId: subject.candidateId, source: 'flaky_check', sourceId: first.id, fingerprint: first.fingerprint, excerpt: first.excerpt }, ctx.clock);
    }
  } else {
    const last = group.at(-1)!;
    chosen = last.status === 'CANCELLED' ? last : first;
    if (chosen.fingerprint && chosen.status !== 'CANCELLED') {
      recordFailure(ctx.db, { runId: ctx.run.id, candidateId: subject.candidateId, source: subject.source, sourceId: chosen.id, fingerprint: chosen.fingerprint, excerpt: chosen.excerpt }, ctx.clock);
    }
  }
  for (const row of group) removeLeftovers(subject, def.id, attemptIndex(ctx, row));
  return checkRunToResult(getCheckRun(ctx.db, chosen.id), binding);
}

// ---------------------------------------------------------------------------
// launching

function safeCwd(checkout: string, rel: string): string {
  const root = realpathSync(checkout);
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new OrbitError('CONFIG_INVALID', `check cwd ${JSON.stringify(rel)} leaves the checkout`, { cwd: rel });
  }
  let real: string;
  try {
    real = realpathSync(abs);
  } catch (err) {
    throw new OrbitError('NOT_FOUND', `check cwd ${rel} does not exist in the checkout`, { cwd: rel }, { cause: err });
  }
  // A symlink inside the candidate must not steer a check out of its checkout.
  if (real !== root && !real.startsWith(root + sep)) throw new OrbitError('SCOPE_VIOLATION', `check cwd ${rel} resolves outside the checkout`, { cwd: rel, real });
  return real;
}

/**
 * The .NET SDK in a check's sandbox (issue #10). A check's HOME is a new, empty directory, so every `dotnet` command
 * is the SDK's first run, and its first-run steps reach outside the sandbox: the NuGet migrations take a named mutex,
 * which the runtime keeps under /tmp/.dotnet (a path compiled into it, ignoring TMPDIR and HOME, that no sandbox rule
 * may open to one check), the ASP.NET development certificate goes to the login keychain, and the tools path is
 * added to the shell profile. These turn off the parts that are optional; prepareCheckHome records the migrations as
 * done, which they are for a home that holds nothing to migrate. Other tools ignore all of them.
 *
 * EnableSourceControlManagerQueries=false (an MSBuild property, which MSBuild also reads from the environment) stops
 * every build from asking git for the commit, branch and remote that SourceLink embeds. A check's verdict needs none of
 * them, and on Linux the query cannot run: srt protects the repository files that can make git run code (.gitmodules,
 * .gitconfig...) by binding an unopenable device over each one the checkout lacks, so reading an absent .gitmodules
 * fails with EACCES and the build stops at "Error reading git repository information" (.NET SDK 9 and 10). Turning the
 * query off keeps that protection and every other rule of the sandbox; a check's own env can turn it back on.
 *
 * Orbit never changes a check's processor count (issue #10, reopened; evidence/msbuild.ts): DOTNET_PROCESSOR_COUNT
 * reaches the test host, where it changes how the repository's tests run (xunit before 2.8 deadlocks a test that blocks
 * on async code on one processor). MSBuild worker nodes, which the sandbox refuses their named pipe under /tmp, are kept
 * out by the check's own command instead (-m:1, which `orbit doctor` asks for), and a check that still starts one is
 * stopped as soon as MSBuild records the refusal (superviseAttempt).
 */
export const DOTNET_CHECK_ENV: Readonly<Record<string, string>> = {
  DOTNET_CLI_TELEMETRY_OPTOUT: '1',
  DOTNET_NOLOGO: '1',
  DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
  DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false',
  DOTNET_ADD_GLOBAL_TOOLS_TO_PATH: 'false',
  DOTNET_SKIP_WORKLOAD_INTEGRITY_CHECK: '1',
  EnableSourceControlManagerQueries: 'false',
};

/** Where NuGet records the migrations it has run, under the home directory, and the newest one's marker file. */
export const NUGET_MIGRATIONS_DIR = join('.local', 'share', 'NuGet', 'Migrations');
const NUGET_LATEST_MIGRATION = '1';

/**
 * Ready a check's private home before the check starts: the NuGet migrations are marked done, so the .NET SDK does not
 * take the named mutex the sandbox cannot allow (see DOTNET_CHECK_ENV). The home starts empty, so there is nothing for
 * them to migrate. Harmless to every other tool.
 */
export function prepareCheckHome(homeDir: string): void {
  const dir = join(homeDir, NUGET_MIGRATIONS_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicWrite(join(dir, NUGET_LATEST_MIGRATION), '', 0o600);
}

/**
 * The fixed environment a check starts with. The host environment is not inherited beyond PATH. `toolchainEnv` (a
 * ToolchainLayout's env) cannot replace what the runner fixes here; the check's own env overrides everything.
 */
export function checkEnv(def: CheckDefinition, dirs: Pick<AttemptDirs, 'homeDir' | 'tmpDir' | 'artifactsDir'>, hostPath: string | undefined = process.env.PATH, toolchainEnv: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    ...toolchainEnv,
    PATH: hostPath ?? '/usr/bin:/bin',
    HOME: dirs.homeDir,
    TMPDIR: dirs.tmpDir,
    ...DOTNET_CHECK_ENV,
    DOTNET_CLI_HOME: dirs.homeDir,
    LANG: platform() === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8',
    TERM: 'dumb',
    CI: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    NO_UPDATE_NOTIFIER: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    ORBIT_CHECK_ID: def.id,
    ORBIT_ARTIFACTS_DIR: dirs.artifactsDir,
    ...def.env,
  };
}

async function launchAttempt(ctx: RunnerContext, subject: CheckSubject, def: CheckDefinition, configHash: string, rerunOf: string | null): Promise<CheckRunRecord> {
  const argv = def.shell ? ['/bin/sh', '-c', def.command[0]!] : [...def.command];
  const cwd = safeCwd(ctx.checkoutDir, def.cwd);
  await assertCheckoutUnmodified(ctx.checkoutDir, def.id);
  const index = listCheckRuns(ctx.db, { runId: ctx.run.id, candidateId: subject.candidateId, checkId: def.id }).length;
  const dirs = dirsFor(subject, def.id, index);
  for (const d of [dirs.checkDir, dirs.artifactsDir, dirs.homeDir]) mkdirSync(d, { recursive: true, mode: 0o700 });
  prepareCheckHome(dirs.homeDir);
  const tmp = prepareWorkerTmpDir(dirs.checkDir);
  // Before the intent row: a restarted controller must find the generated definition of every row it can see.
  if (!ctx.snapshot.config.checks[def.id]) atomicWriteJson(join(dirs.checkDir, DEFINITION_FILE), def, 0o600);

  const toolchains = checkToolchains(ctx, def, cwd, dirs, tmp);
  prepareToolchainLayout(toolchains);
  const env = checkEnv(def, dirs, process.env.PATH, toolchains.env);
  const profile = profileForCheck({
    worktree: ctx.checkoutDir,
    check: def,
    snapshot: ctx.snapshot,
    extraWritable: [dirs.artifactsDir, dirs.homeDir, tmp, ...toolchains.writable],
    readablePaths: toolchains.readOnly,
    nisDomainName: toolchains.nisDomainName,
    homeDir: ctx.homeDir,
  });
  const wrapped: WrappedCommand = ctx.isolation.wrap(argv, profile, { cwd, env });

  let row: CheckRunRecord;
  try {
    // Intent first: once this commits, a restarted controller knows a check may be running for this row.
    row = planCheckRun(
      ctx.db,
      {
        runId: ctx.run.id,
        candidateId: subject.candidateId,
        checkId: def.id,
        kind: def.kind,
        treeHash: subject.treeHash,
        checkConfigHash: configHash,
        policyHash: ctx.run.policyHash,
        command: argv,
        cwd,
        isolation: ctx.isolation.kind,
        // NuGet's audit off is a gap in what the check proves, as an isolation limitation is: the record says so.
        limitations: [...wrapped.limitations, ...(env.NuGetAudit === 'false' ? [NUGET_AUDIT_LIMITATION] : [])],
        rerunOf,
      },
      ctx.clock,
    );
  } catch (err) {
    wrapped.cleanup();
    throw err;
  }

  const token = randomBytes(8).toString('hex');
  const intent: ShimIntent = {
    token,
    checkRunId: row.id,
    argv: wrapped.argv,
    cwd,
    timeoutMs: def.timeout_seconds * 1000,
    killGraceMs: ctx.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
    maxOutputBytes: ctx.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    writtenAt: ctx.clock.now(),
  };
  try {
    atomicWriteJson(shimPath(dirs.checkDir, 'intent'), intent, 0o600);
    const shim = ensureShim(ctx.runDir);
    const { pid } = spawnDetached([process.execPath, shim, dirs.checkDir], { cwd: dirs.checkDir, env: wrapped.env, stdoutPath: join(dirs.checkDir, 'shim.out'), stderrPath: join(dirs.checkDir, 'shim.out') });
    let procStart: string | null = null;
    try {
      procStart = processStartTime(pid);
    } catch {
      /* ps unavailable: liveness falls back to the bare pid */
    }
    atomicWriteJson(shimPath(dirs.checkDir, 'launch'), { token, pid, procStart } satisfies ShimLaunch, 0o600);
    row = markCheckRunning(ctx.db, row.id, pid, ctx.clock);
  } catch (err) {
    finishCheckRun(ctx.db, row.id, {
      status: 'ERROR',
      exitCode: null,
      timedOut: false,
      cancelled: false,
      logPath: null,
      logSha256: null,
      fingerprint: null,
      excerpt: redact(`could not start the check: ${err instanceof Error ? err.message : String(err)}`),
      artifacts: [],
      endedAt: ctx.clock.now(),
    });
    wrapped.cleanup();
    throw err;
  }
  return superviseAttempt(ctx, subject, def, row, wrapped);
}

/**
 * The toolchains a check uses (its command, the checkout root and its cwd) and where their state goes
 * (docs/decisions/0009-toolchain-profiles.md): the repository's dependency caches are writable only for Orbit's own
 * install step (a generated definition, never a policy check that borrows its id) and read-only for every other
 * check; build state is private to the attempt.
 */
export function checkToolchains(ctx: Pick<RunnerContext, 'snapshot' | 'checkoutDir' | 'toolchainCacheRoot' | 'homeDir' | 'isolation'>, def: CheckDefinition, cwd: string, dirs: Pick<AttemptDirs, 'toolchainsDir'>, tmpDir: string): ToolchainLayout {
  const install = INSTALL_CHECK_IDS.includes(def.id) && !ctx.snapshot.config.checks[def.id];
  return toolchainLayout({
    toolchains: detectToolchains({ command: def.command, shell: def.shell, roots: [ctx.checkoutDir, cwd] }),
    mode: install ? 'install' : 'check',
    cacheRoot: ctx.toolchainCacheRoot ?? null,
    scratchRoot: dirs.toolchainsDir,
    tmpDir,
    // A container brings its own toolchain installation; the host's rustup and JDK are neither mounted nor wanted there.
    ...(ctx.isolation.kind === 'container' ? { hostEnv: {} } : { hostEnv: process.env, ...(ctx.homeDir ? { hostHome: ctx.homeDir } : {}) }),
  });
}

/**
 * Where a check's command is configured, for the fix of a denied MSBuild node: Orbit's own dependency install is
 * `dependencies.install_command` (it has no env a person sets), any other check is `checks.<id>`.
 */
function msbuildFixWhere(ctx: Pick<RunnerContext, 'snapshot'>, def: CheckDefinition): MsbuildFixWhere | null {
  return INSTALL_CHECK_IDS.includes(def.id) && !ctx.snapshot.config.checks[def.id] ? { command: 'dependencies.install_command', env: null } : null;
}

/**
 * Checks share one writable checkout. A check that rewrote a tracked file
 * (a formatter in write mode, a code generator) leaves a tree that is no
 * longer the candidate, and anything run on it afterwards would be evidence
 * bound to a tree it never saw. Untracked and ignored output (builds,
 * node_modules, reports) is not part of the tree and is allowed.
 */
async function assertCheckoutUnmodified(dir: string, nextCheck: string): Promise<void> {
  const out = await git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--ignore-submodules=none']);
  const changed = out.split('\0').filter(Boolean).map((rec) => rec.slice(3));
  if (changed.length > 0) {
    const shown = changed.slice(0, 10).join(', ') + (changed.length > 10 ? `, and ${changed.length - 10} more` : '');
    throw new OrbitError('STALE_EVIDENCE', `the checkout no longer holds the candidate tree (tracked files changed: ${shown}); check ${nextCheck} was not started`, { checkout: dir, changed: changed.slice(0, 50), checkId: nextCheck });
  }
}

// ---------------------------------------------------------------------------
// supervising

function sleepOrAbort(ctx: RunnerContext, ms: number): Promise<void> {
  const sigs = [ctx.signal, ctx.detachSignal].filter((x): x is AbortSignal => x !== undefined);
  if (sigs.length === 0) return ctx.clock.sleep(ms);
  if (sigs.some((x) => x.aborted)) return Promise.resolve();
  return new Promise<void>((done) => {
    const onAbort = () => done();
    for (const x of sigs) x.addEventListener('abort', onAbort, { once: true });
    void ctx.clock.sleep(ms).then(() => {
      for (const x of sigs) x.removeEventListener('abort', onAbort);
      done();
    });
  });
}

function pidAlive(pid: number | null): boolean {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

interface Shim {
  pid: number | null;
  procStart: string | null;
  pgid: number | null;
}

function readShim(dir: string, intentToken: string | null): Shim {
  const launch = readJsonFile<ShimLaunch>(shimPath(dir, 'launch'));
  const pidFile = readJsonFile<ShimPid>(shimPath(dir, 'pid'));
  const valid = (t: string | undefined) => intentToken === null || t === intentToken;
  return {
    pid: launch && valid(launch.token) ? launch.pid : pidFile && valid(pidFile.token) ? pidFile.shimPid : null,
    procStart: launch && valid(launch.token) ? launch.procStart : null,
    pgid: pidFile && valid(pidFile.token) ? pidFile.childPgid : null,
  };
}

/**
 * Written beside the attempt when the runner stops a check for a sandbox denial that its tool would otherwise wait out
 * (an MSBuild node denied its pipe, evidence/msbuild.ts): the outcome is FAILED with this note, whatever the stopped
 * process exits with (srt exits 0 on SIGTERM), and a restarted controller finds it there. The note ends the log, on the
 * footer only the runner writes, where PREFLIGHT reads it as the environment's failure, not a pre-existing one
 * (evidence/environment-failure.ts classifyCouldNotRun). On a candidate it is read so only when the same check showed it
 * on the base revision (ADR 0010): otherwise the change brought the node, and the failure goes to repair.
 */
const DENIAL_FILE = 'sandbox-denial.json';
/** How often a running check's private temp directory is looked at for such a denial. */
const DENIAL_SCAN_MS = 1_000;

interface DenialRecord {
  token: string | null;
  note: string;
}

/**
 * The note on a check MSBuild recorded a refused worker node for. The exception line comes from a file the check could
 * write: redacted like the check's own output. The fix is for this check's command: -m:1, or for a dotnet format whose
 * implicit restore was refused, the form that loads no project, or with SDK 8 (pinned by the checkout's global.json) a
 * pinned restore first; on macOS, where the form that loads no project cannot list the folders above a checkout below a
 * denied directory (a run's, in the Orbit home), running dotnet format outside Orbit.
 */
function denialNote(ctx: RunnerContext, def: CheckDefinition, denial: MsbuildNodeDenial, stopped = true): string {
  const inProcess = sdkFormatsInProcess(resolve(ctx.checkoutDir, def.cwd), ctx.checkoutDir);
  return redact(msbuildNodeDenialNote(denial, nodeDenialFix(def, msbuildFixWhere(ctx, def), inProcess, folderFormRuns(ctx)), stopped));
}

/** Whether dotnet format whitespace --folder can list the folders above this checkout in the check sandbox (evidence/dotnet-format.ts). */
function folderFormRuns(ctx: Pick<RunnerContext, 'checkoutDir' | 'snapshot' | 'homeDir'>): boolean {
  if (platform() !== 'darwin' || !ctx.snapshot.repo_root) return true;
  try {
    return !checkoutBelowDenied({ checkout: ctx.checkoutDir, repoRoot: ctx.snapshot.repo_root, homeDir: ctx.homeDir ?? homedir() });
  } catch {
    return false;
  }
}

/** The note of a denial recorded for this attempt (its intent's token), or null. */
function readDenial(checkDir: string): string | null {
  const record = readJsonFile<DenialRecord>(join(checkDir, DENIAL_FILE));
  if (!record || typeof record.note !== 'string') return null;
  const token = readJsonFile<ShimIntent>(shimPath(checkDir, 'intent'))?.token ?? null;
  return token === null || record.token === token ? record.note : null;
}

/** Wait for the attempt to end (or end it), then record the outcome. Returns the final row. */
async function superviseAttempt(ctx: RunnerContext, subject: CheckSubject, def: CheckDefinition, row: CheckRunRecord, wrapped: WrappedCommand | null): Promise<CheckRunRecord> {
  const index = attemptIndex(ctx, row);
  const dirs = dirsFor(subject, def.id, index);
  const poll = ctx.pollMs ?? DEFAULT_POLL_MS;
  const grace = ctx.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const intent = readJsonFile<ShimIntent>(shimPath(dirs.checkDir, 'intent'));
  const token = intent?.token ?? null;
  const backstop = row.startedAt + def.timeout_seconds * 1000 + grace * 2 + 2_000;
  let cancelSentAt: number | null = null;
  let checkedIdentity = false;
  let detachedHere = false;
  // A denial found in the check's temp directory: when the group was told to stop, and whether it was killed.
  let deniedAt: number | null = readDenial(dirs.checkDir) === null ? null : ctx.clock.now();
  let deniedKilled = false;
  let nextDenialScan = 0;

  try {
    for (;;) {
      const exit = readJsonFile<ShimExit>(shimPath(dirs.checkDir, 'exit'));
      if (exit && (token === null || exit.token === token)) return finalize(ctx, def, row, dirs, exit, null);
      // Stop supervising, not cancel: the process and its row are left exactly as they are for the next owner.
      // A cancellation already under way is finished first, since that one must end in a recorded outcome.
      if (cancelSentAt === null && detached(ctx) && !cancelRequested(ctx)) {
        detachedHere = true;
        throw detachError(ctx);
      }

      const shim = readShim(dirs.checkDir, token);
      const now = ctx.clock.now();

      if (cancelSentAt === null && cancelRequested(ctx)) {
        cancelSentAt = now;
        if (shim.pid !== null && pidAlive(shim.pid)) {
          try {
            process.kill(shim.pid, 'SIGTERM');
          } catch {
            /* exited between the check and the signal */
          }
        } else if (shim.pgid !== null) killQuiet(shim.pgid, 'SIGTERM');
      }
      if (cancelSentAt !== null && now - cancelSentAt > grace * 2 + 1_000) {
        reapAll(shim);
        return finalize(ctx, def, row, dirs, null, 'cancelled');
      }

      // MSBuild recorded a worker node the sandbox denied its pipe: the build cannot succeed, and MSBuild would wait
      // 30 s for each of ten node starts before saying so. Stop the check's group (not the shim, which would read it as
      // a cancellation); the outcome is recorded from the denial file whatever the group exits with.
      if (cancelSentAt === null && deniedAt === null && shim.pgid !== null && now >= nextDenialScan) {
        nextDenialScan = now + DENIAL_SCAN_MS;
        const denial = findMsbuildNodeDenial(dirs.tmpDir);
        if (denial) {
          atomicWriteJson(join(dirs.checkDir, DENIAL_FILE), { token, note: denialNote(ctx, def, denial) } satisfies DenialRecord, 0o600);
          deniedAt = now;
          killQuiet(shim.pgid, 'SIGTERM');
        }
      }
      if (cancelSentAt === null && deniedAt !== null && !deniedKilled && now - deniedAt > grace && shim.pgid !== null) {
        deniedKilled = true;
        killQuiet(shim.pgid, 'SIGKILL');
      }

      if (now > backstop && cancelSentAt === null) {
        reapAll(shim);
        return finalize(ctx, def, row, dirs, null, 'timeout');
      }

      if (shim.pid === null) {
        const waited = now - (intent?.writtenAt ?? row.startedAt);
        if (waited > LAUNCH_GRACE_MS) return finalize(ctx, def, row, dirs, null, 'lost');
      } else {
        if (!checkedIdentity) {
          checkedIdentity = true;
          // The first look after a restart verifies the start time; later polls use the cheap existence test.
          if (!isAlive(shim.pid, shim.procStart)) {
            const late = readJsonFile<ShimExit>(shimPath(dirs.checkDir, 'exit'));
            if (late) continue;
            reapAll(shim);
            return finalize(ctx, def, row, dirs, null, 'lost');
          }
        } else if (!pidAlive(shim.pid)) {
          const late = readJsonFile<ShimExit>(shimPath(dirs.checkDir, 'exit'));
          if (late) continue;
          reapAll(shim);
          return finalize(ctx, def, row, dirs, null, cancelSentAt !== null ? 'cancelled' : 'lost');
        }
      }
      await sleepOrAbort(ctx, poll);
    }
  } finally {
    // Cleanup of a wrapper can stop what it wraps (a container is removed); a detached check must keep running.
    if (!detachedHere) wrapped?.cleanup();
  }
}

function killQuiet(pgid: number, signal: NodeJS.Signals): void {
  try {
    killGroup(pgid, signal);
  } catch {
    /* refused (unsafe pgid) or already gone */
  }
}

/** Last resort for a shim that is gone, stuck or deaf to SIGTERM: stop the check's group and the shim. */
function reapAll(shim: Shim): void {
  if (shim.pgid !== null) killQuiet(shim.pgid, 'SIGKILL');
  if (shim.pid !== null && pidAlive(shim.pid)) {
    try {
      process.kill(shim.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

// ---------------------------------------------------------------------------
// finalizing

type Synthetic = 'cancelled' | 'timeout' | 'lost';

function finalize(ctx: RunnerContext, def: CheckDefinition, row: CheckRunRecord, dirs: AttemptDirs, exit: ShimExit | null, synthetic: Synthetic | null): CheckRunRecord {
  const rawPath = shimPath(dirs.checkDir, 'output');
  const raw = readCapped(rawPath);
  const secrets = Object.entries(def.env).filter(([k]) => isSecretEnvName(k)).map(([, v]) => v);
  const body = redact(raw, secrets);

  let status: CheckStatus;
  let note: string | null = null;
  if (exit) {
    if (exit.error) {
      status = 'ERROR';
      note = `could not start the check: ${redact(exit.error, secrets)}`;
    } else if (exit.timedOut) status = 'TIMEOUT';
    else if (exit.cancelled) status = 'CANCELLED';
    else {
      status = exit.exitCode === 0 ? 'PASSED' : 'FAILED';
      // The memory watchdog (isolation/memory.ts) stopped the check: a resource-limit failure, not an ordinary one, so the repair brief and the log name the limit.
      const limit = status === 'FAILED' && exit.exitCode === RESOURCE_LIMIT_EXIT_CODE ? resourceLimitNote(body) : null;
      if (limit) note = `resource limit exceeded, ${limit}`;
    }
  } else if (synthetic === 'cancelled') {
    status = 'CANCELLED';
    note = 'the check was cancelled and did not report an exit record';
  } else if (synthetic === 'timeout') {
    status = 'TIMEOUT';
    note = 'the check exceeded its timeout and its supervisor did not stop it; the process group was killed';
  } else {
    status = 'ERROR';
    note = 'the check process disappeared without writing an exit record (killed externally or the host restarted)';
  }
  // Stopped by the runner for a sandbox denial its tool would have waited out: a failure, never a pass (srt exits 0 on
  // SIGTERM), unless it was cancelled or timed out first.
  const denial = status === 'CANCELLED' || status === 'TIMEOUT' ? null : readDenial(dirs.checkDir);
  if (denial !== null) {
    status = 'FAILED';
    note = denial;
  } else if (status === 'FAILED' && note === null) {
    // MSBuild can record a refused node and fail before the next scan (at once on Linux): look once more.
    const late = findMsbuildNodeDenial(dirs.tmpDir);
    if (late) note = denialNote(ctx, def, late, false);
  }

  const exitCode = exit?.exitCode ?? null;
  const footer = `[orbit] check=${def.id} status=${status} exit=${exitCode === null ? (exit?.signal ?? 'none') : exitCode}${note ? ` note=${note}` : ''}\n`;
  const log = body + (body === '' || body.endsWith('\n') ? '' : '\n') + footer;
  atomicWrite(dirs.logPath, log, 0o600);
  const logSha256 = sha256(log);

  let fingerprint: string | null = null;
  let excerpt: string | null = null;
  if (status !== 'PASSED' && status !== 'CANCELLED') {
    const roots = [ctx.checkoutDir, ctx.runDir, dirs.checkDir];
    try {
      roots.push(realpathSync(ctx.checkoutDir));
    } catch {
      /* checkout already removed */
    }
    // The check's own output plus Orbit's note, but not the footer: its "status=FAILED" would count as an error line in every log and give unrelated silent failures one fingerprint.
    const fp = fingerprintFailure(note ? `${body}\n${note}\n` : body, def, { exitCode, timedOut: status === 'TIMEOUT', roots });
    fingerprint = fp.fingerprint;
    excerpt = fp.excerpt;
  }

  const artifacts = [{ path: dirs.logPath, sha256: logSha256, kind: 'log' }, ...collectArtifacts(dirs.artifactsDir)];
  return finishCheckRun(ctx.db, row.id, {
    status,
    exitCode,
    timedOut: status === 'TIMEOUT',
    cancelled: status === 'CANCELLED',
    logPath: dirs.logPath,
    logSha256,
    fingerprint,
    excerpt,
    artifacts,
    endedAt: ctx.clock.now(),
  });
}

function readCapped(path: string): string {
  if (!existsSync(path)) return '';
  const size = statSync(path).size;
  const len = Math.min(size, MAX_RAW_READ);
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, len, 0);
  } finally {
    closeSync(fd);
  }
  return buf.toString('utf8') + (size > len ? `\n[orbit: output truncated: ${size - len} bytes dropped]\n` : '');
}

function kindOf(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 'screenshot';
  if (['webm', 'mp4'].includes(ext)) return 'video';
  if (ext === 'zip') return 'trace';
  if (['xml', 'json', 'html', 'md', 'txt', 'lcov', 'info'].includes(ext)) return 'report';
  if (ext === 'log') return 'log';
  return 'other';
}

function collectArtifacts(dir: string): { path: string; sha256: string; kind: string }[] {
  const out: { path: string; sha256: string; kind: string }[] = [];
  const stack = [dir];
  while (stack.length > 0 && out.length < MAX_ARTIFACTS) {
    const d = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(d).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const p = join(d, name);
      let st;
      try {
        // lstat: a link planted by the check could point the controller at any file on the host.
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(p);
      else if (st.isFile() && out.length < MAX_ARTIFACTS) out.push({ path: p, sha256: hashFile(p), kind: kindOf(p) });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function hashFile(path: string): string {
  const h = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return h.digest('hex');
}

/** The raw output may hold secrets the redactor has not seen; it goes as soon as the sanitized log is durable. Scratch dirs go too. */
function removeLeftovers(subject: CheckSubject, checkId: string, index: number): void {
  const dirs = dirsFor(subject, checkId, index);
  rmSync(shimPath(dirs.checkDir, 'output'), { force: true });
  for (const d of [dirs.homeDir, dirs.tmpDir, dirs.toolchainsDir]) removeScratch(d);
}
