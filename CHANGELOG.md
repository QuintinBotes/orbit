# Changelog

## Unreleased

- `orbit run` no longer starts a run whose worker sessions would all be refused for a plugin the policy does not allow (#22). `orbit doctor` failed `claude.plugins` for the managed plugins that the defaults (`agents.allowed_plugins: []`, `agents.allow_managed_plugins: false`) refuse, yet `orbit run --foreground` went on: about ten minutes of base-revision checks, baseline-exception questions and a planner worker, then two refused planner attempts and a refused curator (about 0.8 USD, nothing produced). Run start now makes doctor's judgement (one shared function, `judgeWorkerPlugins`): `orbit run --foreground` refuses in admission, before a run row, a frozen policy, a check or a model call exists, with every plugin id and doctor's exact fix line (exit 4, "No run was created"); a run handed to the service (`--detach`) or resumed is judged by its controller at the start of PREFLIGHT, before the base-revision checks, and ends BLOCKED with nothing spent (no check, no question, no worker, no curator). Why two places and not one: only the process that drives a run can judge its Claude Code environment, and a run that exists has already frozen the policy the fix would change, so refusing before it exists is the clean outcome whenever this process drives it; a BLOCKED run that cost nothing is the fallback when only the service can judge, and its message says the way out (allow the plugin and start a new run, or remove the plugin and `orbit resume --force`).
- A worker session that Orbit refuses after it started (a plugin the policy does not allow, an MCP server, another permission mode) is not transient and is no longer retried as a worker attempt (#22): the planner, the reviewer and diagnosis units, and the implementer (also a parallel work unit) end the run BLOCKED after that one session. The outcome line carries the whole refusal, naming every plugin and the config line that allows it (it was cut at 200 characters, mid-sentence), and says that `orbit doctor` shows the cause. A run that ended this way with no candidate does not start the curator, which would be refused in the same environment (`worker_refusal` in the run outcome, "refused" in `learning.json`).
- `orbit init` in a linked git worktree says that the exclude file it wrote is shared (#3 follow-up). git reads only the common git directory's `info/exclude`, so the rules always went to the main checkout's `.git`, outside the worktree, which surprised a person who expected init in a worktree to change nothing outside it. Orbit keeps that shared write (one write covers every worktree, nothing is committed) and now names the file and states that every worktree of the clone shares it, both when it adds the rules and when they are already there. `orbit init --json` gains `exclude_file` (`path` and `shared_across_worktrees`, true in a linked worktree and false in a normal checkout; detected with git by comparing `--git-dir` with `--git-common-dir`); `exclude` keeps its `path` and `added`. A normal checkout prints what it always did.

## 0.2.0 (2026-10-06)

- New `orbit timeline <run-id>`: the readable history of a run, one line per significant step in order with the local time. It shows state transitions with their reasons, routing and escalation decisions with their evidence, each attempt and candidate with its verification verdict, check results, the review outcome and reviewer, questions asked and answered, delivery actions, and the cost so far as measured and as charged. `--follow` streams a running run, `--last <n>` cuts it, `--all` adds housekeeping events and `--json` is for machines. `orbit logs` stays the raw output and its help now points to the timeline; `/orbit:status <run-id>` shows the status and then the last steps of the timeline.
- `orbit init` proposes checks from what the repository declares, for the tools found on PATH: Node (package.json scripts lint, typecheck or a tsc config, test, build; npm, pnpm or yarn from the lockfile), .NET (`dotnet build` and `dotnet test` on the solution or the projects), Python (pytest, ruff or flake8, mypy when configured), Go (`build`, `vet`, `test` over `./...`) and Rust (`cargo build`, `test`, `clippy` when installed). Each has a category, a timeout and a comment asking for review; a mixed repository gets all of them, a monorepo gets root-level commands, an existing config is never touched, and init prints what it proposed and why (`checks.proposed` and `checks.not_proposed` in `--json`).
- `orbit init` no longer proposes folders that hold CI pipeline or build-system definitions (pipeline YAML with a top-level trigger, stages, jobs or extends template, Jenkinsfiles, GitLab CI, CircleCI) as `scope.allowed_paths`; it protects them, plus central build files such as Directory.Build.props, Directory.Packages.props, global.json, nuget.config and a root Makefile, in `scope.protected_paths`, and tells the person to narrow the scope to the goal (#4).
- A linked git worktree is its own repository root (`git rev-parse --show-toplevel`): `orbit init` writes the worktree's `.orbit/config.yaml` with the worktree's branch as `repository.base_branch`, `doctor`, `run` and every other command use the worktree's branch, cleanliness and state, `.git/info/exclude` stays shared, and worker checkouts made from a linked worktree find its own git directory (#3).
- Skills: `/orbit:status`, `/orbit:doctor`, `/orbit:init` and `/orbit:inquisition` are model-invocable, so an agent asked to use Orbit sees them; `run`, `resume`, `repair` and `verify` stay user-only and say that a person starts them; `scripts/check-plugin.mjs` enforces the allowlist (ADR 0006 addendum) (#2).
- Skills: `status` and `doctor` pre-approve their own read-only `orbit` command with `allowed-tools`, so `claude -p "/orbit:status"` prints the status without a permission denial (#2).
- Docs: README and installation say that `orbit` reaches the Bash tool's PATH only after `/reload-plugins` or in a new session, and what to use until then (#5).
- Worker sessions with organisation-managed plugins no longer block every run (#9): `agents.allowed_plugins` (exact name@marketplace ids) and `agents.allow_managed_plugins` admit a plugin (default strict); a refusal names each plugin and the config line that allows it, every non-built-in plugin is recorded in the worker's result and the final report, and `orbit doctor` lists the plugins a worker would load.
- A check the environment stopped on the base revision (a sandbox denial on a filesystem call outside its checkout, or a crash before any output) now blocks the run at PREFLIGHT with the first error line and a fix, and is never offered as a baseline exception; the same refusal on a candidate blocks without a repair, and a compile error or failing test in the output keeps the normal path (#10).
- Checks get the .NET SDK's first-run settings (NuGet migrations marked done in the private home, `DOTNET_CLI_HOME`, telemetry, logo, certificate, tools path and workload check off), so `dotnet build` runs under `srt` instead of dying with EPERM on `/tmp/.dotnet` (#10).
- `orbit doctor` (`checks.sandbox`) starts each check's executable in its sandbox with a harmless argument and reports a sandbox denial before any run (#10).
- Linux: `dotnet build` checks run under `srt` with the .NET 9 and 10 SDKs. Checks set `EnableSourceControlManagerQueries=false`, so the build no longer reads git metadata that `srt` makes unopenable on Linux (an absent `.gitmodules`); and a write the sandbox refuses outside the checkout is recognised in its Linux form (EROFS, "Read-only file system") as well as macOS's EPERM, so `orbit doctor` and the baseline report it there too.
- doctor lists every unmet reviewer prerequisite at once (login, data policy attestation, no qualified model), each with its own fix, and orbit init seeds the model registry and reads the Codex catalog so a fresh setup does not hit the second failure (#7).
- Review falls back to a disclosed Claude review by default when no independent reviewer is usable: new `review.providers` (preference order, supported ids only) and `review.when_unavailable: claude | ask | block`, with the legacy keys mapped onto it; reports, decisions and `orbit doctor` say which reviewer was used and, for a same-provider review, why it is not independent (#8, ADR 0007).
- `review.when_unavailable: ask` raises a material question and runs the same-provider review only after a person's yes (`orbit decide`), recorded as a decision (#6, ADR 0007).
- Release automation. Pushing a `v*` tag runs `.github/workflows/release.yml`: it checks that the tag matches `package.json`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json` and the version `orbit --version` reports, that `CHANGELOG.md` has a section for it and that the commit is on `main`; runs the full gate (typecheck, unit, integration, fault and acceptance tests, `check:dist`, `check-plugin`); builds an archive of the `plugin/` payload with checksums and a GitHub artifact attestation (`actions/attest-build-provenance`); creates the GitHub release with that CHANGELOG section as the notes; and opens a pull request on `QuintinBotes/claude-plugins` that moves the orbit entry's `ref` to the tag. The last step needs the secret `CATALOG_PR_TOKEN` and is skipped with a notice without it. New scripts `scripts/release-notes.mjs`, `scripts/check-release-versions.mjs` and `scripts/bump-catalog-ref.mjs`, each with unit tests; the process is in CONTRIBUTING.md and the verification steps in docs/installation.md.
- Notifications (ADR 0008). When a run ends or raises a question a person must
  answer, Orbit notifies through the new `notifications` policy section: a
  desktop notification (macOS `osascript`, Linux `notify-send`; on by default),
  a webhook (Slack-compatible `text`; the URL is read from the environment
  variable `notifications.webhook.url_env` names, must be `https` to a host in
  `network.allowed_hosts`) and a comment on the run's pull request or linked
  issue. Payloads carry the run id, state, a short redacted reason, the next
  action and question ids only. Each notification is sent once; delivery
  failures are recorded as events and never change the run.
  `ORBIT_NOTIFICATIONS=off` turns every channel off. New command
  `orbit notify test`.
- Remote answers (ADR 0008). With `notifications.remote_answers.enabled`, a
  `/orbit answer <question-id> <choice>` comment on the run's pull request (or
  the linked issue) answers an open question, but only when the GitHub API says
  its author has write, maintain or admin permission when the comment is read.
  The answer is recorded like `orbit decide`, with the comment URL, author and
  permission; anything else is ignored and recorded. The service polls blocked
  runs and resumes them once no material question is open; without a service,
  `orbit resume` reads the comments first.
- Toolchain sandbox profiles (ADR 0009): checks and workers that use Go, Rust, Python, the JVM or .NET (detected from the check's command and the repository's marker files) get the repository's dependency caches (`GOMODCACHE`, `CARGO_HOME`, `PIP_CACHE_DIR`, Gradle's and Maven's repositories, `NUGET_PACKAGES`) from `<orbit home>/toolchains/<repo key>/`, read-only, and their build state (`GOCACHE`, `GOPATH`, `CARGO_TARGET_DIR`, `PYTHONPYCACHEPREFIX`, `java.io.tmpdir`) in a private directory per check attempt or per worker. Only Orbit's dependency-install step writes the caches; nothing is shared between repositories and nothing points at your own caches. A check's `env` still overrides every variable.
- A configured `dependencies.install_command` also reaches the registries of the toolchains its command and the repository use (for example `index.crates.io` and `static.crates.io` for `cargo fetch --locked`), not only the npm registry.
- `orbit doctor` (`checks.sandbox`) adds one line per toolchain the checks or the repository use: whether it starts in the check sandbox and where its dependency caches live.
- Toolchain profiles pass the host's absolute `JAVA_HOME` to JVM checks (macOS's `/usr/bin/java` stub needs it to find a JDK) and rustup's home (`RUSTUP_HOME`, else `~/.rustup`) to Rust checks, both read-only and never into a container; `orbit doctor` starts each toolchain by its name, so a rustup proxy such as `cargo` is tested as itself.
- A check's scratch is removed even after a tool made it read-only on Node 24, which reports that case as `ENOTEMPTY`.

## 0.1.0 (2026-10-06)

The first release. The entries below record what changed while testing it
end to end and live; the initial implementation follows under "Initial
implementation".

End-to-end test round of 2026-10-05 (a new user installing and running Orbit
against real providers). Fixes, each with a test that failed first:

- Packaging. The plugin is the `plugin/` directory (ADR 0006), so a marketplace
  install brings only the sandbox runtime `srt` (pinned 0.0.78, with a
  lockfile) instead of every development dependency of the repository. The
  marketplace entry is a `git-subdir` source with path `plugin`. New skills
  `/orbit:init` and `/orbit:doctor`; `bin/orbit` puts `orbit` on the PATH of
  Claude Code's Bash tool, and messages name the `/orbit:<skill>` for plugin
  users. Skills pass free text through a quoted here-document (`--goal -`,
  `repair -`) and validate run ids; `run`, `resume` and `repair` check the
  service, then hand the run to it (`--detach`) or drive it from the session
  (`--foreground`); `orbit resume` gained `--detach`. The SessionStart hook now
  prints open questions (`orbit questions --pending --quiet`).
- Starter configuration. The starter mode is `autonomous` and the delivery
  actions follow the mode, so the quickstart validates under every `--mode`.
  `orbit init` derives `scope.allowed_paths` from the repository layout, and
  `orbit doctor` warns (`scope`) when they match no tracked file.
- Run admission. `orbit run` refuses a dirty working tree, git credentials in
  the repository's configuration and, for a foreground run, a failing
  environment gate, before it creates a run.
- Verification. A PASS can no longer rest on green checks that prove nothing:
  a candidate whose tree is the base tree is INCOMPLETE, and a criterion is
  `unverified` unless a check failed on the base revision or the candidate adds
  or changes a test. Evidence paths are relative to the run directory and
  `orbit verify` shows them relative to the repository.
- Reports. A candidate commit that was not delivered is reported as "candidate
  commit (local, not delivered)", never as a delivered commit.
- Run loop. A recorded Approve or Reject of a contract amendment is applied to
  the contract. A resume after fixing a failed worker starts a fresh series of
  attempts (spending one `recovery_attempts`) instead of replaying the stored
  failure. An accepted reviewer claim goes to repair instead of dead-ending in
  BLOCKED. A block that comes from the frozen policy says so and tells you to
  start a new run; `orbit resume` refuses it (exit 5) unless `--force`. A
  foreground resume after `kill -9` expires the dead controller's lease.
  Block and exhaustion messages name the real cause.
- Budgets. A session with tokens but no reported cost is charged a token-priced
  estimate, and a session is presumed to cost at most half the cost cap (at
  least $1), so $2 and $4 caps admit their first session. Per-role output
  budgets are larger (planner 16000, implementer 24000, verifier 8000,
  reviewer 12000, inquisitor 6000, curator 4000, explorer 6000), and a response
  that exceeds its cap is retried once at double the cap, up to 32000.
- Baseline questions. A baseline-exception question is withdrawn when the goal
  is to make that check pass; open ones are closed when a run SUCCEEDS.
- Cleanup. A run that ends SUCCEEDED or CANCELLED removes its worktrees;
  `orbit gc --keep-days 0` is allowed. `orbit service uninstall` waits for the
  service manager to release the job and reports a stop still in progress.
- CLI. Fix and summary text is no longer truncated mid-sentence; `-v` prints the
  version; group commands list their subcommands with `--help`; `help <unknown>`
  exits 2; misspelled commands get a suggestion; a closed pipe exits quietly;
  `models list` agrees with doctor about eligibility.
- Documentation. The README quickstart is rewritten to be followed literally
  from a marketplace install or a clone, and the install, configuration,
  operations, troubleshooting and security documents now describe the above. The
  live demo status is stated from the recorded reports (docs/demos/2026-10-05).

- Browser journeys run under `srt` on macOS (ADR 0001, "Browsers under
  sandbox-runtime on macOS"; live demo 2). Chromium aborted at start because
  Seatbelt refused its Mach rendezvous service (`bootstrap_check_in
  org.chromium.Chromium.MachPortRendezvousServer.<pid>`), so every journey
  failed. A new `SandboxProfile.chromiumMachRendezvous`, set on UI-check and
  exploration profiles only (never the application under test or a worker),
  makes the `srt` provider start `srt`'s unmodified CLI as `node --import
  srt-chromium-preload.mjs cli.js`. The preload adds exactly two rules,
  `mach-register` and `mach-lookup` for
  `^org[.]chromium[.]Chromium[.]MachPortRendezvousServer[.][0-9]+$`, after the
  one `(allow process-exec)` of the single-quoted `sandbox-exec -p` profile,
  and exits 97 for any other shape, any other way of running `sandbox-exec`,
  or an exit without a patched sandbox. Browser checks require `srt` 0.0.78
  (otherwise `ISOLATION_UNAVAILABLE`), and node and the preload must be out of
  the sandbox's write reach. The preload ships as `dist/srt-chromium-preload.mjs`,
  and `npm run check:dist` checks it. A browser that could not start under
  `srt` on macOS (the rendezvous FATAL, "sandbox initialization failed", Firefox
  or WebKit, read only from Playwright's launch errors and only when no journey
  passed; or a preload refusal the preload recorded where the sandbox cannot
  write) is an environment ERROR that blocks the run at once, never a journey
  failure. A path in the profile that spells the marker or `sandbox-exec` is
  patched around, not refused. Check runs record `isolationAdjustments` and
  `srtVersion`, and the evidence report states the limitation (Chromium runs
  with `--no-sandbox`, so `srt` is its only boundary). `orbit doctor` adds
  `ui.browser-isolation`: the `srt` version, a launch of Playwright's real
  headless Chromium binary through the preload (no repository code runs, every
  credential path and the repository are read-denied, and only a page whose
  script ran counts), and "unverified" on Linux. The demo app's 8 journeys
  pass on desktop and mobile under the real `srt`.
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

### Initial implementation

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
- The `orbit` CLI, eight plugin skills, seven agents and two hooks (a
  SessionStart hook and the guard hook), shipped as one committed bundle
  (`plugin/dist/orbit.mjs`).
