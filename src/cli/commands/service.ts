/**
 * `orbit service install|uninstall|status|run`. The service is a launchd user
 * agent (macOS) or a systemd user unit (Linux) that runs `orbit service run`
 * for one repository. Orbit writes no credentials into the definition: the
 * service sees the PATH it was installed with and whatever the service
 * manager gives it, and ADR 0003 explains how credentials are supplied.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { OrbitError } from '../../core/errors.ts';
import { execCapture } from '../../core/exec.ts';
import { createLogger } from '../../core/log.ts';
import { loadConfig } from '../../policy/index.ts';
import { Controller, defaultControllerDeps, installService, launcherPath, pruneDeadControllers, readLauncher, refreshLauncher, serviceLabel, serviceSpec, serviceStatus, uninstallService, type ServiceManagerOptions } from '../../controller/index.ts';
import { stateDbPath } from '../../controller/start.ts';
import { openDb } from '../../storage/db.ts';
import type { Args, OptionSpec } from '../args.ts';
import { controllers, openState, resolveRepo, type CliContext } from '../context.ts';
import { EXIT } from '../exit.ts';
import { ago, json, line } from '../io.ts';

export const SERVICE_INSTALL_OPTIONS: OptionSpec = {
  entry: { type: 'string', description: 'the orbit entry script the service runs (default: the one running now)', valueName: 'path' },
};

function managerOptions(ctx: CliContext): ServiceManagerOptions {
  return {
    platform: ctx.platform,
    homeDir: ctx.homeDir,
    uid: ctx.uid,
    ...(ctx.seams.serviceRunner ? { run: ctx.seams.serviceRunner } : {}),
    ...(ctx.seams.serviceStopTimeoutMs !== undefined ? { stopTimeoutMs: ctx.seams.serviceStopTimeoutMs } : {}),
  };
}

/**
 * Run for every command: when a service launcher exists (service install wrote it), point it at the bundle and node
 * that are running now. A plugin update changes the bundle's versioned path, and this is what keeps the installed
 * service starting the new one. Best effort: it never fails or delays the command, and it never creates a launcher.
 */
export function refreshServiceLauncher(ctx: CliContext): void {
  try {
    refreshLauncher({ orbitHome: ctx.orbitHome, entry: ctx.entry, nodePath: process.execPath });
  } catch {
    // A launcher that cannot be refreshed is reported by `orbit service status`, which reads it.
  }
}

/** On Linux a user unit stops at logout unless lingering is enabled; the answer is a warning, never a failure. */
export async function lingerState(ctx: CliContext): Promise<'yes' | 'no' | 'unknown'> {
  if (ctx.platform !== 'linux') return 'unknown';
  try {
    const r = await execCapture(['loginctl', 'show-user', ctx.user, '--property=Linger'], { timeoutMs: 10_000, env: { PATH: ctx.env.PATH } });
    const m = /Linger=(yes|no)/.exec(r.stdout);
    return m ? (m[1] as 'yes' | 'no') : 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function serviceInstallCommand(args: Args, ctx: CliContext): Promise<number> {
  args.expect(0);
  const repo = await resolveRepo(ctx, args.str('repo'));
  // A service that cannot load the policy would crash-loop under the restart throttle: refuse before installing.
  loadConfig(repo);
  const entry = args.str('entry') ?? ctx.entry;
  if (!entry || !existsSync(entry)) throw new OrbitError('NOT_FOUND', `the orbit entry script ${entry || '(unknown)'} does not exist; pass --entry <path to plugin/dist/orbit.mjs>`);
  const warnings: string[] = [];
  if (!entry.endsWith('.mjs')) warnings.push(`the service will run ${entry}, not a built plugin/dist/orbit.mjs; build the bundle for a durable installation`);
  const spec = serviceSpec({ repoRoot: repo, orbitHome: ctx.orbitHome, entry, ...(ctx.env.PATH ? { path: ctx.env.PATH } : {}) });
  const status = await installService(spec, managerOptions(ctx));
  if (ctx.platform === 'linux' && (await lingerState(ctx)) === 'no') warnings.push(`lingering is off for ${ctx.user}, so the service stops when you log out; run "loginctl enable-linger ${ctx.user}" to keep it running`);
  if (args.bool('json')) json(ctx.io, { ...status, warnings });
  else {
    line(ctx.io, `service ${status.label} installed (${status.platform}): ${status.loaded ? 'loaded' : status.detail}`);
    line(ctx.io, `definition: ${status.definitionPath}`);
    line(ctx.io, `launcher: ${spec.launcher} (runs ${entry}; it follows plugin updates, so the service never needs reinstalling for one)`);
    line(ctx.io, `logs: ${join(ctx.orbitHome, 'logs')}`);
    line(ctx.io, 'No credentials were written to the definition. For unattended runs export ANTHROPIC_API_KEY (and CODEX_API_KEY) where the service can see them; see docs/decisions/0003-authentication.md.');
    for (const w of warnings) ctx.io.err(`warning: ${w}\n`);
  }
  return EXIT.OK;
}

export async function serviceUninstallCommand(args: Args, ctx: CliContext): Promise<number> {
  args.expect(0);
  const repo = await resolveRepo(ctx, args.str('repo'));
  const status = await uninstallService(serviceLabel(repo), managerOptions(ctx));
  if (args.bool('json')) json(ctx.io, status);
  else if (status.stopPending) line(ctx.io, `service ${status.label} removed; ${ctx.platform === 'darwin' ? 'launchd' : 'the service manager'} is still stopping the controller (it finishes its current step first); runs and their state are untouched. Check with: orbit service status`);
  else line(ctx.io, `service ${status.label} uninstalled; runs and their state are untouched`);
  return EXIT.OK;
}

function launcherState(ctx: CliContext): { path: string; exists: boolean; node: string | null; entry: string | null; bundleExists: boolean } {
  const path = launcherPath(ctx.orbitHome);
  const target = readLauncher(path);
  return { path, exists: existsSync(path), node: target?.node ?? null, entry: target?.entry ?? null, bundleExists: target ? existsSync(target.entry) && existsSync(target.node) : false };
}

export async function serviceStatusCommand(args: Args, ctx: CliContext): Promise<number> {
  args.expect(0);
  const repo = await resolveRepo(ctx, args.str('repo'));
  const status = await serviceStatus(serviceLabel(repo), managerOptions(ctx));
  let heartbeats: { id: string; mode: string; pid: number; heartbeat_age_ms: number; live: boolean; last_progress_at: number | null }[] = [];
  if (existsSync(stateDbPath(repo))) {
    const db = openState(repo);
    try {
      // A controller that died without a stop record is not "stale", it is gone.
      pruneDeadControllers(db, ctx.clock);
      heartbeats = controllers(db, ctx.clock.now(), { limit: 5 }).map((c) => ({ id: c.record.id, mode: c.record.mode, pid: c.record.pid, heartbeat_age_ms: c.age, live: c.live, last_progress_at: c.record.lastProgressAt }));
    } finally {
      db.close();
    }
  }
  // A definition that is gone while the manager still lists the job is a service being torn down, not a service that is running.
  const serving = status.loaded === true && status.installed;
  const tearingDown = status.loaded === true && !status.installed;
  const launcher = launcherState(ctx);
  if (args.bool('json')) json(ctx.io, { ...status, launcher, controllers: heartbeats });
  else {
    line(
      ctx.io,
      tearingDown
        ? `service ${status.label}: not installed, but ${ctx.platform === 'darwin' ? 'launchd' : 'the service manager'} still holds the job (a stop still in progress, or one left over; it should disappear on its own, otherwise run orbit service uninstall)`
        : `service ${status.label}: ${status.installed ? 'installed' : 'not installed'}, ${status.loaded === null ? `state unknown (${status.detail})` : status.loaded ? 'loaded' : 'not loaded'}`,
    );
    line(ctx.io, `definition: ${status.definitionPath}`);
    if (launcher.entry) line(ctx.io, `launcher ${launcher.path} runs ${launcher.entry}${launcher.bundleExists ? '' : ' (MISSING: run any orbit command from the installed version, or orbit service install)'}`);
    else if (status.installed) line(ctx.io, `launcher ${launcher.path}: ${launcher.exists ? 'not written by Orbit' : 'MISSING'}; run orbit service install`);
    if (heartbeats.length === 0) line(ctx.io, 'controller: none has registered in this repository');
    for (const h of heartbeats) line(ctx.io, `controller ${h.id}: ${h.mode}, pid ${h.pid}, heartbeat ${ago(ctx.clock.now(), ctx.clock.now() - h.heartbeat_age_ms)} (${h.live ? 'live' : 'stale'})`);
  }
  // Like systemctl is-active: scripts can branch on whether the service is running.
  return serving ? EXIT.OK : EXIT.FAILURE;
}

/** The persistent controller the service definition starts. It runs until it is told to stop. */
export async function serviceRunCommand(args: Args, ctx: CliContext): Promise<number> {
  args.expect(0);
  const repo = await resolveRepo(ctx, args.str('repo'));
  const config = loadConfig(repo);
  const db = openDb(stateDbPath(repo));
  try {
    const logger = createLogger({ file: join(ctx.orbitHome, 'logs', 'controller.jsonl'), stderr: true, clock: ctx.clock });
    const factory = ctx.seams.controllerDeps ?? defaultControllerDeps;
    const deps = factory({ repoRoot: repo, db, clock: ctx.clock, config, env: ctx.env, orbitHome: ctx.orbitHome, logger });
    const controller = new Controller({ deps, mode: 'service', handleSignals: true, ...(ctx.seams.controller ?? {}) });
    line(ctx.io, `orbit controller ${controller.ownerId} started in service mode for ${repo} (pid ${process.pid})`);
    await controller.start();
    return EXIT.OK;
  } finally {
    db.close();
  }
}
