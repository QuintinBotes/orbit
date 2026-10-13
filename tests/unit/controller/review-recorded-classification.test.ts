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

async function setup(reviewer?: Parameters<typeof scriptedAdapter>[1]) {
  lab = makeUnitLab({
    path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING'],
    deps: { schedulerProbe: { availableParallelism: () => 16, freemem: () => 64_000 * 1024 * 1024 } },
    tweak: (c) => {
      c.providers.codex = { ...c.providers.codex!, data_policy_eligible: true, model: 'gpt-6-astra' };
    },
  });
  const codex = scriptedAdapter(lab, reviewer ?? (({ spec }) => okResult({ verdict: 'APPROVE', candidate_revision: spec.prompt.match(/candidate revision ([0-9a-f]{40})/)?.[1] ?? '0'.repeat(40), findings: [] })));
  lab.deps.adapters = { claude: claude(), codex };
  validateModels(lab);
  for (const e of lab.deps.registry.list()) if (e.provider === 'codex') lab.deps.registry.markAvailability(e.modelId, 'codex-cli', true, 'test');
  const repo = await giveRepository(lab);
  setContract(lab, { baseline_revision: repo.base, allowed_paths: ['apps/calc.mjs'] });
  initLedger(lab);
  writeFileSync(join(repo.worktree, 'apps', 'calc.mjs'), 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n');
  const cand = await snapshotCandidate({ db: lab.db, clock: lab.clock, repoRoot: lab.repo, worktree: repo.worktree, runId: lab.runId, baseRev: repo.base, attempt: 1, workerId: null });
  lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 1, 'implementation.attempt', 'x', ?)", lab.runId, JSON.stringify({ attempt: 1 }));
  lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 1, 'implementation.candidate', 'x', ?)", lab.runId, JSON.stringify({ attempt: 1, candidate_id: cand.id }));
  addEvidence(lab, cand);
  return { cand, codex };
}

function record(cand: { id: string; treeHash: string }, verdict: 'APPROVE' | 'REPAIR_REQUIRED' | 'BLOCK', findings: IngestedFinding[]) {
  const n = listReviews(lab.db, lab.runId, { includeInvalidated: true }).length + 1;
  return recordReview(lab.db, { id: `rev-${n}`, runId: lab.runId, candidateId: cand.id, treeHash: cand.treeHash, round: n, provider: 'codex', model: null, workerId: null, verdict, packetSha256: null, findings }, lab.clock);
}

const state = () => getRun(lab.db, lab.runId).state;
const transitionsTo = (to: string) => lab.db.all("SELECT 1 AS x FROM events WHERE run_id = ? AND type = 'state.transition' AND to_state = ?", lab.runId, to).length;
const repairs = () => lab.db.all('SELECT 1 AS x FROM events WHERE run_id = ? AND type = ?', lab.runId, REVIEW_REPAIR_EVENT).length;

describe('a review finding that only disputes the fail-before outcome Orbit recorded', () => {
  it('the dotnet stall shape: it is reported as a note and sent to neither repair nor the Inquisition', async () => {
    const { cand } = await setup();
    record(cand, 'REPAIR_REQUIRED', [TEST_1, COR_1, PRAC_1]);
    await reviewingStep(lab.ctx());
    expect(state()).not.toBe('REPAIRING');
    expect(state()).not.toBe('INQUISITION');
    expect(repairs()).toBe(0);
    expect(existsSync(briefPath(lab.ctx(), 2))).toBe(false);
    expect(listDecisions(lab.db, lab.runId, { kind: 'repair.brief' })).toEqual([]);
    const f = listFindings(lab.db, lab.runId).find((x) => x.externalId === 'TEST-1')!;
    expect(f.status).toBe('advisory');
    expect(f.resolution).toMatch(/no repair can change/);
    expect((f.resolutionJson as { blocking: boolean }).blocking).toBe(false);
    // The note is on the run's record, where the report and the timeline read it.
    expect(listDecisions(lab.db, lab.runId, { kind: 'review.finding.noted' }).map((d) => d.summary)).toEqual([expect.stringMatching(/^TEST-1 \(high\) noted: /)]);
    // No review approved the tree: the run stops and says why, instead of spending an attempt it cannot use.
    expect(state()).toBe('BLOCKED');
    const reason = getRun(lab.db, lab.runId).outcomeReason ?? '';
    expect(reason).toMatch(/TEST-1/);
    expect(reason).toMatch(/no repair can change/);
    expect(JSON.parse(getRun(lab.db, lab.runId).outcomeJson!).noted_findings).toEqual([expect.objectContaining({ external_id: 'TEST-1', severity: 'high' })]);
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
