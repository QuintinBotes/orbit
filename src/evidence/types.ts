/**
 * Evidence (spec §11). Every result is bound to the exact candidate tree and
 * to the hashes of the configuration that produced it. Evidence whose bindings
 * do not match the current candidate is stale and can authorize nothing.
 */

/** A candidate is an exact tree, materialized as a commit on refs/orbit/<run>/candidates/<seq>. */
export interface Candidate {
  id: string;
  runId: string;
  seq: number;
  attempt: number;
  commitSha: string;
  treeHash: string;
  parentSha: string;
}

export interface EvidenceBinding {
  candidateId: string;
  treeHash: string;
  checkConfigHash: string;
  policyHash: string;
}

export type CheckStatus = 'PASSED' | 'FAILED' | 'ERROR' | 'TIMEOUT' | 'CANCELLED';

export interface CheckResult {
  id: string;
  checkId: string;
  kind: 'command' | 'playwright';
  binding: EvidenceBinding;
  command: string[];
  cwd: string;
  isolation: string;
  isolationLimitations: string[];
  startedAt: number;
  endedAt: number;
  exitCode: number | null;
  status: CheckStatus;
  timedOut: boolean;
  cancelled: boolean;
  /** Passed only after a rerun: reported as flaky, never as a clean pass. */
  flaky: boolean;
  logPath: string;
  logSha256: string;
  /** Normalized failure signature; null when the check passed. */
  fingerprint: string | null;
  /** Sanitized, bounded excerpt of the failure for briefs and model context. */
  excerpt: string | null;
  artifacts: { path: string; sha256: string; kind: string }[];
}

export interface ScopeReport {
  allowed_paths_pass: boolean;
  forbidden_paths_changed: string[];
  out_of_scope_paths_changed: string[];
  changed_files: number;
  changed_lines: number;
  within_size_limits: boolean;
  lockfile_changed: boolean;
  dependency_manifest_changed: string[];
  symlinks_escaping: string[];
  /** Signals that tests or oracles were weakened (removed assertions, .skip, raised timeouts, snapshot edits). */
  weakening_signals: { path: string; signal: string; detail: string }[];
  visual_baseline_changes: string[];
}

export type CriterionStatus = 'supported' | 'unsupported' | 'unverified' | 'blocked';

export interface CriterionEvidence {
  criterion_id: string;
  status: CriterionStatus;
  artifacts: string[];
  note?: string;
}

/** Spec §11 example shape, extended with the bindings. */
export interface EvidenceReport {
  task_id: string;
  run_id: string;
  attempt: number;
  candidate_revision: string;
  tree_hash: string;
  check_config_hash: string;
  policy_hash: string;
  scope: ScopeReport;
  checks: { id: string; status: CheckStatus; exit_code: number | null; flaky: boolean; log: string }[];
  ui: { journey: string; status: CheckStatus; artifacts: string[] }[];
  acceptance_evidence: CriterionEvidence[];
  verdict: 'PASS' | 'FAIL' | 'INCOMPLETE';
  /** Things the report could not establish, stated rather than implied. */
  unverified: string[];
}

/** Spec §14. A repair brief must carry all of these to be accepted. */
export interface RepairBrief {
  fingerprint: string;
  evidence: string[];
  hypotheses: { statement: string; supporting: string; refuting?: string }[];
  experiment: string;
  expected_observation: string;
  scoped_fix: string;
  post_fix_checks: string[];
  preserved_constraints: string[];
}
