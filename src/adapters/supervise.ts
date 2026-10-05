/**
 * Controller-side half of the worker shim contract, shared by every adapter:
 * launching the shim detached, reattaching to it from its files, telling
 * running from exited from lost, cancelling it, and reading its log.
 *
 * Identity is (pid, start time) as everywhere in Orbit (core/proc.ts): a
 * recorded pid whose start time no longer matches is a different process,
 * and its group is never signalled.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { Clock } from '../core/clock.ts';
import { systemClock } from '../core/clock.ts';
import { OrbitError } from '../core/errors.ts';
import { spawnDetached } from '../core/exec.ts';
import { atomicWriteJson, readJsonIfExists } from '../core/fsx.ts';
import { isAlive, isGroupAlive, processStartTime, terminateGroup } from '../core/proc.ts';
import {
  EXIT_FILE,
  LOG_FILE,
  PID_FILE,
  SHIM_LOG_FILE,
  STDERR_FILE,
  argvHash,
  readExitRecord,
  readFrom,
  readPidRecord,
  shimArgs,
  type AbortPattern,
  type ExitRecord,
  type PidRecord,
} from './shim.ts';
import type { TaskHandle } from './types.ts';

/** Intent marker written before the shim is spawned (persist intent before acting). */
export const LAUNCH_FILE = 'launch.json';
/** Written by cancelTask before it signals anything. */
export const CANCEL_FILE = 'cancel.json';
const PID_WAIT_MS = 15_000;

export interface LaunchRecord {
  version: 1;
  provider: string;
  workerId: string;
  argvHash: string;
  sessionId: string | null;
  requestedAt: number;
  /**
   * The spawned shim's pid and start time, written right after the spawn and
   * before waiting for pid.json, so reconciliation can tell a slow-starting
   * shim from a dead one and never launches a second shim beside it. Absent
   * until the spawn happened; procStart is null when ps could not read it.
   */
  pid?: number;
  procStart?: string | null;
  /** Adapter facts for reporting only (isolation tier, limitations); never used to decide anything. */
  meta?: Record<string, unknown>;
}

export interface LaunchInput {
  provider: string;
  workerId: string;
  workerDir: string;
  cwd: string;
  /** The command that runs the shim, e.g. [node, <orbit>/dist/orbit.mjs, 'shim']. */
  shimCommand: string[];
  /** The provider command the shim supervises (already wrapped by isolation). */
  argv: string[];
  env: Record<string, string>;
  timeoutMs: number;
  graceMs?: number;
  sessionId?: string | null;
  stdinPath?: string | null;
  abortOn?: AbortPattern[];
  cleanupPaths?: string[];
  /**
   * Reporting facts (isolation tier, limitations, model) stored in launch.json
   * before the spawn, so a controller that crashes right after it still
   * reports the attempt truthfully.
   */
  meta?: Record<string, unknown>;
  clock?: Clock;
}

/**
 * Start the shim, or return the handle of the one already started for this
 * worker directory. Calling it twice (a controller that crashed after the
 * spawn but before recording it) never starts a second worker: an existing
 * launch is reattached, and a launch whose shim died is refused until the
 * attempt is archived.
 */
export async function launchShim(input: LaunchInput): Promise<TaskHandle> {
  const clock = input.clock ?? systemClock;
  mkdirSync(input.workerDir, { recursive: true, mode: 0o700 });
  if (existsSync(join(input.workerDir, LAUNCH_FILE))) return reattachLaunch(input.provider, input.workerDir, input.workerId, clock);
  const launch: LaunchRecord = {
    version: 1,
    provider: input.provider,
    workerId: input.workerId,
    argvHash: argvHash(input.argv),
    sessionId: input.sessionId ?? null,
    requestedAt: clock.now(),
    ...(input.meta ? { meta: input.meta } : {}),
  };
  atomicWriteJson(join(input.workerDir, LAUNCH_FILE), launch, 0o600);

  const args = shimArgs({
    workerDir: input.workerDir,
    timeoutMs: input.timeoutMs,
    graceMs: input.graceMs,
    sessionId: input.sessionId,
    stdinPath: input.stdinPath,
    cwd: input.cwd,
    abortOn: input.abortOn,
    cleanupPaths: input.cleanupPaths,
    argv: input.argv,
  });
  const shimLog = join(input.workerDir, SHIM_LOG_FILE);
  const { pid } = spawnDetached([...input.shimCommand, ...args], { cwd: input.cwd, env: input.env, stdoutPath: shimLog, stderrPath: shimLog });
  recordShimIdentity(input.workerDir, launch, pid);
  const handle = await waitForHandle(input.provider, input.workerDir, pid, clock);
  if (handle) return handle;
  // The shim never wrote pid.json: it failed on its arguments or could not
  // start at all. Its log says why.
  throw new OrbitError('PROVIDER_UNAVAILABLE', `worker shim for ${input.workerId} did not start (see ${shimLog})`, { workerId: input.workerId, shimLog });
}

/** Add the shim's pid and start time to launch.json (atomic rewrite of the record written before the spawn). */
function recordShimIdentity(workerDir: string, launch: LaunchRecord, pid: number): void {
  let procStart: string | null = null;
  try {
    procStart = processStartTime(pid);
  } catch {
    procStart = null;
  }
  atomicWriteJson(join(workerDir, LAUNCH_FILE), { ...launch, pid, procStart }, 0o600);
}

/**
 * The handle of a launch that already happened in this directory. A launch
 * whose task has ended (or was lost) is refused: starting it again would be
 * a second worker under the same id, so the attempt must be archived first.
 */
export async function reattachLaunch(provider: string, workerDir: string, workerId: string, clock: Clock = systemClock): Promise<TaskHandle> {
  const handle = await waitForHandle(provider, workerDir, null, clock);
  if (handle && taskState(handle).state === 'running') return handle;
  throw new OrbitError('TRANSITION_INVALID', `worker ${workerId} was already launched in ${workerDir} and is no longer running; archive the attempt before starting another`, {
    workerId,
    workerDir,
  });
}

/** Add reporting facts to launch.json after the spawn. */
export function recordLaunchMeta(workerDir: string, meta: Record<string, unknown>): void {
  const path = join(workerDir, LAUNCH_FILE);
  const launch = readJsonIfExists<LaunchRecord>(path);
  if (launch) atomicWriteJson(path, { ...launch, meta }, 0o600);
}

/**
 * Wait for pid.json (or exit.json, for a provider that failed to start),
 * as long as the shim is alive. `shimPid` is null when reattaching.
 */
async function waitForHandle(provider: string, workerDir: string, shimPid: number | null, clock: Clock): Promise<TaskHandle | null> {
  const deadline = clock.now() + PID_WAIT_MS;
  for (;;) {
    const handle = handleFromWorkerDir(provider, workerDir);
    if (handle) return handle;
    if (shimPid !== null && !isAlive(shimPid) && !existsSync(join(workerDir, PID_FILE))) return null;
    if (clock.now() >= deadline) return null;
    await clock.sleep(25);
  }
}

/** Rebuild a handle from pid.json alone; this is how a restarted controller reattaches. */
export function handleFromWorkerDir(provider: string, workerDir: string): TaskHandle | null {
  const pid = readPidRecord(workerDir);
  if (!pid) return null;
  return {
    provider,
    workerId: readJsonIfExists<LaunchRecord>(join(workerDir, LAUNCH_FILE))?.workerId ?? '',
    workerDir,
    pid: pid.shimPid,
    pgid: pid.pgid,
    procStart: pid.shimStart,
    logPath: join(workerDir, LOG_FILE),
    exitPath: join(workerDir, EXIT_FILE),
  };
}

export type TaskState =
  | { state: 'running'; pid: PidRecord | null }
  | { state: 'exited'; exit: ExitRecord; pid: PidRecord | null }
  | { state: 'lost'; pid: PidRecord | null; orphans: boolean; cancelRequested: boolean };

/**
 * Where a task stands from its files and the process table. A shim that is
 * gone without exit.json was killed (SIGKILL, OOM, reboot): lost. Its
 * provider process may still run, orphaned; `orphans` says so, and
 * cancelTask ends it.
 */
export function taskState(handle: Pick<TaskHandle, 'workerDir' | 'pid' | 'pgid' | 'procStart'>): TaskState {
  const pid = readPidRecord(handle.workerDir);
  const exit = readExitRecord(handle.workerDir);
  if (exit) return { state: 'exited', exit, pid };
  if (shimAlive(handle)) return { state: 'running', pid };
  // The shim may have written exit.json between the two reads.
  const late = readExitRecord(handle.workerDir);
  if (late) return { state: 'exited', exit: late, pid };
  return { state: 'lost', pid, orphans: childAlive(pid) || leftoverGroup(handle.pgid), cancelRequested: existsSync(join(handle.workerDir, CANCEL_FILE)) };
}

/**
 * The shim's group outlived it: no process has the group's id as its pid,
 * yet the group has members. A pid is not reused while a group of that id
 * exists, so those members can only be what the dead shim started (the
 * provider's helpers after the provider itself ended, or a provider whose
 * start time could not be read).
 */
function leftoverGroup(pgid: number): boolean {
  try {
    return !isAlive(pgid) && isGroupAlive(pgid);
  } catch {
    // Without a process table there is no proof the group is empty.
    return true;
  }
}

function shimAlive(handle: Pick<TaskHandle, 'pid' | 'procStart'>): boolean {
  try {
    return isAlive(handle.pid, handle.procStart);
  } catch {
    // ps unavailable: without proof of death, keep treating it as running.
    return true;
  }
}

function childAlive(pid: PidRecord | null): boolean {
  if (!pid || pid.childPid === null) return false;
  try {
    return isAlive(pid.childPid, pid.childStart);
  } catch {
    return true;
  }
}

/**
 * Cancel by process group: SIGINT (the provider ends its turn), SIGTERM,
 * SIGKILL. The intent is written first. The group is signalled only while
 * the shim or the provider is provably the process we started.
 */
export async function cancelShim(handle: TaskHandle, graceMs: number, clock: Clock = systemClock): Promise<void> {
  if (!existsSync(join(handle.workerDir, CANCEL_FILE))) {
    atomicWriteJson(join(handle.workerDir, CANCEL_FILE), { version: 1, requestedAt: clock.now() }, 0o600);
  }
  const pid = readPidRecord(handle.workerDir);
  if (!shimAliveStrict(handle) && !childAlive(pid) && !leftoverGroupStrict(handle.pgid)) return;
  if (!isGroupAlive(handle.pgid)) return;
  await terminateGroup(handle.pgid, graceMs, { clock });
}

/** leftoverGroup for signalling: without proof the group is ours, nothing is signalled. */
function leftoverGroupStrict(pgid: number): boolean {
  try {
    return !isAlive(pgid) && isGroupAlive(pgid);
  } catch {
    return false;
  }
}

function shimAliveStrict(handle: Pick<TaskHandle, 'pid' | 'procStart'>): boolean {
  try {
    return isAlive(handle.pid, handle.procStart);
  } catch {
    return false;
  }
}

export interface LogLines {
  /** Parsed JSON objects in file order. */
  events: Record<string, unknown>[];
  /** Non-empty lines that were not JSON objects. */
  malformed: string[];
  /** True when the last non-empty line was not a JSON object (a torn or garbage tail). */
  malformedTail: boolean;
}

/** Parse a whole JSONL log; unknown shapes are kept, garbage is counted, nothing throws. */
export function readLogLines(path: string, maxBytes = 64 * 1024 * 1024): LogLines {
  const buf = readFrom(path, 0, maxBytes);
  return parseJsonLines(buf ? buf.toString('utf8') : '');
}

export function parseJsonLines(text: string): LogLines {
  const out: LogLines = { events: [], malformed: [], malformedTail: false };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const o = tryParse(line);
    if (o) {
      out.events.push(o);
      out.malformedTail = false;
    } else {
      out.malformed.push(line.length > 200 ? `${line.slice(0, 200)}...` : line);
      out.malformedTail = true;
    }
  }
  return out;
}

/** Complete lines appended since `offset`; a partial last line is left for the next call. */
export function readNewLines(path: string, offset: number): { lines: Record<string, unknown>[]; nextOffset: number } {
  const buf = readFrom(path, offset);
  if (!buf || buf.length === 0) return { lines: [], nextOffset: offset };
  const end = buf.lastIndexOf(0x0a);
  if (end === -1) return { lines: [], nextOffset: offset };
  const lines: Record<string, unknown>[] = [];
  for (const raw of buf.subarray(0, end).toString('utf8').split('\n')) {
    const o = tryParse(raw.trim());
    if (o) lines.push(o);
  }
  return { lines, nextOffset: offset + end + 1 };
}

function tryParse(line: string): Record<string, unknown> | null {
  if (!line.startsWith('{')) return null;
  try {
    const o = JSON.parse(line) as unknown;
    return o !== null && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Every file one attempt leaves in its worker directory: the shim's, and the
 * adapters' inputs and outputs (prompt, system prompt, settings, schema,
 * Codex's -o file, the classified result.json). All of them move, so nothing
 * of an earlier attempt can be read as the next one's (a stale result.json
 * beside a new attempt that failed to start would be stale evidence).
 */
export const ATTEMPT_FILES: readonly string[] = [
  LAUNCH_FILE,
  PID_FILE,
  EXIT_FILE,
  LOG_FILE,
  STDERR_FILE,
  SHIM_LOG_FILE,
  CANCEL_FILE,
  'result.json',
  'prompt.md',
  'system.md',
  'settings.json',
  'schema.json',
  'last-message.json',
];

/**
 * Move a finished attempt's files into attempts/<n>/ so the same worker
 * directory can host a restart (storage planWorkerRestart). Refuses while
 * the attempt still runs.
 */
export function archiveAttempt(provider: string, workerDir: string): string | null {
  const handle = handleFromWorkerDir(provider, workerDir);
  const st = handle ? taskState(handle) : null;
  if (st?.state === 'running') {
    throw new OrbitError('TRANSITION_INVALID', `the attempt in ${workerDir} is still running; cancel it before archiving`, { workerDir });
  }
  // A lost shim can leave its provider running. Archiving would let a
  // restart start a second worker in the same worktree beside it.
  if (st?.state === 'lost' && st.orphans) {
    throw new OrbitError('TRANSITION_INVALID', `the shim of the attempt in ${workerDir} is gone but its provider process is still running; cancel it before archiving`, { workerDir });
  }
  const files = ATTEMPT_FILES.filter((f) => existsSync(join(workerDir, f)));
  if (files.length === 0) return null;
  let n = 1;
  while (existsSync(join(workerDir, 'attempts', String(n)))) n++;
  const dest = join(workerDir, 'attempts', String(n));
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  for (const f of files) renameSync(join(workerDir, f), join(dest, f));
  return dest;
}

/** How many attempts archiveAttempt has moved aside in this worker directory: the number of the attempt about to start. */
export function archivedAttempts(workerDir: string): number {
  let n = 0;
  while (existsSync(join(workerDir, 'attempts', String(n + 1)))) n++;
  return n;
}

/**
 * The session id the next launch in `workerDir` uses: one per attempt,
 * because the CLI refuses a --session-id it has already seen ("Session ID
 * ... is already in use", verified with 2.1.288), so a restart that reused
 * attempt 0's id would fail every time.
 */
export function nextSessionId(workerId: string, workerDir: string): string {
  return sessionIdFor(workerId, archivedAttempts(workerDir));
}

/**
 * Deterministic session id for a worker attempt, so the controller can
 * persist it before spawning (it is a function of ids it already stored) and
 * a restarted controller derives the same one. Formatted as a version 4 UUID,
 * which `--session-id` requires.
 */
export function sessionIdFor(workerId: string, attempt = 0): string {
  const h = createHash('sha256').update(`orbit-session:${workerId}:${attempt}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x40;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}
