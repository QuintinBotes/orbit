import { describe, expect, it } from 'vitest';
import { BASELINE_MATERIAL_TOPICS, draftContract, type DraftContractInput } from '../../../src/contract/draft.ts';
import { policyHashOf, validateContract } from '../../../src/contract/validate.ts';
import { isOrbitError } from '../../../src/core/errors.ts';
import { BASELINE, check, planner, snapshot, uiConfig } from './fixtures.ts';

function input(overrides: Partial<DraftContractInput> = {}): DraftContractInput {
  return {
    goal: 'Implement CSV export for the reports page.',
    plannerOutput: planner(),
    snapshot: snapshot(),
    baselineRevision: BASELINE,
    taskId: 'ORB-001',
    ...overrides,
  };
}

describe('draftContract', () => {
  it('builds a valid contract with controller-fixed ids, hash, baseline and delivery', () => {
    const inp = input();
    const { contract } = draftContract(inp);
    expect(validateContract(contract, inp.snapshot)).toBe(contract);
    expect(contract.task_id).toBe('ORB-001');
    expect(contract.original_goal).toBe(inp.goal);
    expect(contract.objective).toBe('Add CSV export for filtered reports.');
    expect(contract.acceptance_criteria.map((c) => c.id)).toEqual(['AC-1', 'AC-2']);
    expect(contract.assumptions).toEqual([{ id: 'AS-1', statement: 'Exports use the existing report query.', status: 'unverified' }]);
    expect(contract.policy_hash).toBe(policyHashOf(inp.snapshot));
    expect(contract.baseline_revision).toBe(BASELINE);
    expect(contract.delivery).toEqual({ draft_pr: true, merge: false });
    expect(contract.version).toBe('1.0');
  });

  it('is deterministic', () => {
    expect(draftContract(input())).toEqual(draftContract(input()));
  });

  it('drops check ids the policy does not define and records why', () => {
    const { contract, adjustments } = draftContract(input());
    expect(contract.acceptance_criteria[0]!.check_ids).toEqual(['reports-tests']);
    expect(contract.required_check_ids).not.toContain('curl-evil');
    expect(contract.required_check_ids).not.toContain('made-up-check');
    const dropped = adjustments.filter((a) => a.kind === 'check-dropped').map((a) => a.subject);
    expect(dropped.sort()).toEqual(['curl-evil', 'made-up-check']);
    expect(adjustments.find((a) => a.subject === 'curl-evil')?.reason).toContain('does not define');
  });

  it('adds checks cited by criteria and checks the policy marks mandatory', () => {
    const { contract, adjustments } = draftContract(input());
    expect(contract.required_check_ids).toEqual(['build', 'reports-tests', 'lint', 'typecheck']);
    expect(adjustments).toContainEqual({ kind: 'check-added', subject: 'reports-tests', reason: 'criterion AC-1 cites it as evidence' });
    expect(adjustments).toContainEqual({ kind: 'check-added', subject: 'lint', reason: 'the policy marks it mandatory' });
  });

  it('cleans proposed text: trims, removes blank and duplicate entries', () => {
    const { contract } = draftContract(input());
    expect(contract.acceptance_criteria[0]!.proof).toEqual(['A multi-page filtered fixture produces every matching record.']);
    expect(contract.non_goals).toEqual(['Change report filtering semantics']);
  });

  it('always escalates the spec section 10 topics, without duplicating planner topics', () => {
    const { contract, adjustments } = draftContract(input());
    const topics = contract.escalation.material_topics;
    expect(topics.slice(0, 2)).toEqual(['Security rules', 'billing']);
    for (const t of BASELINE_MATERIAL_TOPICS) expect(topics.map((x) => x.toLowerCase())).toContain(t);
    expect(topics.filter((t) => t.toLowerCase() === 'security rules')).toHaveLength(1);
    expect(adjustments.filter((a) => a.kind === 'topic-added')).toHaveLength(3);
  });

  describe('allowed paths', () => {
    it('keeps contained globs, narrows broad ones to the scope and drops the rest', () => {
      const plan = planner({ allowed_paths: ['apps/api/**', '**', 'infra/**', 'apps/[x]/**'] });
      const { contract, adjustments } = draftContract(input({ plannerOutput: plan }));
      expect(contract.allowed_paths).toEqual(['apps/api/**', 'apps/**', 'packages/**', 'tests/**', 'docs/**']);
      expect(adjustments).toContainEqual(expect.objectContaining({ kind: 'path-narrowed', subject: '**' }));
      expect(adjustments).toContainEqual({ kind: 'path-dropped', subject: 'infra/**', reason: 'not inside the policy scope' });
      expect(adjustments).toContainEqual({ kind: 'path-dropped', subject: 'apps/[x]/**', reason: 'glob syntax cannot be checked against the policy scope' });
    });

    it('falls back to the expected changed files inside the scope when no glob fits', () => {
      const plan = planner({
        allowed_paths: ['infra/**'],
        expected_changed_files: [
          { path: 'apps/api/export.ts', change: 'add', reason: 'r' },
          { path: 'infra/main.tf', change: 'modify', reason: 'r' },
          { path: 'apps/api/[id].ts', change: 'add', reason: 'r' },
        ],
      });
      const { contract, adjustments } = draftContract(input({ plannerOutput: plan }));
      expect(contract.allowed_paths).toEqual(['apps/api/export.ts']);
      expect(adjustments).toContainEqual({ kind: 'path-added', subject: 'apps/api/export.ts', reason: 'expected changed file inside the policy scope' });
    });

    it('refuses when nothing proposed lies inside the scope', () => {
      const plan = planner({ allowed_paths: ['infra/**'], expected_changed_files: [{ path: 'infra/main.tf', change: 'modify', reason: 'r' }] });
      try {
        draftContract(input({ plannerOutput: plan }));
        throw new Error('expected failure');
      } catch (err) {
        expect(isOrbitError(err, 'CONTRACT_INVALID')).toBe(true);
      }
    });
  });

  it('records material unresolved decisions as needs-decision assumptions, so only a human can settle them', () => {
    const plan = planner({
      unresolved_decisions: [
        { question: 'Export every matching record or only the current page?', options: ['all', 'page'], recommendation: 'all', material: true, affected_criteria: ['all-records'] },
        { question: 'Name the file export.csv or report.csv?', options: ['export.csv', 'report.csv'], recommendation: null, material: false, affected_criteria: [] },
        { question: '  Exports use the existing report query. ', options: ['yes', 'no'], recommendation: null, material: true, affected_criteria: [] },
      ],
    });
    const { contract, adjustments } = draftContract(input({ plannerOutput: plan }));
    expect(contract.assumptions).toEqual([
      { id: 'AS-1', statement: 'Exports use the existing report query.', status: 'needs-decision' },
      { id: 'AS-2', statement: 'Export every matching record or only the current page?', status: 'needs-decision' },
    ]);
    expect(adjustments).toContainEqual({ kind: 'decision-recorded', subject: 'AS-2', reason: 'the planner left a material decision unresolved' });
    expect(adjustments).toContainEqual({ kind: 'decision-recorded', subject: 'AS-1', reason: 'the planner left a material decision unresolved' });
  });

  it('sets draft_pr from the policy and never turns merge on', () => {
    expect(draftContract(input({ snapshot: snapshot({ merge: true }) })).contract.delivery).toEqual({ draft_pr: true, merge: false });
    expect(draftContract(input({ snapshot: snapshot({ pullRequest: 'ready' }) })).contract.delivery.draft_pr).toBe(false);
    expect(draftContract(input({ snapshot: snapshot({ openPullRequest: false }) })).contract.delivery.draft_pr).toBe(false);
  });

  it('binds an explicit policy hash when given', () => {
    const hash = `sha256:${'c'.repeat(64)}`;
    expect(draftContract(input({ policyHash: hash })).contract.policy_hash).toBe(hash);
  });

  it('rejects planner output that does not match its schema', () => {
    const bad = { ...planner(), extra: true };
    try {
      draftContract(input({ plannerOutput: bad }));
      throw new Error('expected failure');
    } catch (err) {
      expect(isOrbitError(err, 'MALFORMED_OUTPUT')).toBe(true);
    }
  });

  it('fails contract validation when the proposal has no mandatory criterion', () => {
    const plan = planner();
    for (const c of plan.criteria) c.mandatory = false;
    try {
      draftContract(input({ plannerOutput: plan }));
      throw new Error('expected failure');
    } catch (err) {
      expect(isOrbitError(err, 'CONTRACT_INVALID')).toBe(true);
    }
  });

  it('fails when the scope reaches UI paths but no criterion is a UI criterion', () => {
    const snap = snapshot({ ui: uiConfig(), checks: { 'reports-tests': check('reports-tests'), build: check('build') } });
    const plan = planner({ allowed_paths: ['apps/web/**'] });
    try {
      draftContract(input({ snapshot: snap, plannerOutput: plan }));
      throw new Error('expected failure');
    } catch (err) {
      expect(isOrbitError(err, 'CONTRACT_INVALID')).toBe(true);
    }
    // An optional ui criterion does not make UI evidence required.
    plan.criteria[1]!.ui = true;
    expect(() => draftContract(input({ snapshot: snap, plannerOutput: plan }))).toThrow(/no mandatory criterion is marked ui/);
    plan.criteria[0]!.ui = true;
    expect(draftContract(input({ snapshot: snap, plannerOutput: plan })).contract.acceptance_criteria[0]!.ui).toBe(true);
  });
});
