import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../../../src/policy/config.ts';
import { effectiveProtectedPaths } from '../../../src/policy/builtin.ts';
import type { OrbitConfig, PolicySnapshot } from '../../../src/policy/types.ts';
import type { GoalContract } from '../../../src/contract/types.ts';
import type { EvidenceReport } from '../../../src/evidence/types.ts';
import type { CredentialStatus, ProviderCapabilities } from '../../../src/adapters/types.ts';
import { ManualClock } from '../../../src/core/clock.ts';
import { createRun } from '../../../src/controller/run-store.ts';
import { openDb, type OrbitDb } from '../../../src/storage/db.ts';
import type { ClaimEvidence, ResolvableFinding, ResolverReview } from '../../../src/review/resolve.ts';
import type { FindingSeverity, IngestedFinding } from '../../../src/review/types.ts';

export const TREE_A = 'a'.repeat(40);
export const TREE_B = 'b'.repeat(40);
export const COMMIT_A = '1'.repeat(40);

export function snapshotOf(patch: (c: OrbitConfig) => void = () => {}): PolicySnapshot {
  const config = defaultConfig('autonomous-delivery');
  config.providers.codex = { ...config.providers.codex!, data_policy_eligible: true, model: 'codex-alpha' };
  patch(config);
  return { schema: 'orbit.policy/1', run_id: 'run-1', created_at: '2026-10-03T00:00:00Z', repo_root: '/repo/acme', config, effective_protected_paths: effectiveProtectedPaths(config), check_config_hashes: {} };
}

/** A snapshot whose config carries the given review.security (raw, so tests can also pass malformed policy). */
export function snapshotWithSecurity(security: unknown, patch: (c: OrbitConfig) => void = () => {}): PolicySnapshot {
  return snapshotOf((c) => {
    patch(c);
    (c.review as unknown as { security: unknown }).security = security;
  });
}

export function cap(provider: string, over: Partial<ProviderCapabilities> = {}): ProviderCapabilities {
  return { provider, available: true, version: '1.0.0', models: [], structuredOutput: true, readOnlySandbox: true, usageReporting: 'exact', costReporting: true, detail: 'ok', ...over };
}

export const cred = (state: CredentialStatus['state'], detail = ''): CredentialStatus => ({ state, method: 'env', detail });

export function contract(over: Partial<GoalContract> = {}): GoalContract {
  return {
    version: '1.0',
    task_id: 'ORB-001',
    original_goal: 'Add CSV export for filtered reports.',
    objective: 'Add CSV export for filtered reports.',
    acceptance_criteria: [
      { id: 'AC-1', statement: 'Export all matching records, including records beyond the current page.', proof: ['A multi-page filtered fixture produces every matching record.'], mandatory: true },
      { id: 'AC-2', statement: 'Preserve visible column order and escape CSV values correctly.', proof: ['Header ordering and escaping tests pass.'], mandatory: true },
    ],
    non_goals: ['Change report filtering semantics'],
    allowed_paths: ['src/**', 'tests/**'],
    required_check_ids: ['unit'],
    assumptions: [{ id: 'AS-1', statement: 'Exports are limited to the signed-in tenant.', status: 'unverified' }],
    delivery: { draft_pr: true, merge: false },
    policy_hash: 'sha256:policy',
    baseline_revision: 'base',
    escalation: { material_topics: [] },
    ...over,
  };
}

export function evidenceReport(treeHash: string, over: Partial<EvidenceReport> = {}): EvidenceReport {
  return {
    task_id: 'ORB-001',
    run_id: 'run-1',
    attempt: 1,
    candidate_revision: COMMIT_A,
    tree_hash: treeHash,
    check_config_hash: 'sha256:checks',
    policy_hash: 'sha256:policy',
    scope: {
      allowed_paths_pass: true,
      forbidden_paths_changed: [],
      out_of_scope_paths_changed: [],
      changed_files: 2,
      changed_lines: 40,
      within_size_limits: true,
      lockfile_changed: false,
      dependency_manifest_changed: [],
      symlinks_escaping: [],
      weakening_signals: [],
      visual_baseline_changes: [],
    },
    checks: [{ id: 'unit', status: 'PASSED', exit_code: 0, flaky: false, log: 'unit.log' }],
    ui: [],
    acceptance_evidence: [{ criterion_id: 'AC-1', status: 'supported', artifacts: ['unit.log'] }],
    verdict: 'PASS',
    unverified: ['No load test was run.'],
    ...over,
  };
}

let seq = 0;
export function rfinding(over: Partial<ResolvableFinding> = {}): ResolvableFinding {
  seq += 1;
  return {
    id: `rev-1:FND-${seq}`,
    reviewId: 'rev-1',
    provider: 'codex',
    treeHash: TREE_A,
    externalId: `FND-${seq}`,
    severity: 'high',
    category: 'authorization',
    location: 'src/export.ts:42',
    claim: `Export omits tenant scope (${seq}).`,
    evidence: 'Query construction lacks the tenant predicate.',
    suggestedValidation: 'Add a cross-tenant negative test.',
    status: 'open',
    ...over,
  };
}

export const rreview = (over: Partial<ResolverReview> = {}): ResolverReview => ({ id: 'rev-1', provider: 'codex', verdict: 'REPAIR_REQUIRED', treeHash: TREE_A, ...over });

export function evidence(over: Partial<ClaimEvidence> = {}): ClaimEvidence {
  return { kind: 'new_test', treeHash: TREE_A, verdict: 'refutes', status: 'PASSED', exercisesClaim: true, checkId: 'cross-tenant', ref: 'evidence/1/cross-tenant.log', ...over };
}

export function ingested(over: Partial<IngestedFinding> = {}): IngestedFinding {
  return {
    externalId: 'SEC-1',
    severity: 'high' as FindingSeverity,
    category: 'authorization',
    location: 'src/export.ts:42',
    path: 'src/export.ts',
    line: 42,
    claim: 'Export omits tenant scope.',
    evidence: 'Query construction lacks the tenant predicate.',
    suggestedValidation: 'Add a cross-tenant negative test.',
    ...over,
  };
}

/** The candidate row dbFixture records for each fixture tree: recordReview refuses a candidate that does not exist. */
export function candidateOf(treeHash: string | undefined): string {
  return treeHash === TREE_B ? 'cand-2' : 'cand-1';
}

export function dbFixture(): { db: OrbitDb; clock: ManualClock; runDir: string } {
  const db = openDb(':memory:');
  const clock = new ManualClock();
  createRun(db, { id: 'run-1', repoRoot: '/repo/acme', goal: 'g', mode: 'autonomous', policyHash: 'sha256:x', policyPath: '/p' }, clock);
  for (const [seq, tree] of [[1, TREE_A], [2, TREE_B]] as const) {
    db.run(
      "INSERT INTO candidates (id, run_id, seq, attempt, commit_sha, tree_hash, parent_sha, status, created_at) VALUES (?, 'run-1', ?, ?, ?, ?, 'p', 'CREATED', 1)",
      `cand-${seq}`,
      seq,
      seq,
      `c${seq}`.padEnd(40, '0'),
      tree,
    );
  }
  return { db, clock, runDir: mkdtempSync(join(tmpdir(), 'orbit-review-')) };
}
