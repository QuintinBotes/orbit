import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderAdapter, TaskHandle, TaskResult, TaskSpec } from '../../../src/adapters/types.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { getRun, requestCancel } from '../../../src/controller/run-store.ts';
import { PLANNER_FILE, contractingStep, storedPlan } from '../../../src/controller/steps/contracting.ts';
import { PLANNER_OUTPUT } from '../../integration/controller/harness.ts';
import { makeUnitLab, setContract, type UnitLab } from './coverage-helpers.ts';
import { OrbitError } from '../../../src/core/errors.ts';

type Draft = typeof import('../../../src/contract/draft.ts');
const draftHook = vi.hoisted(() => ({ fail: null as null | (() => never) }));
vi.mock('../../../src/contract/draft.ts', async (orig) => {
  const actual = await orig<Draft>();
  return { ...actual, draftContract: (...a: Parameters<Draft['draftContract']>) => (draftHook.fail ? draftHook.fail() : actual.draftContract(...a)) };
});
beforeEach(() => {
  draftHook.fail = null;
});

let lab: UnitLab;
afterEach(() => lab?.cleanup());

const usage = { provider: 'claude', model: null, inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheWriteTokens: null, costUsd: 0.1, costSource: 'reported' as const };

const prompts: string[] = [];

function planner(structured: unknown, status: TaskResult['status'] = 'succeeded'): ProviderAdapter {
  const calls = new Map<string, number>();
  const a = {
    id: 'claude',
    async startTask(spec: TaskSpec): Promise<TaskHandle> {
      prompts.push(spec.prompt);
      mkdirSync(spec.workerDir, { recursive: true });
      writeFileSync(join(spec.workerDir, 'pid.json'), JSON.stringify({ version: 1, shimPid: 2_000_000_000, shimStart: 'x', pgid: 2_000_000_000, childPid: null, childStart: null, sessionId: null, argvHash: 'h', startedAt: 1 }));
      return { provider: 'claude', workerId: spec.workerId, workerDir: spec.workerDir, pid: 2_000_000_000, pgid: 2_000_000_000, procStart: 'x', logPath: '', exitPath: '' };
    },
    async collectResult(h: TaskHandle): Promise<TaskResult | null> {
      const n = (calls.get(h.workerId) ?? 0) + 1;
      calls.set(h.workerId, n);
      return { status, structured, text: null, error: status === 'succeeded' ? null : 'planner failed', exitCode: 0, usage, durationMs: 1 };
    },
    async cancelTask(): Promise<void> {},
  };
  return a as unknown as ProviderAdapter;
}

function prepare(structured: unknown, tweak?: Parameters<typeof makeUnitLab>[0] extends infer O ? (O extends { tweak?: infer T } ? T : never) : never, status: TaskResult['status'] = 'succeeded') {
  lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING'], adapters: { claude: planner(structured, status) }, tweak });
  lab.db.run('UPDATE runs SET base_revision = ?, worktree_path = ? WHERE id = ?', 'a'.repeat(40), lab.repo, lab.runId);
  lab.deps.registry.seed();
  for (const e of lab.deps.registry.list()) if (e.provider === 'claude') lab.deps.registry.markAvailability(e.modelId, 'claude-cli', true, 'test');
}

/** The first call starts the planner; the next collects it. */
async function runToEnd() {
  let out = await contractingStep(lab.ctx());
  for (let i = 0; i < 6 && out.waiting?.includes('is running'); i++) out = await contractingStep(lab.ctx());
  return out;
}

const state = () => getRun(lab.db, lab.runId).state;
const decisions = (kind: string) => listDecisions(lab.db, lab.runId, { kind });

describe('contractingStep', () => {
  it('stops at a safe point', async () => {
    prepare(PLANNER_OUTPUT);
    requestCancel(lab.db, lab.runId, 'u', lab.clock);
    expect(await contractingStep(lab.ctx())).toMatchObject({ done: true });
  });

  it('drafts the contract from the planner\'s output, stores the plan and the contract, passes the intake gate and moves to planning', async () => {
    prepare(PLANNER_OUTPUT);
    const first = await contractingStep(lab.ctx());
    expect(first.waiting).toMatch(/the planner \(wrk-.+\) is running/);
    const out = await runToEnd();
    expect(out).toEqual({ progressed: true });
    expect(state()).toBe('PLANNING');
    const run = getRun(lab.db, lab.runId);
    expect(JSON.parse(run.contractJson!)).toMatchObject({ objective: PLANNER_OUTPUT.objective, task_id: lab.runId });
    expect(run.contractHash).toMatch(/^sha256:/);
    expect(existsSync(join(lab.ctx().runDir, 'contract.json'))).toBe(true);
    expect(storedPlan(lab.ctx())?.objective).toBe(PLANNER_OUTPUT.objective);
    expect(decisions('gate.intake')).toHaveLength(1);
  });

  it('records what the controller changed in the planner\'s proposal, and settles reversible questions with the recommendation', async () => {
    prepare({
      ...PLANNER_OUTPUT,
      required_check_ids: ['unit', 'not-a-check'],
      unresolved_decisions: [
        { question: 'Which rounding?', options: ['half-even', 'half-up'], recommendation: 'half-even', material: false, affected_criteria: [] },
        { question: 'Which naming?', options: ['mul', 'multiply'], recommendation: null, material: false, affected_criteria: [] },
        { question: 'Which style?', options: ['plain', 'fancy'], recommendation: null, material: false, affected_criteria: [] },
      ],
    });
    await runToEnd();
    expect(state()).toBe('PLANNING');
    expect(decisions('contract.check-dropped').length).toBeGreaterThan(0);
    const choices = decisions('inquisition.resolve').map((d) => d.summary).sort();
    expect(choices).toEqual(['reversible choice: Which naming? -> mul', 'reversible choice: Which rounding? -> half-even', 'reversible choice: Which style? -> plain']);
    expect(decisions('inquisition.resolve').find((d) => d.summary.includes('style'))?.data).toMatchObject({ choice: 'plain', basis: 'planner recommendation; reversible' });
  });

  it('a material question the planner could not settle sends the run to the inquisition with the contract already stored', async () => {
    prepare({
      ...PLANNER_OUTPUT,
      unresolved_decisions: [{ question: 'Does mul round?', options: ['yes', 'no'], recommendation: null, material: true, affected_criteria: ['mul', 'AC-9', 'unknown-key'] }],
    });
    await runToEnd();
    expect(state()).toBe('INQUISITION');
    const run = getRun(lab.db, lab.runId);
    expect(run.contractJson).toBeTruthy();
    const ev = lab.db.get<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'state.transition' AND to_state = 'INQUISITION'", lab.runId);
    const trigger = JSON.parse(ev!.data_json).data.trigger;
    expect(trigger).toMatchObject({ kind: 'hidden_decision', mode: 'clarify', subjects: ['AC-1', 'AC-9'] });
    expect(trigger.summary).toBe('the planner left 1 material decision(s) unresolved');
    expect(trigger.key).toMatch(/^contracting:/);
  });

  it('an assumption that needs a decision sends the run to the inquisition too, with the open assumptions as evidence', async () => {
    prepare({ ...PLANNER_OUTPUT, assumptions: [{ statement: 'Amounts are integers', basis: 'the existing tests', status: 'needs-decision' }] });
    await runToEnd();
    expect(state()).toBe('INQUISITION');
    const ev = lab.db.get<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'state.transition' AND to_state = 'INQUISITION'", lab.runId);
    expect(JSON.parse(ev!.data_json).data.trigger.evidence[0]).toContain('Amounts are integers');
  });

  it('a contract the intake gate cannot accept blocks the run with the problems', async () => {
    prepare({ ...PLANNER_OUTPUT, required_check_ids: [], criteria: [{ ...PLANNER_OUTPUT.criteria[0]!, check_ids: [] }] });
    await runToEnd();
    expect(state()).toBe('BLOCKED');
    expect(getRun(lab.db, lab.runId).outcomeReason).toMatch(/^intake gate rejected/);
  });

  it('a planner that never produces valid output is retried and then blocks the run', async () => {
    prepare({ not: 'a plan' });
    const out = await runToEnd();
    expect(out).toMatchObject({ done: true });
    expect(state()).toBe('BLOCKED');
    expect(getRun(lab.db, lab.runId).outcomeReason).toContain('the planner: no usable result after 2 attempt(s)');
  });

  it('with a contract already settled (back from inquiry or a block) only the intake gate remains', async () => {
    prepare(PLANNER_OUTPUT);
    setContract(lab);
    expect(await contractingStep(lab.ctx())).toEqual({ progressed: true });
    expect(state()).toBe('PLANNING');
    expect(lab.db.all('SELECT 1 FROM workers WHERE run_id = ?', lab.runId)).toHaveLength(0);
  });

  it('a settled contract the intake gate now refuses blocks the run', async () => {
    prepare(PLANNER_OUTPUT);
    setContract(lab);
    lab.db.run("UPDATE runs SET repo_root = '/somewhere/else' WHERE id = ?", lab.runId);
    await contractingStep(lab.ctx());
    expect(state()).toBe('BLOCKED');
    expect(getRun(lab.db, lab.runId).outcomeReason).toContain('intake gate rejected the contract');
  });

  it('a plan drafted before preflight recorded the base revision is rejected by the contract check', async () => {
    prepare(PLANNER_OUTPUT);
    lab.db.run('UPDATE runs SET base_revision = NULL WHERE id = ?', lab.runId);
    await runToEnd();
    expect(state()).toBe('BLOCKED');
    expect(getRun(lab.db, lab.runId).outcomeReason).toMatch(/^intake gate rejected the planner's contract: /);
    expect(JSON.parse(getRun(lab.db, lab.runId).outcomeJson!).problems).toBeDefined();
  });

  it('tells the planner which trusted checks the policy defines and which are mandatory', async () => {
    prepare(PLANNER_OUTPUT, (c) => void (c.checks = { unit: { ...c.checks.unit!, mandatory: true }, lint: { ...c.checks.unit!, id: 'lint', mandatory: false } }));
    await contractingStep(lab.ctx());
    expect(prompts.at(-1)).toContain('unit (mandatory), lint');
  });

  // Review: P18 for a missing target rests on the contract naming the check, and the planner was never told which
  // checks name something the base revision does not have, so a contract could name one the goal does not create.
  it('tells the planner which checks name something the base revision does not have, and when to name them', async () => {
    prepare(PLANNER_OUTPUT, (c) => void (c.checks = { unit: { ...c.checks.unit!, mandatory: true }, lint: { ...c.checks.unit!, id: 'lint', mandatory: true } }));
    const ctx = lab.ctx();
    writeFileSync(
      join(ctx.runDir, 'baseline.json'),
      JSON.stringify({ schema: 'orbit.baseline/1', runId: lab.runId, baseRevision: ctx.run.baseRevision, failures: [{ checkId: 'lint', fingerprint: null, excerpt: 'npm error Missing script: "lint"', classification: 'missing-target' }, { checkId: 'unit', fingerprint: 'fp:1', excerpt: 'not ok 1' }], checks: [] }),
    );
    await contractingStep(lab.ctx());
    expect(prompts.at(-1)).toContain('On the base revision the command of check lint names something that does not exist yet (a missing target): name it as the proof of a criterion only when the goal is to create what it names, and the run then expects it to pass; otherwise leave it out, and the run stops on it as a misconfigured check.');
    expect(prompts.at(-1)).not.toMatch(/check unit names something/);
  });

  // Issue #32: the planner cited an optional dotnet format check in an optional criterion, which made the run require it.
  it('tells the planner what naming a check the policy does not mark mandatory costs, and only when there is one', async () => {
    const line = 'A check not marked mandatory runs only when the contract names it, and then like a mandatory one: on the base revision before any change, and the run stops if it cannot run there. Name one only as the proof of a criterion that needs it.';
    prepare(PLANNER_OUTPUT, (c) => void (c.checks = { unit: { ...c.checks.unit!, mandatory: true }, format: { ...c.checks.unit!, id: 'format', mandatory: false } }));
    await contractingStep(lab.ctx());
    expect(prompts.at(-1)).toContain('Trusted checks the policy defines: unit (mandatory), format. Name only these as check ids.');
    expect(prompts.at(-1)).toContain(line);
    lab.cleanup();
    prepare(PLANNER_OUTPUT, (c) => void (c.checks = { unit: { ...c.checks.unit!, mandatory: true } }));
    await contractingStep(lab.ctx());
    expect(prompts.at(-1)).not.toContain(line);
  });

  it('tells the planner there are no trusted checks when the policy defines none', async () => {
    prepare(PLANNER_OUTPUT, (c) => void (c.checks = {}));
    await contractingStep(lab.ctx());
    expect(prompts.at(-1)).toContain('Trusted checks the policy defines: none.');
  });

  it('a draft refused for another reason than an invalid contract surfaces, and one with no details blocks with none recorded', async () => {
    prepare(PLANNER_OUTPUT);
    draftHook.fail = () => {
      throw new OrbitError('INTERNAL', 'draft exploded');
    };
    await expect(runToEnd()).rejects.toMatchObject({ code: 'INTERNAL' });
    draftHook.fail = () => {
      throw new Error('plain failure');
    };
    await expect(runToEnd()).rejects.toThrow('plain failure');
    draftHook.fail = () => {
      throw new OrbitError('CONTRACT_INVALID', 'contract is invalid');
    };
    await runToEnd();
    expect(state()).toBe('BLOCKED');
    expect(JSON.parse(getRun(lab.db, lab.runId).outcomeJson!).problems).toBeNull();
  });

  it('needs the worktree preflight made', async () => {
    prepare(PLANNER_OUTPUT);
    lab.db.run('UPDATE runs SET worktree_path = NULL WHERE id = ?', lab.runId);
    await expect(contractingStep(lab.ctx())).rejects.toMatchObject({ code: 'INTERNAL', message: expect.stringContaining('has no worktree') });
  });
});

describe('storedPlan', () => {
  it('is the planner output that CONTRACTING stored, and null when there is none or it cannot be read', () => {
    prepare(PLANNER_OUTPUT);
    const ctx = lab.ctx();
    expect(storedPlan(ctx)).toBeNull();
    mkdirSync(ctx.runDir, { recursive: true });
    writeFileSync(join(ctx.runDir, PLANNER_FILE), '{broken');
    expect(storedPlan(ctx)).toBeNull();
    writeFileSync(join(ctx.runDir, PLANNER_FILE), JSON.stringify({ worker_id: 'w' }));
    expect(storedPlan(ctx)).toBeNull();
    writeFileSync(join(ctx.runDir, PLANNER_FILE), JSON.stringify({ worker_id: 'w', output: { not: 'a plan' } }));
    expect(storedPlan(ctx)).toBeNull();
    writeFileSync(join(ctx.runDir, PLANNER_FILE), JSON.stringify({ worker_id: 'w', output: PLANNER_OUTPUT }));
    expect(storedPlan(ctx)?.criteria).toHaveLength(1);
    expect(readFileSync(join(ctx.runDir, PLANNER_FILE), 'utf8')).toContain('worker_id');
  });
});
