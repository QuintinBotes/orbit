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

`scope.credential_paths` (list of globs, default empty): files workers may never read, enforced by the OS read-deny list, the Read tool and the Bash read check, in addition to the built-in credential patterns. Use it for credentials whose names do not say so.
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
  rebase_task_branch: false
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

`rebase_task_branch` (default `false`) is the permission to rebase the task
branch onto a base branch that has moved on. It needs `commit`. While it is
`false`, a moved base branch is reported and never rebased over.

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
    mark_ready: true          # mark a draft pull request ready for review before merging
  environments:
    production:
      deploy_command: [npm, run, deploy]   # argv, never run through a shell
      verify_command: null                 # argv that exits 0 when the deploy took effect
      allowed_branches: [main]             # default: the base branch
      require_ci_green: true
      network_hosts: []                    # must be covered by network.allowed_hosts
      timeout_seconds: 1800
```

A run can name the one environment it deploys to with `orbit run --environment
<name>`; the name must be a key of `environments`, and the contract carries it
as `delivery.environment` (see [operations.md](operations.md#release-mode-safeguards)).
Without it a run deploys every environment its branch is allowed for.

Default `null`. Mode `release` requires it (not null) and needs
`actions.merge` or `actions.deploy_production` to be true; without either, use
`autonomous-delivery`. `actions.deploy_production: true` needs at least one
environment, and an environment with no `allowed_branches` is an error, since
nothing could ever be deployed to it. Left-out merge settings and environment
fields take the defaults shown; `deploy_command` has none.

`merge.mark_ready` (default `true`): when the pull request is still a draft,
release mode marks it ready for review as its own ledgered action before it
merges. Set it to `false` to have a person do that.

`verify_command` (default `null`) is a trusted command that reports whether a
deploy took effect: exit 0 means it did, any other exit means it did not. It is
used to reconcile a deploy whose outcome is UNKNOWN (for example after a crash
in the middle of it). It runs like `deploy_command`, in isolation and with the
environment's `network_hosts`. With `null`, an UNKNOWN deploy waits for a
person.

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

A changed file the scanner could not read (its size is unknown, or it is above
the 1 GiB streaming limit) is reported as an `unscannable-file` finding. It
blocks and leaves the scan incomplete whatever `block_severities` lists; only
an exception for that rule and path waives it.

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
| `local_binding` | default true: the check may listen on 127.0.0.1 (a test suite that starts an HTTP server); outbound reach is still only `network_hosts`. Set false for a check that never serves |
| `env` | extra environment; delivery credentials such as `GH_TOKEN` are refused |
| `mandatory` | default true; a run cannot succeed while it fails |
| `flaky_reruns` | 0 to 5; reruns are used only to classify flakiness |
| `kind` | `command` (default) or `playwright` |

A check that fails on a candidate exactly as it failed on the base revision,
with a sandbox or environment denial in its output (`EPERM`, "operation not
permitted", an srt violation marker, or `EACCES` on a path outside the
worktree), is an environment failure, not a defect in the change. The run ends
`BLOCKED` before the repair loop instead of spending attempts on it. The outcome
reason names the check and the cause and offers two ways forward: fix the
environment or the check definition and start a new run (a run's policy and
recorded check results are frozen), or approve the baseline
exception question that PREFLIGHT raised for the pre-existing failure with
`orbit decide`, then `orbit resume`. A plain pre-existing code failure, with no
such signal, keeps the repair loop.

A mandatory check that could not execute at all is an environment failure too,
with or without a base-revision comparison: its process (or the UI application
under test) was killed by a crash signal such as `SIGABRT` before it printed
anything of its own, or the runner could not start it. The run ends `BLOCKED`
before the Inquisition and the repair loop, and the reason names the check, the
cause and the log. Only the first way forward applies, since a check that never
ran has no failure to except. A check that ran and failed, an application that
threw while loading, or a crash after test output keeps the repair loop.

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
    cpu_seconds: 3600          # CPU time per process
    max_processes: 2048         # processes of the user id (RLIMIT_NPROC)
    max_file_mb: 2048          # largest file a process may write
    memory_mb: 4096            # resident memory of the command's processes (watchdog)
  require_resource_limits: false   # true: refuse a provider that cannot enforce a configured limit

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
    tier: auto                    # auto | os-sandbox | codex-sandbox (Codex only)
```

`providers.<id>.tier` is the isolation tier of the Codex reviewer (ADR 0001,
"Codex reviewer tiers" and "Second live finding"). It is chosen by login type,
because Codex inside `srt` cannot use a ChatGPT login (it connects, then fails
with "workspace routing discovery failed"):

| value | what runs | when |
| --- | --- | --- |
| `auto` (default) | `os-sandbox` when `CODEX_API_KEY` or `OPENAI_API_KEY` is set (not blank) in the worker environment and `srt` starts here; otherwise `codex-sandbox` | the usual choice |
| `os-sandbox` | `codex exec --sandbox danger-full-access` inside `srt`, which is then the only sandbox | refuses with `ISOLATION_UNAVAILABLE` when `srt` is not in use or does not start; it never falls back to an unwrapped Codex. With no API key in the environment it still runs, and records that a ChatGPT login cannot work there (an API-key login stored in `CODEX_HOME` can) |
| `codex-sandbox` | `codex exec --sandbox read-only`, never wrapped in `srt`, even when `srt` and an API key are available | reads are unrestricted, and the worker record says so |

Both API key variables are passed to a Codex worker (and to no other worker).
The worker record always carries the tier and its limitations, and `orbit
doctor` reports the tier the reviewer will use and why (`codex.worker-tier`),
as a warning when `auto` falls back to `codex-sandbox`. The key exists for
Codex providers only (`codex`, or an id starting with `codex-` or `codex_`):
`providers.claude.tier` is rejected with a config error, not ignored, because
Claude workers choose their own tier (`os-sandbox` with an exported credential
and `sandbox-runtime`, else `claude-sandbox`; see [installation](installation.md#isolation-tiers))
and a setting that silently did nothing would read as confinement that is not
there. A config without the key (an older snapshot) reads as `auto`.

`isolation.limits` is on by default. Set a value to `null` to turn that limit
off. It sets hard per-process limits on every worker shell command and check.
With `sandbox-runtime` and `none` the first three are applied by `bash` with
`ulimit` right before the command starts (inside the sandbox, so srt itself is
not limited); with `container` they become `docker --ulimit` flags next to the
container's own memory, CPU and pids limits. A wrapped command cannot raise
them again. `max_processes` is the kernel's per-user limit: it counts every
process of your user id, not only the command's, so if your account already
runs more than 2048 processes (a desktop with many applications can), raise it
or the command will fail to start processes. When limits are set and no
`bash` is found, the command is refused rather than run without them.

`memory_mb` cannot be a ulimit (RLIMIT_AS breaks node, the JVM and Go, and
macOS ignores RLIMIT_RSS), so under `sandbox-runtime` a watchdog starts the
command, samples the resident memory of the command's process group and
descendants with `ps` every 500 ms, and kills them all with SIGKILL when the
sum passes the limit. The check or worker is then recorded as a resource-limit
failure that names the limit. It samples, so a command that allocates faster
than that can overshoot before it is stopped, and it sums resident sets, so
memory shared between processes counts once per process. Without `ps` (or
node), the command is refused rather than run without the limit.

What each provider enforces:

| limit | sandbox-runtime | container | none |
| --- | --- | --- | --- |
| `cpu_seconds` | ulimit | `--ulimit cpu` | ulimit |
| `max_processes` | ulimit | `--ulimit nproc`, plus `container.pids` | ulimit |
| `max_file_mb` | ulimit | `--ulimit fsize` | ulimit |
| `memory_mb` | resident-memory watchdog | not used; `container.memory_mb` is enforced by Docker | not enforced |

`none` runs commands with every permission of the Orbit user and applies only
the ulimit limits; it enforces no memory limit. The wall-clock timeout is the
caller's job under every provider.

`require_resource_limits` (default `false`) turns a gap in that table into a
refusal. By default a limit the provider cannot enforce is only stated in the
evidence record. With `true`, the environment gate at preflight blocks the run
(before any worker starts) when a limit that is not `null` cannot be enforced,
and `orbit doctor` fails its isolation check with the same message. The
ulimit-based limits are enforced by every provider, so only `memory_mb` can be
refused:

- `sandbox-runtime` is refused: its watchdog samples resident memory and a fast
  allocation can overshoot it, so it is not a hard cap.
- `none` is refused: it enforces no memory limit.
- `container` is accepted when `container.memory_mb` (Docker's hard cap, which
  replaces `limits.memory_mb`) is no higher than `limits.memory_mb`, and refused
  when it is higher or `container` is not set.

To satisfy it, use the `container` provider, set `limits.memory_mb: null` to
run without a memory limit (the other limits stay required), or set
`require_resource_limits: false`.

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
