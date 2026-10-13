// REVIEWING and a finding whose subject is Orbit's own recorded evidence classification (ADR 0014, 0.3.1 addendum).
//
// The dotnet stall of the 0.3.0 retest (runs orb-20261013-083016-84a30d and orb-20261013-083337-df06a4): the reviewer
// returned REPAIR_REQUIRED with one high finding, TEST-1, "the fail-before evidence shows only a load failure", plus two
// info findings. Orbit made TEST-1 claim_pending and blocking and sent it to repair; a repair cannot change the base
// revision, so attempt 2 reproduced the tree and the run ended EXHAUSTED on non-progress. In the python advisory run
// (orb-20261013-080355-6ac27f) the same finding, about pricing, went to the Inquisition as "financial effects" first,
// which amended AC-4's proof. Such a finding is a note: no repair, no Inquisition.
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderAdapter } from '../../../src/adapters/types.ts';
import { snapshotCandidate } from '../../../src/evidence/candidate.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { listFindings, listReviews, recordReview } from '../../../src/review/store.ts';
import type { IngestedFinding } from '../../../src/review/types.ts';
import { getRun } from '../../../src/controller/run-store.ts';
import { REVIEW_REPAIR_EVENT, reviewingStep } from '../../../src/controller/steps/reviewing.ts';
import { briefPath } from '../../../src/controller/steps/implementing.ts';
import { addEvidence, giveRepository, initLedger, makeUnitLab, okResult, scriptedAdapter, setContract, validateModels, type UnitLab } from './coverage-helpers.ts';

let lab: UnitLab;
afterEach(() => {
  if (lab) execFileSync('chmod', ['-R', 'u+w', lab.base]);
  lab?.cleanup();
});

const claude = (): ProviderAdapter =>
  ({
    id: 'claude',
    discoverCapabilities: async () => ({ provider: 'claude', available: true, version: '1', models: [], structuredOutput: true, readOnlySandbox: true, usageReporting: 'full', costReporting: true, detail: '' }),
    validateCredentials: async () => ({ state: 'valid', method: 'api_key', detail: 'ok' }),
  }) as unknown as ProviderAdapter;

/** The dotnet run's findings, verbatim. */
const TEST_1: IngestedFinding = {
  externalId: 'TEST-1',
  severity: 'high',
  category: 'test-adequacy',
  location: 'tests/Acme.Tests/CalculatorTests.cs:23',
  path: 'tests/Acme.Tests/CalculatorTests.cs',
  line: 23,
  claim: 'The fail-before evidence for AC-1, AC-2 and AC-3 shows only a load failure. It does not show that any assertion about the criteria failed. The new tests depend on Clamp existing, but the probe does not prove that they check its behavior.',
  evidence: "In evidence/1/fail-before/unit-tests~1.log, the only errors are CS1061 at CalculatorTests.cs(23,49) and (27,68), saying 'Calculator' does not contain a definition for 'Clamp'. The test project did not compile, so no assertion ran on the base revision.",
  suggestedValidation: 'Rerun the fail-before probe on the base revision with a stub Clamp that compiles but behaves wrongly, for example one that returns value and never throws.',
};
const COR_1: IngestedFinding = { externalId: 'COR-1', severity: 'info', category: 'correctness', location: 'src/Acme/Calculator.cs:13', path: 'src/Acme/Calculator.cs', line: 13, claim: 'Reading the code, the implementation appears to meet AC-1 and AC-2.', evidence: 'Calculator.cs:13-18 holds the guard and the clamp.', suggestedValidation: null };
const PRAC_1: IngestedFinding = { externalId: 'PRAC-1', severity: 'info', category: 'scope', location: null, path: null, line: null, claim: 'The justifications for the omitted practices are sound for an O(1) pure integer method.', evidence: 'Calculator.cs:11-19 has no I/O.', suggestedValidation: null };

/** The python advisory run's TEST-1: about pricing, so it read as financial effects. */
const PRICING_TEST_1: IngestedFinding = {
  externalId: 'TEST-1',
  severity: 'high',
  category: 'test-adequacy',
  location: 'tests/test_pricing.py:3',
  path: 'tests/test_pricing.py',
  line: 3,
  claim: 'The fail-before evidence for AC-1 to AC-4 only shows a load failure. It does not show any assertion about the bulk_price discount criteria failing on the base.',
  evidence: 'Because of the module-level import of bulk_price, collection fails on the base, so none of the nine new price tests ran there.',
  suggestedValidation: 'Change the tests so the module collects on the base, then rerun the fail-before probe.',
};

type Script = Parameters<typeof scriptedAdapter>[1];

const revisionOf = (prompt: string): string => prompt.match(/candidate revision ([0-9a-f]{40})/)?.[1] ?? '0'.repeat(40);
const approve: Script = ({ spec }) => okResult({ verdict: 'APPROVE', candidate_revision: revisionOf(spec.prompt), findings: [] });
/** A reviewer that answers with `verdict` and `findings` (in the review output's own shape). */
const answer =
  (verdict: 'APPROVE' | 'REPAIR_REQUIRED' | 'BLOCK', findings: IngestedFinding[]): Script =>
  ({ spec }) =>
    okResult({
      verdict,
      candidate_revision: revisionOf(spec.prompt),
      findings: findings.map((f) => ({ id: f.externalId, severity: f.severity, category: f.category, location: f.location, claim: f.claim, evidence: f.evidence, suggested_validation: f.suggestedValidation })),
    });

/**
 * A run in REVIEWING with one candidate and fresh PASS evidence. The reviewer is Codex (independent) by default; with
 * `sameProvider` it is Claude reviewing Claude's work in a separate session, as in the .NET runs, where Codex was not
 * eligible and review.when_unavailable was claude.
 */
async function setup(reviewer?: Script, opts: { sameProvider?: boolean } = {}) {
  lab = makeUnitLab({
    path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING'],
    deps: { schedulerProbe: { availableParallelism: () => 16, freemem: () => 64_000 * 1024 * 1024 } },
    tweak: (c) => {
      if (opts.sameProvider) c.review.when_unavailable = 'claude';
      else c.providers.codex = { ...c.providers.codex!, data_policy_eligible: true, model: 'gpt-6-astra' };
    },
  });
  const scripted = scriptedAdapter(lab, reviewer ?? approve);
  lab.deps.adapters = opts.sameProvider ? { claude: scripted } : { claude: claude(), codex: scripted };
  validateModels(lab);
  for (const e of lab.deps.registry.list()) if (e.provider === 'codex') lab.deps.registry.markAvailability(e.modelId, 'codex-cli', true, 'test');
  const repo = await giveRepository(lab);
  setContract(lab, { baseline_revision: repo.base, allowed_paths: ['apps/calc.mjs'] });
  const ledger = initLedger(lab);
  writeFileSync(join(repo.worktree, 'apps', 'calc.mjs'), 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n');
  const cand = await snapshotCandidate({ db: lab.db, clock: lab.clock, repoRoot: lab.repo, worktree: repo.worktree, runId: lab.runId, baseRev: repo.base, attempt: 1, workerId: null });
  lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 1, 'implementation.attempt', 'x', ?)", lab.runId, JSON.stringify({ attempt: 1 }));
  lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 1, 'implementation.candidate', 'x', ?)", lab.runId, JSON.stringify({ attempt: 1, candidate_id: cand.id }));
  addEvidence(lab, cand);
  return { cand, codex: scripted, reviewer: scripted, ledger };
}

function record(cand: { id: string; treeHash: string }, verdict: 'APPROVE' | 'REPAIR_REQUIRED' | 'BLOCK', findings: IngestedFinding[], provider = 'codex') {
  const n = listReviews(lab.db, lab.runId, { includeInvalidated: true }).length + 1;
  return recordReview(lab.db, { id: `rev-${n}`, runId: lab.runId, candidateId: cand.id, treeHash: cand.treeHash, round: n, provider, model: null, workerId: null, verdict, packetSha256: null, findings }, lab.clock);
}

const state = () => getRun(lab.db, lab.runId).state;
const transitionsTo = (to: string) => lab.db.all("SELECT 1 AS x FROM events WHERE run_id = ? AND type = 'state.transition' AND to_state = ?", lab.runId, to).length;
const repairs = () => lab.db.all('SELECT 1 AS x FROM events WHERE run_id = ? AND type = ?', lab.runId, REVIEW_REPAIR_EVENT).length;
const outcome = () => JSON.parse(getRun(lab.db, lab.runId).outcomeJson ?? '{}') as Record<string, unknown>;
/** The reviewer sessions started, by purpose. */
const reviewerPurposes = () => lab.db.all<{ purpose: string }>("SELECT purpose FROM workers WHERE run_id = ? AND role = 'reviewer' ORDER BY created_at, rowid", lab.runId).map((w) => w.purpose);
/** Step until the run leaves REVIEWING or stops waiting on a worker. */
async function settle(max = 12) {
  let out = await reviewingStep(lab.ctx());
  for (let i = 0; i < max && out.waiting && state() === 'REVIEWING'; i++) out = await reviewingStep(lab.ctx());
  return out;
}

describe('a review finding that only disputes the fail-before outcome Orbit recorded', () => {
  it('the dotnet stall shape: it is reported as a note and sent to neither repair nor the Inquisition', async () => {
    // The fresh review of the tree (below) disputes the outcome again, so nothing approves the tree.
    const { cand } = await setup(answer('REPAIR_REQUIRED', [TEST_1]));
    record(cand, 'REPAIR_REQUIRED', [TEST_1, COR_1, PRAC_1]);
    await settle();
    expect(state()).not.toBe('REPAIRING');
    expect(state()).not.toBe('INQUISITION');
    expect(repairs()).toBe(0);
    expect(existsSync(briefPath(lab.ctx(), 2))).toBe(false);
    expect(listDecisions(lab.db, lab.runId, { kind: 'repair.brief' })).toEqual([]);
    const f = listFindings(lab.db, lab.runId).find((x) => x.externalId === 'TEST-1')!;
    expect(f.status).toBe('advisory');
    expect(f.resolution).toMatch(/no repair can change/);
    expect((f.resolutionJson as { blocking: boolean }).blocking).toBe(false);
    // Each note is on the run's record, where the report and the timeline read it: the first review's and the fresh one's.
    const notes = listDecisions(lab.db, lab.runId, { kind: 'review.finding.noted' }).map((d) => d.summary);
    expect(notes).toHaveLength(2);
    for (const n of notes) expect(n).toMatch(/^TEST-1 \(high\) noted: /);
    // No review approved the tree: the run stops and says why, instead of spending an attempt it cannot use.
    expect(state()).toBe('BLOCKED');
    const reason = getRun(lab.db, lab.runId).outcomeReason ?? '';
    expect(reason).toMatch(/TEST-1/);
    expect(reason).toMatch(/no repair can change/);
    expect(outcome().noted_findings).toEqual([expect.objectContaining({ external_id: 'TEST-1', severity: 'high' })]);
  });

  it('the python advisory shape: a finding about prices is not sent to the Inquisition as financial effects', async () => {
    const { cand } = await setup();
    record(cand, 'REPAIR_REQUIRED', [PRICING_TEST_1]);
    await reviewingStep(lab.ctx());
    expect(transitionsTo('INQUISITION')).toBe(0);
    expect(transitionsTo('REPAIRING')).toBe(0);
    expect(listFindings(lab.db, lab.runId)[0]!.status).toBe('advisory');
  });

  it('next to an approval it does not hold back delivery', async () => {
    const { cand } = await setup();
    record(cand, 'APPROVE', [TEST_1]);
    await reviewingStep(lab.ctx());
    expect(state()).toBe('DELIVERING');
  });

  it('next to a real defect, only the defect is repaired', async () => {
    const { cand } = await setup();
    const defect: IngestedFinding = { externalId: 'COR-2', severity: 'high', category: 'correctness', location: 'apps/calc.mjs:2', path: 'apps/calc.mjs', line: 2, claim: 'mul accepts non-numeric arguments and returns NaN instead of throwing', evidence: 'mul("a", 2) is NaN', suggestedValidation: 'Add a test asserting mul("a", 2) throws' };
    record(cand, 'REPAIR_REQUIRED', [TEST_1, defect]);
    await reviewingStep(lab.ctx());
    expect(state()).toBe('REPAIRING');
    const repair = JSON.parse(lab.db.get<{ data_json: string }>('SELECT data_json FROM events WHERE run_id = ? AND type = ?', lab.runId, REVIEW_REPAIR_EVENT)!.data_json) as { findings: { external_id: string }[] };
    expect(repair.findings.map((f) => f.external_id)).toEqual(['COR-2']);
  });
});

// The lead's follow-up to item 3 of the addendum: a REPAIR_REQUIRED review that asked for repair only through notes ended
// BLOCKED, and resume came back to the same BLOCKED, a dead end. Such a review now gets exactly one fresh review of the
// same tree, told that the recorded outcome is not a finding. Only that reviewer's APPROVE lets the run go on.
describe('a review that asked for repair only through notes gets one fresh review of the same tree', () => {
  it('the dotnet stall shape, same provider: one fresh review, and its approval moves the run on to delivery', async () => {
    const { cand, reviewer, ledger } = await setup(approve, { sameProvider: true });
    ledger.consume('review_rounds', 1);
    record(cand, 'REPAIR_REQUIRED', [TEST_1, COR_1, PRAC_1], 'claude');
    await settle();
    expect(state()).toBe('DELIVERING');
    // Exactly one fresh review, under a purpose of its own, charged to review_rounds like any review.
    expect(reviewerPurposes()).toEqual([`review-fresh:${cand.id}#1`]);
    expect(ledger.state('review_rounds').used).toBe(2);
    expect(listDecisions(lab.db, lab.runId, { kind: 'review.fresh' })).toHaveLength(1);
    // Its prompt names the noted finding and says the recorded outcome is not a finding a repair could answer.
    const prompt = reviewer.specs[0]!.prompt;
    expect(prompt).toMatch(/fresh review/i);
    expect(prompt).toContain('TEST-1 (high)');
    expect(prompt).toMatch(/the fail-before outcome Orbit recorded for the base revision is not a finding and cannot be repaired by changing the candidate/i);
    expect(prompt).toContain(TEST_1.claim);
    // Nothing went to repair or the Inquisition, and the approval that clears the tree is the reviewer's own.
    expect(repairs()).toBe(0);
    expect(transitionsTo('INQUISITION')).toBe(0);
    const live = listReviews(lab.db, lab.runId, { treeHash: cand.treeHash });
    expect(live.map((r) => r.verdict)).toEqual(['APPROVE']);
    // The first review is kept on the record, superseded rather than deleted, and its note stays a residual risk.
    const all = listReviews(lab.db, lab.runId, { includeInvalidated: true });
    expect(all).toHaveLength(2);
    expect(all[0]!.invalidatedAt).not.toBeNull();
    expect(listFindings(lab.db, lab.runId).find((x) => x.externalId === 'TEST-1')!.status).toBe('advisory');
  });

  it.each(['REPAIR_REQUIRED', 'BLOCK'] as const)('a fresh review that blocks again (%s) ends BLOCKED naming the findings, and resuming starts no second one', async (verdict) => {
    const { cand, reviewer } = await setup(answer(verdict, [TEST_1]), { sameProvider: true });
    record(cand, 'REPAIR_REQUIRED', [TEST_1, COR_1, PRAC_1], 'claude');
    await settle();
    expect(state()).toBe('BLOCKED');
    expect(reviewer.specs).toHaveLength(1);
    expect(repairs()).toBe(0);
    expect(transitionsTo('INQUISITION')).toBe(0);
    const reason = getRun(lab.db, lab.runId).outcomeReason ?? '';
    expect(reason).toMatch(/fresh review/);
    expect(reason).toMatch(/TEST-1 \(high/);
    expect(outcome().fresh_review).toMatchObject({ started: true, verdict, findings: [expect.objectContaining({ external_id: 'TEST-1', severity: 'high' })] });
    // orbit resume returns the run to REVIEWING: the same BLOCKED follows, without another review.
    lab.db.run("UPDATE runs SET state = 'REVIEWING' WHERE id = ?", lab.runId);
    await settle();
    expect(state()).toBe('BLOCKED');
    expect(reviewer.specs).toHaveLength(1);
    expect(reviewerPurposes()).toEqual([`review-fresh:${cand.id}#1`]);
  });

  it('with review_rounds at its hard cap, no fresh review starts and the run ends BLOCKED naming the notes', async () => {
    const { cand, reviewer, ledger } = await setup(approve, { sameProvider: true });
    const rounds = ledger.state('review_rounds');
    ledger.consume('review_rounds', rounds.hard_cap - rounds.used);
    record(cand, 'REPAIR_REQUIRED', [TEST_1, COR_1, PRAC_1], 'claude');
    await settle();
    expect(state()).toBe('BLOCKED');
    expect(reviewer.specs).toHaveLength(0);
    expect(reviewerPurposes()).toEqual([]);
    expect(listDecisions(lab.db, lab.runId, { kind: 'review.fresh' })).toEqual([]);
    expect(ledger.state('review_rounds').used).toBe(rounds.hard_cap);
    const reason = getRun(lab.db, lab.runId).outcomeReason ?? '';
    expect(reason).toMatch(/TEST-1/);
    expect(reason).toMatch(/review_rounds/);
    expect(outcome().fresh_review).toMatchObject({ started: false });
  });

  it('a defect of the candidate the fresh review reports is repaired like any finding, and the note is not', async () => {
    const defect: IngestedFinding = { externalId: 'COR-2', severity: 'high', category: 'correctness', location: 'apps/calc.mjs:2', path: 'apps/calc.mjs', line: 2, claim: 'mul accepts non-numeric arguments and returns NaN instead of throwing', evidence: 'mul("a", 2) is NaN', suggestedValidation: 'Add a test asserting mul("a", 2) throws' };
    const { cand, reviewer } = await setup(answer('REPAIR_REQUIRED', [TEST_1, defect]), { sameProvider: true });
    record(cand, 'REPAIR_REQUIRED', [TEST_1, COR_1, PRAC_1], 'claude');
    await settle();
    expect(state()).toBe('REPAIRING');
    expect(reviewer.specs).toHaveLength(1);
    const repair = JSON.parse(lab.db.get<{ data_json: string }>('SELECT data_json FROM events WHERE run_id = ? AND type = ?', lab.runId, REVIEW_REPAIR_EVENT)!.data_json) as { findings: { external_id: string }[] };
    expect(repair.findings.map((f) => f.external_id)).toEqual(['COR-2']);
  });

  it('never approves by itself: a review asking for repair through a real defect is repaired, not re-reviewed', async () => {
    const { cand, reviewer } = await setup(approve, { sameProvider: true });
    const defect: IngestedFinding = { externalId: 'COR-2', severity: 'high', category: 'correctness', location: 'apps/calc.mjs:2', path: 'apps/calc.mjs', line: 2, claim: 'mul accepts non-numeric arguments and returns NaN instead of throwing', evidence: 'mul("a", 2) is NaN', suggestedValidation: 'Add a test asserting mul("a", 2) throws' };
    record(cand, 'REPAIR_REQUIRED', [TEST_1, defect], 'claude');
    await settle();
    expect(state()).toBe('REPAIRING');
    expect(reviewer.specs).toHaveLength(0);
    expect(listDecisions(lab.db, lab.runId, { kind: 'review.fresh' })).toEqual([]);
  });
});
