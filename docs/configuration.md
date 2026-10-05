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

`change_secrets` is reserved: workers never hold or change secrets, so only
`false` is accepted. `change_permissions` is read by the authorization layer:
while it is `false`, commands that change file modes, owners, ACLs or flags
(`chmod`, `chown`, `chgrp`, `chflags`, `chattr`, `setfacl`) are denied. Setting
it to `true` allows them inside the worktree; protected paths and setuid bits
stay denied.

## release

```yaml
release:
  merge:
    method: squash            # squash | merge | rebase
    require_checks: [build]   # CI checks that must be green before merging
    delete_branch: true
  environments:
    production:
      deploy_command: [npm, run, deploy]   # argv, never run through a shell
      allowed_branches: [main]             # default: the base branch
      require_ci_green: true
      network_hosts: []                    # must be covered by network.allowed_hosts
      timeout_seconds: 1800
```

Default `null`. Mode `release` requires it (not null) and needs
`actions.merge` or `actions.deploy_production` to be true; without either, use
`autonomous-delivery`. `actions.deploy_production: true` needs at least one
environment, and an environment with no `allowed_branches` is an error, since
nothing could ever be deployed to it. Left-out merge settings and environment
fields take the defaults shown; `deploy_command` has none.

## dependencies and network

```yaml
dependencies:
  install_existing_lockfile: true
  install_command: null              # argv list, or null to detect
  add_packages: false
  change_lockfile: false
  install_scripts: deny-unless-allowlisted   # deny | deny-unless-allowlisted | allow
  install_script_allowlist: []
  audit:
    enabled: false
    fail_on: high                    # critical | high | moderate | low
    license_allowlist: null          # SPDX ids, or null for no license policy
    exceptions: []                   # {id, reason, expires}

network:
  allowed_hosts: [github.com, api.github.com, registry.npmjs.org]
```

Hosts are exact names, IPv4 addresses, or `*.example.com` (subdomains only).
No ports, schemes or bare `*`. Everything else is blocked by the sandbox.
`add_packages` also needs `change_lockfile`.

`dependencies.audit` is the vulnerability and license policy of the baseline
and dependency gates (npm lockfiles). When enabled, `npm audit --json
--package-lock-only` runs inside isolation (registry network only, no
scripts) on the base revision, and the result is recorded in `baseline.json`
together with the packages whose lockfile license is not on
`license_allowlist`. A candidate that changes `package.json` or the lockfile
is audited again; its install is refused, with one recorded failure per
finding for the repair brief, when it introduces a vulnerability at or above
`fail_on` or a package with a license not on the allowlist. Vulnerabilities
below `fail_on` are reported as advisory, and findings the base already had
are never blamed on the candidate. A license expression `A OR B` is allowed
when either side is, `A AND B` only when both are, and a package with no
license is not allowed.

An exception names an advisory (`GHSA-xxxx-xxxx-xxxx`, or `npm:<source id>`
when the advisory has no GHSA id) or a license finding (`license:<package>`
or `license:<package>@<version>`), with a `reason` of at least ten
characters and an optional `expires` date. An expired exception is reported
and not applied.

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
  require_independent_work_units: true  # cannot be turned off
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

## static_security

```yaml
static_security:
  block_severities: [critical, high]   # critical | high | medium | low
  exceptions:
    - {rule_id: generic-api-key, path_glob: "tests/fixtures/**", reason: "revoked sample keys for parser tests", expires: 2026-12-31}
```

Severity and exception rules for the static security gate. Every secret-scan
finding has a severity: credentials for an account, a cloud or a signing
identity (private keys, cloud keys, GitHub, GitLab, model provider and
payment tokens) are `critical`, any other detected secret is `high`. SAST
checks (`category: sast`) that write SARIF (`*.sarif` or `*.sarif.json`) to
`$ORBIT_ARTIFACTS_DIR` are judged by finding: severity comes from the
`security-severity` score when the tool writes one (9.0 and up critical, 7.0
high, 4.0 medium), otherwise from the level (error high, warning medium, note
low). Findings at a listed severity block; the rest are reported as advisory.

An exception waives the findings of one rule (`rule_id` is the gitleaks rule
id, the built-in scanner's kind such as `github-token`, or the SARIF rule id),
under one path glob when `path_glob` is set, until `expires`. The waiver and
its reason are recorded with the evidence; an expired exception is reported
and not applied.

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
  exploration: {enabled: false, max_minutes: 15, budget_usd: 2}
```

`ui: null` turns UI verification off. `exploration` (off by default) lets an
explorer look for UI defects beyond the journeys, within the time and spend
ceilings; its findings are unproven until reproduced as a failing test. Accessibility scans and visual checks have
limited coverage; Orbit reports that rather than claiming complete accessibility.

## isolation and providers

```yaml
isolation:
  provider: sandbox-runtime    # sandbox-runtime | container | none
  allow_unisolated: false
  container: {image: "node:22-bookworm", memory_mb: 4096, cpus: 2, pids: 512}  # required for container
  limits:
    cpu_seconds: null          # CPU time per process
    max_processes: null        # processes of the user id (RLIMIT_NPROC)
    max_file_mb: null          # largest file a process may write

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

`isolation.limits` sets hard per-process limits on every worker shell
command and check. With `sandbox-runtime` and `none` they are applied by
`bash` with `ulimit` right before the command starts (inside the sandbox, so
srt itself is not limited); with `container` they become `docker --ulimit`
flags next to the container's own memory, CPU and pids limits. A wrapped
command cannot raise them again. `max_processes` is the kernel's per-user
limit: it counts every process of your user id, not only the command's, so
set it well above what the account already runs. Memory is limited only by
the container provider. When limits are set and no `bash` is found, the
command is refused rather than run without them.

## routing and retention

```yaml
routing:
  allowed_models: [opus, sonnet, haiku]   # fable is excluded on purpose
  overrides: {}                           # work kind -> family or exact id, within allowed_models
  output_budgets:                         # output tokens per role, 100 to 200000
    planner: 4000
    implementer: 8000
    verifier: 3000
    reviewer: 4000
    inquisitor: 3000
    curator: 2000
    explorer: 2000

retention:
  keep_runs_days: 30
  redact_patterns: []                     # extra regular expressions redacted from logs and artifacts
```

`output_budgets` defaults follow the token-efficiency table in
[the architecture](architecture.md); a partial map overrides only the roles it
names.

`redact_patterns` are JavaScript regular expressions (compiled with the `u`
flag). From the moment a run's policy is frozen or verified, every redaction
in that process applies them as well as the built-in secret shapes: the
controller log, worker prompts, check and CI logs, review packets and
`final.md`. A match becomes `[REDACTED:custom]`. A pattern that can match the
empty string is refused when the configuration is loaded, because it could
never be applied.

`keep_runs_days` is the artifact retention period. The retention pass
(`pruneExpiredRuns` in `src/storage/retention.ts`) removes `.orbit/runs/<id>/`
and the run's worktrees under `$ORBIT_HOME/worktrees/` for runs that ended
(`SUCCEEDED`, `EXHAUSTED`, `IMPOSSIBLE` or `CANCELLED`) more than that many days
ago. The database rows stay and are marked with a `run.artifacts_pruned`
event. A `BLOCKED` run is never pruned, and neither is a run whose controller
still holds its lease.

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
