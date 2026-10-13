// Every finished session's usage is recorded once and charged to cost_usd once, whichever path collected it and
// wherever a controller died (adversarial review of fix/031-budget). Random interleavings of sessions finishing by
// each path, charge passes, PLANNING's precharge and crashes inside a charge, then a final pass of the paths a resumed
// run takes: the charge must equal the recorded spend, and each usage record must carry exactly one charge mark.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderAdapter, TaskHandle, TaskResult } from '../../../src/adapters/types.ts';
import { finalizeRun } from '../../../src/controller/report.ts';
import { getRun } from '../../../src/controller/run-store.ts';
import { planningStep } from '../../../src/controller/steps/planning.ts';
import { accountWorker, chargeRecordedUsage, collectIfFinished, USAGE_CHARGED_EVENT } from '../../../src/controller/workers.ts';
import { stopWorker } from '../../../src/recovery/reconcile.ts';
import { recordUsage } from '../../../src/routing/usage.ts';
import { BudgetLedger } from '../../../src/scheduling/budget.ts';
import { finishWorker, getWorker, listWorkers, markWorkerRunning, planWorker, type WorkerRecord } from '../../../src/storage/workers.ts';
import { initLedger, makeUnitLab, OWNER, setContract, type UnitLab } from './coverage-helpers.ts';

/** How a session's end is recorded: by the Inquisition engine (result and usage together, uncharged), by reconciliation or the watchdog (result only), by a step (result, then usage and charge), or by the controller collecting a worker another component started. */
type Path = 'engine' | 'reconciled' | 'collected' | 'supervised';
const PATHS: readonly Path[] = ['engine', 'reconciled', 'collected', 'supervised'];
const ROLES = ['planner', 'implementer', 'reviewer', 'inquisitor'] as const;

const CRASH = 'controller killed';

/** A small deterministic generator (mulberry32), so a failing interleaving can be replayed from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const resultOf = (cost: number): TaskResult => ({
  status: 'succeeded',
  structured: {},
  text: null,
  error: null,
  exitCode: 0,
  usage: { provider: 'claude', model: null, inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: cost, costSource: 'reported' },
  durationMs: 10,
});

interface Session {
  id: string;
  path: Path;
  cost: number;
}

let lab: UnitLab;
afterEach(() => {
  vi.restoreAllMocks();
  lab?.cleanup();
});

/** What the interleavings exercised, so the property cannot pass by never reaching a path or a crash. */
const seen = { paths: new Set<Path>(), crashedIn: new Set<string>() };

describe('a session is charged exactly once, whatever collected it and wherever the controller died', () => {
  it('for random interleavings of record, charge and crash, the charge equals the recorded spend and each record is marked once', async () => {
    for (let seed = 1; seed <= 60; seed++) await interleaving(seed);
    expect([...seen.paths].sort()).toEqual([...PATHS].sort());
    // A crash inside PLANNING's precharge, inside a charge pass, and inside the collection of a session by each path.
    expect([...seen.crashedIn].sort()).toEqual(['charge', 'collected', 'plan', 'supervised']);
  });

  it('a session the watchdog stopped as the run ended is recorded and charged when the report is written, once', async () => {
    lab?.cleanup();
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'], adapters: { claude: { id: 'claude', collectResult: async () => resultOf(0.33) } as never } });
    initLedger(lab);
    const workerDir = join(lab.base, 'w', 'wrk-rev');
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, 'pid.json'), JSON.stringify({ version: 1, shimPid: 2_000_000_000, shimStart: 'x', pgid: 2_000_000_000, childPid: null, childStart: null, sessionId: null, argvHash: 'h', startedAt: 1 }));
    writeFileSync(join(workerDir, 'exit.json'), JSON.stringify({ version: 1, code: 0, signal: null, timedOut: false, cancelled: true, aborted: null, endedAt: 2, startedAt: 1 }));
    const w = planWorker(lab.db, { id: 'wrk-rev', runId: lab.runId, role: 'reviewer', purpose: 'review:1', provider: 'claude', model: null, workerDir, cwd: lab.repo }, lab.clock, OWNER);
    markWorkerRunning(lab.db, w.id, { pid: 2_000_000_000, pgid: 2_000_000_000, procStart: 'x' }, lab.clock, OWNER);
    // The watchdog stops the session and stores what it collected; nothing records its usage, and the run ends.
    const stopped = await stopWorker({ db: lab.db, clock: lab.clock, ownerId: OWNER, adapters: lab.deps.adapters, graceMs: 50 }, getWorker(lab.db, w.id), 'abandoned by the watchdog');
    expect(stopped.state).toBe('CANCELLED');
    expect(lab.db.all('SELECT 1 FROM usage WHERE worker_id = ?', w.id)).toEqual([]);
    lab.walk(['EXHAUSTED']);
    await finalizeRun(lab.ctx());
    expect(lab.db.all('SELECT cost_usd FROM usage WHERE worker_id = ?', w.id)).toEqual([{ cost_usd: 0.33 }]);
    expect(lab.ctx().ledger!.state('cost_usd').used).toBeCloseTo(0.33, 6);
    await finalizeRun(lab.ctx());
    expect(lab.ctx().ledger!.state('cost_usd').used).toBeCloseTo(0.33, 6);
  });
});

async function interleaving(seed: number): Promise<void> {
  const next = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
  const sessions = new Map<string, Session>();
  const adapter = {
    id: 'claude',
    reattach: (dir: string): TaskHandle => ({ provider: 'claude', workerId: '', workerDir: dir, pid: 2_000_000_000, pgid: 2_000_000_000, procStart: 'x', logPath: '', exitPath: '' }),
    collectResult: async (h: TaskHandle): Promise<TaskResult | null> => resultOf(sessions.get(h.workerId)!.cost),
  } as unknown as ProviderAdapter;
  lab?.cleanup();
  lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING'], adapters: { claude: adapter } });
  lab.deps.registry.seed();
  for (const e of lab.deps.registry.list()) if (e.provider === 'claude') lab.deps.registry.markAvailability(e.modelId, 'claude-cli', true, 'test');
  mkdirSync(lab.ctx().runDir, { recursive: true });
  setContract(lab);

  // A crash armed with n lets n more charges through, then kills the controller inside the next one.
  let armed: number | null = null;
  let doing = '';
  vi.restoreAllMocks();
  const original = BudgetLedger.prototype.consumeCost;
  vi.spyOn(BudgetLedger.prototype, 'consumeCost').mockImplementation(function (this: BudgetLedger, ...args: Parameters<BudgetLedger['consumeCost']>) {
    if (armed !== null && armed-- === 0) {
      armed = null;
      seen.crashedIn.add(doing);
      throw new Error(CRASH);
    }
    return original.apply(this, args);
  });
  const survive = async (what: string, op: () => unknown): Promise<void> => {
    doing = what;
    try {
      await op();
    } catch (err) {
      if (!(err instanceof Error && err.message === CRASH)) throw err;
    }
  };

  const finish = async (w: WorkerRecord): Promise<void> => {
    const s = sessions.get(w.id)!;
    const r = resultOf(s.cost);
    const outcome = { state: 'SUCCEEDED' as const, exitCode: 0, resultStatus: 'succeeded' as const, result: r, error: null };
    if (s.path === 'engine') {
      lab.db.tx(() => {
        finishWorker(lab.db, w.id, outcome, lab.clock, OWNER);
        recordUsage(lab.db, { runId: lab.runId, workerId: w.id, usage: r.usage, durationMs: r.durationMs }, lab.clock);
      });
    } else if (s.path === 'reconciled') {
      finishWorker(lab.db, w.id, outcome, lab.clock, OWNER);
    } else if (s.path === 'collected') {
      const row = finishWorker(lab.db, w.id, outcome, lab.clock, OWNER);
      await survive('collected', () => accountWorker(lab.ctx(), row, r));
    } else {
      await survive('supervised', () => collectIfFinished(lab.ctx(), w));
    }
  };
  const running = (): WorkerRecord[] => listWorkers(lab.db, { runId: lab.runId }).filter((w) => w.state === 'RUNNING');

  for (let step = 0; step < 16; step++) {
    const op = pick(['start', 'start', 'finish', 'finish', 'charge', 'plan', 'crash'] as const);
    if (op === 'start') {
      const id = `wrk-${seed}-${sessions.size + 1}`;
      const path = pick(PATHS);
      const role = path === 'engine' ? 'inquisitor' : pick(ROLES);
      sessions.set(id, { id, path, cost: Math.round(next() * 50) / 100 });
      seen.paths.add(path);
      const workerDir = join(lab.base, 'w', id);
      mkdirSync(workerDir, { recursive: true });
      planWorker(lab.db, { id, runId: lab.runId, role, purpose: `p:${id}`, provider: 'claude', model: null, workerDir, cwd: lab.repo }, lab.clock, OWNER);
      markWorkerRunning(lab.db, id, { pid: 2_000_000_000, pgid: 2_000_000_000, procStart: 'x' }, lab.clock, OWNER);
    } else if (op === 'finish') {
      const live = running();
      if (live.length > 0) await finish(pick(live));
    } else if (op === 'charge') {
      const all = listWorkers(lab.db, { runId: lab.runId });
      if (all.length > 0) await survive('charge', () => chargeRecordedUsage(lab.ctx(), getWorker(lab.db, pick(all).id)));
    } else if (op === 'plan') {
      if (getRun(lab.db, lab.runId).state === 'PLANNING') await survive('plan', () => planningStep(lab.ctx()));
    } else {
      armed = Math.floor(next() * 3);
    }
  }

  // The run resumes: nothing kills it now, every session ends, PLANNING completes and every charge pass runs.
  armed = null;
  for (const w of running()) await finish(w);
  if (getRun(lab.db, lab.runId).state === 'PLANNING') await planningStep(lab.ctx());
  for (const w of listWorkers(lab.db, { runId: lab.runId })) chargeRecordedUsage(lab.ctx(), getWorker(lab.db, w.id));
  // And again: a second pass over everything charges nothing more.
  for (const w of listWorkers(lab.db, { runId: lab.runId })) chargeRecordedUsage(lab.ctx(), getWorker(lab.db, w.id));

  const spent = Math.round([...sessions.values()].reduce((t, s) => t + s.cost, 0) * 100) / 100;
  const charged = lab.ctx().ledger!.state('cost_usd').used;
  const rows = lab.db.all<{ id: number; worker_id: string }>('SELECT id, worker_id FROM usage WHERE run_id = ? ORDER BY id', lab.runId);
  const marks = lab.db
    .all<{ data_json: string }>('SELECT data_json FROM events WHERE run_id = ? AND type = ?', lab.runId, USAGE_CHARGED_EVENT)
    .flatMap((e) => (JSON.parse(e.data_json) as { usage_ids: number[] }).usage_ids);
  const context = `seed ${seed}: ${[...sessions.values()].map((s) => `${s.id} ${s.path} $${s.cost}`).join(', ')}`;
  expect(rows.map((r) => r.worker_id).sort(), context).toEqual([...sessions.keys()].sort());
  expect(Math.round(charged * 100) / 100, context).toBe(spent);
  expect([...marks].sort((a, b) => a - b), context).toEqual(rows.map((r) => r.id));
}
