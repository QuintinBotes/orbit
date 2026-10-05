# Gaps against the spec

Every row of `docs/traceability.md` that is not done, grouped by module. Each
gap is listed once, with the requirement ids it covers. The many partial rows
in spec sections 1, 18 and 19 roll up to the gaps below.

Severity:

- **blocker**: the stated goal ("implemented fully as per the spec and 100%
  tested, with all feedback and findings addressed") cannot be claimed while it
  is open. This covers an open `it.fails` defect, a mandatory scenario or fault
  test, a definition-of-delivered item, a broken user-facing command, a
  security setting that is silently ignored, and any runtime behaviour with no test.
- **should**: a spec requirement that is missing or partial while the core loop
  still works.
- **nice**: conformance or hygiene with little behavioural effect.

Blockers: 11. Should: 21. Nice: 12.

## Plugin skills and CLI

### G1. `/orbit:verify` and `/orbit:repair` call commands that do not exist (blocker)

Covers S4.3, S4.4, S19.12, S3.1. `skills/verify/SKILL.md` runs
`orbit verify $ARGUMENTS` and `skills/repair/SKILL.md` runs `orbit repair
$ARGUMENTS`. Both exit 2 with `unknown command`, but the skills present them as
working.

Fix (the shape of the commands is a product decision; this is the minimal one
that fits the skill text):

- Add `orbit verify [run-id]` in `src/cli/commands/verify.ts` and register it in
  `src/cli/cli.ts:COMMANDS`.
  - With no id, it uses the newest run (`listRuns`).
  - Take a short CLI lease with `withCliLease`, and refuse when a live controller
    owns the run.
  - Run `evidence/runner.ts:runChecks` for the run's latest candidate and the
    contract's `required_check_ids`, under the frozen snapshot.
  - Build the report with `evidence/report.ts:buildEvidenceReport` and
    `evaluateEvidence`. Print one line per criterion (supported, unsupported,
    unverified) with its artifact paths.
  - Exit 0 on PASS. Add exit codes for FAIL and INCOMPLETE to `cli/exit.ts`.
  - Never move the run's state.
- Add `orbit repair <run-id | text>`.
  - Given a run id whose latest evidence is FAIL and whose state is BLOCKED or
    paused: take the CLI lease, transition to DIAGNOSING (the BLOCKED to
    DIAGNOSING edge exists), and hand off as `resumeCommand` does. Print the
    failure fingerprint and the brief path.
  - Given anything else: behave as `orbit run --goal "Repair: <text>"`.
- Tests:
  - U/cli: argument handling.
  - I/cli: verify prints criterion verdicts on a lab run. Repair moves a failed
    BLOCKED run to DIAGNOSING and the controller completes it.
  - I/plugin/plugin.test.ts: every `dist/orbit.mjs <command>` named in
    `skills/*/SKILL.md` must resolve in `COMMANDS`.

### G2. `/orbit:inquisition` is broken, so interactive Inquisition does not work (blocker)

Covers S4.2, S10.9, S19.9.

- The skill runs `orbit inquisition $ARGUMENTS`, which does not exist.
- It runs `orbit decide <question-id> ...`, but `cli/commands/decide.ts` takes
  `decide <run-id> <question-id> <answer...>`.

Fix:

- Change the decide line to `decide <run-id> <question-id> "<answer>"`, and
  list the questions with `orbit questions <run-id>`.
- For the case with no run, either drop the `orbit inquisition` call and keep the
  grill conversational (the skill already says how), or add
  `orbit inquisition <goal-or-plan>`. That command would draft a contract with
  `contract/draft.ts`, run `inquisition/triggers.ts:detectTriggers` and print the
  triggers and suggested questions, without creating a run.
- Covered by the plugin command-resolution test from G1.

### G3. Status skill names states that do not exist (nice)

Covers S4.5. `skills/status/SKILL.md` gives RUNNING, DONE and FAILED as example
states. Use the real states: VERIFYING, BLOCKED, SUCCEEDED, EXHAUSTED and so on.

### G4. Native `/goal` integration (should)

Covers S4.27. Nothing uses `/goal`.

- Add an optional step to `skills/run/SKILL.md`: after a supervised submit, when
  `/goal` is available, set it to the run's objective plus
  "evidence: `orbit status <run-id>` reports SUCCEEDED".
- State in the skill that the controller's completion gate stays the authority.
- Document it in `docs/operations.md`. A text test in plugin.test.ts is enough.

### G5. Authority written in the goal is not reconciled with the policy (nice)

Covers S20.1. Goal prose such as "use autonomous-delivery" or "do not merge" is
plain goal text, and a mismatch with the policy is never surfaced.

- In `steps/contracting.ts`, run `inquisition/heuristics.ts` and a small mode
  matcher over the goal.
- Record a `goal.authority-mismatch` decision, and add a clarify trigger when the
  goal asks for more than the policy allows.
- Unit test the matcher.

## Controller

### G6. A criterion blocked by the Inquisition does not stop success or delivery (blocker)

Covers S5.23, S10.5, S17.M4. This is the defect behind
A/ambiguity.test.ts "scenario 4: the blocked criterion keeps the run from
success..." (it.fails). After a continue-partial disposition,
`steps/inquisition.ts:~127` resumes. `gates.ts:completionGate` (about line 358)
never looks at open material questions, so the run delivers and SUCCEEDS.

Fix:

- In `completionGate`, add a reason for each criterion in
  `inquisition/questions.ts:criteriaBlockedByQuestions(db, runId)`.
- In `steps/delivering.ts` (before `deliver`) and `steps/reviewing.ts` (before
  moving to DELIVERING), BLOCK with the open question ids.
- Make sure the continue-partial path persists the question it names
  (`persistQuestion`), so `orbit questions` shows it.
- Add unit tests for `completionGate`, which has none today: blocked criterion,
  stale evidence, missing APPROVE, delivered tree mismatch.
- Flip the acceptance test to `it`.

### G7. An authentication failure ends EXHAUSTED instead of BLOCKED (blocker)

Covers S14.6, S2.14, S17.F5, S17.M12. This is the defect behind
F/model-faults.test.ts "an implementer whose credentials expire mid-run..." and
A/credentials-and-routing.test.ts "scenario 12: an implementer whose credentials
expire mid-run (401)..." (both it.fails). `controller/workers.ts:~132`
(`accountFinished`) charges the unreported cost of an auth-failed session at its
ceiling before `blockOnAuth` runs, so `BUDGET_EXHAUSTED` wins.

Fix:

- In `accountWorker` or `accountFinished`, when the result status is
  `auth_failed` and the transcript has a result line with `total_cost_usd` 0 and
  empty `modelUsage`, or no assistant message, record usage as measured zero.
- Otherwise charge as now, but call `blockOnAuth` before the charge can throw.
  Also catch `BUDGET_EXHAUSTED` from that charge when the status is
  `auth_failed`, and block instead.
- Flip both tests to `it`.

### G8. A worker that dies under a live controller is not restarted (blocker)

Covers S14.3, S17.F1, S2.4, S1.11. This is the defect behind
F/worker-crash.test.ts "the worker dies under a live controller..." (it.fails).
`steps/implementing.ts:132-147` treats a LOST implementer as a finished attempt
and charges its unreported cost at the session ceiling, which exhausts the run.

Fix: when `collectIfFinished` sees a LOST implementer, use the same path as
reconciliation.

- `recovery/reconcile.ts` logic, `decideRetry` with `classifyFailure({ status: 'lost' })`.
- `storage/workers.ts:planWorkerRestart` in the preserved worktree.
- Spend one `recovery_attempts`.
- Charge only measured usage, or the role ceiling. Never charge the full session
  cap twice.

Flip the test to `it`.

### G9. The resource probe is applied per run, not per controller (blocker)

Covers S6.19, S17.F13, S1.8, S18.5. This is the defect behind
F/saturation.test.ts "with memory saturated, a controller owning two runs never
has more than one implementer running" (it.fails). `steps/implementing.ts:87`
builds the scheduler's running set from `listActiveWorkers(ctx.db, ctx.run.id)`.

Fix:

- Build the running set from all active workers of this repository's database
  (`listActiveWorkers(ctx.db)` without a run filter), so the
  `AgentScheduler.capacity` probe counts every running implementer.
- Keep `WAIT` (not EXHAUSTED) for capacity deferrals.
- Flip the test to `it`.

### G10. Untested terminal paths: dirty start, IMPOSSIBLE, unavailable mandatory verification (blocker)

Covers S6.4, S6.16, S7.13, S7.14. The code exists but no test asserts it.

- **Dirty start** (`steps/preflight.ts:49`). Add an I/controller test: an
  uncommitted file with `allow_dirty_start: false` ends BLOCKED naming the path,
  and with `true` the run proceeds.
- **IMPOSSIBLE** (`steps/diagnosing.ts:105`). Script a diagnosis whose every
  hypothesis is eliminated by recorded experiments and where no authorized
  experiment remains. Assert IMPOSSIBLE, the outcome hypotheses, the final report
  and the CLI exit code 12.
- **Mandatory verification unavailable** (`steps/verifying.ts:144`). Use a
  mandatory check whose command cannot start (ERROR, so the verdict is
  INCOMPLETE) with no trigger. Assert BLOCKED with the reason text.

### G11. Implementer escalated after a single failure (blocker, decision needed)

Covers S8.4, S17.M14, S1.6. This is the defect behind
A/credentials-and-routing.test.ts "scenario 14: the implementer is not escalated
on a single localized failure" (it.fails). The router escalates Sonnet to Opus
on `strong-attempt-failed` after one failed attempt. `docs/architecture.md`
("Token efficiency") allows that only after repeated equivalent failures.

Fix, choosing one:

- Gate the `strong-attempt-failed` signal in `routing/router.ts` for `routine-code`
  on `repeatedFingerprints >= repeated_failure_threshold`.
- Or amend the architecture table and delete the it.fails test.

The spec allows escalation on "difficult causal failures", so this needs a
decision.

### G12. Routing back down after the diagnosis is solved is not wired (should)

Covers S8.13. `routing/router.ts` honours `diagnosisSolved`, but
`steps/implementing.ts:routeSignals` never sets it.

- Set it when the previous route escalated, the latest attempt's fingerprint is
  gone from the latest evidence, and no equivalent failure repeated since
  (`inquisition/repair.ts:progressSince` shows a fixed mandatory check or
  localized fault).
- Also pass `criticalSecurity` from the planning assessment.
- Add an I/controller test: escalated attempt 2 fixes the fault, and the
  follow-up attempt routes back to Sonnet with the superseded property recorded.

### G13. Worker transient failures are retried without backoff (should)

Covers S14.5. `steps/common.ts:handleWorkerFailure` returns `retry: true` and
the worker is respawned on the next tick. `recovery/backoff.ts:retryWithBackoff`
and `backoffDelayMs` are unused by the controller.

- Record a `worker.retry` event with `not_before = now + backoffDelayMs(attempt)`.
- Make `obtain` and `ensureWorker` return `WAIT` until then.
- Honour a `retry-after` hint from the classification.
- Test with a ManualClock: two transient failures give two increasing, jittered
  waits within the ceiling.

### G14. Within-run parallel units are never scheduled (should)

Covers S8.25, S8.27, S8.29. The controller runs one writer per run, and
`AgentScheduler` is used only for admission.

- Let REVIEWING start the security review and the UI review as separate
  read-only units at once, with `cancelWhen: ['revision-changed']` and the
  candidate as `revision`.
- Add browser capacity (one Playwright run per core pair) and a
  context-duplication cost to `scheduling/scheduler.ts` admission.
- Fill `WorkUnit.revision`, `cancelWhen` and `budget` from the route and the
  spend cap.
- Test: two reviewers start together, and a new candidate cancels both.

### G15. Supervised mode never asks to authorize an action (should)

Covers S5.2. A denied action is only denied.

- In supervised mode, a delivery or dependency action the policy does not
  authorize should persist a question with `kind: 'authorization'`, options
  approve-once or deny, and the operation in its data, then BLOCK.
- An answer of approve-once from a human (`isHumanActor`) authorizes that one
  operation for that candidate, recorded as a decision and re-checked by
  `authorize` with an explicit one-shot grant. It never widens the snapshot.
- Unit and integration tests.

### G16. Release mode has no release actions: merge and deploy are missing (should)

Covers S5.5, S15.5, S15.6, S18.8.

- Add a `merge` action kind to `delivery/actions.ts` and a `mergePullRequest` to
  `GitHubClient` (`gh pr merge --match-head-commit <sha>`; the fake mirrors it).
- Call it from `steps/awaiting-ci.ts` after green CI, only when
  `authorize(merge)` allows it, the mode is release, and `contract.delivery.merge`
  is true.
- Before merging, re-check the completion gate, the exact head sha, the required
  branch checks, the review gate and the open blockers. Reconcile a lost response
  by reading the PR state.
- Deployment: define a `release.deploy` profile (command id from trusted checks,
  environment name, approval requirement) and run it as an action with
  intent/receipt. Refuse it unless the profile names the environment.
- Tests: merge happy path, merge refused on stale head, lost merge response
  reconciled.

### G17. Policy denials inside workers are not recorded (should)

Covers S16.4, S7.12. Only scope inspection writes `policy.deny` decisions.

- Record guard-hook denials and Claude `permission_denials` as `policy.deny`
  decisions with rule and target. The hook can append to a worker-dir denials
  file that the controller ingests on collect. `claude-transcript.ts` already
  parses `permission_denials`.
- This feeds the scope_pressure trigger and spec 16.
- Test: a worker that tries a protected edit three times raises scope_pressure.

### G18. Inquisitor task environment refused by every adapter (should)

This is the fix-controller finding. `inquisition/engine.ts:378` puts
`ORBIT_POLICY_PATH`, `ORBIT_POLICY_HASH` and `ORBIT_WORKTREE` in `spec.env`,
which every adapter refuses. `steps/inquisition.ts:guardEnvAdapter` strips them
as a workaround.

- Pass `policyHash` on the TaskSpec and leave `env` empty in the engine.
- Update U/inquisition/engine.test.ts:237 to expect `env: {}` and the
  `policyHash`.
- Delete `guardEnvAdapter`.

### G19. `controller/gates.ts:deliveryGate` is dead code (nice)

Delivery uses `delivery/gate.ts` directly. Either call `deliveryGate` from
`steps/delivering.ts` and record it with `recordGate`, which gives a full gate
trail, or delete it.

## Policy and security

### G20. `retention.redact_patterns` is validated but never applied (blocker)

Covers S3.28. `core/redact.ts:createRedactor` accepts `patterns`, but no caller
passes `config.retention.redact_patterns`. A user's custom secret patterns
silently do nothing.

- Build one redactor per run from the snapshot in `controller/context.ts`.
- Thread it through `core/log.ts:createLogger`, `adapters/prompt.ts`,
  `review/packet.ts`, `delivery/ci.ts:sanitizeLog`, `evidence/runner.ts` (log and
  excerpt) and `controller/report.ts`.
- Test: a custom pattern is redacted from the controller log, a worker prompt, a
  review packet and final.md.

### G21. `retention.keep_runs_days` is never applied (should)

Covers S3.27.

- Add `orbit gc` (and a daily pass in the service loop) that deletes
  `.orbit/runs/<id>/` and worktrees of terminal runs older than `keep_runs_days`.
- Keep the SQLite rows and mark them `artifacts_pruned`.
- Never touch BLOCKED runs.
- Unit test with a ManualClock.

### G22. No vulnerability or license policy at the baseline gate (should)

Covers S5.13.

- Add policy `dependencies.audit` (command id from trusted checks, for example
  `npm audit --json`) and `dependencies.license_allowlist`.
- Run them in `evidence/baseline.ts` on the base and on the candidate when the
  lockfile or manifest changes.
- `baselineGate` blocks on new findings at or above a configured severity.
- Tests with a fake audit JSON.

### G23. Scanner findings have no severity or exception rules (should)

Covers S5.18, S5.38.

- Give secret-scan findings and SAST output a severity (gitleaks rule to
  severity map, SARIF `level`).
- Reuse `review/resolve.ts:matchException` with `review.security.exceptions`
  scoped to `source: scan`.
- `staticSecurityGate` blocks at the configured severities and reports the rest
  as advisory.
- Tests: an excepted gitleaks rule passes with its reason recorded, and an
  unexcepted one blocks.

### G24. The default isolation does not limit CPU, memory or processes (should)

Covers S5.28. `sandbox-runtime` covers filesystem and network only. The
limitation is disclosed but nothing enforces it.

- On Linux, wrap srt commands in `systemd-run --user --scope -p MemoryMax= -p
  CPUQuota= -p TasksMax=` when available.
- On macOS, apply `ulimit -u` and `-v` in the shim.
- Otherwise state the limitation in the environment gate notes (already done),
  and refuse when the policy sets `isolation.require_resource_limits: true`.
- Test the argv construction, plus an int test on Linux.

### G25. Engineering practices are not selected or justified (should)

Covers S5.40.

- Add `practices: [{ practice, applicable, justification }]` to
  `schemas/planner-output.schema.json`, using the nine spec practices as an
  enum.
- Store it in the contract.
- Have `review/packet.ts` include it, and add a reviewer question to reject
  unjustified omissions.
- Schema test, plus an I/review packet test.

### G26. Config keys parsed but never read (nice)

Covers S5.8. `agents.isolate_writers`, `agents.prohibit_shared_worktree_writes`,
`agents.require_independent_work_units`, `actions.change_secrets` and
`actions.change_permissions` have no effect. The behaviour is hard-coded safe.

- Either make `policy/config.ts` reject `false` for the first three (they cannot
  be turned off) and document the last two as reserved,
- or read them: the scheduler for the first three, `authorize` for secret and
  permission paths and `chmod`-class commands.

## Contract

### G27. A baseline exception cannot be added to a contract (should)

Covers S6.6. `evidence/report.ts` honours `baseline_exceptions`, but neither
`contract/draft.ts`, an amendment op nor the CLI can add one, so a repository
with a pre-existing mandatory failure can never be green.

- Add an amendment op `accept_baseline_failure { check_id, fingerprint, reason }`.
  It always needs human approval, and the fingerprint must equal the recorded
  baseline failure.
- Let preflight raise a decision-record question when a required check fails on
  the base.
- Tests in U/contract/amend.test.ts and an I/controller run.

## Routing and tokens

### G28. No role-specific output budgets (should)

Covers S8.21, S1.7. The architecture table (1k, 2k, 3k and 4k tokens) is not
enforced.

- Add `ROLE_OUTPUT_TOKENS` in `adapters/prompt.ts`.
- Pass it as `CLAUDE_CODE_MAX_OUTPUT_TOKENS` in the worker env (verify the name
  in `docs/interfaces/claude-headless-and-sandbox.md` first), and as the matching
  Codex config.
- Charge the admission estimate from it.
- Test the argv and env.

### G29. Registry latency is never measured (nice)

Covers S8.1. `model_registry.latency_ms` is always null.

- Record a rolling median of time-to-first-event per model from worker logs in
  `routing/usage.ts:recordUsage`, and write it through `ModelRegistry`.
- Unit test.

## Inquisition

### G30. Mode outputs are not all produced as records (nice)

Covers S10.3. Risk review has no impact register.

- On risk-review, write an `inquisition.impact-register` decision listing
  category, affected paths, reversibility and the authorization needed (from
  `authorizationIds`).
- Engine unit test.

## Review and report

### G31. Accepted and waived findings are left out of the final report's risks (should)

Covers S12.13, S1.12. This is the fix-controller finding.
`controller/report.ts:125` lists only advisory, open and claim_pending findings.

- Also list `accepted` findings that are still unresolved (blocking) and
  `excepted` findings, with the exception reason and expiry.
- Extend U/controller/report.test.ts.

## UI

### G32. No keyboard navigation checks (should)

Covers S13.4, S1.10.

- Add `expectKeyboardReachable(page, selectors)` to
  `templates/playwright/orbit-fixtures.ts`. It tabs through and asserts focus
  order and a visible focus ring, and emits an `orbit-keyboard` attachment.
- Parse it in `ui/report.ts` and report it in the UI binding.
- Use it in the demo app journey and in `tests/fixtures/ui-app`.
- Add a runner test with a fixture defect that breaks tab order.

### G33. No agent-driven UI exploration (should)

Covers S13.14.

- Add an optional `ui.exploration` read-only worker role. It gets the base URL
  through the app fixture and returns findings with reproduction steps.
- Each finding becomes a failing Playwright spec that the implementer must make
  pass. Findings never count as acceptance evidence.
- Schema, runner and I/ui tests.

### G34. UI config shape differs from the spec, and the decision is not recorded (nice)

Covers S13.9, S3.21. The spec's declarative `journeys[].steps` and `artifacts:`
block became `journey_check_ids` and enforced flags. Write
`docs/decisions/0004-ui-journeys-as-playwright-checks.md` with the reasons.

### G35. `accessibility.fail_on_new_serious_or_critical` has no effect (nice)

Covers S13.10.

- Pass it to the fixture as `ORBIT_A11Y_FAIL_ON` (`serious,critical` or `none`).
  With `false`, record violations as advisory instead of failing.
- Test both settings.

## Recovery

### G36. Timeouts are not diagnosed as performance or environment issues (nice)

Covers S14.8.

- When the failing check status is TIMEOUT, add a mandatory
  environment/performance hypothesis to the diagnosis prompt and brief
  (machine load from the scheduler probe, duration against baseline duration).
- Forbid a raised timeout as the scoped fix (weakening already flags it).
- Unit test in `steps/diagnosing` or `inquisition/repair`.

### G37. No conflict or rebase handling (should)

Covers S14.11.

- Detect a moved base branch in AWAITING_CI (PR `mergeable: CONFLICTING`) and
  on a refused fast-forward.
- When `actions.rebase_task_branch` is authorized, rebase the candidate onto the
  new base in the worktree, snapshot a new candidate (which invalidates evidence)
  and re-verify. Otherwise BLOCK with the conflict.
- Tests with FakeGitHub mergeability.

## Observability

### G38. Spec 16 metrics are missing (should)

Covers S16.11. False-pass rate (PASS evidence later refused by review),
escalation quality (escalated attempts that fixed the fingerprint), duplicate
failures, time-to-green, concurrency overhead (wait time from WAIT events),
stale-evidence preventions (refused deliveries) and UI defects found.

- Compute them in a `metricsFor(db, window)` in `controller/report.ts`.
- Print them in `orbit report --learning` and `--json`.
- Unit tests with seeded events.

## Demo and test infrastructure

### G39. The live demo has never run (should)

Covers S2.9, S19.4, S18.9. Only the mock demo runs. This needs real Anthropic
and Codex credentials and a private GitHub repository.

- Run `scripts/demo/run-live-demo.sh --repo <owner>/<private-repo>` and commit
  the three final reports (redacted) under `examples/demo-app/reports/`.
- Until then, label the live demo unverified in `README.md` with that exact
  command.

### G40. No coverage measurement (blocker)

"100% tested" cannot be shown. `@vitest/coverage-v8` is not installed.

- Add it as a dev dependency.
- Configure `coverage.include: ['src/**']` and `exclude` for the barrels
  `*/index.ts` and the entry points `adapters/{hook,shim}-main.ts`.
- Set thresholds after a first run, then raise them.
- Add `npm run test:coverage` to CI.

### G41. Stale "KNOWN DEFECT" comment in a passing test (nice)

`tests/unit/core/hash.test.ts:53` says to flip the test to `it` once fixed. It
already is `it` and passes. Delete the comment.

### G42. Acceptance suite not fully green (blocker, rolls up)

Covers S2.17, S18.9, S19.11. There are 3 acceptance and 3 fault it.fails. They
close with G6, G7, G8, G9 and G11. After that, remove every `it.fails` and the
DEFECT rows in `tests/acceptance/README.md`.

### G43. Manifest text differs from the spec example (nice)

`.claude-plugin/plugin.json` uses a different description and keywords
(`evidence, agents, workflow, inquisition` against `claude-code,
self-healing, engineering`). Align the keywords, or note why in the 0001
decision.

### G44. No test asserts a granted allowance extension inside a run (nice)

S7.5 and S16.3 are proven at unit level and on the denial path only.

- Add an I/controller test: attempt 1 fails, the diagnosis names a new
  hypothesis and localizes the fault, and `allowance.extend` is recorded with
  `new_allowance = previous + 1`.
