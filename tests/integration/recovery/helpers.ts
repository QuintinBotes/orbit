import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeAdapter } from '../../../src/adapters/claude.ts';
import type { TaskHandle } from '../../../src/adapters/types.ts';
import { readPidRecord } from '../../../src/adapters/shim.ts';
import { systemClock } from '../../../src/core/clock.ts';
import type { RunState } from '../../../src/core/run-states.ts';
import { acquireLease, createRun, transition, type RunRecord } from '../../../src/controller/run-store.ts';
import { openDb, type OrbitDb } from '../../../src/storage/db.ts';
import { markWorkerRunning, planWorker, type WorkerRecord } from '../../../src/storage/workers.ts';
import { FAKE_CLAUDE, IMPLEMENTER_OUTPUT, alive, implementerSpec, makeFixture, waitFor, writeScenario, type Fixture } from '../adapters/helpers.ts';

export { IMPLEMENTER_OUTPUT, alive, waitFor };

/**
 * Everything here is real: a git repository, a SQLite file, the Claude
 * adapter with its shim, and fake-claude as the provider process. Time is the
 * system clock, because pid files and launch records carry real timestamps.
 */

export const OWNER = 'ctl-test';
export const clock = systemClock;
export const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

export interface Env {
  f: Fixture;
  db: OrbitDb;
  runId: string;
  adapter: ClaudeAdapter;
  adapters: { claude: ClaudeAdapter };
  runDir: string;
  /** Extra processes to kill when the test ends. */
  kids: ChildProcess[];
  cleanup(): void;
}

const live: Env[] = [];

export function makeEnv(): Env {
  const f = makeFixture();
  const db = openDb(join(f.base, 'state.sqlite'));
  const adapter = new ClaudeAdapter({
    command: [process.execPath, FAKE_CLAUDE],
    tier: 'claude-sandbox',
    graceMs: 300,
    baseEnv: { PATH: process.env.PATH, HOME: process.env.HOME, ANTHROPIC_API_KEY: 'sk-ant-fake-000' },
  });
  const env: Env = {
    f,
    db,
    runId: 'orb-adp',
    adapter,
    adapters: { claude: adapter },
    runDir: join(f.base, 'run'),
    kids: [],
    cleanup() {
      for (const k of env.kids.splice(0)) killTree(k.pid!);
      // Anything the shims left behind.
      for (const pid of pidsOf(f.workerDir)) killTree(pid);
      // And any check shims and their checks.
      for (const name of readdirSafe(join(env.runDir, 'baseline'))) for (const pid of pidsOf(join(env.runDir, 'baseline', name))) killTree(pid);
      try {
        db.close();
      } catch {
        /* already closed */
      }
      rmSync(f.base, { recursive: true, force: true });
    },
  };
  live.push(env);
  return env;
}

export function cleanupAll(): void {
  for (const e of live.splice(0)) e.cleanup();
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Shim and child pids from a worker's or a check's pid.json (both use shimPid and childPid). */
function pidsOf(dir: string): number[] {
  try {
    const rec = JSON.parse(readFileSync(join(dir, 'pid.json'), 'utf8')) as { shimPid?: number; childPid?: number | null };
    return [rec.shimPid ?? 0, rec.childPid ?? 0].filter((p) => p > 1);
  } catch {
    return [];
  }
}

export function killTree(pid: number): void {
  // pid 0 or 1 would signal our own process group or everything; never.
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
}

/** The run row, walked to `path` by OWNER, who holds its lease. */
export function makeRun(env: Env, path: RunState[] = ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'], owner = OWNER, ttlMs = 60_000): RunRecord {
  let run = createRun(env.db, { id: env.runId, repoRoot: env.f.repo, goal: 'g', mode: 'autonomous', policyHash: env.f.policyHash, policyPath: env.f.policyPath }, clock);
  acquireLease(env.db, env.runId, owner, ttlMs, clock);
  for (const to of path) run = transition(env.db, { runId: env.runId, to, ownerId: owner, reason: 'test' }, clock);
  return run;
}

/** Persist a PLANNED worker row for the fixture's worker directory (intent before spawn). */
export function planImplementer(env: Env, id = 'w1'): WorkerRecord {
  return planWorker(env.db, { id, runId: env.runId, role: 'implementer', provider: 'claude', model: 'sonnet', workerDir: env.f.workerDir, cwd: env.f.repo }, clock);
}

export interface Started {
  handle: TaskHandle;
  shimPid: number;
  childPid: number;
}

/** Start a real worker through the adapter. `recorded: false` leaves the row PLANNED, as a crash between spawn and bookkeeping would. */
export async function startWorker(env: Env, step: object, opts: { recorded?: boolean } = {}): Promise<Started> {
  writeScenario(env.f, { roles: { '*': [step] } });
  planImplementer(env);
  const handle = await env.adapter.startTask(implementerSpec(env.f));
  const pid = readPidRecord(env.f.workerDir)!;
  if (opts.recorded !== false) markWorkerRunning(env.db, 'w1', { pid: handle.pid, pgid: handle.pgid, procStart: handle.procStart }, clock);
  await waitFor(() => readPidRecord(env.f.workerDir)?.childPid ?? null);
  // The fake logs its argv a moment after it starts; tests that count launches read that log.
  await waitFor(() => existsSync(env.f.argvLog) || null);
  return { handle, shimPid: handle.pid, childPid: readPidRecord(env.f.workerDir)?.childPid ?? pid.shimPid };
}

/** A long-lived unrelated process in its own group, to stand in for whatever recycled a pid. */
export function strangerProcess(env: Env): { pid: number; start: string } {
  const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
  child.unref();
  env.kids.push(child);
  return { pid: child.pid!, start: '' };
}

export function writeFile(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function workerRow(env: Env, id = 'w1'): { state: string; restart_count: number; result_status: string | null; error: string | null } {
  return env.db.get<{ state: string; restart_count: number; result_status: string | null; error: string | null }>('SELECT state, restart_count, result_status, error FROM workers WHERE id = ?', id)!;
}

export function counterUsed(env: Env, counter: string): number | undefined {
  return env.db.get<{ used: number }>('SELECT used FROM budget_counters WHERE run_id = ? AND counter = ?', env.runId, counter)?.used;
}

export function seedCounters(env: Env, allowance: Record<string, number>): void {
  for (const [counter, n] of Object.entries(allowance)) env.db.run('INSERT INTO budget_counters (run_id, counter, used, allowance, hard_cap) VALUES (?, ?, 0, ?, ?)', env.runId, counter, n, n);
}
