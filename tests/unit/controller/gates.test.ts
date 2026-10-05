import { describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultCheck, defaultConfig } from '../../../src/policy/config.ts';
import { snapshotHash } from '../../../src/policy/snapshot.ts';
import type { OrbitConfig, PolicySnapshot } from '../../../src/policy/types.ts';
import type { GoalContract } from '../../../src/contract/types.ts';
import type { ScopeReport } from '../../../src/evidence/types.ts';
import type { CredentialCheck } from '../../../src/recovery/credentials.ts';
import { baselineGate, behaviourGate, environmentGate, FAILURE_BEHAVIOUR, GATES, implementationScopeGate, intakeGate, staticSecurityGate, uiGate } from '../../../src/controller/gates.ts';
import type { BaselineReport } from '../../../src/evidence/baseline.ts';

const repo = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-gates-')));

function snap(tweak?: (c: OrbitConfig) => void): PolicySnapshot {
  const c = defaultConfig('autonomous');
  c.checks = { unit: { ...defaultCheck('unit'), command: ['node', 't.mjs'] } };
  tweak?.(c);
  return { schema: 'orbit.policy/1', run_id: 'orb-1', created_at: '2026-10-05T00:00:00.000Z', repo_root: repo, config: c, effective_protected_paths: ['.github/**'], check_config_hashes: {} };
}

function run(s: PolicySnapshot) {
  return { id: 'orb-1', repoRoot: repo, mode: s.config.mode, policyHash: snapshotHash(s) };
}

function contract(s: PolicySnapshot, over: Partial<GoalContract> = {}): GoalContract {
  return {
    version: '1.0',
    task_id: 'orb-1',
    original_goal: 'Add mul.',
    objective: 'Add mul.',
    acceptance_criteria: [{ id: 'AC-1', statement: 'mul multiplies', proof: ['a test'], mandatory: true, check_ids: ['unit'] }],
    non_goals: [],
    allowed_paths: ['apps/**'],
    required_check_ids: ['unit'],
    assumptions: [],
    delivery: { draft_pr: false, merge: false },
    policy_hash: snapshotHash(s),
    baseline_revision: 'a'.repeat(40),
    escalation: { material_topics: [] },
    ...over,
  };
}

function scope(over: Partial<ScopeReport> = {}): ScopeReport {
  return {
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
    ...over,
  };
}

const cred = (provider: string, verdict: CredentialCheck['verdict'], state: string): CredentialCheck => ({ provider, verdict, status: { state: state as 'valid', method: 'api_key', detail: '' }, live: false, error: null });

describe('gate sequence', () => {
  it('lists the spec gates in order with their failure behaviour', () => {
    expect(GATES).toEqual(['intake', 'environment', 'baseline', 'implementation', 'static_security', 'behaviour', 'ui', 'independent_review', 'delivery', 'completion']);
    expect(FAILURE_BEHAVIOUR.environment).toBe('block-unattended');
    expect(FAILURE_BEHAVIOUR.completion).toBe('no-success');
  });
});

describe('intakeGate', () => {
  it('accepts a measurable contract bound to the frozen policy', () => {
    const s = snap();
    const g = intakeGate({ run: run(s), snapshot: s, contract: contract(s) });
    expect(g.status).toBe('pass');
  });

  it('rejects a criterion that cites no trusted check, a foreign policy hash and another repository', () => {
    const s = snap();
    const c = contract(s, { acceptance_criteria: [{ id: 'AC-1', statement: 'it works', proof: ['trust me'], mandatory: true, check_ids: [] }], policy_hash: `sha256:${'0'.repeat(64)}` });
    const g = intakeGate({ run: { ...run(s), repoRoot: tmpdir() }, snapshot: s, contract: c });
    expect(g.passed).toBe(false);
    expect(g.onFailure).toBe('reject-contract');
    expect(g.reasons.join('\n')).toMatch(/not the repository the policy authorizes/);
    expect(g.reasons.join('\n')).toMatch(/policy_hash/);
  });

  it('checks the repository alone at preflight, before any contract exists', () => {
    const s = snap();
    expect(intakeGate({ run: run(s), snapshot: s }).status).toBe('pass');
  });
});

describe('environmentGate', () => {
  it('refuses unattended execution without isolation unless the policy explicitly opts out, and says so when it does', () => {
    const s = snap();
    const refused = environmentGate({ snapshot: s, mode: 'autonomous', isolation: { kind: 'none', available: true, detail: 'none' }, credentials: [], reviewer: null });
    expect(refused.passed).toBe(false);
    expect(refused.details.code).toBe('ISOLATION_UNAVAILABLE');
    const optedOut = snap((c) => void (c.isolation.allow_unisolated = true));
    const allowed = environmentGate({ snapshot: optedOut, mode: 'autonomous', isolation: { kind: 'none', available: true, detail: 'none' }, credentials: [], reviewer: null });
    expect(allowed.passed).toBe(true);
    expect(allowed.notes.join(' ')).toMatch(/no isolation/);
    expect(environmentGate({ snapshot: s, mode: 'supervised', isolation: { kind: 'none', available: true, detail: 'none' }, credentials: [], reviewer: null }).passed).toBe(true);
  });

  it('refuses an unavailable provider and blocks on missing or expired credentials of a mandatory provider', () => {
    const s = snap();
    const iso = { kind: 'sandbox-runtime' as const, available: false, detail: 'srt not found' };
    expect(environmentGate({ snapshot: s, mode: 'autonomous', isolation: iso, credentials: [], reviewer: null }).reasons[0]).toMatch(/srt not found/);
    const ok = { kind: 'container' as const, available: true, detail: 'docker' };
    const g = environmentGate({ snapshot: s, mode: 'autonomous', isolation: ok, credentials: [cred('claude', 'unverified', 'unknown'), cred('codex', 'blocked', 'expired')], reviewer: null });
    expect(g.passed).toBe(false);
    expect(g.details).toEqual({ blockedProvider: 'codex', code: 'AUTH_EXPIRED' });
    expect(g.notes.join(' ')).toMatch(/claude credentials are present but unverified/);
  });

  it('blocks when independent review is mandatory and no reviewer can be selected', () => {
    const g = environmentGate({ snapshot: snap(), mode: 'autonomous', isolation: { kind: 'container', available: true, detail: 'docker' }, credentials: [], reviewer: { decision: 'BLOCK', code: 'PROVIDER_UNAVAILABLE', reason: 'codex is not installed', alternatives: [] } });
    expect(g.reasons.join(' ')).toMatch(/independent review: codex is not installed/);
  });
});

describe('baselineGate', () => {
  const report = (over: Partial<BaselineReport> = {}): BaselineReport => ({ schema: 'orbit.baseline/1', runId: 'orb-1', baseRevision: 'b', baseTree: 't', policyHash: 'h', checkIds: ['unit'], install: { skipped: true, reason: 'no lockfile', ok: false }, checks: [], failures: [], complete: true, recordedAt: 0, ...over });
  it('records pre-existing failures and passes; blocks only on a failed locked install', () => {
    const g = baselineGate(report({ failures: [{ checkId: 'unit', fingerprint: 'fp:1', excerpt: null }] }));
    expect(g.passed).toBe(true);
    expect(g.notes[0]).toMatch(/pre-existing failure on the base revision: unit/);
    expect(baselineGate(report({ install: { skipped: false, reason: 'npm ci failed', ok: false } })).status).toBe('fail');
    expect(baselineGate(report({ complete: false })).status).toBe('unverified');
  });
  it('lists each base-revision audit finding the baseline recorded, without failing the gate (G52)', () => {
    const auditNotes = ['pre-existing vulnerability on the base revision: left-pad 1.0.0 (high) GHSA-test-0001', 'pre-existing license problem on the base revision: widget 2.0.0 uses GPL-3.0'];
    const g = baselineGate(report({ auditNotes }));
    expect(g.passed).toBe(true);
    expect(g.notes).toEqual(expect.arrayContaining(auditNotes));
    expect(baselineGate(report()).notes.filter((n) => /audit|vulnerab|licen/.test(n))).toEqual([]);
  });
});

describe('implementationScopeGate', () => {
  it('treats protected paths and escaping symlinks as a policy violation, scope and size problems as repairable', () => {
    const s = snap();
    const violation = implementationScopeGate(scope({ forbidden_paths_changed: ['.github/workflows/ci.yml'] }), s);
    expect(violation.details.policyViolation).toBe(true);
    const repairable = implementationScopeGate(scope({ out_of_scope_paths_changed: ['docs/x.md'], within_size_limits: false, lockfile_changed: true }), s);
    expect(repairable.details).toEqual({ policyViolation: false, repairable: [expect.stringMatching(/outside the authorized scope/), expect.stringMatching(/size limits/), expect.stringMatching(/lockfile/)] });
    const weak = implementationScopeGate(scope({ weakening_signals: [{ path: 'tests/a.test.ts', signal: 'assertion-removed', detail: '1 line' }] }), s);
    expect(weak.passed).toBe(true);
    expect(weak.notes[0]).toMatch(/oracle weakening/);
  });
});

describe('staticSecurityGate', () => {
  const scan = (findings = 0, scanner: 'gitleaks' | 'builtin' = 'gitleaks') => ({ scanner, completed: true, findings: Array.from({ length: findings }, (_, i) => ({ file: `apps/k${i}.ts`, line: 1, rule: 'github-pat' })), files: 1, note: scanner, reportPath: '/x' });
  it('reports static analysis as unverified, never passed, when the policy defines no SAST', () => {
    const g = staticSecurityGate({ scan: scan(), sast: [] });
    expect(g.status).toBe('unverified');
    expect(g.passed).toBe(false);
    expect(g.notes.join(' ')).toMatch(/SAST\) is unverified/);
  });

  it('fails on secrets, names the built-in fallback, and passes only with every SAST check green', () => {
    expect(staticSecurityGate({ scan: scan(2), sast: [] }).status).toBe('fail');
    expect(staticSecurityGate({ scan: scan(0, 'builtin'), sast: [{ checkId: 'sast', status: 'PASSED' }] }).notes.join(' ')).toMatch(/built-in patterns only/);
    expect(staticSecurityGate({ scan: scan(), sast: [{ checkId: 'sast', status: 'PASSED' }] }).status).toBe('pass');
    expect(staticSecurityGate({ scan: scan(), sast: [{ checkId: 'sast', status: 'FAILED' }] }).status).toBe('fail');
    expect(staticSecurityGate({ scan: scan(), sast: [{ checkId: 'sast', status: null }] }).status).toBe('unverified');
  });
});

describe('behaviour and UI gates', () => {
  it('maps the evidence verdict: FAIL needs a repair brief, INCOMPLETE is unverified', () => {
    const report = { verdict: 'FAIL', checks: [{ id: 'unit', status: 'FAILED', exit_code: 1, flaky: false, log: 'unit.log' }], acceptance_evidence: [], unverified: [] };
    const fail = behaviourGate({ report: report as never, failReasons: ['unit failed'], incompleteReasons: [] });
    expect(fail).toMatchObject({ status: 'fail', onFailure: 'repair-brief', reasons: ['unit failed'] });
    expect(behaviourGate({ report: { ...report, verdict: 'INCOMPLETE' } as never, failReasons: [], incompleteReasons: ['AC-1 has no evidence'] }).status).toBe('unverified');
  });

  it('requires configured journeys when UI evidence is needed and never passes an interrupted run', () => {
    expect(uiGate({ required: false, configured: false, result: null }).passed).toBe(true);
    expect(uiGate({ required: true, configured: false, result: null }).status).toBe('fail');
    expect(uiGate({ required: true, configured: true, result: { verdict: 'CANCELLED', reasons: ['interrupted'], unverified: [], journeys: [] } }).status).toBe('unverified');
    expect(uiGate({ required: true, configured: true, result: { verdict: 'FAIL', reasons: ['journey failed'], unverified: [], journeys: [] } }).status).toBe('fail');
  });
});
