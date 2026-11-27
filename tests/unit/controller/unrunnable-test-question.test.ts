// Issue #261 changes what a missing mapped test gets, and nothing else: a test the candidate has but no check can run
// alone keeps its reason, its cause and the question that offers a person the acceptance.
import { afterEach, describe, expect, it } from 'vitest';
import { routeFailBefore } from '../../../src/controller/fail-before.ts';
import { getRun } from '../../../src/controller/run-store.ts';
import { criterionProofEntry, criterionTests } from '../../../src/evidence/criterion-tests.ts';
import { listQuestions } from '../../../src/inquisition/store.ts';
import { checkDef } from '../evidence/fixtures.ts';
import { contract, fakeSnapshot } from '../evidence/report-fixtures.ts';
import { addCandidate, addEvidence, makeUnitLab, setContract, type UnitLab } from './coverage-helpers.ts';

let lab: UnitLab;
afterEach(() => lab?.cleanup());

const PATH = 'tests/here.test.ts';
const REASON = `no check AC-1 cites has a tests_command that runs ${PATH} alone`;

describe('a mapped test that no check can run alone', () => {
  it('is not established as not probed, and a person is asked whether to accept it', async () => {
    const mapped = contract({ acceptance_criteria: [{ id: 'AC-1', statement: 'caps the cost', proof: ['p'], mandatory: true, check_ids: ['unit'], tests: [PATH] }], required_check_ids: ['unit'] });
    const units = criterionTests(mapped, fakeSnapshot([checkDef('unit')]), () => true)[0]!;
    const fb = criterionProofEntry(units, { mode: 'required', base: null, candidate: null, skipped: { cause: 'not-probed', reason: 'no mapped test can run alone' }, accepted: [] });
    expect(fb).toMatchObject({ outcome: 'not-established', cause: 'not-probed', reason: REASON });

    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'VERIFYING'] });
    setContract(lab);
    const cand = addCandidate(lab);
    const ev = addEvidence(lab, cand, { verdict: 'INCOMPLETE', acceptance_evidence: [{ criterion_id: 'AC-1', status: 'blocked', artifacts: [], note: `fail-before not established: ${fb.reason}`, fail_before: fb }] });
    await routeFailBefore(lab.ctx(), cand, ev, async () => null);

    const questions = listQuestions(lab.db, lab.runId, { status: 'open' });
    expect(questions).toHaveLength(1);
    expect(questions[0]!.question).toBe(`Accept AC-1 without fail-before evidence for candidate 1 (tree ${cand.treeHash.slice(0, 12)})?`);
    expect(questions[0]!.evidence).toContain(`AC-1: ${REASON}`);
    expect(questions[0]!.evidence).toContain(`new tests: ${PATH}`);
    expect(questions[0]!.options.map((o) => o.label)).toEqual(['accept', 'decline']);
    expect(getRun(lab.db, lab.runId).outcomeReason).toContain(`it was not established: AC-1: ${REASON}`);
  });
});
