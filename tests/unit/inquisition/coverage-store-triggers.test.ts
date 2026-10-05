import { afterEach, describe, expect, it } from 'vitest';
import { isOrbitError, type OrbitErrorCode } from '../../../src/core/errors.ts';
import type { ImplementerOutput } from '../../../src/contract/model-outputs.ts';
import { persistQuestion, answerQuestion } from '../../../src/inquisition/questions.ts';
import {
  fingerprintOccurrences,
  findAmendment,
  findHypothesis,
  findLedgerEntry,
  getAmendment,
  getHypothesis,
  getLedgerEntry,
  insertAmendment,
  insertHypothesis,
  insertLedgerEntry,
  listFailures,
  listQuestions,
  resolveAmendment,
  setQuestionAnswer,
  widenQuestionAffected,
  withdrawQuestion,
  writeLedgerStatus,
  type FailureRecord,
} from '../../../src/inquisition/store.ts';
import { detectTriggers, loadInquisitionSnapshot, proofAdequacy, type InquisitionSnapshot } from '../../../src/inquisition/triggers.ts';
import { RUN, addDecision, addEvidence, goodQuestion, setup, type Env } from './helpers.ts';

let env: Env | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

function code(fn: () => unknown, expected: OrbitErrorCode): void {
  try {
    fn();
  } catch (err) {
    expect(isOrbitError(err, expected), String(err)).toBe(true);
    return;
  }
  throw new Error(`expected ${expected}`);
}

const REC = { field: 'f', old_value: null, new_value: null, evidence: 'e', reason: 'r', approval_required: false, affected_verification: [] };

describe('question state machine', () => {
  it('refuses to answer, widen or withdraw a question that is not open', () => {
    env = setup();
    const q = persistQuestion(env.db, RUN, 'clarify', goodQuestion(), env.clock).question;
    withdrawQuestion(env.db, q.id, 'superseded', env.clock);
    code(() => setQuestionAnswer(env!.db, q.id, 'x', 'alice', env!.clock), 'TRANSITION_INVALID');
    code(() => widenQuestionAffected(env!.db, q.id, ['AC-2'], env!.clock), 'TRANSITION_INVALID');
    expect(widenQuestionAffected(env.db, q.id, [], env.clock).affected).toEqual(q.affected);

    const second = persistQuestion(env.db, RUN, 'clarify', goodQuestion({ question: 'Should the export file be compressed when it holds more than ten thousand rows?', affected_work: ['AC-3'], unblocked_work: [] }), env.clock).question;
    answerQuestion(env.db, env.runDir, second.id, 'Current page', 'alice', env.clock);
    code(() => withdrawQuestion(env!.db, second.id, 'late', env!.clock), 'TRANSITION_INVALID');
    code(() => setQuestionAnswer(env!.db, second.id, 'something else', 'alice', env!.clock), 'CONCURRENT_UPDATE');
    expect(setQuestionAnswer(env.db, second.id, 'Current page', 'alice', env.clock).status).toBe('answered');
  });

  it('reads a question row that kept no affected or change lists', () => {
    env = setup();
    const q = persistQuestion(env.db, RUN, 'clarify', goodQuestion(), env.clock).question;
    env.db.run('UPDATE questions SET affected_json = NULL WHERE id = ?', q.id);
    const [read] = listQuestions(env.db, RUN);
    expect(read).toMatchObject({ affected: [], changes: [] });
    env.db.run("UPDATE questions SET affected_json = '{}' WHERE id = ?", q.id);
    expect(listQuestions(env.db, RUN)[0]).toMatchObject({ affected: [], changes: [] });
  });

  it('refuses unreadable stored JSON rather than reading it as empty', () => {
    env = setup();
    const q = persistQuestion(env.db, RUN, 'clarify', goodQuestion(), env.clock).question;
    env.db.run("UPDATE questions SET options_json = '{broken' WHERE id = ?", q.id);
    code(() => listQuestions(env!.db, RUN), 'INTERNAL');
  });
});

describe('ledger store', () => {
  const entry = { runId: RUN, claim: 'The export reuses the report query.', source: 'rules', confidence: 'low' as const, consequence: null, reversibility: 'reversible' as const, experiment: null };

  it('defaults status and evidence, and refuses an unknown run, entry or stale transition', () => {
    env = setup();
    const rec = insertLedgerEntry(env.db, entry, env.clock);
    expect(rec).toMatchObject({ status: 'unverified', evidence: [] });
    expect(findLedgerEntry(env.db, 'as-none')).toBeNull();
    code(() => getLedgerEntry(env!.db, 'as-none'), 'NOT_FOUND');
    code(() => insertLedgerEntry(env!.db, { ...entry, runId: 'nope' }, env!.clock), 'NOT_FOUND');
    code(() => writeLedgerStatus(env!.db, rec.id, 'supported', 'rejected', [], env!.clock), 'CONCURRENT_UPDATE');
    const moved = writeLedgerStatus(env.db, rec.id, 'unverified', 'supported', [{ kind: 'inspection', ref: 'x', note: 'n', at: 1 }], env.clock);
    expect(moved.status).toBe('supported');
  });
});

describe('amendment and hypothesis store', () => {
  it('reads an amendment row that kept no envelope, resolves it without hashes, and refuses unknown rows', () => {
    env = setup();
    const rec = insertAmendment(env.db, { runId: RUN, record: REC, change: null, status: 'pending-approval' }, env.clock);
    env.db.run('UPDATE amendments SET affected_json = NULL WHERE id = ?', rec.id);
    expect(getAmendment(env.db, rec.id)).toMatchObject({ change: null, note: '', contractBefore: null, contractAfter: null, record: { affected_verification: [] } });
    expect(findAmendment(env.db, 'amd-none')).toBeNull();
    code(() => getAmendment(env!.db, 'amd-none'), 'NOT_FOUND');
    code(() => insertAmendment(env!.db, { runId: 'nope', record: REC, change: null, status: 'applied' }, env!.clock), 'NOT_FOUND');
    const resolved = resolveAmendment(env.db, rec.id, 'applied', 'dec-1', env.clock);
    expect(resolved).toMatchObject({ status: 'applied', approvedBy: 'dec-1' });
    expect(resolveAmendment(env.db, rec.id, 'applied', 'dec-1', env.clock).status).toBe('applied');
    code(() => resolveAmendment(env!.db, rec.id, 'rejected', 'dec-2', env!.clock), 'TRANSITION_INVALID');
  });

  it('reads a hypothesis with no stored fingerprint, and refuses unknown ones', () => {
    env = setup();
    const h = insertHypothesis(env.db, { runId: RUN, statement: 'The clock is not pinned', normalizedHash: 'h1', fingerprint: 'fp-1' }, env.clock);
    env.db.run("UPDATE hypotheses SET fingerprint = NULL, result = '{}' WHERE id = ?", h.id);
    expect(getHypothesis(env.db, h.id)).toMatchObject({ fingerprint: '', outcome: null });
    expect(findHypothesis(env.db, 'hyp-none')).toBeNull();
    code(() => getHypothesis(env!.db, 'hyp-none'), 'NOT_FOUND');
    code(() => insertHypothesis(env!.db, { runId: 'nope', statement: 's', normalizedHash: 'h', fingerprint: 'f' }, env!.clock), 'NOT_FOUND');
  });

  it('keeps the last excerpt it saw, ignoring failures that have none', () => {
    const f = (id: number, excerpt: string | null, candidateId: string | null): FailureRecord => ({ id, runId: RUN, candidateId, source: 'check', sourceId: null, fingerprint: 'fp', excerpt, createdAt: id });
    const occ = fingerprintOccurrences([f(1, 'first', 'c1'), f(2, null, 'c1'), f(3, null, null)]);
    expect(occ.get('fp')).toEqual({ candidates: ['c1', 'row:3'], rows: 3, excerpt: 'first' });
  });
});

function snapshot(over: Partial<InquisitionSnapshot> = {}): InquisitionSnapshot {
  return {
    runId: RUN,
    mode: 'autonomous',
    contract: null,
    failures: [],
    evidence: null,
    reviews: [],
    denials: [],
    decisions: [],
    expectedChangedFiles: [],
    changedFiles: [],
    diff: null,
    claims: null,
    sources: [],
    thresholds: { repeatedFailure: 2, unexplainedFiles: 3, denials: 3 },
    ...over,
  };
}

const kinds = (s: InquisitionSnapshot) => detectTriggers(s).map((t) => t.kind);

describe('loading a snapshot', () => {
  it('fills in whatever an evidence report left out', () => {
    env = setup();
    env.db.run(
      'INSERT INTO evidence_reports (id, run_id, candidate_id, tree_hash, check_config_hash, policy_hash, verdict, report_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      'ev-bare',
      RUN,
      'cand-1',
      'tree-1',
      'cfg',
      'pol',
      'INCOMPLETE',
      '{}',
      1,
    );
    const snap = loadInquisitionSnapshot(env.db, RUN);
    expect(snap.evidence).toMatchObject({ checks: [], acceptance: [], weakeningSignals: [], visualBaselineChanges: [], unverified: [] });
  });

  it('keeps an acceptance entry that listed no artifacts, and reads a check without a flaky flag as not flaky', () => {
    env = setup();
    addEvidence(env.db, { checks: [{ id: 'lint', status: 'PASSED' }], acceptance: [{ criterion_id: 'AC-1', status: 'supported' }] });
    const snap = loadInquisitionSnapshot(env.db, RUN);
    expect(snap.evidence?.acceptance).toEqual([{ criterion_id: 'AC-1', status: 'supported', artifacts: [] }]);
    expect(snap.evidence?.checks[0]?.flaky).toBe(false);
  });

  it('names a denial after the decision kind when it carries no rule, and finds its target in any field', () => {
    env = setup();
    addDecision(env.db, 'policy.deny', 'blocked one', null);
    addDecision(env.db, 'policy.deny.command', 'blocked two', { command: 'curl evil' });
    addDecision(env.db, 'policy.deny.network', 'blocked three', { rule: 'network.hosts', host: 'example.test' });
    addDecision(env.db, 'policy.deny.path', 'blocked four', { rule: 'scope', path: '.github/x', target: 'ignored-order' });
    const { denials } = loadInquisitionSnapshot(env.db, RUN);
    expect(denials).toEqual([
      { rule: 'policy.deny', target: null },
      { rule: 'policy.deny.command', target: 'curl evil' },
      { rule: 'network.hosts', target: 'example.test' },
      { rule: 'scope', target: 'ignored-order' },
    ]);
  });
});

describe('detection without a contract or evidence', () => {
  it('has nothing to say about a missing contract, and a green report proves nothing without one', () => {
    expect(kinds(snapshot())).toEqual([]);
    const green = { candidateId: 'c', treeHash: 't', verdict: 'PASS' as const, checks: [{ id: 'lint', status: 'PASSED', flaky: false }], acceptance: [], weakeningSignals: [], visualBaselineChanges: [], unverified: [] };
    expect(kinds(snapshot({ evidence: green }))).toEqual([]);
    expect(proofAdequacy(snapshot({ evidence: green })).adequate).toBe(true);
    expect(proofAdequacy(snapshot()).reason).toMatch(/no current evidence report/);
  });

  it('flags a contract with no criteria at all', () => {
    env = setup({ contract: (c) => ({ ...c, acceptance_criteria: [] }) });
    const t = detectTriggers(loadInquisitionSnapshot(env.db, RUN)).find((x) => x.kind === 'missing_outcomes');
    expect(t?.evidence).toEqual(['the contract has no acceptance criteria']);
  });

  it('ignores a source claim with an empty subject or value', () => {
    const s = snapshot({
      sources: [
        { source: 'a.md', authority: 'doc', claims: [{ subject: '', value: 'x' }, { subject: 'page size', value: '' }, { subject: 'page size', value: '100' }] },
        { source: 'b.md', authority: 'doc', claims: [{ subject: 'page size', value: '200' }] },
      ],
    });
    expect(detectTriggers(s).filter((t) => t.kind === 'contradictory_sources')).toHaveLength(1);
  });

  it('treats checks as relevant when the contract requires none, and a required check that never ran as not green', () => {
    env = setup({ contract: (c) => ({ ...c, required_check_ids: [] }) });
    addEvidence(env.db, { checks: [{ id: 'lint', status: 'PASSED' }], acceptance: [] });
    expect(detectTriggers(loadInquisitionSnapshot(env.db, RUN)).map((t) => t.kind)).toContain('green_without_proof');
    env.cleanup();
    env = setup();
    addEvidence(env.db, { checks: [{ id: 'build', status: 'PASSED' }], acceptance: [] });
    expect(detectTriggers(loadInquisitionSnapshot(env.db, RUN)).map((t) => t.kind)).not.toContain('green_without_proof');
  });

  it('reports a risky change as a hidden decision when there is no contract to have mentioned it', () => {
    const s = snapshot({ changedFiles: ['src/billing/invoice.ts'] });
    const hidden = detectTriggers(s).filter((t) => t.kind === 'hidden_decision');
    expect(hidden).toHaveLength(1);
    expect(hidden[0]?.summary).toBe('the change touches billing but the contract never mentions it');
  });

  it('counts denials with and without a target as separate groups', () => {
    const s = snapshot({ denials: [{ rule: 'scope', target: null }, { rule: 'scope', target: null }, { rule: 'scope', target: '.github/x' }] });
    const t = detectTriggers(s).find((x) => x.kind === 'scope_pressure');
    expect(t?.evidence).toEqual(['3 policy denials', 'scope x2', 'scope .github/x x1']);
  });
});

describe('unsupported confidence without evidence', () => {
  const claims = (over: Partial<ImplementerOutput> = {}): ImplementerOutput =>
    ({ tests_added: [], checks_run: [], evidence_refs: [], next_action: { kind: 'continue-implementation', detail: '' }, ...over }) as unknown as ImplementerOutput;

  it('says there is no evidence yet, skips claims that are not a pass or name no check, and skips refs without a criterion', () => {
    const s = snapshot({
      claims: claims({
        checks_run: [
          { check_id: 'lint', command: null, claimed_result: 'passed', note: '' },
          { check_id: 'unit', command: null, claimed_result: 'failed', note: '' },
          { check_id: null, command: 'npm test', claimed_result: 'passed', note: '' },
        ],
        evidence_refs: [{ criterion_id: null, ref: 'notes.md', note: '' }],
      }),
    });
    const t = detectTriggers(s).find((x) => x.kind === 'unsupported_confidence');
    expect(t?.evidence).toEqual(['claims lint passed; the controller has no result for it (no evidence yet)']);
  });

  it('asks for verification evidence when a mandatory criterion exists and nothing was offered', () => {
    env = setup();
    const contract = loadInquisitionSnapshot(env.db, RUN).contract;
    const s = snapshot({ contract, claims: claims({ next_action: { kind: 'request-verification', detail: '' } }) });
    expect(detectTriggers(s).find((x) => x.kind === 'unsupported_confidence')?.evidence).toEqual(['requests verification with no tests added and no evidence offered']);
  });
});
