// A run's release environment in the goal contract (docs/gaps.md G50): `delivery.environment` is optional, set by the
// controller from `orbit run --environment`, validated against the release profile, and never changed by an amendment.
import { describe, expect, it } from 'vitest';
import { applyAmendment } from '../../../src/contract/amend.ts';
import { draftContract } from '../../../src/contract/draft.ts';
import { contractProblems, releaseEnvironmentProblem, validateContract } from '../../../src/contract/validate.ts';
import type { ReleaseEnvironment } from '../../../src/policy/types.ts';
import { BASELINE, contract, planner, snapshot } from './fixtures.ts';

const env = (): ReleaseEnvironment => ({ deploy_command: ['node', '-e', '0'], allowed_branches: ['main'], require_ci_green: false, network_hosts: [], timeout_seconds: 30, verify_command: null });

function releaseSnapshot() {
  const snap = snapshot({ merge: true });
  snap.config.mode = 'release';
  snap.config.actions.deploy_production = true;
  snap.config.release = { merge: { method: 'squash', require_checks: [], delete_branch: false, mark_ready: true }, environments: { staging: env(), canary: env() } };
  return snap;
}

describe('releaseEnvironmentProblem', () => {
  it('accepts a defined environment in release mode and explains every other case', () => {
    const snap = releaseSnapshot();
    expect(releaseEnvironmentProblem(snap.config, 'canary')).toBeNull();
    expect(releaseEnvironmentProblem(snap.config, 'production')).toBe('"production" is not defined in release.environments (defined: staging, canary)');
    expect(releaseEnvironmentProblem(snap.config, 'Staging')).toMatch(/is not defined/);
    expect(releaseEnvironmentProblem(snap.config, '__proto__')).toMatch(/is not defined/);
    expect(releaseEnvironmentProblem({ ...snap.config, release: null }, 'staging')).toBe('the policy has no release profile (release: in the configuration)');
    expect(releaseEnvironmentProblem({ ...snap.config, mode: 'autonomous-delivery' }, 'staging')).toMatch(/only in mode release \(the policy's mode is autonomous-delivery\)/);
    expect(releaseEnvironmentProblem({ ...snap.config, release: { ...snap.config.release!, environments: {} } }, 'staging')).toMatch(/\(defined: none\)/);
  });
});

describe('delivery.environment', () => {
  it('is carried from the run into the drafted contract, and absent when the run names none', () => {
    const snap = releaseSnapshot();
    const base = { goal: 'Ship the acme widget.', plannerOutput: planner(), snapshot: snap, baselineRevision: BASELINE, taskId: 'ORB-001' };
    expect(draftContract({ ...base, environment: 'canary' }).contract.delivery).toEqual({ draft_pr: true, merge: false, environment: 'canary' });
    expect(draftContract(base).contract.delivery).toEqual({ draft_pr: true, merge: false });
    expect(draftContract({ ...base, environment: null }).contract.delivery).toEqual({ draft_pr: true, merge: false });
  });

  it('is accepted when the release profile defines it, and refused otherwise, with the schema pattern guarding the name', () => {
    const snap = releaseSnapshot();
    const named = (environment: string) => contract(snap, { delivery: { draft_pr: false, merge: false, environment } });
    expect(contractProblems(named('staging'), snap)).toEqual([]);
    expect(validateContract(named('canary'), snap).delivery.environment).toBe('canary');
    expect(contractProblems(named('production'), snap)).toEqual(['delivery.environment: "production" is not defined in release.environments (defined: staging, canary)']);
    expect(contractProblems(named('Not A Name'), snap).join('\n')).toMatch(/schema: .*\/delivery\/environment/);
    // Outside release mode there is nothing to deploy to.
    const plain = snapshot();
    expect(contractProblems(contract(plain, { delivery: { draft_pr: false, merge: false, environment: 'staging' } }), plain).join('\n')).toMatch(/delivery\.environment: a release environment can be named only in mode release/);
  });

  it('survives an approved set_delivery amendment: the person chose it at orbit run', () => {
    const snap = releaseSnapshot();
    const c = contract(snap, { delivery: { draft_pr: true, merge: false, environment: 'staging' } });
    const res = applyAmendment(c, { change: { op: 'set_delivery', draft_pr: true, merge: true }, evidence: 'release notes', reason: 'ship it' }, { snapshot: snap, approvedBy: 'dec-1a2b3c4d5e6f' });
    expect(res.contract.delivery).toEqual({ draft_pr: true, merge: true, environment: 'staging' });
    expect(res.record.old_value).toEqual({ draft_pr: true, merge: false, environment: 'staging' });
  });
});
