// A needs-decision entry of the assumption ledger is a choice only a person may make (spec section 10 "Ledger"). A run
// cannot end SUCCEEDED while one raised during the run is open: as CONTRACTING does for a needs-decision assumption, it
// blocks with a question to a person, naming each entry. On the 0.3.0 retest a Python advisory run recorded three such
// entries in two inquiries, asked nobody, and ended SUCCEEDED.
import { afterEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { deliveringStep } = await import('../../../src/controller/steps/delivering.ts');
const { completionGate } = await import('../../../src/controller/gates.ts');
const { recordAskedLedger, ACCEPT_LEDGER_DECISIONS, DECLINE_LEDGER_DECISIONS } = await import('../../../src/controller/undecided-ledger.ts');
const { snapshotCandidate } = await import('../../../src/evidence/candidate.ts');
const { getRun } = await import('../../../src/controller/run-store.ts');
const { newRunNeeded } = await import('../../../src/controller/resume.ts');
const { insertLedgerEntry, insertQuestion, listLedger, listQuestions } = await import('../../../src/inquisition/store.ts');
const { answerQuestion } = await import('../../../src/inquisition/questions.ts');
const { answerDecisionId } = await import('../../../src/inquisition/actors.ts');
const { recordReview } = await import('../../../src/review/store.ts');
const { addEvidence, giveRepository, gitIn, initLedger, makeUnitLab, setContract } = await import('./coverage-helpers.ts');
type UnitLab = import('./coverage-helpers.ts').UnitLab;
type CandidateRecord = import('../../../src/evidence/store.ts').CandidateRecord;

let lab: UnitLab;
afterEach(() => lab?.cleanup());

async function setup(): Promise<{ cand: CandidateRecord }> {
  lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'DELIVERING'] });
  const repo = await giveRepository(lab);
  setContract(lab, { baseline_revision: repo.base, allowed_paths: ['apps/calc.mjs'] });
  initLedger(lab);
  writeFileSync(join(repo.worktree, 'apps', 'calc.mjs'), 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n');
  const cand = await snapshotCandidate({ db: lab.db, clock: lab.clock, repoRoot: lab.repo, worktree: repo.worktree, runId: lab.runId, baseRev: repo.base, attempt: 1, workerId: null });
  lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 1, 'implementation.attempt', 'x', ?)", lab.runId, JSON.stringify({ attempt: 1 }));
  lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 1, 'implementation.candidate', 'x', ?)", lab.runId, JSON.stringify({ attempt: 1, candidate_id: cand.id }));
  addEvidence(lab, cand);
  recordReview(lab.db, { id: 'rev-1', runId: lab.runId, candidateId: cand.id, treeHash: cand.treeHash, round: 1, provider: 'codex', model: null, workerId: null, verdict: 'APPROVE', packetSha256: null, findings: [] }, lab.clock);
  return { cand };
}

const entry = (claim: string, status: 'needs-decision' | 'unverified' = 'needs-decision') =>
  insertLedgerEntry(lab.db, { runId: lab.runId, claim, source: 'inquisitor autonomous decision', confidence: 'low', consequence: 'proceeding would be a guess', reversibility: 'costly-to-reverse', experiment: null, status }, lab.clock);
/** An entry an inquiry derived from its trigger, as the engine records it: with the trigger's marker. */
const derived = (claim: string, key: string) =>
  insertLedgerEntry(lab.db, { runId: lab.runId, claim, source: 'diff and contract', confidence: 'low', consequence: 'the work ships on an unchecked belief', reversibility: 'irreversible', experiment: null, status: 'needs-decision', evidence: [{ kind: 'inspection', ref: `trigger:${key}`, note: 'raised by hidden_decision', at: 0 }] }, lab.clock);
const clarify = (question: string, affected: string[]) =>
  insertQuestion(lab.db, { runId: lab.runId, mode: 'clarify', question, evidence: [], options: [{ label: 'half-even', description: 'banker\'s rounding', consequences: 'c' }, { label: 'half-up', description: 'school rounding', consequences: 'c' }], changes: [], recommendation: { option: 'half-even', reason: 'r' }, safeDefault: { exists: false, option: null, reason: 'none' }, material: true, affected, unblocked: [] }, lab.clock);
const run = () => deliveringStep(lab.ctx());
const state = () => getRun(lab.db, lab.runId).state;
const reason = () => getRun(lab.db, lab.runId).outcomeReason ?? '';
const resumeDelivering = () => lab.db.run("UPDATE runs SET state = 'DELIVERING' WHERE id = ?", lab.runId);
const runDir = () => lab.ctx().runDir;
const branchExists = () => {
  try {
    gitIn(lab.repo, 'rev-parse', '--verify', '--quiet', `refs/heads/orbit/${lab.runId}`);
    return true;
  } catch {
    return false;
  }
};

describe('a needs-decision ledger entry raised during the run', () => {
  it('keeps the run from success: it blocks before delivery with a question to a person naming each entry', async () => {
    await setup();
    const rounding = entry('Round each bulk price half to even.');
    const negative = entry('A negative percent raises ValueError.');
    entry('The parser is total.', 'unverified');
    await run();
    expect(state()).toBe('BLOCKED');
    expect(branchExists()).toBe(false);
    const [q, ...more] = listQuestions(lab.db, lab.runId, { status: 'open' });
    expect(more).toEqual([]);
    expect(q!.material).toBe(true);
    expect(q!.mode).toBe('decision-record');
    expect(q!.question).toContain(rounding.id);
    expect(q!.question).toContain(negative.id);
    expect(q!.evidence.join('\n')).toContain(`${rounding.id}`);
    expect(q!.evidence.join('\n')).toContain('Round each bulk price half to even.');
    expect(q!.evidence.join('\n')).toContain('A negative percent raises ValueError.');
    expect(q!.evidence.join('\n')).not.toContain('The parser is total.');
    expect(q!.options.map((o) => o.label)).toEqual([ACCEPT_LEDGER_DECISIONS, DECLINE_LEDGER_DECISIONS]);
    expect(reason()).toContain(rounding.id);
    expect(reason()).toContain(negative.id);
    expect(reason()).toContain(q!.id);
    expect(reason()).toContain(`orbit decide ${lab.runId} ${q!.id}`);
    expect(JSON.parse(getRun(lab.db, lab.runId).outcomeJson!)).toMatchObject({ questions: [q!.id], ledger_entries: [rounding.id, negative.id] });
  });

  it('asks once: running the step again finds the same question', async () => {
    await setup();
    entry('Round each bulk price half to even.');
    await run();
    resumeDelivering();
    await run();
    expect(listQuestions(lab.db, lab.runId)).toHaveLength(1);
  });

  it('a person who accepts settles each entry on that answer, and the run succeeds', async () => {
    await setup();
    const rounding = entry('Round each bulk price half to even.');
    await run();
    const q = listQuestions(lab.db, lab.runId, { status: 'open' })[0]!;
    answerQuestion(lab.db, runDir(), q.id, ACCEPT_LEDGER_DECISIONS, 'acme-dev', lab.clock);
    resumeDelivering();
    await run();
    expect(state(), reason()).toBe('SUCCEEDED');
    const settled = listLedger(lab.db, lab.runId).find((e) => e.id === rounding.id)!;
    expect(settled.status).toBe('supported');
    expect(settled.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'decision', ref: answerDecisionId(q.id) })]));
  });

  it('a person who declines keeps the run from success, and a resume blocks again without a new question', async () => {
    await setup();
    const rounding = entry('Round each bulk price half to even.');
    await run();
    const q = listQuestions(lab.db, lab.runId, { status: 'open' })[0]!;
    answerQuestion(lab.db, runDir(), q.id, DECLINE_LEDGER_DECISIONS, 'acme-dev', lab.clock);
    resumeDelivering();
    await run();
    expect(state()).toBe('BLOCKED');
    expect(reason()).toContain(rounding.id);
    expect(reason()).toMatch(/declined/);
    expect(reason()).toContain('start a new run');
    expect(listLedger(lab.db, lab.runId).find((e) => e.id === rounding.id)!.status).toBe('needs-decision');
    expect(listQuestions(lab.db, lab.runId)).toHaveLength(1);
    expect(branchExists()).toBe(false);
  });

  it('a declined entry is reported as declined, not as waiting, and the outcome records it so every surface says a new run', async () => {
    await setup();
    const rounding = entry('Round each bulk price half to even.');
    await run();
    const q = listQuestions(lab.db, lab.runId, { status: 'open' })[0]!;
    answerQuestion(lab.db, runDir(), q.id, DECLINE_LEDGER_DECISIONS, 'acme-dev', lab.clock);
    resumeDelivering();
    await run();
    expect(state()).toBe('BLOCKED');
    expect(reason()).toMatch(/^a person declined 1 needs-decision assumption ledger entry/);
    expect(reason()).not.toMatch(/waits? for a person/);
    expect(reason()).not.toMatch(/then orbit resume/);
    expect(JSON.parse(getRun(lab.db, lab.runId).outcomeJson!)).toMatchObject({ ledger_entries: [rounding.id], ledger_declined: [{ question_id: q.id, ledger_ids: [rounding.id] }] });
    const fresh = newRunNeeded(lab.db, getRun(lab.db, lab.runId));
    expect(fresh).toContain(q.id);
    expect(fresh).toContain(rounding.id);
  });

  it('with one entry declined and another still waiting, the declined one decides: no "answer, then resume" advice', async () => {
    await setup();
    const rounding = entry('Round each bulk price half to even.');
    await run();
    const q = listQuestions(lab.db, lab.runId, { status: 'open' })[0]!;
    answerQuestion(lab.db, runDir(), q.id, DECLINE_LEDGER_DECISIONS, 'acme-dev', lab.clock);
    const later = entry('A negative percent raises ValueError.');
    resumeDelivering();
    await run();
    expect(state()).toBe('BLOCKED');
    expect(reason()).toMatch(new RegExp(`^a person declined 1 needs-decision assumption ledger entry recorded during the run, so it cannot reach delivery: ${rounding.id} `));
    expect(reason()).toContain(`${later.id} (A negative percent raises ValueError.) also needs a person's decision`);
    expect(reason()).not.toMatch(/then orbit resume/);
    expect(reason()).toContain('start a new run');
    // The run cannot succeed whatever is answered now, so nothing more is asked of a person.
    expect(listQuestions(lab.db, lab.runId)).toHaveLength(1);
    expect(JSON.parse(getRun(lab.db, lab.runId).outcomeJson!)).toMatchObject({ ledger_declined: [{ question_id: q.id, ledger_ids: [rounding.id] }] });
  });

  it('an entry an inquiry derived and asked a person about is settled by the person\'s answer, with no second question', async () => {
    await setup();
    const asked = derived('the planner left 1 material decision(s) unresolved; the behaviour chosen is acceptable.', 'contracting:k1');
    const q = clarify('Which rounding should bulk_price use?', ['AC-1']);
    recordAskedLedger(lab.ctx(), 'contracting:k1', [asked], [q]);
    answerQuestion(lab.db, runDir(), q.id, 'half-up', 'acme-dev', lab.clock);
    await run();
    expect(state(), reason()).toBe('SUCCEEDED');
    expect(listQuestions(lab.db, lab.runId)).toHaveLength(1);
    const settled = listLedger(lab.db, lab.runId).find((e) => e.id === asked.id)!;
    expect(settled.status).toBe('supported');
    expect(settled.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'decision', ref: answerDecisionId(q.id) })]));
  });

  it('an entry the inquisitor added in that inquiry, or an earlier inquiry\'s entry it met again, was not asked about: it gets the question', async () => {
    await setup();
    const asked = derived('the planner left 1 material decision(s) unresolved; the behaviour chosen is acceptable.', 'contracting:k1');
    const worker = entry('Round each bulk price half to even.');
    const earlier = derived('an earlier inquiry\'s decision.', 'review:k0');
    const q = clarify('Which rounding should bulk_price use?', ['AC-1']);
    recordAskedLedger(lab.ctx(), 'contracting:k1', [asked, worker, earlier], [q]);
    answerQuestion(lab.db, runDir(), q.id, 'half-up', 'acme-dev', lab.clock);
    await run();
    expect(state()).toBe('BLOCKED');
    const ask = listQuestions(lab.db, lab.runId, { status: 'open' });
    expect(ask).toHaveLength(1);
    expect(ask[0]!.question).toContain(worker.id);
    expect(ask[0]!.question).toContain(earlier.id);
    expect(ask[0]!.question).not.toContain(asked.id);
    expect(listLedger(lab.db, lab.runId).find((e) => e.id === asked.id)!.status).toBe('supported');
  });

  it('an entry whose inquiry question is still open waits for that question, and no other is asked', async () => {
    await setup();
    const asked = derived('the behaviour chosen is acceptable.', 'review:k2');
    const q = insertQuestion(lab.db, { runId: lab.runId, mode: 'risk-review', question: 'Is a 3 percent fee acceptable?', evidence: [], options: [], changes: [], recommendation: { option: 'a', reason: 'r' }, safeDefault: { exists: false, option: null, reason: 'none' }, material: true, affected: [], unblocked: [] }, lab.clock);
    recordAskedLedger(lab.ctx(), 'review:k2', [asked], [q]);
    await run();
    expect(state()).toBe('BLOCKED');
    expect(reason()).toContain(q.id);
    expect(reason()).toContain(asked.id);
    expect(listQuestions(lab.db, lab.runId)).toHaveLength(1);
  });

  it('is named by the completion gate as long as it is open', async () => {
    const { cand } = await setup();
    const rounding = entry('Round each bulk price half to even.');
    const gate = () => completionGate(lab.db, { run: { id: lab.runId }, snapshot: lab.ctx().snapshot, candidate: cand, implementerProvider: 'claude', deliveredTree: cand.treeHash, now: lab.clock.now() });
    expect(gate().passed).toBe(false);
    expect(gate().reasons.join(' ')).toContain(rounding.id);
  });
});
