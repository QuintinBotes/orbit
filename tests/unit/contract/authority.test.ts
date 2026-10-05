import { describe, expect, it } from 'vitest';
import { modesRequestedInGoal, reconcileAuthority } from '../../../src/contract/authority.ts';
import { draftContract } from '../../../src/contract/draft.ts';
import { config, BASELINE, planner, snapshot } from './fixtures.ts';

/** The spec section 20 invocation, trimmed to its authority prose. */
const SPEC_GOAL = [
  'Implement CSV export for the reports page.',
  'Run unsupervised using the autonomous-delivery profile.',
  'You may edit application code, tests, and documentation; install dependencies from the existing lockfile; commit; push an orbit/* branch; open a draft PR; and repair CI up to three cycles.',
  'Do not change dependencies, CI definitions, infrastructure, secrets, permissions, or production state. Do not merge.',
].join('\n');

describe('modesRequestedInGoal', () => {
  it('reads a profile or mode named in the goal, and ignores ordinary uses of the words', () => {
    expect(modesRequestedInGoal(SPEC_GOAL).map((m) => m.mode)).toEqual(['autonomous-delivery']);
    expect(modesRequestedInGoal('Run this in supervised mode.').map((m) => m.mode)).toEqual(['supervised']);
    expect(modesRequestedInGoal('Use release mode for this one').map((m) => m.mode)).toEqual(['release']);
    expect(modesRequestedInGoal('Build an autonomous vehicle simulator and a release checklist page.')).toEqual([]);
  });

  it('skips a mode the goal rules out', () => {
    expect(modesRequestedInGoal('Do not use the autonomous-delivery profile.')).toEqual([]);
  });
});

describe('reconcileAuthority', () => {
  const autonomous = { ...config(), mode: 'autonomous' as const };

  it('flags a profile and actions that the policy does not back as exceeding it', () => {
    const noDelivery = { ...autonomous, actions: { ...autonomous.actions, push_task_branch: false, open_pull_request: false } };
    const found = reconcileAuthority(SPEC_GOAL, noDelivery);
    expect(found.map((m) => [m.kind, m.subject])).toEqual([
      ['exceeds-policy', 'mode:autonomous-delivery'],
      ['exceeds-policy', 'actions.push_task_branch'],
      ['exceeds-policy', 'actions.open_pull_request'],
    ]);
    expect(found[0]!.detail).toContain('the policy governs');
    expect(found[1]!.phrase).toMatch(/^push an orbit\/\* branch/);
  });

  it('reports nothing when the goal agrees with the policy', () => {
    expect(reconcileAuthority(SPEC_GOAL, config())).toEqual([]);
    expect(reconcileAuthority('Fix the flaky export test.', config())).toEqual([]);
  });

  it('notes "do not merge" as stricter than a policy that allows merge, and does not escalate it', () => {
    const merging = { ...config(), actions: { ...config().actions, merge: true } };
    const found = reconcileAuthority('Fix it. Do not merge.', merging);
    expect(found).toEqual([{ kind: 'stricter-than-policy', subject: 'actions.merge', phrase: 'merge', detail: expect.stringContaining('the goal forbids merge') }]);
  });

  it('flags a request to merge or deploy that the policy forbids, but not "merge conflicts" or a negated request', () => {
    const found = reconcileAuthority('Fix it, then merge the PR and deploy to production.', config());
    expect(found.map((m) => m.subject)).toEqual(['actions.merge', 'actions.deploy_production']);
    expect(reconcileAuthority('Resolve the merge conflicts in the parser.', config())).toEqual([]);
    expect(reconcileAuthority('Never deploy to production from here.', config())).toEqual([]);
  });

  it('notes a narrower mode as stricter, not exceeding', () => {
    const found = reconcileAuthority('Use supervised mode.', config());
    expect(found).toEqual([{ kind: 'stricter-than-policy', subject: 'mode:supervised', phrase: expect.any(String), detail: expect.stringContaining('less authority') }]);
  });
});

describe('draftContract surfaces a goal that asks for more than the policy allows', () => {
  const goal = 'Implement CSV export for the reports page. Run it in release mode, then merge the PR.';

  it('records an authority-mismatch adjustment per claim and a needs-decision assumption for each excess', () => {
    const { contract, adjustments } = draftContract({ goal, plannerOutput: planner(), snapshot: snapshot(), baselineRevision: BASELINE, taskId: 'ORB-001' });
    const mismatches = adjustments.filter((a) => a.kind === 'authority-mismatch');
    expect(mismatches.map((a) => a.subject)).toEqual(['mode:release', 'actions.merge']);
    expect(mismatches[0]!.reason).toContain('the policy governs');
    const open = contract.assumptions.filter((a) => a.status === 'needs-decision');
    expect(open).toHaveLength(2);
    expect(open.every((a) => a.statement.includes('more authority than the policy grants'))).toBe(true);
    expect(contract.delivery.merge).toBe(false);
  });

  it('records nothing for a goal that agrees with the policy', () => {
    const { contract, adjustments } = draftContract({ goal: SPEC_GOAL, plannerOutput: planner(), snapshot: snapshot(), baselineRevision: BASELINE, taskId: 'ORB-001' });
    expect(adjustments.filter((a) => a.kind === 'authority-mismatch')).toEqual([]);
    expect(contract.assumptions.some((a) => a.statement.includes('more authority than the policy grants'))).toBe(false);
  });
});
