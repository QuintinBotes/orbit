import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderAdapter, TaskHandle, TaskResult, TaskSpec } from '../../../src/adapters/types.ts';
import { OrbitError } from '../../../src/core/errors.ts';
import { insertQuestion } from '../../../src/inquisition/store.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { recordUsage } from '../../../src/routing/usage.ts';
import { planWorker } from '../../../src/storage/workers.ts';
import { getRun, requestCancel } from '../../../src/controller/run-store.ts';
import { START_CHARGE_EVENT, chargeOnce, latestAttempt, obtain, type ObtainOptions } from '../../../src/controller/steps/obtain.ts';
import { planningStep } from '../../../src/controller/steps/planning.ts';
import { spendRecoveryAttempt } from '../../../src/recovery/budget.ts';
import { PLANNER_FILE } from '../../../src/controller/steps/contracting.ts';
import { PLANNER_OUTPUT, plannerPractices } from '../../integration/controller/harness.ts';
import { ENGINEERING_PRACTICES } from '../../../src/contract/practices.ts';
import { makeUnitLab, OWNER, setContract, validContract, type UnitLab } from './coverage-helpers.ts';

let lab: UnitLab;
afterEach(() => lab?.cleanup());

const usage = { provider: 'claude', model: null, inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheWriteTokens: null, costUsd: 0.2, costSource: 'reported' as const };
const result = (over: Partial<TaskResult> = {}): TaskResult => ({ status: 'succeeded', structured: { value: 1 }, text: null, error: null, exitCode: 0, usage, durationMs: 1, ...over });

/** Answers each worker by its purpose and how many times it was asked: a list of results, null for "still running". */
function adapter(script: Record<string, (TaskResult | null)[]>): ProviderAdapter {
  const asked = new Map<string, number>();
  const a = {
    id: 'claude',
    async startTask(spec: TaskSpec): Promise<TaskHandle> {
      mkdirSync(spec.workerDir, { recursive: true });
      writeFileSync(join(spec.workerDir, 'pid.json'), JSON.stringify({ version: 1, shimPid: 2_000_000_000, shimStart: 'x', pgid: 2_000_000_000, childPid: null, childStart: null, sessionId: null, argvHash: 'h', startedAt: 1 }));
      return { provider: 'claude', workerId: spec.workerId, workerDir: spec.workerDir, pid: 2_000_000_000, pgid: 2_000_000_000, procStart: 'x', logPath: '', exitPath: '' };
    },
    async collectResult(h: TaskHandle): Promise<TaskResult | null> {
      const purpose = lab.db.get<{ purpose: string }>('SELECT purpose FROM workers WHERE id = ?', h.workerId)?.purpose ?? '';
      const n = asked.get(purpose) ?? 0;
      asked.set(purpose, n + 1);
      const list = script[purpose] ?? script['*'] ?? [result()];
      return list[Math.min(n, list.length - 1)] ?? null;
    },
    async cancelTask(): Promise<void> {},
  };
  return a as unknown as ProviderAdapter;
}

function opts(over: Partial<ObtainOptions<number>> = {}): ObtainOptions<number> {
  return {
    base: 'plan',
    maxAttempts: 3,
    what: 'planning',
    request: (purpose, attempt) => ({ role: 'planner', purpose, attempt, provider: 'claude', model: null, effort: null, cwd: lab.repo, readOnly: true, prompt: () => 'plan it' }),
    accept: (r) => (r.structured as { value: number }).value,
    ...over,
  };
}

describe('latestAttempt', () => {
  it('is the highest numbered attempt of a base, ignoring other bases, unnumbered purposes and workers without one', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const ctx = lab.ctx();
    expect(latestAttempt(ctx, 'plan')).toBe(0);
    const plan = (id: string, purpose: string | undefined) => planWorker(lab.db, { id, runId: lab.runId, role: 'planner', ...(purpose ? { purpose } : {}), provider: 'claude', workerDir: join(lab.base, id), cwd: lab.repo }, lab.clock, OWNER);
    plan('w1', 'plan#1');
    plan('w2', 'plan#3');
    plan('w3', 'plan#x');
    plan('w4', 'plan#2.5');
    plan('w5', 'other#9');
    plan('w6', undefined);
    expect(latestAttempt(ctx, 'plan')).toBe(3);
    expect(latestAttempt(ctx, 'other')).toBe(9);
  });
});

/** Call obtain until the worker it started has finished: the first call only starts it. */
async function settle(o: ObtainOptions<number>, max = 12) {
  let out = await obtain(lab.ctx(), o);
  for (let i = 0; i < max && !out.ok && /is running$/.test(out.step.waiting ?? ''); i++) out = await obtain(lab.ctx(), o);
  return out;
}

describe('obtain', () => {
  it('starts the worker, waits while it runs, and returns the accepted value with its worker and attempt', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'], adapters: { claude: adapter({ 'plan#1': [null, result()] }) } });
    const first = await obtain(lab.ctx(), opts());
    expect(first).toMatchObject({ ok: false, step: { progressed: false, waiting: expect.stringMatching(/^planning \(wrk-.+\) is running$/) } });
    const second = await obtain(lab.ctx(), opts());
    expect(second).toMatchObject({ ok: false });
    const third = await obtain(lab.ctx(), opts());
    expect(third).toMatchObject({ ok: true, value: 1, attempt: 1 });
  });

  it('asks again with a new numbered purpose when the output is malformed, and gives up after the attempt limit with the caller\'s outcome', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'], adapters: { claude: adapter({ '*': [result({ structured: { value: 'bad' } })] }) } });
    let accepted = 0;
    const accept: ObtainOptions<number>['accept'] = () => {
      accepted++;
      throw new OrbitError(accepted % 2 === 0 ? 'SCHEMA_INVALID' : 'MALFORMED_OUTPUT', 'output does not match its schema');
    };
    const out = await settle(opts({ accept, maxAttempts: 2, exhausted: async () => ({ progressed: false, waiting: 'custom exhausted' }) }));
    expect(out).toEqual({ ok: false, step: { progressed: false, waiting: 'custom exhausted' } });
    expect(accepted).toBe(2);
    expect(latestAttempt(lab.ctx(), 'plan')).toBe(2);
    expect(lab.db.all('SELECT 1 FROM events WHERE run_id = ? AND type = ?', lab.runId, 'worker.regenerate')).toHaveLength(1);
  });

  it('any other error from accepting the result is a defect and surfaces', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'], adapters: { claude: adapter({}) } });
    const o = opts({ accept: () => { throw new TypeError('bug'); } });
    await obtain(lab.ctx(), o);
    await expect(obtain(lab.ctx(), o)).rejects.toThrow('bug');
  });

  it('a failed worker is retried within the limit and blocks the run after it', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'], adapters: { claude: adapter({ '*': [result({ status: 'failed', error: 'crashed' })] }) } });
    const out = await settle(opts({ maxAttempts: 2 }));
    expect(out).toMatchObject({ ok: false, step: { done: true } });
    expect(getRun(lab.db, lab.runId).state).toBe('BLOCKED');
    expect(getRun(lab.db, lab.runId).outcomeReason).toContain('planning: no usable result after 2 attempt(s)');
  });

  it('an authentication failure blocks at once, without a retry', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'], adapters: { claude: adapter({ '*': [result({ status: 'auth_failed', error: 'expired' })] }) } });
    const out = await settle(opts());
    expect(out).toMatchObject({ ok: false, step: { done: true } });
    expect(latestAttempt(lab.ctx(), 'plan')).toBe(1);
  });

  it('a transient failure backs off before the next worker starts', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'], deps: { random: () => 0.9 }, adapters: { claude: adapter({ 'plan#1': [result({ status: 'transient_error', error: 'retry after 5s' })], 'plan#2': [result()] }) } });
    const first = await settle(opts());
    expect(first).toMatchObject({ ok: false, step: { waiting: expect.stringContaining('backing off 5000 ms') } });
    lab.clock.advance(5_001);
    const second = await settle(opts());
    expect(second).toMatchObject({ ok: true, attempt: 2 });
  });

  it('charges the start of a fresh worker once, before its row exists, and a refused charge leaves nothing behind', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'], adapters: { claude: adapter({ 'plan#1': [null] }) } });
    let charged = 0;
    await obtain(lab.ctx(), opts({ beforeStart: () => void charged++ }));
    await obtain(lab.ctx(), opts({ beforeStart: () => void charged++ }));
    expect(charged).toBe(1);
    lab.cleanup();

    lab = makeUnitLab({ path: ['PREFLIGHT'], adapters: { claude: adapter({}) } });
    await expect(
      obtain(
        lab.ctx(),
        opts({
          beforeStart: () => {
            throw new OrbitError('BUDGET_EXHAUSTED', 'no implementation attempts left');
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' });
    expect(latestAttempt(lab.ctx(), 'plan')).toBe(0);
  });
});

describe('chargeOnce', () => {
  it('records the charge with its marker, skips a purpose already charged, rethrows a refusal and any other failure', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const ctx = lab.ctx();
    let n = 0;
    chargeOnce(ctx, 'p#1', () => void n++);
    chargeOnce(ctx, 'p#1', () => void n++);
    chargeOnce(ctx, 'p#2', () => void n++);
    expect(n).toBe(2);
    expect(lab.db.all('SELECT 1 FROM events WHERE run_id = ? AND type = ?', lab.runId, START_CHARGE_EVENT)).toHaveLength(2);
    expect(() =>
      chargeOnce(ctx, 'p#3', () => {
        throw new OrbitError('BUDGET_EXHAUSTED', 'spent');
      }),
    ).toThrow('spent');
    expect(() =>
      chargeOnce(ctx, 'p#4', () => {
        throw new Error('db down');
      }),
    ).toThrow('db down');
    expect(lab.db.all('SELECT 1 FROM events WHERE run_id = ? AND type = ?', lab.runId, START_CHARGE_EVENT)).toHaveLength(2);
  });
});

describe('planningStep', () => {
  function writePlan(paths: string[], over: Record<string, unknown> = {}): void {
    const out = {
      ...PLANNER_OUTPUT,
      criteria: [{ ...PLANNER_OUTPUT.criteria[0]!, changes: paths.map((p) => ({ path: p, summary: 'x' })) }],
      expected_changed_files: paths.map((p) => ({ path: p, change: 'modify', reason: 'r' })),
      ...over,
    };
    writeFileSync(join(lab.ctx().runDir, PLANNER_FILE), JSON.stringify({ worker_id: 'w', output: out }));
  }
  function prepare(contractOver = {}, tweak?: Parameters<typeof makeUnitLab>[0] extends infer O ? (O extends { tweak?: infer T } ? T : never) : never) {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING'], tweak });
    lab.deps.registry.seed();
    for (const e of lab.deps.registry.list()) if (e.provider === 'claude') lab.deps.registry.markAvailability(e.modelId, 'claude-cli', true, 'test');
    mkdirSync(lab.ctx().runDir, { recursive: true });
    setContract(lab, contractOver);
  }
  const decisions = (kind: string) => listDecisions(lab.db, lab.runId, { kind });

  it('records the proof map, practices and difficulty, creates the budget, routes the first attempt and moves to implementing', async () => {
    prepare({ practices: plannerPractices(['behavior-tests']) });
    writePlan(['apps/calc.mjs', 'tests/mul.test.mjs']);
    const out = await planningStep(lab.ctx());
    expect(out).toEqual({ progressed: true });
    const run = getRun(lab.db, lab.runId);
    expect(run.state).toBe('IMPLEMENTING');
    expect(run.difficulty).toBeTruthy();
    expect(decisions('planning.proof-map')[0]?.summary).toBe('criterion-to-proof mapping for 1 criteria');
    const omitted = ENGINEERING_PRACTICES.filter((p) => p !== 'behavior-tests');
    expect(decisions('planning.practices')[0]?.summary).toBe(`engineering practices: 1 selected, ${omitted.length} omitted with a reason (${omitted.join(', ')})`);
    expect(decisions('planning.difficulty')[0]?.summary).toMatch(/^difficulty \w+ \(score \d+\/\d+\)/);
    expect(lab.db.get('SELECT 1 AS x FROM budget_counters WHERE run_id = ? LIMIT 1', lab.runId)).toBeTruthy();
    expect(decisions('route')[0]?.id).toBe(`dec-route-${lab.runId}-implement_1`);
  });

  it('says "all selected" without an omission list, and plans without a stored plan or practices', async () => {
    prepare({ practices: plannerPractices(ENGINEERING_PRACTICES) });
    await planningStep(lab.ctx());
    expect(decisions('planning.practices')[0]?.summary).toBe(`engineering practices: ${ENGINEERING_PRACTICES.length} selected`);
    expect(decisions('planning.proof-map')).toEqual([]);
    lab.cleanup();
    prepare();
    setContract(lab, { practices: undefined });
    await planningStep(lab.ctx());
    expect(decisions('planning.practices')).toEqual([]);
  });

  it.each([
    [['apps/a.mjs'], 'low'],
    [['apps/a.mjs', 'tests/b.mjs'], 'medium'],
    [['apps/a.mjs', 'tests/b.mjs', 'docs/c.md'], 'high'],
  ])('reads the coupling of %j as %s', async (files, coupling) => {
    prepare();
    writePlan(files);
    await planningStep(lab.ctx());
    const d = decisions('planning.difficulty')[0]!;
    expect((d.data as { factors: { factor: string; value: string }[] }).factors.find((f) => f.factor === 'coupling')?.value).toBe(coupling);
  });

  it('weighs security-sensitive wording, open questions, UI criteria and missing tests', async () => {
    prepare({ objective: 'Harden authentication against token theft', required_check_ids: ['unit'] });
    writePlan(['apps/a.mjs'], { risks: [{ risk: 'credential leak', impact: 'high', mitigation: 'm' }] });
    insertQuestion(lab.db, { id: 'q-1', runId: lab.runId, mode: 'clarify', question: 'Which?', evidence: [], options: [], changes: [], recommendation: { option: 'a', reason: 'r' }, safeDefault: { exists: false, option: null, reason: 'none' }, material: false, affected: [], unblocked: [] }, lab.clock);
    await planningStep(lab.ctx());
    const factors = (decisions('planning.difficulty')[0]!.data as { factors: { factor: string; value: unknown }[] }).factors;
    expect(factors.find((f) => f.factor === 'security_impact')?.value).toBe(true);
    expect(JSON.stringify(factors)).toContain('open');
  });

  it('maps the proof of a criterion the plan has no entry for to no changes, and a contract criterion without check ids to none', async () => {
    prepare({
      acceptance_criteria: [
        { id: 'AC-1', statement: 'mul multiplies', proof: ['a test'], mandatory: true, check_ids: ['unit'] },
        { id: 'AC-2', statement: 'optional extra', proof: ['a test'], mandatory: false },
      ],
    });
    writePlan(['apps/calc.mjs']);
    await planningStep(lab.ctx());
    const map = decisions('planning.proof-map')[0]!.data as { criteria: { id: string; check_ids: string[]; changes: unknown[] }[] };
    expect(map.criteria.map((c) => [c.id, c.check_ids, c.changes.length])).toEqual([
      ['AC-1', ['unit'], 1],
      ['AC-2', [], 0],
    ]);
  });

  it('uses the baseline report\'s failing checks as difficulty evidence', async () => {
    prepare();
    writeFileSync(join(lab.ctx().runDir, 'baseline.json'), JSON.stringify({ failures: [{ checkId: 'lint', fingerprint: 'fp', excerpt: null }, { checkId: 'unit', fingerprint: null, excerpt: null }] }));
    await planningStep(lab.ctx());
    expect(JSON.stringify(decisions('planning.difficulty')[0]!.data)).toContain('2');
  });

  it('charges spend recorded before the budget existed exactly once', async () => {
    prepare();
    recordUsage(lab.db, { runId: lab.runId, workerId: null, provider: 'claude', model: 'm', usage, durationMs: 1 }, lab.clock);
    const w = planWorker(lab.db, { id: 'wrk-plan', runId: lab.runId, role: 'planner', provider: 'claude', workerDir: join(lab.base, 'wp'), cwd: lab.repo }, lab.clock, OWNER);
    recordUsage(lab.db, { runId: lab.runId, workerId: w.id, provider: 'claude', model: 'm', usage: { ...usage, costUsd: 0.3 }, durationMs: 1 }, lab.clock);
    await planningStep(lab.ctx());
    const ledger = lab.ctx().ledger!;
    expect(ledger.state('cost_usd').used).toBeCloseTo(0.5, 6);
    const ev = lab.db.get<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'budget.precharged'", lab.runId);
    expect(JSON.parse(ev!.data_json)).toEqual({ usage_rows: 2, charged_usd: 0.5 });
  });

  it('counts recovery attempts spent before the budget existed, once, so the report does not say 0 used (Nm8)', async () => {
    prepare();
    // A resume after a block in CONTRACTING spends a recovery attempt while the run has no counters (e2e r13).
    spendRecoveryAttempt(lab.db, lab.runId, lab.clock, { actor: OWNER, why: 'resume after a block: fresh the planner' });
    await planningStep(lab.ctx());
    expect(lab.ctx().ledger!.state('recovery_attempts').used).toBe(1);
    const ev = lab.db.get<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'budget.precharged'", lab.runId);
    expect(JSON.parse(ev!.data_json)).toMatchObject({ recovery_attempts: 1 });
    // A restarted step charges nothing twice, and an attempt spent through the counters is not counted again.
    spendRecoveryAttempt(lab.db, lab.runId, lab.clock, { actor: OWNER, why: 'later', ledgerFor: () => lab.ctx().ledger! });
    lab.db.run("UPDATE runs SET state = 'PLANNING' WHERE id = ?", lab.runId);
    await planningStep(lab.ctx());
    expect(lab.ctx().ledger!.state('recovery_attempts').used).toBe(2);
  });

  it('keeps the counters of a restarted step and does not charge the earlier spend again', async () => {
    prepare();
    recordUsage(lab.db, { runId: lab.runId, workerId: null, provider: 'claude', model: 'm', usage, durationMs: 1 }, lab.clock);
    await planningStep(lab.ctx());
    lab.db.run("UPDATE runs SET state = 'PLANNING' WHERE id = ?", lab.runId);
    await planningStep(lab.ctx());
    expect(lab.ctx().ledger!.state('cost_usd').used).toBeCloseTo(0.2, 6);
    expect(lab.db.all("SELECT 1 FROM events WHERE run_id = ? AND type = 'budget.precharged'", lab.runId)).toHaveLength(1);
  });

  it('refuses to plan a run that reached PLANNING without a contract', async () => {
    prepare();
    lab.db.run('UPDATE runs SET contract_json = NULL WHERE id = ?', lab.runId);
    await expect(planningStep(lab.ctx())).rejects.toMatchObject({ code: 'CONTRACT_INVALID', message: expect.stringContaining('reached PLANNING') });
  });

  it('rates test availability partial when a mandatory criterion names no check', async () => {
    prepare({
      acceptance_criteria: [
        { id: 'AC-1', statement: 'mul(a, b) returns the product', proof: ['tests/mul.test.mjs asserts mul(2, 3) === 6'], mandatory: true, check_ids: ['unit'] },
        { id: 'AC-2', statement: 'the README mentions mul', proof: ['review of the README diff'], mandatory: true, check_ids: [] },
      ],
    });
    writePlan(['apps/calc.mjs']);
    await planningStep(lab.ctx());
    expect(decisions('planning.difficulty')).toHaveLength(1);
    expect(JSON.stringify(decisions('planning.difficulty')[0]?.data)).toContain('partial');
  });

  it('stops at a safe point when the run is being cancelled', async () => {
    prepare();
    requestCancel(lab.db, lab.runId, 'user', lab.clock);
    expect(await planningStep(lab.ctx())).toMatchObject({ done: true });
    expect(getRun(lab.db, lab.runId).state).toBe('CANCELLED');
  });
});
