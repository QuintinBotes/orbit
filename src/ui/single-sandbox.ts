import { readFileSync } from 'node:fs';

/**
 * UI checks with the application and the browser in one sandbox (docs/decisions/0001-runtime-choices.md, "Browsers
 * under sandbox-runtime on macOS", Linux paragraph).
 *
 * Under sandbox-runtime on Linux every srt process gets its own network namespace: an application started by the app
 * fixture in one srt process listens on a loopback that the readiness probe, a browser in a second srt process and the
 * host all reach as ECONNREFUSED. For a provider that says so (IsolationProvider.privateLoopback), the UI runner wraps
 * one Orbit-owned launcher per journey check instead. Inside that one sandbox the launcher starts the application,
 * waits until it is ready, runs the Playwright check, and stops the application, all under the same profile rules:
 * the write allowlist, the credential read-denies and the egress filter, with loopback private to the sandbox.
 *
 * The launcher is passed to node as source (`--eval`), so it needs no file of its own in the plugin bundle. Its
 * instructions travel in one environment variable that it removes before starting anything. What it reports goes to a
 * status file in the run's application directory; that directory is writable from inside the sandbox, so the record can
 * only ever turn a run into an error (an application that "did not start"), never into a pass: the verdict still comes
 * from the Playwright report and the exit status.
 */

/** Recorded in UiCheckRun.isolationAdjustments for a check that ran this way. */
export const UI_SINGLE_SANDBOX = 'ui-single-sandbox';

/** Disclosed with the evidence of every run that used the mode under sandbox-runtime (Linux). */
export const UI_SINGLE_SANDBOX_LIMITATION =
  'UI checks under sandbox-runtime on Linux: every srt sandbox has its own network namespace, so the application under test and the journey check run in one sandbox (an Orbit launcher starts the application, waits until it is ready, runs Playwright and stops the application). ' +
  "srt's write allowlist, credential read-denies and egress filter apply to both, and loopback is private to that sandbox. " +
  "What this widens: the application gets the journey check's network hosts and writable paths, and the journeys can read the application's environment and files and signal its processes.";

/** The same disclosure under the container provider, whose containers run with no network at all. */
export const UI_SINGLE_CONTAINER_LIMITATION =
  'UI checks under the container provider: every container runs with --network none and so has its own loopback, so the application under test and the journey check run in one container (an Orbit launcher, run by the image\'s node, starts the application, waits until it is ready, runs Playwright and stops the application). ' +
  'The container\'s mounts, read-only root, dropped capabilities and resource limits apply to both. ' +
  "What this widens: the application gets the journey check's writable paths, and the journeys can read the application's environment and files and signal its processes.";

/** The disclosure for the provider a single-sandbox check ran under. */
export function singleSandboxLimitation(kind: string): string {
  return kind === 'container' ? UI_SINGLE_CONTAINER_LIMITATION : UI_SINGLE_SANDBOX_LIMITATION;
}

/** The environment variable that carries the launch spec into the sandbox. */
export const LAUNCH_ENV = 'ORBIT_UI_LAUNCH';
/** The launcher's record, beside app.log in the run's application directory. */
export const LAUNCH_STATUS_FILE = 'launch.json';
/** The launcher's exit code when the application could not be started or did not become ready. */
export const LAUNCH_APP_FAILED_EXIT = 98;

export interface LaunchSpec {
  baseUrl: string;
  readyTimeoutMs: number;
  pollMs: number;
  requestTimeoutMs: number;
  /** Grace period of each stop signal (SIGINT, then SIGTERM, then SIGKILL). */
  graceMs: number;
  statusPath: string;
  app: {
    argv: string[];
    cwd: string;
    /** The application's own environment values, set over the launcher's. */
    env: Record<string, string>;
    /** Names only the journey check has (its own env, the report path): removed before the application starts. */
    dropEnv: string[];
    logPath: string;
  };
  check: { argv: string[]; cwd: string };
}

export type LaunchAppState = 'port_in_use' | 'spawn_failed' | 'exited' | 'ready_timeout' | 'ready' | 'stopped';

export interface LaunchStatus {
  app: LaunchAppState;
  /** HTTP status of whatever already answered (port_in_use). */
  status?: number;
  code?: number | null;
  signal?: string | null;
  detail?: string;
  readyMs?: number;
  /** stopped: the application had exited on its own before the journeys finished. */
  exitedDuringCheck?: boolean;
}

const STATES: ReadonlySet<string> = new Set(['port_in_use', 'spawn_failed', 'exited', 'ready_timeout', 'ready', 'stopped']);
const FAILED: ReadonlySet<LaunchAppState> = new Set(['port_in_use', 'spawn_failed', 'exited', 'ready_timeout']);

/** Whether the record says the application never got to serve the journeys. */
export function launchFailed(status: LaunchStatus | null): boolean {
  return status !== null && FAILED.has(status.app);
}

/** The launcher's record, or null when there is none or it is not one (written from inside the sandbox). */
export function readLaunchStatus(path: string): LaunchStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const r = parsed as Record<string, unknown>;
  if (typeof r.app !== 'string' || !STATES.has(r.app)) return null;
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined);
  const out: LaunchStatus = { app: r.app as LaunchAppState };
  if (num(r.status) !== undefined) out.status = num(r.status);
  if (r.code === null || num(r.code) !== undefined) out.code = r.code === null ? null : num(r.code);
  if (r.signal === null || typeof r.signal === 'string') out.signal = r.signal === null ? null : str(r.signal, 20);
  if (str(r.detail, 300) !== undefined) out.detail = str(r.detail, 300);
  if (num(r.readyMs) !== undefined) out.readyMs = num(r.readyMs);
  if (typeof r.exitedDuringCheck === 'boolean') out.exitedDuringCheck = r.exitedDuringCheck;
  return out;
}

/** Why the application did not serve the journeys, in the app fixture's words. */
export function describeLaunchFailure(status: LaunchStatus, spec: Pick<LaunchSpec, 'baseUrl' | 'readyTimeoutMs'>): string {
  switch (status.app) {
    case 'port_in_use':
      return `something already answers at ${spec.baseUrl} inside the sandbox (HTTP ${status.status ?? '?'}); refusing to test a server Orbit did not start`;
    case 'spawn_failed':
      return `the application could not be started: ${status.detail ?? 'unknown error'}`;
    case 'exited':
      return `the application exited before it became ready (${status.signal ? `signal ${status.signal}` : `exit ${status.code ?? '?'}`})`;
    case 'ready_timeout':
      return `the application was not ready at ${spec.baseUrl} within ${spec.readyTimeoutMs} ms`;
    default:
      return `the application did not start (${status.app})`;
  }
}

/** The command the provider wraps: node running the launcher, which reads its spec from LAUNCH_ENV. */
export function launcherArgv(nodePath: string = process.execPath): string[] {
  return [nodePath, '--eval', LAUNCHER_SOURCE];
}

/**
 * The launcher (CommonJS, for `node --eval`). Plain JavaScript on purpose: it runs inside the sandbox with whatever node
 * the provider starts, and must not depend on Orbit's modules.
 *
 * - The application gets its own process group, so stopping it reaches everything it started; the stop is SIGINT,
 *   SIGTERM, SIGKILL with a grace period each, like the app fixture's.
 * - A signal to the launcher (the runner's timeout or cancel) stops the check and the application before it exits.
 * - The Playwright check inherits the launcher's output, so its log is the check's log as before; the application's
 *   output goes to app.log.
 * - The exit code is the check's own, or LAUNCH_APP_FAILED_EXIT when the application never served it.
 */
export const LAUNCHER_SOURCE = `'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const spec = JSON.parse(process.env.${LAUNCH_ENV});
delete process.env.${LAUNCH_ENV};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const record = (status) => { try { fs.writeFileSync(spec.statusPath, JSON.stringify(status) + '\\n', { mode: 0o600 }); } catch {} };
const isReady = (s) => (s >= 200 && s < 400) || (s >= 400 && s <= 403);
async function probe() {
  try {
    const res = await fetch(spec.baseUrl, { redirect: 'manual', signal: AbortSignal.timeout(spec.requestTimeoutMs) });
    if (res.body) await res.body.cancel().catch(() => {});
    return res.status;
  } catch { return null; }
}
let app = null;
let appExit = null;
let check = null;
const groupAlive = () => { if (!app || !app.pid) return false; try { process.kill(-app.pid, 0); return true; } catch { return false; } };
const signalApp = (sig) => { if (app && app.pid) { try { process.kill(-app.pid, sig); } catch {} } };
async function stopApp(graceMs) {
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGKILL']) {
    if (!groupAlive()) return true;
    signalApp(sig);
    const until = Date.now() + graceMs;
    while (Date.now() < until && groupAlive()) await sleep(20);
  }
  return !groupAlive();
}
const fail = async (status) => { record(status); await stopApp(Math.min(spec.graceMs, 500)); process.exit(${LAUNCH_APP_FAILED_EXIT}); };
let stopping = false;
const onSignal = (sig) => {
  if (stopping) return;
  stopping = true;
  if (check && check.exitCode === null) { try { check.kill(sig); } catch {} }
  stopApp(Math.min(spec.graceMs, 300)).finally(() => process.exit(128 + (os.constants.signals[sig] || 15)));
};
process.on('SIGTERM', () => onSignal('SIGTERM'));
process.on('SIGINT', () => onSignal('SIGINT'));
process.on('exit', () => signalApp('SIGKILL'));
(async () => {
  const before = await probe();
  if (before !== null) return fail({ app: 'port_in_use', status: before });
  const env = Object.assign({}, process.env);
  for (const name of spec.app.dropEnv) delete env[name];
  Object.assign(env, spec.app.env);
  const log = fs.openSync(spec.app.logPath, 'a', 0o600);
  try {
    app = spawn(spec.app.argv[0], spec.app.argv.slice(1), { cwd: spec.app.cwd, env, detached: true, stdio: ['ignore', log, log] });
  } catch (e) {
    fs.closeSync(log);
    return fail({ app: 'spawn_failed', detail: String(e && e.message) });
  }
  fs.closeSync(log);
  app.on('error', (e) => { appExit = appExit || { code: null, signal: null, detail: String(e && e.message) }; });
  app.on('exit', (code, signal) => { appExit = appExit || { code, signal }; });
  const started = Date.now();
  const deadline = started + spec.readyTimeoutMs;
  for (;;) {
    if (appExit) return fail(appExit.detail && appExit.code === null && appExit.signal === null ? { app: 'spawn_failed', detail: appExit.detail } : { app: 'exited', code: appExit.code, signal: appExit.signal });
    const s = await probe();
    if (s !== null && isReady(s)) break;
    if (Date.now() >= deadline) return fail({ app: 'ready_timeout' });
    await sleep(spec.pollMs);
  }
  const readyMs = Date.now() - started;
  record({ app: 'ready', readyMs });
  if (stopping) return;
  check = spawn(spec.check.argv[0], spec.check.argv.slice(1), { cwd: spec.check.cwd, env: process.env, stdio: 'inherit' });
  const result = await new Promise((resolve) => {
    check.on('error', (e) => { process.stderr.write('[orbit] the journey check could not be started: ' + String(e && e.message) + '\\n'); resolve({ code: 127, signal: null }); });
    check.on('exit', (code, signal) => resolve({ code, signal }));
  });
  if (stopping) return;
  const exitedDuringCheck = appExit !== null;
  await stopApp(spec.graceMs);
  record({ app: 'stopped', readyMs, exitedDuringCheck, code: appExit ? appExit.code : null, signal: appExit ? appExit.signal : null });
  process.exit(result.code !== null ? result.code : 128 + (os.constants.signals[result.signal] || 0));
})().catch((e) => { process.stderr.write('[orbit] launcher: ' + String(e && e.stack || e) + '\\n'); process.exit(70); });
`;
