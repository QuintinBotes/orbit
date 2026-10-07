import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { systemClock, type Clock } from '../core/clock.ts';
import { OrbitError } from '../core/errors.ts';
import { spawnDetached } from '../core/exec.ts';
import { atomicWriteJson, ensureDir, readJsonIfExists } from '../core/fsx.ts';
import { isAlive, isGroupAlive, processStartTime, terminateGroup } from '../core/proc.ts';
import { redact } from '../core/redact.ts';
import type { IsolationProvider, SandboxProfile } from '../isolation/types.ts';
import { safeBaseEnv } from './env.ts';

/**
 * The application under test (spec section 13, Isolation): started through
 * the isolation provider, in its own process group, with a state file that
 * lets a restarted controller find and stop it. A server left running keeps
 * its port, and the next run would then test whatever answers there.
 */

export interface AppIsolation {
  provider: IsolationProvider;
  /** The caller's profile; startApp adds allowLocalBinding itself (see there). */
  profile: SandboxProfile;
}

export interface StartAppOptions {
  command: string[];
  cwd: string;
  baseUrl: string;
  readyTimeoutMs: number;
  /** Added to the safe base environment (see env.ts). */
  env?: Record<string, string>;
  isolation: AppIsolation;
  /** Spec: refuse non-loopback base URLs when isolated test data is required. Default true. */
  isolatedTestData?: boolean;
  /** Where app.json and app.log go; created if missing. */
  stateDir: string;
  clock?: Clock;
  pollMs?: number;
  /** Per-probe timeout. */
  requestTimeoutMs?: number;
  /** Replaces fetch in tests of the readiness loop. */
  probe?: (url: string, timeoutMs: number) => Promise<number | null>;
  /** Source of the safe base environment; defaults to process.env. */
  hostEnv?: Readonly<Record<string, string | undefined>>;
  /**
   * Asked on every look while the application is not ready yet: a reason to stop it now, or null. For a sandbox denial
   * its toolchain would otherwise wait out (an MSBuild worker node refused its named pipe, ui/app-toolchains.ts), which no
   * readiness probe can see. Asked once more, with `exited`, when it exited before it was ready, for the reason's sake.
   */
  stopWhen?: (exited: boolean) => string | null;
}

export interface AppState {
  state: 'starting' | 'running' | 'stopped';
  command: string[];
  cwd: string;
  baseUrl: string;
  startedAt: number;
  pid: number | null;
  pgid: number | null;
  /** Process start time, so a reused pid is never mistaken for the app. */
  start: string | null;
  logPath: string;
  stoppedAt?: number;
}

export interface AppHandle {
  pid: number;
  pgid: number;
  baseUrl: string;
  stateFile: string;
  logPath: string;
  limitations: string[];
}

export const APP_STATE_FILE = 'app.json';
export const APP_LOG_FILE = 'app.log';
const LOG_TAIL_BYTES = 2_000;

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h.endsWith('.localhost')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return v4 !== null && Number(v4[1]) === 127 && v4.slice(1).every((p) => Number(p) <= 255);
}

/**
 * The base URL must be a plain http(s) URL without credentials. With isolated
 * test data required it must also be loopback: a base URL on another host
 * means the journeys would drive a shared or production system.
 */
export function assertBaseUrl(baseUrl: string, isolatedTestData: boolean): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new OrbitError('CONFIG_INVALID', `ui.environment.base_url is not a URL: ${JSON.stringify(baseUrl)}`, { baseUrl });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OrbitError('CONFIG_INVALID', `ui.environment.base_url must be http or https, got ${url.protocol}`, { baseUrl });
  }
  if (url.username || url.password) {
    throw new OrbitError('CONFIG_INVALID', 'ui.environment.base_url must not carry credentials', { baseUrl: `${url.protocol}//${url.host}` });
  }
  if (isolatedTestData && !isLoopbackHost(url.hostname)) {
    throw new OrbitError('POLICY_DENIED', `isolated_test_data is required, so base_url must be a loopback address (127.0.0.0/8, ::1, localhost); got host ${url.hostname}`, {
      rule: 'ui.environment.isolated_test_data',
      host: url.hostname,
    });
  }
  return url;
}

/** Playwright's readiness rule: 2xx and 3xx, and 400 to 403, mean something is serving. */
export function isReadyStatus(status: number): boolean {
  return (status >= 200 && status < 400) || (status >= 400 && status <= 403);
}

async function fetchStatus(url: string, timeoutMs: number): Promise<number | null> {
  try {
    // 'manual': a redirect means the app answered; following it could leave the base URL.
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel().catch(() => {});
    return res.status;
  } catch {
    return null;
  }
}

/** The end of an application log, redacted; empty when it cannot be read. */
export function logTail(path: string): string {
  try {
    const size = statSync(path).size;
    const len = Math.min(size, LOG_TAIL_BYTES);
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      return redact(buf.toString('utf8'));
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}

export async function startApp(opts: StartAppOptions): Promise<AppHandle> {
  const clock = opts.clock ?? systemClock;
  const probe = opts.probe ?? fetchStatus;
  const pollMs = Math.max(10, opts.pollMs ?? 200);
  const requestTimeout = opts.requestTimeoutMs ?? 2_000;
  assertBaseUrl(opts.baseUrl, opts.isolatedTestData !== false);
  if (opts.command.length === 0) throw new OrbitError('CONFIG_INVALID', 'ui.environment.start_command is empty');

  // An app a crashed controller left behind (state file still "running") is stopped first; without this the port
  // check below would refuse every later run until someone killed it by hand.
  const priorState = join(opts.stateDir, APP_STATE_FILE);
  const outcome = await reconcileApp(priorState, { clock });
  if (outcome === 'still-running') {
    throw new OrbitError('CONFIG_INVALID', `an application started by an earlier run (state ${priorState}) would not stop; refusing to start another`, { reason: 'previous_app_running', stateFile: priorState });
  }

  // A server Orbit did not start would make every readiness check pass and every journey test something else.
  const existing = await probe(opts.baseUrl, requestTimeout);
  if (existing !== null) {
    throw new OrbitError('CONFIG_INVALID', `something already answers at ${opts.baseUrl} (HTTP ${existing}); refusing to test a server Orbit did not start`, { reason: 'port_in_use', status: existing });
  }

  ensureDir(opts.stateDir);
  const stateFile = join(opts.stateDir, APP_STATE_FILE);
  const logPath = join(opts.stateDir, APP_LOG_FILE);
  const startedAt = clock.now();
  const base: Omit<AppState, 'state' | 'pid' | 'pgid' | 'start'> = { command: opts.command, cwd: opts.cwd, baseUrl: opts.baseUrl, startedAt, logPath };
  // Intent first: a crash between spawn and the next write leaves a record saying an app may exist.
  atomicWriteJson(stateFile, { ...base, state: 'starting', pid: null, pgid: null, start: null } satisfies AppState);

  const env = { ...safeBaseEnv(opts.hostEnv ?? process.env), ...(opts.env ?? {}) };
  // An application under test exists to listen on loopback, so startApp grants allowLocalBinding itself
  // rather than trusting every caller to remember it (a profile without it makes the app fail to bind under srt).
  // Chromium's Mach rules are for a UI check's browser only, never the application under test.
  const profile: SandboxProfile = { ...opts.isolation.profile, allowLocalBinding: true, chromiumMachRendezvous: false };
  // The log is handed to the app as its stdout and stderr. It lives in the run's evidence directory, which profiles
  // read-deny, and a sandboxed node aborts at startup when it holds a descriptor it may not read (WrapOptions.stdioFiles),
  // so the file exists before the wrap and the provider is told about it.
  closeSync(openSync(logPath, 'a', 0o600));
  const wrapped = opts.isolation.provider.wrap(opts.command, profile, { cwd: opts.cwd, env, stdioFiles: [logPath] });
  let spawned: { pid: number; pgid: number };
  try {
    spawned = spawnDetached(wrapped.argv, { cwd: opts.cwd, env: wrapped.env, stdoutPath: logPath, stderrPath: logPath });
  } catch (err) {
    wrapped.cleanup();
    throw err;
  }
  let start: string | null = null;
  try {
    start = processStartTime(spawned.pid);
  } catch {
    /* ps unavailable; liveness checks fall back to signal 0 */
  }
  atomicWriteJson(stateFile, { ...base, state: 'running', pid: spawned.pid, pgid: spawned.pgid, start } satisfies AppState);
  const handle: AppHandle = { pid: spawned.pid, pgid: spawned.pgid, baseUrl: opts.baseUrl, stateFile, logPath, limitations: wrapped.limitations };

  const deadline = clock.now() + opts.readyTimeoutMs;
  try {
    for (;;) {
      if (!groupAlive(spawned.pgid)) {
        const why = opts.stopWhen?.(true) ?? null;
        throw new OrbitError('INTERNAL', `the application exited before it became ready: ${logTail(logPath).trim() || '(no output)'}${why ? `; ${why}` : ''}`, { reason: 'app_exited', logPath });
      }
      const stop = opts.stopWhen?.(false) ?? null;
      if (stop !== null) throw new OrbitError('INTERNAL', `the application was stopped before it became ready: ${stop}`, { reason: 'app_stopped', logPath });
      const status = await probe(opts.baseUrl, requestTimeout);
      if (status !== null && isReadyStatus(status)) return handle;
      if (clock.now() >= deadline) {
        throw new OrbitError('INTERNAL', `the application was not ready at ${opts.baseUrl} within ${opts.readyTimeoutMs} ms: ${logTail(logPath).trim() || '(no output)'}`, { reason: 'ready_timeout', logPath });
      }
      await clock.sleep(pollMs);
    }
  } catch (err) {
    await stopApp(handle, { clock });
    throw err;
  } finally {
    // The wrapper's settings files are read at launch; the app keeps running without them.
    wrapped.cleanup();
  }
}

function groupAlive(pgid: number): boolean {
  try {
    return isGroupAlive(pgid);
  } catch {
    return false;
  }
}

/**
 * Stop the application's process group: SIGINT, SIGTERM, SIGKILL with a grace
 * period each. Safe to call twice, and a no-op for a group that is already gone.
 */
export async function stopApp(handle: Pick<AppHandle, 'pgid' | 'stateFile'>, opts: { graceMs?: number; clock?: Clock } = {}): Promise<{ exited: boolean }> {
  const state = readJsonIfExists<AppState>(handle.stateFile);
  // Real time on purpose: the grace period waits for a real process, whatever clock the caller injected for deadlines.
  let result: Awaited<ReturnType<typeof terminateGroup>> | undefined;
  for (let attempt = 0; result === undefined; attempt++) {
    try {
      result = await terminateGroup(handle.pgid, opts.graceMs ?? 2_000);
    } catch (err) {
      // macOS answers EPERM to a signal sent to a group whose only process is still inside fork/exec.
      if (attempt >= 5 || !(err instanceof OrbitError && err.code === 'INTERNAL')) throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (state) atomicWriteJson(handle.stateFile, { ...state, state: 'stopped', stoppedAt: (opts.clock ?? systemClock).now() } satisfies AppState);
  return { exited: result.exited };
}

export type ReconcileOutcome = 'none' | 'already-stopped' | 'stopped' | 'foreign-process' | 'still-running';

/**
 * Called by a restarted controller (and before a run) for a state file left
 * by an earlier incarnation. It stops the app only when the recorded process
 * is demonstrably the one Orbit started: a pid whose start time differs now
 * belongs to something else and is left alone.
 */
export async function reconcileApp(stateFile: string, opts: { graceMs?: number; clock?: Clock } = {}): Promise<ReconcileOutcome> {
  const state = readJsonIfExists<AppState>(stateFile);
  if (!state) return 'none';
  if (state.state === 'stopped') return 'already-stopped';
  if (state.pid === null || state.pgid === null) {
    // Crashed between the intent record and the spawn record: nothing we can identify to stop.
    atomicWriteJson(stateFile, { ...state, state: 'stopped', stoppedAt: (opts.clock ?? systemClock).now() } satisfies AppState);
    return 'already-stopped';
  }
  const leaderAlive = isAlive(state.pid, state.start);
  const anyoneAtPid = isAlive(state.pid);
  if (!leaderAlive && anyoneAtPid) return 'foreign-process';
  if (!groupAlive(state.pgid)) {
    atomicWriteJson(stateFile, { ...state, state: 'stopped', stoppedAt: (opts.clock ?? systemClock).now() } satisfies AppState);
    return 'already-stopped';
  }
  const { exited } = await stopApp({ pgid: state.pgid, stateFile }, opts);
  return exited ? 'stopped' : 'still-running';
}
