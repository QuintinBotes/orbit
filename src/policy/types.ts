/**
 * Trusted configuration (`.orbit/config.yaml`) after validation and defaults.
 * Mirrors schemas/config.schema.json. At run start the resolved config is
 * frozen into a policy snapshot (policy.json, mode 0444) whose hash every gate
 * re-verifies; workers can neither read the live config's authority nor change
 * the snapshot.
 */
import type { ReviewFallback } from './review.ts';

export type { ReviewFallback } from './review.ts';

export type RunMode = 'supervised' | 'autonomous' | 'autonomous-delivery' | 'release';

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
  /**
   * May the check listen on 127.0.0.1 (a test suite that starts an HTTP server)? Default true. It grants the
   * sandbox's loopback bind only; outbound reach stays exactly `network_hosts`. A definition frozen into a snapshot
   * written before the key existed has none, and reads as the default.
   */
  local_binding: boolean;
  /** Extra environment. The host environment is not inherited beyond a fixed safe set. */
  env: Record<string, string>;
  mandatory: boolean;
  /** Bounded reruns used only to classify flakiness; a flaky pass is disclosed, not clean. */
  flaky_reruns: number;
  kind: 'command' | 'playwright';
  /**
   * What the check evidences. Parsed configs always carry it (default 'test';
   * kind 'playwright' implies 'ui'); it is optional in the type only so
   * synthesized check definitions and older snapshots read as 'test'. The
   * controller's static security gate lists the 'sast' checks (sastCheckIds).
   */
  category?: CheckCategory;
}

export type CheckCategory = 'test' | 'lint' | 'typecheck' | 'build' | 'sast' | 'ui' | 'other';

export const CHECK_CATEGORIES: readonly CheckCategory[] = ['test', 'lint', 'typecheck', 'build', 'sast', 'ui', 'other'];

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
  /**
   * Exploratory UI testing (spec section 13). Parsed configs always carry it
   * (default disabled); optional in the type so older snapshots still read.
   * Findings are unproven until reproduced as a failing test.
   */
  exploration?: UiExplorationConfig;
}

export interface UiExplorationConfig {
  enabled: boolean;
  /** Wall-clock ceiling for one exploration session. */
  max_minutes: number;
  /** Spend ceiling for one exploration session. */
  budget_usd: number;
}

export type MergeMethod = 'squash' | 'merge' | 'rebase';

export interface ReleaseEnvironment {
  /** argv, never run through a shell. */
  deploy_command: string[];
  /**
   * Trusted argv that reports whether a deploy took effect: exit 0 means it
   * did, any other exit means it did not. Used to reconcile a deploy whose
   * outcome is UNKNOWN. null leaves that to `orbit release resolve`.
   */
  verify_command: string[] | null;
  /** Branches this environment may be deployed from; empty means none. */
  allowed_branches: string[];
  require_ci_green: boolean;
  /** Hosts the deploy command may reach; each must be covered by network.allowed_hosts. */
  network_hosts: string[];
  timeout_seconds: number;
}

/** Release mode only (spec section 5 Execution modes): how to merge and where to deploy. */
export interface ReleaseConfig {
  merge: {
    method: MergeMethod;
    require_checks: string[];
    delete_branch: boolean;
    /** Release mode marks a draft pull request ready for review, as a ledgered action, before merging it. */
    mark_ready: boolean;
  };
  environments: Record<string, ReleaseEnvironment>;
}

/** Roles with an output token budget (architecture "Token efficiency"). */
export type BudgetRole = 'planner' | 'implementer' | 'verifier' | 'reviewer' | 'inquisitor' | 'curator' | 'explorer';

export type AuditSeverity = 'critical' | 'high' | 'moderate' | 'low';

/** Vulnerability and license policy at the baseline and dependency gates (spec section 5). */
export interface DependencyAuditConfig {
  enabled: boolean;
  /** Findings at or above this severity that the candidate introduces block it. */
  fail_on: AuditSeverity;
  /** SPDX identifiers a newly introduced package may carry; null means no license policy. */
  license_allowlist: string[] | null;
  /** An advisory id (GHSA-..., or npm:<source>) or license:<package> that is accepted, with why and until when. */
  exceptions: { id: string; reason: string; expires: string | null }[];
}

export type StaticSeverity = 'critical' | 'high' | 'medium' | 'low';

/** Severity and exception rules for secret-scan and SAST findings (spec section 5). */
export interface StaticSecurityConfig {
  block_severities: StaticSeverity[];
  exceptions: { rule_id: string; path_glob: string | null; reason: string; expires: string | null }[];
}

/** Per-process resource limits applied inside the sandbox; null leaves a limit unset. */
export interface IsolationLimits {
  cpu_seconds: number | null;
  max_processes: number | null;
  max_file_mb: number | null;
  /**
   * Resident memory of the command's processes in MB, enforced by a watchdog
   * that samples them (isolation/memory.ts). Applied by sandbox-runtime; the
   * container provider uses isolation.container.memory_mb instead.
   */
  memory_mb: number | null;
}

/**
 * Isolation tier of the Codex reviewer (ADR 0001, "Second live finding"):
 * `auto` picks `os-sandbox` (srt around the whole codex process) only with an
 * API key in the worker environment and an srt that starts, else
 * `codex-sandbox` (unwrapped, Codex's own read-only sandbox).
 */
export type CodexTierSetting = 'auto' | 'os-sandbox' | 'codex-sandbox';

export interface ProviderConfig {
  command: string;
  /** User attests that sending sanitized code and diffs to this provider is permitted. */
  data_policy_eligible: boolean;
  model: string | null;
  reasoning_effort: string | null;
  extra_args: string[];
  /**
   * Codex providers only (a Claude provider rejects the key). Parsed configs
   * carry it for every Codex provider; absent in older snapshots, which read as `auto`.
   */
  tier?: CodexTierSetting;
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
    /** Credential locations workers may not read (OS read-deny, Read tool, Bash reads), in addition to the built-ins. */
    credential_paths?: string[];
  };
  actions: {
    edit: boolean;
    test: boolean;
    commit: boolean;
    push_task_branch: boolean;
    /** Permission to rebase the task branch onto a base branch that moved on. */
    rebase_task_branch: boolean;
    open_pull_request: boolean;
    read_ci_logs: boolean;
    repair_ci: boolean;
    merge: boolean;
    deploy_production: boolean;
    /** Reserved: workers never hold or change secrets, so only false is accepted. */
    change_secrets: false;
    /** Read by authorize: when false, chmod-class commands (file modes, owners, ACLs, flags) are denied. */
    change_permissions: boolean;
  };
  dependencies: {
    install_existing_lockfile: boolean;
    install_command: string[] | null;
    add_packages: boolean;
    change_lockfile: boolean;
    install_scripts: 'deny' | 'deny-unless-allowlisted' | 'allow';
    install_script_allowlist: string[];
    /** Parsed configs always carry it (default disabled); optional in the type so older snapshots still read. */
    audit?: DependencyAuditConfig;
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
    /** Parallel writers always get disjoint work units; cannot be turned off (the scheduler enforces path ownership). */
    require_independent_work_units: true;
    isolate_writers: true;
    prohibit_shared_worktree_writes: true;
    cancel_obsolete_workers: boolean;
    /**
     * Plugins a worker session may load besides Claude Code's built-ins: exact name@marketplace ids. A plugin can
     * add hooks and tools to workers, so the default is none. Parsed configs always carry it; optional in the type
     * so older snapshots still read (as none).
     */
    allowed_plugins?: string[];
    /** Also accept every organisation-managed plugin (scope managed). Default false; absent in older snapshots reads as false. */
    allow_managed_plugins?: boolean;
  };
  review: {
    /**
     * Independent review providers, in preference order (docs/decisions/0007-reviewer-availability.md). Parsed
     * configs always carry it; optional in the type so older snapshots, which have only preferred_provider, still
     * read. Read it through policy/review.ts `reviewProviderOrder`.
     */
    providers?: string[];
    /** What happens when no independent reviewer is usable. Parsed configs always carry it; read it through `reviewFallback`. */
    when_unavailable?: ReviewFallback;
    /** Legacy: the single preferred provider, replaced by `providers`. */
    preferred_provider?: string;
    /** Legacy: mapped onto when_unavailable (true without the fallback is block). */
    independent_provider_required?: boolean;
    /** Legacy: mapped onto when_unavailable. */
    fallback_same_provider_allowed?: boolean;
    block_unresolved_high_impact_findings: boolean;
    /** Spec §5: explicit severity and exception rules; a warning is not automatically a defect. */
    security: {
      block_severities: ('critical' | 'high' | 'medium' | 'low' | 'info')[];
      exceptions: { category: string; severities: ('critical' | 'high' | 'medium' | 'low' | 'info')[]; reason: string; location: string | null; expires: string | null }[];
    };
  };
  delivery: {
    provider: 'github' | 'fake';
    pull_request: 'draft' | 'ready' | 'none';
    max_ci_repair_cycles: number;
    ci_timeout_minutes: number;
    /** When true, a delivery with no CI checks observed before the timeout cannot succeed. */
    require_ci: boolean;
  };
  checks: Record<string, CheckDefinition>;
  ui: UiConfig | null;
  isolation: {
    provider: 'sandbox-runtime' | 'container' | 'none';
    /** 'none' is refused in unattended modes unless this is true. */
    allow_unisolated: boolean;
    container: { image: string; memory_mb: number; cpus: number; pids: number } | null;
    /** Parsed configs always carry it (all null by default); optional in the type so older snapshots still read. */
    limits?: IsolationLimits;
    /**
     * When true, a run refuses an isolation provider that cannot enforce every configured limit (isolation/limits.ts
     * `unenforcedLimits`), instead of running with the limit named in the evidence record as unenforced. Parsed
     * configs always carry it (false by default); optional in the type so older snapshots still read.
     */
    require_resource_limits?: boolean;
  };
  providers: Record<string, ProviderConfig>;
  routing: {
    allowed_models: string[];
    /** Work kind -> model family or exact id, overriding the default table. */
    overrides: Record<string, string>;
    /** Output token budget per role. Parsed configs always carry it; optional in the type so older snapshots still read. */
    output_budgets?: Record<BudgetRole, number>;
  };
  /** Severity and exception rules for the static security gate. Parsed configs always carry it. */
  static_security?: StaticSecurityConfig;
  /** Merge and deploy settings; required (non-null) in mode release. Parsed configs always carry it (default null). */
  release?: ReleaseConfig | null;
  retention: { keep_runs_days: number; redact_patterns: string[] };
  verification: {
    /** A check that passed only on a rerun is disclosed as flaky; when false it cannot make the verdict PASS. */
    allow_flaky_pass: boolean;
  };
  /** Learning layer (ADR 0002). Nothing here can widen authority. */
  knowledge: {
    enabled: boolean;
    /** Off by default: only repositories the user marks shareable feed the global graph. */
    share_globally: boolean;
    max_advisory_tokens: number;
    /** Spend ceiling for end-of-run curation; skipped when the run's reserve needs it. */
    curator_budget_usd: number;
    /** Spend ceiling for one replay evaluation of a candidate overlay; 0 disables evaluations. */
    eval_budget_usd: number;
    /** ADR 0002: adopt overlays automatically when replay evals improve with no regression. */
    auto_adopt_overlays: boolean;
  };
  /** Publication guard (architecture "Publication guard"). */
  guard: {
    /** Private terms file; null means ~/.config/publish-guard/terms.txt. */
    terms_file: string | null;
    allowed_emails: string[];
  };
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
