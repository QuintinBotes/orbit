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
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from '../core/fsx.ts';
import { execCapture } from '../core/exec.ts';
import { OrbitError } from '../core/errors.ts';
import { repoKey } from './context.ts';

export const SERVICE_LABEL_PREFIX = 'dev.orbit.controller';

export interface ServiceSpec {
  label: string;
  /** Absolute: PATH may hold several Node versions (platform-runtime section 7.4). */
  nodePath: string;
  /** Absolute path of dist/orbit.mjs. */
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
    ...[spec.nodePath, spec.entry, ...spec.args].map((a) => `    ${str(a)}`),
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
    `ExecStart=${[spec.nodePath, spec.entry, ...spec.args].map(sdQuote).join(' ')}`,
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
}

export interface ServiceStatus {
  label: string;
  platform: NodeJS.Platform;
  definitionPath: string;
  installed: boolean;
  /** null when the service manager's answer could not be interpreted. */
  loaded: boolean | null;
  detail: string;
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
    return serviceStatus(label, opts);
  }
  if (opts.platform === 'linux') {
    const unit = systemdUnitPath(opts.homeDir, label);
    const cmd = systemctlCommands(label);
    if (existsSync(unit)) await run(cmd.disable);
    rmSync(unit, { force: true });
    await must(run, cmd.daemonReload, [0]);
    return serviceStatus(label, opts);
  }
  return unsupported(opts.platform);
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
