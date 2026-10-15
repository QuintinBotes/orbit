// Third adversarial review of fix/031-budget. 0.3.1's accounting (a charge mark on every usage record, usage recorded
// from stored results, every session settled by the run's end) applies only to a run started on 0.3.1 or later, which
// records it when it is created: a run started on 0.3.0 keeps 0.3.0's accounting when it is resumed, and its spend line
// says so. A worker stopped at the run's end with nothing to collect is recorded and charged as one stopped mid-run is.
// A stand-in charge is attributed to the usage record its mark names, never to every record of a worker id.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProviderAdapter, TaskHandle, TaskResult } from '../../../src/adapters/types.ts';
import { Controller } from '../../../src/controller/loop.ts';
import { finalizeRun } from '../../../src/controller/report.ts';
import { getRun } from '../../../src/controller/run-store.ts';
import { finishRun } from '../../../src/controller/steps/common.ts';
import { planningStep } from '../../../src/controller/steps/planning.ts';
import { cancelObsoleteWork } from '../../../src/controller/steps/reviewing.ts';
import { accountWorker, chargeRecordedUsage, ensureWorker, recordSpendCap, settleRunUsage, settleUnsettledSessions, stopAndSettle, USAGE_CHARGED_EVENT } from '../../../src/controller/workers.ts';
import { reconcileOnStart } from '../../../src/recovery/reconcile.ts';
import { recordUsage } from '../../../src/routing/usage.ts';
import { spendBreakdown } from '../../../src/scheduling/budget.ts';
import { appendEvent } from '../../../src/storage/events.ts';
import { finishWorker, getWorker, listWorkers, markWorkerRunning, planWorker, type WorkerRecord } from '../../../src/storage/workers.ts';
import { addCandidate, initLedger, makeUnitLab, OWNER, setContract, type UnitLab } from './coverage-helpers.ts';

let lab: UnitLab;
afterEach(() => {
  vi.restoreAllMocks();
  lab?.cleanup();
});

const DEAD = 2_000_000_000;
const usageOf = (cost: number | null, tokens: number | null = 10): TaskResult['usage'] => ({ provider: 'claude', model: null, inputTokens: tokens, outputTokens: tokens, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: cost, costSource: cost === null ? 'unavailable' : 'reported' });
const resultOf = (cost: number | null, status: TaskResult['status'] = 'succeeded', tokens: number | null = 10): TaskResult => ({ status, structured: {}, text: null, error: null, exitCode: status === 'succeeded' ? 0 : null, usage: usageOf(cost, tokens), durationMs: 10 });
const used = (): number => lab.ctx().ledger!.state('cost_usd').used;
const marks = (): { usage_ids: number[]; source: string }[] => lab.db.all<{ data_json: string }>('SELECT data_json FROM events WHERE run_id = ? AND type = ?', lab.runId, USAGE_CHARGED_EVENT).map((e) => JSON.parse(e.data_json) as { usage_ids: number[]; source: string });
const usageRows = (): { worker_id: string; cost_usd: number | null }[] => lab.db.all('SELECT worker_id, cost_usd FROM usage WHERE run_id = ? ORDER BY id', lab.runId);
const markedOnce = (): void => {
  const ids = marks().flatMap((m) => m.usage_ids).sort((a, b) => a - b);
  expect(ids).toEqual(lab.db.all<{ id: number }>('SELECT id FROM usage WHERE run_id = ? ORDER BY id', lab.runId).map((r) => r.id));
};

function running(id: string, role: string, opts: { purpose?: string; pid?: boolean; candidateId?: string } = {}): WorkerRecord {
  const workerDir = join(lab.base, 'w', id);
  mkdirSync(workerDir, { recursive: true });
  if (opts.pid) writeFileSync(join(workerDir, 'pid.json'), JSON.stringify({ version: 1, shimPid: DEAD, shimStart: 'x', pgid: DEAD, childPid: null, childStart: null, sessionId: null, argvHash: 'h', startedAt: 1 }));
  planWorker(lab.db, { id, runId: lab.runId, role: role as WorkerRecord['role'], purpose: opts.purpose ?? `p:${id}`, provider: 'claude', model: null, workerDir, cwd: lab.repo, ...(opts.candidateId ? { candidateId: opts.candidateId } : {}) }, lab.clock, OWNER);
  return markWorkerRunning(lab.db, id, { pid: DEAD, pgid: DEAD, procStart: 'x' }, lab.clock, OWNER);
}

function succeeded(w: WorkerRecord, r: TaskResult): WorkerRecord {
  return finishWorker(lab.db, w.id, { state: 'SUCCEEDED', exitCode: 0, resultStatus: 'succeeded', result: r, error: null }, lab.clock, OWNER);
}

/** The run as 0.3.0 created it: its run.created event names no accounting. */
function startedOn030(): void {
  lab.db.run("UPDATE events SET data_json = json_remove(data_json, '$.accounting') WHERE run_id = ? AND type = 'run.created'", lab.runId);
}

const LEGACY_NOTE = 'this run was started before Orbit 0.3.1 and is accounted under the rules of the version that started it, which did not record the session each charge covers, so these figures are as recorded';

describe('a run records the accounting it is charged by when it is created', () => {
  it('a run started on 0.3.1 names it in its run.created event', () => {
    lab = makeUnitLab();
    const created = lab.db.get<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'run.created'", lab.runId)!;
    expect(JSON.parse(created.data_json)).toMatchObject({ accounting: 1 });
  });
});

describe('a run started on 0.3.0 and resumed on 0.3.1 keeps 0.3.0 accounting', () => {
  /** PLANNING and an implementer under 0.3.0, then a reviewer whose charge exhausted the budget: 0.3.0 committed the charge and threw before recording its usage, leaving its result stored. */
  function exhaustedOn030(): void {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING'] });
    startedOn030();
    const ledger = initLedger(lab);
    const p = succeeded(running('wrk-plan', 'planner'), resultOf(0.2));
    recordUsage(lab.db, { runId: lab.runId, workerId: p.id, usage: usageOf(0.2), durationMs: 10 }, lab.clock);
    ledger.consumeCost({ costUsd: 0.2, costSource: 'reported' }, 'planner');
    lab.db.tx(() => appendEvent(lab.db, lab.runId, 'budget.precharged', OWNER, { usage_rows: 1, charged_usd: 0.2 }, lab.clock.now()));
    lab.walk(['IMPLEMENTING']);
    const i = succeeded(running('wrk-impl', 'implementer'), resultOf(0.5));
    ledger.consumeCost({ costUsd: 0.5, costSource: 'reported' }, 'implementer');
    recordUsage(lab.db, { runId: lab.runId, workerId: i.id, usage: usageOf(0.5), durationMs: 10 }, lab.clock);
    succeeded(running('wrk-rev', 'reviewer'), resultOf(0.5));
    ledger.consumeCost({ costUsd: 0.5, costSource: 'reported' }, 'reviewer', { phase: 'final' });
    lab.walk(['EXHAUSTED']);
    lab.clock.advance(1000);
  }

  it('its ledger is unchanged by every settlement path, and its spend line says which rules account for it', async () => {
    exhaustedOn030();
    expect(used()).toBeCloseTo(1.2, 6);
    // 0.3.1 starts: the report repair over recently ended runs, the run's settlement, every charge pass, the step backstop.
    (new Controller({ mode: 'service', deps: lab.deps }) as unknown as { ensureFinalReports(): void }).ensureFinalReports();
    expect(settleRunUsage(lab.ctx())).toBe(false);
    settleUnsettledSessions(lab.ctx());
    for (const w of listWorkers(lab.db, { runId: lab.runId })) chargeRecordedUsage(lab.ctx(), getWorker(lab.db, w.id));
    await finalizeRun(lab.ctx());
    expect(used()).toBeCloseTo(1.2, 6);
    expect(usageRows()).toEqual([{ worker_id: 'wrk-plan', cost_usd: 0.2 }, { worker_id: 'wrk-impl', cost_usd: 0.5 }]);
    expect(marks()).toEqual([]);
    const s = spendBreakdown(lab.db, lab.runId);
    expect(s).toMatchObject({ accounting: 'legacy', charged_usd: 1.2, reported_usd: 0.7, reported_sessions: 2, precharged_usd: 0.2, unmatched_usd: null, uncharged_usd: null });
    expect(s.explanation).toBe(`$1.20 charged to the cost budget (the figure the cost cap is checked against); recorded usage: $0.70 reported by providers (2 sessions); $0.20 of it was spent before PLANNING and charged when the budget was created; ${LEGACY_NOTE}`);
    const md = readFileSync(join(dirname(getRun(lab.db, lab.runId).policyPath), 'final.md'), 'utf8');
    expect(md).toContain(`- spend: ${s.explanation}\n`);
  });

  it('a session collected after the upgrade is charged and then recorded, as 0.3.0 did; nothing is marked or backfilled', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING'] });
    startedOn030();
    const ledger = initLedger(lab);
    lab.db.tx(() => appendEvent(lab.db, lab.runId, 'budget.precharged', OWNER, { usage_rows: 0, charged_usd: 0 }, lab.clock.now()));
    lab.walk(['IMPLEMENTING']);
    // The engine recorded an inquisitor's usage under 0.3.0, which charged nothing for it.
    const q = succeeded(running('wrk-inq', 'inquisitor'), resultOf(0.07));
    recordUsage(lab.db, { runId: lab.runId, workerId: q.id, usage: usageOf(0.07), durationMs: 10 }, lab.clock);
    ledger.consumeCost({ costUsd: 0.3, costSource: 'reported' }, 'implementer');
    const r = resultOf(1.5);
    accountWorker(lab.ctx(), succeeded(running('wrk-impl', 'implementer'), r), r);
    expect(used()).toBeCloseTo(1.8, 6);
    accountWorker(lab.ctx(), getWorker(lab.db, 'wrk-impl'), r);
    for (const w of listWorkers(lab.db, { runId: lab.runId })) chargeRecordedUsage(lab.ctx(), getWorker(lab.db, w.id));
    settleRunUsage(lab.ctx());
    expect(used()).toBeCloseTo(1.8, 6);
    expect(marks()).toEqual([]);
    expect(usageRows()).toEqual([{ worker_id: 'wrk-inq', cost_usd: 0.07 }, { worker_id: 'wrk-impl', cost_usd: 1.5 }]);
  });

  it('sessions collected after the upgrade still reach the cost cap', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING'] });
    startedOn030();
    initLedger(lab);
    lab.walk(['IMPLEMENTING']);
    const cap = lab.ctx().ledger!.state('cost_usd').hard_cap;
    let exhausted = false;
    for (let i = 0; exhausted === false && i < 100; i++) {
      const r = resultOf(2);
      try {
        accountWorker(lab.ctx(), succeeded(running(`wrk-i${i}`, 'implementer'), r), r);
      } catch (err) {
        expect(err).toMatchObject({ code: 'BUDGET_EXHAUSTED' });
        exhausted = true;
      }
    }
    expect(exhausted).toBe(true);
    expect(used()).toBeLessThanOrEqual(cap + 2);
    expect(marks()).toEqual([]);
  });

  it('a lost attempt reconciliation restarts records nothing for it, as 0.3.0 did', async () => {
    const adapter = { id: 'claude', reattach: (dir: string): TaskHandle => ({ provider: 'claude', workerId: '', workerDir: dir, pid: DEAD, pgid: DEAD, procStart: 'x', logPath: '', exitPath: '' }), collectResult: async () => resultOf(0.6, 'lost') } as unknown as ProviderAdapter;
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'], adapters: { claude: adapter } });
    startedOn030();
    initLedger(lab);
    running('wrk-impl', 'implementer', { purpose: 'implement:1#1', pid: true });
    await reconcileOnStart({ db: lab.db, ownerId: OWNER, clock: lab.clock, adapters: lab.deps.adapters, graceMs: 50, runIds: [lab.runId], ledgerFor: () => lab.ctx().ledger, fallbackRecoveries: 3 });
    expect(getWorker(lab.db, 'wrk-impl').state).toBe('PLANNED');
    expect(usageRows()).toEqual([]);
    const restart = lab.db.get<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'recovery.worker-restart'", lab.runId)!;
    expect(JSON.parse(restart.data_json)).not.toHaveProperty('usage_id');
  });

  it('PLANNING resumed on 0.3.1 precharges by 0.3.0\'s rules and marks nothing', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING'] });
    startedOn030();
    mkdirSync(lab.ctx().runDir, { recursive: true });
    setContract(lab);
    lab.deps.registry.seed();
    for (const e of lab.deps.registry.list()) if (e.provider === 'claude') lab.deps.registry.markAvailability(e.modelId, 'claude-cli', true, 'test');
    succeeded(running('wrk-a', 'planner'), resultOf(0.4));
    recordUsage(lab.db, { runId: lab.runId, workerId: 'wrk-a', usage: usageOf(0.4), durationMs: 1 }, lab.clock);
    // Reconciliation stored this one's result under 0.3.0 and recorded no usage: 0.3.0 never charged it, and 0.3.1 does not backfill it.
    succeeded(running('wrk-b', 'planner'), resultOf(0.3));
    await planningStep(lab.ctx());
    expect(used()).toBeCloseTo(0.4, 6);
    expect(usageRows()).toEqual([{ worker_id: 'wrk-a', cost_usd: 0.4 }]);
    expect(marks()).toEqual([]);
    const pre = lab.db.get<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'budget.precharged'", lab.runId)!;
    expect(JSON.parse(pre.data_json)).toEqual({ usage_rows: 1, charged_usd: 0.4 });
  });
});

// Codex (fix/031-budget, third review): stopActiveWorkers finished a started worker with a null result when its files
// were missing, and settlement skipped a null result, so a stop at the run's end left no usage record and no charge
// while the same stop mid-run recorded one and charged the session cap.
describe('a started worker stopped with nothing to collect', () => {
  for (const when of ['mid-run', 'at the run\'s end'] as const) {
    it(`is recorded unmeasured and charged its session cap ${when}, and the spend line names it`, async () => {
      const adapter = { id: 'claude', collectResult: async () => null, cancelTask: async () => undefined } as unknown as ProviderAdapter;
      lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING'], adapters: { claude: adapter } });
      mkdirSync(lab.ctx().runDir, { recursive: true });
      setContract(lab);
      initLedger(lab);
      lab.db.tx(() => appendEvent(lab.db, lab.runId, 'budget.precharged', OWNER, { usage_rows: 0, charged_usd: 0, usage_marked: true }, lab.clock.now()));
      recordSpendCap(lab.ctx(), 'review:1', 7, 0.5);
      // Its files are gone: no pid.json, nothing to collect.
      running('wrk-rev', 'reviewer', { purpose: 'review:1' });
      if (when === 'mid-run') await stopAndSettle(lab.ctx(), getWorker(lab.db, 'wrk-rev'), 'obsolete', 'final');
      else await finishRun(lab.ctx(), 'EXHAUSTED', 'review_rounds hard cap reached');
      expect(getWorker(lab.db, 'wrk-rev').state).toBe('CANCELLED');
      expect(lab.db.all('SELECT cost_usd, cost_source FROM usage WHERE worker_id = ?', 'wrk-rev')).toEqual([{ cost_usd: null, cost_source: 'unavailable' }]);
      expect(used()).toBeCloseTo(7.5, 6);
      const s = spendBreakdown(lab.db, lab.runId);
      expect(s).toMatchObject({ accounting: 'current', ceiling_usd: 7.5, ceiling_sessions: 1, unmatched_usd: 0, uncharged_usd: 0, unmeasured_sessions: [{ worker_id: 'wrk-rev', role: 'reviewer', charged_usd: 7.5 }] });
      expect(s.explanation).toBe('$7.50 charged to the cost budget (the figure the cost cap is checked against): $7.50 at conservative ceilings for 1 session that reported no cost and could not be priced (reviewer wrk-rev)');
      if (when !== 'mid-run') expect(readFileSync(join(lab.ctx().runDir, 'final.md'), 'utf8')).toContain('(reviewer wrk-rev)');
      // Settled once: the run's settlement charges nothing more.
      settleRunUsage(lab.ctx());
      expect(used()).toBeCloseTo(7.5, 6);
      markedOnce();
    });
  }

  it('a worker that never started is not a session: stopped mid-run or at the end it is neither recorded nor charged', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING'] });
    initLedger(lab);
    const cand = addCandidate(lab, { tree: 'a'.repeat(40) });
    const dir = join(lab.base, 'w', 'wrk-planned');
    mkdirSync(dir, { recursive: true });
    planWorker(lab.db, { id: 'wrk-planned', runId: lab.runId, role: 'reviewer', purpose: 'review:x', provider: 'claude', model: null, workerDir: dir, cwd: lab.repo, candidateId: cand.id }, lab.clock, OWNER);
    expect(await cancelObsoleteWork(lab.ctx(), 'b'.repeat(40))).toEqual(['wrk-planned']);
    expect(getWorker(lab.db, 'wrk-planned').state).toBe('CANCELLED');
    expect(usageRows()).toEqual([]);
    expect(used()).toBe(0);
    settleRunUsage(lab.ctx());
    expect(used()).toBe(0);
  });

  it('one reconciliation stopped as its run ended is recorded and charged when the controller next starts', async () => {
    const adapter = { id: 'claude', collectResult: async () => null } as unknown as ProviderAdapter;
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'], adapters: { claude: adapter } });
    initLedger(lab);
    recordSpendCap(lab.ctx(), 'implement:1#1', 2, 0.5);
    running('wrk-impl', 'implementer', { purpose: 'implement:1#1', pid: true });
    lab.walk(['EXHAUSTED']);
    await reconcileOnStart({ db: lab.db, ownerId: OWNER, clock: lab.clock, adapters: lab.deps.adapters, graceMs: 50, runIds: [lab.runId] });
    expect(getWorker(lab.db, 'wrk-impl').state).toBe('CANCELLED');
    (new Controller({ mode: 'service', deps: lab.deps }) as unknown as { ensureFinalReports(): void }).ensureFinalReports();
    expect(lab.db.all('SELECT cost_usd FROM usage WHERE worker_id = ?', 'wrk-impl')).toEqual([{ cost_usd: null }]);
    expect(used()).toBeCloseTo(2.5, 6);
    expect(readFileSync(join(dirname(getRun(lab.db, lab.runId).policyPath), 'final.md'), 'utf8')).toContain('(implementer wrk-impl)');
    markedOnce();
  });
});

// Codex (fix/031-budget, third review): recovery restarts a lost worker on the same row, so one worker id has two
// sessions. A stand-in charge named the worker id and stood for every usage record of it: a lost attempt charged a $6
// ceiling and its restart's $0.50 read as $0 reported across 0 sessions and $0.50 charged with no matching usage record.
describe('a lost attempt and its restart under one worker id', () => {
  it('each session is counted by the charge its usage record\'s mark names', async () => {
    let attempt: 'lost' | 'restarted' = 'lost';
    const adapter = {
      id: 'claude',
      reattach: (dir: string): TaskHandle => ({ provider: 'claude', workerId: '', workerDir: dir, pid: DEAD, pgid: DEAD, procStart: 'x', logPath: '', exitPath: '' }),
      collectResult: async () => (attempt === 'lost' ? resultOf(null, 'lost', null) : resultOf(0.5)),
    } as unknown as ProviderAdapter;
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'], adapters: { claude: adapter } });
    initLedger(lab);
    recordSpendCap(lab.ctx(), 'implement:1#1', 5.5, 0.5);
    running('wrk-impl', 'implementer', { purpose: 'implement:1#1', pid: true });
    await reconcileOnStart({ db: lab.db, ownerId: OWNER, clock: lab.clock, adapters: lab.deps.adapters, graceMs: 50, runIds: [lab.runId], ledgerFor: () => lab.ctx().ledger, fallbackRecoveries: 3 });
    attempt = 'restarted';
    lab.db.run("UPDATE workers SET state = 'RUNNING', pid = ?, pgid = ?, proc_start = 'x' WHERE id = 'wrk-impl'", DEAD, DEAD);
    const st = await ensureWorker(lab.ctx(), { role: 'implementer', purpose: 'implement:1#1', provider: 'claude', model: null, effort: null, cwd: lab.repo, readOnly: false, prompt: () => 'x' });
    expect(st.status).toBe('finished');
    expect(usageRows()).toEqual([{ worker_id: 'wrk-impl', cost_usd: null }, { worker_id: 'wrk-impl', cost_usd: 0.5 }]);
    expect(used()).toBeCloseTo(6.5, 6);
    const s = spendBreakdown(lab.db, lab.runId);
    expect(s).toMatchObject({ charged_usd: 6.5, reported_usd: 0.5, reported_sessions: 1, ceiling_usd: 6, ceiling_sessions: 1, unpriced_sessions: 0, unmatched_usd: 0, uncharged_usd: 0 });
    expect(s.explanation).toBe('$6.50 charged to the cost budget (the figure the cost cap is checked against): $0.50 reported by providers (1 session) + $6.00 at conservative ceilings for 1 session that reported no cost and could not be priced (implementer wrk-impl)');
    markedOnce();
  });
});
