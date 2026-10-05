/**
 * Starting a run and assembling a controller's collaborators. Starting a run
 * freezes the policy first (snapshot, hash, mode 0444) and only then writes
 * the run row that names it, so no run ever exists without its authority.
 */
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { systemClock, type Clock } from '../core/clock.ts';
import { newRunId } from '../core/ids.ts';
import { createLogger, type Logger } from '../core/log.ts';
import { openDb, type OrbitDb } from '../storage/db.ts';
import { loadConfig } from '../policy/config.ts';
import { snapshotPolicy } from '../policy/snapshot.ts';
import type { OrbitConfig } from '../policy/types.ts';
import { createAdapters, type AdapterDeps } from '../adapters/index.ts';
import type { ProviderAdapter } from '../adapters/types.ts';
import { getIsolation } from '../isolation/index.ts';
import { ModelRegistry } from '../routing/registry.ts';
import type { ControllerDeps } from './context.ts';
import { createRun, type RunRecord } from './run-store.ts';

export function orbitDir(repoRoot: string): string {
  return join(repoRoot, '.orbit');
}

export function stateDbPath(repoRoot: string): string {
  return join(orbitDir(repoRoot), 'state.sqlite');
}

export function defaultOrbitHome(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env.ORBIT_HOME ?? join(homedir(), '.orbit');
}

/** The directory holding agents/, schemas/ and dist/: three levels up from this file in the sources, one from the bundle. */
export function orbitInstallDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return here.endsWith(join('src', 'controller')) ? resolve(here, '..', '..') : resolve(here, '..');
}

export interface StartRunInput {
  db: OrbitDb;
  repoRoot: string;
  goal: string;
  config: OrbitConfig;
  clock?: Clock;
  runId?: string;
  actor?: string;
}

export function startRun(input: StartRunInput): RunRecord {
  const clock = input.clock ?? systemClock;
  const repoRoot = realpathSync(input.repoRoot);
  const id = input.runId ?? newRunId(clock.now());
  const runDir = join(orbitDir(repoRoot), 'runs', id);
  const snap = snapshotPolicy(input.config, { runId: id, repoRoot, runDir, clock });
  return createRun(input.db, { id, repoRoot, goal: input.goal, mode: input.config.mode, policyHash: snap.hash, policyPath: snap.path }, clock, input.actor ?? 'cli');
}

export interface DefaultDepsInput {
  repoRoot: string;
  db?: OrbitDb;
  clock?: Clock;
  logger?: Logger;
  /** The live configuration, for provider adapters; each run still acts only under its own frozen snapshot. */
  config?: OrbitConfig;
  orbitHome?: string;
  adapters?: Record<string, ProviderAdapter>;
  adapterDeps?: AdapterDeps;
  env?: Readonly<Record<string, string | undefined>>;
}

export function defaultControllerDeps(input: DefaultDepsInput): Omit<ControllerDeps, 'ownerId'> {
  const repoRoot = realpathSync(input.repoRoot);
  const clock = input.clock ?? systemClock;
  const db = input.db ?? openDb(stateDbPath(repoRoot));
  const env = input.env ?? process.env;
  const orbitHome = input.orbitHome ?? defaultOrbitHome(env);
  const installDir = orbitInstallDir();
  const config = input.config ?? loadConfig(repoRoot);
  let adapters = input.adapters;
  if (!adapters) {
    let isolation = null;
    try {
      isolation = getIsolation(config.isolation, { orbitInstallDir: installDir, mode: config.mode });
    } catch {
      isolation = null;
    }
    adapters = createAdapters(config, { isolation, clock, baseEnv: env, ...(input.adapterDeps ?? {}) });
  }
  const logger = input.logger ?? createLogger({ file: join(orbitHome, 'logs', 'controller.jsonl'), clock });
  return { db, clock, logger, adapters, registry: new ModelRegistry(db, clock), orbitHome, homeDir: homedir(), hostEnv: env, orbitInstallDir: installDir };
}
