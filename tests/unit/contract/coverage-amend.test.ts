import { describe, expect, it } from 'vitest';
import { applyAmendment, assessAmendment } from '../../../src/contract/amend.ts';
import type { AmendmentChange, AmendmentProposal, HumanAmendmentChange } from '../../../src/contract/amend.ts';
import type { ContractAmendment } from '../../../src/contract/types.ts';
import { isOrbitError, type OrbitErrorCode } from '../../../src/core/errors.ts';
import { contract, snapshot, type ConfigTweaks } from './fixtures.ts';

const HUMAN = 'dec-1a2b3c4d5e6f';

const proposal = (change: AmendmentChange | HumanAmendmentChange): AmendmentProposal => ({ change, evidence: 'reports.ts:40 paginates before export', reason: 'make the criterion testable' }) as AmendmentProposal;

function setup(t: ConfigTweaks = {}) {
  const snap = snapshot(t);
  return { snap, c: contract(snap) };
}

function rejection(fn: () => unknown, code: OrbitErrorCode): string {
  try {
    fn();
  } catch (err) {
    if (!isOrbitError(err, code)) throw err;
    return err.message;
  }
  throw new Error('expected a rejection');
}

const invalid = (change: AmendmentChange | HumanAmendmentChange, message: RegExp, t: ConfigTweaks = {}) => {
  const { snap, c } = setup(t);
  expect(rejection(() => assessAmendment(c, proposal(change), { snapshot: snap }), 'CONTRACT_INVALID')).toMatch(message);
};

describe('malformed amendment fields', () => {
  it('rejects a list field that is not a list or that ends up too short', () => {
    invalid({ op: 'add_proof', criterion_id: 'AC-1', proof: 'one entry' as never }, /proof must be a list/);
    invalid({ op: 'add_proof', criterion_id: 'AC-1', proof: [] }, /proof needs at least 1 entry/);
    invalid({ op: 'replace_proof', criterion_id: 'AC-1', proof: ['   '] }, /proof must be a non-empty string/);
    invalid({ op: 'add_required_checks', criterion_id: null, check_ids: 'lint' as never }, /check_ids must be a list/);
    invalid({ op: 'add_required_checks', criterion_id: null, check_ids: [] }, /check_ids needs at least 1 entry/);
    invalid({ op: 'add_required_checks', criterion_id: null, check_ids: ['not a check id'] }, /check_ids entries must be check ids/);
    invalid({ op: 'add_required_checks', criterion_id: null, check_ids: [5 as never] }, /check_ids entries must be check ids/);
  });

  it('rejects an unknown criterion, an unknown operation and a missing change', () => {
    invalid({ op: 'clarify_criterion', criterion_id: 'AC-99', statement: 'Whatever statement text.' }, /no criterion AC-99/);
    invalid({ op: 'launch_rockets' } as never, /unknown amendment operation "launch_rockets"/);
    const { snap, c } = setup();
    expect(rejection(() => assessAmendment(c, null as never, { snapshot: snap }), 'CONTRACT_INVALID')).toMatch(/must have a change/);
    expect(rejection(() => assessAmendment(c, { change: 'x', evidence: 'e', reason: 'r' } as never, { snapshot: snap }), 'CONTRACT_INVALID')).toMatch(/must have a change/);
    expect(rejection(() => assessAmendment(c, { change: { op: 'add_non_goal', non_goal: 'x' }, evidence: '  ', reason: 'r' }, { snapshot: snap }), 'CONTRACT_INVALID')).toMatch(/evidence must be a non-empty string/);
  });

  it('rejects changes that alter nothing', () => {
    const { c } = setup();
    invalid({ op: 'clarify_objective', objective: ` ${c.objective} ` }, /does not alter the contract/);
    invalid({ op: 'clarify_criterion', criterion_id: 'AC-1', statement: c.acceptance_criteria[0]!.statement }, /does not alter the contract/);
    invalid({ op: 'replace_proof', criterion_id: 'AC-1', proof: [...c.acceptance_criteria[0]!.proof] }, /does not alter the contract/);
    invalid({ op: 'add_non_goal', non_goal: 'change report FILTERING semantics' }, /does not alter the contract/);
    invalid({ op: 'add_escalation_topic', topic: 'Security Rules' }, /does not alter the contract/);
    invalid({ op: 'add_required_checks', criterion_id: null, check_ids: ['lint'] }, /does not alter the contract/);
    invalid({ op: 'remove_required_checks', criterion_id: null, check_ids: ['build'] }, /does not alter the contract/);
    invalid({ op: 'remove_required_checks', criterion_id: 'AC-1', check_ids: ['build'] }, /does not alter the contract/);
    invalid({ op: 'remove_required_checks', criterion_id: 'AC-2', check_ids: ['build'] }, /does not alter the contract/);
    invalid({ op: 'set_allowed_paths', allowed_paths: [...c.allowed_paths] }, /does not alter the contract/);
    invalid({ op: 'set_assumption', assumption_id: 'AS-1', statement: 'Exports use the existing report query.', status: 'unverified' }, /does not alter the contract/);
    invalid({ op: 'set_mandatory', criterion_id: 'AC-1', mandatory: true }, /does not alter the contract/);
    invalid({ op: 'set_delivery', draft_pr: true, merge: false }, /does not alter the contract/);
  });

  it('rejects wrongly typed flags and values', () => {
    invalid({ op: 'add_criterion', statement: 'A derived criterion.', proof: ['A test.'], mandatory: 'yes' as never, ui: false, check_ids: [] }, /mandatory and ui must be booleans/);
    invalid({ op: 'add_criterion', statement: 'A derived criterion.', proof: ['A test.'], mandatory: true, ui: 1 as never, check_ids: [] }, /mandatory and ui must be booleans/);
    invalid({ op: 'set_mandatory', criterion_id: 'AC-1', mandatory: 'no' as never }, /mandatory must be a boolean/);
    invalid({ op: 'set_delivery', draft_pr: 'yes' as never, merge: false }, /draft_pr and merge must be booleans/);
    invalid({ op: 'set_delivery', draft_pr: true, merge: 0 as never }, /draft_pr and merge must be booleans/);
    invalid({ op: 'set_allowed_paths', allowed_paths: 'apps/**' as never }, /allowed_paths must be a non-empty list/);
    invalid({ op: 'set_allowed_paths', allowed_paths: [] }, /allowed_paths must be a non-empty list/);
    invalid({ op: 'set_assumption', assumption_id: null, statement: 'A new assumption.', status: 'maybe' as never }, /unknown assumption status/);
    invalid({ op: 'set_assumption', assumption_id: 'AS-9', statement: 'A new assumption.', status: 'supported' }, /no assumption AS-9/);
    invalid({ op: 'remove_non_goal', non_goal: 'something never listed' }, /no such non-goal/);
    invalid({ op: 'remove_escalation_topic', topic: 'something never listed' }, /no such escalation topic/);
  });

  it('rejects a baseline exception whose check id is not shaped like one', () => {
    invalid({ op: 'accept_baseline_failure', check_id: '../etc', fingerprint: 'fp-1', reason: 'known' } as never, /check_id must be a check id/);
  });
});

describe('amendment effects not covered elsewhere', () => {
  it('lets a lower-case comparison find a duplicated non-goal and keeps list entries distinct', () => {
    const { snap, c } = setup();
    const a = assessAmendment(c, proposal({ op: 'add_proof', criterion_id: 'AC-3', proof: ['One more test.', 'one MORE test.'] }), { snapshot: snap });
    expect(a.next.acceptance_criteria[2]!.proof).toEqual(['Component test for the toast.', 'One more test.']);
  });

  it('adds a criterion without check ids and lists no check among its affected verification', () => {
    const { snap, c } = setup();
    const a = assessAmendment(c, proposal({ op: 'add_criterion', statement: 'A derived criterion.', proof: ['A test.'], mandatory: false, ui: false, check_ids: [] }), { snapshot: snap });
    expect(a.record.affected_verification).toEqual(['AC-4']);
    expect(a.approvalReasons).toEqual([]);
  });

  it('skips a required check that is already required while adding it to a criterion', () => {
    const { snap, c } = setup();
    const a = assessAmendment(c, proposal({ op: 'add_required_checks', criterion_id: 'AC-2', check_ids: ['lint'] }), { snapshot: snap });
    expect(a.next.required_check_ids).toEqual(c.required_check_ids);
    expect(a.next.acceptance_criteria[1]!.check_ids).toEqual(['lint']);
    expect(a.record.field).toBe('acceptance_criteria[AC-2].check_ids');
    expect(a.record.old_value).toEqual({ required_check_ids: c.required_check_ids, check_ids: [] });
  });

  it('removes several required checks at once and strips them from criteria that cite them', () => {
    const { snap, c } = setup({ checks: undefined });
    const free = { ...snap, config: { ...snap.config, checks: { 'reports-tests': snap.config.checks['reports-tests']!, lint: { ...snap.config.checks.lint!, mandatory: false } } } };
    const a = assessAmendment(c, proposal({ op: 'remove_required_checks', criterion_id: null, check_ids: ['lint', 'reports-tests'] }), { snapshot: free });
    expect(a.approvalReasons).toEqual(['removes required checks lint, reports-tests']);
    expect(a.next.acceptance_criteria[0]!.check_ids).toEqual([]);
    expect(a.record.affected_verification).toEqual(['AC-1', 'check:lint', 'check:reports-tests']);
  });

  it('removes one required check with singular wording', () => {
    const { snap, c } = setup();
    const lax = { ...snap, config: { ...snap.config, checks: { ...snap.config.checks, 'reports-tests': { ...snap.config.checks['reports-tests']!, mandatory: false } } } };
    const a = assessAmendment(c, proposal({ op: 'remove_required_checks', criterion_id: null, check_ids: ['reports-tests'] }), { snapshot: lax });
    expect(a.approvalReasons).toEqual(['removes required check reports-tests']);
  });

  it('removes check evidence from a criterion and leaves the contract-wide list alone', () => {
    const { snap, c } = setup();
    const a = assessAmendment(c, proposal({ op: 'remove_required_checks', criterion_id: 'AC-1', check_ids: ['reports-tests'] }), { snapshot: snap });
    expect(a.approvalReasons).toEqual(['removes check evidence reports-tests from criterion AC-1']);
    expect(a.next.acceptance_criteria[0]!.check_ids).toEqual([]);
    expect(a.next.required_check_ids).toEqual(c.required_check_ids);
  });

  it('treats a criterion with no check list as having no check evidence to remove', () => {
    const { c, snap } = setup();
    const bare = structuredClone(c);
    delete bare.acceptance_criteria[0]!.check_ids;
    expect(rejection(() => assessAmendment(bare, proposal({ op: 'remove_required_checks', criterion_id: 'AC-1', check_ids: ['reports-tests'] }), { snapshot: snap }), 'CONTRACT_INVALID')).toMatch(/does not alter/);
    const added = assessAmendment(bare, proposal({ op: 'add_required_checks', criterion_id: 'AC-1', check_ids: ['build'] }), { snapshot: snap });
    expect(added.record.old_value).toEqual({ required_check_ids: bare.required_check_ids, check_ids: [] });
    expect(added.next.acceptance_criteria[0]!.check_ids).toEqual(['build']);
  });

  it('reports glob syntax it cannot check, ignoring non-strings, and still flags the scope', () => {
    const { snap, c } = setup();
    const a = assessAmendment(c, proposal({ op: 'set_allowed_paths', allowed_paths: ['apps/api/**', 'apps/api/**', 7 as never, 'apps/{a,b/**'] }), { snapshot: snap });
    expect(a.forbidden.filter((f) => f.includes('cannot be checked against the policy scope'))).toHaveLength(2);
    expect(a.next.allowed_paths).toEqual(['apps/api/**']);
  });

  it('treats a policy without scope as outside scope for every allowed path', () => {
    const { snap, c } = setup();
    const noScope = { ...snap, config: { ...snap.config, scope: undefined as never } };
    const a = assessAmendment(c, proposal({ op: 'set_allowed_paths', allowed_paths: ['apps/api/**'] }), { snapshot: noScope });
    expect(a.forbidden).toEqual(['allowed path "apps/api/**" is outside the policy scope']);
  });

  it('treats a policy without checks as defining none, so no check can be added', () => {
    const { snap, c } = setup();
    const noChecks = { ...snap, config: { ...snap.config, checks: undefined as never } };
    const a = assessAmendment(c, proposal({ op: 'add_required_checks', criterion_id: null, check_ids: ['build'] }), { snapshot: noChecks });
    expect(a.forbidden).toEqual(['check "build" is not defined by the policy, and a contract cannot add check commands']);
    const removal = assessAmendment(c, proposal({ op: 'remove_required_checks', criterion_id: null, check_ids: ['lint'] }), { snapshot: noChecks });
    expect(removal.forbidden).toEqual([]);
  });

  it('refuses to reissue an id found only in history records that carry no affected list', () => {
    const { snap, c } = setup();
    const history = [
      { field: 'acceptance_criteria', old_value: { id: 'AC-7' }, new_value: null, evidence: 'e', reason: 'r', approval_required: true } as unknown as ContractAmendment,
      { field: 'x', old_value: ['AC-9'], new_value: 'not-an-id', evidence: 'e', reason: 'r', approval_required: false, affected_verification: ['AC-8', 'check:lint'] } as ContractAmendment,
    ];
    const a = assessAmendment(c, proposal({ op: 'add_criterion', statement: 'A derived criterion.', proof: ['A test.'], mandatory: false, ui: false, check_ids: [] }), { snapshot: snap, history });
    expect(a.next.acceptance_criteria.at(-1)!.id).toBe('AC-9');
  });

  it('forbids opening a pull request when the policy turns them off in either way', () => {
    const base = setup({ openPullRequest: false });
    const turnedOn = { ...base.c, delivery: { draft_pr: false, merge: false } };
    const a = assessAmendment(turnedOn, proposal({ op: 'set_delivery', draft_pr: true, merge: false }), { snapshot: base.snap });
    expect(a.forbidden).toEqual(['the policy does not allow opening a pull request']);
    const none = setup({ pullRequest: 'none' });
    const b = assessAmendment({ ...none.c, delivery: { draft_pr: false, merge: false } }, proposal({ op: 'set_delivery', draft_pr: true, merge: false }), { snapshot: none.snap });
    expect(b.forbidden).toEqual(['the policy does not allow opening a pull request']);
    const allowed = setup();
    const c2 = assessAmendment({ ...allowed.c, delivery: { draft_pr: false, merge: false } }, proposal({ op: 'set_delivery', draft_pr: true, merge: false }), { snapshot: allowed.snap });
    expect(c2.forbidden).toEqual([]);
  });

  it('forbids merge when the policy has no actions section at all', () => {
    const { snap, c } = setup();
    const noActions = { ...snap, config: { ...snap.config, actions: undefined as never } };
    const a = assessAmendment(c, proposal({ op: 'set_delivery', draft_pr: true, merge: true }), { snapshot: noActions });
    expect(a.forbidden).toEqual(['the policy does not allow merge']);
    expect(a.approvalReasons).toEqual(['turns on merge']);
  });

  it('applies an approved assumption resolution and rejects an unapproved one', () => {
    const { snap, c } = setup();
    const change = { op: 'set_assumption', assumption_id: 'AS-2', statement: 'Dates use UTC.', status: 'supported' } as const;
    expect(rejection(() => applyAmendment(c, proposal(change), { snapshot: snap }), 'POLICY_DENIED')).toMatch(/resolves needs-decision assumption AS-2/);
    const done = applyAmendment(c, proposal(change), { snapshot: snap, approvedBy: HUMAN });
    expect(done.contract.assumptions[1]).toEqual({ id: 'AS-2', statement: 'Dates use UTC.', status: 'supported' });
    expect(done.approvedBy).toBe(HUMAN);
  });
});
