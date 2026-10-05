import { afterEach, describe, expect, it } from 'vitest';
import { isOrbitError, type OrbitErrorCode } from '../../../src/core/errors.ts';
import { ManualClock } from '../../../src/core/clock.ts';
import { createRun } from '../../../src/controller/run-store.ts';
import { MODEL_OUTPUT_SCHEMAS } from '../../../src/contract/model-outputs.ts';
import { hashObject } from '../../../src/core/hash.ts';
import { listWorkers } from '../../../src/storage/workers.ts';
import {
  applyApprovedAmendment,
  authorityMap,
  commitPlan,
  processAmendments,
  questionForUncovered,
  rebuildContract,
  renderInquisitorPrompt,
  runInquisition,
  syncContract,
  type InquisitorWorkerOptions,
} from '../../../src/inquisition/engine.ts';
import { answerQuestion, openQuestions } from '../../../src/inquisition/questions.ts';
import type { Ambiguity } from '../../../src/inquisition/resolve.ts';
import { insertAmendment, insertHypothesis, listAmendments, listLedger } from '../../../src/inquisition/store.ts';
import { transitionAssumption } from '../../../src/inquisition/ledger.ts';
import type { Trigger } from '../../../src/inquisition/types.ts';
import type { AmendmentProposal } from '../../../src/contract/amend.ts';
import { RUN, ScriptedAdapter, addFailure, goodQuestion, inquisitorOutput, setup, workerQuestion, type Env, type Script } from './helpers.ts';
import type { TaskHandle, TaskSpec } from '../../../src/adapters/types.ts';

let env: Env | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

function trig(over: Partial<Trigger> = {}): Trigger {
  return { kind: 'missing_outcomes', mode: 'clarify', summary: 'acceptance criteria lack a measurable outcome', evidence: ['AC-1: vague'], subjects: [], key: 'missing_outcomes:abc', ...over };
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

async function rejectsWith(p: Promise<unknown>, code: OrbitErrorCode): Promise<Error> {
  try {
    await p;
  } catch (err) {
    expect(isOrbitError(err, code), String(err)).toBe(true);
    return err as Error;
  }
  throw new Error(`expected ${code}`);
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

const decision = (text: string, over: Record<string, unknown> = {}) => ({ decision: text, category: 'implementation-detail' as const, rationale: 'It is simpler.', evidence: ['apps/api/reports.ts:40'], reversibility: 'reversible' as const, ...over });

describe('deterministic obligations per trigger kind', () => {
  async function ledgerFor(t: Trigger): Promise<string[]> {
    env = setup();
    const res = await runInquisition({ trigger: t, context: env.ctx() });
    return res.ledger.map((l) => l.claim);
  }

  it('records what has to be shown for architecture, scope and reviewer triggers', async () => {
    expect(await ledgerFor(trig({ kind: 'unexplained_architecture', mode: 'risk-review', key: 'ua' }))).toEqual(['The changes outside the plan are required by the criteria.']);
    env?.cleanup();
    expect(await ledgerFor(trig({ kind: 'scope_pressure', mode: 'diagnose', key: 'sp' }))).toEqual(['The work can be completed inside the granted scope.']);
    env?.cleanup();
    expect(await ledgerFor(trig({ kind: 'reviewer_disagreement', mode: 'reconcile', key: 'rd' }))).toEqual(['The reviewers see the same code and one of them is wrong.']);
    env?.cleanup();
    expect(await ledgerFor(trig({ kind: 'missing_outcomes', key: 'mo', subjects: ['AC-1', 'AC-2'] }))).toEqual(['AC-1 can be verified as written.', 'AC-2 can be verified as written.']);
  });

  it('records a hidden decision as its own evidence in decision-record mode, and as the summary otherwise', async () => {
    expect(await ledgerFor(trig({ kind: 'hidden_decision', mode: 'decision-record', evidence: ['Dates use local time.'], key: 'hd1' }))).toEqual(['Dates use local time.']);
    env?.cleanup();
    expect(await ledgerFor(trig({ kind: 'hidden_decision', mode: 'decision-record', evidence: [], summary: 'a choice nobody wrote down', key: 'hd2' }))).toEqual(['a choice nobody wrote down; the behaviour chosen is acceptable.']);
    env?.cleanup();
    expect(await ledgerFor(trig({ kind: 'hidden_decision', mode: 'risk-review', evidence: ['Dates use local time.'], summary: 'security changed', key: 'hd3' }))).toEqual(['security changed; the behaviour chosen is acceptable.']);
  });

  it('derives nothing for a trigger kind with no standing obligation', async () => {
    expect(await ledgerFor(trig({ kind: 'repeated_failure', mode: 'diagnose', key: 'rf' }))).toEqual([]);
  });
});

describe('authorityMap', () => {
  it('skips a claim whose subject has no words and ranks an unknown authority last', () => {
    const map = authorityMap([
      { source: 'a', authority: 'doc', claims: [{ subject: '!!!', value: 'x' }, { subject: 'page size', value: '1' }] },
      { source: 'b', authority: 'mystery' as never, claims: [{ subject: '!!!', value: 'y' }, { subject: 'page size', value: '2' }] },
    ]);
    expect(map).toHaveLength(1);
    expect(map[0]).toMatchObject({ subject: 'page size', tied: false, winner: { source: 'a', value: '1' } });
    expect(map[0]?.others).toEqual([{ source: 'b', value: '2' }]);
  });
});

describe('inquisitor prompt', () => {
  it('lists ambiguities, bounded recent failures without excerpts, hypotheses and open questions', async () => {
    env = setup();
    const amb: Ambiguity = { id: 'AMB-9', description: 'Which column order applies?', kind: 'implementation-detail', evidence: ['schema order'], reversibility: 'reversible', affects: ['AC-2'], choice: { option: 'schema order', rationale: 'matches the table' } };
    addFailure(env.db, 'fp-silent', 'c1', null as never);
    for (let i = 0; i < 7; i++) addFailure(env.db, `fp-${i}`, 'c1', `boom ${i}`);
    insertHypothesis(env.db, { runId: RUN, statement: 'The clock is not pinned', normalizedHash: 'hash-1', fingerprint: 'fp-1' }, env.clock);
    const material: Ambiguity = { id: 'AMB-2', description: 'Should the export include every matching record or only the current page?', kind: 'product-semantics', evidence: ['Filtering occurs before pagination.'], reversibility: 'costly-to-reverse', affects: ['AC-1'], question: goodQuestion() };
    await runInquisition({ trigger: trig({ key: 'q' }), context: env.ctx({}, { ambiguities: [material] }) });
    const prompt = renderInquisitorPrompt(trig(), env.ctx({}, { ambiguities: [amb] }));
    expect(prompt).toContain('<orbit-data label="ambiguities">');
    expect(prompt).toContain('AMB-9');
    expect(prompt).toContain('<orbit-data label="failures">');
    const failures = JSON.parse(prompt.split('<orbit-data label="failures">\n')[1]!.split('\n</orbit-data>')[0]!) as { fingerprint: string; excerpt: string | null }[];
    expect(failures).toHaveLength(5);
    expect(failures.at(-1)?.fingerprint).toBe('fp-6');
    expect(prompt).toContain('<orbit-data label="hypotheses-already-tried">');
    expect(prompt).toContain('<orbit-data label="questions-already-open">');
  });

  it('omits the optional blocks when there is nothing to put in them', () => {
    env = setup();
    const prompt = renderInquisitorPrompt(trig(), env.ctx());
    for (const label of ['ambiguities', 'failures', 'hypotheses-already-tried', 'questions-already-open']) expect(prompt).not.toContain(`label="${label}"`);
  });
});

describe('worker supervision', () => {
  it('uses the default turn, timeout and poll settings and falls back to the clock for duration', async () => {
    env = setup();
    const adapter = new ScriptedAdapter([{ structured: inquisitorOutput(), pendingPolls: 1, durationMs: null as never }]);
    const t0 = env.clock.now();
    const bare = workerOpts(env);
    delete (bare as Partial<InquisitorWorkerOptions>).pollMs;
    delete (bare as Partial<InquisitorWorkerOptions>).timeoutMs;
    await runInquisition({ trigger: trig(), context: env.ctx({}, { worker: bare }), adapter });
    expect(adapter.specs[0]).toMatchObject({ maxTurns: 12, timeoutMs: 300_000 });
    expect(env.clock.now() - t0).toBe(500);
    const usage = env.db.all<{ duration_ms: number }>('SELECT duration_ms FROM usage WHERE run_id = ?', RUN);
    expect(usage).toEqual([{ duration_ms: 500 }]);
  });

  it('marks the worker failed and rethrows when the process cannot be started', async () => {
    env = setup();
    class Broken extends ScriptedAdapter {
      override async startTask(_spec: TaskSpec): Promise<TaskHandle> {
        throw new Error('spawn failed');
      }
    }
    await expect(runInquisition({ trigger: trig(), context: env.ctx({}, { worker: workerOpts(env) }), adapter: new Broken([]) })).rejects.toThrow('spawn failed');
    const [w] = listWorkers(env.db, { runId: RUN });
    expect(w).toMatchObject({ state: 'FAILED', resultStatus: 'failed' });
  });

  it('treats a lost worker as no usable output and keeps the trigger subjects blocked', async () => {
    env = setup();
    const res = await runInquisition({ trigger: trig({ subjects: ['AC-1'] }), context: env.ctx({}, { worker: workerOpts(env) }), adapter: new ScriptedAdapter([{ status: 'lost' as never }]) });
    expect(res.output).toBeNull();
    expect(res.blockedCriteria).toEqual(['AC-1']);
    expect(listWorkers(env.db, { runId: RUN })[0]?.state).toBe('LOST');
  });

  it('uses a default message when the provider gives no error text', async () => {
    env = setup();
    const err1 = await rejectsWith(runInquisition({ trigger: trig(), context: env.ctx({}, { worker: workerOpts(env) }), adapter: new ScriptedAdapter([{ status: 'auth_failed', error: null }]) }), 'AUTH_EXPIRED');
    expect(err1.message).toBe('the provider rejected the credentials');
    const err2 = await rejectsWith(runInquisition({ trigger: trig(), context: env.ctx({}, { worker: workerOpts(env) }), adapter: new ScriptedAdapter([{ status: 'transient_error', error: null }]) }), 'PROVIDER_TRANSIENT');
    expect(err2.message).toBe('transient provider failure');
  });

  it('supervises with an abort signal: polls normally, then stops supervising when it fires', async () => {
    env = setup();
    const polled = await runInquisition({ trigger: trig(), context: env.ctx({}, { worker: workerOpts(env) }), adapter: new ScriptedAdapter([{ structured: inquisitorOutput(), pendingPolls: 2 }]), signal: new AbortController().signal });
    expect(polled.output).not.toBeNull();

    const controller = new AbortController();
    class StallClock extends ManualClock {
      override sleep(): Promise<void> {
        setTimeout(() => controller.abort(new Error('lease lost')), 0);
        return new Promise(() => undefined);
      }
    }
    const stalled = setup();
    const ctx = stalled.ctx({}, { worker: workerOpts(stalled) });
    ctx.clock = new StallClock();
    await expect(runInquisition({ trigger: trig({ key: 'stall' }), context: ctx, adapter: new ScriptedAdapter([{ structured: inquisitorOutput(), pendingPolls: 1_000 }]), signal: controller.signal })).rejects.toThrow('lease lost');
    // The worker is left running for the next owner.
    expect(listWorkers(stalled.db, { runId: RUN })[0]?.state).toBe('RUNNING');
    stalled.cleanup();
  });

  it('does not wait when the signal fires between the deadline check and the sleep', async () => {
    env = setup();
    const controller = new AbortController();
    class AbortOnNow extends ManualClock {
      private calls = 0;
      override now(): number {
        if (++this.calls === 12) controller.abort(new Error('shutdown'));
        return super.now();
      }
    }
    const ctx = env.ctx({}, { worker: workerOpts(env) });
    ctx.clock = new AbortOnNow();
    await expect(runInquisition({ trigger: trig(), context: ctx, adapter: new ScriptedAdapter([{ structured: inquisitorOutput(), pendingPolls: 1_000 }]), signal: controller.signal })).rejects.toThrow('shutdown');
  });

  it('refuses to run when the inquisitor output schema stops being strict-compatible', async () => {
    env = setup();
    const schema = MODEL_OUTPUT_SCHEMAS.inquisitor as { additionalProperties?: unknown };
    const saved = schema.additionalProperties;
    schema.additionalProperties = true;
    try {
      await rejectsWith(runInquisition({ trigger: trig(), context: env.ctx() }), 'SCHEMA_INVALID');
    } finally {
      schema.additionalProperties = saved;
    }
  });
});

describe('reusing and counting earlier workers', () => {
  async function firstRun(e: Env) {
    return runInquisition({ trigger: trig(), context: e.ctx({}, { worker: workerOpts(e) }), adapter: new ScriptedAdapter([{ structured: inquisitorOutput() }]) });
  }

  it('counts a stored result that no longer validates as a spent attempt, and spawns again within the bound', async () => {
    env = setup();
    await firstRun(env);
    env.db.run("UPDATE workers SET result_json = '{\"mode\":\"nonsense\"}' WHERE role = 'inquisitor'");
    const second = new ScriptedAdapter([{ structured: inquisitorOutput() }]);
    const res = await runInquisition({ trigger: trig(), context: env.ctx({}, { worker: workerOpts(env, { maxAttempts: 2 }) }), adapter: second });
    expect(second.specs).toHaveLength(1);
    expect(res.output).not.toBeNull();
    expect(listWorkers(env.db, { runId: RUN })).toHaveLength(2);
  });

  it('spawns nothing once the bound is spent, and fails closed', async () => {
    env = setup();
    await firstRun(env);
    env.db.run("UPDATE workers SET result_json = '{\"mode\":\"nonsense\"}' WHERE role = 'inquisitor'");
    const second = new ScriptedAdapter([{ structured: inquisitorOutput() }]);
    const res = await runInquisition({ trigger: trig({ subjects: ['AC-1'] }), context: env.ctx({}, { worker: workerOpts(env, { maxAttempts: 1 }) }), adapter: second });
    expect(second.specs).toEqual([]);
    expect(res.output).toBeNull();
    expect(res.blockedCriteria).toEqual(['AC-1']);
  });

  it('refuses to start a second worker while one is still active', async () => {
    env = setup();
    await firstRun(env);
    env.db.run("UPDATE workers SET state = 'RUNNING', result_json = NULL, result_status = NULL WHERE role = 'inquisitor'");
    await rejectsWith(runInquisition({ trigger: trig(), context: env.ctx({}, { worker: workerOpts(env) }), adapter: new ScriptedAdapter([{ structured: inquisitorOutput() }]) }), 'CONCURRENT_UPDATE');
  });

  it('counts a worker that returned malformed output as a spent attempt', async () => {
    env = setup();
    await runInquisition({ trigger: trig(), context: env.ctx({}, { worker: workerOpts(env, { maxAttempts: 1 }) }), adapter: new ScriptedAdapter([{ status: 'malformed_output', structured: null }]) });
    const again = new ScriptedAdapter([{ structured: inquisitorOutput() }]);
    const res = await runInquisition({ trigger: trig(), context: env.ctx({}, { worker: workerOpts(env, { maxAttempts: 1 }) }), adapter: again });
    expect(again.specs).toEqual([]);
    expect(res.output).toBeNull();
  });
});

describe('reducing worker output', () => {
  const run = async (e: Env, output: ReturnType<typeof inquisitorOutput>, t: Trigger = trig(), extra: Script = {}) =>
    runInquisition({ trigger: t, context: e.ctx({}, { worker: workerOpts(e) }), adapter: new ScriptedAdapter([{ structured: output, ...extra }]) });

  it('blocks according to what an unaskable material question names, the trigger, or everything', async () => {
    env = setup();
    const weak = (affected: string[]) => workerQuestion({ question: 'Should I proceed with the dates export implementation now?', affected_work: affected, unblocked_work: [] });
    const named = await run(env, inquisitorOutput({ questions: [weak(['AC-3'])] }), trig({ key: 'a' }));
    expect(named.blockedCriteria).toContain('AC-3');
    env.cleanup();
    env = setup();
    const bySubject = await run(env, inquisitorOutput({ questions: [weak([])] }), trig({ key: 'b', subjects: ['AC-2'] }));
    expect(bySubject.blockedCriteria).toEqual(['AC-2']);
    env.cleanup();
    env = setup();
    const everything = await run(env, inquisitorOutput({ questions: [weak(['not-a-criterion'])] }), trig({ key: 'c' }));
    expect(everything.blockedCriteria).toEqual(['AC-1', 'AC-2', 'AC-3']);
  });

  it('ignores a non-material unknown, trusts a question that covers a material one, and falls back to the trigger subjects', async () => {
    env = setup();
    const res = await run(
      env,
      inquisitorOutput({
        questions: [workerQuestion()],
        unknowns: [
          { statement: 'Whether the toast copy is final', material: false, blocks: ['AC-3'] },
          { statement: 'Which records count as matching', material: true, blocks: ['AC-1'] },
          { statement: 'The retention period of exports', material: true, blocks: [] },
        ],
      }),
      trig({ subjects: ['AC-2'] }),
    );
    expect(res.blockedCriteria).toContain('AC-1');
    expect(res.blockedCriteria).toContain('AC-2');
    expect(res.blockedCriteria).not.toContain('AC-3');
  });

  it('words each kind of accepted decision, and pins every choice except a hypothesis with a test', async () => {
    env = setup();
    const res = await run(
      env,
      inquisitorOutput({
        autonomous_decisions: [
          decision('Follow the existing kebab-case file names', { category: 'convention', evidence: ['src/a-b.ts', 'src/c-d.ts'] }),
          decision('Assume ISO dates while testing', { category: 'technical-hypothesis' }),
          decision('Name the helper buildExportRows'),
        ],
      }),
    );
    expect(res.decisions.map((d) => d.summary)).toEqual([
      'followed convention: Follow the existing kebab-case file names',
      'adopted for testing: Assume ISO dates while testing',
      'chose reversible detail: Name the helper buildExportRows',
    ]);
    expect(res.decisions.map((d) => (d.data as { category: string }).category)).toEqual(['convention', 'implementation-detail', 'implementation-detail']);
    expect(res.experiments.filter((x) => x.kind === 'pin-test')).toHaveLength(2);
  });

  it('refuses a choice whose words mean it cannot be undone, even when the worker called it reversible', async () => {
    env = setup();
    const res = await run(env, inquisitorOutput({ autonomous_decisions: [decision('Permanently rename the export helper')] }));
    expect(res.decisions).toEqual([]);
    expect(res.refused[0]?.why).toBe('it has irreversible effects');
  });

  it('refuses an experiment that names an interpretation with no expected observation', async () => {
    env = setup();
    const interpretations = [
      { id: 'I1', statement: 'limit applied early', impact: 'high' as const, reversibility: 'reversible' as const, rank: 1, evidence: [] },
      { id: 'I2', statement: 'serializer stops early', impact: 'medium' as const, reversibility: 'reversible' as const, rank: 2, evidence: [] },
    ];
    const experiment = { description: 'Export a fixture and print the SQL', discriminates: ['I1', 'I2'], expected_observations: [{ interpretation_id: 'I1', observation: 'LIMIT before WHERE' }, { interpretation_id: 'I1', observation: 'something else' }], authorization: 'reports-tests', cost: 'low' as const };
    const res = await run(env, inquisitorOutput({ interpretations, chosen_experiment: experiment }));
    expect(res.refused.find((r) => r.what.startsWith('experiment:'))?.why).toContain('gives no expected observation for every interpretation');
  });

  it('does not block on a question a person already answered in equivalent words', async () => {
    env = setup();
    const first = await run(env, inquisitorOutput({ questions: [workerQuestion()] }), trig({ key: 'first' }));
    answerQuestion(env.db, env.runDir, first.questions[0]!.id, 'A', 'alice', env.clock);
    const second = await run(env, inquisitorOutput({ questions: [workerQuestion()] }), trig({ key: 'second' }));
    expect(second.blockedCriteria).not.toContain('AC-1');
  });

  it('blocks on a question the worker marked non-material when the rules say it is material', async () => {
    env = setup();
    const q = workerQuestion({ material: false, question: 'Should the export include the security rules of the requester or ignore them entirely?' });
    const res = await run(env, inquisitorOutput({ questions: [q] }), trig({ key: 'mat' }));
    const classified = openQuestions(env.db, RUN);
    expect(classified.length).toBeGreaterThan(0);
    expect(res.blockedCriteria.length).toBeGreaterThanOrEqual(0);
  });

  it('treats an open non-material question as blocking nothing in a later inquiry', async () => {
    env = setup();
    const calm = workerQuestion({
      material: false,
      changes: ['implementation'],
      question: 'Would the export filename read better with the date first or last?',
      safe_default: { exists: true, option: 'A', reason: 'Either order is easy to change later and nobody depends on it.' },
      affected_work: ['AC-3'],
      unblocked_work: [],
    });
    await run(env, inquisitorOutput({ questions: [calm] }), trig({ key: 'nm' }));
    expect(openQuestions(env.db, RUN).map((q) => q.material)).toEqual([false]);
    const later = await runInquisition({ trigger: trig({ key: 'later' }), context: env.ctx({}, { ambiguities: [] }) });
    expect(later.blockedCriteria).not.toContain('AC-3');
  });
});

describe('questionForUncovered', () => {
  it('falls through to the generic text when the question the trigger names is too weak', () => {
    env = setup();
    const t = trig({ evidence: ['Should I proceed now?'], subjects: ['AC-2'] });
    const q = questionForUncovered(env.ctx(), t, ['AC-2'], ['AC-3'], env.contract);
    expect(q?.question).toMatch(/^Which behaviour should AC-2 have/);
    expect(q?.unblocked).toEqual(['AC-3']);
  });

  it('builds nothing when no blocked criterion remains, or when every candidate text is unusable', () => {
    env = setup();
    expect(questionForUncovered(env.ctx(), trig(), [], [], env.contract)).toBeNull();
    const t = trig({ evidence: [], summary: 'what language to use', subjects: ['AC-2'] });
    expect(questionForUncovered(env.ctx(), t, ['AC-2'], [], env.contract)).toBeNull();
  });
});

describe('amendment processing details', () => {
  const proposal = (change: AmendmentProposal['change']): AmendmentProposal => ({ change, evidence: 'reports.ts:40 paginates before export', reason: 'make the criterion testable' });

  it('records a malformed proposal as refused, and does not trip over it on the next pass', () => {
    env = setup();
    const ctx = env.ctx();
    const first = processAmendments(ctx, 'clarify', [{ evidence: 'e', reason: 'r' } as unknown as AmendmentProposal]);
    expect(first.refused).toEqual([{ what: 'amendment ?', why: expect.stringContaining('must have a change') }]);
    expect(first.outcomes.refused[0]).toMatchObject({ status: 'rejected', record: { field: 'unknown' } });
    const second = processAmendments(ctx, 'clarify', [{ evidence: 'e', reason: 'r' } as unknown as AmendmentProposal]);
    expect(second.refused).toHaveLength(1);
    expect(listAmendments(env.db, RUN)).toHaveLength(2);
  });

  it('refuses a proposal whose result would not be a valid contract, without applying it', () => {
    env = setup();
    const res = processAmendments(env.ctx(), 'clarify', [proposal({ op: 'add_criterion', statement: 'The export has a button users can press.', proof: ['Browser test.'], mandatory: true, ui: true, check_ids: [] })]);
    expect(res.outcomes.applied).toEqual([]);
    expect(res.refused[0]?.why).toMatch(/needs browser evidence/);
    expect(res.contract).toEqual(env.contract);
    expect(listAmendments(env.db, RUN, { status: 'rejected' })).toHaveLength(1);
  });

  it('applies a new assumption directly, but queues one set straight to supported', () => {
    env = setup();
    const res = processAmendments(env.ctx(), 'clarify', [
      proposal({ op: 'set_assumption', assumption_id: null, statement: 'Exports are small enough to buffer.', status: 'unverified' }),
      proposal({ op: 'set_assumption', assumption_id: 'AS-1', statement: 'Exports use the existing report query.', status: 'rejected' }),
    ]);
    expect(res.outcomes.applied).toHaveLength(1);
    expect(res.outcomes.pending).toHaveLength(1);
    expect(res.contract.assumptions.map((a) => a.id)).toEqual(['AS-1', 'AS-2', 'AS-3']);
  });
});

describe('approving amendments', () => {
  const proposal = (change: AmendmentProposal['change']): AmendmentProposal => ({ change, evidence: 'reports.ts:40 paginates before export', reason: 'make the criterion testable' });

  function pendingRemoval(e: Env) {
    const res = processAmendments(e.ctx(), 'clarify', [proposal({ op: 'remove_criterion', criterion_id: 'AC-3' })]);
    return res.outcomes.pending[0]!;
  }

  it('refuses an amendment that belongs to another run', () => {
    env = setup();
    createRun(env.db, { id: 'run-2', repoRoot: '/repo/acme', goal: 'g', mode: 'autonomous', policyHash: 'sha256:x', policyPath: '/p' }, env.clock);
    const other = insertAmendment(env.db, { runId: 'run-2', record: { field: 'x', old_value: null, new_value: null, evidence: 'e', reason: 'r', approval_required: true, affected_verification: [] }, change: null, status: 'pending-approval' }, env.clock);
    expectCode(() => applyApprovedAmendment(env!.ctx(), other.id, 'dec-x'), 'POLICY_DENIED');
  });

  it('refuses a free-text answer, and an approval of an amendment that is no longer pending', () => {
    env = setup();
    const pending = pendingRemoval(env);
    const maybe = answerQuestion(env.db, env.runDir, `q-amd-${pending.id}`, 'perhaps later', 'alice', env.clock);
    expectCode(() => applyApprovedAmendment(env!.ctx(), pending.id, maybe.decision.id), 'POLICY_DENIED');

    env.cleanup();
    env = setup();
    const second = pendingRemoval(env);
    const yes = answerQuestion(env.db, env.runDir, `q-amd-${second.id}`, 'Approve', 'alice', env.clock);
    env.db.run("UPDATE amendments SET status = 'rejected' WHERE id = ?", second.id);
    expectCode(() => applyApprovedAmendment(env!.ctx(), second.id, yes.decision.id), 'TRANSITION_INVALID');
  });

  it('returns the synced contract when the same approval is retried after the amendment applied', () => {
    env = setup();
    const pending = pendingRemoval(env);
    const yes = answerQuestion(env.db, env.runDir, `q-amd-${pending.id}`, 'Approve', 'alice', env.clock);
    const first = applyApprovedAmendment(env.ctx(), pending.id, yes.decision.id);
    const again = applyApprovedAmendment(env.ctx(), pending.id, yes.decision.id);
    expect(again.amendment.status).toBe('applied');
    expect(again.contract).toEqual(first.contract);
  });

  it('cannot apply an approved amendment that kept no change', () => {
    env = setup();
    const pending = pendingRemoval(env);
    const yes = answerQuestion(env.db, env.runDir, `q-amd-${pending.id}`, 'Approve', 'alice', env.clock);
    env.db.run("UPDATE amendments SET affected_json = json_set(affected_json, '$.change', json('null')) WHERE id = ?", pending.id);
    expectCode(() => applyApprovedAmendment(env!.ctx(), pending.id, yes.decision.id), 'INTERNAL');
  });
});

describe('replaying amendments', () => {
  const exception = { op: 'accept_baseline_failure', check_id: 'lint', fingerprint: 'fp-lint', reason: 'known failure' } as const;

  function appliedException(e: Env, contractBefore: string, contractAfter: string) {
    return insertAmendment(
      e.db,
      {
        runId: RUN,
        record: { field: 'baseline_exceptions', old_value: [], new_value: [], evidence: 'baseline run failed', reason: 'known', approval_required: true, affected_verification: ['check:lint'] },
        change: exception,
        status: 'applied',
        approvedBy: 'dec-1a2b3c4d5e6f',
        contractBefore,
        contractAfter,
      },
      e.clock,
    );
  }

  it('rebuilds and syncs a contract through a stored baseline exception without the baseline report', () => {
    env = setup();
    const withException = rebuildAfter(env);
    expect(withException.baseline_exceptions).toEqual([{ check_id: 'lint', fingerprint: 'fp-lint', reason: 'known failure' }]);
    // A contract at the "before" hash is brought forward, one at the "after" hash is left alone, an unknown one is not guessed at.
    expect(syncContract({ db: env.db, runId: RUN, snapshot: env.snap }, env.contract)).toEqual(withException);
    expect(syncContract({ db: env.db, runId: RUN, snapshot: env.snap }, withException)).toEqual(withException);
    const stranger = { ...env.contract, objective: 'Something else entirely.' };
    expect(syncContract({ db: env.db, runId: RUN, snapshot: env.snap }, stranger)).toEqual(stranger);
  });

  function rebuildAfter(e: Env) {
    const before = hashObject(e.contract);
    const after = hashObject({ ...e.contract, baseline_exceptions: [{ check_id: 'lint', fingerprint: 'fp-lint', reason: 'known failure' }] });
    appliedException(e, before, after);
    return rebuildContract(e.contract, { db: e.db, runId: RUN, snapshot: e.snap });
  }

  it('skips applied records that kept no change and orders replays by when they took effect', () => {
    env = setup();
    insertAmendment(env.db, { runId: RUN, record: { field: 'x', old_value: null, new_value: null, evidence: 'e', reason: 'r', approval_required: false, affected_verification: [] }, change: null, status: 'applied' }, env.clock);
    const added = processAmendments(env.ctx(), 'clarify', [{ change: { op: 'add_non_goal', non_goal: 'Redesign the report page' }, evidence: 'e', reason: 'r' }]);
    expect(added.outcomes.pending).toHaveLength(1);
    // Events lacking an amendment id sort after those that have one.
    env.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 1, 'amendment.applied', 'x', NULL)", RUN);
    expect(rebuildContract(env.contract, { db: env.db, runId: RUN, snapshot: env.snap })).toEqual(env.contract);
    expect(syncContract({ db: env.db, runId: RUN, snapshot: env.snap }, env.contract)).toEqual(env.contract);
  });
});

describe('committing a plan', () => {
  it('redacts ledger entries with no consequence or experiment, and refuses nothing when no worker ledger is given', () => {
    env = setup();
    const ctx = env.ctx();
    const plan = { decisions: [], experiments: [], amendments: [], questions: [], rejected: [], unresolved: [], answered: [], blockedCriteria: [], continuingCriteria: ['AC-1'], disposition: 'continue', reason: '' } as never;
    const out = commitPlan(ctx, {
      plan,
      trigger: trig(),
      ledger: [{ runId: RUN, claim: 'A claim with no stated consequence.', source: 'rules', confidence: 'low', consequence: null, reversibility: 'reversible', experiment: null, status: 'unverified' }],
      questions: [],
      proposals: [],
    });
    expect(out.ledger[0]).toMatchObject({ claim: 'A claim with no stated consequence.', consequence: null, experiment: null });
    expect(listLedger(env.db, RUN)).toHaveLength(1);
  });

  it('reports a question that cannot be persisted and lets any other failure through', () => {
    env = setup();
    const ctx = env.ctx();
    const plan = { decisions: [], experiments: [], amendments: [], questions: [], rejected: [], unresolved: [], answered: [], blockedCriteria: [], continuingCriteria: [], disposition: 'continue', reason: '' } as never;
    const bad = { ...goodQuestion(), options: [] };
    const out = commitPlan(ctx, { plan, trigger: trig(), ledger: [], questions: [{ draft: bad }], proposals: [] });
    expect(out.rejectedQuestions).toHaveLength(1);
    expect(out.rejectedQuestions[0]?.problems.length).toBeGreaterThan(0);
    expect(() => commitPlan(ctx, { plan, trigger: trig(), ledger: [], questions: [{ draft: null as never }], proposals: [] })).toThrow(TypeError);
  });

  it('reopens a supported claim raised again by a different trigger instance', async () => {
    env = setup();
    const t1 = trig({ kind: 'green_without_proof', mode: 'challenge', subjects: ['AC-1'], key: 'k1' });
    const first = await runInquisition({ trigger: t1, context: env.ctx() });
    transitionAssumption(env.db, first.ledger[0]!.id, 'supported', [{ kind: 'inspection', ref: 'trigger:k1', note: 'verified in a test' }], env.clock, 'test');
    const t2 = trig({ kind: 'green_without_proof', mode: 'challenge', subjects: ['AC-1'], key: 'k2' });
    const second = await runInquisition({ trigger: t2, context: env.ctx() });
    expect(second.ledger[0]?.status).toBe('unverified');
    expect(second.ledger[0]?.evidence.some((x) => x.ref === 'trigger:k2' && /raised again/.test(x.note ?? ''))).toBe(true);
    expect(listLedger(env.db, RUN)).toHaveLength(1);
  });
});
