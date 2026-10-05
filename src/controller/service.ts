/**
 * Persistent execution (spec section 4): a launchd user agent on macOS and a
 * systemd user unit on Linux, each running `orbit service run --repo <root>`
 * for one repository. Command shapes and exit codes are the verified ones in
 * docs/interfaces/platform-runtime.md and gaps-and-contradictions.md (V7):
 *
 *   launchctl bootout gui/<uid>/<label>    0, or 3 when not loaded (accepted)
 *   launchctl bootstrap gui/<uid> <plist>  0, or 5 when already loaded (then kickstart -k)
 *   launchctl print gui/<uid>/<label>      0 loaded, 113 not loaded; the output is never parsed
 *
 * Both definitions restart only on failure, throttle restarts, log under
 * ~/.orbit/logs (created 0700 first), and leave workers alone when the
 * controller stops: workers run in their own session and process group, so a
 * launchd job kill does not reach them, and the systemd unit uses
 * KillMode=process (docs/decisions/0001) so the cgroup is not swept either.
 * The next controller reattaches to them.
 *
 * Neither definition names the bundle. The plugin's bundle sits under a versioned path that changes on every plugin
 * update, so a definition that recorded it would silently break at the next update. Both start a stable launcher,
 * ~/.orbit/bin/orbit, a three-line shell script that execs the current node on the current bundle. Install writes it,
 * and the CLI refreshes it whenever it runs from a different bundle or node (refreshLauncher), so an update needs no
 * reinstall. The launcher is a sibling of worktrees/, not inside any path a worker may write, and ~/.orbit is on the
 * read-deny list of every profile (isolation/profiles.ts HOME_DENY_READ).
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { atomicWrite } from '../core/fsx.ts';
import { execCapture } from '../core/exec.ts';
import { OrbitError } from '../core/errors.ts';
import { isAlive } from '../core/proc.ts';
import type { Clock } from '../core/clock.ts';
import type { OrbitDb } from '../storage/db.ts';
import { listControllers, markControllerStopped } from '../storage/controllers.ts';
import { repoKey } from './context.ts';

export const SERVICE_LABEL_PREFIX = 'dev.orbit.controller';

export interface ServiceSpec {
  label: string;
  /** What the definition starts: the stable launcher, whose content (not the definition) names the bundle and node. */
  launcher: string;
  /** Absolute: PATH may hold several Node versions (platform-runtime section 7.4). Written into the launcher. */
  nodePath: string;
  /** Absolute path of the bundle (plugin/dist/orbit.mjs in a checkout, dist/orbit.mjs under the plugin root). Written into the launcher. */
  entry: string;
  args: string[];
  workingDirectory: string;
  logDir: string;
  env: Record<string, string>;
  throttleSeconds: number;
  stopTimeoutSeconds: number;
}

export interface ServiceSpecInput {
  repoRoot: string;
  orbitHome: string;
  entry: string;
  nodePath?: string;
  path?: string;
}

export function serviceLabel(repoRoot: string): string {
  return `${SERVICE_LABEL_PREFIX}.${repoKey(repoRoot)}`;
}

export function serviceSpec(input: ServiceSpecInput): ServiceSpec {
  return {
    label: serviceLabel(input.repoRoot),
    launcher: launcherPath(input.orbitHome),
    nodePath: input.nodePath ?? process.execPath,
    entry: input.entry,
    args: ['service', 'run', '--repo', input.repoRoot],
    workingDirectory: input.repoRoot,
    logDir: join(input.orbitHome, 'logs'),
    env: {
      PATH: input.path ?? '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      NODE_OPTIONS: '--disable-warning=ExperimentalWarning',
      ORBIT_HOME: input.orbitHome,
    },
    throttleSeconds: 10,
    stopTimeoutSeconds: 30,
  };
}

// ---------------------------------------------------------------------------
// The stable launcher

const LAUNCHER_MARK = '# orbit-launcher v1';

export function launcherPath(orbitHome: string): string {
  return join(orbitHome, 'bin', 'orbit');
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function renderLauncher(target: { node: string; entry: string }): string {
  for (const v of [target.node, target.entry]) {
    if (!isAbsolute(v) || /[\n\r\0]/.test(v)) throw new OrbitError('CONFIG_INVALID', `the launcher needs absolute paths without line breaks, got ${JSON.stringify(v)}`);
  }
  return [
    '#!/bin/sh',
    LAUNCHER_MARK,
    '# Written by orbit (service install, and whenever orbit runs from another install). Do not edit: it is rewritten.',
    `# node: ${target.node}`,
    `# entry: ${target.entry}`,
    `exec ${shQuote(target.node)} ${shQuote(target.entry)} "$@"`,
    '',
  ].join('\n');
}

/** The node and bundle a launcher starts, or null when there is no launcher or Orbit did not write it. */
export function readLauncher(path: string): { node: string; entry: string } | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  if (!text.split('\n').includes(LAUNCHER_MARK)) return null;
  const node = /^# node: (.+)$/m.exec(text)?.[1];
  const entry = /^# entry: (.+)$/m.exec(text)?.[1];
  return node && entry ? { node, entry } : null;
}

/**
 * The launcher directory must be one only this user can change: whoever can write it can run code as the service.
 * ~/.orbit and ~/.orbit/bin are created 0700; an existing one that is owned by this user has group and world write
 * removed; one owned by anybody else, or reached through a symbolic link, is refused.
 */
function secureLauncherDir(orbitHome: string): void {
  const uid = process.getuid?.();
  mkdirSync(orbitHome, { recursive: true, mode: 0o700 });
  const home = statSync(orbitHome);
  if (uid !== undefined && home.uid !== uid) throw new OrbitError('CONFIG_INVALID', `${orbitHome} is not owned by this user; refusing to put the service launcher in it`, { path: orbitHome });
  if ((home.mode & 0o022) !== 0) chmodSync(orbitHome, home.mode & 0o755 & ~0o022);
  const bin = join(orbitHome, 'bin');
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  const st = lstatSync(bin);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new OrbitError('CONFIG_INVALID', `${bin} must be a real directory, not a link or a file; refusing to put the service launcher in it`, { path: bin });
  if (uid !== undefined && st.uid !== uid) throw new OrbitError('CONFIG_INVALID', `${bin} is not owned by this user; refusing to put the service launcher in it`, { path: bin });
  if ((st.mode & 0o077) !== 0) chmodSync(bin, 0o700);
}

/** Write the launcher: a temporary file renamed over the old one, mode 0700, so a starting service sees the old or the new, never half. */
export function writeLauncher(orbitHome: string, target: { node: string; entry: string }): string {
  const content = renderLauncher(target);
  secureLauncherDir(orbitHome);
  const path = launcherPath(orbitHome);
  atomicWrite(path, content, 0o700);
  return path;
}

export type LauncherRefresh = 'absent' | 'foreign' | 'current' | 'updated' | 'skipped';

/**
 * Point an existing launcher at the bundle and node that are running now. The plugin's versioned path changes on every
 * update, so without this a service installed from the old version would start a directory that is gone. It never
 * creates a launcher (no service was installed), never touches a file Orbit did not write, and never points the
 * service at a TypeScript source entry, which only a development checkout runs.
 */
export function refreshLauncher(input: { orbitHome: string; entry: string; nodePath: string }): LauncherRefresh {
  const path = launcherPath(input.orbitHome);
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return 'absent';
  }
  const current = st.isFile() ? readLauncher(path) : null;
  if (!current) return 'foreign';
  if (!input.entry.endsWith('.mjs') || !isAbsolute(input.entry) || !existsSync(input.entry) || !isAbsolute(input.nodePath) || !existsSync(input.nodePath)) return 'skipped';
  const unchanged = current.node === input.nodePath && current.entry === input.entry && (st.mode & 0o777) === 0o700;
  if (unchanged) return 'current';
  writeLauncher(input.orbitHome, { node: input.nodePath, entry: input.entry });
  return 'updated';
}

export function logPaths(spec: Pick<ServiceSpec, 'logDir' | 'label'>): { out: string; err: string } {
  return { out: join(spec.logDir, `${spec.label}.out.log`), err: join(spec.logDir, `${spec.label}.err.log`) };
}

// ---------------------------------------------------------------------------
// launchd

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function renderLaunchdPlist(spec: ServiceSpec): string {
  const logs = logPaths(spec);
  const str = (v: string) => `<string>${xml(v)}</string>`;
  const env = Object.entries(spec.env)
    .map(([k, v]) => `      <key>${xml(k)}</key>${str(v)}`)
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>${str(spec.label)}`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...[spec.launcher, ...spec.args].map((a) => `    ${str(a)}`),
    '  </array>',
    `  <key>WorkingDirectory</key>${str(spec.workingDirectory)}`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    env,
    '  </dict>',
    '  <key>RunAtLoad</key><true/>',
    // Restart after a crash or non-zero exit only; a clean stop stays stopped.
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key><false/>',
    '  </dict>',
    `  <key>ThrottleInterval</key><integer>${spec.throttleSeconds}</integer>`,
    `  <key>ExitTimeOut</key><integer>${spec.stopTimeoutSeconds}</integer>`,
    `  <key>ProcessType</key>${str('Background')}`,
    `  <key>StandardOutPath</key>${str(logs.out)}`,
    `  <key>StandardErrorPath</key>${str(logs.err)}`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export function launchdPlistPath(homeDir: string, label: string): string {
  return join(homeDir, 'Library', 'LaunchAgents', `${label}.plist`);
}

export function launchctlCommands(label: string, uid: number, plistPath: string): Record<'bootout' | 'bootstrap' | 'kickstart' | 'print', string[]> {
  const domain = `gui/${uid}`;
  return {
    bootout: ['launchctl', 'bootout', `${domain}/${label}`],
    bootstrap: ['launchctl', 'bootstrap', domain, plistPath],
    kickstart: ['launchctl', 'kickstart', '-k', `${domain}/${label}`],
    print: ['launchctl', 'print', `${domain}/${label}`],
  };
}

// ---------------------------------------------------------------------------
// systemd

/** systemd quoting: double quotes, with backslash and double quote escaped, and % doubled (specifier escape). */
function sdQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}

export function renderSystemdUnit(spec: ServiceSpec): string {
  const logs = logPaths(spec);
  return [
    '[Unit]',
    `Description=Orbit controller (${spec.workingDirectory.replace(/\n/g, ' ')})`,
    'StartLimitIntervalSec=300',
    'StartLimitBurst=10',
    '',
    '[Service]',
    'Type=exec',
    `ExecStart=${[spec.launcher, ...spec.args].map(sdQuote).join(' ')}`,
    `WorkingDirectory=${sdQuote(spec.workingDirectory)}`,
    ...Object.entries(spec.env).map(([k, v]) => `Environment=${sdQuote(`${k}=${v}`)}`),
    'Restart=on-failure',
    `RestartSec=${Math.max(5, Math.floor(spec.throttleSeconds / 2))}`,
    `TimeoutStopSec=${spec.stopTimeoutSeconds}`,
    // Workers are detached into their own process groups; KillMode=process keeps a controller restart from killing them (ADR 0001).
    'KillMode=process',
    `StandardOutput=append:${logs.out}`,
    `StandardError=append:${logs.err}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

export function systemdUnitPath(homeDir: string, label: string): string {
  return join(homeDir, '.config', 'systemd', 'user', `${label}.service`);
}

export function systemctlCommands(label: string): Record<'daemonReload' | 'enable' | 'disable' | 'isActive', string[]> {
  const unit = `${label}.service`;
  return {
    daemonReload: ['systemctl', '--user', 'daemon-reload'],
    enable: ['systemctl', '--user', 'enable', '--now', unit],
    disable: ['systemctl', '--user', 'disable', '--now', unit],
    isActive: ['systemctl', '--user', 'is-active', unit],
  };
}

// ---------------------------------------------------------------------------
// Install, uninstall, status

export type CommandRunner = (argv: string[]) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;

export interface ServiceManagerOptions {
  platform: NodeJS.Platform;
  homeDir: string;
  uid: number;
  /** Replaceable in tests so nothing is ever loaded into the real user domain. */
  run?: CommandRunner;
  /**
   * How long uninstall waits for the service manager to let go of the job. launchd sends SIGTERM and waits up to the
   * plist's ExitTimeOut for the controller to exit, so the default is that plus a margin.
   */
  stopTimeoutMs?: number;
  /** How often uninstall asks the service manager whether the job is gone. */
  pollMs?: number;
  /** Replaceable in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Replaceable in tests. */
  now?: () => number;
}

/** launchd's ExitTimeOut (ServiceSpec.stopTimeoutSeconds) plus a margin for the job to disappear after it exits. */
export const DEFAULT_STOP_TIMEOUT_MS = (30 + 5) * 1000;
const DEFAULT_STOP_POLL_MS = 250;

export interface ServiceStatus {
  label: string;
  platform: NodeJS.Platform;
  definitionPath: string;
  installed: boolean;
  /** null when the service manager's answer could not be interpreted. */
  loaded: boolean | null;
  detail: string;
  /** Uninstall only: the definition is removed but the service manager still lists the job, so its controller is still stopping. */
  stopPending?: boolean;
}

const defaultRunner: CommandRunner = async (argv) => {
  const r = await execCapture(argv, { timeoutMs: 30_000 });
  return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
};

function unsupported(platform: string): never {
  throw new OrbitError('CONFIG_INVALID', `persistent service is supported on macOS (launchd) and Linux (systemd --user), not ${platform}; use orbit run --foreground`);
}

async function must(run: CommandRunner, argv: string[], ok: readonly number[]): Promise<number> {
  const r = await run(argv);
  if (r.exitCode === null || !ok.includes(r.exitCode)) {
    throw new OrbitError('INTERNAL', `${argv.slice(0, 3).join(' ')} failed (exit ${r.exitCode ?? 'signal'}): ${r.stderr.trim().slice(0, 300)}`, { argv });
  }
  return r.exitCode;
}

export async function installService(spec: ServiceSpec, opts: ServiceManagerOptions): Promise<ServiceStatus> {
  const run = opts.run ?? defaultRunner;
  // launchd would create log directories itself, but world-readable; create them private first (gaps V7).
  mkdirSync(spec.logDir, { recursive: true, mode: 0o700 });
  if (opts.platform !== 'darwin' && opts.platform !== 'linux') return unsupported(opts.platform);
  // The definition starts the launcher, so the launcher exists (and names this bundle) before the service manager hears of it.
  writeLauncher(dirname(dirname(spec.launcher)), { node: spec.nodePath, entry: spec.entry });
  if (opts.platform === 'darwin') {
    const plist = launchdPlistPath(opts.homeDir, spec.label);
    mkdirSync(join(opts.homeDir, 'Library', 'LaunchAgents'), { recursive: true });
    // launchd refuses a plist that is group- or world-writable.
    atomicWrite(plist, renderLaunchdPlist(spec), 0o644);
    const cmd = launchctlCommands(spec.label, opts.uid, plist);
    await must(run, cmd.bootout, [0, 3]);
    const code = await must(run, cmd.bootstrap, [0, 5]);
    // 5: still loaded (a bootout racing a running job). Restart it so the new definition's process runs.
    if (code === 5) await must(run, cmd.kickstart, [0]);
    return serviceStatus(spec.label, opts);
  }
  if (opts.platform === 'linux') {
    const unit = systemdUnitPath(opts.homeDir, spec.label);
    mkdirSync(join(opts.homeDir, '.config', 'systemd', 'user'), { recursive: true });
    atomicWrite(unit, renderSystemdUnit(spec), 0o644);
    const cmd = systemctlCommands(spec.label);
    await must(run, cmd.daemonReload, [0]);
    await must(run, cmd.enable, [0]);
    return serviceStatus(spec.label, opts);
  }
  return unsupported(opts.platform);
}

export async function uninstallService(label: string, opts: ServiceManagerOptions): Promise<ServiceStatus> {
  const run = opts.run ?? defaultRunner;
  if (opts.platform === 'darwin') {
    const plist = launchdPlistPath(opts.homeDir, label);
    await must(run, launchctlCommands(label, opts.uid, plist).bootout, [0, 3]);
    rmSync(plist, { force: true });
    return waitUntilGone(label, opts);
  }
  if (opts.platform === 'linux') {
    const unit = systemdUnitPath(opts.homeDir, label);
    const cmd = systemctlCommands(label);
    if (existsSync(unit)) await run(cmd.disable);
    rmSync(unit, { force: true });
    await must(run, cmd.daemonReload, [0]);
    return waitUntilGone(label, opts);
  }
  return unsupported(opts.platform);
}

/**
 * `launchctl bootout` returns once the stop is requested, while the controller may still be winding down (launchd
 * waits up to ExitTimeOut for it). Ask until the service manager no longer lists the job, so "uninstalled" is true
 * when it is said. A job still listed at the timeout is reported as a pending stop, never as gone.
 */
async function waitUntilGone(label: string, opts: ServiceManagerOptions): Promise<ServiceStatus> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const timeout = opts.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const poll = Math.max(1, opts.pollMs ?? Math.min(DEFAULT_STOP_POLL_MS, Math.max(1, timeout)));
  const started = now();
  let status = await serviceStatus(label, opts);
  while (status.loaded === true && now() - started < timeout) {
    await sleep(poll);
    status = await serviceStatus(label, opts);
  }
  const pending = status.loaded === true;
  return { ...status, stopPending: pending, ...(pending ? { detail: `still stopping: the service manager still lists the job after ${Math.round((now() - started) / 1000)} s` } : {}) };
}

/**
 * Foreground controllers that died without a stop record (Ctrl-C twice, kill -9, a closed terminal) stay in the
 * registry as "stale" for ever. Those of this host whose process is gone are marked stopped, which is what a stop
 * record is; a controller of another host, or a live process whose heartbeat is merely old, is left alone. Returns
 * the ids it marked.
 */
export function pruneDeadControllers(db: OrbitDb, clock: Clock): string[] {
  const host = hostname();
  const pruned: string[] = [];
  for (const c of listControllers(db)) {
    if (c.host !== host || isAlive(c.pid, c.procStart)) continue;
    markControllerStopped(db, c.id, 'process is gone (found by orbit service status)', clock);
    pruned.push(c.id);
  }
  return pruned;
}

export async function serviceStatus(label: string, opts: ServiceManagerOptions): Promise<ServiceStatus> {
  const run = opts.run ?? defaultRunner;
  if (opts.platform === 'darwin') {
    const path = launchdPlistPath(opts.homeDir, label);
    const r = await run(launchctlCommands(label, opts.uid, path).print);
    const loaded = r.exitCode === 0 ? true : r.exitCode === 113 ? false : null;
    return { label, platform: opts.platform, definitionPath: path, installed: existsSync(path), loaded, detail: loaded === null ? `launchctl print exited ${r.exitCode ?? 'by signal'}` : loaded ? 'loaded' : 'not loaded' };
  }
  if (opts.platform === 'linux') {
    const path = systemdUnitPath(opts.homeDir, label);
    // is-active exit codes are UNVERIFIED (platform-runtime section 3); its one-word answer is read instead.
    const r = await run(systemctlCommands(label).isActive);
    const word = r.stdout.trim();
    const loaded = word === 'active' || word === 'activating' || word === 'reloading' ? true : word === 'inactive' || word === 'failed' ? false : null;
    return { label, platform: opts.platform, definitionPath: path, installed: existsSync(path), loaded, detail: word || `systemctl exited ${r.exitCode ?? 'by signal'}` };
  }
  return unsupported(opts.platform);
}
