# Changelog

## Unreleased

- Checks may listen on loopback: `local_binding` (default true) on a check
  sets the sandbox's local binding for that check only. Outbound reach is still
  `network_hosts`. The first live run failed the demo app's `unit` check on the
  base revision and every candidate with `listen EPERM` because every trusted
  check ran with loopback binding denied.
- An environment failure is not repaired: a mandatory check that fails on the
  candidate as it failed on the base revision, with a sandbox or environment
  denial in its output (EPERM, "operation not permitted", an srt violation
  marker, EACCES outside the worktree), ends the run BLOCKED before the repair
  loop. The outcome reason names the check, the cause and the two ways forward
  (fix the environment or the check definition, or approve the baseline
  exception question). An approved baseline exception also makes an earlier
  FAIL or INCOMPLETE evidence report stale, so the resumed run judges the
  recorded results under the amended contract.
- Engineering practices: the planner selects or justifies each of the nine
  practices; the contract, the reviewer packet and the final report carry them.
- A pre-existing failing mandatory check raises a decision question in
  PREFLIGHT; `orbit decide` with "Approve" adds a fingerprint-bound baseline
  exception to the contract, and the command prints what it did.
- The Inquisition records the impact register for a risk review; `final.json`
  and `orbit report --json` are redacted like `final.md`.
- Supervised mode also asks about denied `actions.*` and `network.*` operations
  from a worker (approve-once retries the attempt under a grant for exactly
  that operation; deny sends a scope repair).
- Parallel writers within one run for disjoint work units (only with
  `agents.default_parallelism` of 2 or more, never supervised), with merge
  overhead charged by the scheduler.
- `orbit verify` and the VERIFYING step share one evidence collection.
- Release mode: marks a draft pull request ready before merging, rebases a
  moved base when `actions.rebase_task_branch` allows, deploys each defined
  environment its branch allows, and `orbit release resolve` settles an unknown
  deploy.
- `isolation.limits` is on by default (CPU 3600 s, 2048 processes, 2048 MB
  files, 4096 MB memory). The process default is high because the limit counts
  every process of the user id.
- `orbit run --environment <name>` (release mode) deploys only that
  environment; the name is kept in the contract as `delivery.environment` and
  is refused when the release profile does not define it or does not allow it
  for the deployed branch, before anything is merged.
- `isolation.require_resource_limits` (default false) refuses a provider that
  cannot enforce a configured limit, at preflight and in `orbit doctor`.
- An approved baseline exception is also applied when VERIFYING starts, and
  `npm run test:coverage` enforces an 80% per-file lines floor.
- The baseline gate lists base-revision dependency audit findings.
- Documented every CLI command and flag, including `verify`, `repair`, `stats`
  and `gc`, release mode safeguards, and resource limits per isolation provider.
- Documented the native `/goal` command as an optional interactive aid; the
  controller stays the completion authority.
- The README now states that the live demo has not yet run against real providers.
- Config keys documented: `actions.rebase_task_branch`,
  `release.merge.mark_ready`, `release.environments[*].verify_command`, and
  `isolation.limits.memory_mb` (enforced under sandbox-runtime by a
  resident-memory watchdog on the process group).

## 0.1.0

First release.

- Durable goal contracts, an explicit run state machine, and one owner lease
  per run in a repository-local SQLite state database.
- Immutable policy: `.orbit/config.yaml` is validated and frozen into a hashed
  snapshot at run start.
- Isolated workers in git worktrees outside the repository, in the
  `os-sandbox` or `claude-sandbox` tier, with sandbox-runtime or Docker
  isolation for trusted checks.
- Controller-side candidate snapshots, trusted check execution, and evidence
  bound to the candidate tree, check configuration and policy.
- Independent review by a second provider (Codex), with a data-policy gate.
- Adaptive iteration budgets under fixed hard caps; model routing with
  recorded justification; usage and cost accounting.
- Orbit Inquisition for unclear goals, weak evidence and repeated failures.
- Playwright UI journeys with accessibility and visual-baseline handling.
- Delivery through `git` and `gh` with an intent, execute, receipt ledger;
  CI observation and repair.
- Recovery: foreground and service execution (launchd, systemd user unit),
  heartbeats, watchdog, reattachment to workers after a controller crash.
- A learning layer: lesson graph, calibration, prompt overlays with replay
  evaluation and rollback, JSON-LD export, publication guard.
- The `orbit` CLI, six plugin skills, six agents and the guard hook, shipped as
  one committed bundle (`dist/orbit.mjs`).
