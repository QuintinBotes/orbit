import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type Engine = typeof import('../../../src/inquisition/engine.ts');
type Trig = typeof import('../../../src/inquisition/triggers.ts');
const hooks = vi.hoisted(() => ({ runInquisition: vi.fn(), detectTriggers: vi.fn() }));
vi.mock('../../../src/inquisition/engine.ts', async (orig) => ({ ...(await orig<Engine>()), runInquisition: hooks.runInquisition }));
vi.mock('../../../src/inquisition/triggers.ts', async (orig) => ({ ...(await orig<Trig>()), detectTriggers: hooks.detectTriggers }));

const { inquisitionStep } = await import('../../../src/controller/steps/inquisition.ts');
const { getRun, requestCancel } = await import('../../../src/controller/run-store.ts');
const { briefPath } = await import('../../../src/controller/steps/implementing.ts');
const { planWorker, markWorkerRunning, getWorker } = await import('../../../src/storage/workers.ts');
const { addCandidate, addEvidence, makeUnitLab, setContract, validContract, OWNER } = await import('./coverage-helpers.ts');
type UnitLab = import('./coverage-helpers.ts').UnitLab;
type Trigger = import('../../../src/inquisition/types.ts').Trigger;

let lab: UnitLab;
beforeEach(() => {
  hooks.runInquisition.mockReset();
  hooks.detectTriggers.mockReset();
  hooks.detectTriggers.mockReturnValue([]);
});
afterEach(() => lab?.cleanup());

const trigger = (over: Partial<Trigger> = {}): Trigger => ({ kind: 'hidden_decision', mode: 'clarify', summary: 'a hidden decision', evidence: ['e1'], subjects: ['AC-1'], key: 'k:1', ...over });

function setup(opts: { candidate?: boolean; trigger?: Trigger | null; from?: 'IMPLEMENTING' | 'VERIFYING' } = {}) {
  lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'], adapters: { claude: { id: 'claude', collectResult: async () => null } as never } });
  setContract(lab);
  lab.db.run('UPDATE runs SET worktree_path = ? WHERE id = ?', lab.repo, lab.runId);
  lab.deps.registry.seed();
  for (const e of lab.deps.registry.list()) if (e.provider === 'claude') lab.deps.registry.markAvailability(e.modelId, 'claude-cli', true, 'test');
  const cand = opts.candidate ? addCandidate(lab) : null;
  if (opts.candidate) addEvidence(lab, cand!, { verdict: 'PASS', acceptance_evidence: [{ criterion_id: 'AC-1', status: 'supported', artifacts: [] }] });
  const t = opts.trigger === undefined ? trigger() : opts.trigger;
  lab.walk(opts.from === 'VERIFYING' ? ['VERIFYING'] : []);
  lab.walk(['INQUISITION']);
  if (t) {
    // The trigger travels with the transition into INQUISITION: rewrite that event's data as the entering step would have.
    lab.db.run("UPDATE events SET data_json = ? WHERE run_id = ? AND type = 'state.transition' AND to_state = 'INQUISITION'", JSON.stringify({ reason: 'test', data: { trigger: t } }), lab.runId);
  }
  return { cand, trigger: t };
}

const result = (over: Record<string, unknown> = {}) => ({ disposition: 'continue', reason: 'settled', questions: [], blockedCriteria: [], rejectGreen: false, experiments: [], contract: validContract(lab), ...over });
const state = () => getRun(lab.db, lab.runId).state;

describe('inquisitionStep', () => {
  it('stops at a safe point', async () => {
    setup();
    requestCancel(lab.db, lab.runId, 'u', lab.clock);
    expect(await inquisitionStep(lab.ctx())).toMatchObject({ done: true });
    expect(hooks.runInquisition).not.toHaveBeenCalled();
  });

  it('resumes the interrupted stage when there is nothing left to inquire into: planning before a candidate, verification with one', async () => {
    setup({ trigger: null });
    await inquisitionStep(lab.ctx());
    expect(state()).toBe('IMPLEMENTING');
    expect(getRun(lab.db, lab.runId).outcomeReason).toBeNull();
    lab.cleanup();
    setup({ trigger: null, candidate: true, from: 'VERIFYING' });
    hooks.detectTriggers.mockReturnValue([]);
    await inquisitionStep(lab.ctx());
    expect(state()).toBe('VERIFYING');
  });

  it('with no entering trigger, looks for one in the candidate\'s evidence', async () => {
    setup({ trigger: null, candidate: true, from: 'VERIFYING' });
    hooks.detectTriggers.mockReturnValue([trigger({ key: 'found:1' })]);
    hooks.runInquisition.mockResolvedValue(result());
    await inquisitionStep(lab.ctx());
    expect(hooks.runInquisition.mock.calls[0]![0].trigger.key).toBe('found:1');
  });

  it('without a recorded stage to return to, resumes planning before a candidate and verification after one', async () => {
    setup({ trigger: null });
    lab.db.run('UPDATE runs SET resume_state = NULL WHERE id = ?', lab.runId);
    await inquisitionStep(lab.ctx());
    expect(state()).toBe('PLANNING');
    lab.cleanup();
    setup({ trigger: null, candidate: true, from: 'VERIFYING' });
    lab.db.run('UPDATE runs SET resume_state = NULL WHERE id = ?', lab.runId);
    await inquisitionStep(lab.ctx());
    expect(state()).toBe('VERIFYING');
  });

  it('a transition into the inquisition that carries no data has no entering trigger', async () => {
    setup({ trigger: null });
    lab.db.run("UPDATE events SET data_json = NULL WHERE run_id = ? AND type = 'state.transition' AND to_state = 'INQUISITION'", lab.runId);
    await inquisitionStep(lab.ctx());
    expect(hooks.runInquisition).not.toHaveBeenCalled();
    expect(state()).toBe('IMPLEMENTING');
    lab.cleanup();
    setup({ trigger: null });
    lab.db.run("DELETE FROM events WHERE run_id = ? AND type = 'state.transition' AND to_state = 'INQUISITION'", lab.runId);
    await inquisitionStep(lab.ctx());
    expect(state()).toBe('IMPLEMENTING');
  });

  it('a candidate with no evidence report supports nothing, and the host environment defaults to the process\'s', async () => {
    setup({ candidate: true, from: 'VERIFYING' });
    lab.db.run('DELETE FROM evidence_reports WHERE run_id = ?', lab.runId);
    lab.deps.hostEnv = undefined;
    hooks.runInquisition.mockResolvedValue(result());
    await inquisitionStep(lab.ctx());
    expect(hooks.runInquisition.mock.calls[0]![0].context.supportedCriteria).toEqual([]);
  });

  it('rejecting green while the contract was amended persists the amended contract with the brief', async () => {
    setup({ candidate: true, from: 'VERIFYING' });
    const amended = { ...validContract(lab), non_goals: ['x'] };
    hooks.runInquisition.mockResolvedValue(result({ rejectGreen: true, contract: amended }));
    await inquisitionStep(lab.ctx());
    expect(state()).toBe('DIAGNOSING');
    expect(JSON.parse(getRun(lab.db, lab.runId).contractJson!).non_goals).toEqual(['x']);
  });

  it('a trigger already settled is not inquired into again', async () => {
    setup();
    lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 1, 'inquisition.completed', 'x', ?)", lab.runId, JSON.stringify({ key: 'k:1' }));
    await inquisitionStep(lab.ctx());
    expect(hooks.runInquisition).not.toHaveBeenCalled();
    expect(state()).toBe('IMPLEMENTING');
  });

  it('settled inquiry resumes the stage it interrupted, recording the disposition', async () => {
    setup();
    hooks.runInquisition.mockResolvedValue(result({ disposition: 'continue' }));
    expect(await inquisitionStep(lab.ctx())).toEqual({ progressed: true });
    expect(state()).toBe('IMPLEMENTING');
    const input = hooks.runInquisition.mock.calls[0]![0];
    expect(input.trigger.key).toBe('k:1');
    expect(input.context).toMatchObject({ runId: lab.runId, supportedCriteria: [] });
    expect(input.context.worker).toMatchObject({ cwd: lab.repo, pollMs: 250 });
    expect(typeof input.context.worker.fence).toBe('function');
    expect(input.context.worker.maxTurns).toBe(lab.ctx().snapshot.config.scheduler.hard_limits.worker_turns_per_session);
  });

  it('hands the engine what the candidate\'s evidence supports, and persists a contract the inquiry amended', async () => {
    const { cand } = setup({ candidate: true, from: 'VERIFYING' });
    const amended = { ...validContract(lab), non_goals: ['Do not change add'] };
    hooks.runInquisition.mockResolvedValue(result({ contract: amended }));
    await inquisitionStep(lab.ctx());
    expect(hooks.runInquisition.mock.calls[0]![0].context.supportedCriteria).toEqual(['AC-1']);
    expect(hooks.runInquisition.mock.calls[0]![0].context.inquiry).toBeDefined();
    expect(JSON.parse(getRun(lab.db, lab.runId).contractJson!).non_goals).toEqual(['Do not change add']);
    expect(JSON.parse(readFileSync(join(lab.ctx().runDir, 'contract.json'), 'utf8')).non_goals).toEqual(['Do not change add']);
    expect(state()).toBe('VERIFYING');
  });

  it.each(['ask', 'block'] as const)('a %s disposition blocks the run with the persisted questions', async (disposition) => {
    setup();
    hooks.runInquisition.mockResolvedValue(result({ disposition, reason: 'a person must decide', questions: Array.from({ length: 7 }, (_, i) => ({ id: `q-${i}`, question: `Question ${i}?` })), blockedCriteria: ['AC-1'] }));
    await inquisitionStep(lab.ctx());
    expect(state()).toBe('BLOCKED');
    const run = getRun(lab.db, lab.runId);
    expect(run.outcomeReason).toContain('a person must decide; open questions: Question 0? | Question 1? | Question 2? | Question 3? | Question 4?');
    expect(run.outcomeReason).not.toContain('Question 5?');
    expect(JSON.parse(run.outcomeJson!)).toMatchObject({ inquiry: 'k:1', blocked_criteria: ['AC-1'] });
  });

  it('a block with no questions says only why', async () => {
    setup();
    hooks.runInquisition.mockResolvedValue(result({ disposition: 'block', reason: 'nothing can proceed' }));
    await inquisitionStep(lab.ctx());
    expect(getRun(lab.db, lab.runId).outcomeReason).toBe('nothing can proceed');
  });

  it('rejects green checks as proof: the next attempt gets a brief to strengthen the tests', async () => {
    const { cand } = setup({ candidate: true, from: 'VERIFYING', trigger: trigger({ kind: 'green_without_proof', key: 'g:1', evidence: ['unit passed without asserting AC-1'] }) });
    hooks.runInquisition.mockResolvedValue(result({ rejectGreen: true, experiments: [{ description: 'Write a failing test for AC-1' }] }));
    await inquisitionStep(lab.ctx());
    expect(state()).toBe('DIAGNOSING');
    const brief = JSON.parse(readFileSync(briefPath(lab.ctx(), 1), 'utf8'));
    expect(brief).toMatchObject({ attempt: 1, source: 'diagnosis', fingerprint: 'proof:g:1' });
    expect(brief.brief.experiment).toBe('Write a failing test for AC-1');
    expect(brief.brief.post_fix_checks).toEqual(['unit']);
  });

  it('without a planned experiment the brief asks for a test of each affected criterion', async () => {
    setup({ candidate: true, from: 'VERIFYING' });
    hooks.runInquisition.mockResolvedValue(result({ rejectGreen: true, experiments: [] }));
    await inquisitionStep(lab.ctx());
    expect(JSON.parse(readFileSync(briefPath(lab.ctx(), 1), 'utf8')).brief.experiment).toMatch(/^Write a test for each affected criterion/);
  });

  it('a rejected green with no candidate is nothing to strengthen: the stage resumes', async () => {
    setup();
    hooks.runInquisition.mockResolvedValue(result({ rejectGreen: true }));
    await inquisitionStep(lab.ctx());
    expect(state()).toBe('IMPLEMENTING');
  });

  it('a cancellation that lands during the inquiry ends the step before any transition', async () => {
    setup();
    hooks.runInquisition.mockImplementation(async () => {
      requestCancel(lab.db, lab.runId, 'u', lab.clock);
      return result({ disposition: 'ask', questions: [] });
    });
    expect(await inquisitionStep(lab.ctx())).toMatchObject({ done: true });
    expect(state()).toBe('CANCELLED');
  });

  it('collects an inquisitor a crashed controller left behind, and waits while it still runs', async () => {
    setup();
    const w = planWorker(lab.db, { id: 'wrk-inq', runId: lab.runId, role: 'inquisitor', provider: 'claude', workerDir: join(lab.base, 'wi'), cwd: lab.repo }, lab.clock, OWNER);
    markWorkerRunning(lab.db, w.id, { pid: 2_000_000_000, pgid: 2_000_000_000, procStart: 'x' }, lab.clock, OWNER);
    // Its directory holds no pid record: collecting it records it lost, and the inquiry goes on.
    hooks.runInquisition.mockResolvedValue(result());
    await inquisitionStep(lab.ctx());
    expect(getWorker(lab.db, w.id).state).toBe('LOST');
    expect(hooks.runInquisition).toHaveBeenCalledTimes(1);
  });

  it('a still-running inquisitor holds the step', async () => {
    setup();
    const dir = join(lab.base, 'wi2');
    const w = planWorker(lab.db, { id: 'wrk-inq2', runId: lab.runId, role: 'inquisitor', provider: 'claude', workerDir: dir, cwd: lab.repo }, lab.clock, OWNER);
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pid.json'), JSON.stringify({ version: 1, shimPid: process.pid, shimStart: null, pgid: 2_000_000_000, childPid: null, childStart: null, sessionId: null, argvHash: 'h', startedAt: 1 }));
    markWorkerRunning(lab.db, w.id, { pid: process.pid, pgid: 2_000_000_000, procStart: null }, lab.clock, OWNER);
    const out = await inquisitionStep(lab.ctx());
    expect(out).toEqual({ progressed: false, waiting: 'inquisitor wrk-inq2 is still running' });
    expect(hooks.runInquisition).not.toHaveBeenCalled();
    expect(existsSync(dir)).toBe(true);
  });
});
