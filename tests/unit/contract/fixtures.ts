import type { OrbitConfig, PolicySnapshot, CheckDefinition, UiConfig } from '../../../src/policy/types.ts';
import type { GoalContract } from '../../../src/contract/types.ts';
import type { PlannerOutput } from '../../../src/contract/model-outputs.ts';
import { hashObject } from '../../../src/core/hash.ts';

export function check(id: string, overrides: Partial<CheckDefinition> = {}): CheckDefinition {
  return {
    id,
    command: ['npm', 'run', id],
    shell: false,
    cwd: '.',
    timeout_seconds: 600,
    network_hosts: [],
    env: {},
    mandatory: false,
    flaky_reruns: 0,
    kind: 'command',
    ...overrides,
  };
}

export function uiConfig(overrides: Partial<UiConfig> = {}): UiConfig {
  return {
    required_when_ui_changes: true,
    ui_paths: ['apps/web/**/*.tsx', 'apps/web/**/*.css'],
    browsers: ['chromium'],
    viewports: [{ width: 1440, height: 900 }],
    environment: { base_url: 'http://127.0.0.1:3000', start_command: null, ready_timeout_seconds: 60, isolated_test_data: true, production_accounts: false },
    journey_check_ids: ['reports-ui'],
    accessibility: { enabled: true, fail_on_new_serious_or_critical: true },
    visual: { enabled: false, baseline_changes_require_review: true, baseline_globs: [] },
    visual_baseline_auto_accept: false,
    ...overrides,
  };
}

export interface ConfigTweaks {
  allowedPaths?: string[];
  checks?: Record<string, CheckDefinition>;
  ui?: UiConfig | null;
  merge?: boolean;
  openPullRequest?: boolean;
  pullRequest?: 'draft' | 'ready' | 'none';
}

export function config(t: ConfigTweaks = {}): OrbitConfig {
  return {
    version: 1,
    mode: 'autonomous-delivery',
    repository: { base_branch: 'main', branch_prefix: 'orbit/', allow_dirty_start: false, remote: 'origin' },
    scope: { allowed_paths: t.allowedPaths ?? ['apps/**', 'packages/**', 'tests/**', 'docs/**'], protected_paths: ['.github/**'] },
    actions: {
      edit: true,
      test: true,
      commit: true,
      push_task_branch: true,
      open_pull_request: t.openPullRequest ?? true,
      read_ci_logs: true,
      repair_ci: true,
      merge: t.merge ?? false,
      deploy_production: false,
      change_secrets: false,
      change_permissions: false,
    },
    dependencies: {
      install_existing_lockfile: true,
      install_command: null,
      add_packages: false,
      change_lockfile: false,
      install_scripts: 'deny-unless-allowlisted',
      install_script_allowlist: [],
    },
    network: { allowed_hosts: [] },
    ambiguity: { resolve_reversible_choices: true, require_evidence_for_behavior_changes: true, block_security_or_data_semantics: true },
    scheduler: {
      hard_limits: {
        implementation_attempts: 12,
        diagnostic_experiments: 16,
        review_rounds: 4,
        ci_repair_cycles: 3,
        worker_turns_per_session: 30,
        wall_minutes: 120,
        model_cost_usd: 30,
        parallel_workers: 4,
        changed_files: 40,
        changed_lines: 2000,
        infrastructure_retries: 3,
        recovery_attempts: 3,
      },
      initial_allowances: { simple_attempts: 2, medium_attempts: 4, complex_attempts: 6 },
      extension: { attempts_per_extension: 1, require_measurable_progress: true, require_new_hypothesis: true, preserve_final_verification_reserve: true },
      repeated_failure_threshold: 2,
      final_reserve_fraction: 0.2,
    },
    agents: { default_parallelism: 1, require_independent_work_units: true, isolate_writers: true, prohibit_shared_worktree_writes: true, cancel_obsolete_workers: true },
    review: { independent_provider_required: true, preferred_provider: 'codex', fallback_same_provider_allowed: false, block_unresolved_high_impact_findings: true, security: { block_severities: ['critical', 'high'], exceptions: [] } },
    delivery: { provider: 'fake', pull_request: t.pullRequest ?? 'draft', max_ci_repair_cycles: 3, ci_timeout_minutes: 30, require_ci: false },
    checks: t.checks ?? {
      lint: check('lint', { mandatory: true }),
      typecheck: check('typecheck', { mandatory: true }),
      'reports-tests': check('reports-tests'),
      build: check('build'),
      'reports-ui': check('reports-ui', { kind: 'playwright' }),
    },
    ui: t.ui === undefined ? null : t.ui,
    isolation: { provider: 'sandbox-runtime', allow_unisolated: false, container: null },
    providers: {},
    routing: { allowed_models: [], overrides: {} },
    retention: { keep_runs_days: 30, redact_patterns: [] },
    verification: { allow_flaky_pass: false },
    knowledge: { enabled: true, share_globally: false, max_advisory_tokens: 800, curator_budget_usd: 0.25, eval_budget_usd: 0, auto_adopt_overlays: true },
    guard: { terms_file: null, allowed_emails: [] },
  };
}

export function snapshot(t: ConfigTweaks = {}): PolicySnapshot {
  return {
    schema: 'orbit.policy/1',
    run_id: 'orb-20261003-120000-abcdef',
    created_at: '2026-10-03T12:00:00.000Z',
    repo_root: '/work/acme-app',
    config: config(t),
    effective_protected_paths: ['.github/**', '.orbit/**'],
    check_config_hashes: {},
  };
}

export const BASELINE = 'a'.repeat(40);

export function contract(snap: PolicySnapshot, overrides: Partial<GoalContract> = {}): GoalContract {
  return {
    version: '1.0',
    task_id: 'ORB-001',
    original_goal: 'Add CSV export for filtered reports.',
    objective: 'Add CSV export for filtered reports.',
    acceptance_criteria: [
      {
        id: 'AC-1',
        statement: 'Export all matching records, including records beyond the current page.',
        proof: ['A multi-page filtered fixture produces every matching record.'],
        mandatory: true,
        check_ids: ['reports-tests'],
      },
      {
        id: 'AC-2',
        statement: 'Preserve visible column order and escape CSV values correctly.',
        proof: ['Header ordering and escaping tests pass.', 'Snapshot of the generated file matches.'],
        mandatory: true,
      },
      {
        id: 'AC-3',
        statement: 'Show a toast after the export finishes.',
        proof: ['Component test for the toast.'],
        mandatory: false,
      },
    ],
    non_goals: ['Change report filtering semantics'],
    allowed_paths: ['apps/api/**', 'tests/reports/**'],
    required_check_ids: ['lint', 'typecheck', 'reports-tests'],
    assumptions: [
      { id: 'AS-1', statement: 'Exports use the existing report query.', status: 'unverified' },
      { id: 'AS-2', statement: 'Dates use the user local time zone.', status: 'needs-decision' },
    ],
    delivery: { draft_pr: true, merge: false },
    policy_hash: hashObject(snap),
    baseline_revision: BASELINE,
    escalation: { material_topics: ['security rules'] },
    ...overrides,
  };
}

export function planner(overrides: Partial<PlannerOutput> = {}): PlannerOutput {
  return {
    objective: '  Add CSV export for filtered reports.  ',
    current_behavior: [{ statement: 'Reports paginate server side.', evidence: ['apps/api/reports.ts:40'] }],
    criteria: [
      {
        key: 'all-records',
        statement: 'Export all matching records, including records beyond the current page.',
        mandatory: true,
        ui: false,
        proof: ['A multi-page filtered fixture produces every matching record.', 'A multi-page filtered fixture produces every matching record.'],
        check_ids: ['reports-tests', 'made-up-check'],
        changes: [{ path: 'apps/api/export.ts', summary: 'stream all pages' }],
      },
      {
        key: 'escaping',
        statement: 'Escape CSV values correctly.',
        mandatory: false,
        ui: false,
        proof: ['Escaping tests pass.'],
        check_ids: [],
        changes: [],
      },
    ],
    expected_changed_files: [{ path: 'apps/api/export.ts', change: 'add', reason: 'new endpoint' }],
    allowed_paths: ['apps/api/**', 'tests/reports/**'],
    required_check_ids: ['build', 'curl-evil'],
    non_goals: ['Change report filtering semantics', ' change report filtering semantics '],
    risks: [{ risk: 'Large exports', impact: 'medium', mitigation: 'stream' }],
    assumptions: [{ statement: 'Exports use the existing report query.', basis: 'apps/api/reports.ts', status: 'unverified' }],
    unresolved_decisions: [],
    material_topics: ['Security rules', 'billing'],
    ...overrides,
  };
}
