// Every session that spent is charged once, on every path that ends it (second adversarial review of fix/031-budget):
// the curator after the report, a worker stopped as obsolete mid-run, a lost attempt reconciliation restarts, and a
// lost inquisitor with nothing to collect. A run started before 0.3.1 keeps 0.3.0's accounting instead
// (accounting-version.test.ts).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProviderAdapter, TaskHandle, TaskResult } from '../../../src/adapters/types.ts';
import { Controller } from '../../../src/controller/loop.ts';
import { runCurator, writeFinalReport, type CuratorHost } from '../../../src/controller/report.ts';
import { getRun } from '../../../src/controller/run-store.ts';
import { step } from '../../../src/controller/steps/index.ts';
import { cancelObsoleteWork } from '../../../src/controller/steps/reviewing.ts';
import { chargeRecordedUsage, collectIfFinished, committedSpendUsd, ensureWorker, recordSpendCap, settleRunUsage, USAGE_CHARGED_EVENT } from '../../../src/controller/workers.ts';
import { reconcileOnStart } from '../../../src/recovery/reconcile.ts';
import { BudgetLedger } from '../../../src/scheduling/budget.ts';
import { appendEvent } from '../../../src/storage/events.ts';
import { finishWorker, getWorker, listWorkers, markWorkerRunning, planWorker, type WorkerRecord } from '../../../src/storage/workers.ts';
import { addCandidate, initLedger, makeUnitLab, OWNER, setContract, type UnitLab } from './coverage-helpers.ts';

let lab: UnitLab;
afterEach(() => {
  vi.restoreAllMocks();
  lab?.cleanup();
});

const DEAD = 2_000_000_000;
const usageOf = (cost: number | null): TaskResult['usage'] => ({ provider: 'claude', model: null, inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: cost, costSource: cost === null ? 'unavailable' : 'reported' });
const resultOf = (cost: number, status: TaskResult['status'] = 'succeeded'): TaskResult => ({ status, structured: {}, text: null, error: null, exitCode: status === 'succeeded' ? 0 : null, usage: usageOf(cost), durationMs: 10 });
const used = (): number => lab.ctx().ledger!.state('cost_usd').used;
const marks = (): { usage_ids: number[]; source: string }[] => lab.db.all<{ data_json: string }>('SELECT data_json FROM events WHERE run_id = ? AND type = ?', lab.runId, USAGE_CHARGED_EVENT).map((e) => JSON.parse(e.data_json) as { usage_ids: number[]; source: string });
const markedOnce = (): void => {
  const ids = marks().flatMap((m) => m.usage_ids).sort((a, b) => a - b);
  expect(ids).toEqual(lab.db.all<{ id: number }>('SELECT id FROM usage WHERE run_id = ? ORDER BY id', lab.runId).map((r) => r.id));
};

function running(id: string, role: string, opts: { purpose?: string; pid?: boolean; exit?: boolean; candidateId?: string } = {}): WorkerRecord {
  const workerDir = join(lab.base, 'w', id);
  mkdirSync(workerDir, { recursive: true });
  if (opts.pid) writeFileSync(join(workerDir, 'pid.json'), JSON.stringify({ version: 1, shimPid: DEAD, shimStart: 'x', pgid: DEAD, childPid: null, childStart: null, sessionId: null, argvHash: 'h', startedAt: 1 }));
  if (opts.exit) writeFileSync(join(workerDir, 'exit.json'), JSON.stringify({ version: 1, code: 0, signal: null, timedOut: false, cancelled: false, aborted: null, endedAt: 2, startedAt: 1 }));
  planWorker(lab.db, { id, runId: lab.runId, role: role as WorkerRecord['role'], purpose: opts.purpose ?? `p:${id}`, provider: 'claude', model: null, workerDir, cwd: lab.repo, ...(opts.candidateId ? { candidateId: opts.candidateId } : {}) }, lab.clock, OWNER);
  return markWorkerRunning(lab.db, id, { pid: DEAD, pgid: DEAD, procStart: 'x' }, lab.clock, OWNER);
}

function succeeded(w: WorkerRecord, r: TaskResult): WorkerRecord {
  return finishWorker(lab.db, w.id, { state: 'SUCCEEDED', exitCode: 0, resultStatus: 'succeeded', result: r, error: null }, lab.clock, OWNER);
}

describe('the curator, which runs after the report is written', () => {
  it('a curator a crash left running is recorded and charged after the restart, and the report says so', async () => {
    const adapter = { id: 'claude', collectResult: async () => resultOf(0.12) } as unknown as ProviderAdapter;
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'], adapters: { claude: adapter } });
    initLedger(lab);
    lab.walk(['EXHAUSTED']);
    const runDir = dirname(getRun(lab.db, lab.runId).policyPath);
    writeFinalReport(lab.db, lab.runId, { runDir, clock: lab.clock, snapshot: lab.ctx().snapshot });
    const before = readFileSync(join(runDir, 'final.md'), 'utf8');
    running(`${lab.runId}-curator-1`, 'curator', { purpose: 'curate:1', pid: true, exit: true });
    await reconcileOnStart({ db: lab.db, ownerId: OWNER, clock: lab.clock, adapters: lab.deps.adapters, graceMs: 50, runIds: [lab.runId] });
    expect(getWorker(lab.db, `${lab.runId}-curator-1`).state).toBe('SUCCEEDED');
    (new Controller({ mode: 'service', deps: lab.deps }) as unknown as { ensureFinalReports(): void }).ensureFinalReports();
    expect(lab.db.all('SELECT cost_usd FROM usage WHERE worker_id = ?', `${lab.runId}-curator-1`)).toEqual([{ cost_usd: 0.12 }]);
    expect(used()).toBeCloseTo(0.12, 6);
    const after = readFileSync(join(runDir, 'final.md'), 'utf8');
    expect(after).not.toBe(before);
    expect(after).toContain('$0.12');
    // Settled once: another repair pass changes nothing.
    (new Controller({ mode: 'service', deps: lab.deps }) as unknown as { ensureFinalReports(): void }).ensureFinalReports();
    expect(used()).toBeCloseTo(0.12, 6);
    markedOnce();
  });

  it('the curator\'s result, usage and charge commit together: a crash inside its charge leaves it to be collected again', async () => {
    const adapter = { id: 'claude', startTask: async (spec: { workerId: string; workerDir: string }): Promise<TaskHandle> => ({ provider: 'claude', workerId: spec.workerId, workerDir: spec.workerDir, pid: DEAD, pgid: DEAD, procStart: 'x', logPath: '', exitPath: '' }), collectResult: async () => resultOf(0.12) } as unknown as ProviderAdapter;
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'], adapters: { claude: adapter } });
    initLedger(lab);
    lab.walk(['EXHAUSTED']);
    const ctx = lab.ctx();
    const host: CuratorHost = { deps: lab.deps, clock: lab.clock, snapshot: ctx.snapshot, policyPath: ctx.run.policyPath, policyHash: ctx.run.policyHash, runId: lab.runId, dir: join(ctx.runDir, 'learning'), budgetUsd: 0.5, recorded: ctx };
    vi.spyOn(BudgetLedger.prototype, 'consumeCost').mockImplementation(() => {
      throw new Error('controller killed');
    });
    await runCurator(host, { prompt: 'p' }, null).catch(() => null);
    vi.restoreAllMocks();
    const [w] = listWorkers(lab.db, { runId: lab.runId, role: 'curator' });
    expect(w?.state).toBe('RUNNING');
    expect(lab.db.all('SELECT 1 FROM usage WHERE worker_id = ?', w!.id)).toEqual([]);
  });
});

describe('a worker stopped mid-run', () => {
  it('an obsolete reviewer is charged as it is stopped, before the next session is funded', async () => {
    const adapter = { id: 'claude', collectResult: async () => resultOf(6, 'cancelled'), cancelTask: async () => undefined } as unknown as ProviderAdapter;
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING'], adapters: { claude: adapter } });
    lab.deps.registry.seed();
    initLedger(lab);
    const old = addCandidate(lab, { tree: 'a'.repeat(40), commit: '1'.repeat(40) });
    const cur = addCandidate(lab, { tree: 'b'.repeat(40), commit: '2'.repeat(40), attempt: 2 });
    recordSpendCap(lab.ctx(), 'review:old', 7, 0.5);
    running('wrk-rev', 'reviewer', { purpose: 'review:old', pid: true, exit: true, candidateId: old.id });
    expect(committedSpendUsd(lab.ctx())).toBeCloseTo(7.5, 6);
    expect(await cancelObsoleteWork(lab.ctx(), cur.treeHash)).toEqual(['wrk-rev']);
    expect(getWorker(lab.db, 'wrk-rev').state).toBe('CANCELLED');
    expect(lab.db.all('SELECT cost_usd FROM usage WHERE worker_id = ?', 'wrk-rev')).toEqual([{ cost_usd: 6 }]);
    expect(used()).toBeCloseTo(6, 6);
    expect(committedSpendUsd(lab.ctx())).toBe(0);
    markedOnce();
  });

  it('a session stored without usage that no step asks for again is charged at the start of the next step', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    setContract(lab);
    initLedger(lab);
    lab.db.tx(() => appendEvent(lab.db, lab.runId, 'budget.precharged', OWNER, { usage_rows: 0, charged_usd: 0, usage_marked: true }, lab.clock.now()));
    // Reconciliation or the watchdog stored this explorer's result; no usage record, no charge.
    succeeded(running('wrk-exp', 'explorer'), resultOf(0.8));
    await step(lab.deps, lab.runId, new AbortController().signal);
    expect(lab.db.all('SELECT cost_usd FROM usage WHERE worker_id = ?', 'wrk-exp')).toEqual([{ cost_usd: 0.8 }]);
    expect(used()).toBeCloseTo(0.8, 6);
    markedOnce();
  });
});

describe('a lost worker reconciliation restarts', () => {
  it('what the lost attempt spent is recorded with the restart and charged, as well as the restarted session', async () => {
    let attempt: 'lost' | 'restarted' = 'lost';
    const handle = (dir: string): TaskHandle => ({ provider: 'claude', workerId: '', workerDir: dir, pid: DEAD, pgid: DEAD, procStart: 'x', logPath: '', exitPath: '' });
    const adapter = { id: 'claude', reattach: handle, collectResult: async () => (attempt === 'lost' ? resultOf(0.6, 'lost') : resultOf(0.4)) } as unknown as ProviderAdapter;
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'], adapters: { claude: adapter } });
    initLedger(lab);
    running('wrk-impl', 'implementer', { purpose: 'implement:1#1', pid: true });
    const rep = await reconcileOnStart({ db: lab.db, ownerId: OWNER, clock: lab.clock, adapters: lab.deps.adapters, graceMs: 50, runIds: [lab.runId], ledgerFor: () => lab.ctx().ledger, fallbackRecoveries: 3 });
    expect(rep.runs[0]?.workers[0]).toMatchObject({ observation: 'lost', restartPlanned: true, state: 'PLANNED' });
    expect(lab.db.all('SELECT cost_usd FROM usage WHERE worker_id = ?', 'wrk-impl')).toEqual([{ cost_usd: 0.6 }]);
    // The restarted session runs and is collected: its own usage is recorded beside the lost attempt's.
    attempt = 'restarted';
    lab.db.run("UPDATE workers SET state = 'RUNNING', pid = ?, pgid = ?, proc_start = 'x' WHERE id = 'wrk-impl'", DEAD, DEAD);
    const st = await ensureWorker(lab.ctx(), { role: 'implementer', purpose: 'implement:1#1', provider: 'claude', model: null, effort: null, cwd: lab.repo, readOnly: false, prompt: () => 'x' });
    expect(st.status).toBe('finished');
    expect(lab.db.all('SELECT cost_usd FROM usage WHERE worker_id = ? ORDER BY id', 'wrk-impl')).toEqual([{ cost_usd: 0.6 }, { cost_usd: 0.4 }]);
    expect(used()).toBeCloseTo(1.0, 6);
    settleRunUsage(lab.ctx());
    expect(used()).toBeCloseTo(1.0, 6);
    markedOnce();
  });

  it('the lost attempt is charged before the next step funds anything, even before the restart is collected', async () => {
    const adapter = { id: 'claude', reattach: (dir: string): TaskHandle => ({ provider: 'claude', workerId: '', workerDir: dir, pid: DEAD, pgid: DEAD, procStart: 'x', logPath: '', exitPath: '' }), collectResult: async () => resultOf(0.6, 'lost') } as unknown as ProviderAdapter;
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'], adapters: { claude: adapter } });
    setContract(lab);
    initLedger(lab);
    lab.db.tx(() => appendEvent(lab.db, lab.runId, 'budget.precharged', OWNER, { usage_rows: 0, charged_usd: 0, usage_marked: true }, lab.clock.now()));
    running('wrk-impl', 'implementer', { purpose: 'implement:1#1', pid: true });
    await reconcileOnStart({ db: lab.db, ownerId: OWNER, clock: lab.clock, adapters: lab.deps.adapters, graceMs: 50, runIds: [lab.runId], ledgerFor: () => lab.ctx().ledger, fallbackRecoveries: 3 });
    expect(getWorker(lab.db, 'wrk-impl').state).toBe('PLANNED');
    await step(lab.deps, lab.runId, new AbortController().signal);
    expect(used()).toBeGreaterThanOrEqual(0.6 - 1e-9);
    expect(marks().flatMap((m) => m.usage_ids)).toContain(lab.db.get<{ id: number }>('SELECT id FROM usage WHERE worker_id = ?', 'wrk-impl')!.id);
  });
});

describe('a lost session with nothing to collect is charged like any other role', () => {
  it('an inquisitor the controller finds without a pid record', async () => {
    const adapter = { id: 'claude', reattach: () => null, collectResult: async () => null } as unknown as ProviderAdapter;
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'], adapters: { claude: adapter } });
    initLedger(lab);
    recordSpendCap(lab.ctx(), 'implement:1#1', 2, 0.5);
    recordSpendCap(lab.ctx(), 'inquire:x', 2, 0.5);
    running('wrk-impl', 'implementer', { purpose: 'implement:1#1' });
    await ensureWorker(lab.ctx(), { role: 'implementer', purpose: 'implement:1#1', provider: 'claude', model: null, effort: null, cwd: lab.repo, readOnly: false, prompt: () => 'x' });
    const implementer = used();
    expect(implementer).toBeGreaterThan(0);
    running('wrk-inq', 'inquisitor', { purpose: 'inquire:x' });
    expect(await collectIfFinished(lab.ctx(), getWorker(lab.db, 'wrk-inq'))).toBe(false);
    expect(getWorker(lab.db, 'wrk-inq').state).toBe('LOST');
    expect(lab.db.all('SELECT cost_usd, cost_source FROM usage WHERE worker_id = ?', 'wrk-inq')).toEqual([{ cost_usd: null, cost_source: 'unavailable' }]);
    expect(used() - implementer).toBeCloseTo(Math.min(2.5, lab.ctx().ledger!.roleCostCeiling('inquisitor')), 6);
    settleRunUsage(lab.ctx());
    expect(used() - implementer).toBeCloseTo(Math.min(2.5, lab.ctx().ledger!.roleCostCeiling('inquisitor')), 6);
    markedOnce();
  });

  it('an inquisitor reconciliation finds lost with no partial result', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'INQUISITION'], adapters: { claude: { id: 'claude', collectResult: async () => null } as unknown as ProviderAdapter } });
    initLedger(lab);
    recordSpendCap(lab.ctx(), 'inquire:y', 2, 0.5);
    const w = running('wrk-inq2', 'inquisitor', { purpose: 'inquire:y' });
    writeFileSync(join(w.workerDir, 'launch.json'), JSON.stringify({ requestedAt: 0 }));
    lab.clock.advance(10 * 60_000);
    await reconcileOnStart({ db: lab.db, ownerId: OWNER, clock: lab.clock, adapters: lab.deps.adapters, graceMs: 50, runIds: [lab.runId] });
    expect(getWorker(lab.db, 'wrk-inq2').state).toBe('LOST');
    expect(lab.db.all('SELECT cost_usd FROM usage WHERE worker_id = ?', 'wrk-inq2')).toEqual([{ cost_usd: null }]);
    chargeRecordedUsage(lab.ctx(), getWorker(lab.db, 'wrk-inq2'));
    settleRunUsage(lab.ctx());
    expect(used()).toBeCloseTo(Math.min(2.5, lab.ctx().ledger!.roleCostCeiling('inquisitor')), 6);
    markedOnce();
  });
});
