import { defaultConfig } from '../../../src/policy/config.ts';
import { checkConfigHash } from '../../../src/policy/snapshot.ts';
import type { CheckDefinition, PolicySnapshot } from '../../../src/policy/types.ts';
import type { GoalContract } from '../../../src/contract/types.ts';
import type { Candidate, CheckResult, CheckStatus, ScopeReport } from '../../../src/evidence/types.ts';
import { snapshotHash } from '../../../src/policy/snapshot.ts';
import { checkDef } from './fixtures.ts';

export function fakeSnapshot(checks: CheckDefinition[], configure: (c: PolicySnapshot['config']) => void = () => {}): PolicySnapshot {
  const config = defaultConfig('autonomous');
  config.checks = Object.fromEntries(checks.map((c) => [c.id, c]));
  configure(config);
  return {
    schema: 'orbit.policy/1',
    run_id: 'orb-test-1',
    created_at: '2026-10-03T00:00:00.000Z',
    repo_root: '/repo',
    config,
    effective_protected_paths: [],
    check_config_hashes: Object.fromEntries(checks.map((c) => [c.id, checkConfigHash(c)])),
  };
}

export const CANDIDATE: Candidate = { id: 'cand-1', runId: 'orb-test-1', seq: 1, attempt: 1, commitSha: 'c0ffee', treeHash: 'tree-a', parentSha: 'base0' };

export function contract(over: Partial<GoalContract> = {}): GoalContract {
  return {
    version: '1.0',
    task_id: 'ORB-001',
    original_goal: 'acme goal',
    objective: 'acme objective',
    acceptance_criteria: [
      { id: 'AC-1', statement: 'exports all rows', proof: ['export test passes'], mandatory: true, check_ids: ['tests'] },
      { id: 'AC-2', statement: 'escapes values', proof: ['escaping test passes'], mandatory: true, check_ids: ['tests', 'lint'] },
    ],
    non_goals: [],
    allowed_paths: ['apps/**'],
    required_check_ids: ['tests', 'lint'],
    assumptions: [],
    delivery: { draft_pr: true, merge: false },
    policy_hash: 'sha256:x',
    baseline_revision: 'base0',
    escalation: { material_topics: [] },
    ...over,
  };
}

export const CLEAN_SCOPE: ScopeReport = {
  allowed_paths_pass: true,
  forbidden_paths_changed: [],
  out_of_scope_paths_changed: [],
  changed_files: 2,
  changed_lines: 10,
  within_size_limits: true,
  lockfile_changed: false,
  dependency_manifest_changed: [],
  symlinks_escaping: [],
  weakening_signals: [],
  visual_baseline_changes: [],
};

export function result(snapshot: PolicySnapshot, checkId: string, status: CheckStatus = 'PASSED', over: Partial<CheckResult> = {}): CheckResult {
  return {
    id: `run-${checkId}`,
    checkId,
    kind: 'command',
    binding: { candidateId: CANDIDATE.id, treeHash: CANDIDATE.treeHash, checkConfigHash: snapshot.check_config_hashes[checkId] ?? 'unknown', policyHash: snapshotHash(snapshot) },
    command: ['node'],
    cwd: '/checkout',
    isolation: 'none',
    isolationLimitations: [],
    startedAt: 1000,
    endedAt: 2000,
    exitCode: status === 'PASSED' ? 0 : status === 'FAILED' ? 1 : null,
    status,
    timedOut: status === 'TIMEOUT',
    cancelled: status === 'CANCELLED',
    flaky: false,
    logPath: `/runs/evidence/1/${checkId}.log`,
    logSha256: 'abc',
    fingerprint: status === 'FAILED' || status === 'TIMEOUT' ? `fp:${checkId}` : null,
    excerpt: null,
    artifacts: [],
    ...over,
  };
}

export const standardChecks = (): CheckDefinition[] => [checkDef('tests'), checkDef('lint')];
