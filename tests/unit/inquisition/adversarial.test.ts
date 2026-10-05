import { afterEach, describe, expect, it } from 'vitest';
import { riskCategoriesInText } from '../../../src/inquisition/heuristics.ts';
import { isOrbitError, type OrbitErrorCode } from '../../../src/core/errors.ts';
import { listWorkers, planWorker, finishWorker, markWorkerRunning } from '../../../src/storage/workers.ts';
import { recordDecision, listDecisions } from '../../../src/storage/decisions.ts';
import { answerQuestion, criteriaBlockedByQuestions, isHumanActor, openQuestions, persistQuestion } from '../../../src/inquisition/questions.ts';
import { applyApprovedAmendment, authorityMap, rebuildContract, renderInquisitorPrompt, runInquisition, type InquisitorWorkerOptions } from '../../../src/inquisition/engine.ts';
import { addAssumption, transitionAssumption } from '../../../src/inquisition/ledger.ts';
import { isNewHypothesis, proposeHypothesis, recordExperiment, recordExperimentResult } from '../../../src/inquisition/hypotheses.ts';
import { nonProgress, progressSince, validateRepairBrief, type AttemptSnapshot } from '../../../src/inquisition/repair.ts';
import { resolveAmbiguities, type Ambiguity } from '../../../src/inquisition/resolve.ts';
import { getHypothesis, listLedger, listQuestions } from '../../../src/inquisition/store.ts';
import { detectTriggers, loadInquisitionSnapshot, proofAdequacy } from '../../../src/inquisition/triggers.ts';
import type { Trigger } from '../../../src/inquisition/types.ts';
import { RUN, ScriptedAdapter, addCheckRun, addEvidence, addFailure, goodQuestion, inquisitorOutput, setup, workerQuestion, type Env } from './helpers.ts';

let env: Env | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

function trig(over: Partial<Trigger> = {}): Trigger {
  return { kind: 'repeated_failure', mode: 'diagnose', summary: 'equivalent failure repeated 2 times', evidence: ['fingerprint fp-a on 2 distinct candidates'], subjects: [], key: 'repeated_failure:fp-a:2', ...over };
}

function workerOpts(e: Env, over: Partial<InquisitorWorkerOptions> = {}): InquisitorWorkerOptions {
  return {
    route: { provider: 'fake', model: 'fake-model', effort: null },
    workerDir: `${e.dir}/workers`,
    cwd: `${e.dir}/wt`,
    sandbox: { writablePaths: [], denyReadPaths: [], allowedHosts: [], limits: { timeoutMs: 1000, memoryMb: null, cpus: null, pids: null } },
    policyPath: `${e.dir}/policy.json`,
    pollMs: 10,
    timeoutMs: 1000,
    ...over,
  };
}

function expectCode(fn: () => unknown, code: OrbitErrorCode): void {
  try {
    fn();
  } catch (err) {
    expect(isOrbitError(err, code), String(err)).toBe(true);
    return;
  }
  throw new Error(`expected ${code}`);
}

async function rejectsWith(p: Promise<unknown>, code: OrbitErrorCode): Promise<void> {
  try {
    await p;
  } catch (err) {
    expect(isOrbitError(err, code), String(err)).toBe(true);
    return;
  }
  throw new Error(`expected ${code}`);
}

const SECRET_KEY = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefgh';
const SECRET_GH = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD';

describe('restart does not duplicate inquisitor workers (scenario 7)', () => {
  it('a second call for the same trigger reuses the finished worker output instead of spawning another', async () => {
    env = setup();
    const out = inquisitorOutput({ mode: 'diagnose', questions: [workerQuestion()] });
    const t = trig();
    const a1 = new ScriptedAdapter([{ structured: out }]);
    const r1 = await runInquisition({ trigger: t, context: env.ctx({}, { worker: workerOpts(env) }), adapter: a1 });
    expect(r1.workerRan).toBe(true);
    const a2 = new ScriptedAdapter([{ structured: out }]);
    const r2 = await runInquisition({ trigger: t, context: env.ctx({}, { worker: workerOpts(env) }), adapter: a2 });
    expect(a2.specs).toHaveLength(0);
    expect(r2.workerRan).toBe(false);
    expect(r2.workerIds).toEqual(r1.workerIds);
    expect(listWorkers(env.db, { runId: RUN })).toHaveLength(1);
    expect(env.db.all('SELECT 1 FROM usage WHERE run_id = ?', RUN)).toHaveLength(1);
    expect(r2.questions.map((q) => q.id)).toEqual(r1.questions.map((q) => q.id));
    expect(r2.blockedCriteria).toEqual(r1.blockedCriteria);
  });

  it('a worker row left PLANNED or RUNNING by a crash is never joined by a second inquisitor', async () => {
    env = setup();
    const t = trig();
    planWorker(env.db, { id: 'wrk-crashed', runId: RUN, role: 'inquisitor', purpose: `inquisition:diagnose:${t.key}`, provider: 'fake', workerDir: `${env.dir}/workers/wrk-crashed`, cwd: env.dir }, env.clock);
    const a = new ScriptedAdapter([{ structured: inquisitorOutput({ mode: 'diagnose' }) }]);
    await rejectsWith(runInquisition({ trigger: t, context: env.ctx({}, { worker: workerOpts(env) }), adapter: a }), 'CONCURRENT_UPDATE');
    markWorkerRunning(env.db, 'wrk-crashed', { pid: 4242, pgid: 4242, procStart: null }, env.clock);
    await rejectsWith(runInquisition({ trigger: t, context: env.ctx({}, { worker: workerOpts(env) }), adapter: a }), 'CONCURRENT_UPDATE');
    expect(a.specs).toHaveLength(0);
    expect(listWorkers(env.db, { runId: RUN })).toHaveLength(1);
  });

  it('regeneration of malformed output is bounded across restarts, not per call', async () => {
    env = setup();
    const t = trig({ kind: 'missing_outcomes', mode: 'clarify', subjects: ['AC-2'], key: 'missing_outcomes:zz' });
    for (const id of ['wrk-m1', 'wrk-m2']) {
      planWorker(env.db, { id, runId: RUN, role: 'inquisitor', purpose: `inquisition:clarify:${t.key}`, provider: 'fake', workerDir: `${env.dir}/workers/${id}`, cwd: env.dir }, env.clock);
      markWorkerRunning(env.db, id, { pid: 1, pgid: 1, procStart: null }, env.clock);
      finishWorker(env.db, id, { state: 'FAILED', resultStatus: 'malformed_output', error: 'not json' }, env.clock);
    }
    const a = new ScriptedAdapter([{ structured: inquisitorOutput() }]);
    const res = await runInquisition({ trigger: t, context: env.ctx({}, { worker: workerOpts(env, { maxAttempts: 2 }) }), adapter: a });
    expect(a.specs).toHaveLength(0);
    expect(res.workerRan).toBe(false);
    expect(res.blockedCriteria).toEqual(['AC-2']);
  });
});

describe('an answered question stays answered', () => {
  it('a later inquiry that asks the same question again does not reopen or re-block it', async () => {
    env = setup();
    const out = inquisitorOutput({ questions: [workerQuestion()] });
    const r1 = await runInquisition({ trigger: trig({ key: 'k1' }), context: env.ctx({}, { worker: workerOpts(env) }), adapter: new ScriptedAdapter([{ structured: out }]) });
    expect(r1.blockedCriteria).toEqual(['AC-1']);
    answerQuestion(env.db, env.runDir, r1.questions[0]!.id, 'A', 'alice', env.clock);
    const r2 = await runInquisition({ trigger: trig({ key: 'k2' }), context: env.ctx({}, { worker: workerOpts(env) }), adapter: new ScriptedAdapter([{ structured: out }]) });
    expect(openQuestions(env.db, RUN)).toEqual([]);
    expect(listQuestions(env.db, RUN)).toHaveLength(1);
    expect(r2.blockedCriteria).toEqual([]);
    expect(r2.disposition).toBe('continue');
  });

  it('a rule-planned material ambiguity whose question was already answered no longer blocks', async () => {
    env = setup();
    const amb: Ambiguity = {
      id: 'AMB-2',
      description: 'Should the export include every matching record or only the current page?',
      kind: 'product-semantics',
      evidence: ['Filtering occurs before pagination; no export convention exists.'],
      reversibility: 'costly-to-reverse',
      affects: ['AC-1'],
      question: goodQuestion(),
    };
    const r1 = await runInquisition({ trigger: trig({ kind: 'missing_outcomes', mode: 'clarify', key: 'a' }), context: env.ctx({}, { ambiguities: [amb] }) });
    expect(r1.blockedCriteria).toEqual(['AC-1']);
    answerQuestion(env.db, env.runDir, r1.questions[0]!.id, 'All matching records', 'alice', env.clock);
    const r2 = await runInquisition({ trigger: trig({ kind: 'missing_outcomes', mode: 'clarify', key: 'b' }), context: env.ctx({}, { ambiguities: [amb] }) });
    expect(r2.blockedCriteria).toEqual([]);
    expect(openQuestions(env.db, RUN)).toEqual([]);
    expect(listQuestions(env.db, RUN)).toHaveLength(1);
  });

  it('an answer settles only the question it answered: other criteria or other options are asked afresh', () => {
    env = setup();
    const first = persistQuestion(env.db, RUN, 'clarify', goodQuestion(), env.clock).question;
    answerQuestion(env.db, env.runDir, first.id, 'Current page', 'alice', env.clock);
    // Same words, but about AC-2: the person answered for AC-1 only.
    const other = persistQuestion(env.db, RUN, 'clarify', goodQuestion({ affected_work: ['AC-2'], unblocked_work: ['AC-1', 'AC-3'] }), env.clock, { contract: env.contract });
    expect(other.created).toBe(true);
    expect(other.question.status).toBe('open');
    // Same words and criterion, but different options: a different decision.
    const opts = goodQuestion().options.map((o, i) => (i === 0 ? { ...o, description: 'Stream every page to the client as a zip archive.' } : o));
    const reoptioned = persistQuestion(env.db, RUN, 'clarify', goodQuestion({ options: opts }), env.clock);
    expect(reoptioned.created).toBe(true);
    expect(reoptioned.question.status).toBe('open');
  });

  it('the same open question asked for more criteria blocks all of them', () => {
    env = setup();
    const first = persistQuestion(env.db, RUN, 'clarify', goodQuestion(), env.clock).question;
    const again = persistQuestion(env.db, RUN, 'clarify', goodQuestion({ affected_work: ['AC-2'], unblocked_work: ['AC-1', 'AC-3'] }), env.clock, { contract: env.contract });
    expect(again.created).toBe(false);
    expect(again.question.id).toBe(first.id);
    expect(again.question.affected).toEqual(['AC-1', 'AC-2']);
    expect(criteriaBlockedByQuestions(openQuestions(env.db, RUN))).toEqual(['AC-1', 'AC-2']);
  });

  it('persistQuestion returns the answered record instead of creating a second question', () => {
    env = setup();
    const first = persistQuestion(env.db, RUN, 'clarify', goodQuestion(), env.clock).question;
    answerQuestion(env.db, env.runDir, first.id, 'Current page', 'alice', env.clock);
    const again = persistQuestion(env.db, RUN, 'clarify', goodQuestion(), env.clock);
    expect(again.created).toBe(false);
    expect(again.question).toMatchObject({ id: first.id, status: 'answered' });
  });
});

describe('proof adequacy and stale evidence', () => {
  it('with no current evidence at all, green cannot be trusted', () => {
    env = setup();
    const r = proofAdequacy(loadInquisitionSnapshot(env.db, RUN));
    expect(r.adequate).toBe(false);
    expect(r.reason).toMatch(/no current evidence/);
  });

  it('evidence for another tree is stale: it is ignored, and proof is inadequate', () => {
    env = setup();
    addEvidence(env.db, { verdict: 'PASS', tree: 'tree-old', checks: [{ id: 'lint', status: 'PASSED' }], acceptance: [{ criterion_id: 'AC-1', status: 'supported', artifacts: ['a'] }] });
    const snap = loadInquisitionSnapshot(env.db, RUN, { currentTreeHash: 'tree-new' });
    expect(snap.evidence).toBeNull();
    const r = proofAdequacy(snap);
    expect(r.adequate).toBe(false);
    expect(r.reason).toMatch(/no current evidence/);
  });

  it('with the current tree known, the report for that tree is used even when an older tree reported later', () => {
    env = setup();
    addEvidence(env.db, { tree: 'tree-new', verdict: 'FAIL' });
    addEvidence(env.db, { tree: 'tree-old', verdict: 'PASS' });
    expect(loadInquisitionSnapshot(env.db, RUN, { currentTreeHash: 'tree-new' }).evidence).toMatchObject({ treeHash: 'tree-new', verdict: 'FAIL' });
  });

  it('reviews of another tree do not count toward disagreement on the current one', () => {
    env = setup();
    env.db.run('INSERT INTO reviews (id, run_id, candidate_id, tree_hash, round, provider, verdict, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', 'rev-a', RUN, 'c', 'tree-old', 1, 'codex', 'REJECT', 1);
    env.db.run('INSERT INTO reviews (id, run_id, candidate_id, tree_hash, round, provider, verdict, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', 'rev-b', RUN, 'c', 'tree-old', 1, 'claude', 'APPROVE', 2);
    expect(loadInquisitionSnapshot(env.db, RUN, { currentTreeHash: 'tree-new' }).reviews).toEqual([]);
  });
});

describe('secrets never reach durable inquisition records or the worker prompt', () => {
  it('trigger evidence built from a diff is redacted', () => {
    env = setup();
    const diff = `+++ b/apps/api/billing/export.ts\n+const invoicePrice = 10; const key = "${SECRET_KEY}";\n`;
    const triggers = detectTriggers(loadInquisitionSnapshot(env.db, RUN, { changedFiles: ['apps/api/billing/export.ts'], diff }));
    const hidden = triggers.filter((t) => t.kind === 'hidden_decision' && t.evidence.some((e) => e.startsWith('added:')));
    expect(hidden.length).toBeGreaterThan(0);
    expect(JSON.stringify(hidden)).toContain('invoice');
    expect(JSON.stringify(hidden)).not.toContain(SECRET_KEY);
  });

  it('trigger evidence built from implementer claims and failure excerpts is redacted', () => {
    env = setup();
    addFailure(env.db, 'fp-a', 'c1', `Error: bad credentials ${SECRET_GH}`);
    addFailure(env.db, 'fp-a', 'c2', `Error: bad credentials ${SECRET_GH}`);
    const claims = {
      checks_run: [{ check_id: 'lint', command: null, claimed_result: 'passed' }],
      evidence_refs: [{ criterion_id: 'AC-1', ref: `logs/${SECRET_GH}.txt` }],
      tests_added: [],
      next_action: { kind: 'request-verification' },
    } as never;
    const triggers = detectTriggers(loadInquisitionSnapshot(env.db, RUN, { claims }));
    expect(triggers.map((t) => t.kind)).toEqual(expect.arrayContaining(['repeated_failure', 'unsupported_confidence']));
    expect(JSON.stringify(triggers)).not.toContain(SECRET_GH);
  });

  it('a worker that quotes a secret has it redacted from the question, the decision and the ledger it persists', async () => {
    env = setup();
    const q = workerQuestion({ evidence: [`The config at apps/api/config.ts hardcodes ${SECRET_GH}, so the repository convention is unclear.`] });
    const out = inquisitorOutput({
      questions: [q],
      autonomous_decisions: [{ decision: 'Name the export file after the report', category: 'implementation-detail', rationale: `Matches the download name; the sample used ${SECRET_KEY} as a path`, evidence: [`seen near ${SECRET_GH}`], reversibility: 'reversible' }],
      ledger: [{ claim: `The sample ${SECRET_GH} is a placeholder`, source: 'apps/api/config.ts:3', confidence: 'low', consequence_if_wrong: 'a live credential is committed', reversibility: 'reversible', validation_experiment: 'ask the owner', status: 'unverified' }],
    });
    await runInquisition({ trigger: trig(), context: env.ctx({}, { worker: workerOpts(env) }), adapter: new ScriptedAdapter([{ structured: out }]) });
    const dump = JSON.stringify([listQuestions(env.db, RUN), listLedger(env.db, RUN), listDecisions(env.db, RUN)]);
    expect(dump).not.toContain(SECRET_GH);
    expect(dump).not.toContain(SECRET_KEY);
  });

  it('the prompt redacts secrets in every block, not only the trigger evidence', () => {
    env = setup();
    proposeHypothesis(env.db, RUN, { statement: `The token ${SECRET_GH} expired early`, fingerprint: 'fp-a' }, env.clock);
    const prompt = renderInquisitorPrompt(trig(), env.ctx());
    expect(prompt).not.toContain(SECRET_GH);
  });
});

describe('ledger evidence must be real evidence', () => {
  const BASE = { runId: RUN, claim: 'The export includes rows beyond page one.', source: 'apps/api/reports.ts:40', confidence: 'low' as const, consequence: 'Rows are silently missing.', reversibility: 'reversible' as const, experiment: 'Run a 250 row fixture.' };

  it('a failed or flaky check cannot support a claim', () => {
    env = setup();
    addCheckRun(env.db, 'chk-red', 'reports-tests', 'FAILED');
    addCheckRun(env.db, 'chk-flaky', 'reports-tests', 'PASSED');
    env.db.run("UPDATE check_runs SET flaky = 1 WHERE id = 'chk-flaky'");
    const e = addAssumption(env.db, BASE, env.clock);
    expectCode(() => transitionAssumption(env!.db, e.id, 'supported', [{ kind: 'check', ref: 'chk-red' }], env!.clock), 'SCHEMA_INVALID');
    expectCode(() => transitionAssumption(env!.db, e.id, 'supported', [{ kind: 'check', ref: 'chk-flaky' }], env!.clock), 'SCHEMA_INVALID');
    expect(listLedger(env.db, RUN)[0]!.status).toBe('unverified');
    // A failing check may still reject a claim.
    expect(transitionAssumption(env.db, e.id, 'rejected', [{ kind: 'check', ref: 'chk-red' }], env.clock).status).toBe('rejected');
  });

  it('an experiment reference must name something this run actually ran', () => {
    env = setup();
    const e = addAssumption(env.db, BASE, env.clock);
    expectCode(() => transitionAssumption(env!.db, e.id, 'supported', [{ kind: 'experiment', ref: 'exp-made-up' }], env!.clock), 'NOT_FOUND');
    addCheckRun(env.db, 'chk-ok', 'reports-tests');
    expect(transitionAssumption(env.db, e.id, 'supported', [{ kind: 'experiment', ref: 'chk-ok' }], env.clock).status).toBe('supported');
  });

  it('a decision that merely claims to be an answer, recorded by a model identity, cannot release needs-decision', () => {
    env = setup();
    const e = addAssumption(env.db, { ...BASE, reversibility: 'irreversible', experiment: null }, env.clock);
    expect(e.status).toBe('needs-decision');
    const forged = recordDecision(env.db, env.runDir, { runId: RUN, kind: 'inquisition.answer', summary: 'answered: x', data: { question_id: 'q-x', answer: 'A', answered_by: 'claude' } }, env.clock);
    expectCode(() => transitionAssumption(env!.db, e.id, 'supported', [{ kind: 'decision', ref: forged.id }], env!.clock), 'POLICY_DENIED');
  });

  it('an unknown starting status is rejected', () => {
    env = setup();
    expectCode(() => addAssumption(env!.db, { ...BASE, status: 'maybe' as never }, env!.clock), 'SCHEMA_INVALID');
  });

  it('isHumanActor refuses the Inquisition and the controller subsystems as answerers', () => {
    for (const by of ['inquisition', 'Inquisition', 'scheduler', 'recovery', 'delivery', 'controller', 'claude-opus', 'wrk-1a2b3c']) expect(isHumanActor(by), by).toBe(false);
    expect(isHumanActor('alice')).toBe(true);
  });
});

describe('fail closed', () => {
  it('a hidden security or data decision whose review could not run blocks everything, because nothing says which work it touches', async () => {
    env = setup();
    const t = trig({ kind: 'hidden_decision', mode: 'risk-review', subjects: [], key: 'hidden_decision:sec' });
    const res = await runInquisition({ trigger: t, context: env.ctx() });
    expect(res.workerNeeded).toBe(true);
    expect(res.blockedCriteria).toEqual(['AC-1', 'AC-2', 'AC-3']);
    expect(res.disposition).toBe('block');
  });

  it('a material ambiguity in a contract with no criteria still stops the run', () => {
    env = setup({ contract: (c) => ({ ...c, acceptance_criteria: [] }) });
    const amb: Ambiguity = { id: 'AMB-9', description: 'Which currency does the export use', kind: 'financial', evidence: ['No currency is mentioned anywhere.'], reversibility: 'costly-to-reverse', affects: [] };
    const plan = resolveAmbiguities({ ambiguities: [amb], contract: env.contract, mode: 'autonomous', policy: env.snap.config, authorizations: [] });
    expect(plan.disposition).toBe('block');
    const supervised = resolveAmbiguities({ ambiguities: [amb], contract: env.contract, mode: 'supervised', policy: env.snap.config, authorizations: [] });
    expect(supervised.disposition).toBe('ask');
  });

  it('a technical experiment with no authorization list to check against is not run', () => {
    env = setup();
    const amb: Ambiguity = {
      id: 'AMB-7',
      description: 'Is the page limit applied before the filter',
      kind: 'technical-hypothesis',
      evidence: ['reports.ts:40 builds the query'],
      reversibility: 'reversible',
      affects: ['AC-1'],
      experiment: { description: 'Print the generated SQL for a 250 row fixture', expectedObservation: 'LIMIT appears before WHERE', authorization: 'curl-evil' },
    };
    const plan = resolveAmbiguities({ ambiguities: [amb], contract: env.contract, mode: 'autonomous', policy: env.snap.config } as never);
    expect(plan.experiments).toEqual([]);
    expect(plan.unresolved).toEqual([{ ambiguityId: 'AMB-7', reason: expect.stringContaining('not a defined check') }]);
    expect(plan.blockedCriteria).toEqual(['AC-1']);
  });

  it('a worker cannot mark a contract assumption supported or rejected by amendment: a proposal is not evidence', async () => {
    env = setup();
    const out = inquisitorOutput({
      amendments: [
        { change: { op: 'set_assumption', assumption_id: null, statement: 'Dates are exported in UTC.', status: 'supported' }, evidence: 'reports.ts:12 formats in UTC', reason: 'record the assumption' },
        { change: { op: 'set_assumption', assumption_id: 'AS-1', statement: env.contract.assumptions.find((a) => a.id === 'AS-1')!.statement, status: 'supported' }, evidence: 'looks fine', reason: 'it is fine' },
      ],
    });
    const res = await runInquisition({ trigger: trig({ kind: 'missing_outcomes', mode: 'clarify', key: 'amd-sup' }), context: env.ctx({}, { worker: workerOpts(env) }), adapter: new ScriptedAdapter([{ structured: out }]) });
    expect(res.amendments.applied).toEqual([]);
    expect(res.amendments.pending.length).toBeGreaterThanOrEqual(1);
    expect(res.contract.assumptions.filter((a) => a.status === 'supported')).toEqual(env.contract.assumptions.filter((a) => a.status === 'supported'));
  });

  describe('a claim an earlier tree had supported', () => {
    const GREEN = [{ id: 'lint', status: 'PASSED' }, { id: 'typecheck', status: 'PASSED' }, { id: 'reports-tests', status: 'PASSED' }, { id: 'build', status: 'PASSED' }];
    async function greenWithoutProof(e: Env, tree: string) {
      addEvidence(e.db, { tree, verdict: 'INCOMPLETE', checks: GREEN, acceptance: [] });
      const t = detectTriggers(loadInquisitionSnapshot(e.db, RUN, { currentTreeHash: tree })).find((x) => x.kind === 'green_without_proof');
      if (!t) throw new Error('fixture must produce green_without_proof');
      return t;
    }

    it('is reopened when a new trigger instance (another tree) raises the same claim', async () => {
      env = setup();
      const t1 = await greenWithoutProof(env, 'tree-1');
      const r1 = await runInquisition({ trigger: t1, context: env.ctx() });
      const claim = r1.ledger[0]!;
      transitionAssumption(env.db, claim.id, 'supported', [{ kind: 'inspection', ref: 'apps/api/reports.ts:40' }], env.clock);
      const t2 = await greenWithoutProof(env, 'tree-2');
      expect(t2.key).not.toBe(t1.key);
      const r2 = await runInquisition({ trigger: t2, context: env.ctx() });
      expect(r2.ledger.find((l) => l.id === claim.id)?.status).toBe('unverified');
      expect(listLedger(env.db, RUN)).toHaveLength(r1.ledger.length);
      // The reopening is itself recorded as evidence.
      expect(r2.ledger.find((l) => l.id === claim.id)?.evidence.map((x) => x.ref)).toContain(`trigger:${t2.key}`);
    });

    it('is left alone when the very same trigger is replayed after a crash', async () => {
      env = setup();
      const t1 = await greenWithoutProof(env, 'tree-1');
      const r1 = await runInquisition({ trigger: t1, context: env.ctx() });
      const claim = r1.ledger[0]!;
      transitionAssumption(env.db, claim.id, 'supported', [{ kind: 'inspection', ref: 'apps/api/reports.ts:40' }], env.clock);
      const replay = await runInquisition({ trigger: t1, context: env.ctx() });
      expect(replay.ledger.find((l) => l.id === claim.id)?.status).toBe('supported');
    });

    it('is never reopened by a worker merely repeating the claim', async () => {
      env = setup();
      const claimText = 'The sample value is a placeholder, not a real credential.';
      const out = inquisitorOutput({ ledger: [{ claim: claimText, source: 'apps/api/config.ts:3', confidence: 'low', consequence_if_wrong: 'a credential is committed', reversibility: 'reversible', validation_experiment: 'ask the owner', status: 'unverified' }] });
      const r1 = await runInquisition({ trigger: trig({ key: 'w1' }), context: env.ctx({}, { worker: workerOpts(env) }), adapter: new ScriptedAdapter([{ structured: out }]) });
      const claim = r1.ledger.find((l) => l.claim === claimText)!;
      transitionAssumption(env.db, claim.id, 'supported', [{ kind: 'inspection', ref: 'apps/api/config.ts:3' }], env.clock);
      const r2 = await runInquisition({ trigger: trig({ key: 'w2' }), context: env.ctx({}, { worker: workerOpts(env) }), adapter: new ScriptedAdapter([{ structured: out }]) });
      expect(r2.ledger.find((l) => l.id === claim.id)?.status).toBe('supported');
    });
  });
});

describe('authority map', () => {
  it('a source with an unrecognised authority label ranks last instead of winning', () => {
    const map = authorityMap([
      { source: 'wiki/page', authority: 'wiki' as never, claims: [{ subject: 'page size', value: '1000' }] },
      { source: 'apps/api/reports.ts', authority: 'code', claims: [{ subject: 'page size', value: '100' }] },
    ]);
    expect(map[0]!.winner).toEqual({ source: 'apps/api/reports.ts', value: '100' });
  });
});

describe('non-progress (scenario 6)', () => {
  function attempt(n: number, over: Partial<AttemptSnapshot> = {}): AttemptSnapshot {
    return { attempt: n, supportedCriteria: [], passingMandatoryChecks: ['lint'], failingMandatoryChecks: ['reports-tests'], failureFingerprints: ['fp-page'], eliminatedHypotheses: [], localizedFault: null, resolvedAmbiguities: [], ...over };
  }

  it('a fault location that merely moves each attempt is not progress, so the loop still terminates', () => {
    const history = [attempt(1, { localizedFault: 'a.ts:10' }), attempt(2, { localizedFault: 'a.ts:11' }), attempt(3, { localizedFault: 'b.ts:5' }), attempt(4, { localizedFault: 'c.ts:9' })];
    expect(progressSince(history[0]!, history[1]!).made_progress).toBe(false);
    expect(nonProgress(history, 3)).toMatchObject({ terminate: true, consecutiveNoProgress: 3 });
  });

  it('the first localization still counts', () => {
    expect(progressSince(attempt(1), attempt(2, { localizedFault: 'a.ts:10' })).made_progress).toBe(true);
  });
});

describe('hypothesis experiments', () => {
  function fresh(e: Env, statement = 'The export query applies the page limit before the filter.') {
    return proposeHypothesis(e.db, RUN, { statement, fingerprint: 'fp-page' }, e.clock).record!.id;
  }

  it('re-recording the identical result after a crash is a no-op, a different one is refused', () => {
    env = setup();
    addCheckRun(env.db, 'chk-9', 'reports-tests');
    const id = fresh(env);
    recordExperiment(env.db, id, { experiment: 'count rows on a 250 row fixture', expectedObservation: 'only 100 rows come back' }, env.clock);
    const res = { outcome: 'eliminated' as const, observation: '250 rows came back, so the limit is not applied early', evidence: ['chk-9'] };
    const first = recordExperimentResult(env.db, id, res, env.clock);
    env.clock.advance(5);
    expect(recordExperimentResult(env.db, id, res, env.clock)).toEqual(first);
    expectCode(() => recordExperimentResult(env!.db, id, { ...res, outcome: 'supported' }, env!.clock), 'TRANSITION_INVALID');
    expect(env.db.all("SELECT 1 FROM events WHERE type = 'hypothesis.eliminated'")).toHaveLength(1);
  });

  it('the expectation cannot be rewritten while the experiment is under way, but re-recording the same one is a no-op', () => {
    env = setup();
    const id = fresh(env);
    recordExperiment(env.db, id, { experiment: 'count rows on a 250 row fixture', expectedObservation: 'only 100 rows come back' }, env.clock);
    const events = env.db.all("SELECT 1 FROM events WHERE type = 'hypothesis.testing'").length;
    recordExperiment(env.db, id, { experiment: 'count rows on a 250 row fixture', expectedObservation: 'only 100 rows come back' }, env.clock);
    expect(env.db.all("SELECT 1 FROM events WHERE type = 'hypothesis.testing'")).toHaveLength(events);
    expectCode(() => recordExperiment(env!.db, id, { experiment: 'count rows on a 250 row fixture', expectedObservation: 'whatever came back, as predicted' }, env!.clock), 'TRANSITION_INVALID');
    expect(getHypothesis(env.db, id).expectedObservation).toBe('only 100 rows come back');
  });

  it('eliminating or supporting a hypothesis needs a reference to something this run recorded', () => {
    env = setup();
    const id = fresh(env);
    recordExperiment(env.db, id, { experiment: 'count rows on a 250 row fixture', expectedObservation: 'only 100 rows come back' }, env.clock);
    expectCode(() => recordExperimentResult(env!.db, id, { outcome: 'eliminated', observation: 'looked fine to me, honestly', evidence: ['trust me'] }, env!.clock), 'NOT_FOUND');
    expect(getHypothesis(env.db, id).status).toBe('testing');
    addCheckRun(env.db, 'chk-real', 'reports-tests');
    expect(recordExperimentResult(env.db, id, { outcome: 'eliminated', observation: '250 rows came back, so the limit is not applied early', evidence: ['chk-real'] }, env.clock).status).toBe('eliminated');
  });

  it('an inconclusive result needs no reference', () => {
    env = setup();
    const id = fresh(env);
    recordExperiment(env.db, id, { experiment: 'count rows on a 250 row fixture', expectedObservation: 'only 100 rows come back' }, env.clock);
    expect(recordExperimentResult(env.db, id, { outcome: 'inconclusive', observation: 'the fixture was too small to tell', evidence: [] }, env.clock).status).toBe('inconclusive');
  });
});

describe('amendment replay after a crash', () => {
  it('rebuildContract replays in the order amendments were applied, not the order they were proposed', async () => {
    env = setup();
    const run = (key: string, change: import('../../../src/contract/amendment-types.ts').AmendmentChange, base = env!.contract) =>
      runInquisition({
        trigger: trig({ kind: 'missing_outcomes', mode: 'clarify', key }),
        context: env!.ctx({}, { worker: workerOpts(env!), contract: base }),
        adapter: new ScriptedAdapter([{ structured: inquisitorOutput({ amendments: [{ change, evidence: 'reports.ts:40 paginates before export', reason: 'make the criterion testable' }] }) }]),
      });
    // Proposed first, approved last: the removal of AC-3 waits for a person.
    const removal = await run('rm', { op: 'remove_criterion', criterion_id: 'AC-3' });
    const pending = removal.amendments.pending[0]!;
    // Proposed second, applied at once: a proof entry for the criterion that is about to go.
    const addition = await run('add', { op: 'add_proof', criterion_id: 'AC-3', proof: ['A fixture with a thousand rows exports a thousand rows.'] });
    expect(addition.amendments.applied).toHaveLength(1);
    const yes = answerQuestion(env.db, env.runDir, `q-amd-${pending.id}`, 'Approve', 'alice', env.clock);
    const applied = applyApprovedAmendment(env.ctx({}, { contract: addition.contract }), pending.id, yes.decision.id);
    expect(applied.contract.acceptance_criteria.map((c) => c.id)).toEqual(['AC-1', 'AC-2']);
    expect(rebuildContract(env.contract, { db: env.db, runId: RUN, snapshot: env.snap })).toEqual(applied.contract);
  });
});

describe('a crash between applying amendments and persisting the contract', () => {
  const change: import('../../../src/contract/amendment-types.ts').AmendmentChange = { op: 'add_criterion', statement: 'The export filename contains the report name.', proof: ['A filename test asserts the report name appears in it.'], mandatory: false, ui: false, check_ids: [] };
  const output = () => inquisitorOutput({ amendments: [{ change, evidence: 'reports.ts:40 names downloads after the report', reason: 'make the naming testable' }] });
  const t = () => trig({ kind: 'missing_outcomes', mode: 'clarify', key: 'crash' });

  it('a re-run on the old contract still returns the amended one, instead of dropping the applied amendment', async () => {
    env = setup();
    const first = await runInquisition({ trigger: t(), context: env.ctx({}, { worker: workerOpts(env) }), adapter: new ScriptedAdapter([{ structured: output() }]) });
    expect(first.contract.acceptance_criteria.map((c) => c.id)).toEqual(['AC-1', 'AC-2', 'AC-3', 'AC-4']);
    // The controller died before persisting first.contract, so it hands back the base contract.
    const again = await runInquisition({ trigger: t(), context: env.ctx({}, { worker: workerOpts(env) }), adapter: new ScriptedAdapter([{ structured: output() }]) });
    expect(again.contract).toEqual(first.contract);
    expect(env.db.all("SELECT 1 FROM amendments WHERE status = 'applied'")).toHaveLength(1);
  });

  it('a re-run on the already persisted contract does not apply the amendment a second time', async () => {
    env = setup();
    const first = await runInquisition({ trigger: t(), context: env.ctx({}, { worker: workerOpts(env) }), adapter: new ScriptedAdapter([{ structured: output() }]) });
    const again = await runInquisition({ trigger: t(), context: env.ctx({}, { worker: workerOpts(env), contract: first.contract }), adapter: new ScriptedAdapter([{ structured: output() }]) });
    expect(again.contract).toEqual(first.contract);
    expect(again.contract.acceptance_criteria).toHaveLength(4);
  });

  it('retrying an approval after the crash returns the amended contract instead of failing', async () => {
    env = setup();
    const removal = await runInquisition({
      trigger: t(),
      context: env.ctx({}, { worker: workerOpts(env) }),
      adapter: new ScriptedAdapter([{ structured: inquisitorOutput({ amendments: [{ change: { op: 'remove_criterion', criterion_id: 'AC-3' }, evidence: 'AC-3 duplicates AC-2', reason: 'remove the duplicate' }] }) }]),
    });
    const pending = removal.amendments.pending[0]!;
    const yes = answerQuestion(env.db, env.runDir, `q-amd-${pending.id}`, 'Approve', 'alice', env.clock);
    const applied = applyApprovedAmendment(env.ctx(), pending.id, yes.decision.id);
    // Crash: the controller never persisted applied.contract and asks again with the base contract.
    const retried = applyApprovedAmendment(env.ctx(), pending.id, yes.decision.id);
    expect(retried.contract).toEqual(applied.contract);
    expect(retried.amendment).toMatchObject({ status: 'applied', approvedBy: yes.decision.id });
  });
});

describe('worker accounting', () => {
  it('a worker that timed out leaves a visible unmeasured-spend usage row, not silence', async () => {
    env = setup();
    const stuck = new ScriptedAdapter([{ structured: inquisitorOutput(), pendingPolls: 1_000_000 }]);
    await runInquisition({ trigger: trig({ subjects: ['AC-1'] }), context: env.ctx({}, { worker: workerOpts(env, { timeoutMs: 100, pollMs: 25 }) }), adapter: stuck });
    expect(env.db.all('SELECT cost_source, worker_id FROM usage WHERE run_id = ?', RUN)).toEqual([expect.objectContaining({ cost_source: 'unavailable' })]);
  });

  it('a result and its usage are recorded together: if usage cannot be written the worker stays unfinished for recovery to reconcile', async () => {
    env = setup();
    env.db.raw.exec("CREATE TRIGGER usage_full BEFORE INSERT ON usage BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    const adapter = new ScriptedAdapter([{ structured: inquisitorOutput({ mode: 'diagnose' }) }]);
    await expect(runInquisition({ trigger: trig(), context: env.ctx({}, { worker: workerOpts(env) }), adapter })).rejects.toThrow(/disk full/);
    const [w] = listWorkers(env.db, { runId: RUN });
    expect(w!.state).toBe('RUNNING');
    expect(w!.resultJson).toBeNull();
  });
});

describe('worker decisions', () => {
  const decision = (rationale: string) => ({ decision: 'Name the export file after the report', category: 'implementation-detail' as const, rationale, evidence: ['apps/web/reports/download.ts names downloads after the report title'], reversibility: 'reversible' as const });

  it('two inquiries that reach the same choice with different reasoning each record it instead of the second crashing', async () => {
    env = setup();
    const run = (key: string, rationale: string) =>
      runInquisition({ trigger: trig({ key }), context: env!.ctx({}, { worker: workerOpts(env!) }), adapter: new ScriptedAdapter([{ structured: inquisitorOutput({ autonomous_decisions: [decision(rationale)] }) }]) });
    const a = await run('d1', 'It matches the download name used by the on-screen report.');
    const b = await run('d2', 'Users already expect the report title in the filename.');
    expect(a.decisions).toHaveLength(1);
    expect(b.decisions).toHaveLength(1);
    expect(b.decisions[0]!.id).not.toBe(a.decisions[0]!.id);
    // Replaying the first inquiry still finds its own record rather than adding a third.
    const again = await run('d1', 'It matches the download name used by the on-screen report.');
    expect(again.decisions[0]!.id).toBe(a.decisions[0]!.id);
    expect(listDecisions(env.db, RUN).filter((d) => d.kind === 'inquisition.resolve')).toHaveLength(2);
  });

  it('a reversible choice the worker makes is pinned by a test obligation, like one the rules make', async () => {
    env = setup();
    const res = await runInquisition({ trigger: trig({ key: 'pin' }), context: env.ctx({}, { worker: workerOpts(env) }), adapter: new ScriptedAdapter([{ structured: inquisitorOutput({ autonomous_decisions: [decision('It matches the on-screen report.')] }) }]) });
    expect(res.experiments).toEqual([expect.objectContaining({ kind: 'pin-test', description: expect.stringContaining('Name the export file after the report') })]);
  });
});

describe('hypothesis novelty edge cases', () => {
  const prior = (statement: string, over: Partial<import('../../../src/inquisition/hypotheses.ts').PriorHypothesis> = {}) => ({ id: 'hyp-1', statement, fingerprint: 'fp', experiment: null, expectedObservation: null, status: 'eliminated' as const, ...over });

  it('short statements that differ in the one word that matters are different causes', () => {
    expect(isNewHypothesis({ statement: 'Timeout is too short', fingerprint: 'fp' }, [prior('Timeout is too long')]).kind).toBe('new');
    expect(isNewHypothesis({ statement: 'Cache returns fresh data', fingerprint: 'fp' }, [prior('Cache returns stale data')]).kind).toBe('new');
    expect(
      isNewHypothesis(
        { statement: 'Parser drops quotes', fingerprint: 'fp', experiment: 'Feed a quoted field and print the tokens', expectedObservation: 'The quote is missing from the tokens' },
        [prior('Parser drops commas', { experiment: 'Feed a comma field and print the tokens', expectedObservation: 'The comma is missing from the tokens' })],
      ).kind,
    ).toBe('new');
  });

  it('but a short statement reworded without changing its words is still a duplicate', () => {
    expect(isNewHypothesis({ statement: 'The timeout is too short.', fingerprint: 'fp' }, [prior('Timeouts are too short')]).kind).toBe('duplicate');
    expect(isNewHypothesis({ statement: 'Timeout too short', fingerprint: 'fp' }, [prior('The timeout is too short')]).kind).toBe('duplicate');
  });

  it('a statement that names no cause is neither new nor storable', () => {
    env = setup();
    expect(isNewHypothesis({ statement: 'It is the problem, I think, maybe.', fingerprint: 'fp-page' }, []).isNew).toBe(false);
    expectCode(() => proposeHypothesis(env!.db, RUN, { statement: 'It is the problem, I think, maybe.', fingerprint: 'fp-page' }, env!.clock), 'SCHEMA_INVALID');
    // Two different empty-of-content rewordings must not each count as new either.
    expect(isNewHypothesis({ statement: 'Probably just the bug again.', fingerprint: 'fp-page' }, [{ id: 'hyp-1', statement: 'It is the problem.', fingerprint: 'fp-page', experiment: null, expectedObservation: null, status: 'eliminated' }]).isNew).toBe(false);
  });
});

describe('risk heuristics cover the everyday spellings', () => {
  it.each([
    ['security', 'adds a login redirect for expired sessions'],
    ['security', 'grants extra privileges to the export role'],
    ['privacy', 'sends analytics events with the visitor ip address'],
    ['billing', 'applies a per-seat fee over the quota'],
    ['data', 'runs ALTER TABLE reports DROP COLUMN legacy_flag'],
  ])('%s: %s', (category, text) => {
    expect(riskCategoriesInText(text)).toContain(category);
  });

  it('plain export work is not flagged', () => {
    expect(riskCategoriesInText('escape commas and quotes in the exported CSV values and keep the column order')).toEqual([]);
  });
});

describe('corrupt rows are errors, not empty answers', () => {
  it('an unreadable contract on the run row stops trigger detection instead of reporting no triggers', () => {
    env = setup();
    env.db.run("UPDATE runs SET contract_json = '{not json' WHERE id = ?", RUN);
    expectCode(() => loadInquisitionSnapshot(env!.db, RUN), 'CONTRACT_INVALID');
  });

  it('an unreadable evidence report stops detection instead of reading as a report with no checks', () => {
    env = setup();
    addEvidence(env.db, { verdict: 'PASS' });
    env.db.run("UPDATE evidence_reports SET report_json = 'garbage'");
    expectCode(() => loadInquisitionSnapshot(env!.db, RUN), 'INTERNAL');
  });

  it('a question whose blocked-work column is unreadable would stop blocking anything, so reading it fails', () => {
    env = setup();
    const q = persistQuestion(env.db, RUN, 'clarify', goodQuestion(), env.clock).question;
    env.db.run("UPDATE questions SET affected_json = 'oops' WHERE id = ?", q.id);
    expectCode(() => listQuestions(env!.db, RUN), 'INTERNAL');
    env.db.run("UPDATE questions SET affected_json = NULL, options_json = 'oops' WHERE id = ?", q.id);
    expectCode(() => listQuestions(env!.db, RUN), 'INTERNAL');
  });
});

describe('repair brief protected tests', () => {
  const ctx = { policyCheckIds: ['lint', 'typecheck', 'reports-tests', 'build'], protectedTests: ['tests/reports/export.test.ts'], expectedFingerprint: 'fp-page' };
  const brief = (constraints: string[]) => ({
    fingerprint: 'fp-page',
    evidence: ['reports-tests failed: expected 250 rows, received 100 (log reports-tests.log line 42)'],
    hypotheses: [{ statement: 'The export query applies the page limit before the filter.', supporting: 'The generated SQL in the log shows LIMIT 100 before the WHERE clause.' }],
    experiment: 'Run the export on a fixture with 250 matching rows and print the generated SQL.',
    expected_observation: 'The SQL shows LIMIT before WHERE and only 100 rows are returned.',
    scoped_fix: 'Move the limit clause after the filter in buildExportQuery in apps/api/reports.ts.',
    post_fix_checks: ['reports-tests'],
    preserved_constraints: constraints,
  });

  it('names the protected test even when a sentence ends right after it', () => {
    expect(validateRepairBrief(brief(['Do not edit tests/reports/export.test.ts.', 'The on-screen report keeps its page size.']), ctx).problems).toEqual([]);
    expect(validateRepairBrief(brief(['Keep the file tests/reports/export.test.ts: it must pass unchanged', 'The on-screen report keeps its page size.']), ctx).problems).toEqual([]);
  });

  it('still refuses a constraint that only resembles the protected path', () => {
    expect(validateRepairBrief(brief(['Do not edit tests/reports/export.test.ts.bak', 'The on-screen report keeps its page size.']), ctx).problems.join()).toContain('protected test tests/reports/export.test.ts');
    expect(validateRepairBrief(brief(['Do not edit export.test.ts please', 'The on-screen report keeps its page size.']), ctx).problems.join()).toContain('protected test');
  });
});

describe('repeated failure ignores failures that are not repair attempts', () => {
  it('a pre-existing baseline failure plus one candidate failure is not a repeat', () => {
    env = setup();
    addFailure(env.db, 'fp-a', null, 'AssertionError: already failing on the base tree', 'baseline');
    addFailure(env.db, 'fp-a', 'cand-1');
    expect(detectTriggers(loadInquisitionSnapshot(env.db, RUN)).filter((t) => t.kind === 'repeated_failure')).toEqual([]);
  });

  it('install failures are environment, not repeated implementation failures', () => {
    env = setup();
    addFailure(env.db, 'fp-npm', null, 'npm ERR! network', 'install');
    addFailure(env.db, 'fp-npm', null, 'npm ERR! network', 'install');
    expect(detectTriggers(loadInquisitionSnapshot(env.db, RUN)).filter((t) => t.kind === 'repeated_failure')).toEqual([]);
  });

  it('baseline rows do not inflate the count of real candidate failures', () => {
    env = setup();
    addFailure(env.db, 'fp-a', null, 'already failing', 'baseline');
    addFailure(env.db, 'fp-a', 'cand-1');
    addFailure(env.db, 'fp-a', 'cand-2');
    const [t] = detectTriggers(loadInquisitionSnapshot(env.db, RUN)).filter((x) => x.kind === 'repeated_failure');
    expect(t!.summary).toContain('2 times');
    expect(t!.key).toBe('repeated_failure:fp-a:2');
  });
});
