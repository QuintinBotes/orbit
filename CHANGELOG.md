# Changelog

## Unreleased

- The Codex reviewer's tier is chosen by login type (ADR 0001, "Second live
  finding"). Inside `srt`, Codex with a ChatGPT login fails with "workspace
  routing discovery failed", so the new `providers.codex.tier` (`auto`,
  `os-sandbox`, `codex-sandbox`; default `auto`) picks `os-sandbox` only when
  `CODEX_API_KEY` or `OPENAI_API_KEY` is in the worker environment and `srt`
  starts, and `codex-sandbox` otherwise, recording that reads are unrestricted
  and that a ChatGPT login cannot run under `srt`. An explicit `os-sandbox`
  without `srt` fails closed with `ISOLATION_UNAVAILABLE`; an explicit
  `codex-sandbox` never wraps. `OPENAI_API_KEY` is now passed to Codex workers
  (and to no other worker). `orbit doctor` reports the tier and why
  (`codex.worker-tier`). A Claude provider rejects the `tier` key. The refusal
  of `--sandbox danger-full-access` outside the `srt` wrapper is unchanged.
- The Codex reviewer follows two tiers (ADR 0001, "Codex reviewer tiers"). The
  first live run showed Codex's own sandbox cannot start inside `srt` on macOS
  (`sandbox_apply: Operation not permitted`), so the reviewer exited 1 with
  `Operation not permitted (os error 1)`. Under `srt` (`os-sandbox`) Codex now
  runs with `--sandbox danger-full-access` and `srt` as the only sandbox: writes
  only to the worker directory and Codex's state directory, never the review
  checkout; egress only to the Codex provider hosts; credential paths unreadable
  except Codex's own auth file. Without `srt` (`codex-sandbox`) it runs unwrapped
  with `--sandbox read-only` and records that reads are unrestricted. The
  adapter refuses `danger-full-access` in any combination but the `srt` wrapper;
  other isolation providers are no longer wrapped around Codex.
- The UI application starts under `srt` again (second live finding on the demo
  app). `startApp` hands the app its log as stdout and stderr, and the log sits
  in the run's evidence directory, which every profile read-denies. On macOS
  Seatbelt answers EPERM to `fstat` on a descriptor opened for writing on such
  a path, and node aborts at startup when `fstat` fails on descriptor 0, 1 or 2
  (`node::InitializeOncePerProcessInternal`, then `SIGABRT`), so the mandatory
  UI checks never ran. The isolation providers' `wrap` now takes `stdioFiles`:
  files the caller hands the command as descriptors; the `srt` provider makes
  exactly those files readable (never writable) and the app fixture names its
  log. Egress rules, credential read-denies, the write allowlist and the
  default limits are unchanged. Unit checks were never affected: the check shim
  gives the sandboxed command pipes, and workers get an unlinked spill file.
- A mandatory check that could not execute is an environment failure too: the
  UI application or a check's process was killed by a crash signal before it
  printed anything of its own, or the runner could not start the check. The run
  ends `BLOCKED` at once, through the same path as the failures above, instead
  of entering the Inquisition and the repair loop (in the live run it repeated
  the identical tree before blocking). The reason names the check, the cause and
  the log, and the one way forward that applies (there is no baseline exception
  for a check that never ran). A check that ran and failed, or an application
  that threw while loading, keeps the repair loop.
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
