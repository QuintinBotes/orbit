# Configuration

Orbit is configured by one file, `.orbit/config.yaml`, created by `orbit init`
from `templates/config.yaml`. The authoritative description of every key is the
JSON Schema in `schemas/config.schema.json`; the template carries a comment for
each setting.

The file is trusted input. At run start Orbit validates it, applies defaults,
and freezes the result into `.orbit/runs/<run-id>/policy.json`, read-only and
hashed. Editing the file never changes a run in progress. `orbit policy show
<run-id>` prints the frozen policy and verifies its hash. Unknown keys, wrong
types and contradictory settings are errors, all reported at once. Validate
with `orbit doctor`. Workers can never edit this file: it is a built-in
protected path.

## mode

```yaml
mode: autonomous-delivery
```

| Mode | Behaviour |
|---|---|
| `supervised` | Ask for material decisions and unauthorized actions. |
| `autonomous` | Do preauthorized work; resolve reversible, low-risk ambiguity. |
| `autonomous-delivery` | Also commit, push a task branch, open a pull request, observe and repair CI. |
| `release` | Also merge and deploy, each only when its action is true. |

`orbit run --mode <mode>` overrides it and is validated as if the file said it.
Delivery actions default to on only in the delivery modes; turning one on in
`supervised` or `autonomous` is an error.

## repository

```yaml
repository:
  base_branch: main
  branch_prefix: orbit/        # task branches are orbit/<run-id>
  allow_dirty_start: false
  remote: origin
```

Orbit only pushes branches with the prefix, and the prefix may not match the
base branch.

## scope

```yaml
scope:
  allowed_paths: ["apps/**", "packages/**", "tests/**", "docs/**"]
  protected_paths: [".github/**", "infra/**", ".orbit/config.yaml", "**/.env*"]
```

A worker may change only `allowed_paths`; anything else fails the scope gate.
A goal contract can narrow the scope but never widen it. Protected paths win
over allowed ones. Built-in protections you cannot remove: `.orbit/**`, `.git`,
nested `.git` directories, `.claude/settings*.json`, `.mcp.json`, `**/.env*`,
`**/*.pem`, SSH keys, `**/.npmrc` and `**/.netrc`.

## actions

```yaml
actions:
  edit: true
  test: true
  commit: true
  push_task_branch: true
  open_pull_request: true
  repair_ci: true
  read_ci_logs: true
  merge: false
  deploy_production: false
  change_secrets: false
  change_permissions: false
```

`commit`, `push_task_branch`, `open_pull_request` and `repair_ci` need mode
`autonomous-delivery` or `release`. `merge` and `deploy_production` need `release`.

## dependencies and network

```yaml
dependencies:
  install_existing_lockfile: true
  install_command: null              # argv list, or null to detect
  add_packages: false
  change_lockfile: false
  install_scripts: deny-unless-allowlisted   # deny | deny-unless-allowlisted | allow
  install_script_allowlist: []

network:
  allowed_hosts: [github.com, api.github.com, registry.npmjs.org]
```

Hosts are exact names, IPv4 addresses, or `*.example.com` (subdomains only).
No ports, schemes or bare `*`. Everything else is blocked by the sandbox.
`add_packages` also needs `change_lockfile`.

## ambiguity

```yaml
ambiguity:
  resolve_reversible_choices: true
  require_evidence_for_behavior_changes: true
  block_security_or_data_semantics: true
```

## scheduler

```yaml
scheduler:
  hard_limits:
    implementation_attempts: 12
    diagnostic_experiments: 16
    review_rounds: 4
    ci_repair_cycles: 3
    worker_turns_per_session: 30
    wall_minutes: 120
    model_cost_usd: 30
    parallel_workers: 4
    changed_files: 40
    changed_lines: 2000
    infrastructure_retries: 5
    recovery_attempts: 3
  initial_allowances: {simple_attempts: 2, medium_attempts: 4, complex_attempts: 6}
  extension:
    attempts_per_extension: 1
    require_measurable_progress: true
    require_new_hypothesis: true
    preserve_final_verification_reserve: true
  repeated_failure_threshold: 2
  final_reserve_fraction: 0.2
```

Hard limits are copied into the policy snapshot and never change during a run.
Starting allowances must fit under `implementation_attempts`. One more attempt
is granted only with measurable progress and a new, evidence-backed hypothesis,
and never from the final verification reserve. After
`repeated_failure_threshold` equivalent failures Orbit stops and interrogates
the plan.

## agents and review

```yaml
agents:
  default_parallelism: 1
  require_independent_work_units: true
  isolate_writers: true                 # cannot be turned off
  prohibit_shared_worktree_writes: true # cannot be turned off
  cancel_obsolete_workers: true

review:
  independent_provider_required: true
  preferred_provider: codex
  fallback_same_provider_allowed: false   # must stay false while the line above is true
  block_unresolved_high_impact_findings: true
```

If the reviewer provider is unavailable or not `data_policy_eligible`, a run
that requires independent review stops as `BLOCKED` instead of reviewing with the
implementer's provider.

## delivery

```yaml
delivery:
  provider: github       # github | fake
  pull_request: draft    # draft | ready | none
  max_ci_repair_cycles: 3   # may not exceed scheduler.hard_limits.ci_repair_cycles
  ci_timeout_minutes: 60
  require_ci: false
```

Delivery uses `git` and the `gh` CLI with the controller's `GH_TOKEN` only; a
worker never sees it. With `require_ci: false`, "no CI observed" is reported as
unverified; with `true`, such a delivery cannot succeed.

## checks

Checks are the only commands Orbit runs as evidence. A goal contract may name
only check ids defined here; a command written by a model is never executed.

```yaml
checks:
  lint:
    command: [npm, run, lint]
    timeout_seconds: 300
  unit-tests:
    command: [npm, test]
    flaky_reruns: 1
  build:
    command: "npm run build && test -f dist/index.js"
    shell: true
  ui-journeys:
    command: [npx, playwright, test, --reporter=json, --update-snapshots=none]
    kind: playwright
    timeout_seconds: 1200
```

| Key | Meaning |
|---|---|
| `command` | argv list run without a shell; a string needs `shell: true` and runs with `/bin/sh -c` |
| `cwd` | relative to the worktree root (default `.`) |
| `timeout_seconds` | default 600 |
| `network_hosts` | hosts the check may reach; must be covered by `network.allowed_hosts` |
| `env` | extra environment; delivery credentials such as `GH_TOKEN` are refused |
| `mandatory` | default true; a run cannot succeed while it fails |
| `flaky_reruns` | 0 to 5; reruns are used only to classify flakiness |
| `kind` | `command` (default) or `playwright` |

A check that fails then passes on rerun is reported as flaky. With
`verification.allow_flaky_pass: false` (the default) a flaky pass cannot make the
verdict PASS.

## ui

```yaml
ui:
  required_when_ui_changes: true
  ui_paths: ["apps/web/**/*.tsx", "apps/web/**/*.css"]
  browsers: [chromium]
  viewports:
    - {width: 1440, height: 900}
    - {width: 390, height: 844}
  environment:
    base_url: http://127.0.0.1:3000
    start_command: [npm, run, dev]
    ready_timeout_seconds: 120
    isolated_test_data: true
    production_accounts: false
  journey_check_ids: [ui-journeys]
  accessibility: {enabled: true, fail_on_new_serious_or_critical: true}
  visual:
    enabled: true
    baseline_changes_require_review: true
    baseline_globs: ["**/*-snapshots/**"]
  visual_baseline_auto_accept: false
```

`ui: null` turns UI verification off. Accessibility scans and visual checks have
limited coverage; Orbit reports that rather than claiming complete accessibility.

## isolation and providers

```yaml
isolation:
  provider: sandbox-runtime    # sandbox-runtime | container | none
  allow_unisolated: false
  container: {image: "node:22-bookworm", memory_mb: 4096, cpus: 2, pids: 512}  # required for container

providers:
  claude:
    command: claude
    data_policy_eligible: true
    model: null
    reasoning_effort: null
    extra_args: []
  codex:
    command: codex
    data_policy_eligible: false   # true only if sending sanitized code to this provider is permitted
    model: null
    reasoning_effort: null
    extra_args: []
```

## routing and retention

```yaml
routing:
  allowed_models: [opus, sonnet, haiku]   # fable is excluded on purpose
  overrides: {}                           # work kind -> family or exact id, within allowed_models

retention:
  keep_runs_days: 30
  redact_patterns: []                     # extra regular expressions redacted from logs and artifacts
```

## knowledge and guard

```yaml
knowledge:
  enabled: true
  share_globally: false
  max_advisory_tokens: 800
  curator_budget_usd: 0.25
  eval_budget_usd: 0          # 0 disables replay evaluations and automatic overlay adoption
  auto_adopt_overlays: true

guard:
  terms_file: null            # null means ~/.config/publish-guard/terms.txt
  allowed_emails: []

verification:
  allow_flaky_pass: false
```

See [the learning layer](learning.md). The guard reads a private-terms list that
Orbit never prints and never copies into a repository.

## Environment variables

| Variable | Effect |
|---|---|
| `ORBIT_HOME` | Orbit's user directory (default `~/.orbit`): logs, worktrees, global knowledge. |
| `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_API_KEY` | Provider credentials, passed through to workers and nothing else. |
| `GH_TOKEN` | Delivery credential, used by the controller only. |
| `ORBIT_DEBUG` | Print stack traces for internal errors. |
