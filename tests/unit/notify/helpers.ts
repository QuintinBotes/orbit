import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManualClock } from '../../../src/core/clock.ts';
import { createRun, getRun, type RunRecord } from '../../../src/controller/run-store.ts';
import { insertQuestion, type QuestionRecord } from '../../../src/inquisition/store.ts';
import { defaultConfig } from '../../../src/policy/config.ts';
import type { OrbitConfig } from '../../../src/policy/types.ts';
import { openDb, type OrbitDb } from '../../../src/storage/db.ts';
import type { ExecOutcome, NotifyDeps, NotifyFetch } from '../../../src/notify/channels.ts';
import { FakeThreadClient } from '../../../src/notify/threads.ts';

export const RUN = 'orb-20261006-101500-a1b2c3';

export interface NotifyEnv {
  dir: string;
  db: OrbitDb;
  clock: ManualClock;
  runDir: string;
  repoRoot: string;
  run(): RunRecord;
  cleanup(): void;
}

export function setup(): NotifyEnv {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-notify-'));
  const db = openDb(join(dir, 'state.sqlite'));
  const clock = new ManualClock();
  const repoRoot = join(dir, 'repo');
  const runDir = join(repoRoot, '.orbit', 'runs', RUN);
  mkdirSync(runDir, { recursive: true });
  createRun(db, { id: RUN, repoRoot, goal: 'Add CSV export to the acme reports page', mode: 'autonomous', policyHash: 'sha256:x', policyPath: join(runDir, 'policy.json') }, clock);
  return {
    dir,
    db,
    clock,
    runDir,
    repoRoot,
    run: () => getRun(db, RUN),
    cleanup() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Put the run in a state without going through the controller (the state machine is not under test here). */
export function setState(env: NotifyEnv, state: string, reason: string | null = null, endedAt: number | null = null): void {
  env.db.run('UPDATE runs SET state = ?, outcome_reason = ?, ended_at = ? WHERE id = ?', state, reason, endedAt, RUN);
}

export function addQuestion(env: NotifyEnv, opts: { id?: string; runId?: string; material?: boolean; options?: string[] } = {}): QuestionRecord {
  return insertQuestion(
    env.db,
    {
      ...(opts.id ? { id: opts.id } : {}),
      runId: opts.runId ?? RUN,
      mode: 'clarify',
      question: 'Should the export include archived reports, or only active ones?',
      evidence: ['apps/reports/export.ts:12 lists active reports only'],
      options: (opts.options ?? ['A', 'B']).map((label) => ({ label, description: `option ${label}`, consequences: `consequence of ${label}` })),
      changes: ['scope'],
      recommendation: { option: 'A', reason: 'smaller change' },
      safeDefault: { exists: false, option: null, reason: 'either choice changes behaviour' },
      material: opts.material ?? true,
      affected: ['AC-1'],
      unblocked: [],
    },
    env.clock,
  );
}

export function notifyConfig(tweak?: (c: OrbitConfig) => void): OrbitConfig {
  const c = defaultConfig('autonomous');
  tweak?.(c);
  return c;
}

export interface FakeSystem {
  deps: NotifyDeps;
  execCalls: string[][];
  fetchCalls: { url: string; body: string; headers: Record<string, string>; redirect: string }[];
  threads: FakeThreadClient;
}

/** Notification collaborators that record what they were asked to do and never touch the machine or the network. */
export function fakeSystem(opts: { env?: Record<string, string>; platform?: NodeJS.Platform; exec?: (argv: string[]) => ExecOutcome; fetchStatus?: number; fetchError?: Error; statePath?: string } = {}): FakeSystem {
  const execCalls: string[][] = [];
  const fetchCalls: FakeSystem['fetchCalls'] = [];
  const threads = new FakeThreadClient({ statePath: opts.statePath ?? join(mkdtempSync(join(tmpdir(), 'orbit-threads-')), 'threads.json') });
  const fetch: NotifyFetch = async (url, init) => {
    fetchCalls.push({ url, body: init.body, headers: init.headers, redirect: init.redirect });
    if (opts.fetchError) throw opts.fetchError;
    const status = opts.fetchStatus ?? 200;
    return { status, ok: status >= 200 && status < 300 };
  };
  const deps: NotifyDeps = {
    env: opts.env ?? {},
    platform: opts.platform ?? 'darwin',
    exec: async (argv) => {
      execCalls.push(argv);
      return opts.exec ? opts.exec(argv) : { exitCode: 0, notFound: false, stderr: '' };
    },
    fetch,
    threads: async () => threads,
  };
  return { deps, execCalls, fetchCalls, threads };
}
