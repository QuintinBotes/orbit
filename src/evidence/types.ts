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
  /**
   * Present when a check the criterion cites is cited by other criteria too ("check-wide: the tests unit runs, shared by
   * AC-1, AC-2"): its support is that check's whole run, which also supports them (ADR 0014 section 4).
   */
  check_wide?: string;
  /** Whether the criterion's new tests fail on the base revision (docs/decisions/0014-fail-before.md); absent without a base comparison. */
  fail_before?: CriterionFailBefore;
}

/** A criterion's fail-before entry in report.json (ADR 0014 section 5). */
export interface CriterionFailBefore {
  /** verification.fail_before of the run's policy. */
  mode: 'off' | 'advisory' | 'required';
  /**
   * failed-before, passed-before or not-established from the probe; not-run when the policy turned the probe off;
   * not-applicable when the criterion's support does not rest on new tests.
   */
  outcome: 'failed-before' | 'passed-before' | 'not-established' | 'not-run' | 'not-applicable';
  /** Each probed check the criterion cites, with every attempt on the probe tree. */
  checks: { id: string; outcome: 'failed-before' | 'passed-before' | 'not-established'; cause?: string; attempts: { status: CheckStatus; exit_code: number | null; log: string | null }[] }[];
  /** The probe tree (the base tree with the candidate's test-owned paths); null when no probe tree was built. */
  probe_tree: string | null;
  /** The criterion's new tests: the first 20, and how many there are. */
  test_paths: { paths: string[]; count: number };
  reason: string;
  /** Why the outcome is not established, when it is not. */
  cause?: string;
  /** A person accepted the criterion without fail-before for this candidate tree (its question and who answered). */
  accepted?: { question_id: string; by: string };
  /** Present when a probed check is cited by other criteria too: the outcome is that check's, shared by each of them. */
  check_wide?: string;
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
