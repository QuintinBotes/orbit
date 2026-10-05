import { describe, expect, it } from 'vitest';
import { applyAmendment, assessAmendment, baselineExceptionProposal, type AmendmentChange, type AmendmentProposal } from '../../../src/contract/amend.ts';
import { isOrbitError, type OrbitError, type OrbitErrorCode } from '../../../src/core/errors.ts';
import type { ContractAmendment, GoalContract } from '../../../src/contract/types.ts';
import { contract, snapshot, uiConfig } from './fixtures.ts';

const HUMAN = 'dec-1a2b3c4d5e6f';

function proposal(change: AmendmentChange): AmendmentProposal {
  return { change, evidence: 'reports.ts:40 paginates before export', reason: 'make the criterion testable' };
}

function setup(t: Parameters<typeof snapshot>[0] = {}) {
  const snap = snapshot(t);
  return { snap, c: contract(snap) };
}

function failure(fn: () => unknown): OrbitError {
  try {
    fn();
  } catch (err) {
    if (isOrbitError(err)) return err;
    throw err;
  }
  throw new Error('expected an OrbitError');
}

function expectCode(fn: () => unknown, code: OrbitErrorCode): OrbitError {
  const err = failure(fn);
  expect(err.code).toBe(code);
  return err;
}

describe('applyAmendment: allowed without approval', () => {
  it('clarifies a mandatory criterion when the rewrite keeps every word and adds only emphasis', () => {
    const { snap, c } = setup();
    const statement = 'Export all matching records, including all records beyond the current page, always.';
    const { contract: next, record } = applyAmendment(c, proposal({ op: 'clarify_criterion', criterion_id: 'AC-1', statement }), { snapshot: snap });
    expect(next.acceptance_criteria[0]!.statement).toBe(statement);
    const expected: ContractAmendment = {
      field: 'acceptance_criteria[AC-1].statement',
      old_value: c.acceptance_criteria[0]!.statement,
      new_value: statement,
      evidence: 'reports.ts:40 paginates before export',
      reason: 'make the criterion testable',
      approval_required: false,
      affected_verification: ['AC-1'],
    };
    expect(record).toEqual(expected);
  });

  it('clarifies the objective', () => {
    const { snap, c } = setup();
    const { contract: next, record } = applyAmendment(c, proposal({ op: 'clarify_objective', objective: 'Add a complete CSV export for all filtered reports.' }), { snapshot: snap });
    expect(next.objective).toBe('Add a complete CSV export for all filtered reports.');
    expect(record.affected_verification).toEqual(['AC-1', 'AC-2', 'AC-3', 'review']);
  });

  it('adds a derived criterion with policy checks, and requires those checks', () => {
    const { snap, c } = setup();
    const { contract: next, record } = applyAmendment(
      c,
      proposal({ op: 'add_criterion', statement: 'An empty result exports only the header row.', proof: ['Empty fixture test.'], mandatory: true, ui: false, check_ids: ['build'] }),
      { snapshot: snap },
    );
    expect(next.acceptance_criteria.at(-1)).toEqual({ id: 'AC-4', statement: 'An empty result exports only the header row.', proof: ['Empty fixture test.'], mandatory: true, ui: false, check_ids: ['build'] });
    expect(next.required_check_ids).toContain('build');
    expect(record).toMatchObject({ field: 'acceptance_criteria', old_value: null, approval_required: false, affected_verification: ['AC-4', 'check:build'] });
  });

  it('adds proof, skipping entries already present', () => {
    const { snap, c } = setup();
    const { contract: next } = applyAmendment(c, proposal({ op: 'add_proof', criterion_id: 'AC-2', proof: ['header ordering and escaping tests pass', 'Quote fields with commas.'] }), { snapshot: snap });
    expect(next.acceptance_criteria[1]!.proof).toEqual([...c.acceptance_criteria[1]!.proof, 'Quote fields with commas.']);
  });

  it('rewords proof entries when each old entry survives as a clarification', () => {
    const { snap, c } = setup();
    const proof = ['Header ordering and escaping tests all pass.', 'Snapshot of the whole generated file matches exactly.'];
    const { contract: next, record } = applyAmendment(c, proposal({ op: 'replace_proof', criterion_id: 'AC-2', proof }), { snapshot: snap });
    expect(next.acceptance_criteria[1]!.proof).toEqual(proof);
    expect(record.approval_required).toBe(false);
  });

  it('makes an optional criterion mandatory and adds required checks', () => {
    const { snap, c } = setup();
    const step = applyAmendment(c, proposal({ op: 'set_mandatory', criterion_id: 'AC-3', mandatory: true }), { snapshot: snap });
    expect(step.contract.acceptance_criteria[2]!.mandatory).toBe(true);
    const { contract: next, record } = applyAmendment(step.contract, proposal({ op: 'add_required_checks', criterion_id: 'AC-3', check_ids: ['build'] }), { snapshot: snap });
    expect(next.required_check_ids).toContain('build');
    expect(next.acceptance_criteria[2]!.check_ids).toEqual(['build']);
    expect(record.field).toBe('acceptance_criteria[AC-3].check_ids');
  });

  it('narrows allowed_paths', () => {
    const { snap, c } = setup();
    const { contract: next } = applyAmendment(c, proposal({ op: 'set_allowed_paths', allowed_paths: ['apps/api/export/**'] }), { snapshot: snap });
    expect(next.allowed_paths).toEqual(['apps/api/export/**']);
  });

  it('records assumptions and escalation topics, and safer delivery', () => {
    const { snap, c } = setup();
    let next = applyAmendment(c, proposal({ op: 'set_assumption', assumption_id: null, statement: 'CSV uses comma separators.', status: 'supported' }), { snapshot: snap }).contract;
    expect(next.assumptions.at(-1)).toEqual({ id: 'AS-3', statement: 'CSV uses comma separators.', status: 'supported' });
    next = applyAmendment(next, proposal({ op: 'set_assumption', assumption_id: 'AS-1', statement: 'Exports reuse the report query.', status: 'supported' }), { snapshot: snap }).contract;
    expect(next.assumptions[0]).toEqual({ id: 'AS-1', statement: 'Exports reuse the report query.', status: 'supported' });
    next = applyAmendment(next, proposal({ op: 'add_escalation_topic', topic: 'personal data' }), { snapshot: snap }).contract;
    expect(next.escalation.material_topics).toEqual(['security rules', 'personal data']);
  });

  it('never mutates the input contract, and the record does not alias either contract', () => {
    const { snap, c } = setup();
    const before = structuredClone(c);
    const res = applyAmendment(c, proposal({ op: 'add_proof', criterion_id: 'AC-1', proof: ['More proof.'] }), { snapshot: snap });
    expect(c).toEqual(before);
    res.contract.acceptance_criteria[0]!.proof.push('mutated later');
    c.acceptance_criteria[0]!.proof.push('mutated later');
    expect(res.record.old_value).toEqual(before.acceptance_criteria[0]!.proof);
    expect(res.record.new_value).toEqual([...before.acceptance_criteria[0]!.proof, 'More proof.']);
  });
});

describe('applyAmendment: needs a human decision', () => {
  const cases: [string, AmendmentChange][] = [
    ['weakening a mandatory criterion by dropping words', { op: 'clarify_criterion', criterion_id: 'AC-1', statement: 'Export matching records on the current page.' }],
    ['narrowing a mandatory criterion with a qualifier', { op: 'clarify_criterion', criterion_id: 'AC-1', statement: 'Export all matching records, including records beyond the current page, only for admins.' }],
    ['narrowing a mandatory criterion with plain words', { op: 'clarify_criterion', criterion_id: 'AC-1', statement: 'Export all matching records, including records beyond the current page, for the demo dataset.' }],
    ['adding detail to a mandatory criterion by rewriting it', { op: 'clarify_criterion', criterion_id: 'AC-1', statement: 'Export all matching records, including records beyond the current page, in one CSV file.' }],
    ['narrowing the objective with plain words', { op: 'clarify_objective', objective: 'Add CSV export for filtered reports in the demo tenant.' }],
    ['weakening a proof entry to a test double', { op: 'replace_proof', criterion_id: 'AC-1', proof: ['A multi-page filtered fixture produces every matching record against a stubbed exporter.'] }],
    ['redefining the objective', { op: 'clarify_objective', objective: 'Add JSON export for reports.' }],
    ['removing a mandatory criterion', { op: 'remove_criterion', criterion_id: 'AC-2' }],
    ['removing an optional criterion and its proof', { op: 'remove_criterion', criterion_id: 'AC-3' }],
    ['making a mandatory criterion optional', { op: 'set_mandatory', criterion_id: 'AC-1', mandatory: false }],
    ['removing a proof entry', { op: 'replace_proof', criterion_id: 'AC-2', proof: ['Header ordering and escaping tests pass.'] }],
    ['rewriting a proof entry away', { op: 'replace_proof', criterion_id: 'AC-1', proof: ['Manual check of one page.'] }],
    ['removing a required check', { op: 'remove_required_checks', criterion_id: null, check_ids: ['reports-tests'] }],
    ['removing check evidence from a criterion', { op: 'remove_required_checks', criterion_id: 'AC-1', check_ids: ['reports-tests'] }],
    ['widening allowed_paths inside the policy', { op: 'set_allowed_paths', allowed_paths: ['apps/**', 'tests/reports/**'] }],
    ['adding a non-goal', { op: 'add_non_goal', non_goal: 'Handle more than one page' }],
    ['removing a non-goal', { op: 'remove_non_goal', non_goal: 'change report filtering semantics' }],
    ['resolving a needs-decision assumption', { op: 'set_assumption', assumption_id: 'AS-2', statement: 'Dates use the user local time zone.', status: 'supported' }],
    ['removing an escalation topic', { op: 'remove_escalation_topic', topic: 'Security Rules' }],
    ['turning a draft pull request into a ready one', { op: 'set_delivery', draft_pr: false, merge: false }],
  ];

  it.each(cases)('rejects %s without approval and carries the would-be record', (_label, change) => {
    const { snap, c } = setup({ merge: true });
    const err = expectCode(() => applyAmendment(c, proposal(change), { snapshot: snap }), 'POLICY_DENIED');
    expect(err.message).toContain('needs a human decision');
    const record = err.details?.record as ContractAmendment;
    expect(record.approval_required).toBe(true);
    expect(record.evidence).toBe('reports.ts:40 paginates before export');
    expect((err.details?.approvalReasons as string[]).length).toBeGreaterThan(0);
  });

  it.each(cases)(
    'applies %s with a human decision and records that approval was required',
    (_label, change) => {
      const { snap, c } = setup({ merge: true });
      const res = applyAmendment(c, proposal(change), { snapshot: snap, approvedBy: HUMAN });
      expect(res.record.approval_required).toBe(true);
      expect(res.approvedBy).toBe(HUMAN);
    },
  );

  it('lets the same detail apply directly as a derived criterion, which removes no obligation', () => {
    const { snap, c } = setup();
    const { contract: next, record } = applyAmendment(
      c,
      proposal({ op: 'add_criterion', statement: 'The export is a single CSV file.', proof: ['Export test counts one file.'], mandatory: true, ui: false, check_ids: [] }),
      { snapshot: snap },
    );
    expect(record.approval_required).toBe(false);
    expect(next.acceptance_criteria[0]).toEqual(c.acceptance_criteria[0]);
  });

  it('flags the same changes through assessAmendment without throwing', () => {
    const { snap, c } = setup();
    const a = assessAmendment(c, proposal({ op: 'remove_criterion', criterion_id: 'AC-1' }), { snapshot: snap });
    expect(a.approvalReasons).toEqual(['removes mandatory criterion AC-1 and its proof']);
    expect(a.forbidden).toEqual([]);
    expect(a.next.acceptance_criteria.map((x) => x.id)).toEqual(['AC-2', 'AC-3']);
  });

  it('still validates the result after approval', () => {
    const { snap, c } = setup();
    const only = applyAmendment(c, proposal({ op: 'set_mandatory', criterion_id: 'AC-2', mandatory: false }), { snapshot: snap, approvedBy: HUMAN }).contract;
    // AC-1 is now the only mandatory criterion; making it optional leaves none.
    expectCode(() => applyAmendment(only, proposal({ op: 'set_mandatory', criterion_id: 'AC-1', mandatory: false }), { snapshot: snap, approvedBy: HUMAN }), 'CONTRACT_INVALID');
  });
});

describe('applyAmendment: never allowed, even with approval', () => {
  it('cannot widen allowed_paths beyond the policy scope', () => {
    const { snap, c } = setup();
    for (const approvedBy of [undefined, HUMAN]) {
      const err = expectCode(() => applyAmendment(c, proposal({ op: 'set_allowed_paths', allowed_paths: ['apps/**', 'infra/**'] }), { snapshot: snap, approvedBy }), 'POLICY_DENIED');
      expect(err.details?.forbidden).toEqual(['allowed path "infra/**" is outside the policy scope']);
    }
    expectCode(() => applyAmendment(c, proposal({ op: 'set_allowed_paths', allowed_paths: ['**'] }), { snapshot: snap, approvedBy: HUMAN }), 'POLICY_DENIED');
    expectCode(() => applyAmendment(c, proposal({ op: 'set_allowed_paths', allowed_paths: ['apps/[x]/**'] }), { snapshot: snap, approvedBy: HUMAN }), 'POLICY_DENIED');
  });

  it('cannot add a check the policy does not define (no check commands)', () => {
    const { snap, c } = setup();
    expectCode(() => applyAmendment(c, proposal({ op: 'add_required_checks', criterion_id: null, check_ids: ['curl-attacker'] }), { snapshot: snap, approvedBy: HUMAN }), 'POLICY_DENIED');
    expectCode(
      () => applyAmendment(c, proposal({ op: 'add_criterion', statement: 'Deploys.', proof: ['deploy log'], mandatory: true, ui: false, check_ids: ['deploy-prod'] }), { snapshot: snap, approvedBy: HUMAN }),
      'POLICY_DENIED',
    );
  });

  it('cannot remove a check the policy marks mandatory', () => {
    const { snap, c } = setup();
    const err = expectCode(() => applyAmendment(c, proposal({ op: 'remove_required_checks', criterion_id: null, check_ids: ['lint'] }), { snapshot: snap, approvedBy: HUMAN }), 'POLICY_DENIED');
    expect(err.details?.forbidden).toEqual(['check "lint" is mandatory in the policy and cannot be removed']);
  });

  it('cannot flip merge on unless the policy allows merge', () => {
    const { snap, c } = setup();
    expectCode(() => applyAmendment(c, proposal({ op: 'set_delivery', draft_pr: true, merge: true }), { snapshot: snap }), 'POLICY_DENIED');
    expectCode(() => applyAmendment(c, proposal({ op: 'set_delivery', draft_pr: true, merge: true }), { snapshot: snap, approvedBy: HUMAN }), 'POLICY_DENIED');
    const permissive = setup({ merge: true });
    expectCode(() => applyAmendment(permissive.c, proposal({ op: 'set_delivery', draft_pr: true, merge: true }), { snapshot: permissive.snap }), 'POLICY_DENIED');
    const res = applyAmendment(permissive.c, proposal({ op: 'set_delivery', draft_pr: true, merge: true }), { snapshot: permissive.snap, approvedBy: HUMAN });
    expect(res.contract.delivery.merge).toBe(true);
    // Turning merge back off is always allowed.
    expect(applyAmendment(res.contract, proposal({ op: 'set_delivery', draft_pr: true, merge: false }), { snapshot: permissive.snap }).contract.delivery.merge).toBe(false);
  });

  it('cannot make the only mandatory ui criterion optional while the scope reaches UI paths', () => {
    const snap = snapshot({ ui: uiConfig() });
    const c = contract(snap, { allowed_paths: ['apps/web/**'] });
    c.acceptance_criteria[0]!.ui = true;
    expectCode(() => applyAmendment(c, proposal({ op: 'set_mandatory', criterion_id: 'AC-1', mandatory: false }), { snapshot: snap, approvedBy: HUMAN }), 'CONTRACT_INVALID');
  });

  it('cannot turn on a pull request the policy does not allow', () => {
    const snap = snapshot({ openPullRequest: false });
    const c: GoalContract = contract(snap, { delivery: { draft_pr: false, merge: false } });
    expectCode(() => applyAmendment(c, proposal({ op: 'set_delivery', draft_pr: true, merge: false }), { snapshot: snap, approvedBy: HUMAN }), 'POLICY_DENIED');
  });
});

describe('applyAmendment: malformed proposals', () => {
  it.each([
    ['an unknown criterion', proposal({ op: 'clarify_criterion', criterion_id: 'AC-9', statement: 'x' })],
    ['an unknown assumption', proposal({ op: 'set_assumption', assumption_id: 'AS-9', statement: 'x', status: 'supported' })],
    ['an unknown non-goal', proposal({ op: 'remove_non_goal', non_goal: 'nothing like this' })],
    ['an unknown operation', proposal({ op: 'grant_admin' } as unknown as AmendmentChange)],
    ['a no-op', proposal({ op: 'set_mandatory', criterion_id: 'AC-1', mandatory: true })],
    ['a duplicate proof entry', proposal({ op: 'add_proof', criterion_id: 'AC-1', proof: ['a multi-page filtered fixture produces every matching record'] })],
    ['missing evidence', { ...proposal({ op: 'add_escalation_topic', topic: 'x' }), evidence: '   ' }],
    ['missing reason', { ...proposal({ op: 'add_escalation_topic', topic: 'x' }), reason: '' }],
    ['blank proof', proposal({ op: 'add_criterion', statement: 'x', proof: ['  '], mandatory: false, ui: false, check_ids: [] })],
    ['a bad check id', proposal({ op: 'add_required_checks', criterion_id: null, check_ids: ['rm -rf /'] })],
    ['no change object', { evidence: 'e', reason: 'r' } as unknown as AmendmentProposal],
  ])('rejects %s as CONTRACT_INVALID', (_label, p) => {
    const { snap, c } = setup();
    expectCode(() => applyAmendment(c, p, { snapshot: snap }), 'CONTRACT_INVALID');
  });

  it('rejects an approval that is not a decision id', () => {
    const { snap, c } = setup();
    expectCode(() => applyAmendment(c, proposal({ op: 'remove_criterion', criterion_id: 'AC-3' }), { snapshot: snap, approvedBy: 'yes please; drop table' }), 'POLICY_DENIED');
  });
});

describe('applyAmendment: criterion ids', () => {
  it('never reissues the id of a removed criterion when given the amendment history', () => {
    const { snap, c } = setup();
    const removed = applyAmendment(c, proposal({ op: 'remove_criterion', criterion_id: 'AC-3' }), { snapshot: snap, approvedBy: HUMAN });
    const add = proposal({ op: 'add_criterion', statement: 'Show a progress bar.', proof: ['Component test.'], mandatory: false, ui: false, check_ids: [] });
    const next = applyAmendment(removed.contract, add, { snapshot: snap, history: [removed.record] });
    expect(next.contract.acceptance_criteria.map((ac) => ac.id)).toEqual(['AC-1', 'AC-2', 'AC-4']);
    expect(next.record.affected_verification).toEqual(['AC-4']);
  });

  it('counts ids that only appear inside earlier records', () => {
    const { snap, c } = setup();
    const history: ContractAmendment[] = [
      { field: 'acceptance_criteria', old_value: null, new_value: { id: 'AC-7' }, evidence: 'e', reason: 'r', approval_required: false, affected_verification: [] },
    ];
    const add = proposal({ op: 'add_criterion', statement: 'Show a progress bar.', proof: ['Component test.'], mandatory: false, ui: false, check_ids: [] });
    expect(applyAmendment(c, add, { snapshot: snap, history }).contract.acceptance_criteria.at(-1)!.id).toBe('AC-8');
  });
});

describe('accept_baseline_failure (a pre-existing failure the contract accepts)', () => {
  const FP = 'test-failure:reports-tests:3f9a2c';
  const accept = (fingerprint = FP, checkId = 'reports-tests') => baselineExceptionProposal({ checkId, fingerprint, excerpt: 'AssertionError in reports.test.ts' }, 'the export suite already fails on main');
  const recorded = [{ checkId: 'reports-tests', fingerprint: FP }];

  it('always needs a human decision, even when the fingerprint matches the recorded baseline failure', () => {
    const { snap, c } = setup();
    const a = assessAmendment(c, accept(), { snapshot: snap, baselineFailures: recorded });
    expect(a.forbidden).toEqual([]);
    expect(a.approvalReasons).toEqual(['accepts the failure of check reports-tests that already exists on the base revision as an exception']);
    expect(a.record).toMatchObject({ field: 'baseline_exceptions', old_value: [], approval_required: true, affected_verification: ['check:reports-tests', 'AC-1'] });
    const err = expectCode(() => applyAmendment(c, accept(), { snapshot: snap, baselineFailures: recorded }), 'POLICY_DENIED');
    expect(err.message).toContain('needs a human decision');
  });

  it('adds the exception to the contract once a recorded human decision approves it', () => {
    const { snap, c } = setup();
    const { contract: next, record, approvedBy } = applyAmendment(c, accept(), { snapshot: snap, baselineFailures: recorded, approvedBy: HUMAN });
    expect(approvedBy).toBe(HUMAN);
    expect(next.baseline_exceptions).toEqual([{ check_id: 'reports-tests', fingerprint: FP, reason: 'the export suite already fails on main' }]);
    expect(record.new_value).toEqual(next.baseline_exceptions);
    expect(c.baseline_exceptions).toBeUndefined();
  });

  it('is forbidden when the fingerprint differs from the recorded baseline failure, even with approval', () => {
    const { snap, c } = setup();
    const err = expectCode(() => applyAmendment(c, accept('test-failure:reports-tests:other'), { snapshot: snap, baselineFailures: recorded, approvedBy: HUMAN }), 'POLICY_DENIED');
    expect(err.message).toContain('fingerprint does not equal the failure recorded on the base revision');
  });

  it('is forbidden for a check that did not fail on the base revision, and when no baseline was supplied', () => {
    const { snap, c } = setup();
    const none = expectCode(() => applyAmendment(c, accept(), { snapshot: snap, baselineFailures: [], approvedBy: HUMAN }), 'POLICY_DENIED');
    expect(none.message).toContain('did not fail on the base revision');
    const unknown = expectCode(() => applyAmendment(c, accept(), { snapshot: snap, approvedBy: HUMAN }), 'POLICY_DENIED');
    expect(unknown.message).toContain('cannot be confirmed');
    const unrecorded = expectCode(() => applyAmendment(c, accept(), { snapshot: snap, baselineFailures: [{ checkId: 'reports-tests', fingerprint: null }], approvedBy: HUMAN }), 'POLICY_DENIED');
    expect(unrecorded.message).toContain('fingerprint does not equal');
  });

  it('rejects a check the contract does not require, a repeat of the same exception, and a failure without a fingerprint', () => {
    const { snap, c } = setup();
    expectCode(() => applyAmendment(c, accept(FP, 'build'), { snapshot: snap, baselineFailures: [{ checkId: 'build', fingerprint: FP }], approvedBy: HUMAN }), 'CONTRACT_INVALID');
    const withException = applyAmendment(c, accept(), { snapshot: snap, baselineFailures: recorded, approvedBy: HUMAN }).contract;
    expectCode(() => applyAmendment(withException, accept(), { snapshot: snap, baselineFailures: recorded, approvedBy: HUMAN }), 'CONTRACT_INVALID');
    expectCode(() => baselineExceptionProposal({ checkId: 'reports-tests', fingerprint: null }), 'CONTRACT_INVALID');
  });

  it('replaces an earlier exception for the same check when the failure has since changed', () => {
    const { snap, c } = setup();
    const first = applyAmendment(c, accept(), { snapshot: snap, baselineFailures: recorded, approvedBy: HUMAN }).contract;
    const second = applyAmendment(first, accept('test-failure:reports-tests:new'), { snapshot: snap, baselineFailures: [{ checkId: 'reports-tests', fingerprint: 'test-failure:reports-tests:new' }], approvedBy: HUMAN }).contract;
    expect(second.baseline_exceptions).toHaveLength(1);
    expect(second.baseline_exceptions![0]!.fingerprint).toBe('test-failure:reports-tests:new');
  });

  it('is not an operation a model can propose: the inquisitor schema does not list it', async () => {
    const { readFileSync } = await import('node:fs');
    const schema = readFileSync(new URL('../../../schemas/inquisitor-output.schema.json', import.meta.url), 'utf8');
    expect(schema).not.toContain('accept_baseline_failure');
  });
});
