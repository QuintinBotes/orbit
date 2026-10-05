import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../../../src/core/clock.ts';
import { hashObject } from '../../../src/core/hash.ts';
import { createRun } from '../../../src/controller/run-store.ts';
import type { GoalContract } from '../../../src/contract/types.ts';
import { snapshotPolicy } from '../../../src/policy/snapshot.ts';
import type { PolicySnapshot } from '../../../src/policy/types.ts';
import { openDb, type OrbitDb } from '../../../src/storage/db.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { syncContract } from '../../../src/inquisition/engine.ts';
import { currentEvidenceReport, insertEvidenceReport, listEvidenceReports } from '../../../src/evidence/store.ts';
import {
  BASELINE_EXCEPTION_REQUEST_KIND,
  applyBaselineExceptionAnswers,
  baselineQuestionId,
  raiseBaselineExceptionQuestions,
  type BaselineFailureInput,
} from '../../../src/inquisition/baseline-exception.ts';
import { answerQuestion } from '../../../src/inquisition/questions.ts';
import { listAmendments, listQuestions, setQuestionAnswer } from '../../../src/inquisition/store.ts';
import { contract as baseContract, config } from '../contract/fixtures.ts';

const RUN = 'run-1';
const FP = 'test-failure:lint:9f2c41d07a33b2e1';
const OTHER_FP = 'test-failure:lint:0000000000000000';

interface Env {
  db: OrbitDb;
  clock: ManualClock;
  dir: string;
  runDir: string;
  snapshot: PolicySnapshot;
  policyHash: string;
  contract: GoalContract;
  baseline(failures: { checkId: string; fingerprint: string | null; excerpt: string | null }[]): void;
  contractRow(): GoalContract | null;
  cleanup(): void;
}

let env: Env | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

/** A run with a real frozen policy (verified the way the controller and `orbit decide` verify it) and, optionally, a contract. */
function setup(opts: { withContract?: boolean } = {}): Env {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-baseline-exception-'));
  const runDir = join(dir, 'run');
  mkdirSync(runDir, { recursive: true });
  const clock = new ManualClock();
  const frozen = snapshotPolicy(config(), { runId: RUN, repoRoot: dir, runDir, clock });
  const db = openDb(join(dir, 'state.sqlite'));
  createRun(db, { id: RUN, repoRoot: dir, goal: 'Add CSV export', mode: 'autonomous', policyHash: frozen.hash, policyPath: frozen.path }, clock);
  const contract = baseContract(frozen.snapshot, { policy_hash: frozen.hash });
  if (opts.withContract !== false) db.run('UPDATE runs SET contract_json = ?, contract_hash = ? WHERE id = ?', JSON.stringify(contract), hashObject(contract), RUN);
  const e: Env = {
    db,
    clock,
    dir,
    runDir,
    snapshot: frozen.snapshot,
    policyHash: frozen.hash,
    contract,
    baseline(failures) {
      writeFileSync(join(runDir, 'baseline.json'), JSON.stringify({ schema: 'orbit.baseline/1', runId: RUN, failures, complete: true }));
    },
    contractRow() {
      const row = db.get<{ contract_json: string | null }>('SELECT contract_json FROM runs WHERE id = ?', RUN);
      return row?.contract_json ? (JSON.parse(row.contract_json) as GoalContract) : null;
    },
    cleanup() {
      db.close();
      chmodSync(frozen.path, 0o644);
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return e;
}

const FAILURE = { checkId: 'lint', fingerprint: FP, excerpt: 'src/export.ts:12 error: unused variable' };

function raise(e: Env, failures: BaselineFailureInput[] = [FAILURE]) {
  return raiseBaselineExceptionQuestions({ db: e.db, clock: e.clock, runId: RUN, runDir: e.runDir }, { failures, baseRevision: 'a'.repeat(40) });
}

describe('raising the baseline-exception question (PREFLIGHT)', () => {
  it('persists one non-blocking decision question per failure, with a request decision that carries the proposal', () => {
    env = setup();
    const { raised, skipped } = raise(env);
    expect(skipped).toEqual([]);
    expect(raised).toHaveLength(1);
    const q = raised[0]!.question;
    expect(q).toMatchObject({ id: baselineQuestionId(RUN, 'lint', FP), mode: 'decision-record', status: 'open', material: false, affected: ['check:lint'] });
    expect(q.options.map((o) => o.label)).toEqual(['Approve', 'Reject']);
    expect(q.recommendation?.option).toBe('Reject');
    expect(q.question).toContain('lint');
    expect(listQuestions(env.db, RUN, { status: 'open' })).toHaveLength(1);

    const [req] = listDecisions(env.db, RUN, { kind: BASELINE_EXCEPTION_REQUEST_KIND });
    expect(req!.data).toMatchObject({
      question_id: q.id,
      check_id: 'lint',
      fingerprint: FP,
      proposal: { change: { op: 'accept_baseline_failure', check_id: 'lint', fingerprint: FP } },
    });
    // Asking changes nothing: the contract has no exception until a person approves.
    expect(env.contractRow()!.baseline_exceptions).toBeUndefined();
  });

  it('is idempotent across a restarted PREFLIGHT, and offers nothing for a failure with no fingerprint', () => {
    env = setup();
    raise(env);
    raise(env);
    expect(listQuestions(env.db, RUN)).toHaveLength(1);
    expect(listDecisions(env.db, RUN, { kind: BASELINE_EXCEPTION_REQUEST_KIND })).toHaveLength(1);
    const res = raise(env, [{ checkId: 'typecheck', fingerprint: null, excerpt: null }]);
    expect(res.raised).toEqual([]);
    expect(res.skipped).toEqual([expect.objectContaining({ checkId: 'typecheck' })]);
    expect(listQuestions(env.db, RUN)).toHaveLength(1);
  });

  it('redacts a secret quoted in the failure excerpt before it is stored', () => {
    env = setup();
    const token = ['ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
    raise(env, [{ ...FAILURE, excerpt: `fetch failed with ${token}` }]);
    const q = listQuestions(env.db, RUN)[0]!;
    expect(JSON.stringify(q)).not.toContain(token);
    expect(JSON.stringify(listDecisions(env.db, RUN))).not.toContain(token);
  });
});

describe('an approved answer applies the exception through the amendment rules (orbit decide)', () => {
  it('Approve adds exactly the recorded fingerprint to the contract, records the amendment and a decision, and rewrites contract.json', () => {
    env = setup();
    env.baseline([FAILURE]);
    const qid = raise(env).raised[0]!.question.id;
    const before = env.contractRow()!;

    const answered = answerQuestion(env.db, env.runDir, qid, 'Approve', 'alice', env.clock);
    expect(answered.baselineException).toMatchObject({ questionId: qid, checkId: 'lint', status: 'applied' });

    const after = env.contractRow()!;
    expect(after.baseline_exceptions).toEqual([{ check_id: 'lint', fingerprint: FP, reason: expect.stringContaining('lint') }]);
    expect({ ...after, baseline_exceptions: undefined }).toEqual({ ...before, baseline_exceptions: undefined });
    expect(JSON.parse(readFileSync(join(env.runDir, 'contract.json'), 'utf8'))).toEqual(after);
    expect(env.db.get<{ contract_hash: string }>('SELECT contract_hash FROM runs WHERE id = ?', RUN)!.contract_hash).toBe(hashObject(after));

    const [amd] = listAmendments(env.db, RUN, { status: 'applied' });
    expect(amd).toMatchObject({ approvedBy: `dec-answer-${qid}`, contractBefore: hashObject(before), contractAfter: hashObject(after) });
    expect(amd!.record).toMatchObject({ field: 'baseline_exceptions', approval_required: true });
    expect(listDecisions(env.db, RUN, { kind: 'contract.baseline-exception' })).toHaveLength(1);
  });

  it('makes a report judged before the exception stale, so the next verification evaluates the recorded results under the amended contract; a PASS stands', () => {
    env = setup();
    env.baseline([FAILURE]);
    const qid = raise(env).raised[0]!.question.id;
    const report = (candidateId: string, verdict: 'PASS' | 'FAIL') => ({
      candidateId,
      reportPath: null,
      report: { task_id: 't', run_id: RUN, attempt: 1, candidate_revision: 'c', tree_hash: `tree-${candidateId}`, check_config_hash: 'h', policy_hash: env!.policyHash, scope: {} as never, checks: [], ui: [], acceptance_evidence: [], verdict, unverified: [] },
    });
    insertEvidenceReport(env.db, report('cand-fail', 'FAIL'), env.clock);
    insertEvidenceReport(env.db, report('cand-pass', 'PASS'), env.clock);

    answerQuestion(env.db, env.runDir, qid, 'Approve', 'alice', env.clock);
    expect(currentEvidenceReport(env.db, RUN, 'cand-fail')).toBeNull();
    expect(currentEvidenceReport(env.db, RUN, 'cand-pass')?.verdict).toBe('PASS');
    const stale = listEvidenceReports(env.db, RUN).find((r) => r.candidateId === 'cand-fail');
    expect(stale?.invalidatedReason).toMatch(/baseline exception for check lint/);
  });

  it('a Reject leaves every report as it is', () => {
    env = setup();
    env.baseline([FAILURE]);
    const qid = raise(env).raised[0]!.question.id;
    insertEvidenceReport(env.db, { candidateId: 'cand-fail', reportPath: null, report: { task_id: 't', run_id: RUN, attempt: 1, candidate_revision: 'c', tree_hash: 'tree-x', check_config_hash: 'h', policy_hash: env.policyHash, scope: {} as never, checks: [], ui: [], acceptance_evidence: [], verdict: 'FAIL', unverified: [] } }, env.clock);
    answerQuestion(env.db, env.runDir, qid, 'Reject', 'alice', env.clock);
    expect(currentEvidenceReport(env.db, RUN, 'cand-fail')?.verdict).toBe('FAIL');
  });

  it('is idempotent: answering the same way again, or applying again, changes nothing', () => {
    env = setup();
    env.baseline([FAILURE]);
    const qid = raise(env).raised[0]!.question.id;
    answerQuestion(env.db, env.runDir, qid, 'Approve', 'alice', env.clock);
    const once = env.contractRow();
    const again = answerQuestion(env.db, env.runDir, qid, 'Approve', 'alice', env.clock);
    expect(again.baselineException?.status).toBe('already-applied');
    expect(applyBaselineExceptionAnswers({ db: env.db, clock: env.clock, runId: RUN, runDir: env.runDir }).outcomes).toEqual([expect.objectContaining({ status: 'already-applied' })]);
    expect(env.contractRow()).toEqual(once);
    expect(listAmendments(env.db, RUN)).toHaveLength(1);
  });

  it('Reject, or an answer that is not "Approve", excepts nothing', () => {
    env = setup();
    env.baseline([FAILURE]);
    const qid = raise(env).raised[0]!.question.id;
    expect(answerQuestion(env.db, env.runDir, qid, 'Reject', 'alice', env.clock).baselineException).toMatchObject({ status: 'declined' });
    expect(env.contractRow()!.baseline_exceptions).toBeUndefined();
    expect(listAmendments(env.db, RUN)).toEqual([]);

    env.cleanup();
    env = setup();
    env.baseline([FAILURE]);
    const q2 = raise(env).raised[0]!.question.id;
    expect(answerQuestion(env.db, env.runDir, q2, 'sure, go ahead', 'alice', env.clock).baselineException).toMatchObject({ status: 'declined' });
    expect(env.contractRow()!.baseline_exceptions).toBeUndefined();
  });

  it('a model or worker can neither answer nor have a forged answer applied', () => {
    env = setup();
    env.baseline([FAILURE]);
    const qid = raise(env).raised[0]!.question.id;
    const e = env;
    expect(() => answerQuestion(e.db, e.runDir, qid, 'Approve', 'inquisitor', e.clock)).toThrow(/cannot answer a question/);
    // A row written behind answerQuestion's back, with no recorded decision by a person, does not count either.
    setQuestionAnswer(env.db, qid, 'Approve', 'inquisitor', env.clock);
    const res = applyBaselineExceptionAnswers({ db: env.db, clock: env.clock, runId: RUN, runDir: env.runDir });
    expect(res.outcomes).toEqual([expect.objectContaining({ status: 'declined' })]);
    expect(env.contractRow()!.baseline_exceptions).toBeUndefined();
  });

  it('refuses, and records a rejected amendment, when the baseline no longer records that fingerprint', () => {
    env = setup();
    env.baseline([FAILURE]);
    const qid = raise(env).raised[0]!.question.id;
    // The baseline report on disk now says the check failed differently (or not at all): the request cannot be honoured.
    env.baseline([{ ...FAILURE, fingerprint: OTHER_FP }]);
    const res = answerQuestion(env.db, env.runDir, qid, 'Approve', 'alice', env.clock);
    expect(res.baselineException).toMatchObject({ status: 'refused' });
    expect(res.baselineException!.detail).toMatch(/fingerprint does not equal/);
    expect(env.contractRow()!.baseline_exceptions).toBeUndefined();
    expect(listAmendments(env.db, RUN, { status: 'rejected' })).toHaveLength(1);
    // A refused request is not retried into success by a later call.
    expect(applyBaselineExceptionAnswers({ db: env.db, clock: env.clock, runId: RUN, runDir: env.runDir }).outcomes[0]!.status).toBe('refused');
  });

  it('refuses when the baseline report is missing, because the fingerprint cannot be confirmed', () => {
    env = setup();
    const qid = raise(env).raised[0]!.question.id;
    const res = answerQuestion(env.db, env.runDir, qid, 'Approve', 'alice', env.clock);
    expect(res.baselineException).toMatchObject({ status: 'refused' });
    expect(res.baselineException!.detail).toMatch(/baseline failures were not supplied/);
  });

  it('refuses an exception for a check the contract does not require', () => {
    env = setup();
    env.baseline([{ checkId: 'build', fingerprint: 'build-failure:x', excerpt: null }]);
    const qid = raise(env, [{ checkId: 'build', fingerprint: 'build-failure:x', excerpt: null }]).raised[0]!.question.id;
    const res = answerQuestion(env.db, env.runDir, qid, 'Approve', 'alice', env.clock);
    expect(res.baselineException).toMatchObject({ status: 'refused' });
    expect(res.baselineException!.detail).toMatch(/not in required_check_ids/);
  });

  it('defers an approval given before the run has a contract, and applies it on the next call once there is one', () => {
    env = setup({ withContract: false });
    env.baseline([FAILURE]);
    const qid = raise(env).raised[0]!.question.id;
    const res = answerQuestion(env.db, env.runDir, qid, 'Approve', 'alice', env.clock);
    expect(res.baselineException).toMatchObject({ status: 'deferred' });
    expect(res.decision.kind).toBe('inquisition.answer');
    expect(existsSync(join(env.runDir, 'contract.json'))).toBe(false);

    env.db.run('UPDATE runs SET contract_json = ?, contract_hash = ? WHERE id = ?', JSON.stringify(env.contract), hashObject(env.contract), RUN);
    const later = applyBaselineExceptionAnswers({ db: env.db, clock: env.clock, runId: RUN, runDir: env.runDir }, { snapshot: env.snapshot });
    expect(later.outcomes).toEqual([expect.objectContaining({ status: 'applied' })]);
    expect(later.contract!.baseline_exceptions).toEqual([expect.objectContaining({ check_id: 'lint', fingerprint: FP })]);
  });

  it('a contract persisted before the exception is brought up to date by syncContract (the replay carries the failure it was applied against)', () => {
    env = setup();
    env.baseline([FAILURE]);
    const qid = raise(env).raised[0]!.question.id;
    answerQuestion(env.db, env.runDir, qid, 'Approve', 'alice', env.clock);
    const stale = env.contract;
    expect(stale.baseline_exceptions).toBeUndefined();
    const synced = syncContract({ db: env.db, runId: RUN, snapshot: env.snapshot }, stale);
    expect(synced.baseline_exceptions).toEqual(env.contractRow()!.baseline_exceptions);
  });

  it('applies only the answered question when several checks failed', () => {
    env = setup();
    env.baseline([FAILURE, { checkId: 'typecheck', fingerprint: 'type-failure:y', excerpt: null }]);
    const raised = raise(env, [FAILURE, { checkId: 'typecheck', fingerprint: 'type-failure:y', excerpt: null }]).raised;
    expect(raised).toHaveLength(2);
    answerQuestion(env.db, env.runDir, raised[0]!.question.id, 'Approve', 'alice', env.clock);
    expect(env.contractRow()!.baseline_exceptions!.map((x) => x.check_id)).toEqual(['lint']);
    const all = applyBaselineExceptionAnswers({ db: env.db, clock: env.clock, runId: RUN, runDir: env.runDir });
    expect(all.outcomes.map((o) => [o.checkId, o.status])).toEqual([['lint', 'already-applied'], ['typecheck', 'unanswered']]);
  });
});
