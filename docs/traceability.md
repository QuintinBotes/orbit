# Spec traceability

Every concrete requirement of `docs/spec.md` (sections 1 to 21), the code that
implements it and the tests that prove it. Non-done rows have a fix in
`docs/gaps.md`, where each gap names the requirement ids it covers.

Final re-audit of 2026-10-05, after the stabilizer wave (G40 and G49). The
audit went through spec sections 1 to 21 requirement by requirement, checked
mechanically that every test cited below exists in the named file under the
quoted name, and read the tests behind every row that changed in the last two
waves (among them S3.27, S3.28, S4.3, S5.2, S5.13, S5.28, S6.6, S8.21, S8.27,
S14.11, S15.5 and S15.6). `npm run test:coverage`: 347 test files, 6399
tests passed and 1 skipped (`identity.test.ts`, Linux only), none failing;
thresholds met and enforced (see "Coverage" at the end). No `it.fails`,
`it.todo` or `.only` marker remains in `tests/` outside fixtures that test the
weakening detector.

Status rules:

- **done**: implemented, and at least one test asserts the behaviour.
- **partial**: implemented in part, a stub, behaviour contradicted by an
  `it.fails` or failing test, or a config key that is parsed but never applied.
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
| S1.6 | Dynamic routing across Fable, Opus, Sonnet, Haiku | `routing/router.ts:route` | U/routing/router.test.ts; A/credentials-and-routing.test.ts "scenario 14: the implementer is not escalated on a single localized failure..."; I/controller/routing-down.test.ts | done |
| S1.7 | Token-efficient context and usage accounting | `adapters/prompt.ts`, `routing/usage.ts`, role output budgets (S8.21) | U/routing/usage.test.ts, I/adapters/output-budget.test.ts | done |
| S1.8 | Resource-aware subagent scheduling | `scheduling/scheduler.ts:AgentScheduler`, `steps/implementing.ts` (running set across every run of the controller) | U/scheduling/scheduler.test.ts; F/saturation.test.ts "with memory saturated, a controller owning two runs never has more than one implementer running" | done |
| S1.9 | Cross-provider review, Codex first | `adapters/codex.ts`, `review/select.ts` | I/adapters/codex-fake.test.ts, I/review/flow.test.ts | done |
| S1.10 | Playwright journeys, accessibility, visual verification | `ui/runner.ts:runUiChecks` | I/ui/runner-journeys.test.ts, I/ui/runner-baselines.test.ts, I/ui/runner-keyboard-a11y.test.ts | done |
| S1.11 | Recovery from crashes, interrupted workers, ambiguous action outcomes | `recovery/reconcile.ts`, `steps/implementing.ts` (LOST worker restart), `delivery/actions.ts` | I/recovery/*, F/worker-crash.test.ts "the worker dies under a live controller..." | done |
| S1.12 | Truthful completion or escalation reports | `controller/report.ts:buildFinalReport` | U/controller/report.test.ts, U/controller/report-findings.test.ts | done |
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
| S2.4 | No duplicate workers or actions after crash, closed terminal, lost response | `recovery/reconcile.ts:reconcileOnStart`, `delivery/actions.ts:ActionLedger` | A/restart-and-delivery.test.ts "scenario 7", "scenario 8"; F/worker-crash.test.ts (both tests) | done |
| S2.5 | Installation, configuration, security docs, demo repository | `docs/*.md`, `examples/demo-app` | I/demo/example.test.ts "copies Orbit's Playwright fixtures template unchanged", A/demo-shapes.test.ts "demo 1..." | done |
| S2.6 | Demo 1: simple task on a low-cost route | `scripts/demo/mock-demo.ts` | A/demo-shapes.test.ts "demo 1...", I/demo/mock-demo.test.ts "simple: SUCCEEDED on a cheap route" | done |
| S2.7 | Demo 2: difficult task with evidence-backed escalation | same | A/demo-shapes.test.ts "demo 2...", I/demo/mock-demo.test.ts "difficult..." | done |
| S2.8 | Demo 3: UI fails browser checks, repaired, reviewed, draft PR | same | A/ui.test.ts "scenario 17 (and demo run 3)", I/demo/mock-demo.test.ts "ui..." | done |
| S2.9 | Demos run unattended against real providers | `scripts/demo/run-live-demo.sh`; README "Live runs and what is not proven yet" says what ran against real providers and what did not, and gives the reproduction commands | I/demo/live-script.test.ts (stubbed gh and orbit only); `docs/demos/2026-10-05/` holds the live reports: simple and difficult SUCCEEDED with draft PRs, ui BLOCKED (G39) | partial |
| S2.10 | Safe stop: unauthorized action | `delivery/deliver.ts`, `policy/authorize.ts` | A/safe-stops.test.ts "unauthorized action..." | done |
| S2.11 | Safe stop: stale evidence | `evidence/freshness.ts:assertDeliverable` | A/policy-and-evidence.test.ts "scenario 10..." | done |
| S2.12 | Safe stop: repeated non-progress | `inquisition/repair.ts:nonProgress` | A/proof-and-progress.test.ts "scenario 6..." | done |
| S2.13 | Safe stop: exhausted budget | `scheduling/budget.ts`, `steps/implementing.ts:startAttempt` | A/safe-stops.test.ts "exhausted budget..." | done |
| S2.14 | Safe stop: expired credentials | `recovery/credentials.ts`, `steps/common.ts:blockOnAuth`, `controller/workers.ts` (auth-failed session not charged at the ceiling) | A/safe-stops.test.ts "expired credentials..."; A/credentials-and-routing.test.ts "scenario 12: an implementer whose credentials expire mid-run (401) blocks on credentials, not on budget" | done |
| S2.15 | Safe stop: unavailable mandatory reviewer | `review/select.ts:selectReviewer` | A/safe-stops.test.ts "unavailable mandatory reviewer..." (two tests) | done |
| S2.16 | Environment-blocked tests labelled, with reproduction commands | `skipIf` guards, `tests/acceptance/README.md` | I/controller/security.test.ts (skipIf gitleaks), I/adapters/os-sandbox.test.ts | done |
| S2.17 | Acceptance suite passes before completion is declared | `tests/acceptance/*` | 35 tests, all plain `it`, all pass | done |

## 3. Architecture

| ID | Requirement | Implementation | Tests | Status |
|---|---|---|---|---|
| S3.1 | Component: plugin (skills, agents, hooks) | `skills/`, `agents/`, `hooks/` | I/plugin/plugin.test.ts "resolves every orbit command a skill names to a registered command" | done |
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
| S3.18 | Vitest | `vitest.config.ts` (coverage over `src/**`, thresholds lines 95, functions 95, statements 95, branches 90) | whole suite; `npm run test:coverage` exits 0 | done |
| S3.19 | Structured JSON logs | `core/log.ts:createLogger` | U/core/log.test.ts "writes one JSON object per line..." | done |
| S3.20 | CLI executable named `orbit` | `package.json` bin, `cli/cli.ts:main` | U/cli/cli.test.ts, I/plugin/plugin.test.ts "runs --version and doctor --json" | done |
| S3.21 | Record justification for different defaults | `docs/decisions/0001..0004` | U/ui/decision.test.ts "records the decision, the reasons and the consequences" (0004 only) | done |
| S3.22 | Plugin layout (skills, agents, hooks, src dirs, schemas, templates, tests, examples, docs) | repository tree | I/plugin/plugin.test.ts "lists eight skills, init and doctor among them, and the seven agents (P10)" | done |
| S3.23 | Manifest `.claude-plugin/plugin.json` with name, version, description, license, keywords | `.claude-plugin/plugin.json` | I/plugin/plugin.test.ts "validates under --strict" | done |
| S3.24 | `.orbit/` layout: config, state.sqlite, runs/<id>/{contract, policy, decisions.jsonl, evidence, logs, final.md} | `controller/start.ts`, `storage/decisions.ts`, `controller/report.ts` | I/cli/run.test.ts "drives a run to success... leaves a final report", U/storage/decisions.test.ts | done |
| S3.25 | No mutable run data in the plugin directory | `controller/context.ts:runWorktreeRoot` | A/parallel.test.ts "scenario 15..." | done |
| S3.26 | Protect policy and trusted storage from workers | `isolation/profiles.ts`, `policy/snapshot.ts` (mode 0444) | U/policy/snapshot.test.ts "detects a snapshot made writable", I/isolation/sandbox-runtime.int.test.ts "cannot read sibling projects, the main checkout or Orbit state" | done |
| S3.27 | Artifact retention rules | `storage/retention.ts:pruneExpiredRuns`, `cli/commands/gc.ts`, `controller/loop.ts` (start and periodic pass) | U/storage/retention.test.ts "never touches BLOCKED or still-active runs...", I/controller/retention.test.ts "the periodic pass prunes a run that expires while the service runs", U/cli/gc-stats.test.ts | done |
| S3.28 | Redaction rules (configured patterns) | `core/redact.ts:applyRedactPatterns`, called by `policy/snapshot.ts` and `loadConfig`; `controller/report.ts:buildFinalReport` deep-redacts, so `final.json`, `final.md` and `orbit report --json` are covered | I/policy/redact-patterns.test.ts "verifying a run snapshot puts its patterns in force for the controller log, worker prompts and final.md", "...for the review packet"; U/controller/report-redact.test.ts "redacts every string of final.json, not only final.md" | done |

## 4. Commands and unattended operation

| ID | Requirement | Implementation | Tests | Status |
|---|---|---|---|---|
| S4.1 | `/orbit:run <goal>` | `skills/run/SKILL.md` to `orbit run` | I/plugin/plugin.test.ts "skills pass arguments through verbatim" | done |
| S4.2 | `/orbit:inquisition <goal-or-plan>` | `skills/inquisition/SKILL.md` (conversational grill without a run; `orbit questions` and `orbit decide <run-id> <question-id>` with one) | I/plugin/plugin.test.ts "resolves every orbit command a skill names...", "never invents an inquisition command" | done |
| S4.3 | `/orbit:verify [run-id]` | `cli/commands/verify.ts:verifyCommand` and `steps/verifying.ts` both call `controller/verification.ts:collectVerificationEvidence`, so one policy judges a finding wherever it is asked | I/cli/verify-repair.test.ts "prints a verdict per criterion...", "exits 14 on FAIL...", "refuses while a live controller owns the run", "judges a secret finding waived by static_security.exceptions the way the run did..." | done |
| S4.4 | `/orbit:repair <failure-or-run-id>` | `cli/commands/repair.ts:repairCommand` | I/cli/verify-repair.test.ts "moves a BLOCKED run with FAIL evidence to DIAGNOSING and the controller completes the repair", "turns a description into a repair run..." | done |
| S4.5 | `/orbit:status [run-id]` | `skills/status/SKILL.md` | I/plugin/plugin.test.ts "names only real run states in the status skill" | done |
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
| S4.27 | Use native `/goal` when available as a continuation aid | `skills/run/SKILL.md` "Keeping the session on the goal (optional)", `docs/operations.md` "Using the native /goal command" | I/plugin/plugin.test.ts "offers native /goal as an optional aid while keeping the controller as the completion authority" | done |
| S4.28 | Controller works without `/goal` | controller has no `/goal` dependency | whole suite | done |

## 5. Authorization and security gates

| ID | Requirement | Implementation | Tests | Status |
|---|---|---|---|---|
| S5.1 | Supervised mode asks for material decisions | `steps/inquisition.ts` (disposition ask: BLOCKED with questions), `cli/commands/decide.ts` | U/inquisition/resolve.test.ts "unattended with nothing independent left: BLOCKED. Supervised: wait for the person" | done |
| S5.2 | Supervised mode asks for unauthorized actions | `controller/authorization.ts` (lockfile and package changes, and `actions.*` and `network.*` denials from a worker: persisted approve-once or deny question; approve-once retries the attempt under a read-only grant policy for exactly that operation and the transcript is checked afterwards); `steps/implementing.ts`, `controller/workers.ts` | I/controller/supervised-authorization.test.ts "a lockfile change blocks on a persisted authorization question; approve-once from a person lets that candidate through", "a denied chmod becomes a persisted question; approve-once retries the attempt under a grant for exactly that operation", "deny retries the attempt as a scope repair under the unchanged policy", "autonomous mode only records the denial and asks nothing"; U/controller/authorization-grants.test.ts | done |
| S5.3 | Autonomous mode: preauthorized work, reversible ambiguity resolved | `inquisition/resolve.ts:resolveAmbiguities` | A/ambiguity.test.ts "scenario 3..." | done |
| S5.4 | Autonomous delivery: commit, push task branch, PR, CI repair | `steps/delivering.ts`, `steps/awaiting-ci.ts` | A/feature-and-repair.test.ts "scenario 1", F/injection.test.ts "a CI log with injected instructions becomes a fenced repair brief..." | done |
| S5.5 | Release mode: narrowly scoped release actions via a release profile | `delivery/release.ts:performRelease`, `steps/delivering.ts`, `steps/awaiting-ci.ts`, `policy/config.ts` (`release` block) | I/delivery/release.test.ts "refuses every release action outside release mode...", I/controller/release.test.ts | done |
| S5.6 | Unified configuration example loads | `policy/config.ts:parseConfig` | U/policy/config.test.ts "fills a minimal file from the spec section 5 example" | done |
| S5.7 | Provider ids are adapter ids; model ids resolved during validation | `policy/config.ts:modelPermitted`, `routing/registry.ts` | U/policy/config.test.ts "accepts exact entries and family members only" | done |
| S5.8 | Every example config key has effect | `schemas/config.schema.json` (`const true` for the three agents keys, `const false` for `change_secrets`), `policy/authorize.ts` (`actions.change_permissions`) | U/policy/config.test.ts "refuses require_independent_work_units: false and change_secrets: true...", U/policy/authorize.test.ts "actions.change_permissions (gap G26...)" | done |
| S5.9 | Gate sequence in spec order | `controller/gates.ts:GATES`, `FAILURE_BEHAVIOUR` | U/controller/gates.test.ts "lists the spec gates in order with their failure behaviour" | done |
| S5.10 | Intake gate: repository, scope, budgets, measurable criteria; reject invalid contract | `gates.ts:intakeGate` | U/controller/gates.test.ts "rejects a criterion that cites no trusted check..." | done |
| S5.11 | Environment gate: isolation, scoped credentials, network controls; block unattended | `gates.ts:environmentGate` | U/controller/gates.test.ts "refuses an unavailable provider and blocks on missing or expired credentials" | done |
| S5.12 | Baseline gate: locked install, existing failures recorded | `gates.ts:baselineGate`, `evidence/baseline.ts:runBaseline` | U/controller/gates.test.ts "records pre-existing failures...", I/evidence/baseline.test.ts | done |
| S5.13 | Baseline gate: vulnerability and license policy | `evidence/baseline.ts` (`dependencies.audit`), `controller/gates.ts:baselineGate` (one note per base finding), `steps/verifying.ts` (unverified audit disclosed) | I/evidence/baseline-audit.test.ts "records the base revision findings and blocks a candidate that adds a high vulnerability or a disallowed license", U/controller/gates.test.ts "lists each base-revision audit finding the baseline recorded...", I/controller/static-security-policy.test.ts "a candidate dependency audit that could not run is disclosed as unverified..." | done |
| S5.14 | Implementation gate: filesystem bounds, protected paths; deny and record | `gates.ts:implementationScopeGate`, `steps/verifying.ts` (policy.deny decision) | U/controller/gates.test.ts "treats protected paths and escaping symlinks as a policy violation" | done |
| S5.15 | Static security: secret scan | `controller/security.ts:scanCandidateSecrets` | I/controller/security.test.ts, U/controller/gates.test.ts "fails on secrets..." | done |
| S5.16 | Static security: configured SAST | `policy/config.ts:sastCheckIds`, `gates.ts:staticSecurityGate` | U/controller/gates.test.ts "reports static analysis as unverified... when the policy defines no SAST" | done |
| S5.17 | Static security: sensitive-diff review | `inquisition/triggers.ts` hidden_decision from `riskCategoriesInDiff` | U/inquisition/triggers.test.ts "flags a security change the contract never mentions, from the diff" | done |
| S5.18 | Static security repairs or blocks by severity policy | `controller/security.ts` (`static_security`, `judgeSastResult`), `steps/verifying.ts` | I/controller/static-security-policy.test.ts "a secret finding waived by static_security.exceptions does not block...", "the same finding outside the excepted path still blocks the candidate" | done |
| S5.19 | Behaviour gate: failure produces a repair brief | `gates.ts:behaviourGate`, `steps/diagnosing.ts` | A/feature-and-repair.test.ts "scenario 2" | done |
| S5.20 | UI gate: repair or block | `gates.ts:uiGate` | U/controller/gates.test.ts "requires configured journeys when UI evidence is needed" | done |
| S5.21 | Independent review gate: resolve findings | `review/stale.ts:reviewGate`, `gates.ts:independentReviewGate` | U/review/stale.test.ts | done |
| S5.22 | Delivery gate: exact revision, fresh evidence, authorized destination | `delivery/gate.ts:assertDeliverable`, `evidence/freshness.ts` | U/delivery/gate.test.ts, I/delivery/deliver.test.ts "refuses a remote host that network.allowed_hosts does not list" | done |
| S5.23 | Completion gate: every mandatory requirement holds for the delivered revision | `gates.ts:completionGate` (criteria blocked by open material questions), `steps/reviewing.ts`, `steps/delivering.ts` | U/controller/completion-gate.test.ts "fails while a material question blocks a criterion...", A/ambiguity.test.ts "scenario 4: the blocked criterion keeps the run from success and delivery..." | done |
| S5.24 | Snapshot and hash policy before execution | `policy/snapshot.ts:snapshotPolicy` | U/policy/snapshot.test.ts "writes a read-only, self-describing snapshot..." | done |
| S5.25 | Workers cannot modify policy, trusted runner or authorization state | `isolation/profiles.ts`, `policy/builtin.ts` | A/policy-and-evidence.test.ts "scenario 9", F/policy-faults.test.ts | done |
| S5.26 | Policy expansion needs a separately authorized revision | `contract/amend.ts`, `inquisition/engine.ts:processAmendments` | U/inquisition/engine.test.ts "widening scope beyond the frozen policy is refused outright" | done |
| S5.27 | Trusted components mounted read-only | `isolation/profiles.ts` (read-only config, policy) | U/isolation/profiles.test.ts "keeps the config dir surfaces that run code on the host read-only" | done |
| S5.28 | Restrict filesystem, network, CPU, memory, process count, time | srt: fs and network; `isolation/limits.ts` sets `ulimit` CPU time, process count and file size and `isolation/memory.ts` is a resident-memory watchdog around srt; all on by default (`isolation.limits`, null turns one off); the container provider keeps its own memory limit and `none` enforces no memory; `isolation.require_resource_limits` (default false) makes `controller/gates.ts:environmentGate` and `orbit doctor` refuse a provider that cannot enforce a configured limit (`isolation/limits.ts:unenforcedLimits`) | U/isolation/limits.test.ts "unenforcedLimits and resourceLimitRefusals", U/controller/gates.test.ts "environmentGate: isolation.require_resource_limits (G24)", U/cli/coverage-doctor-system.test.ts "fails when isolation.require_resource_limits is true", I/controller/require-resource-limits.test.ts, U/isolation/limits.test.ts, U/isolation/memory.test.ts, I/isolation/limits.int.test.ts "sets CPU time, process count and file size as hard limits for the command" (macOS only run), I/isolation/memory.int.test.ts "stops a sandboxed command that holds too much memory" (real srt), I/evidence/runner-memory.test.ts, I/isolation/container.int.test.ts, A/demo-shapes.test.ts "demo 1..." (default limits on a busy account) | done |
| S5.29 | No host credentials, SSH agents, container sockets | `adapters/env.ts:buildWorkerEnv`, `isolation/profiles.ts` | U/adapters/env-shim.test.ts "starts from an allowlist...", U/isolation/profiles.test.ts "denies container-engine state and keychains" | done |
| S5.30 | Separate implementation and delivery credentials; none in workers | `adapters/env.ts`, `delivery/github.ts:GhCliClient` | U/adapters/env-shim.test.ts, I/delivery/gh-cli.test.ts "uses the controller token only" | done |
| S5.31 | Resolve symlinks, canonicalize, reject traversal | `policy/paths.ts:resolveInside` | U/policy/paths.test.ts | done |
| S5.32 | Inspect final diffs independently of hooks | `policy/scope.ts:inspectScope` | I/policy/scope.test.ts, F/policy-faults.test.ts "...caught by scope inspection" | done |
| S5.33 | Constrain indirect writes through shell | `policy/bash.ts:classifyBash`, OS sandbox | U/policy/bash.test.ts, U/policy/adversarial.test.ts | done |
| S5.34 | Repository text, logs, web, dependency output are untrusted | `adapters/prompt.ts:fence` | F/injection.test.ts "a check log with injected instructions reaches the verifier... only as fenced untrusted data" | done |
| S5.35 | Tool output cannot grant authority | `adapters/prompt.ts`, `knowledge/authority.ts` | U/adapters/prompt-agents.test.ts "fences every untrusted input with a label that says it grants nothing" | done |
| S5.36 | Sanitize logs and artifacts before provider transmission | `core/redact.ts:redactForProvider` | U/adapters/prompt-agents.test.ts "bounds untrusted blocks, redacts secrets for the provider", I/review/packet.test.ts | done |
| S5.37 | Enforce provider data-handling eligibility | `review/packet.ts:assertProviderEligible` | I/review/packet.test.ts "refuses a provider whose data_policy_eligible is false" | done |
| S5.38 | Explicit scanner severity and exception rules | `controller/security.ts` (secret severities, SARIF severities, `static_security.exceptions`), `review/resolve.ts` | I/policy/static-security.test.ts "gives every secret finding a severity...", "reads severity from security-severity scores, falling back to the result level" | done |
| S5.39 | Hooks assist; controller checks and isolation remain the gate | `policy/scope.ts` after `policy/guard-hook.ts` | F/policy-faults.test.ts | done |
| S5.40 | Select applicable engineering practices per task and justify omissions | `contract/practices.ts`, `schemas/planner-output.schema.json`, `contract/draft.ts`, `review/packet.ts`, `steps/planning.ts` (`planning.practices` decision), `controller/report.ts` ("Engineering practices") | U/contract/draft.test.ts (engineering practices), U/schemas/model-output-schemas.test.ts "planner output: engineering practices", U/review/packet-practices.test.ts, U/controller/report-practices.test.ts | done |

## 6. Goal contracts and state

| ID | Requirement | Implementation | Tests | Status |
|---|---|---|---|---|
| S6.1 | Contract stores goal, objective, criteria, non-goals, scope, baseline, checks, proof, assumptions, delivery, policy hash, escalation | `contract/types.ts:GoalContract`, `contract/draft.ts` (budgets bound through policy_hash) | U/contract/draft.test.ts, U/contract/validate.test.ts | done |
| S6.2 | Commands only in trusted config; model commands not authorized | `contract/validate.ts:contractProblems` | U/contract/amend.test.ts "cannot add a check the policy does not define (no check commands)" | done |
| S6.3 | Preflight captures status and revision | `steps/preflight.ts:preflightStep` | I/controller/runs.test.ts (via runs) | done |
| S6.4 | Reject dirty starts unless permitted | `steps/preflight.ts` | I/controller/terminal-paths.test.ts "a dirty start is refused by default, naming the uncommitted path...", "with repository.allow_dirty_start the run proceeds..." | done |
| S6.5 | Run baseline checks, record pre-existing failures | `evidence/baseline.ts:runBaseline` | I/evidence/baseline.test.ts "records pre-existing failures on the base revision..." | done |
| S6.6 | Never green with failing mandatory checks unless the contract accepts a documented baseline exception | `evidence/report.ts` honours `baseline_exceptions`; `steps/preflight.ts` raises a question per pre-existing failure, `inquisition/questions.ts:answerQuestion` (`orbit decide`) applies "Approve" through `inquisition/baseline-exception.ts` and `contract/amend.ts`; `cli/commands/decide.ts` prints the outcome; `controller/steps/verifying.ts` applies an approved answer whose apply step never ran before it judges the evidence | U/evidence/report.test.ts "accepts the failure whose fingerprint equals the recorded one", U/contract/amend.test.ts, U/inquisition/baseline-exception.test.ts, U/inquisition/baseline-exception-run.test.ts (a failing mandatory check through to SUCCEEDED), U/cli/control.test.ts "says what an answer to a baseline-exception question did to the contract", U/inquisition/baseline-exception-run.test.ts "an approval recorded after planning, whose apply step never ran, is applied when VERIFYING starts" | done |
| S6.7 | Amendments: clarify or add tests; never remove mandatory, redefine success, broaden scope | `contract/amend.ts:applyAmendment` | U/contract/amend.test.ts | done |
| S6.8 | Amendment records old, new, evidence, reason, approval, affected verification | `contract/types.ts:ContractAmendment`, `inquisition/store.ts` | U/contract/amend.test.ts, U/inquisition/store.test.ts | done |
| S6.9 | State machine edges | `controller/states.ts` | U/storage/run-store.test.ts "accepts every listed edge and rejects every other pair" | done |
| S6.10 | Ambiguity: INQUISITION, then resume or BLOCKED | `steps/inquisition.ts` | A/ambiguity.test.ts, I/controller/runs.test.ts "scenario 4" | done |
| S6.11 | Failure: DIAGNOSING, REPAIRING, VERIFYING | `steps/diagnosing.ts`, `steps/implementing.ts` | A/feature-and-repair.test.ts "scenario 2" | done |
| S6.12 | Crash: RECOVERING, reconcile, resume | `recovery/budget.ts:enterRecovery`, `steps/recovering.ts` | I/recovery/reconcile-runs.test.ts "a run whose owner died mid-step becomes RECOVERING" | done |
| S6.13 | Policy violation: BLOCKED | `steps/verifying.ts:61` | A/policy-and-evidence.test.ts "scenario 9" | done |
| S6.14 | Budget limit: EXHAUSTED | `steps/common.ts:safePoint` | F/budgets.test.ts | done |
| S6.15 | Cancellation: CANCELLED | `steps/common.ts:safePoint` | F/cancellation.test.ts | done |
| S6.16 | Terminal outcome IMPOSSIBLE | `steps/diagnosing.ts` | I/controller/terminal-paths.test.ts "a diagnosis that rules out every hypothesis ends IMPOSSIBLE..." | done |
| S6.17 | Blocked run resumable after decision or environment repair | `cli/commands/control.ts:resumeCommand` | A/credentials-and-routing.test.ts "scenario 12: reviewer credentials that expire mid-run... orbit resume" | done |
| S6.18 | Invariant: one owner lease per run | `run-store.ts:acquireLease`, `assertLeaseHeld` | I/storage/lease-contention.test.ts | done |
| S6.19 | Invariant: bounded active workers | `steps/implementing.ts` (running set from every active worker of the database) | F/saturation.test.ts "with memory saturated, a controller owning two runs never has more than one implementer running" | done |
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
| S7.12 | Inquisition on authority pressure | `triggers.ts` scope_pressure, fed by `controller/denials.ts` (guard-hook and permission denials as `policy.deny`) | U/controller/denials.test.ts "records each denial once as a policy.deny decision, and three protected edits raise scope_pressure" | done |
| S7.13 | Stop when no useful authorized experiment remains | `steps/diagnosing.ts` (IMPOSSIBLE) | I/controller/terminal-paths.test.ts "a diagnosis that rules out every hypothesis ends IMPOSSIBLE..." | done |
| S7.14 | Stop when mandatory verification is unavailable | `steps/verifying.ts` | I/controller/terminal-paths.test.ts "a mandatory check that cannot start leaves verification incomplete, and the run blocks as an environment failure, naming the cause", U/controller/coverage-steps-verifying.test.ts (INCOMPLETE without a trigger blocks with "mandatory verification is unavailable") | done |
| S7.15 | Stop when a material decision cannot be inferred | `steps/inquisition.ts` | I/controller/runs.test.ts "scenario 4..." | done |
| S7.16 | Stop when the budget cannot support honest completion | `steps/implementing.ts:startAttempt` | A/safe-stops.test.ts "exhausted budget..." | done |
| S7.17 | Extension decision record in the spec shape | `scheduling/budget.ts:extensionDecisionRecord` | U/scheduling/budget.test.ts "grants one attempt... in the spec shape" | done |
| S7.18 | Repeated non-progress terminates | `inquisition/repair.ts:nonProgress` | A/proof-and-progress.test.ts "scenario 6", U/scheduling/adversarial.test.ts | done |

## 8. Models, tokens and subagents

| ID | Requirement | Implementation | Tests | Status |
|---|---|---|---|---|
| S8.1 | Registry records provider, id, surfaces, tools, structured output, vision, limits, pricing, refresh, latency, evaluations, data handling | `routing/registry.ts:ModelRegistry.recordLatency`, `routing/usage.ts:recordUsage` (time to first event) | U/routing/registry.test.ts, U/routing/usage.test.ts "records a rolling median per model and writes it through the registry" | done |
| S8.2 | Validate availability per surface | `ModelRegistry` surfaces | U/routing/router.test.ts "only routes to models validated on the CLI surface", I/cli/models-learn.test.ts | done |
| S8.3 | Haiku for extraction and log classification | `routing/router.ts` | U/routing/router.test.ts "routes bounded extraction to Haiku..." | done |
| S8.4 | Sonnet for routine code; escalate on coupled changes or difficult causal failures | `router.ts` (strong-attempt-failed needs repeated equivalent failures), `steps/implementing.ts:routeSignals`, ADR 0001 | A/credentials-and-routing.test.ts "scenario 14: the implementer is not escalated on a single localized failure..." | done |
| S8.5 | Opus for architecture and complex diagnosis | `router.ts` | U/routing/router.test.ts "keeps architecture on Opus when Fable is not in policy" | done |
| S8.6 | Fable only when evaluation justifies | `router.ts` | U/routing/router.test.ts "uses Fable only when allowed AND a strong attempt failed" | done |
| S8.7 | Screenshot interpretation by an eligible vision model | `router.ts` | U/routing/router.test.ts "routes screenshots to the cheapest eligible vision model" | done |
| S8.8 | Independent review by a qualified other-provider model | `review/select.ts`, `router.ts` | U/routing/router.test.ts "prefers a qualified other-provider reviewer at high effort" | done |
| S8.9 | Optimize expected cost per verified accepted task | `router.ts` cost breakdown | U/routing/router.test.ts "routes simple routine code to Sonnet at medium effort, not Opus or Fable" | done |
| S8.10 | Escalate on observed difficulty, not worker confidence | `router.ts` | U/routing/router.test.ts "ignores worker confidence and requests" | done |
| S8.11 | Raise reasoning effort where supported | `router.ts` | U/routing/router.test.ts "raises effort, not tier, for security-critical code" | done |
| S8.12 | Compact handoff packet | `adapters/prompt.ts:renderWorkerPrompt` | U/adapters/prompt-agents.test.ts "starts with the compact operating prompt..." | done |
| S8.13 | Route routine follow-up down once the diagnosis is solved | `steps/implementing.ts:diagnosisSolved` sets the router signal | I/controller/routing-down.test.ts "the escalated attempt fixes the fault, and the routine follow-up routes back to the starting tier..." | done |
| S8.14 | Never route safety review below its quality floor | `review/select.ts:REVIEW_QUALITY_FLOOR_TIER` | U/review/select.test.ts "never goes below the floor..." | done |
| S8.15 | Deterministic parsing and policy instead of model calls | `inquisition/engine.ts` (rules first) | U/inquisition/engine.test.ts "...does not call a worker" | done |
| S8.16 | Full logs in artifacts, excerpts to workers | `evidence/fingerprint.ts`, `adapters/prompt.ts` | U/evidence/fingerprint.test.ts "bounds the excerpt...", U/adapters/prompt-agents.test.ts | done |
| S8.17 | Retrieve repository context on demand | `adapters/prompt.ts` (no preloaded repo) | U/adapters/prompt-agents.test.ts "...carries the bounded work unit, never the spec" | done |
| S8.18 | Compact contracts, decisions, repair briefs | `contract/*`, `inquisition/repair.ts` | U/inquisition/repair.test.ts | done |
| S8.19 | Supported prompt caching (stable prefix first) | `adapters/prompt.ts` ordering; cache tokens in `routing/usage.ts` | U/adapters/prompt-agents.test.ts, U/routing/usage.test.ts "...cache hit ratio" | done |
| S8.20 | Do not repeat the spec in each worker | `adapters/prompt.ts:OPERATING_PROMPT` | U/adapters/prompt-agents.test.ts "...never the spec" | done |
| S8.21 | Role-specific output budgets | `routing.output_budgets`, `adapters/prompt.ts:outputBudgetInstruction`, `adapters/claude.ts` (`CLAUDE_CODE_MAX_OUTPUT_TOKENS`); Codex: instruction plus recorded limitation (no verified output-token key exists, checked against codex 0.153.4; guarded in U/adapters/codex.test.ts) | I/adapters/output-budget.test.ts "gives the implementer the table default, sets the cap variable...", "sends the role budget as the request max_tokens..." (real CLI) | done |
| S8.22 | Evidence references and hashes in handoffs | `adapters/prompt.ts:EvidenceRef` | U/adapters/prompt-agents.test.ts | done |
| S8.23 | Track input, output, cached tokens and cost per accepted run | `routing/usage.ts:recordUsage`, `summarizeUsage`, `cli/commands/report.ts` | U/routing/usage.test.ts, U/cli/inspect.test.ts "summarizes verified pass rate, attempts and cost over time" | done |
| S8.24 | One implementer; planner when needed; verifier after changes; reviewer after checks pass | `controller/states.ts`, steps | A/feature-and-repair.test.ts | done |
| S8.25 | Extra workers only for bounded independent units, weighing CPU, memory, browsers, rate limits, spend, context duplication, merge overhead | `AgentScheduler` (cores, memory, browser slots, rate limits, budget, context duplication, merge overhead as `mergeOverhead`) | U/scheduling/scheduler.test.ts "allows one Playwright run per core pair...", "charges a unit started beside another on the same revision...", "merge overhead" tests (G14), U/scheduling/work-units.test.ts | done |
| S8.26 | Good parallelism: separate check suites | `evidence/runner.ts:runCheckSet` concurrency | I/evidence/runner.test.ts "runs independent checks concurrently up to the limit" | done |
| S8.27 | Good parallelism: separate security and UI review, separable changes in isolated worktrees | `steps/reviewing.ts` (security and UI reviewers at once); `scheduling/work-units.ts` and `controller/parallel-writers.ts` (disjoint work units in their own worktrees, integrated serially; only with `agents.default_parallelism` of 2 or more and never in supervised mode) | I/controller/parallel-review.test.ts "starts the security and the UI review together...", I/controller/parallel-writers.test.ts "runs two disjoint work units at once in their own worktrees, integrates both serially and verifies one candidate", A/parallel.test.ts | done |
| S8.28 | Avoid shared-file edits, duplicate fixes, stale-revision reviews, speculative research | `AgentScheduler`; `scheduling/work-units.ts` (units come only from contract criteria with mapped files, and criteria whose paths may overlap stay in one unit, so two writers never attempt the same fix); Orbit has no research role, so no worker is spawned outside the plan | U/scheduling/scheduler.test.ts "serializes writers whose owned paths overlap...", "cancels reviews and verifications of a stale revision"; U/scheduling/work-units.test.ts "keeps criteria whose paths may overlap together, through globs and chains", "does not split when a criterion has no mapped file or there is only one criterion" | done |
| S8.29 | Every task has ownership, inputs, schema, dependencies, revision, cancellation, budget | `scheduling/types.ts:WorkUnit`, filled in `steps/implementing.ts` and `steps/reviewing.ts` | I/controller/parallel-review.test.ts "a new candidate cancels both running reviewers", U/scheduling/scheduler.test.ts "a new revision makes both parallel reviewers obsolete" | done |
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
| S10.3 | Modes and outputs: clarify, challenge, reconcile (authority map), diagnose, risk review (impact register), decision record | `types.ts:INQUISITION_MODES`, `engine.ts:authorityMap`, `engine.ts:runInquisition` records `inquisition/impact.ts:recordImpactRegister` for a risk-review | U/inquisition/engine.test.ts "ranks conflicting sources and flags ties", "records exactly one impact-register decision for a risk-review over an auth path, and none for a challenge", U/inquisition/impact.test.ts | done |
| S10.4 | Procedure: evidence, facts versus assumptions, interpretations, ranking, experiment, ask last | `engine.ts:runInquisition` | U/inquisition/engine.test.ts "accepts only an authorized experiment that tells interpretations apart" | done |
| S10.5 | Unattended: never wait on the keyboard; persist questions, continue independent work, or BLOCKED | `steps/inquisition.ts`, `gates.ts:completionGate` | A/ambiguity.test.ts "scenario 4: the blocked criterion keeps the run from success and delivery, and its question waits for a person" | done |
| S10.6 | Autonomous resolution rules | `inquisition/resolve.ts:classifyAmbiguity` | U/inquisition/resolve.test.ts "never guesses, even when a choice was named" | done |
| S10.7 | Question quality rules | `inquisition/questions.ts:validateQuestion` | U/inquisition/questions.test.ts | done |
| S10.8 | Ledger fields and statuses; no invented calibrated probabilities | `inquisition/ledger.ts`, `store.ts` | U/inquisition/ledger.test.ts "rejects missing fields and invented confidence values" | done |
| S10.9 | Interactive Inquisition | `skills/inquisition/SKILL.md` | I/plugin/plugin.test.ts "resolves every orbit command a skill names...", "never invents an inquisition command" | done |

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
| S12.6 | Reviewers run separately, read-only | `adapters/codex.ts:buildCodexArgv`, `isolation/profiles.ts:codexReviewerProfile` | U/adapters/codex.test.ts "builds the verified read-only review argv", "refuses --sandbox danger-full-access in every combination except the sandbox-runtime wrapper"; U/adapters/codex-tiers.test.ts; U/isolation/profiles.test.ts "codexReviewerProfile"; I/adapters/codex-os-sandbox.test.ts (real srt: checkout unwritable, other hosts refused) | done |
| S12.7 | No approval deadlock without removing the sandbox | `adapters/codex.ts`, `adapters/claude.ts` (`dontAsk`) | A/credentials-and-routing.test.ts "scenario 11" | done |
| S12.8 | Findings in the spec shape | `schemas/review-output.schema.json` | U/schemas/model-output-schemas.test.ts "matches the spec section 12 findings shape" | done |
| S12.9 | No majority vote | `review/resolve.ts` | U/review/resolve.test.ts "is not decided by how many reviewers approved" | done |
| S12.10 | Disagreements become testable claims, reproduced, Inquisition as needed | `review/resolve.ts`, `steps/reviewing.ts` | A/review-and-security.test.ts "scenario 16", I/review/flow.test.ts | done |
| S12.11 | Block unresolved high-impact findings | `review/resolve.ts:severityBlocks` | U/review/resolve.test.ts "critical blocks like high..." | done |
| S12.12 | Record why findings were accepted or rejected | `review/store.ts:persistResolution` | U/review/store.test.ts "writes statuses with reasons and blocking flags, then one decision per decided claim" | done |
| S12.13 | Accepted and waived findings reach the final report as residual risk | `controller/report.ts` | U/controller/report-findings.test.ts "lists unresolved accepted findings as blocking", "lists excepted findings with the exception reason and expiry" | done |
| S12.14 | Mandatory other provider unavailable: block, no silent substitute | `review/select.ts` | F/model-faults.test.ts "a mandatory independent reviewer that is missing blocks the run" | done |

## 13. UI testing

| ID | Requirement | Implementation | Tests | Status |
|---|---|---|---|---|
| S13.1 | Journeys and DOM assertions | `ui/runner.ts`, `templates/playwright` | I/ui/runner-journeys.test.ts | done |
| S13.2 | Responsive checks across viewports | `ui/runner.ts` coverage | I/ui/runner-safety.test.ts "records... the viewport", I/demo/example.test.ts "desktop and mobile" | done |
| S13.3 | Accessibility scans | `templates/playwright/orbit-fixtures.ts`, `ui/report.ts:parseA11y` | I/ui/runner-baselines.test.ts "fails only on the new serious violation" | done |
| S13.4 | Keyboard navigation checks | `templates/playwright/orbit-fixtures.ts` (`orbit-keyboard` attachment), `ui/report.ts:parseKeyboard` | I/ui/runner-keyboard-a11y.test.ts "fails when a positive tabindex puts the export button ahead of the filter", "fails when the focus indicator is removed" | done |
| S13.5 | Visual regression | `ui/runner.ts` baselines | I/ui/runner-baselines.test.ts "a real visual regression fails..." | done |
| S13.6 | Console and network failures | `ui/report.ts:parseDiagnostics` | I/ui/runner-safety.test.ts "records console errors, failed responses..." | done |
| S13.7 | Screenshots and traces | `ui/runner.ts:enforcedFlags` | U/ui/runner-units.test.ts "enforces the recording flags...", U/ui/brief.test.ts | done |
| S13.8 | UI config: required, environment, browsers, viewports, accessibility, visual | `policy/types.ts:UiConfig` | U/policy/config.test.ts "checks ui references and keeps auto-accept of baselines impossible" | done |
| S13.9 | UI config journeys with declarative steps | journeys are Playwright checks (`journey_check_ids`); deviation recorded in `docs/decisions/0004-ui-config.md` | U/ui/decision.test.ts "names what replaced the spec keys" | done |
| S13.10 | `accessibility.fail_on_new_serious_or_critical` honoured | `ui/runner.ts` (`ORBIT_A11Y_FAIL_ON`), `ui/report.ts:parseA11y` (advisory) | I/ui/runner-keyboard-a11y.test.ts "true: the new violation fails the journey", "false: the same violation is recorded as advisory and does not fail" | done |
| S13.11 | Visual baseline changes require review | `ui/runner.ts:229`, `evidence/report.ts` | A/ui.test.ts "scenario 18" | done |
| S13.12 | Artifact policy (screenshots on failure, retained traces, console, failed requests) | `ui/runner.ts:enforcedFlags` | U/ui/runner-units.test.ts | done |
| S13.13 | Deterministic journeys satisfy explicit criteria | `evidence/report.ts` | U/evidence/report.test.ts "supports a UI criterion from a passing journey" | done |
| S13.14 | Agent-driven exploration produces reproducible findings | `ui/explore.ts:exploreUi`, `controller/exploration.ts`, `agents/explorer.md` | I/ui/explore.test.ts "counts a finding only when its test fails on every run...", I/controller/exploration.test.ts "runs the explorer and the spec writer as read-only workers..." | done |
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
| S14.3 | Worker crash: preserve worktree, bounded restart | `recovery/reconcile.ts`, `steps/implementing.ts` (LOST worker under a live controller restarted in place) | F/worker-crash.test.ts "the worker dies under a live controller: it is detected LOST and restarted in the preserved worktree, without a duplicate" | done |
| S14.4 | Controller crash: recover lease, reconcile processes | `recovery/reconcile.ts:reconcileOnStart` | F/controller-crash.test.ts | done |
| S14.5 | Temporary provider failure: bounded backoff with jitter | `steps/common.ts:handleWorkerFailure` (`worker.retry` with `not_before`), `recovery/backoff.ts` | U/controller/retry-backoff.test.ts "two transient failures give two increasing, jittered waits within the ceiling...", I/controller/worker-retry.test.ts | done |
| S14.6 | Authentication failure: block | `steps/common.ts:blockOnAuth`, `controller/workers.ts` (auth failure checked before the spend charge) | F/model-faults.test.ts "an implementer whose credentials expire mid-run blocks the run...", A/credentials-and-routing.test.ts "scenario 12: an implementer whose credentials expire mid-run (401)..." | done |
| S14.7 | Malformed output: schema validation, bounded regeneration | `steps/common.ts:MAX_REGENERATIONS` | F/model-faults.test.ts "a planner that keeps returning malformed output..." | done |
| S14.8 | Timeout: diagnose performance or environment | `steps/diagnosing.ts` (timeout context, mandatory environment hypothesis, no raised timeout) | U/controller/diagnosing-timeout.test.ts "names the timed-out check, its baseline and the machine load, and makes an environment hypothesis mandatory" | done |
| S14.8a | A failure identical to the base revision's, with a sandbox or environment denial in its output, is not repaired (first live run: `listen EPERM`) | `evidence/environment-failure.ts:classifyEnvironmentFailure` (pure), `controller/environment-block.ts`, `steps/verifying.ts` (BLOCKED before DIAGNOSING; names the check, the cause and the two ways forward), `inquisition/baseline-exception.ts` (an approved exception stales a FAIL or INCOMPLETE report); checks may bind loopback: `local_binding` (default true) through `isolation/profiles.ts:profileForCheck` | U/evidence/environment-failure.test.ts, U/controller/environment-block.test.ts, I/controller/environment-failure.test.ts "the live sequence...", "a plain pre-existing code failure...", "approving the baseline exception...", U/inquisition/baseline-exception.test.ts "makes a report judged before the exception stale...", U/isolation/profiles.test.ts "lets a check listen on loopback by default...", I/evidence/runner-sandbox.int.test.ts "lets a check that may bind loopback listen...", "still denies the same bind..." | done |
| S14.8b | A mandatory check that could not execute at all (its process or the UI application killed by a crash signal before printing anything, or not startable) is an environment failure and is not repaired (second live run: the demo app aborted at start under `srt`) | `evidence/environment-failure.ts:classifyNotExecuted` (pure), `controller/environment-block.ts:checksNotExecutedFor`, `steps/verifying.ts` (BLOCKED before INQUISITION and DIAGNOSING), `ui/runner.ts` (`notExecuted` in `ui-result.json`); the app log is readable inside the sandbox: `isolation/types.ts:WrapOptions.stdioFiles`, `isolation/sandbox-runtime.ts:buildSrtSettings`, `ui/app-fixture.ts:startApp` | U/evidence/environment-failure.test.ts "classifyNotExecuted: ...", U/controller/environment-block.test.ts "checksNotExecutedFor: ...", U/ui/coverage-runner.test.ts "records that the application never ran...", I/controller/environment-failure.test.ts "the live sequence: the UI app aborts at start...", "a UI app that throws while loading...", "a command check whose process aborts before it runs...", U/isolation/sandbox-runtime.test.ts "re-allows reading a stdio file inside a denied region...", U/ui/app-fixture.test.ts "tells the provider about the log...", I/ui/app-fixture-srt-limits.test.ts "starts through the app fixture and becomes ready..." | done |
| S14.9 | Flaky check: bounded reruns, disclosed | `evidence/runner.ts` flaky_reruns | I/evidence/runner.test.ts "records a pass after a failure as flaky, never clean" | done |
| S14.10 | Lost action response: query remote before retry | `delivery/actions.ts:ActionLedger` | U/delivery/actions.test.ts "after an error, reconciles BEFORE retrying" | done |
| S14.11 | Conflict: rebase only if authorized; invalidate changed evidence | `steps/awaiting-ci.ts`: with `actions.rebase_task_branch` it rebases onto the moved base in an isolated checkout, invalidates evidence and reviews and goes back to VERIFYING (at most 3 rebases per run); a conflict or a missing permission blocks naming the paths and the key. Mergeability is the local `git merge-tree` check, not a host field | I/controller/base-conflict.test.ts "a delivered commit that conflicts with the moved base blocks with the conflicting paths", "with actions.rebase_task_branch a base that moved is rebased onto...", "with the permission, a base that moved into a conflict blocks...", "without the permission a base that moved cleanly still completes without any rebase", "a rebased candidate that then fails verification goes to DIAGNOSING and is never pushed" | done |
| S14.12 | Budget exhaustion: stop workers, keep artifacts, report | `steps/common.ts:finishRun` | F/budgets.test.ts "...with the failing evidence and the worktree preserved" | done |
| S14.13 | Self-healing cannot rewrite policy; recovery has a budget | `recovery/budget.ts` | U/recovery/budget.test.ts | done |

## 15. Delivery and CI

| ID | Requirement | Implementation | Tests | Status |
|---|---|---|---|---|
| S15.1 | Commit verified trees, push configured task branches only | `delivery/git.ts:pushBranch`, `assertTaskBranch` | I/delivery/git.test.ts "refuses the base branch, non-task branches and bad remotes" | done |
| S15.2 | Create or update one PR per run | `delivery/deliver.ts` | I/delivery/deliver.test.ts "delivers a repaired candidate as a fast-forward... and updates the same PR" | done |
| S15.3 | Observe CI, sanitized logs, repair within cycle limits | `delivery/ci.ts`, `steps/awaiting-ci.ts` | I/delivery/ci-flow.test.ts, F/injection.test.ts | done |
| S15.4 | Before every action: validate, persist intent, execute, receipt, reconcile | `delivery/actions.ts:ActionLedger.perform` | U/delivery/actions.test.ts "persists intent, executes and stores the receipt" | done |
| S15.5 | Opt-in merge with exact candidate, branch checks, review policy, no blockers; revalidate after changes | `delivery/release.ts:performRelease` (merge), `delivery/github.ts` (`--match-head-commit`), `steps/delivering.ts`; a ledgered `pr_ready` action marks a draft ready before the merge (`release.merge.mark_ready`) | I/delivery/release.test.ts "merges the exact reviewed commit after green branch checks...", "refuses the merge when the PR head moved off the reviewed commit...", "revalidates on every call...", I/controller/release.test.ts, I/delivery/release.test.ts "performRelease: a draft pull request (G48)", I/controller/release-deploy.test.ts "a draft pull request is marked ready, merged, and the merge commit is deployed..." | done |
| S15.6 | Deployment through a release profile with environment safeguards | `delivery/release.ts` (deploy: `release.environments`, allowed branches, hosts, green CI, action ledger; every defined environment deploys in profile order, skipped ones reported, unless the run names one with `orbit run --environment` (stored as `runs.environment` and `delivery.environment`, checked by `controller/gates.ts:intakeGate`, deployed alone and refused before the merge when undefined or not allowed for the branch); an UNKNOWN outcome is settled by `verify_command` or `orbit release resolve`) | I/delivery/release.test.ts "refuses an environment the profile does not name, a branch it does not allow, and a host the policy does not allow", "records a failed deploy and never re-runs it automatically", I/controller/release-deploy.test.ts (all tests, among them "a run that names its environment (orbit run --environment) deploys only that one", "a named environment the base branch is not allowed for blocks the release before the pull request is merged" and "a run that names an environment the release profile does not define is refused at intake"), U/cli/run-environment.test.ts, U/contract/release-environment.test.ts, U/delivery/coverage-release.test.ts "a named environment is refused before anything is merged (G50)", U/cli/release.test.ts "orbit release resolve" | done |

## 16. Observability

| ID | Requirement | Implementation | Tests | Status |
|---|---|---|---|---|
| S16.1 | Record every model choice | `controller/workers.ts:routeFor` (route decisions) | A/credentials-and-routing.test.ts "scenario 13" | done |
| S16.2 | Record agent spawn and cancellation | `storage/workers.ts:planWorker`, `requestWorkerCancel` | U/storage/workers.test.ts "writes a PLANNED row and a worker.planned event" | done |
| S16.3 | Record allowance extensions | `steps/diagnosing.ts:136` | A/proof-and-progress.test.ts "scenario 6" (deny path) | done |
| S16.4 | Record every policy denial | `controller/denials.ts` (guard-hook denials file, Claude `permission_denials`), `policy/scope.ts` | U/controller/denials.test.ts "reads guard-hook denials with their rule and target...", "records each denial once as a policy.deny decision..." | done |
| S16.5 | Record experiments | `inquisition/hypotheses.ts:recordExperiment` | U/inquisition/hypotheses.test.ts | done |
| S16.6 | Record provider disagreements | `review/resolve.ts` | A/review-and-security.test.ts "scenario 16" | done |
| S16.7 | Record evidence invalidations | `evidence/freshness.ts:invalidateEvidence` | U/evidence/freshness.test.ts "...logs one event" | done |
| S16.8 | Record state transitions | `run-store.ts:transition` | U/storage/run-store.test.ts | done |
| S16.9 | Record external-action reconciliations | `delivery/actions.ts` | U/delivery/actions.test.ts "records each reconciliation as a decision" | done |
| S16.10 | Metrics: verified pass rate, spend per accepted task, token and cache usage | `cli/commands/report.ts:learningReport`, `routing/usage.ts` | U/cli/inspect.test.ts "summarizes verified pass rate...", U/routing/usage.test.ts | done |
| S16.11 | Metrics: false-pass rate, escalation quality, duplicate failures, time-to-green, concurrency overhead, stale-evidence prevention, UI defects found | `observability/metrics.ts:metricsFor`, `cli/commands/stats.ts` | U/observability/metrics.test.ts (every metric), "prints every spec 16 metric as JSON, limited by --since, and as a table" | done |
| S16.12 | No sensitive content in logs | `core/log.ts`, `cli/io.ts` | U/core/log.test.ts "redacts the message and every string field", U/cli/io.test.ts | done |
| S16.13 | Missing usage measurements explicit | `routing/usage.ts`, `controller/report.ts` | U/controller/report.test.ts "states unmeasured spend instead of implying a number" | done |

## 17. Acceptance and fault testing

| ID | Requirement | Implementation | Tests | Status |
|---|---|---|---|---|
| S17.1 | Unit tests: contracts, policy, traversal, fingerprints, budgets, routing, scheduling, freshness, transitions, decisions, redaction, reconciliation | n/a | U/contract, U/policy, U/evidence, U/scheduling, U/routing, U/storage, U/core/redact.test.ts, U/delivery/actions.test.ts | done |
| S17.2 | Integration tests: plugin, hooks, worker launch, worktree isolation, SQLite recovery, checks, mock review, UI fixtures, mock delivery, service restart | n/a | I/plugin, I/cli/hook.test.ts, I/adapters, I/isolation, I/recovery, I/evidence, I/review, I/ui, I/delivery, I/controller/service-loop.test.ts; I/demo/example.test.ts (see S2.5) | done |
| S17.F1 | Fault: kill worker during edit | n/a | F/worker-crash.test.ts (both tests pass) | done |
| S17.F2 | Fault: kill controller mid-transition | n/a | F/controller-crash.test.ts | done |
| S17.F3 | Fault: lose PR response | n/a | F/delivery.test.ts "a lost pull request response is reconciled..." | done |
| S17.F4 | Fault: malformed output | n/a | F/model-faults.test.ts | done |
| S17.F5 | Fault: expired credentials | n/a | F/model-faults.test.ts (implementer and reviewer) | done |
| S17.F6 | Fault: exhausted budgets | n/a | F/budgets.test.ts | done |
| S17.F7 | Fault: prompt injection in logs | n/a | F/injection.test.ts | done |
| S17.F8 | Fault: indirect shell writes | n/a | F/policy-faults.test.ts | done |
| S17.F9 | Fault: policy edits | n/a | F/policy-faults.test.ts "a policy snapshot edited mid-run..." | done |
| S17.F10 | Fault: stale revision | n/a | F/delivery.test.ts "a candidate changed after review cannot be delivered" | done |
| S17.F11 | Fault: cancellation during checks | n/a | F/cancellation.test.ts | done |
| S17.F12 | Fault: unavailable reviewer | n/a | F/model-faults.test.ts "a mandatory independent reviewer that is missing..." | done |
| S17.F13 | Fault: resource saturation | n/a | F/saturation.test.ts (five tests, including two runs on one controller) | done |
| S17.M1 | Scenario 1: scoped feature passes with behaviour tests | n/a | A/feature-and-repair.test.ts "scenario 1" | done |
| S17.M2 | Scenario 2: reproducible regression repaired | n/a | A/feature-and-repair.test.ts "scenario 2" | done |
| S17.M3 | Scenario 3: reversible ambiguity resolved unattended | n/a | A/ambiguity.test.ts "scenario 3" | done |
| S17.M4 | Scenario 4: material ambiguity blocks affected work, independent work continues | n/a | A/ambiguity.test.ts (both scenario 4 tests) | done |
| S17.M5 | Scenario 5: weak tests rejected despite green | n/a | A/proof-and-progress.test.ts "scenario 5" | done |
| S17.M6 | Scenario 6: repeated non-progress terminates | n/a | A/proof-and-progress.test.ts "scenario 6" | done |
| S17.M7 | Scenario 7: restart does not duplicate workers or actions | n/a | A/restart-and-delivery.test.ts "scenario 7" (two tests) | done |
| S17.M8 | Scenario 8: lost PR response, one PR | n/a | A/restart-and-delivery.test.ts "scenario 8" | done |
| S17.M9 | Scenario 9: unauthorized protected changes rejected | n/a | A/policy-and-evidence.test.ts "scenario 9" | done |
| S17.M10 | Scenario 10: stale evidence cannot authorize delivery | n/a | A/policy-and-evidence.test.ts "scenario 10" | done |
| S17.M11 | Scenario 11: no permission-prompt deadlock | n/a | A/credentials-and-routing.test.ts "scenario 11" (real `claude`, ran here) | done |
| S17.M12 | Scenario 12: expired credentials give a truthful blocker | n/a | A/credentials-and-routing.test.ts (three scenario 12 tests) | done |
| S17.M13 | Scenario 13: simple work on a low-cost route | n/a | A/credentials-and-routing.test.ts "scenario 13" | done |
| S17.M14 | Scenario 14: escalation only with recorded justification | n/a | A/credentials-and-routing.test.ts (both scenario 14 tests) | done |
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
| S18.3 | Inquisition, repair briefs, non-progress detection | `inquisition/` | see S10 | done |
| S18.4 | Persistent execution and fault recovery | `controller/loop.ts`, `recovery/` | see S14 | done |
| S18.5 | Registry, token accounting, adaptive budgets, scheduling | `routing/`, `scheduling/` | see S8 | done |
| S18.6 | Codex review adapter and disagreement resolution | `adapters/codex.ts`, `review/` | see S12 | done |
| S18.7 | UI runner, accessibility, visual artifacts | `ui/` | see S13 | done |
| S18.8 | Delivery, CI repair, action reconciliation | `delivery/` | see S15 | done |
| S18.9 | Acceptance suite, docs, demo runs, security review | `tests/acceptance`, `docs/`, `examples/` | acceptance green; I/demo/example.test.ts and I/demo/mock-demo.test.ts pass; the live demo ran in part on 2026-10-05, see `docs/demos/2026-10-05/` (G39) | partial |
| S18.10 | Enforcement exists before autonomous delivery | `policy/`, `isolation/` | U/policy/*, I/isolation/* | done |

## 19. Definition of delivered

| ID | Requirement | Implementation | Tests | Status |
|---|---|---|---|---|
| S19.1 | Installs | `docs/installation.md`, `scripts/check-plugin.mjs` | I/plugin/plugin.test.ts "validates under --strict" | done |
| S19.2 | Loads | plugin, `dist/orbit.mjs` | I/plugin/plugin.test.ts "is current and starts with a node shebang" | done |
| S19.3 | Runs persistently | `controller/service.ts`, `controller/loop.ts` | I/controller/service-loop.test.ts | done |
| S19.4 | Completes the demo unattended | mock demo; live: simple and difficult SUCCEEDED, ui BLOCKED (`docs/demos/2026-10-05/`, G39) | I/demo/mock-demo.test.ts "simple: SUCCEEDED on a cheap route", A/demo-shapes.test.ts | partial |
| S19.5 | Commands use documented interfaces | `docs/interfaces/*` | U/adapters/claude-invocation.test.ts "builds the verified headless invocation" | done |
| S19.6 | State survives restart | `storage/`, `recovery/` | A/restart-and-delivery.test.ts | done |
| S19.7 | Policies enforced outside prompts | `policy/`, `isolation/` | F/policy-faults.test.ts | done |
| S19.8 | Evidence is candidate-bound | `evidence/` | U/evidence/freshness.test.ts | done |
| S19.9 | Inquisition works interactively and unattended | see S4.2, S10.5 | A/ambiguity.test.ts, I/plugin/plugin.test.ts | done |
| S19.10 | Review and delivery are reconciled | `review/stale.ts`, `delivery/actions.ts` | I/review/flow.test.ts, I/delivery/deliver.test.ts | done |
| S19.11 | Fault tests pass | `tests/fault-injection` | all pass, no `it.fails`; the flaky kill-order race in F/worker-crash.test.ts is fixed (G49) and the full suite passed at 4 and at 8 workers | done |
| S19.12 | No placeholder labelled functional | the skills call real commands; the impact register is recorded by the engine (S10.3) | I/plugin/plugin.test.ts "resolves every orbit command a skill names to a registered command", U/inquisition/engine.test.ts "records exactly one impact-register decision..." | done |
| S19.13 | Final report: outcome, goal, behaviour, criterion evidence, checks, decisions, assumptions, repairs, revision, branch, PR, budget, risks, blocker or next action | `controller/report.ts:buildFinalReport` | U/controller/report.test.ts "has every section spec section 19 asks for" | done |

## 20. Example user invocation

| ID | Requirement | Implementation | Tests | Status |
|---|---|---|---|---|
| S20.1 | `/orbit:run` with a natural-language goal and authority prose; authority comes only from policy | `contract/authority.ts:reconcileAuthority`, called by `contract/draft.ts:draftContract` (mismatch adjustments, needs-decision assumptions) | U/contract/authority.test.ts "records an authority-mismatch adjustment per claim and a needs-decision assumption for each excess" | done |

## 21. Compact worker operating prompt

| ID | Requirement | Implementation | Tests | Status |
|---|---|---|---|---|
| S21.1 | Workers get the compact operating prompt, role, bounded unit, contract, policy summary, candidate, evidence | `adapters/prompt.ts:OPERATING_PROMPT`, `steps/common.ts:policySummary` | U/adapters/prompt-agents.test.ts "starts with the compact operating prompt..." | done |
| S21.2 | Structured output with paths, evidence, findings, next action; never claim completion | `schemas/implementer-output.schema.json` | U/schemas/model-output-schemas.test.ts "gives the implementer no way to claim completion" | done |

## Security review 1

The first independent security review (`docs/decisions/0005-security-review-fixes.md`). Each fix ships with a test that failed on the code before it.

| Finding | Fix | Test |
|---|---|---|
| 1. Parallel integration wrote through symlinks (critical) | `controller/parallel-writers.ts`: per-unit tree checked with `inspectScope`, changes applied with `git apply --index`, integrated tree re-checked | U/controller/coverage-parallel-writers.test.ts "rejects a unit that adds a symlink leaving the repository, so a later unit cannot write through it" |
| 2. Lost lease did not fence external actions (high) | `delivery/actions.ts:markExecuting` checks the lease in the transaction that sets EXECUTING and records executor and deadline (`storage/schema.ts` migration 5) | U/delivery/actions.test.ts "a controller that lost its lease starts no action, and the new owner does not re-execute an in-flight attempt" |
| 3. Worker shell read credentials (high) | `steps/preflight.ts:gitCredentialProblems`, `isolation/util.ts:credentialFilesIn` into `isolation/profiles.ts`, `policy/bash.ts` reads denied by `policy/authorize.ts` (`bash.credential-read`); re-review: `policy/builtin.ts:credentialGlobsOf` feeds all layers, `node_modules` is walked, a walk over its cap refuses the profile | I/controller/preflight-credentials.test.ts, U/policy/bash-credential-reads.test.ts "protected credential globs from the policy", U/isolation/profiles.test.ts "credential files inside the worktree" and "credential enumeration covers the policy and node_modules, and fails closed" |
| 4. Worker output stored unredacted (high) | `adapters/shim.ts` redacts line by line before `log.jsonl` and `stderr.log`; re-review: `LineSink` drops a multi-line PEM private key block as one marker | U/adapters/coverage-entry-shim.test.ts "writes no credential to log.jsonl or stderr.log..." and "a multi-line private key block in provider output is persisted as one marker" |
| 5. Extra push URLs escaped authorization (high) | `delivery/git.ts` reads every push URL and refuses rewrites; `delivery/deliver.ts` pushes to the checked URL | I/delivery/deliver.test.ts "refuses a remote with a second push URL before pushing to either" |
| 6. Oversized files skipped the secret scan (high) | `controller/security.ts` streams large files in overlapping windows; unreadable or oversized files become a blocking `unscannable-file` finding that blocks whatever `block_severities` lists | I/controller/security.test.ts "files above the gitleaks input limit" (secret beyond the old 8 MiB capture) and "is incomplete and blocking whatever block_severities says" |
| 7. Approve-once widened the worker (high) | `controller/authorization.ts:runApprovedOperation` runs the approved command once in isolation; no grant policy | U/controller/approve-once-isolation.test.ts "an approved GET runs once in isolation as a recorded action, and a different POST by the retried worker never reaches the host" |
| 8. PR checks attributed to the wrong revision (medium) | `delivery/github.ts` reads check runs and status of the given commit and labels them with the reported SHA; re-review: every status page is read and the aggregate state and `total_count` keep a partial read from passing | U/delivery/github.test.ts "never reports another commit's green checks as the asked commit's" and "combined commit status pagination and aggregate state" |

## End-to-end test 1

Defects from the first end-to-end test of Orbit 0.1.0 (five testers, three live runs; P are product defects, D documentation). Each product fix ships with a test that failed on the code before it, except where the row says otherwise. P13, P14 and the Linux rows came in the second wave, with the integration pass that ran the CI steps on macOS and in a Linux container.

| Defect | Fix | Test |
|---|---|---|
| P1. Approved contract amendments never applied | `inquisition/amendment-answers.ts:applyAmendmentAnswers`, called by `cli/commands/decide.ts` and at every safe point (`steps/common.ts`) | I/controller/amendment-approval.test.ts "\"Approve\" applies the pending amendment to the run contract..." and "an approval recorded without being applied (an interrupted decide)..."; U/inquisition/amendment-answers.test.ts |
| P2. A verify PASS on checks that prove nothing | `evidence/report.ts`: a candidate tree equal to the base tree is INCOMPLETE, a criterion is unverified unless a check failed on the base revision or the candidate adds or changes a test; `controller/verification.ts` passes base tree, baseline and changed paths | U/evidence/report.test.ts "is INCOMPLETE, with no criterion supported, when the candidate tree is the base tree"; I/cli/verify-repair.test.ts "does not PASS a candidate whose tree is the base tree..." |
| P3. Resume replays the stored failure | `steps/obtain.ts:attemptStart` starts a fresh attempt after a resume, bounded by `recovery_attempts` | F/resume-after-fix.test.ts "a reviewer that failed twice blocks; after the fix, resume starts review attempt 3..." |
| P4. An accepted reviewer claim dead-ends in BLOCKED | `steps/reviewing.ts:settleInquiredClaims`: a claim the inquiry supports (ledger or a cited amendment) is accepted, one it refutes is rejected with the ledger evidence, any other stays pending and goes to a repair attempt that runs its discriminating test | I/controller/review-repair.test.ts "a medium claim the Inquisition accepts..."; U/controller/coverage-steps-reviewing.test.ts "a claim the inquiry supports in its ledger..." and "...rejects in its ledger on evidence..."; A/review-and-security.test.ts "scenario 16" |
| P5. Starter config fails the quickstart | `templates/config.yaml`: mode `autonomous`, delivery actions follow the mode | U/cli/e2e-fixes.test.ts "validates under every mode the quickstart names, with no hand editing" |
| P6. Doctor's review fix is wrong on a fresh setup | `cli/review-fix.ts` follows the selection's alternatives | U/cli/doctor-actionable.test.ts "with codex eligible but no model qualified, the fix is to refresh the catalog or name a model" |
| P7. SessionStart hook never prints | `orbit questions --pending [--quiet]`; the hook reports failures on stderr | I/plugin/plugin.test.ts "prints the open questions of a run at session start (P7)" |
| P8. Actionable text truncated | `cli/io.ts:flat`, no truncation in doctor, status, drive, verify, models | U/cli/doctor-actionable.test.ts "names the whole install command for a missing srt, in the fix and in the JSON" |
| P9. Plugin install runs `npm ci` of every devDependency | `plugin/package.json` pins srt only, with a lockfile; `scripts/check-plugin.mjs:payloadProblems` | I/plugin/plugin.test.ts "holds only the allowed files..." and "fails on a devDependency..." |
| P10. Plugin users have no init, doctor or `orbit` | `/orbit:init`, `/orbit:doctor`, `plugin/bin/orbit`, `core/invocation.ts:orbitHint` | I/plugin/plugin.test.ts "lists eight skills, init and doctor among them, and the seven agents (P10)"; U/cli/plugin-invocation.test.ts |
| P11. Skill flows leave runs idle or orphaned | skills check `service status`, then `--detach` or `--foreground` in the background; `resume --detach` | I/plugin/plugin.test.ts "check the service, then detach to it or drive in the background and say so" (written after the change) |
| P12. Config-caused blocks cannot be cleared by resume | `steps/common.ts:finishRun` tags frozen-policy blocks; `resume` exits 5 unless `--force` | U/controller/block-causes.test.ts; U/cli/control.test.ts "refuses with exit 5 and names a new run as the way forward; --force still resumes" |
| P15. Small budgets fail at admission; charges far above spend | `scheduling/budget.ts`: token-priced estimate, session ceiling at most half the cap and at least $1; `controller/workers.ts`, `steps/planning.ts` | U/scheduling/budget.test.ts "charges a token-priced estimate instead of the role ceiling..."; U/controller/coverage-workers.test.ts "charges an estimate priced from the reported tokens..." |
| P16. Resume after `kill -9` refused until the lease expires | `cli/commands/drive.ts:expireLeaseOfDeadOwner` | U/cli/drive-dead-owner.test.ts "proceeds when the owner is registered on this host and its process is gone" |
| P17. Block messages hide the real cause | `inquisition/repair.ts`, `steps/diagnosing.ts`, `contract/draft.ts`, `controller/report.ts` | U/inquisition/repair.test.ts "nonProgress names an attempt that changed nothing"; U/contract/draft.test.ts "a plan whose paths all fall outside the policy scope..."; U/controller/block-causes.test.ts "an EXHAUSTED non-progress stop is not reported as a spent budget" |
| P18. A baseline question even when the failing test is the goal | `steps/baseline-questions.ts`: withdrawn and recorded as `baseline.expected-to-flip` | I/controller/baseline-expected-flip.test.ts "asks no baseline exception question when the failing test is the goal..." |
| P19. Worktrees never removed | `controller/worktree-cleanup.ts` for SUCCEEDED and CANCELLED (unsaved edits snapshotted first); `gc --keep-days 0` | I/controller/worktree-cleanup.test.ts "a SUCCEEDED run leaves no worktree behind..." |
| P20. `orbit run` creates the run before preflight | `cli/admission.ts`: dirty tree, git credentials and (foreground) the environment gate before `createRun` | U/cli/e2e-fixes.test.ts "refuses a dirty working tree, creates no run and names the way out" |
| P21. `status` after init says to init | `cli/commands/status.ts`, `cli/context.ts` | U/cli/e2e-fixes.test.ts "says there are no runs yet instead of telling the user to run init again" |
| P22. Crash on a closed pipe | EPIPE handler in `cli/main.ts` | U/cli/epipe.test.ts "\"orbit help\" with its reader gone exits 0 and prints no stack" |
| P23. Service wording and stale controllers | `controller/service.ts`: uninstall polls launchd or reports `stopPending`; dead controllers marked stopped | U/controller/service.test.ts "polls until launchd no longer lists the job..." and "marks stopped the controllers of this host whose process is gone..."; U/cli/service.test.ts |
| P24. Default `allowed_paths` match nothing | doctor warns; `cli/layout.ts` derives paths at init | U/cli/doctor-actionable.test.ts "warns on scope in a repository laid out under src/..."; U/cli/e2e-fixes.test.ts "uses the top-level directories the repository tracks" |
| P25. Skill arguments unquoted | quoted here-documents, `orbit repair -`, run ids checked | I/plugin/plugin.test.ts "never puts $ARGUMENTS in a bash fence"; U/cli/plugin-invocation.test.ts "repair - reads the failure description from stdin..." |
| P26. A local commit reported as delivered | `controller/report.ts`: `delivered_commit` only from a real delivery | U/controller/coverage-report-build.test.ts "in a local mode, names the candidate commit as local and not delivered..." |
| P27. Verification and guidance problems | evidence paths relative to the run directory (`evidence/report.ts`, `cli/commands/verify.ts`); `models list` agrees with doctor | U/evidence/report.test.ts "gives artifacts and check logs as paths relative to the run directory..."; U/cli/e2e-fixes.test.ts "models list agrees with doctor..." |
| P28. Polish | `-v`, group help, `help nosuch` exit 2, did-you-mean, parse errors, `--policy`, no "(cancelling)" on finished runs | U/cli/e2e-fixes.test.ts "P28 and P27: command line polish" and "lists CANCELLED without \"(cancelling)\"..." (the last written after the fix) |
| P29. Output caps too small for a realistic goal | `policy/config.ts:DEFAULT_OUTPUT_BUDGETS` raised; one retry at double the cap up to 32000 (`controller/workers.ts`) | U/controller/output-cap-retry.test.ts "retries a planner that exceeded its output cap once with the cap doubled..." |
| P13. A read-only role with a bad key surfaced as a crash | `isolation/profiles.ts:readOnlyProfile` keeps the worktree readable, so the CLI reaches its first request and a bad key is `auth_failed`; a crash error carries the redacted stderr tail (`adapters/claude.ts`) | I/adapters/os-sandbox.test.ts "starts a read-only role inside srt: it reads its worktree, cannot write it, and a bad key is a credential failure"; I/adapters/claude-fake.test.ts "puts the CLI's stderr into the error of a run that ended without a transcript..." |
| P14. A Claude worker cannot read its own worktree under `~/.orbit` (macOS) | `adapters/claude-settings.ts`: `sandbox.filesystem.allowRead` for the worktree, temp dir and readable paths inside a deny | I/adapters/claude-sandbox-worktree.test.ts "runs node, npm and git in the worktree while credentials, the checkout and other runs stay unreadable" |
| P17(d). Login advice when an exported key overrides the login | `recovery/credentials.ts:authBlocker` says fix or unset the variable; callers pass the controller's host environment (`steps/common.ts:blockOnAuth`, `recovery/backoff.ts` `env`) | U/recovery/credentials.test.ts "does not suggest a login when an exported key overrides it..."; U/controller/coverage-steps-common.test.ts "advises from the controller's host environment, not the test process's..."; U/recovery/backoff.test.ts "decideRetry and retryWithBackoff advise unsetting a key exported in the given environment..." |
| P29 follow-up. Adapter tests pinned the old output caps | `claude-fake`, `codex-fake`, `output-budget` tests read `DEFAULT_OUTPUT_BUDGETS` | the five tests, which failed on the raised caps (test change only) |
| Service breaks after a plugin update | `controller/service.ts`: plist and unit start `~/.orbit/bin/orbit`, a private launcher every command repoints at the running bundle; `isolation/profiles.ts` refuses a provider directory that is, contains or sits inside the Orbit home | U/controller/service-launcher.test.ts "survives a plugin update: install from path A, run from path B..."; U/cli/service-launcher.test.ts "install from bundle A, then any command from bundle B..."; U/isolation/profiles.test.ts "refuses a provider config dir that is, contains or sits inside the Orbit home..." |
| Linux: UI checks never reached the application under srt | `ui/single-sandbox.ts` launcher, used when the provider says `privateLoopback` (srt on Linux; containers, with the image's `node`); exploration refuses up front (`ui/explore.ts`); doctor says so | U/ui/single-sandbox.test.ts "runs the application and the journeys in one wrapped launcher..." and "starts the launcher with the provider's own node..."; I/ui/ui-single-sandbox-srt.test.ts (Linux); I/ui/ui-single-container.test.ts (where the Playwright image is present); U/ui/coverage-explore.test.ts "does not start the application under a provider whose every sandbox has its own loopback..."; U/cli/doctor-browser-isolation.test.ts "on Linux names the one-sandbox mode..." |
| Linux: srt found by walking up from the bundle | `isolation/sandbox-runtime.ts:installBinDirs`: PATH, the plugin's own `node_modules/.bin`, then the development checkout's only | U/isolation/sandbox-runtime.test.ts "finds the development checkout's srt when the install directory is the checkout's plugin/..." and "ignores an srt planted in any directory above those two" |
| Linux CI: a bare native frame broke crash classification | `evidence/environment-failure.ts:TRACE_FRAME` | U/evidence/environment-failure.test.ts "accepts a native frame node cannot name, which is a bare address..." |
| CI as GitHub runs it (CI=true, Linux) | demo `playwright.config.ts` reporter `list`; acceptance labs record this platform's baselines first (`demo-shapes`, scenario 18 compares with the lab template); the gitlink test sets `diff.ignoreSubmodules` after its commit (git 2.39 refused it) | I/demo/example.test.ts "passes the browser journeys on desktop and mobile..." (failed with CI=true on macOS); A/demo-shapes.test.ts "demo 2" and A/ui.test.ts "scenario 18" (failed on Linux); I/policy/scope-adversarial.test.ts "sees a submodule pointer change..." (failed on git 2.39) |
| D1 to D11. Documentation | README, installation, configuration, operations, troubleshooting, security, architecture, learning, gaps, demos README, CHANGELOG; skills rewritten (D11) | D2 followed literally to a passing doctor and a started run; I/plugin/plugin.test.ts "does not contradict itself" (D11) |

## End-to-end test 2

Defects from the re-test of the first fix wave (NB are blockers, NM major, Nm minor). Each fix ships with a test that failed on the code before it, except where the row says otherwise; the integration pass then ran the CI steps on macOS and in a Linux arm64 container.

| Defect | Fix | Test |
|---|---|---|
| NB1. An open material question does not stop the review-repair loop | `steps/reviewing.ts` holds back findings on criteria an open material question blocks and blocks naming the question; a review repair that reproduces its tree stops (BLOCKED with a question open, else EXHAUSTED non-progress); `steps/common.ts:blockOnOpenQuestions` | A/review-open-question.test.ts "a finding on a criterion blocked by an open material question ends BLOCKED naming the question, after one attempt" (the second case written after the fix); I/controller/review-repair.test.ts (same-tree repair ends `non_progress`) |
| NB2. A session that failed before any model output is charged in full | `controller/workers.ts`: `failed`, `auth_failed` or `transient_error` with no tokens and no model output costs $0, event `budget.cost-zero-no-model`; `scheduling/budget.ts` prints dollars to the cent | U/controller/budget-honesty.test.ts "a failed session with no usage and an empty transcript is a measured zero, recorded as such"; F/budget-honesty.test.ts "NB2: on a $10 cap, two reviewer sessions that die before any model output cost nothing..." |
| NB3 (P15). Small caps cannot run an implementer | `routing/registry.ts` prices one overshooting request from the context the session cap pays for plus 200k tokens, at most the window; `controller/workers.ts:sessionSpendCap`, `unfundedSessionReason`; `steps/implementing.ts` names the shortfall | F/budget-honesty.test.ts "NB3: a $5 cap runs a Sonnet implementer to a verified result"; U/controller/budget-honesty.test.ts |
| NM1. A closed stdout pipe kills a foreground run | `cli/io.ts` hold while a run is driven; `cli/main.ts`, `commands/drive.ts` | I/cli/epipe-foreground.test.ts "keeps driving the run after stdout is closed, and Ctrl-C still pauses it cleanly"; U/cli/epipe.test.ts "keeps going while a run is being driven..." |
| NM2. Diagnosis workers cannot run Bash | `policy/role-grants.ts:bashGrant`; `experiments` on `TaskSpec` and `WorkerRequest`; `adapters/claude.ts`, `claude-settings.ts` deny writes to the worktree for experiment workers | U/policy/role-grants.test.ts; I/adapters/claude-experiments.test.ts "runs a test command and writes scratch files, but cannot write the worktree"; I/controller/diagnosis-experiments.test.ts |
| NM3. Delivery runs admitted without delivery credentials | `controller/delivery-env.ts`, shared by admission, doctor and preflight (`gates.ts`, `steps/preflight.ts`) | U/cli/admission-gaps.test.ts "names GH_TOKEN and the fix, creates no run, and calls no model"; U/controller/delivery-environment-gate.test.ts |
| NM4. Cheap admission gaps | `cli/admission.ts` refuses no commits, no checks, ui without Playwright; `evidence/git.ts:resolveCommit` says "no commits" | U/cli/admission-gaps.test.ts |
| NM5. Ctrl-C and resume advice leaves a run idle | `cli/commands/control.ts`: a bare resume with no live controller is refused with no state change (exit 7), or drives on a terminal; `context.ts`, `decide.ts`, `release.ts` name `--foreground` when no service runs | U/cli/resume-guidance.test.ts "refuses, changes nothing, and names the command that continues the run" |
| NM6. `models refresh` needed in every repository | `routing/shared-catalog.ts`: the catalog is saved under `ORBIT_HOME` and adopted for 7 days; `registry.ts`, `controller/start.ts` | I/cli/models-shared.test.ts "a refresh in repository A makes the Codex models available in repository B..."; U/routing/shared-catalog.test.ts |
| Nm1. Dead-owner leases block cancel, verify, repair | `cancel` and `withCliLease` reuse the dead-owner check | U/cli/dead-owner-leases.test.ts "cancel finishes the run at once" |
| Nm2. Service launcher never removed, repointed by any bundle | `controller/service.ts`: removed with the last definition; repointed only by the same bundle or a newer version | U/cli/service-launcher-owner.test.ts "install then uninstall leaves no launcher and says so" |
| Nm3. Stale controller state | `status` prunes dead controllers; a terminal run shows no heartbeat | U/cli/stale-state.test.ts "status prunes controllers whose process is gone..." |
| Nm4. `init` does not adapt | `cli/commands/init.ts`, `cli/layout.ts`: base branch from the checkout, flat-layout globs, a warning when nothing matches | U/cli/init-adapts.test.ts "writes the checked-out branch, not \"main\", in a master repository, and says so" |
| Nm5. `models list` contradicts doctor | REVIEW column (`cli/commands/models.ts`) | U/cli/models-review-column.test.ts |
| Nm6. Curator over its output cap | the cause was structured-output retries using the 3 turns: curator budget 8000 (`policy/config.ts`, `templates/config.yaml`), 6 turns and one retry at double the cap (`controller/report.ts`) | U/controller/curator-output.test.ts "gives the session enough turns for a tool call and two structured-output retries" |
| Nm7. Resume after a scope violation re-runs on the contaminated worktree | `steps/verifying.ts` resets the worktree to the last valid candidate or the base and writes a scope brief | I/controller/resume-after-violation.test.ts "restores the worktree before the next attempt..." |
| Nm8. Duplicate and miscounted questions | `inquisition/questions.ts` merges a reworded open question on the same criterion; `steps/planning.ts` counts earlier recovery attempts once | U/inquisition/questions.test.ts; U/controller/coverage-steps-obtain-planning.test.ts "counts recovery attempts spent before the budget existed, once... (Nm8)" |
| Nm9. `bin/orbit` gives raw errors without a usable Node | `plugin/bin/orbit` checks for Node >= 22.16 | I/cli/bin-orbit.test.ts "names the problem and the minimum when there is no node on PATH" |
| Nm10. Offline plugin install reports success | doctor names the missing `node_modules` and how to restore it; `docs/installation.md` | U/cli/doctor-offline-plugin.test.ts |
| Nm11. Outcome and verdict disagree | `inquisition/triggers.ts`: an optional criterion with no mapped check does not reject green | U/inquisition/triggers.test.ts "does not reject green over an optional criterion no check is mapped to... (Nm11)" |
| Nm12. Service run timed out starting srt under load | not changed: unconfirmed (one occurrence at load average 21) | none (watch) |
| P17 leftovers. EXHAUSTED always said "budget is spent" | `controller/report.ts` names each EXHAUSTED cause and lists unanswered material questions | U/controller/block-causes.test.ts |
| P27, P28 leftovers | repair and verify wording, no "CANCELLED (paused)", CREATED is not "already running", "nothing to resume" names a next step, YAML errors give line and column (`policy/config.ts`), the foreground footer prints `result:` | U/cli/guidance-leftovers.test.ts |
| Polish | `help help` describes help (`cli/cli.ts`); a negative number after a value option is that option's value (`cli/args.ts`); the not-a-repository error names `git init` (`cli/context.ts`); cancel does not repeat the state (`commands/control.ts`); question ids match without case (`commands/decide.ts`); plugin wording only with `CLAUDECODE=1` (`core/invocation.ts`); a block reason without a full stop is separated from "Resolve that" (`controller/report.ts`); a run pruned by gc is reported as such, not as a tampered policy (`controller/context.ts`); config errors name the given value and a near miss (`core/near-miss.ts`, `policy/config.ts`); the marketplace example has a `description`; "six skills" corrected | U/cli/polish.test.ts (all ten cases failed first); the marketplace example checked with `claude plugin validate --strict` before and after |
| macOS: cancelling a worker crashed on EPERM under load | `core/proc.ts:terminateGroup` waits for a group that refuses signals because only unreaped zombies remain (Darwin EPERM) instead of throwing | U/core/coverage-proc.test.ts "terminateGroup waits out a group that refuses signals with EPERM..." (seen as a full-suite failure of I/adapters/claude-real.test.ts) |
| Linux CI: plugin init test depended on git's default branch | the test creates its repository on `main` (init now adopts another checked-out branch, such as Linux git's `master`, by design: Nm4) | I/plugin/plugin.test.ts "runs init from the plugin layout..." (failed in the Linux container) |

## Counts

| Status | Earlier re-audit (before the fixer waves) | Previous version of this table | This audit |
|---|---|---|---|
| done | 341 | 356 | 356 |
| partial | 16 | 2 | 3 |
| missing | 1 | 0 | 0 |
| untested | 1 | 1 | 0 |
| total | 359 | 359 | 359 |

Every `done` row was confirmed in this audit. The live demo then ran in part
(2026-10-05), which moved S2.9 from `untested` to `partial`; the three non-done
rows (S2.9, S18.9, S19.4) now wait on the UI demo goal running live (G39). Rows that
are `done` but carry a hardening follow-up name it in `docs/gaps.md` (G24 for
S5.28, G53 for S8.21).

## Coverage

Measured with `npm run test:coverage` (vitest, then the per-file floor script; the configuration in
`vitest.config.ts`: v8 provider, `include: ['src/**']`, `reportOnFailure`,
thresholds lines 95, functions 95, statements 95, branches 90). The run exited
0 (after the security review fixes): 350 test files, 6476 tests passed, 1 skipped, none failing. 211 source
files are measured; the four excluded files hold only types.

| Metric | Covered | Enforced floor |
|---|---|---|
| Lines | 99.59% (20453 of 20536) | 95% |
| Functions | 99.65% (4297 of 4312) | 95% |
| Statements | 98.99% (25429 of 25686) | 95% |
| Branches | 96.18% (20785 of 21610) | 90% |

Lowest files per metric:

| Metric | Lowest files |
|---|---|
| Lines | `inquisition/impact.ts` 96.87%, `controller/verification.ts` 96.96%, `inquisition/resolve.ts` 97.22% |
| Functions | `controller/steps/awaiting-ci.ts` 95.00%, `inquisition/resolve.ts` 96.29%, `policy/weakening.ts` 96.96% |
| Statements | `routing/registry.ts` 94.70%, `adapters/claude-settings.ts` 96.00%, `controller/steps/implementing.ts` 96.10% |
| Branches | `review/stale.ts` 90.62%, `controller/steps/implementing.ts` 90.68%, `contract/draft.ts` 90.90% |

No file is under 80% lines (the per-file floor in `docs/testing-journal.md`),
and `npm run test:coverage` now enforces it (`scripts/check-coverage-floor.mjs`,
U/scripts/coverage-floor.test.ts). The code that
runs only in spawned processes (the CLI entry, the guard hook, the worker
shim) is now covered by in-process entry tests
(U/cli/coverage-entry-process.test.ts, U/adapters/coverage-entry-main.test.ts,
U/adapters/coverage-entry-shim.test.ts) instead of being invisible to v8.
`src/` contains no coverage-ignore comment.
