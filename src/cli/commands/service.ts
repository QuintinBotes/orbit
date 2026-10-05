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
import { Controller, defaultControllerDeps, installService, serviceLabel, serviceSpec, serviceStatus, uninstallService, type ServiceManagerOptions } from '../../controller/index.ts';
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
  return { platform: ctx.platform, homeDir: ctx.homeDir, uid: ctx.uid, ...(ctx.seams.serviceRunner ? { run: ctx.seams.serviceRunner } : {}) };
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
  if (!entry || !existsSync(entry)) throw new OrbitError('NOT_FOUND', `the orbit entry script ${entry || '(unknown)'} does not exist; pass --entry <path to dist/orbit.mjs>`);
  const warnings: string[] = [];
  if (!entry.endsWith('.mjs')) warnings.push(`the service will run ${entry}, not a built dist/orbit.mjs; build the bundle for a durable installation`);
  const spec = serviceSpec({ repoRoot: repo, orbitHome: ctx.orbitHome, entry, ...(ctx.env.PATH ? { path: ctx.env.PATH } : {}) });
  const status = await installService(spec, managerOptions(ctx));
  if (ctx.platform === 'linux' && (await lingerState(ctx)) === 'no') warnings.push(`lingering is off for ${ctx.user}, so the service stops when you log out; run "loginctl enable-linger ${ctx.user}" to keep it running`);
  if (args.bool('json')) json(ctx.io, { ...status, warnings });
  else {
    line(ctx.io, `service ${status.label} installed (${status.platform}): ${status.loaded ? 'loaded' : status.detail}`);
    line(ctx.io, `definition: ${status.definitionPath}`);
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
  else line(ctx.io, `service ${status.label} uninstalled; runs and their state are untouched`);
  return EXIT.OK;
}

export async function serviceStatusCommand(args: Args, ctx: CliContext): Promise<number> {
  args.expect(0);
  const repo = await resolveRepo(ctx, args.str('repo'));
  const status = await serviceStatus(serviceLabel(repo), managerOptions(ctx));
  let heartbeats: { id: string; mode: string; pid: number; heartbeat_age_ms: number; live: boolean; last_progress_at: number | null }[] = [];
  if (existsSync(stateDbPath(repo))) {
    const db = openState(repo);
    try {
      heartbeats = controllers(db, ctx.clock.now(), { limit: 5 }).map((c) => ({ id: c.record.id, mode: c.record.mode, pid: c.record.pid, heartbeat_age_ms: c.age, live: c.live, last_progress_at: c.record.lastProgressAt }));
    } finally {
      db.close();
    }
  }
  const serving = status.loaded === true;
  if (args.bool('json')) json(ctx.io, { ...status, controllers: heartbeats });
  else {
    line(ctx.io, `service ${status.label}: ${status.installed ? 'installed' : 'not installed'}, ${status.loaded === null ? `state unknown (${status.detail})` : status.loaded ? 'loaded' : 'not loaded'}`);
    line(ctx.io, `definition: ${status.definitionPath}`);
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
