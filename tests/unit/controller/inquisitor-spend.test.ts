// Inquisitor spend is charged to cost_usd like every other worker's (0.3.0 retest audit): the Inquisition engine
// records an inquisitor's usage itself, so the controller never charged it, and every python run's cost_usd fell
// short of the measured spend by exactly its inquisitors (1.17 measured, 1.01 charged; 1.51 and 1.31; 0.27 and 0.22).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Engine = typeof import('../../../src/inquisition/engine.ts');
const hooks = vi.hoisted(() => ({ runInquisition: vi.fn() }));
vi.mock('../../../src/inquisition/engine.ts', async (orig) => ({ ...(await orig<Engine>()), runInquisition: hooks.runInquisition }));

const { inquisitionStep } = await import('../../../src/controller/steps/inquisition.ts');
const { chargeRecordedUsage } = await import('../../../src/controller/workers.ts');
const { getRun } = await import('../../../src/controller/run-store.ts');
const { outcomeForError } = await import('../../../src/controller/steps/common.ts');
const { OrbitError } = await import('../../../src/core/errors.ts');
const { finishWorker, getWorker, markWorkerRunning, planWorker } = await import('../../../src/storage/workers.ts');
const { recordUsage } = await import('../../../src/routing/usage.ts');
const { appendEvent } = await import('../../../src/storage/events.ts');
const { spendBreakdown } = await import('../../../src/scheduling/budget.ts');
const { reconcileOnStart } = await import('../../../src/recovery/reconcile.ts');
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

/** An inquisitor the engine ran that ended `status`, with its transcript (none when `log` is undefined) and usage. */
function engineRanFailedInquisitor(id: string, status: 'auth_failed' | 'failed' | 'transient_error', log?: object[], usage: { costUsd?: number; inputTokens?: number; outputTokens?: number } = {}): void {
  const workerDir = join(lab.base, 'w', id);
  planWorker(lab.db, { id, runId: lab.runId, role: 'inquisitor', purpose: `inquire:${id}`, provider: 'claude', model: null, workerDir, cwd: lab.repo }, lab.clock);
  markWorkerRunning(lab.db, id, { pid: 2_000_000_000, pgid: 2_000_000_000, procStart: 'x' }, lab.clock);
  if (log) {
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, 'log.jsonl'), log.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }
  const r: TaskResult = {
    status,
    structured: null,
    text: null,
    error: 'Invalid API key',
    exitCode: 1,
    usage: { provider: 'claude', model: null, inputTokens: usage.inputTokens ?? null, outputTokens: usage.outputTokens ?? null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: usage.costUsd ?? null, costSource: usage.costUsd === undefined ? 'unavailable' : 'reported' },
    durationMs: 100,
  };
  lab.db.tx(() => {
    finishWorker(lab.db, id, { state: 'FAILED', exitCode: 1, resultStatus: status, result: r, error: r.error }, lab.clock);
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

  // A precharge that names no usage record is 0.3.0's, in a run 0.3.0 started: that run keeps 0.3.0's accounting.
  it('in a run started before 0.3.1, what its precharge charged is left as 0.3.0 left it', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING'] });
    lab.db.run("UPDATE events SET data_json = json_remove(data_json, '$.accounting') WHERE run_id = ? AND type = 'run.created'", lab.runId);
    engineRanInquisitor('wrk-inq-early', 0.04);
    initLedger(lab).consumeCost({ costUsd: 0.04, costSource: 'reported' }, 'inquisitor');
    appendEvent(lab.db, lab.runId, 'budget.precharged', OWNER, { usage_rows: 1, charged_usd: 0.04 }, lab.clock.now());
    chargeRecordedUsage(lab.ctx(), getWorker(lab.db, 'wrk-inq-early'));
    expect(charged()).toBeCloseTo(0.04, 6);
    expect(lab.db.all("SELECT 1 FROM events WHERE run_id = ? AND type = 'budget.usage-charged'", lab.runId)).toEqual([]);
  });

  // The rules accountWorker applies to every other session apply to an inquisitor's too (verifier, fix/031-budget):
  // charging the role ceiling for a session that never reached a model brought e2e NB2 back for inquisitors.
  for (const status of ['auth_failed', 'failed', 'transient_error'] as const) {
    it(`an inquisitor that ended ${status} before reaching a model is charged a measured $0, as any other session is`, () => {
      setup();
      engineRanFailedInquisitor('wrk-inq-0', status);
      chargeRecordedUsage(lab.ctx(), getWorker(lab.db, 'wrk-inq-0'));
      expect(charged()).toBe(0);
      const zero = lab.db.all<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'budget.cost-zero-no-model'", lab.runId).map((e) => JSON.parse(e.data_json));
      expect(zero).toEqual([{ worker_id: 'wrk-inq-0', role: 'inquisitor', status, provider: 'claude' }]);
      // Recorded as the measured zero accountWorker records, so the spend line counts it as reported, never as uncharged.
      expect(lab.db.get('SELECT cost_usd, cost_source FROM usage WHERE worker_id = ?', 'wrk-inq-0')).toEqual({ cost_usd: 0, cost_source: 'reported' });
      expect(spendBreakdown(lab.db, lab.runId)).toMatchObject({ charged_usd: 0, reported_sessions: 1, unpriced_sessions: 0, ceiling_sessions: 0 });
      chargeRecordedUsage(lab.ctx(), getWorker(lab.db, 'wrk-inq-0'));
      expect(lab.db.all("SELECT 1 FROM events WHERE run_id = ? AND type = 'budget.cost-zero-no-model'", lab.runId)).toHaveLength(1);
    });
  }

  it('a failed inquisitor whose transcript shows model output is still charged as unmeasured', () => {
    setup();
    engineRanFailedInquisitor('wrk-inq-0', 'failed', [{ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'thinking' }] } }]);
    chargeRecordedUsage(lab.ctx(), getWorker(lab.db, 'wrk-inq-0'));
    expect(charged()).toBe(lab.ctx().ledger!.roleCostCeiling('inquisitor'));
  });

  it('an inquisitor whose credentials were rejected blocks on credentials even when its charge reaches the cap', async () => {
    setup();
    const cap = lab.ctx().ledger!.state('cost_usd').hard_cap;
    lab.db.run("UPDATE budget_counters SET used = ? WHERE run_id = ? AND counter = 'cost_usd'", cap - 0.5, lab.runId);
    hooks.runInquisition.mockImplementation(async () => {
      engineRanFailedInquisitor('wrk-inq-auth', 'auth_failed');
      throw new OrbitError('AUTH_EXPIRED', 'the provider rejected the credentials');
    });
    const err = await inquisitionStep(lab.ctx()).then(() => null, (e: unknown) => e);
    expect(err).toMatchObject({ code: 'AUTH_EXPIRED' });
    await outcomeForError(lab.ctx(), err);
    expect(getRun(lab.db, lab.runId).state).toBe('BLOCKED');
  });

  it('an auth-failed inquisitor whose measured spend crosses the cap is charged, and the run still blocks on credentials', () => {
    setup();
    const cap = lab.ctx().ledger!.state('cost_usd').hard_cap;
    lab.db.run("UPDATE budget_counters SET used = ? WHERE run_id = ? AND counter = 'cost_usd'", cap - 0.5, lab.runId);
    engineRanFailedInquisitor('wrk-inq-auth', 'auth_failed', [], { costUsd: 0.75, inputTokens: 10, outputTokens: 10 });
    expect(() => chargeRecordedUsage(lab.ctx(), getWorker(lab.db, 'wrk-inq-auth'))).not.toThrow();
    expect(charged()).toBeCloseTo(cap + 0.25, 6);
  });

  // Reviewers are admitted and charged in the closing phase, which may spend the reserve; an inquiry that returns to
  // REVIEWING belongs to that stage, so a small inquiry there no longer ends the run on the reserve a reviewer may use.
  it('an inquiry that resumes REVIEWING charges its inquisitor in the closing phase, as reviewers are charged', async () => {
    setup();
    const ledger = lab.ctx().ledger!;
    const cap = ledger.state('cost_usd').hard_cap;
    lab.db.run("UPDATE budget_counters SET used = ? WHERE run_id = ? AND counter = 'cost_usd'", cap - ledger.reserve().cost_usd - 0.1, lab.runId);
    lab.db.run("UPDATE runs SET resume_state = 'REVIEWING' WHERE id = ?", lab.runId);
    hooks.runInquisition.mockImplementation(async () => {
      engineRanInquisitor('wrk-inq-1', 0.2);
      return settled(['wrk-inq-1']);
    });
    await inquisitionStep(lab.ctx());
    expect(getRun(lab.db, lab.runId).state).toBe('REVIEWING');
    expect(charged()).toBeCloseTo(cap - ledger.reserve().cost_usd + 0.1, 6);
  });

  it('an inquiry that resumes work charges its inquisitor in the work phase, so the closing reserve stays held', async () => {
    setup();
    const ledger = lab.ctx().ledger!;
    const cap = ledger.state('cost_usd').hard_cap;
    lab.db.run("UPDATE budget_counters SET used = ? WHERE run_id = ? AND counter = 'cost_usd'", cap - ledger.reserve().cost_usd - 0.1, lab.runId);
    hooks.runInquisition.mockImplementation(async () => {
      engineRanInquisitor('wrk-inq-1', 0.2);
      return settled(['wrk-inq-1']);
    });
    await expect(inquisitionStep(lab.ctx())).rejects.toThrow(/less the closing reserve/);
  });

  describe('admission and the session spend cap', () => {
    type WorkerOptions = { admit?: (purpose: string) => number | null };
    const admitOf = (): ((purpose: string) => number | null) => {
      const opts = (hooks.runInquisition.mock.calls[0]![0] as { context: { worker: WorkerOptions } }).context.worker;
      expect(opts.admit).toBeTypeOf('function');
      return opts.admit!;
    };

    it('an inquisitor is admitted against the budget before it starts and runs under a spend cap, like any other session', async () => {
      setup();
      let cap: number | null = null;
      hooks.runInquisition.mockImplementation(async (input: { context: { worker: WorkerOptions } }) => {
        cap = input.context.worker.admit!('inquisition:risk-review:k:1');
        return settled([]);
      });
      await inquisitionStep(lab.ctx());
      expect(cap).toBeGreaterThan(0);
      const ev = lab.db.all<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'worker.spend-cap'", lab.runId).map((e) => JSON.parse(e.data_json));
      expect(ev).toEqual([expect.objectContaining({ purpose: 'inquisition:risk-review:k:1', cap_usd: cap })]);
    });

    it('with nothing left under the work limit no inquisitor starts, and the run ends EXHAUSTED saying why', async () => {
      setup();
      const ledger = lab.ctx().ledger!;
      const cap = ledger.state('cost_usd').hard_cap;
      lab.db.run("UPDATE budget_counters SET used = ? WHERE run_id = ? AND counter = 'cost_usd'", cap - ledger.reserve().cost_usd - 0.01, lab.runId);
      hooks.runInquisition.mockImplementation(async (input: { context: { worker: WorkerOptions } }) => {
        input.context.worker.admit!('inquisition:risk-review:k:1');
        return settled([]);
      });
      const err = await inquisitionStep(lab.ctx()).then(() => null, (e: unknown) => e);
      expect(err).toMatchObject({ code: 'BUDGET_EXHAUSTED', message: expect.stringMatching(/^inquisitor not started: /) });
      expect(lab.db.all("SELECT 1 FROM events WHERE run_id = ? AND type = 'worker.spend-cap'", lab.runId)).toEqual([]);
      await outcomeForError(lab.ctx(), err);
      expect(getRun(lab.db, lab.runId).state).toBe('EXHAUSTED');
    });

    it('a second attempt is admitted against what the first one spent', async () => {
      setup();
      const ledger = lab.ctx().ledger!;
      const limit = ledger.state('cost_usd').hard_cap - ledger.reserve().cost_usd;
      hooks.runInquisition.mockImplementation(async (input: { context: { worker: WorkerOptions } }) => {
        input.context.worker.admit!('inquisition:risk-review:k:1');
        // The first attempt returned malformed output after spending most of what was left; the engine tries again.
        engineRanInquisitor('wrk-inq-1', limit - 0.05);
        input.context.worker.admit!('inquisition:risk-review:k:1');
        return settled(['wrk-inq-1']);
      });
      const err = await inquisitionStep(lab.ctx()).then(() => null, (e: unknown) => e);
      expect(err).toMatchObject({ code: 'BUDGET_EXHAUSTED', message: expect.stringMatching(/^inquisitor not started: /) });
      expect(charged()).toBeCloseTo(limit - 0.05, 6);
    });

    it('an inquiry that resumes REVIEWING is admitted in the closing phase, where the reserve may be spent', async () => {
      setup();
      const ledger = lab.ctx().ledger!;
      const cap = ledger.state('cost_usd').hard_cap;
      lab.db.run("UPDATE budget_counters SET used = ? WHERE run_id = ? AND counter = 'cost_usd'", cap - ledger.reserve().cost_usd - 0.01, lab.runId);
      lab.db.run("UPDATE runs SET resume_state = 'REVIEWING' WHERE id = ?", lab.runId);
      hooks.runInquisition.mockResolvedValue(settled([]));
      await inquisitionStep(lab.ctx());
      expect(admitOf()('inquisition:reconcile:k:1')).toBeGreaterThan(0);
    });

    it('before PLANNING creates the budget there is nothing to admit against, and no cap is given', async () => {
      lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING'], adapters: { claude: { id: 'claude', collectResult: async () => null } as never } });
      setContract(lab);
      lab.db.run('UPDATE runs SET worktree_path = ? WHERE id = ?', lab.repo, lab.runId);
      lab.deps.registry.seed();
      lab.walk(['INQUISITION']);
      const trigger = { kind: 'hidden_decision', mode: 'risk-review', summary: 's', evidence: ['e'], subjects: [], key: 'k:1' };
      lab.db.run("UPDATE events SET data_json = ? WHERE id = (SELECT MAX(id) FROM events WHERE run_id = ? AND type = 'state.transition' AND to_state = 'INQUISITION')", JSON.stringify({ reason: 'test', data: { trigger } }), lab.runId);
      lab.db.run("UPDATE runs SET resume_state = 'CONTRACTING' WHERE id = ?", lab.runId);
      hooks.runInquisition.mockResolvedValue(settled([]));
      await inquisitionStep(lab.ctx());
      expect(admitOf()('inquisition:risk-review:k:1')).toBeNull();
    });
  });

  // Adversarial review of fix/031-budget: reconciliation collected an exited inquisitor and stored its result with no
  // usage record, the charge pass found no record to charge, and the engine reused the result: a $0.75 session ended
  // SUCCEEDED with no usage row and cost_usd 0.
  it('an inquisitor that reconciliation collected on restart is recorded and charged once, and its reused result is not charged again', async () => {
    setup();
    const workerDir = join(lab.base, 'w', 'wrk-inq-rec');
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, 'pid.json'), JSON.stringify({ version: 1, shimPid: 2_000_000_000, shimStart: 'x', pgid: 2_000_000_000, childPid: null, childStart: null, sessionId: null, argvHash: 'h', startedAt: 1 }));
    writeFileSync(join(workerDir, 'exit.json'), JSON.stringify({ version: 1, code: 0, signal: null, timedOut: false, cancelled: false, aborted: null, endedAt: 2, startedAt: 1 }));
    planWorker(lab.db, { id: 'wrk-inq-rec', runId: lab.runId, role: 'inquisitor', purpose: 'inquisition:risk-review:k:1', provider: 'claude', model: null, workerDir, cwd: lab.repo }, lab.clock, OWNER);
    markWorkerRunning(lab.db, 'wrk-inq-rec', { pid: 2_000_000_000, pgid: 2_000_000_000, procStart: 'x' }, lab.clock, OWNER);
    lab.deps.adapters = { claude: { id: 'claude', collectResult: async () => sessionResult(0.75) } as never };
    const rep = await reconcileOnStart({ db: lab.db, ownerId: OWNER, clock: lab.clock, adapters: lab.deps.adapters, graceMs: 50, runIds: [lab.runId] });
    expect(rep.runs[0]!.workers).toEqual([expect.objectContaining({ workerId: 'wrk-inq-rec', observation: 'finished', state: 'SUCCEEDED' })]);
    // The engine finds the stored result and reuses it: no second session, no usage of its own.
    hooks.runInquisition.mockResolvedValue(settled(['wrk-inq-rec']));
    await inquisitionStep(lab.ctx());
    expect(getRun(lab.db, lab.runId).state).toBe('IMPLEMENTING');
    expect(lab.db.all('SELECT cost_usd FROM usage WHERE worker_id = ?', 'wrk-inq-rec')).toEqual([{ cost_usd: 0.75 }]);
    expect(charged()).toBeCloseTo(0.75, 6);
    expect(spendBreakdown(lab.db, lab.runId)).toMatchObject({ charged_usd: 0.75, reported_usd: 0.75, reported_sessions: 1, uncharged_usd: 0, unmatched_usd: 0 });
    // A later inquiry's charge pass, and a direct one, find it charged.
    enterInquisition('k:2');
    await inquisitionStep(lab.ctx());
    chargeRecordedUsage(lab.ctx(), getWorker(lab.db, 'wrk-inq-rec'));
    expect(charged()).toBeCloseTo(0.75, 6);
    expect(lab.db.all('SELECT 1 FROM usage WHERE worker_id = ?', 'wrk-inq-rec')).toHaveLength(1);
  });

  it('a worker without a usage record has nothing to charge', () => {
    setup();
    const w = planWorker(lab.db, { id: 'wrk-none', runId: lab.runId, role: 'inquisitor', purpose: 'inquire:none', provider: 'claude', model: null, workerDir: join(lab.base, 'w', 'none'), cwd: lab.repo }, lab.clock, OWNER);
    chargeRecordedUsage(lab.ctx(), w);
    expect(charged()).toBe(0);
  });
});
