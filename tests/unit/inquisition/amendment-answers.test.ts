import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInquisition } from '../../../src/inquisition/engine.ts';
import { amendmentIdOfQuestion, applyAmendmentAnswers } from '../../../src/inquisition/amendment-answers.ts';
import { answerQuestion } from '../../../src/inquisition/questions.ts';
import { getAmendment, setQuestionAnswer } from '../../../src/inquisition/store.ts';
import type { AmendmentChange } from '../../../src/contract/amendment-types.ts';
import type { GoalContract } from '../../../src/contract/types.ts';
import { RUN, ScriptedAdapter, inquisitorOutput, setup, type Env } from './helpers.ts';

let env: Env | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

/** An amendment only a person may approve (removing a criterion), left pending with its approval question. */
async function pendingAmendment(e: Env, change: AmendmentChange = { op: 'remove_criterion', criterion_id: 'AC-3' }): Promise<{ id: string; qid: string }> {
  const out = inquisitorOutput({ amendments: [{ change, evidence: 'reports.ts:40 paginates before export', reason: 'AC-3 duplicates AC-1' }] });
  const res = await runInquisition({
    trigger: { kind: 'missing_outcomes', mode: 'clarify', summary: 'acceptance criteria lack a measurable outcome', evidence: ['AC-1: vague'], subjects: [], key: `amend:${Math.random()}` },
    context: e.ctx({}, { worker: { route: { provider: 'fake', model: 'fake-model', effort: null }, workerDir: `${e.dir}/workers`, cwd: `${e.dir}/wt`, sandbox: { writablePaths: [], denyReadPaths: [], allowedHosts: [], limits: { timeoutMs: 1000, memoryMb: null, cpus: null, pids: null } }, policyPath: `${e.dir}/policy.json`, pollMs: 10, timeoutMs: 1000 } }),
    adapter: new ScriptedAdapter([{ structured: out }]),
  });
  const id = res.amendments.pending[0]!.id;
  return { id, qid: `q-amd-${id}` };
}

const scope = (e: Env) => ({ db: e.db, clock: e.clock, runId: RUN, runDir: e.runDir });
const criteria = (e: Env): string[] => (JSON.parse(e.db.get<{ contract_json: string }>('SELECT contract_json FROM runs WHERE id = ?', RUN)!.contract_json) as GoalContract).acceptance_criteria.map((c) => c.id);

describe('amendmentIdOfQuestion', () => {
  it('names the amendment of an approval question and nothing for any other question', () => {
    expect(amendmentIdOfQuestion('q-amd-amd-1')).toBe('amd-1');
    expect(amendmentIdOfQuestion('q-export-scope')).toBeNull();
  });
});

describe('applyAmendmentAnswers', () => {
  it('a question that is not an amendment approval changes nothing', async () => {
    env = setup();
    await pendingAmendment(env);
    const out = applyAmendmentAnswers(scope(env), { questionId: 'q-export-scope', snapshot: env.snap });
    expect(out).toMatchObject({ outcomes: [], changed: false });
    expect(out.contract?.acceptance_criteria).toHaveLength(3);
  });

  it('an unanswered approval question leaves the amendment pending', async () => {
    env = setup();
    const { id } = await pendingAmendment(env);
    const out = applyAmendmentAnswers(scope(env), { snapshot: env.snap });
    expect(out.outcomes).toEqual([{ amendmentId: id, questionId: `q-amd-${id}`, status: 'unanswered', detail: null }]);
    expect(getAmendment(env.db, id).status).toBe('pending-approval');
  });

  it('"Approve" from a person applies the amendment to the run contract, mirrors it and records the change', async () => {
    env = setup();
    const { id, qid } = await pendingAmendment(env);
    answerQuestion(env.db, env.runDir, qid, 'Approve', 'alice', env.clock);
    const out = applyAmendmentAnswers(scope(env), { questionId: qid, snapshot: env.snap });
    expect(out.outcomes).toEqual([{ amendmentId: id, questionId: qid, status: 'applied', detail: null }]);
    expect(out.changed).toBe(true);
    expect(criteria(env)).toEqual(['AC-1', 'AC-2']);
    expect((JSON.parse(readFileSync(join(env.runDir, 'contract.json'), 'utf8')) as GoalContract).acceptance_criteria).toHaveLength(2);
    expect(env.db.get("SELECT 1 AS x FROM events WHERE run_id = ? AND type = 'contract.amended'", RUN)).toBeTruthy();
    // Applying again is a no-op: the amendment is no longer pending.
    expect(applyAmendmentAnswers(scope(env), { snapshot: env.snap })).toMatchObject({ outcomes: [], changed: false });
  });

  it('"Reject" closes the amendment and keeps the contract', async () => {
    env = setup();
    const { id, qid } = await pendingAmendment(env);
    answerQuestion(env.db, env.runDir, qid, 'Reject', 'alice', env.clock);
    const out = applyAmendmentAnswers(scope(env), { snapshot: env.snap });
    expect(out.outcomes).toEqual([{ amendmentId: id, questionId: qid, status: 'rejected', detail: null }]);
    expect(getAmendment(env.db, id).status).toBe('rejected');
    expect(criteria(env)).toEqual(['AC-1', 'AC-2', 'AC-3']);
    expect(existsSync(join(env.runDir, 'contract.json'))).toBe(false);
  });

  it('an answer with no recorded human decision behind it is declined', async () => {
    env = setup();
    const { id, qid } = await pendingAmendment(env);
    setQuestionAnswer(env.db, qid, 'Approve', 'alice', env.clock);
    const out = applyAmendmentAnswers(scope(env), { snapshot: env.snap });
    expect(out.outcomes).toEqual([{ amendmentId: id, questionId: qid, status: 'declined', detail: 'the answer is not a recorded decision by a person' }]);
    expect(getAmendment(env.db, id).status).toBe('pending-approval');
  });

  it('an approval for a run without a contract yet is deferred', async () => {
    env = setup();
    const { qid } = await pendingAmendment(env);
    answerQuestion(env.db, env.runDir, qid, 'Approve', 'alice', env.clock);
    env.db.run('UPDATE runs SET contract_json = NULL WHERE id = ?', RUN);
    const out = applyAmendmentAnswers(scope(env), { snapshot: env.snap });
    expect(out.outcomes[0]).toMatchObject({ status: 'deferred', detail: 'the run has no contract yet' });
    expect(out.contract).toBeNull();
  });

  it('an approval is refused while the frozen policy snapshot cannot be verified', async () => {
    env = setup();
    const { id, qid } = await pendingAmendment(env);
    answerQuestion(env.db, env.runDir, qid, 'Approve', 'alice', env.clock);
    const out = applyAmendmentAnswers(scope(env));
    expect(out.outcomes[0]).toMatchObject({ status: 'refused', detail: expect.stringMatching(/^the policy snapshot could not be verified: /) });
    expect(getAmendment(env.db, id).status).toBe('pending-approval');
  });

  it('an approved amendment that no longer fits the contract is closed, not left pending', async () => {
    env = setup();
    const { id, qid } = await pendingAmendment(env);
    answerQuestion(env.db, env.runDir, qid, 'Approve', 'alice', env.clock);
    // AC-3 was removed some other way after the amendment was proposed.
    const contract = JSON.parse(env.db.get<{ contract_json: string }>('SELECT contract_json FROM runs WHERE id = ?', RUN)!.contract_json) as GoalContract;
    contract.acceptance_criteria = contract.acceptance_criteria.filter((c) => c.id !== 'AC-3');
    env.db.run('UPDATE runs SET contract_json = ? WHERE id = ?', JSON.stringify(contract), RUN);
    const out = applyAmendmentAnswers(scope(env), { snapshot: env.snap });
    expect(out.outcomes[0]).toMatchObject({ amendmentId: id, status: 'refused' });
    expect(getAmendment(env.db, id).status).toBe('rejected');
    expect(env.db.get("SELECT 1 AS x FROM events WHERE run_id = ? AND type = 'amendment.apply-refused'", RUN)).toBeTruthy();
  });

  it('with a question id, only that amendment is considered', async () => {
    env = setup();
    const first = await pendingAmendment(env);
    const second = await pendingAmendment(env, { op: 'remove_criterion', criterion_id: 'AC-2' });
    answerQuestion(env.db, env.runDir, first.qid, 'Approve', 'alice', env.clock);
    answerQuestion(env.db, env.runDir, second.qid, 'Approve', 'alice', env.clock);
    const out = applyAmendmentAnswers(scope(env), { questionId: second.qid, snapshot: env.snap });
    expect(out.outcomes.map((o) => o.amendmentId)).toEqual([second.id]);
    expect(getAmendment(env.db, first.id).status).toBe('pending-approval');
    expect(criteria(env)).toEqual(['AC-1', 'AC-3']);
  });
});
