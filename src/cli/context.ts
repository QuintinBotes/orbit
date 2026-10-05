/**
 * What a command needs from its surroundings: output, clock, environment,
 * the repository and its state database. Tests substitute pieces through
 * `seams`; production uses the process.
 */
import { existsSync, realpathSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { dirname, resolve } from 'node:path';
import { systemClock, type Clock } from '../core/clock.ts';
import { OrbitError } from '../core/errors.ts';
import { execCapture } from '../core/exec.ts';
import { orbitHint } from '../core/invocation.ts';
import { newOwnerId } from '../core/ids.ts';
import { isAlive } from '../core/proc.ts';
import { openDb, type OrbitDb } from '../storage/db.ts';
import { listControllers, type ControllerRecord } from '../storage/controllers.ts';
import { acquireLease, findRun, getLease, listRuns, releaseLease, type Lease, type RunRecord } from '../controller/run-store.ts';
import { defaultOrbitHome, stateDbPath, type DefaultDepsInput } from '../controller/start.ts';
import type { ControllerDeps } from '../controller/context.ts';
import type { ControllerOptions } from '../controller/loop.ts';
import type { CommandRunner } from '../controller/service.ts';
import type { EvalRunner } from '../knowledge/evals.ts';
import { createIo, type Io } from './io.ts';
import type { AdmissionCheck } from './admission.ts';

/** The part of `process` the CLI uses for Ctrl-C and SIGTERM; an EventEmitter stands in for it in tests. */
export interface SignalSource {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export interface CliSeams {
  /** Runs launchctl/systemctl; tests replace it so nothing is ever loaded into the real service manager. */
  serviceRunner?: CommandRunner;
  /** How long `service uninstall` waits for the service manager to let go of the job; tests shorten it. */
  serviceStopTimeoutMs?: number;
  /** Builds the controller's collaborators (foreground runs, `service run`, cancellation); tests inject fake adapters. */
  controllerDeps?: (input: DefaultDepsInput) => Omit<ControllerDeps, 'ownerId'>;
  /** Replays a case for `learn eval`; without one the command explains what is missing. */
  evalRunner?: EvalRunner;
  /** How often foreground runs and `--follow` look at durable state. */
  pollMs?: number;
  /** Controller timing, passed through to Controller (tests shrink it). */
  controller?: Partial<Pick<ControllerOptions, 'leaseTtlMs' | 'leaseRenewMs' | 'heartbeatMs' | 'tickIntervalMs' | 'stepTimeoutMs' | 'shutdownGraceMs' | 'graceMs' | 'startGraceMs'>>;
  /** Where Ctrl-C and SIGTERM handlers are installed; default process. */
  signals?: SignalSource;
  /** Ends the process on a second Ctrl-C; default process.exit. */
  exit?: (code: number) => never;
  /** Judges whether `orbit run` may start (dirty tree, environment gate) before it creates a run; tests that script the controller replace it. */
  admission?: AdmissionCheck;
}

export interface CliContext {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  io: Io;
  clock: Clock;
  platform: NodeJS.Platform;
  uid: number;
  homeDir: string;
  /** The person acting. Decisions are recorded under this name, so it must look like a person, not a subsystem. */
  user: string;
  orbitHome: string;
  /** The script that is running (plugin/dist/orbit.mjs, or the TypeScript entry from a source checkout). */
  entry: string;
  seams: CliSeams;
}

export function createContext(overrides: Partial<CliContext> = {}): CliContext {
  const env = overrides.env ?? process.env;
  const homeDir = overrides.homeDir ?? homedir();
  const io = overrides.io ?? createIo(process.stdout, process.stderr, process.stdin);
  let user = env.ORBIT_USER || env.USER || env.LOGNAME || '';
  if (!user) {
    try {
      user = userInfo().username;
    } catch {
      user = 'user';
    }
  }
  const entry = overrides.entry ?? (process.argv[1] ? safeRealpath(process.argv[1]) : '');
  return {
    cwd: overrides.cwd ?? process.cwd(),
    env,
    io,
    clock: overrides.clock ?? systemClock,
    platform: overrides.platform ?? process.platform,
    uid: overrides.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0),
    homeDir,
    user: overrides.user ?? user,
    orbitHome: overrides.orbitHome ?? defaultOrbitHome({ ...env, HOME: homeDir }),
    entry,
    seams: overrides.seams ?? {},
  };
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** The repository root: the git toplevel of --repo or the current directory (the primary checkout when inside a linked worktree). */
export async function resolveRepo(ctx: CliContext, flag?: string): Promise<string> {
  const start = resolve(ctx.cwd, flag ?? '.');
  if (!existsSync(start)) throw new OrbitError('NOT_FOUND', `${start} does not exist`);
  let r;
  try {
    r = await execCapture(['git', 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], { cwd: start, timeoutMs: 15_000, env: gitEnv(ctx.env) });
  } catch (err) {
    throw new OrbitError('PROVIDER_UNAVAILABLE', `git is not available: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (r.exitCode !== 0) throw new OrbitError('NOT_FOUND', `${start} is not inside a git repository; run orbit from a repository or pass --repo`);
  const [top, common] = r.stdout.trim().split('\n');
  if (!top) throw new OrbitError('NOT_FOUND', `${start} is not inside a git repository`);
  // A linked worktree keeps its own toplevel; Orbit's state lives with the primary checkout (platform-runtime section 7.3).
  if (common && common.endsWith('/.git') && dirname(common) !== top) return safeRealpath(dirname(common));
  return safeRealpath(top);
}

export function gitEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']) if (env[k] !== undefined) out[k] = env[k];
  out.GIT_OPTIONAL_LOCKS = '0';
  return out;
}

/** Whether `orbit init` has been run here (the repository has its policy file), though no run has created state yet. */
export function initialised(repoRoot: string): boolean {
  return existsSync(resolve(repoRoot, '.orbit', 'config.yaml'));
}

/** Open the repository's state database. Without `create` a missing one is an error: reading commands must not conjure state. */
export function openState(repoRoot: string, opts: { create?: boolean } = {}): OrbitDb {
  const path = stateDbPath(repoRoot);
  if (!opts.create && !existsSync(path)) {
    // After "orbit init" the state database is simply not there yet: it appears with the first run. Say that, not "run init".
    if (initialised(repoRoot)) throw new OrbitError('NOT_FOUND', `no runs yet in ${repoRoot}; start one with: orbit run --goal "..."`, { path });
    throw new OrbitError('NOT_FOUND', `no Orbit state in ${repoRoot}; run ${orbitHint('init')}, then ${orbitHint('run')}`, { path });
  }
  return openDb(path);
}

export async function withState<T>(repoRoot: string, fn: (db: OrbitDb) => Promise<T> | T, opts: { create?: boolean } = {}): Promise<T> {
  const db = openState(repoRoot, opts);
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

/** A run by exact id or by a prefix that matches exactly one. */
export function findRunByPrefix(db: OrbitDb, id: string): RunRecord {
  const exact = findRun(db, id);
  if (exact) return exact;
  if (id.length >= 4) {
    const hits = db.all<{ id: string }>("SELECT id FROM runs WHERE id LIKE ? ESCAPE '\\' ORDER BY id LIMIT 3", `${id.replace(/[\\%_]/g, '\\$&')}%`);
    if (hits.length === 1) return findRun(db, hits[0]!.id)!;
    if (hits.length > 1) throw new OrbitError('NOT_FOUND', `"${id}" matches more than one run (${hits.map((h) => h.id).join(', ')}); use the full id`);
  }
  const recent = listRuns(db, { limit: 3 });
  throw new OrbitError('NOT_FOUND', `no run ${id}${recent.length ? `; recent runs: ${recent.map((r) => r.id).join(', ')}` : ''}`);
}

/** The run's lease when it has not expired: someone is (or very recently was) working on it. */
export function liveLease(db: OrbitDb, runId: string, now: number): Lease | null {
  const l = getLease(db, runId);
  return l && l.expiresAt > now ? l : null;
}

/** Heartbeats are published every few seconds; a controller silent for this long is treated as gone. */
export const CONTROLLER_STALE_MS = 30_000;

export interface ControllerLiveness {
  record: ControllerRecord;
  /** Heartbeat age in ms. */
  age: number;
  /** Heartbeat is recent and, on this host, the process is still the one that registered. */
  live: boolean;
}

export function controllers(db: OrbitDb, now: number, opts: { includeStopped?: boolean; limit?: number } = {}): ControllerLiveness[] {
  return listControllers(db, { includeStopped: opts.includeStopped ?? false, limit: opts.limit ?? 20 }).map((record) => {
    const age = Math.max(0, now - record.heartbeatAt);
    let live = record.stoppedAt === null && age < CONTROLLER_STALE_MS;
    if (live && record.host === hostname()) live = isAlive(record.pid, record.procStart);
    return { record, age, live };
  });
}

export function liveServiceController(db: OrbitDb, now: number): ControllerLiveness | null {
  return controllers(db, now).find((c) => c.live && c.record.mode === 'service') ?? null;
}

/**
 * Hold a run's lease for the length of `fn`, as the CLI. Used where the CLI
 * must itself change a run nobody owns (cancelling a BLOCKED run, resuming
 * one). A live owner makes this a CONCURRENT_UPDATE: the CLI never takes a
 * run from a controller that is working on it.
 */
export async function withCliLease<T>(ctx: CliContext, db: OrbitDb, runId: string, fn: (ownerId: string) => Promise<T> | T, ttlMs = 60_000): Promise<T> {
  const ownerId = `cli-${newOwnerId()}`;
  const lease = acquireLease(db, runId, ownerId, ttlMs, ctx.clock);
  if (!lease) {
    const held = getLease(db, runId);
    throw new OrbitError('CONCURRENT_UPDATE', `run ${runId} is owned by a live controller (${held?.ownerId ?? 'unknown'}); its lease expires ${held ? new Date(held.expiresAt).toISOString() : 'soon'}`, { runId });
  }
  try {
    return await fn(ownerId);
  } finally {
    try {
      releaseLease(db, runId, ownerId);
    } catch {
      /* the lease expires by itself */
    }
  }
}
