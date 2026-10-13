// Inquisitor spend is charged to cost_usd like every other worker's (0.3.0 retest audit): the Inquisition engine
// records an inquisitor's usage itself, so the controller never charged it, and every python run's cost_usd fell
// short of the measured spend by exactly its inquisitors (1.17 measured, 1.01 charged; 1.51 and 1.31; 0.27 and 0.22).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

type Engine = typeof import('../../../src/inquisition/engine.ts');
const hooks = vi.hoisted(() => ({ runInquisition: vi.fn() }));
vi.mock('../../../src/inquisition/engine.ts', async (orig) => ({ ...(await orig<Engine>()), runInquisition: hooks.runInquisition }));

const { inquisitionStep } = await import('../../../src/controller/steps/inquisition.ts');
const { chargeRecordedUsage } = await import('../../../src/controller/workers.ts');
const { getRun } = await import('../../../src/controller/run-store.ts');
const { finishWorker, getWorker, markWorkerRunning, planWorker } = await import('../../../src/storage/workers.ts');
const { recordUsage } = await import('../../../src/routing/usage.ts');
const { appendEvent } = await import('../../../src/storage/events.ts');
const { spendBreakdown } = await import('../../../src/scheduling/budget.ts');
const { initLedger, makeUnitLab, setContract, validContract, OWNER } = await import('./coverage-helpers.ts');
type UnitLab = import('./coverage-helpers.ts').UnitLab;
type TaskResult = import('../../../src/adapters/types.ts').TaskResult;

let lab: UnitLab;
// A block body: a function returned from beforeEach is run as its teardown, and mockReset returns the mock.
beforeEach(() => {
  hooks.runInquisition.mockReset();
});
afterEach(() => lab?.cleanup());

function setup(key = 'k:1'): void {
  lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING'], adapters: { claude: { id: 'claude', collectResult: async () => null } as never } });
  setContract(lab);
  lab.db.run('UPDATE runs SET worktree_path = ? WHERE id = ?', lab.repo, lab.runId);
  lab.deps.registry.seed();
  for (const e of lab.deps.registry.list()) if (e.provider === 'claude') lab.deps.registry.markAvailability(e.modelId, 'claude-cli', true, 'test');
  initLedger(lab);
  enterInquisition(key);
}

function enterInquisition(key: string): void {
  lab.walk(getRun(lab.db, lab.runId).state === 'IMPLEMENTING' ? ['INQUISITION'] : ['IMPLEMENTING', 'INQUISITION']);
  const trigger = { kind: 'hidden_decision', mode: 'risk-review', summary: 'a finding about financial effects', evidence: ['e'], subjects: [], key };
  lab.db.run("UPDATE events SET data_json = ? WHERE id = (SELECT MAX(id) FROM events WHERE run_id = ? AND type = 'state.transition' AND to_state = 'INQUISITION')", JSON.stringify({ reason: 'test', data: { trigger } }), lab.runId);
}

const sessionResult = (cost: number | null): TaskResult => ({ status: 'succeeded', structured: {}, text: null, error: null, exitCode: 0, usage: { provider: 'claude', model: null, inputTokens: 2, outputTokens: 3000, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: cost, costSource: cost === null ? 'unavailable' : 'reported' }, durationMs: 21_000 });

/** What the engine's runWorker leaves behind: a finished inquisitor and its usage row, recorded together, never charged. */
function engineRanInquisitor(id: string, cost: number | null): void {
  planWorker(lab.db, { id, runId: lab.runId, role: 'inquisitor', purpose: `inquire:${id}`, provider: 'claude', model: null, workerDir: join(lab.base, 'w', id), cwd: lab.repo }, lab.clock);
  markWorkerRunning(lab.db, id, { pid: 2_000_000_000, pgid: 2_000_000_000, procStart: 'x' }, lab.clock);
  const r = sessionResult(cost);
  lab.db.tx(() => {
    finishWorker(lab.db, id, { state: 'SUCCEEDED', exitCode: 0, resultStatus: 'succeeded', result: r, error: null }, lab.clock);
    recordUsage(lab.db, { runId: lab.runId, workerId: id, usage: r.usage, durationMs: r.durationMs }, lab.clock);
  });
}

const settled = (workerIds: string[]) => ({ disposition: 'continue', reason: 'settled', questions: [], blockedCriteria: [], rejectGreen: false, experiments: [], contract: validContract(lab), workerIds });
const charged = (): number => lab.ctx().ledger!.state('cost_usd').used;

describe('inquisitor spend', () => {
  it('an inquisitor the engine ran is charged to cost_usd when the inquiry settles, so the charge matches the measured spend', async () => {
    setup();
    hooks.runInquisition.mockImplementation(async () => {
      engineRanInquisitor('wrk-inq-1', 0.0777);
      return settled(['wrk-inq-1']);
    });
    await inquisitionStep(lab.ctx());
    expect(getRun(lab.db, lab.runId).state).toBe('IMPLEMENTING');
    expect(charged()).toBeCloseTo(0.0777, 6);
    expect(spendBreakdown(lab.db, lab.runId)).toMatchObject({ reported_usd: 0.0777, uncharged_usd: 0, unmatched_usd: 0 });
    const ev = lab.db.all<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'budget.usage-charged'", lab.runId);
    expect(ev.map((e) => JSON.parse(e.data_json))).toEqual([expect.objectContaining({ worker_id: 'wrk-inq-1', role: 'inquisitor', charged_usd: 0.0777 })]);
  });

  it('charges each inquisitor once, across later inquiries and restarted steps', async () => {
    setup('k:1');
    hooks.runInquisition.mockImplementationOnce(async () => {
      engineRanInquisitor('wrk-inq-1', 0.0777);
      return settled(['wrk-inq-1']);
    });
    await inquisitionStep(lab.ctx());
    enterInquisition('k:2');
    hooks.runInquisition.mockImplementationOnce(async () => {
      engineRanInquisitor('wrk-inq-2', 0.0804);
      return settled(['wrk-inq-2']);
    });
    await inquisitionStep(lab.ctx());
    expect(charged()).toBeCloseTo(0.1581, 6);
    chargeRecordedUsage(lab.ctx(), getWorker(lab.db, 'wrk-inq-1'));
    chargeRecordedUsage(lab.ctx(), getWorker(lab.db, 'wrk-inq-2'));
    expect(charged()).toBeCloseTo(0.1581, 6);
  });

  it('an inquisitor a crashed pass left uncharged is charged before the next inquiry, and one whose inquiry then failed is charged too', async () => {
    setup();
    engineRanInquisitor('wrk-inq-0', 0.02);
    hooks.runInquisition.mockImplementation(async () => {
      engineRanInquisitor('wrk-inq-1', 0.03);
      throw Object.assign(new Error('the provider failed transiently'), { code: 'PROVIDER_TRANSIENT' });
    });
    await expect(inquisitionStep(lab.ctx())).rejects.toThrow(/transiently/);
    expect(charged()).toBeCloseTo(0.05, 6);
  });

  it('an inquisitor that reported no cost is charged from its tokens, like any other session', async () => {
    setup();
    hooks.runInquisition.mockImplementation(async () => {
      engineRanInquisitor('wrk-inq-1', null);
      return settled(['wrk-inq-1']);
    });
    await inquisitionStep(lab.ctx());
    expect(charged()).toBeGreaterThan(0);
    expect(lab.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND type = 'budget.cost-token-estimated' AND json_extract(data_json, '$.worker_id') = 'wrk-inq-1'", lab.runId)?.n).toBe(1);
  });

  it('an inquisitor whose charge would cross the cap ends the run EXHAUSTED, with the charge recorded', async () => {
    setup();
    hooks.runInquisition.mockImplementation(async () => {
      engineRanInquisitor('wrk-inq-1', 31);
      return settled(['wrk-inq-1']);
    });
    await expect(inquisitionStep(lab.ctx())).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' });
    expect(charged()).toBe(31);
    // The charge and its mark committed together: charging it again on the next pass would count it twice.
    chargeRecordedUsage(lab.ctx(), getWorker(lab.db, 'wrk-inq-1'));
    expect(charged()).toBe(31);
  });

  it('an inquisitor collected after a controller restart is charged with its usage, and not again afterwards', async () => {
    setup();
    // accountWorker charges the session it collects and records its usage; the charge pass must see it as charged.
    const w = planWorker(lab.db, { id: 'wrk-inq-left', runId: lab.runId, role: 'inquisitor', purpose: 'inquire:left', provider: 'claude', model: null, workerDir: join(lab.base, 'w', 'left'), cwd: lab.repo }, lab.clock, OWNER);
    markWorkerRunning(lab.db, w.id, { pid: 2_000_000_000, pgid: 2_000_000_000, procStart: 'x' }, lab.clock, OWNER);
    const adapter = { id: 'claude', reattach: () => ({ provider: 'claude', workerId: w.id, workerDir: w.workerDir, pid: 1, pgid: 1, procStart: 'x', logPath: '', exitPath: '' }), collectResult: async () => sessionResult(0.05) };
    lab.deps.adapters = { claude: adapter as never };
    hooks.runInquisition.mockResolvedValue(settled([]));
    await inquisitionStep(lab.ctx());
    expect(charged()).toBeCloseTo(0.05, 6);
    chargeRecordedUsage(lab.ctx(), getWorker(lab.db, w.id));
    expect(charged()).toBeCloseTo(0.05, 6);
  });

  it('before PLANNING creates the budget nothing is charged here: PLANNING charges it', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING'] });
    engineRanInquisitor('wrk-inq-early', 0.04);
    chargeRecordedUsage(lab.ctx(), getWorker(lab.db, 'wrk-inq-early'));
    expect(lab.db.get('SELECT 1 AS x FROM budget_counters WHERE run_id = ?', lab.runId)).toBeUndefined();
    expect(lab.db.all("SELECT 1 FROM events WHERE run_id = ? AND type = 'budget.usage-charged'", lab.runId)).toEqual([]);
  });

  it('a precharge recorded before it named its usage records covers every record written by then', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING'] });
    engineRanInquisitor('wrk-inq-early', 0.04);
    initLedger(lab).consumeCost({ costUsd: 0.04, costSource: 'reported' }, 'inquisitor');
    appendEvent(lab.db, lab.runId, 'budget.precharged', OWNER, { usage_rows: 1, charged_usd: 0.04 }, lab.clock.now());
    chargeRecordedUsage(lab.ctx(), getWorker(lab.db, 'wrk-inq-early'));
    expect(charged()).toBeCloseTo(0.04, 6);
  });

  it('a worker without a usage record has nothing to charge', () => {
    setup();
    const w = planWorker(lab.db, { id: 'wrk-none', runId: lab.runId, role: 'inquisitor', purpose: 'inquire:none', provider: 'claude', model: null, workerDir: join(lab.base, 'w', 'none'), cwd: lab.repo }, lab.clock, OWNER);
    chargeRecordedUsage(lab.ctx(), w);
    expect(charged()).toBe(0);
  });
});
