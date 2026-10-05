# Spec traceability

Every concrete requirement of `docs/spec.md` (sections 1 to 21), the code that
implements it and the tests that prove it. Non-done rows have a fix in
`docs/gaps.md` (the gap id is the requirement id).

Snapshot of 2026-10-05, taken after waves 1 to 3 and the fix, demo, docs and
acceptance passes. `npx vitest run` passed: 184 test files, 3090 tests, 3089
passed and 1 skipped (`identity.test.ts`, Linux only). Six of the passing
tests are `it.fails` markers for open runtime defects. Every `it.fails` still
fails as expected, so each defect is still present.

Status rules:

- **done**: implemented, and at least one test asserts the behaviour.
- **partial**: implemented in part, a stub, behaviour contradicted by an
  `it.fails` test, or a config key that is parsed but never applied.
- **missing**: no runtime implementation. Documentation alone counts as missing.
- **untested**: implemented, but no test asserts the behaviour.

Test path prefixes: `U/` is `tests/unit/`, `I/` is `tests/integration/`, `F/` is
`tests/fault-injection/` and `A/` is `tests/acceptance/`. Test names are quoted,
sometimes shortened.

## 1. Product overview

| ID | Requirement | Implementation | Tests | Status |
|---|---|---|---|---|
| S1.1 | Durable goal contracts and execution state | `contract/draft.ts:draftContract`, `controller/run-store.ts`, `storage/schema.ts` | U/contract/draft.test.ts "builds a valid contract...", U/storage/run-store.test.ts "a cancellation request survives closing and reopening the database" | done |
| S1.2 | Autonomous execution within immutable authorization | `policy/snapshot.ts:snapshotPolicy`, `policy/authorize.ts:authorize` | U/policy/snapshot.test.ts, F/policy-faults.test.ts "a policy snapshot edited mid-run blocks the run" | done |
| S1.3 | Independent planning, implementation, verification, adversarial review | `controller/steps/*` | A/feature-and-repair.test.ts "scenario 1..." | done |
| S1.4 | Security gates enforced outside model instructions | `policy/guard-hook.ts`, `policy/scope.ts:inspectScope`, `isolation/*` | F/policy-faults.test.ts "a protected path written through a shell redirect is caught..." | done |
| S1.5 | Adaptive allowances under fixed hard caps | `scheduling/budget.ts:BudgetLedger` | U/scheduling/budget.test.ts "never extends past the hard cap" | done |
| S1.6 | Dynamic routing across Fable, Opus, Sonnet, Haiku | `routing/router.ts:route` | U/routing/router.test.ts | partial (see S8.4, S8.13) |
| S1.7 | Token-efficient context and usage accounting | `adapters/prompt.ts`, `routing/usage.ts` | U/routing/usage.test.ts | partial (see S8.21) |
| S1.8 | Resource-aware subagent scheduling | `scheduling/scheduler.ts:AgentScheduler` | U/scheduling/scheduler.test.ts; F/saturation.test.ts (it.fails) | partial (see S6.19) |
| S1.9 | Cross-provider review, Codex first | `adapters/codex.ts`, `review/select.ts` | I/adapters/codex-fake.test.ts, I/review/flow.test.ts | done |
| S1.10 | Playwright journeys, accessibility, visual verification | `ui/runner.ts:runUiChecks` | I/ui/runner-journeys.test.ts, I/ui/runner-baselines.test.ts | partial (see S13.4) |
| S1.11 | Recovery from crashes, interrupted workers, ambiguous action outcomes | `recovery/reconcile.ts`, `delivery/actions.ts` | I/recovery/*, F/worker-crash.test.ts (one it.fails) | partial (see S14.3) |
| S1.12 | Truthful completion or escalation reports | `controller/report.ts:buildFinalReport` | U/controller/report.test.ts | partial (see S12.13, S10.5) |
| S1.13 | Non-goal: permission bypass is not isolation | `controller/gates.ts:environmentGate` | U/controller/gates.test.ts "refuses unattended execution without isolation..." | done |
| S1.14 | Non-goal: no silent weakening of tests | `policy/weakening.ts:detectWeakening` | A/proof-and-progress.test.ts "scenario 5..." | done |
| S1.15 | Non-goal: no self-authorized scope expansion | `contract/amend.ts:assessAmendment` | U/contract/amend.test.ts "cannot widen allowed_paths beyond the policy scope" | done |
| S1.16 | Non-goal: workers cannot modify runtime or policy | `isolation/profiles.ts:profileForWorker` | U/isolation/profiles.test.ts "lets the guard hook read the frozen policy without letting the worker change it" | done |
| S1.17 | Non-goal: no production access, merge or deploy by default | `policy/config.ts:defaultConfig`, `applySemanticRules` | U/policy/config.test.ts "requires release mode for merge and deploy_production" | done |
| S1.18 | Numeric settings are proposed defaults | `policy/config.ts:defaultConfig` | U/policy/config.test.ts "fills a minimal file from the spec section 5 example" | done |

## 2. Implementation prompt

| ID | Requirement | Implementation | Tests | Status |
|---|---|---|---|---|
| S2.1 | Verify plugin, hook, skill and CLI interfaces against docs; invent nothing | `docs/interfaces/*`, `scripts/check-plugin.mjs` | I/plugin/plugin.test.ts "validates under --strict", "keeps frontmatter inside the verified key lists" | done |
| S2.2 | Early vertical slice: contract, worker, checks, repair, review, report | controller steps | I/controller/runs.test.ts "scenario 1", "scenario 2" | done |
| S2.3 | Codex as first independent review provider | `adapters/codex.ts:CodexAdapter` | I/adapters/codex-fake.test.ts "runs a read-only review..." | done |
| S2.4 | No duplicate workers or actions after crash, closed terminal, lost response | `recovery/reconcile.ts:reconcileOnStart`, `delivery/actions.ts:ActionLedger` | A/restart-and-delivery.test.ts "scenario 7", "scenario 8"; F/worker-crash.test.ts (it.fails) | partial |
| S2.5 | Installation, configuration, security docs, demo repository | `docs/*.md`, `examples/demo-app` | I/demo/example.test.ts | done |
| S2.6 | Demo 1: simple task on a low-cost route | `scripts/demo/mock-demo.ts` | A/demo-shapes.test.ts "demo 1...", I/demo/mock-demo.test.ts "simple: SUCCEEDED on a cheap route" | done |
| S2.7 | Demo 2: difficult task with evidence-backed escalation | same | A/demo-shapes.test.ts "demo 2...", I/demo/mock-demo.test.ts "difficult..." | done |
| S2.8 | Demo 3: UI fails browser checks, repaired, reviewed, draft PR | same | A/ui.test.ts "scenario 17 (and demo run 3)", I/demo/mock-demo.test.ts "ui..." | done |
| S2.9 | Demos run unattended against real providers | `scripts/demo/run-live-demo.sh` | I/demo/live-script.test.ts (stubbed gh and orbit only) | untested |
| S2.10 | Safe stop: unauthorized action | `delivery/deliver.ts`, `policy/authorize.ts` | A/safe-stops.test.ts "unauthorized action..." | done |
| S2.11 | Safe stop: stale evidence | `evidence/freshness.ts:assertDeliverable` | A/policy-and-evidence.test.ts "scenario 10..." | done |
| S2.12 | Safe stop: repeated non-progress | `inquisition/repair.ts:nonProgress` | A/proof-and-progress.test.ts "scenario 6..." | done |
| S2.13 | Safe stop: exhausted budget | `scheduling/budget.ts`, `steps/implementing.ts:startAttempt` | A/safe-stops.test.ts "exhausted budget..." | done |
| S2.14 | Safe stop: expired credentials | `recovery/credentials.ts`, `steps/common.ts:blockOnAuth` | A/safe-stops.test.ts "expired credentials..."; A/credentials-and-routing.test.ts implementer variant (it.fails) | partial |
| S2.15 | Safe stop: unavailable mandatory reviewer | `review/select.ts:selectReviewer` | A/safe-stops.test.ts "unavailable mandatory reviewer..." (two tests) | done |
| S2.16 | Environment-blocked tests labelled, with reproduction commands | `skipIf` guards, `tests/acceptance/README.md` | I/controller/security.test.ts (skipIf gitleaks), I/adapters/os-sandbox.test.ts | done |
| S2.17 | Acceptance suite passes before completion is declared | `tests/acceptance/*` | 32 pass, 3 it.fails (scenarios 4, 12, 14 variants) | partial |

## 3. Architecture

| ID | Requirement | Implementation | Tests | Status |
|---|---|---|---|---|
| S3.1 | Component: plugin (skills, agents, hooks) | `skills/`, `agents/`, `hooks/` | I/plugin/plugin.test.ts | partial (see S4.2 to S4.4) |
| S3.2 | Component: controller | `controller/loop.ts:Controller` | I/controller/loop.test.ts, I/controller/service-loop.test.ts | done |
| S3.3 | Component: Claude adapter | `adapters/claude.ts:ClaudeAdapter` | I/adapters/claude-fake.test.ts, I/adapters/claude-real.test.ts | done |
| S3.4 | Component: policy engine | `policy/authorize.ts` | U/policy/authorize.test.ts | done |
| S3.5 | Component: evidence runner | `evidence/runner.ts:runChecks` | I/evidence/runner.test.ts | done |
| S3.6 | Component: Inquisition engine | `inquisition/engine.ts:runInquisition` | U/inquisition/engine.test.ts | done |
| S3.7 | Component: model router | `routing/router.ts:route` | U/routing/router.test.ts | done |
| S3.8 | Component: agent scheduler | `scheduling/scheduler.ts:AgentScheduler` | U/scheduling/scheduler.test.ts | done |
| S3.9 | Component: provider adapters | `adapters/index.ts:createAdapters` | I/adapters/codex-fake.test.ts "returns real adapters for real commands..." | done |
| S3.10 | Component: UI runner | `ui/runner.ts` | I/ui/* | done |
| S3.11 | Component: delivery adapter | `delivery/deliver.ts:deliver` | I/delivery/deliver.test.ts | done |
| S3.12 | Component: storage (contracts, events, leases, artifacts, decisions, receipts) | `storage/*`, `controller/run-store.ts` | U/storage/*, I/storage/lease-contention.test.ts | done |
| S3.13 | TypeScript controller and adapters | `src/**/*.ts` | `npx tsc --noEmit` | done |
| S3.14 | SQLite with transactional state changes | `storage/db.ts:openDb` | U/run-store.smoke.test.ts "rolls back the whole transaction on error" | done |
| S3.15 | JSON Schema for contracts and all model outputs | `core/schema.ts`, `schemas/*.json`, `contract/model-outputs.ts` | U/schemas/model-output-schemas.test.ts, U/core/schema.test.ts | done |
| S3.16 | Container or equivalent isolated workers | `isolation/sandbox-runtime.ts`, `isolation/container.ts` | I/isolation/sandbox-runtime.int.test.ts, I/isolation/container.int.test.ts | done |
| S3.17 | Git worktrees for task isolation | `steps/preflight.ts:ensureWorktree` | A/parallel.test.ts "scenario 15: two runs work at once..." | done |
| S3.18 | Vitest | `vitest.config.ts` | whole suite | done |
| S3.19 | Structured JSON logs | `core/log.ts:createLogger` | U/core/log.test.ts "writes one JSON object per line..." | done |
| S3.20 | CLI executable named `orbit` | `package.json` bin, `cli/cli.ts:main` | U/cli/cli.test.ts, I/plugin/plugin.test.ts "runs --version and doctor --json" | done |
| S3.21 | Record justification for different defaults | `docs/decisions/0001..0003` | none (docs) | partial |
| S3.22 | Plugin layout (skills, agents, hooks, src dirs, schemas, templates, tests, examples, docs) | repository tree | I/plugin/plugin.test.ts "lists six skills and the agents" | done |
| S3.23 | Manifest `.claude-plugin/plugin.json` with name, version, description, license, keywords | `.claude-plugin/plugin.json` | I/plugin/plugin.test.ts "validates under --strict" | done |
| S3.24 | `.orbit/` layout: config, state.sqlite, runs/<id>/{contract, policy, decisions.jsonl, evidence, logs, final.md} | `controller/start.ts`, `storage/decisions.ts`, `controller/report.ts` | I/cli/run.test.ts "drives a run to success... leaves a final report", U/storage/decisions.test.ts | done |
| S3.25 | No mutable run data in the plugin directory | `controller/context.ts:runWorktreeRoot` | A/parallel.test.ts "scenario 15..." | done |
| S3.26 | Protect policy and trusted storage from workers | `isolation/profiles.ts`, `policy/snapshot.ts` (mode 0444) | U/policy/snapshot.test.ts "detects a snapshot made writable", I/isolation/sandbox-runtime.int.test.ts "cannot read sibling projects, the main checkout or Orbit state" | done |
| S3.27 | Artifact retention rules | `retention.keep_runs_days` parsed in `policy/config.ts`; nothing deletes runs | none | missing |
| S3.28 | Redaction rules (configured patterns) | `retention.redact_patterns` validated; `core/redact.ts` supports `patterns` but no caller passes them | U/policy/config.test.ts (validation only) | missing |

## 4. Commands and unattended operation

| ID | Requirement | Implementation | Tests | Status |
|---|---|---|---|---|
| S4.1 | `/orbit:run <goal>` | `skills/run/SKILL.md` to `orbit run` | I/plugin/plugin.test.ts "skills pass arguments through verbatim" | done |
| S4.2 | `/orbit:inquisition <goal-or-plan>` | `skills/inquisition/SKILL.md` calls `orbit inquisition` (no such command) and `orbit decide <question-id>` (CLI takes `<run-id> <question-id>`) | plugin test checks text only | partial |
| S4.3 | `/orbit:verify [run-id]` | `skills/verify/SKILL.md` calls `orbit verify`: exits 2, unknown command | none | missing |
| S4.4 | `/orbit:repair <failure-or-run-id>` | `skills/repair/SKILL.md` calls `orbit repair`: exits 2, unknown command | none | missing |
| S4.5 | `/orbit:status [run-id]` | `skills/status/SKILL.md` | plugin test | done |
| S4.6 | `/orbit:resume <run-id>` | `skills/resume/SKILL.md` | plugin test | done |
| S4.7 | `orbit doctor` | `cli/commands/doctor.ts:runDoctor` | I/cli/doctor.test.ts | done |
| S4.8 | `orbit init` | `cli/commands/init.ts:initCommand` | U/cli/init.test.ts | done |
| S4.9 | `orbit run --goal --mode --policy` | `cli/commands/run.ts:runCommand` | I/cli/run.test.ts, U/cli/cli.test.ts "requires a goal and refuses contradictory run flags" | done |
| S4.10 | `orbit status <run-id>` | `cli/commands/status.ts` | U/cli/status.test.ts | done |
| S4.11 | `orbit logs <run-id>` | `cli/commands/logs.ts` | U/cli/inspect.test.ts "prints only this run's controller lines, and redacts..." | done |
| S4.12 | `orbit pause <run-id>` | `cli/commands/control.ts:pauseCommand` | U/cli/control.test.ts "pauses and unpauses durably" | done |
| S4.13 | `orbit resume <run-id>` | `cli/commands/control.ts:resumeCommand` | U/cli/control.test.ts "resumes a BLOCKED run at the stage it stopped in" | done |
| S4.14 | `orbit cancel <run-id>` | `cli/commands/control.ts:cancelCommand` | I/cli/lifecycle.test.ts, A/restart-and-delivery.test.ts "scenario 20" | done |
| S4.15 | `orbit report <run-id>` | `cli/commands/report.ts` | U/cli/inspect.test.ts "prints the final report of a finished run exactly..." | done |
| S4.16 | Doctor covers interfaces, auth, models, isolation, git, storage, checks, browsers, adapters, service; names what is missing | `cli/commands/doctor.ts` | I/cli/doctor.test.ts (17 tests) | done |
| S4.17 | Documented foreground and service execution | `cli/commands/drive.ts`, `controller/service.ts`, `docs/operations.md` | I/cli/run.test.ts, U/cli/service.test.ts | done |
| S4.18 | Service survives terminal closure | `adapters/supervise.ts:launchShim` (detached), `controller/service.ts` | I/adapters/claude-fake.test.ts "survives the death of the process that started it" | done |
| S4.19 | Service restarts after controller failure | `controller/service.ts:renderLaunchdPlist`, `renderSystemdUnit` | U/controller/service.test.ts "renders a launchd agent that restarts only on failure" | done |
| S4.20 | Reconcile existing workers instead of spawning duplicates | `recovery/reconcile.ts:reconcileOnStart` | I/recovery/reconcile-workers.test.ts "a running worker is reattached, not duplicated" | done |
| S4.21 | Persist cancellation and pause requests | `controller/run-store.ts:requestCancel`, `setPaused` | U/storage/run-store.test.ts, I/cli/lifecycle.test.ts | done |
| S4.22 | Publish heartbeat and last-progress timestamps | `storage/controllers.ts:heartbeatController`, `run-store.ts:markProgress` | U/storage/controllers.test.ts, U/cli/status.test.ts "flags a stale heartbeat" | done |
| S4.23 | Watchdog | `recovery/watchdog.ts:watchdogTick` | I/recovery/watchdog.test.ts, I/controller/service-loop.test.ts "the service loop runs the watchdog" | done |
| S4.24 | Graceful shutdown | `controller/loop.ts` | I/controller/loop.test.ts "shuts down gracefully on SIGTERM" | done |
| S4.25 | Terminate or reconcile orphan processes | `recovery/reconcile.ts:stopWorker` | I/recovery/reconcile-processes.test.ts, I/recovery/adversarial.test.ts | done |
| S4.26 | Block on expired credentials, no indefinite retry | `recovery/credentials.ts:checkRunCredentials` | I/controller/service-loop.test.ts "credentials are checked again while a run works..." | done |
| S4.27 | Use native `/goal` when available as a continuation aid | none | none | missing |
| S4.28 | Controller works without `/goal` | controller has no `/goal` dependency | whole suite | done |

## 5. Authorization and security gates

| ID | Requirement | Implementation | Tests | Status |
|---|---|---|---|---|
| S5.1 | Supervised mode asks for material decisions | `steps/inquisition.ts` (disposition ask: BLOCKED with questions), `cli/commands/decide.ts` | U/inquisition/resolve.test.ts "unattended with nothing independent left: BLOCKED. Supervised: wait for the person" | done |
| S5.2 | Supervised mode asks for unauthorized actions | none: actions are denied, never offered for approval | none | missing |
| S5.3 | Autonomous mode: preauthorized work, reversible ambiguity resolved | `inquisition/resolve.ts:resolveAmbiguities` | A/ambiguity.test.ts "scenario 3..." | done |
| S5.4 | Autonomous delivery: commit, push task branch, PR, CI repair | `steps/delivering.ts`, `steps/awaiting-ci.ts` | A/feature-and-repair.test.ts "scenario 1", F/injection.test.ts "a CI log with injected instructions becomes a fenced repair brief..." | done |
| S5.5 | Release mode: narrowly scoped release actions via a release profile | `policy/authorize.ts` (merge and deploy need release); no release action exists | U/policy/authorize.test.ts "requires both the action flag and a mode that permits it" | partial |
| S5.6 | Unified configuration example loads | `policy/config.ts:parseConfig` | U/policy/config.test.ts "fills a minimal file from the spec section 5 example" | done |
| S5.7 | Provider ids are adapter ids; model ids resolved during validation | `policy/config.ts:modelPermitted`, `routing/registry.ts` | U/policy/config.test.ts "accepts exact entries and family members only" | done |
| S5.8 | Every example config key has effect | `agents.isolate_writers`, `prohibit_shared_worktree_writes`, `require_independent_work_units`, `actions.change_secrets`, `actions.change_permissions` are parsed, never read | none | partial |
| S5.9 | Gate sequence in spec order | `controller/gates.ts:GATES`, `FAILURE_BEHAVIOUR` | U/controller/gates.test.ts "lists the spec gates in order with their failure behaviour" | done |
| S5.10 | Intake gate: repository, scope, budgets, measurable criteria; reject invalid contract | `gates.ts:intakeGate` | U/controller/gates.test.ts "rejects a criterion that cites no trusted check..." | done |
| S5.11 | Environment gate: isolation, scoped credentials, network controls; block unattended | `gates.ts:environmentGate` | U/controller/gates.test.ts "refuses an unavailable provider and blocks on missing or expired credentials" | done |
| S5.12 | Baseline gate: locked install, existing failures recorded | `gates.ts:baselineGate`, `evidence/baseline.ts:runBaseline` | U/controller/gates.test.ts "records pre-existing failures...", I/evidence/baseline.test.ts | done |
| S5.13 | Baseline gate: vulnerability and license policy | none | none | missing |
| S5.14 | Implementation gate: filesystem bounds, protected paths; deny and record | `gates.ts:implementationScopeGate`, `steps/verifying.ts` (policy.deny decision) | U/controller/gates.test.ts "treats protected paths and escaping symlinks as a policy violation" | done |
| S5.15 | Static security: secret scan | `controller/security.ts:scanCandidateSecrets` | I/controller/security.test.ts, U/controller/gates.test.ts "fails on secrets..." | done |
| S5.16 | Static security: configured SAST | `policy/config.ts:sastCheckIds`, `gates.ts:staticSecurityGate` | U/controller/gates.test.ts "reports static analysis as unverified... when the policy defines no SAST" | done |
| S5.17 | Static security: sensitive-diff review | `inquisition/triggers.ts` hidden_decision from `riskCategoriesInDiff` | U/inquisition/triggers.test.ts "flags a security change the contract never mentions, from the diff" | done |
| S5.18 | Static security repairs or blocks by severity policy | secret findings always fail; SAST is pass or fail | U/controller/gates.test.ts | partial |
| S5.19 | Behaviour gate: failure produces a repair brief | `gates.ts:behaviourGate`, `steps/diagnosing.ts` | A/feature-and-repair.test.ts "scenario 2" | done |
| S5.20 | UI gate: repair or block | `gates.ts:uiGate` | U/controller/gates.test.ts "requires configured journeys when UI evidence is needed" | done |
| S5.21 | Independent review gate: resolve findings | `review/stale.ts:reviewGate`, `gates.ts:independentReviewGate` | U/review/stale.test.ts | done |
| S5.22 | Delivery gate: exact revision, fresh evidence, authorized destination | `delivery/gate.ts:assertDeliverable`, `evidence/freshness.ts` | U/delivery/gate.test.ts, I/delivery/deliver.test.ts "refuses a remote host that network.allowed_hosts does not list" | done |
| S5.23 | Completion gate: every mandatory requirement holds for the delivered revision | `gates.ts:completionGate` (ignores criteria blocked by open questions); no unit test | A/ambiguity.test.ts "scenario 4: the blocked criterion keeps the run from success..." (it.fails) | partial |
| S5.24 | Snapshot and hash policy before execution | `policy/snapshot.ts:snapshotPolicy` | U/policy/snapshot.test.ts "writes a read-only, self-describing snapshot..." | done |
| S5.25 | Workers cannot modify policy, trusted runner or authorization state | `isolation/profiles.ts`, `policy/builtin.ts` | A/policy-and-evidence.test.ts "scenario 9", F/policy-faults.test.ts | done |
| S5.26 | Policy expansion needs a separately authorized revision | `contract/amend.ts`, `inquisition/engine.ts:processAmendments` | U/inquisition/engine.test.ts "widening scope beyond the frozen policy is refused outright" | done |
| S5.27 | Trusted components mounted read-only | `isolation/profiles.ts` (read-only config, policy) | U/isolation/profiles.test.ts "keeps the config dir surfaces that run code on the host read-only" | done |
| S5.28 | Restrict filesystem, network, CPU, memory, process count, time | srt: fs and network only; container: all; timeouts in `core/exec.ts` | I/isolation/container.int.test.ts "applies the memory, CPU and pids limits" | partial |
| S5.29 | No host credentials, SSH agents, container sockets | `adapters/env.ts:buildWorkerEnv`, `isolation/profiles.ts` | U/adapters/env-shim.test.ts "starts from an allowlist...", U/isolation/profiles.test.ts "denies container-engine state and keychains" | done |
| S5.30 | Separate implementation and delivery credentials; none in workers | `adapters/env.ts`, `delivery/github.ts:GhCliClient` | U/adapters/env-shim.test.ts, I/delivery/gh-cli.test.ts "uses the controller token only" | done |
| S5.31 | Resolve symlinks, canonicalize, reject traversal | `policy/paths.ts:resolveInside` | U/policy/paths.test.ts | done |
| S5.32 | Inspect final diffs independently of hooks | `policy/scope.ts:inspectScope` | I/policy/scope.test.ts, F/policy-faults.test.ts "...caught by scope inspection" | done |
| S5.33 | Constrain indirect writes through shell | `policy/bash.ts:classifyBash`, OS sandbox | U/policy/bash.test.ts, U/policy/adversarial.test.ts | done |
| S5.34 | Repository text, logs, web, dependency output are untrusted | `adapters/prompt.ts:fence` | F/injection.test.ts "a check log with injected instructions reaches the verifier... only as fenced untrusted data" | done |
| S5.35 | Tool output cannot grant authority | `adapters/prompt.ts`, `knowledge/authority.ts` | U/adapters/prompt-agents.test.ts "fences every untrusted input with a label that says it grants nothing" | done |
| S5.36 | Sanitize logs and artifacts before provider transmission | `core/redact.ts:redactForProvider` | U/adapters/prompt-agents.test.ts "bounds untrusted blocks, redacts secrets for the provider", I/review/packet.test.ts | done |
| S5.37 | Enforce provider data-handling eligibility | `review/packet.ts:assertProviderEligible` | I/review/packet.test.ts "refuses a provider whose data_policy_eligible is false" | done |
| S5.38 | Explicit scanner severity and exception rules | review findings only (`review/resolve.ts`); none for secret scan or SAST | U/review/resolve.test.ts "treats a warning-level security finding as advisory" | partial |
| S5.39 | Hooks assist; controller checks and isolation remain the gate | `policy/scope.ts` after `policy/guard-hook.ts` | F/policy-faults.test.ts | done |
| S5.40 | Select applicable engineering practices per task and justify omissions | none (planner schema has no practices field) | none | missing |

## 6. Goal contracts and state

| ID | Requirement | Implementation | Tests | Status |
|---|---|---|---|---|
| S6.1 | Contract stores goal, objective, criteria, non-goals, scope, baseline, checks, proof, assumptions, delivery, policy hash, escalation | `contract/types.ts:GoalContract`, `contract/draft.ts` (budgets bound through policy_hash) | U/contract/draft.test.ts, U/contract/validate.test.ts | done |
| S6.2 | Commands only in trusted config; model commands not authorized | `contract/validate.ts:contractProblems` | U/contract/amend.test.ts "cannot add a check the policy does not define (no check commands)" | done |
| S6.3 | Preflight captures status and revision | `steps/preflight.ts:preflightStep` | I/controller/runs.test.ts (via runs) | done |
| S6.4 | Reject dirty starts unless permitted | `steps/preflight.ts:49` | none (doctor warning only: I/cli/doctor.test.ts) | untested |
| S6.5 | Run baseline checks, record pre-existing failures | `evidence/baseline.ts:runBaseline` | I/evidence/baseline.test.ts "records pre-existing failures on the base revision..." | done |
| S6.6 | Never green with failing mandatory checks unless the contract accepts a documented baseline exception | `evidence/report.ts` honours `baseline_exceptions`; nothing can add one to a contract | U/evidence/report.test.ts "accepts the failure whose fingerprint equals the recorded one" | partial |
| S6.7 | Amendments: clarify or add tests; never remove mandatory, redefine success, broaden scope | `contract/amend.ts:applyAmendment` | U/contract/amend.test.ts | done |
| S6.8 | Amendment records old, new, evidence, reason, approval, affected verification | `contract/types.ts:ContractAmendment`, `inquisition/store.ts` | U/contract/amend.test.ts, U/inquisition/store.test.ts | done |
| S6.9 | State machine edges | `controller/states.ts` | U/storage/run-store.test.ts "accepts every listed edge and rejects every other pair" | done |
| S6.10 | Ambiguity: INQUISITION, then resume or BLOCKED | `steps/inquisition.ts` | A/ambiguity.test.ts, I/controller/runs.test.ts "scenario 4" | done |
| S6.11 | Failure: DIAGNOSING, REPAIRING, VERIFYING | `steps/diagnosing.ts`, `steps/implementing.ts` | A/feature-and-repair.test.ts "scenario 2" | done |
| S6.12 | Crash: RECOVERING, reconcile, resume | `recovery/budget.ts:enterRecovery`, `steps/recovering.ts` | I/recovery/reconcile-runs.test.ts "a run whose owner died mid-step becomes RECOVERING" | done |
| S6.13 | Policy violation: BLOCKED | `steps/verifying.ts:61` | A/policy-and-evidence.test.ts "scenario 9" | done |
| S6.14 | Budget limit: EXHAUSTED | `steps/common.ts:safePoint` | F/budgets.test.ts | done |
| S6.15 | Cancellation: CANCELLED | `steps/common.ts:safePoint` | F/cancellation.test.ts | done |
| S6.16 | Terminal outcome IMPOSSIBLE | `steps/diagnosing.ts:105` | none | untested |
| S6.17 | Blocked run resumable after decision or environment repair | `cli/commands/control.ts:resumeCommand` | A/credentials-and-routing.test.ts "scenario 12: reviewer credentials that expire mid-run... orbit resume" | done |
| S6.18 | Invariant: one owner lease per run | `run-store.ts:acquireLease`, `assertLeaseHeld` | I/storage/lease-contention.test.ts | done |
| S6.19 | Invariant: bounded active workers | `steps/implementing.ts:87` (running set is this run's workers only) | F/saturation.test.ts "with memory saturated, a controller owning two runs never has more than one implementer running" (it.fails) | partial |
| S6.20 | Invariant: every transition has a durable event | `run-store.ts:transition` | U/run-store.smoke.test.ts "requires the lease and appends an event per transition" | done |
| S6.21 | Invariant: no success without current evidence | `gates.ts:completionGate` | F/delivery.test.ts "a candidate changed after review cannot be delivered" | done |
| S6.22 | Invariant: no delivery from an unreviewed revision | `delivery/gate.ts` | U/delivery/gate.test.ts "refuses a review for another tree" | done |
| S6.23 | Invariant: no model-authorized policy expansion | `contract/amend.ts`, `inquisition/engine.ts` | U/inquisition/engine.test.ts "a model cannot approve its own amendment" | done |
| S6.24 | Invariant: no unlimited recovery | `recovery/budget.ts:spendRecoveryAttempt` | U/recovery/budget.test.ts "is unlimited nowhere..." | done |
| S6.25 | Invariant: no continuation after durable cancellation | `run-store.ts:transition` | U/run-store.smoke.test.ts "...blocks everything but CANCELLED after cancel" | done |
| S6.26 | Transactions, leases, heartbeats, reconciliation, atomic artifact writes | `storage/db.ts`, `core/fsx.ts:atomicWrite` | U/core/fsx.test.ts "never lets a concurrent reader... see a partial or mixed file" | done |

## 7. Adaptive iteration budgeting

| ID | Requirement | Implementation | Tests | Status |
|---|---|---|---|---|
| S7.1 | Separate counters: turns, attempts, experiments, review rounds, CI cycles, infrastructure retries | `scheduling/types.ts:BUDGET_COUNTERS`, `BudgetLedger` | U/scheduling/budget.test.ts "creates every counter..." | done |
| S7.2 | API retries do not use attempts; they use wall time and spend | `BudgetLedger.consume` | U/scheduling/budget.test.ts "keeps infrastructure retries apart from implementation attempts" | done |
| S7.3 | Difficulty from nine factors | `scheduling/difficulty.ts:classifyDifficulty` | U/scheduling/difficulty.test.ts "scores each spec section 7 factor" | done |
| S7.4 | Record why an allowance was selected | `BudgetLedger` bind | U/scheduling/budget.test.ts "records the difficulty assessment..." | done |
| S7.5 | Extend only with a remaining failure, new hypothesis, authorized scope, budget | `BudgetLedger.requestExtension` | U/scheduling/budget.test.ts "requires a new hypothesis, authorized scope and a remaining failure" | done |
| S7.6 | Progress definition; tokens and diff size are not progress | `inquisition/repair.ts:progressSince` | U/inquisition/repair.test.ts "more tokens and a bigger diff never count" | done |
| S7.7 | Allowances rise within caps; caps never change | `BudgetLedger` | U/scheduling/budget.test.ts "is idempotent on restart and refuses changed hard caps" | done |
| S7.8 | Reserve for final verification, review, reporting | `BudgetLedger` reserve | U/scheduling/budget.test.ts "protects the closing reserve..." | done |
| S7.9 | Unmeasured cost: report it, conservative admission | `BudgetLedger` role ceilings | U/scheduling/budget.test.ts "charges a conservative role ceiling when cost is unavailable" | done |
| S7.10 | Inquisition after repeated equivalent failures | `triggers.ts` repeated_failure | U/inquisition/triggers.test.ts "fires once the fingerprint has hit the threshold" | done |
| S7.11 | Inquisition on inadequate proof despite green tests | `triggers.ts:proofAdequacy` | A/proof-and-progress.test.ts "scenario 5" | done |
| S7.12 | Inquisition on authority pressure | `triggers.ts` scope_pressure reads `policy.deny` decisions, which only scope inspection writes | U/inquisition/triggers.test.ts "fires on repeated denials of the same target" (synthetic decisions) | partial |
| S7.13 | Stop when no useful authorized experiment remains | `steps/diagnosing.ts:105` (IMPOSSIBLE) | none | untested |
| S7.14 | Stop when mandatory verification is unavailable | `steps/verifying.ts:144` | none | untested |
| S7.15 | Stop when a material decision cannot be inferred | `steps/inquisition.ts` | I/controller/runs.test.ts "scenario 4..." | done |
| S7.16 | Stop when the budget cannot support honest completion | `steps/implementing.ts:startAttempt` | A/safe-stops.test.ts "exhausted budget..." | done |
| S7.17 | Extension decision record in the spec shape | `scheduling/budget.ts:extensionDecisionRecord` | U/scheduling/budget.test.ts "grants one attempt... in the spec shape" | done |
| S7.18 | Repeated non-progress terminates | `inquisition/repair.ts:nonProgress` | A/proof-and-progress.test.ts "scenario 6", U/scheduling/adversarial.test.ts | done |

## 8. Models, tokens and subagents

| ID | Requirement | Implementation | Tests | Status |
|---|---|---|---|---|
| S8.1 | Registry records provider, id, surfaces, tools, structured output, vision, limits, pricing, refresh, latency, evaluations, data handling | `routing/registry.ts:ModelRegistry` (latency_ms is never measured or written) | U/routing/registry.test.ts | partial |
| S8.2 | Validate availability per surface | `ModelRegistry` surfaces | U/routing/router.test.ts "only routes to models validated on the CLI surface", I/cli/models-learn.test.ts | done |
| S8.3 | Haiku for extraction and log classification | `routing/router.ts` | U/routing/router.test.ts "routes bounded extraction to Haiku..." | done |
| S8.4 | Sonnet for routine code; escalate on coupled changes or difficult causal failures | `router.ts`, `steps/implementing.ts:routeSignals` | A/credentials-and-routing.test.ts "scenario 14: the implementer is not escalated on a single localized failure" (it.fails) | partial |
| S8.5 | Opus for architecture and complex diagnosis | `router.ts` | U/routing/router.test.ts "keeps architecture on Opus when Fable is not in policy" | done |
| S8.6 | Fable only when evaluation justifies | `router.ts` | U/routing/router.test.ts "uses Fable only when allowed AND a strong attempt failed" | done |
| S8.7 | Screenshot interpretation by an eligible vision model | `router.ts` | U/routing/router.test.ts "routes screenshots to the cheapest eligible vision model" | done |
| S8.8 | Independent review by a qualified other-provider model | `review/select.ts`, `router.ts` | U/routing/router.test.ts "prefers a qualified other-provider reviewer at high effort" | done |
| S8.9 | Optimize expected cost per verified accepted task | `router.ts` cost breakdown | U/routing/router.test.ts "routes simple routine code to Sonnet at medium effort, not Opus or Fable" | done |
| S8.10 | Escalate on observed difficulty, not worker confidence | `router.ts` | U/routing/router.test.ts "ignores worker confidence and requests" | done |
| S8.11 | Raise reasoning effort where supported | `router.ts` | U/routing/router.test.ts "raises effort, not tier, for security-critical code" | done |
| S8.12 | Compact handoff packet | `adapters/prompt.ts:renderWorkerPrompt` | U/adapters/prompt-agents.test.ts "starts with the compact operating prompt..." | done |
| S8.13 | Route routine follow-up down once the diagnosis is solved | `router.ts` supports `diagnosisSolved`; no controller step sets it | U/routing/router.test.ts "routes routine follow-up back down" (router only) | partial |
| S8.14 | Never route safety review below its quality floor | `review/select.ts:REVIEW_QUALITY_FLOOR_TIER` | U/review/select.test.ts "never goes below the floor..." | done |
| S8.15 | Deterministic parsing and policy instead of model calls | `inquisition/engine.ts` (rules first) | U/inquisition/engine.test.ts "...does not call a worker" | done |
| S8.16 | Full logs in artifacts, excerpts to workers | `evidence/fingerprint.ts`, `adapters/prompt.ts` | U/evidence/fingerprint.test.ts "bounds the excerpt...", U/adapters/prompt-agents.test.ts | done |
| S8.17 | Retrieve repository context on demand | `adapters/prompt.ts` (no preloaded repo) | U/adapters/prompt-agents.test.ts "...carries the bounded work unit, never the spec" | done |
| S8.18 | Compact contracts, decisions, repair briefs | `contract/*`, `inquisition/repair.ts` | U/inquisition/repair.test.ts | done |
| S8.19 | Supported prompt caching (stable prefix first) | `adapters/prompt.ts` ordering; cache tokens in `routing/usage.ts` | U/adapters/prompt-agents.test.ts, U/routing/usage.test.ts "...cache hit ratio" | done |
| S8.20 | Do not repeat the spec in each worker | `adapters/prompt.ts:OPERATING_PROMPT` | U/adapters/prompt-agents.test.ts "...never the spec" | done |
| S8.21 | Role-specific output budgets | none (turn caps and spend caps only) | none | missing |
| S8.22 | Evidence references and hashes in handoffs | `adapters/prompt.ts:EvidenceRef` | U/adapters/prompt-agents.test.ts | done |
| S8.23 | Track input, output, cached tokens and cost per accepted run | `routing/usage.ts:recordUsage`, `summarizeUsage`, `cli/commands/report.ts` | U/routing/usage.test.ts, U/cli/inspect.test.ts "summarizes verified pass rate, attempts and cost over time" | done |
| S8.24 | One implementer; planner when needed; verifier after changes; reviewer after checks pass | `controller/states.ts`, steps | A/feature-and-repair.test.ts | done |
| S8.25 | Extra workers only for bounded independent units, weighing CPU, memory, browsers, rate limits, spend, context duplication, merge overhead | `AgentScheduler` (cores, memory, rate limits, budget; no browser, duplication or merge cost); controller never plans parallel units in a run | U/scheduling/scheduler.test.ts | partial |
| S8.26 | Good parallelism: separate check suites | `evidence/runner.ts:runCheckSet` concurrency | I/evidence/runner.test.ts "runs independent checks concurrently up to the limit" | done |
| S8.27 | Good parallelism: separate security and UI review, separable changes in isolated worktrees | none | none | missing |
| S8.28 | Avoid shared-file edits, duplicate fixes, stale-revision reviews | `AgentScheduler` | U/scheduling/scheduler.test.ts "serializes writers whose owned paths overlap...", "cancels reviews and verifications of a stale revision" | done |
| S8.29 | Every task has ownership, inputs, schema, dependencies, revision, cancellation, budget | `scheduling/types.ts:WorkUnit`; controller fills `revision: null`, `cancelWhen: []`, `budget: {}` | U/scheduling/scheduler.test.ts | partial |
| S8.30 | Writers never share a mutable worktree | `AgentScheduler`, per-run worktrees | U/scheduling/scheduler.test.ts "never lets a writer share a worktree", A/parallel.test.ts | done |
| S8.31 | Integrate serially, then invalidate affected evidence | single writer; `evidence/freshness.ts:invalidateEvidence` | U/evidence/freshness.test.ts "marks every live report stale..." | done |

## 9. Agent roles and skills

| ID | Requirement | Implementation | Tests | Status |
|---|---|---|---|---|
| S9.1 | Planner: read-only; behaviour, mappings, proof plan, files, non-goals, risks, assumptions, decisions | `agents/planner.md`, `schemas/planner-output.schema.json` | U/schemas/model-output-schemas.test.ts, U/adapters/prompt-agents.test.ts "gives read-only roles no edit tool" | done |
| S9.2 | Implementer: isolated worktree, small change, behaviour tests, artifacts, no protected edits | `agents/implementer.md`, `isolation/profiles.ts` | U/schemas/model-output-schemas.test.ts "gives the implementer no way to claim completion" | done |
| S9.3 | Verifier: no edits; fingerprints, excerpts, hypotheses, experiments, constraints | `agents/verifier.md`, `schemas/diagnosis-output.schema.json` | U/schemas/model-output-schemas.test.ts "mirrors RepairBrief exactly in the diagnosis output" | done |
| S9.4 | Reviewer: no edits; exact diff, tests, contract, evidence; rejects weak proof and leakage | `agents/reviewer.md`, `review/packet.ts` | I/review/packet.test.ts, I/adapters/codex-fake.test.ts | done |
| S9.5 | Inquisitor: challenges, experiments, reversible choices, decision requests | `agents/inquisitor.md`, `inquisition/engine.ts` | U/inquisition/engine.test.ts | done |
| S9.6 | Main run protocol, steps 1 to 11 | `controller/steps/*` | A/feature-and-repair.test.ts, F/injection.test.ts (CI repair) | done |

## 10. Orbit Inquisition

| ID | Requirement | Implementation | Tests | Status |
|---|---|---|---|---|
| S10.1 | Minimum questions and smallest experiments | `inquisition/resolve.ts` | U/inquisition/resolve.test.ts | done |
| S10.2 | Triggers: missing outcomes, contradictions, green without proof, repeated failure, architecture, hidden decisions, scope pressure, unsupported confidence, oracle weakening | `inquisition/triggers.ts:detectTriggers`, `types.ts:TRIGGER_KINDS` | U/inquisition/triggers.test.ts | done |
| S10.3 | Modes and outputs: clarify, challenge, reconcile (authority map), diagnose, risk review (impact register), decision record | `types.ts:INQUISITION_MODES`, `engine.ts:authorityMap`; no impact register artifact | U/inquisition/engine.test.ts "ranks conflicting sources and flags ties" | partial |
| S10.4 | Procedure: evidence, facts versus assumptions, interpretations, ranking, experiment, ask last | `engine.ts:runInquisition` | U/inquisition/engine.test.ts "accepts only an authorized experiment that tells interpretations apart" | done |
| S10.5 | Unattended: never wait on the keyboard; persist questions, continue independent work, or BLOCKED | `steps/inquisition.ts`, `gates.ts:completionGate` | A/ambiguity.test.ts "scenario 4: the blocked criterion keeps the run from success..." (it.fails) | partial |
| S10.6 | Autonomous resolution rules | `inquisition/resolve.ts:classifyAmbiguity` | U/inquisition/resolve.test.ts "never guesses, even when a choice was named" | done |
| S10.7 | Question quality rules | `inquisition/questions.ts:validateQuestion` | U/inquisition/questions.test.ts | done |
| S10.8 | Ledger fields and statuses; no invented calibrated probabilities | `inquisition/ledger.ts`, `store.ts` | U/inquisition/ledger.test.ts "rejects missing fields and invented confidence values" | done |
| S10.9 | Interactive Inquisition | `skills/inquisition/SKILL.md` (broken commands, see S4.2) | none | partial |

## 11. Verification and evidence

| ID | Requirement | Implementation | Tests | Status |
|---|---|---|---|---|
| S11.1 | Capture command, cwd, times, exit, timeout and cancellation, sanitized output, revision, worktree, artifact hashes, config hash | `evidence/types.ts:CheckResult`, `evidence/runner.ts` | I/evidence/runner.test.ts "records a bound, logged result...", "lists artifacts the check writes, with their hashes" | done |
| S11.2 | Bind evidence to candidate and input hashes | `evidence/freshness.ts:staleReasons` | U/evidence/freshness.test.ts | done |
| S11.3 | Rerun all mandatory checks after any change (v1) | `evidence/runner.ts` per candidate | I/evidence/evidence-flow.test.ts "rejects results from the old tree when the report is rebuilt" | done |
| S11.4 | Delivery commit has exactly the tested tree | `delivery/git.ts:createDeliveryCommit`, `delivery/gate.ts:verifyCandidateTree` | I/evidence/evidence-flow.test.ts "delivers only when the delivery commit has exactly the tested tree" | done |
| S11.5 | Hooks, rebases, generated files invalidate evidence | `evidence/freshness.ts` | I/delivery/deliver.test.ts "refuses a tree that changed by one byte after review" | done |
| S11.6 | Evidence report in the spec shape | `evidence/report.ts:buildEvidenceReport` | U/evidence/report.test.ts | done |
| S11.7 | Every mandatory criterion needs explicit evidence | `evidence/report.ts:evaluateEvidence` | U/evidence/report.test.ts "blocks PASS for a mandatory criterion with no mapped check" | done |
| S11.8 | Unit tests alone do not prove a journey | `evidence/report.ts` | U/evidence/report-verifier.test.ts "does not support a UI criterion mapped only to passing command checks" | done |
| S11.9 | Model review cannot replace checks | `gates.ts:completionGate` | U/review/stale.test.ts, F/delivery.test.ts | done |
| S11.10 | Missing execution evidence labelled unverified | `evidence/report.ts` | U/evidence/report.test.ts "marks a criterion whose mapped check never ran as unverified" | done |

## 12. Cross-provider verification

| ID | Requirement | Implementation | Tests | Status |
|---|---|---|---|---|
| S12.1 | Adapter interface: discoverCapabilities, validateCredentials, startTask, streamEvents, cancelTask, collectResult, reportUsage | `adapters/types.ts:ProviderAdapter` | I/adapters/codex-fake.test.ts, I/adapters/claude-fake.test.ts | done |
| S12.2 | Claude and Codex supported | `adapters/claude.ts`, `adapters/codex.ts` | I/adapters/* | done |
| S12.3 | Review packet: goal, criteria, policy, candidate, diff, sources, results, assumptions, questions | `review/packet.ts:buildReviewPacket` | I/review/packet.test.ts "contains every section a reviewer needs" | done |
| S12.4 | Packet excludes secrets and unrelated content | `review/packet.ts` | I/review/packet.test.ts "leaves out unrelated repository content", "redacts recognized secret shapes..." | done |
| S12.5 | Record provider and data-policy eligibility | `review/select.ts:selectionDecisionRecord` | U/review/select.test.ts "blocks with a record that serializes for the decision log" | done |
| S12.6 | Reviewers run separately, read-only | `adapters/codex.ts:buildCodexArgv` | U/adapters/codex.test.ts "builds the verified read-only review argv" | done |
| S12.7 | No approval deadlock without removing the sandbox | `adapters/codex.ts`, `adapters/claude.ts` (`dontAsk`) | A/credentials-and-routing.test.ts "scenario 11" | done |
| S12.8 | Findings in the spec shape | `schemas/review-output.schema.json` | U/schemas/model-output-schemas.test.ts "matches the spec section 12 findings shape" | done |
| S12.9 | No majority vote | `review/resolve.ts` | U/review/resolve.test.ts "is not decided by how many reviewers approved" | done |
| S12.10 | Disagreements become testable claims, reproduced, Inquisition as needed | `review/resolve.ts`, `steps/reviewing.ts` | A/review-and-security.test.ts "scenario 16", I/review/flow.test.ts | done |
| S12.11 | Block unresolved high-impact findings | `review/resolve.ts:severityBlocks` | U/review/resolve.test.ts "critical blocks like high..." | done |
| S12.12 | Record why findings were accepted or rejected | `review/store.ts:persistResolution` | U/review/store.test.ts "writes statuses with reasons and blocking flags, then one decision per decided claim" | done |
| S12.13 | Accepted and waived findings reach the final report as residual risk | `controller/report.ts:125` lists only advisory, open, claim_pending | none | partial |
| S12.14 | Mandatory other provider unavailable: block, no silent substitute | `review/select.ts` | F/model-faults.test.ts "a mandatory independent reviewer that is missing blocks the run" | done |

## 13. UI testing

| ID | Requirement | Implementation | Tests | Status |
|---|---|---|---|---|
| S13.1 | Journeys and DOM assertions | `ui/runner.ts`, `templates/playwright` | I/ui/runner-journeys.test.ts | done |
| S13.2 | Responsive checks across viewports | `ui/runner.ts` coverage | I/ui/runner-safety.test.ts "records... the viewport", I/demo/example.test.ts "desktop and mobile" | done |
| S13.3 | Accessibility scans | `templates/playwright/orbit-fixtures.ts`, `ui/report.ts:parseA11y` | I/ui/runner-baselines.test.ts "fails only on the new serious violation" | done |
| S13.4 | Keyboard navigation checks | none | none | missing |
| S13.5 | Visual regression | `ui/runner.ts` baselines | I/ui/runner-baselines.test.ts "a real visual regression fails..." | done |
| S13.6 | Console and network failures | `ui/report.ts:parseDiagnostics` | I/ui/runner-safety.test.ts "records console errors, failed responses..." | done |
| S13.7 | Screenshots and traces | `ui/runner.ts:enforcedFlags` | U/ui/runner-units.test.ts "enforces the recording flags...", U/ui/brief.test.ts | done |
| S13.8 | UI config: required, environment, browsers, viewports, accessibility, visual | `policy/types.ts:UiConfig` | U/policy/config.test.ts "checks ui references and keeps auto-accept of baselines impossible" | done |
| S13.9 | UI config journeys with declarative steps | journeys are Playwright check ids (`journey_check_ids`); deviation not recorded in `docs/decisions` | none | partial |
| S13.10 | `accessibility.fail_on_new_serious_or_critical` honoured | parsed, never read; the fixture always fails on serious or critical | none | partial |
| S13.11 | Visual baseline changes require review | `ui/runner.ts:229`, `evidence/report.ts` | A/ui.test.ts "scenario 18" | done |
| S13.12 | Artifact policy (screenshots on failure, retained traces, console, failed requests) | `ui/runner.ts:enforcedFlags` | U/ui/runner-units.test.ts | done |
| S13.13 | Deterministic journeys satisfy explicit criteria | `evidence/report.ts` | U/evidence/report.test.ts "supports a UI criterion from a passing journey" | done |
| S13.14 | Agent-driven exploration produces reproducible findings | none | none | missing |
| S13.15 | Isolation: synthetic data, isolated services, scoped credentials, network limits, no production mutation | `ui/app-fixture.ts:startApp`, `assertBaseUrl` | U/ui/app-fixture.test.ts "refuses a non-loopback host...", "gives the app a scrubbed environment" | done |
| S13.16 | Reproducible fixtures, resources cleaned up | `ui/app-fixture.ts:stopApp`, `reconcileApp` | I/ui/app-fixture.test.ts "a restarted controller finds and stops an app..." | done |
| S13.17 | Self-healing never removes assertions, inflates timeouts, auto-accepts screenshots | `policy/weakening.ts`, `ui/runner.ts` | U/policy/weakening.test.ts, I/ui/runner-baselines.test.ts "a candidate that re-records the baselines... cannot pass" | done |
| S13.18 | Failure brief contents | `ui/brief.ts:uiFailureBrief` | U/ui/brief.test.ts "carries every section of the spec 13 brief" | done |
| S13.19 | Bind UI evidence to candidate, build, browser, viewport, fixture, config | `ui/types.ts:UiBinding` | I/ui/runner-journeys.test.ts "passes on a healthy candidate and binds the evidence to it" | done |
| S13.20 | Rerun required checks after repair | controller verifying | I/ui/runner-journeys.test.ts "...then verifies the repair", A/ui.test.ts | done |
| S13.21 | Disclose accessibility and visual coverage limits | `ui/runner.ts:UI_LIMITATIONS` | I/ui/app-fixture.test.ts "...with the isolation limitations recorded" | done |

## 14. Recovery and self-healing

| ID | Requirement | Implementation | Tests | Status |
|---|---|---|---|---|
| S14.1 | Repair brief fields | `inquisition/repair.ts:validateRepairBrief` | U/inquisition/repair.test.ts "requires every spec section 14 field" | done |
| S14.2 | Rewording is not a new hypothesis | `inquisition/hypotheses.ts:isNewHypothesis` | U/inquisition/hypotheses.test.ts "a rewording with the same test is a duplicate" | done |
| S14.3 | Worker crash: preserve worktree, bounded restart | `recovery/reconcile.ts` (dead controller only); `steps/implementing.ts:132-147` treats a LOST worker under a live controller as a finished attempt | F/worker-crash.test.ts "the worker dies under a live controller..." (it.fails) | partial |
| S14.4 | Controller crash: recover lease, reconcile processes | `recovery/reconcile.ts:reconcileOnStart` | F/controller-crash.test.ts | done |
| S14.5 | Temporary provider failure: bounded backoff with jitter | `steps/common.ts:handleWorkerFailure` retries without delay; `recovery/backoff.ts:retryWithBackoff` unused by the controller | U/recovery/backoff.test.ts (library only) | partial |
| S14.6 | Authentication failure: block | `steps/common.ts:blockOnAuth`; `controller/workers.ts:132` charges the failed session at its ceiling first | F/model-faults.test.ts implementer variant (it.fails), A/credentials-and-routing.test.ts (it.fails) | partial |
| S14.7 | Malformed output: schema validation, bounded regeneration | `steps/common.ts:MAX_REGENERATIONS` | F/model-faults.test.ts "a planner that keeps returning malformed output..." | done |
| S14.8 | Timeout: diagnose performance or environment | timeouts get their own fingerprint and the ordinary diagnosis | U/evidence/fingerprint.test.ts "...and a timeout its own" | partial |
| S14.9 | Flaky check: bounded reruns, disclosed | `evidence/runner.ts` flaky_reruns | I/evidence/runner.test.ts "records a pass after a failure as flaky, never clean" | done |
| S14.10 | Lost action response: query remote before retry | `delivery/actions.ts:ActionLedger` | U/delivery/actions.test.ts "after an error, reconciles BEFORE retrying" | done |
| S14.11 | Conflict: rebase only if authorized; invalidate changed evidence | none (diverged branch refused; no rebase path or authorization) | I/delivery/git.test.ts "never overwrites a diverged branch without a lease" | partial |
| S14.12 | Budget exhaustion: stop workers, keep artifacts, report | `steps/common.ts:finishRun` | F/budgets.test.ts "...with the failing evidence and the worktree preserved" | done |
| S14.13 | Self-healing cannot rewrite policy; recovery has a budget | `recovery/budget.ts` | U/recovery/budget.test.ts | done |

## 15. Delivery and CI

| ID | Requirement | Implementation | Tests | Status |
|---|---|---|---|---|
| S15.1 | Commit verified trees, push configured task branches only | `delivery/git.ts:pushBranch`, `assertTaskBranch` | I/delivery/git.test.ts "refuses the base branch, non-task branches and bad remotes" | done |
| S15.2 | Create or update one PR per run | `delivery/deliver.ts` | I/delivery/deliver.test.ts "delivers a repaired candidate as a fast-forward... and updates the same PR" | done |
| S15.3 | Observe CI, sanitized logs, repair within cycle limits | `delivery/ci.ts`, `steps/awaiting-ci.ts` | I/delivery/ci-flow.test.ts, F/injection.test.ts | done |
| S15.4 | Before every action: validate, persist intent, execute, receipt, reconcile | `delivery/actions.ts:ActionLedger.perform` | U/delivery/actions.test.ts "persists intent, executes and stores the receipt" | done |
| S15.5 | Opt-in merge with exact candidate, branch checks, review policy, no blockers; revalidate after changes | none (`actions.merge` only gates authorization) | none | missing |
| S15.6 | Deployment through a release profile with environment safeguards | none | none | missing |

## 16. Observability

| ID | Requirement | Implementation | Tests | Status |
|---|---|---|---|---|
| S16.1 | Record every model choice | `controller/workers.ts:routeFor` (route decisions) | A/credentials-and-routing.test.ts "scenario 13" | done |
| S16.2 | Record agent spawn and cancellation | `storage/workers.ts:planWorker`, `requestWorkerCancel` | U/storage/workers.test.ts "writes a PLANNED row and a worker.planned event" | done |
| S16.3 | Record allowance extensions | `steps/diagnosing.ts:136` | A/proof-and-progress.test.ts "scenario 6" (deny path) | done |
| S16.4 | Record every policy denial | only scope inspection writes `policy.deny`; guard-hook and Claude `permission_denials` are dropped | none | partial |
| S16.5 | Record experiments | `inquisition/hypotheses.ts:recordExperiment` | U/inquisition/hypotheses.test.ts | done |
| S16.6 | Record provider disagreements | `review/resolve.ts` | A/review-and-security.test.ts "scenario 16" | done |
| S16.7 | Record evidence invalidations | `evidence/freshness.ts:invalidateEvidence` | U/evidence/freshness.test.ts "...logs one event" | done |
| S16.8 | Record state transitions | `run-store.ts:transition` | U/storage/run-store.test.ts | done |
| S16.9 | Record external-action reconciliations | `delivery/actions.ts` | U/delivery/actions.test.ts "records each reconciliation as a decision" | done |
| S16.10 | Metrics: verified pass rate, spend per accepted task, token and cache usage | `cli/commands/report.ts:learningReport`, `routing/usage.ts` | U/cli/inspect.test.ts "summarizes verified pass rate...", U/routing/usage.test.ts | done |
| S16.11 | Metrics: false-pass rate, escalation quality, duplicate failures, time-to-green, concurrency overhead, stale-evidence prevention, UI defects found | none in observability (false pass exists only in `knowledge/evals.ts`) | none | missing |
| S16.12 | No sensitive content in logs | `core/log.ts`, `cli/io.ts` | U/core/log.test.ts "redacts the message and every string field", U/cli/io.test.ts | done |
| S16.13 | Missing usage measurements explicit | `routing/usage.ts`, `controller/report.ts` | U/controller/report.test.ts "states unmeasured spend instead of implying a number" | done |

## 17. Acceptance and fault testing

| ID | Requirement | Implementation | Tests | Status |
|---|---|---|---|---|
| S17.1 | Unit tests: contracts, policy, traversal, fingerprints, budgets, routing, scheduling, freshness, transitions, decisions, redaction, reconciliation | n/a | U/contract, U/policy, U/evidence, U/scheduling, U/routing, U/storage, U/core/redact.test.ts, U/delivery/actions.test.ts | done |
| S17.2 | Integration tests: plugin, hooks, worker launch, worktree isolation, SQLite recovery, checks, mock review, UI fixtures, mock delivery, service restart | n/a | I/plugin, I/cli/hook.test.ts, I/adapters, I/isolation, I/recovery, I/evidence, I/review, I/ui, I/delivery, I/controller/service-loop.test.ts | done |
| S17.F1 | Fault: kill worker during edit | n/a | F/worker-crash.test.ts (dead controller passes; live controller it.fails) | partial |
| S17.F2 | Fault: kill controller mid-transition | n/a | F/controller-crash.test.ts | done |
| S17.F3 | Fault: lose PR response | n/a | F/delivery.test.ts "a lost pull request response is reconciled..." | done |
| S17.F4 | Fault: malformed output | n/a | F/model-faults.test.ts | done |
| S17.F5 | Fault: expired credentials | n/a | F/model-faults.test.ts (reviewer passes; implementer it.fails) | partial |
| S17.F6 | Fault: exhausted budgets | n/a | F/budgets.test.ts | done |
| S17.F7 | Fault: prompt injection in logs | n/a | F/injection.test.ts | done |
| S17.F8 | Fault: indirect shell writes | n/a | F/policy-faults.test.ts | done |
| S17.F9 | Fault: policy edits | n/a | F/policy-faults.test.ts "a policy snapshot edited mid-run..." | done |
| S17.F10 | Fault: stale revision | n/a | F/delivery.test.ts "a candidate changed after review cannot be delivered" | done |
| S17.F11 | Fault: cancellation during checks | n/a | F/cancellation.test.ts | done |
| S17.F12 | Fault: unavailable reviewer | n/a | F/model-faults.test.ts "a mandatory independent reviewer that is missing..." | done |
| S17.F13 | Fault: resource saturation | n/a | F/saturation.test.ts (unit cases pass; two-run case it.fails) | partial |
| S17.M1 | Scenario 1: scoped feature passes with behaviour tests | n/a | A/feature-and-repair.test.ts "scenario 1" | done |
| S17.M2 | Scenario 2: reproducible regression repaired | n/a | A/feature-and-repair.test.ts "scenario 2" | done |
| S17.M3 | Scenario 3: reversible ambiguity resolved unattended | n/a | A/ambiguity.test.ts "scenario 3" | done |
| S17.M4 | Scenario 4: material ambiguity blocks affected work, independent work continues | n/a | A/ambiguity.test.ts (first test passes; second it.fails) | partial |
| S17.M5 | Scenario 5: weak tests rejected despite green | n/a | A/proof-and-progress.test.ts "scenario 5" | done |
| S17.M6 | Scenario 6: repeated non-progress terminates | n/a | A/proof-and-progress.test.ts "scenario 6" | done |
| S17.M7 | Scenario 7: restart does not duplicate workers or actions | n/a | A/restart-and-delivery.test.ts "scenario 7" (two tests) | done |
| S17.M8 | Scenario 8: lost PR response, one PR | n/a | A/restart-and-delivery.test.ts "scenario 8" | done |
| S17.M9 | Scenario 9: unauthorized protected changes rejected | n/a | A/policy-and-evidence.test.ts "scenario 9" | done |
| S17.M10 | Scenario 10: stale evidence cannot authorize delivery | n/a | A/policy-and-evidence.test.ts "scenario 10" | done |
| S17.M11 | Scenario 11: no permission-prompt deadlock | n/a | A/credentials-and-routing.test.ts "scenario 11" (real `claude`, ran here) | done |
| S17.M12 | Scenario 12: expired credentials give a truthful blocker | n/a | A/credentials-and-routing.test.ts (two pass; implementer variant it.fails) | partial |
| S17.M13 | Scenario 13: simple work on a low-cost route | n/a | A/credentials-and-routing.test.ts "scenario 13" | done |
| S17.M14 | Scenario 14: escalation only with recorded justification | n/a | A/credentials-and-routing.test.ts (one passes; single-failure variant it.fails) | partial |
| S17.M15 | Scenario 15: parallel work respects isolation and limits | n/a | A/parallel.test.ts (two tests) | done |
| S17.M16 | Scenario 16: disagreement becomes a testable claim | n/a | A/review-and-security.test.ts "scenario 16" | done |
| S17.M17 | Scenario 17: UI defect reproduced, repaired, reverified | n/a | A/ui.test.ts "scenario 17" | done |
| S17.M18 | Scenario 18: visual baselines cannot hide regressions | n/a | A/ui.test.ts "scenario 18" | done |
| S17.M19 | Scenario 19: security findings follow severity and exception policy | n/a | A/review-and-security.test.ts "scenario 19" (three tests) | done |
| S17.M20 | Scenario 20: cancellation effective after restart | n/a | A/restart-and-delivery.test.ts "scenario 20" | done |

## 18. Implementation milestones

| ID | Requirement | Implementation | Tests | Status |
|---|---|---|---|---|
| S18.1 | Contracts, policy, storage, doctor, transitions | `contract/`, `policy/`, `storage/`, `cli/commands/doctor.ts` | see S3, S4, S6 | done |
| S18.2 | Isolated worker plus trusted verification slice | `adapters/`, `isolation/`, `evidence/` | I/controller/runs.test.ts | done |
| S18.3 | Inquisition, repair briefs, non-progress detection | `inquisition/` | see S10 (S10.5 partial) | partial |
| S18.4 | Persistent execution and fault recovery | `controller/loop.ts`, `recovery/` | see S14 (S14.3, S14.6 partial) | partial |
| S18.5 | Registry, token accounting, adaptive budgets, scheduling | `routing/`, `scheduling/` | see S8 (S6.19 partial) | partial |
| S18.6 | Codex review adapter and disagreement resolution | `adapters/codex.ts`, `review/` | see S12 | done |
| S18.7 | UI runner, accessibility, visual artifacts | `ui/` | see S13 | done |
| S18.8 | Delivery, CI repair, action reconciliation | `delivery/` | see S15 (merge missing) | partial |
| S18.9 | Acceptance suite, docs, demo runs, security review | `tests/acceptance`, `docs/`, `examples/` | 3 it.fails; live demo unverified | partial |
| S18.10 | Enforcement exists before autonomous delivery | `policy/`, `isolation/` | U/policy/*, I/isolation/* | done |

## 19. Definition of delivered

| ID | Requirement | Implementation | Tests | Status |
|---|---|---|---|---|
| S19.1 | Installs | `docs/installation.md`, `scripts/check-plugin.mjs` | I/plugin/plugin.test.ts "validates under --strict" | done |
| S19.2 | Loads | plugin, `dist/orbit.mjs` | I/plugin/plugin.test.ts "is current and starts with a node shebang" | done |
| S19.3 | Runs persistently | `controller/service.ts`, `controller/loop.ts` | I/controller/service-loop.test.ts | done |
| S19.4 | Completes the demo unattended | mock demo; live demo never run | I/demo/mock-demo.test.ts | partial |
| S19.5 | Commands use documented interfaces | `docs/interfaces/*` | U/adapters/claude-invocation.test.ts "builds the verified headless invocation" | done |
| S19.6 | State survives restart | `storage/`, `recovery/` | A/restart-and-delivery.test.ts | done |
| S19.7 | Policies enforced outside prompts | `policy/`, `isolation/` | F/policy-faults.test.ts | done |
| S19.8 | Evidence is candidate-bound | `evidence/` | U/evidence/freshness.test.ts | done |
| S19.9 | Inquisition works interactively and unattended | see S4.2, S10.5 | A/ambiguity.test.ts (it.fails) | partial |
| S19.10 | Review and delivery are reconciled | `review/stale.ts`, `delivery/actions.ts` | I/review/flow.test.ts, I/delivery/deliver.test.ts | done |
| S19.11 | Fault tests pass | `tests/fault-injection` | 3 it.fails (F1, F5, F13) | partial |
| S19.12 | No placeholder labelled functional | `/orbit:verify`, `/orbit:repair`, `/orbit:inquisition` are documented as working and call missing commands | none | partial |
| S19.13 | Final report: outcome, goal, behaviour, criterion evidence, checks, decisions, assumptions, repairs, revision, branch, PR, budget, risks, blocker or next action | `controller/report.ts:buildFinalReport` | U/controller/report.test.ts "has every section spec section 19 asks for" | done |

## 20. Example user invocation

| ID | Requirement | Implementation | Tests | Status |
|---|---|---|---|---|
| S20.1 | `/orbit:run` with a natural-language goal and authority prose; authority comes only from policy | `skills/run/SKILL.md`, `cli/commands/run.ts` (prose is goal text; a prose mode or permission that disagrees with the policy is not flagged) | I/cli/run.test.ts | partial |

## 21. Compact worker operating prompt

| ID | Requirement | Implementation | Tests | Status |
|---|---|---|---|---|
| S21.1 | Workers get the compact operating prompt, role, bounded unit, contract, policy summary, candidate, evidence | `adapters/prompt.ts:OPERATING_PROMPT`, `steps/common.ts:policySummary` | U/adapters/prompt-agents.test.ts "starts with the compact operating prompt..." | done |
| S21.2 | Structured output with paths, evidence, findings, next action; never claim completion | `schemas/implementer-output.schema.json` | U/schemas/model-output-schemas.test.ts "gives the implementer no way to claim completion" | done |

## Counts

| Status | Rows |
|---|---|
| done | 285 |
| partial | 54 |
| missing | 15 |
| untested | 5 |
| total | 359 |

Many partial rows in sections 1, 18 and 19 roll up a root gap listed elsewhere
(they name it with "see"). `docs/gaps.md` lists each root gap once.

## Coverage and test reach

- No coverage provider is installed (`@vitest/coverage-v8` and
  `@vitest/coverage-istanbul` are absent), so `npx vitest run --coverage`
  cannot run. Line and branch coverage are unknown.
- Source files that no test imports directly (tests/ and scripts/ were
  searched): `adapters/{commands,hook-main,shim-main}.ts`, `cli/commands/{control,decide,doctor,internal,learn,logs,models,policy,report,run,service,status}.ts`,
  `cli/{hook,main}.ts`,
  every `controller/steps/*.ts` except `common.ts`, `obtain.ts` and `index.ts`,
  `controller/index.ts`, `core/ids.ts`, `delivery/index.ts`, `evidence/{git,index}.ts`,
  `inquisition/index.ts`, `knowledge/{db,jsonld}.ts`, `recovery/index.ts`,
  `routing/pricing.ts`, `storage/schema.ts`, `ui/{env,index}.ts`.
- Following imports transitively from tests and scripts, and counting
  `src/cli/main.ts` as reached because tests spawn it, every source file is
  reached except the barrels `delivery/index.ts`, `evidence/index.ts`, `ui/index.ts`
  and the entry points `adapters/hook-main.ts` and `adapters/shim-main.ts`. The
  entry points run only as child processes when Orbit runs from source.
