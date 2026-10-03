/**
 * Trusted configuration (`.orbit/config.yaml`) after validation and defaults.
 * Mirrors schemas/config.schema.json. At run start the resolved config is
 * frozen into a policy snapshot (policy.json, mode 0444) whose hash every gate
 * re-verifies; workers can neither read the live config's authority nor change
 * the snapshot.
 */
import type { RunMode } from '../controller/run-store.ts';

export interface CheckDefinition {
  id: string;
  /** argv form; never interpreted by a shell unless `shell: true`. */
  command: string[];
  shell: boolean;
  /** Relative to the worktree root. */
  cwd: string;
  timeout_seconds: number;
  /** Hosts this check may reach. Empty = no network. */
  network_hosts: string[];
  /** Extra environment. The host environment is not inherited beyond a fixed safe set. */
  env: Record<string, string>;
  mandatory: boolean;
  /** Bounded reruns used only to classify flakiness; a flaky pass is disclosed, not clean. */
  flaky_reruns: number;
  kind: 'command' | 'playwright';
}

export interface HardLimits {
  implementation_attempts: number;
  diagnostic_experiments: number;
  review_rounds: number;
  ci_repair_cycles: number;
  worker_turns_per_session: number;
  wall_minutes: number;
  model_cost_usd: number;
  parallel_workers: number;
  changed_files: number;
  changed_lines: number;
  infrastructure_retries: number;
  recovery_attempts: number;
}

export interface UiConfig {
  required_when_ui_changes: boolean;
  /** Globs whose change marks a candidate as a UI change. */
  ui_paths: string[];
  browsers: string[];
  viewports: { width: number; height: number }[];
  environment: {
    base_url: string;
    start_command: string[] | null;
    ready_timeout_seconds: number;
    isolated_test_data: boolean;
    production_accounts: false;
  };
  /** Check ids of kind playwright that make up the journeys. */
  journey_check_ids: string[];
  accessibility: { enabled: boolean; fail_on_new_serious_or_critical: boolean };
  visual: { enabled: boolean; baseline_changes_require_review: boolean; baseline_globs: string[] };
  visual_baseline_auto_accept: false;
}

export interface ProviderConfig {
  command: string;
  /** User attests that sending sanitized code and diffs to this provider is permitted. */
  data_policy_eligible: boolean;
  model: string | null;
  reasoning_effort: string | null;
  extra_args: string[];
}

export interface OrbitConfig {
  version: 1;
  mode: RunMode;
  repository: {
    base_branch: string;
    branch_prefix: string;
    allow_dirty_start: boolean;
    remote: string;
  };
  scope: {
    allowed_paths: string[];
    /** Always also includes the built-in protected set (see policy/builtin.ts). */
    protected_paths: string[];
  };
  actions: {
    edit: boolean;
    test: boolean;
    commit: boolean;
    push_task_branch: boolean;
    open_pull_request: boolean;
    read_ci_logs: boolean;
    repair_ci: boolean;
    merge: boolean;
    deploy_production: boolean;
    change_secrets: boolean;
    change_permissions: boolean;
  };
  dependencies: {
    install_existing_lockfile: boolean;
    install_command: string[] | null;
    add_packages: boolean;
    change_lockfile: boolean;
    install_scripts: 'deny' | 'deny-unless-allowlisted' | 'allow';
    install_script_allowlist: string[];
  };
  network: { allowed_hosts: string[] };
  ambiguity: {
    resolve_reversible_choices: boolean;
    require_evidence_for_behavior_changes: boolean;
    block_security_or_data_semantics: boolean;
  };
  scheduler: {
    hard_limits: HardLimits;
    initial_allowances: { simple_attempts: number; medium_attempts: number; complex_attempts: number };
    extension: {
      attempts_per_extension: number;
      require_measurable_progress: boolean;
      require_new_hypothesis: boolean;
      preserve_final_verification_reserve: boolean;
    };
    repeated_failure_threshold: number;
    /** Share of cost and wall-time budgets held back for final verification, review and reporting. */
    final_reserve_fraction: number;
  };
  agents: {
    default_parallelism: number;
    require_independent_work_units: boolean;
    isolate_writers: true;
    prohibit_shared_worktree_writes: true;
    cancel_obsolete_workers: boolean;
  };
  review: {
    independent_provider_required: boolean;
    preferred_provider: string;
    fallback_same_provider_allowed: boolean;
    block_unresolved_high_impact_findings: boolean;
  };
  delivery: {
    provider: 'github' | 'fake';
    pull_request: 'draft' | 'ready' | 'none';
    max_ci_repair_cycles: number;
    ci_timeout_minutes: number;
  };
  checks: Record<string, CheckDefinition>;
  ui: UiConfig | null;
  isolation: {
    provider: 'sandbox-runtime' | 'container' | 'none';
    /** 'none' is refused in unattended modes unless this is true. */
    allow_unisolated: boolean;
    container: { image: string; memory_mb: number; cpus: number; pids: number } | null;
  };
  providers: Record<string, ProviderConfig>;
  routing: {
    allowed_models: string[];
    /** Work kind -> model family or exact id, overriding the default table. */
    overrides: Record<string, string>;
  };
  retention: { keep_runs_days: number; redact_patterns: string[] };
}

/** The frozen, hashed form stored at .orbit/runs/<id>/policy.json. */
export interface PolicySnapshot {
  schema: 'orbit.policy/1';
  run_id: string;
  created_at: string;
  repo_root: string;
  config: OrbitConfig;
  /** Built-in protections merged in, listed explicitly so the snapshot is self-describing. */
  effective_protected_paths: string[];
  /** Hash of each check definition, the "check-configuration hash" evidence binds to. */
  check_config_hashes: Record<string, string>;
}

export type Operation =
  | { kind: 'edit'; path: string }
  | { kind: 'read'; path: string }
  | { kind: 'bash'; command: string }
  | { kind: 'network'; host: string }
  | { kind: 'action'; action: keyof OrbitConfig['actions']; target?: string }
  | { kind: 'dependency'; change: 'add_package' | 'change_lockfile' | 'install_script'; detail: string };

export interface AuthorizationDecision {
  allowed: boolean;
  /** Stable machine-readable rule id, e.g. 'scope.protected', 'actions.merge'. */
  rule: string;
  reason: string;
}
