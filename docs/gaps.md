# Gaps against the spec

What is still not done after the re-audit of 2026-10-05 (see
`docs/traceability.md`). Each gap is listed once, with the requirement ids it
covers. Gap ids carry over from the previous audit where the gap is the same;
new ids start at G45. A gap closed in this wave is not listed; its rows are
`done` in the traceability table with the test that proves it.

Severity:

- **blocker**: the stated goal ("implemented fully as per the spec and 100%
  tested, with all feedback and findings addressed") cannot be claimed while it
  is open. This covers a failing test, a mandatory scenario or fault test, a
  definition-of-delivered item, a broken user-facing command, a security
  setting that is silently ignored, and any runtime behaviour with no test.
- **should**: a spec requirement that is missing or partial while the core loop
  still works.
- **nice**: conformance or hygiene with little behavioural effect.

Blockers: 5. Should: 9. Nice: 6.

## Blockers

### G45. The full suite is red: the demo app carries an old Playwright fixtures template (blocker)

Covers S2.5, S17.2, S18.9. I/demo/example.test.ts "copies Orbit's Playwright
fixtures template unchanged" fails. The keyboard-navigation work (former G32)
added `expectKeyboardReachable` and the `orbit-keyboard` attachment to
`templates/playwright/orbit-fixtures.ts`, but
`examples/demo-app/tests/e2e/orbit-fixtures.ts` was not updated.

- Copy `templates/playwright/orbit-fixtures.ts` over
  `examples/demo-app/tests/e2e/orbit-fixtures.ts` byte for byte.
- Optionally add a keyboard step to a demo journey, then refresh the demo's
  committed baselines only if a screenshot actually changes.
- Verify: `npx vitest run tests/integration/demo` passes, including the
  Chromium journey test where Chromium is installed.

### G40. Coverage is below the floor and not enforced (blocker)

"100% tested" cannot be shown. Measured this audit over `src/**`: lines
89.53%, statements 86.30%, functions 91.10%, branches 77.96%. 19 files are
below 80% lines (listed in `docs/traceability.md`, "Coverage"). The floor in
`docs/testing-journal.md` is lines and functions 95%, branches 90%, no file
under 80% lines. `vitest.config.ts` has no `coverage` block, so
`npm run test:coverage` neither restricts to `src/**` nor enforces thresholds,
and a single failing test suppresses the report.

- Add `test.coverage` to `vitest.config.ts`: `provider: 'v8'`,
  `include: ['src/**']`, `exclude: ['src/**/index.ts', 'src/adapters/hook-main.ts', 'src/adapters/shim-main.ts']`,
  `reportOnFailure: true`, and `thresholds` set to the measured values now,
  raised as tests land.
- Child-process code (`cli/main.ts`, `cli/hook.ts`, `cli/commands/internal.ts`,
  `adapters/shim.ts`, `policy/guard-hook.ts`): either collect with
  `NODE_V8_COVERAGE` from the spawned processes and merge, or add in-process
  entry tests that call the exported functions.
- `cli/commands/doctor.ts` (0.9%): call `runDoctor` in-process with stubbed
  probes for each capability, present and missing.
- `policy/bash.ts` (68.5% lines, 56.2% branches): table tests per command
  family in U/policy/bash.test.ts.
- `controller/workers.ts` (65.9%), `controller/start.ts` (40.7%),
  `cli/commands/models.ts`, `service.ts`, `report.ts`: unit tests for the
  untaken branches.

### G30. The impact register is never produced, and its comment says it is (blocker)

Covers S10.3, S18.3, S19.12. `inquisition/impact.ts:recordImpactRegister` is
implemented and unit tested by direct calls (U/inquisition/impact.test.ts), and
its header says "The engine calls `recordImpactRegister` when the inquiry's
mode is `risk-review`". Nothing in `src/` calls it, so a risk review never
writes an `inquisition.impact-register` decision. A function documented as
working that never runs is the placeholder S19.12 forbids.

- In `inquisition/engine.ts:runInquisition`, next to the `authorityMap` call
  (about line 921), call `recordImpactRegister({ db, clock, runId, runDir,
  policy, inquiry }, trigger)`.
- Test in U/inquisition/engine.test.ts: a risk-review trigger over a diff that
  touches an auth path records exactly one register decision; a challenge
  trigger records none.

### G46. `final.json` is written without redaction (blocker)

Covers S3.28. `controller/report.ts:writeFinalReport` passes the report object
straight to `atomicWriteJson(join(runDir, 'final.json'), report)`, while
`final.md` goes through `redact`. A goal, outcome reason or finding that
contains a secret or a `retention.redact_patterns` match is stored in clear in
`final.json`, which `orbit report --json` and the learning layer read.

- Redact every string in the report before writing `final.json` (a
  `redactDeep` over the object in `core/redact.ts`, applying the configured
  patterns).
- Extend I/policy/redact-patterns.test.ts: the custom pattern is absent from
  `final.json` as well as `final.md`.

### G39. The live demo has never run, and the README does not say so (blocker)

Covers S2.9, S19.4, S18.9. Only the mock demo runs
(I/demo/mock-demo.test.ts). `scripts/demo/run-live-demo.sh` is tested with
stubbed `gh` and `orbit` only. The spec asks for environment-blocked work to
be labelled unverified with an exact reproduction command; `README.md` does
not mention the live demo.

- Run `scripts/demo/run-live-demo.sh --repo <owner>/<private-repo>` with real
  Anthropic and Codex credentials, and commit the three final reports
  (redacted) under `examples/demo-app/reports/`.
- Until then, add to `README.md`: "Live demo: unverified. Reproduce with
  `scripts/demo/run-live-demo.sh --repo <owner>/<private-repo>`."

## Should

### G25. Engineering practices are not selected or justified (should)

Covers S5.40. Not started. The planner fixtures are spread across several
owners (`tests/unit/contract`, `tests/unit/schemas`, `scripts/demo/mock`,
`agents/planner.md`), and strict schemas require every property, so this needs
one coordinated change.

- Add `practices: [{ practice, applicable, justification }]` to
  `schemas/planner-output.schema.json`, with the nine spec practices as an
  enum, and the matching type in `contract/model-outputs.ts`.
- Store it on the contract (`contract/types.ts`, `contract/draft.ts`).
- Include it in `review/packet.ts` and add a reviewer question that rejects an
  unjustified omission.
- Update every planner fixture in the same change.
- Tests: schema test, draft test, and an I/review packet test.

### G27. A baseline exception cannot reach a run's contract (should)

Covers S6.6. `contract/amend.ts` now has the `accept_baseline_failure` op
(human approval only, fingerprint must equal the recorded base failure) and
`baselineExceptionProposal`, tested in U/contract/amend.test.ts. No runtime path
uses them: `inquisition/engine.ts` never passes `baselineFailures` to
`applyAmendment`, preflight raises no question, and no CLI command applies the
op. A repository with a pre-existing mandatory failure still cannot be green.

- In `steps/preflight.ts` (or `baselineGate`), when a required check fails on
  the base, persist a decision-record question whose approve option carries
  `baselineExceptionProposal(failure)`.
- When a person answers it (`orbit decide`), apply the proposal with
  `baselineFailures` from the baseline report's `failures`.
- I/controller test: a base with a failing required check blocks; approving
  the exception lets the run reach SUCCEEDED with the exception named in
  `final.md`; a model actor cannot approve it.

### G37. No rebase path for a moved base branch (should)

Covers S14.11, S18.4. AWAITING_CI now detects a delivered commit that
conflicts with the moved base and BLOCKS with the conflicting paths
(I/controller/base-conflict.test.ts). There is no way to authorize a rebase:
the policy has no `actions.rebase_task_branch` key and `GitHubClient` reports
no `mergeable` state.

- Add `actions.rebase_task_branch` (default false, delivery modes only) to
  `policy/types.ts`, `schemas/config.schema.json`, `policy/config.ts` and
  `templates/config.yaml`.
- Read `mergeable` in `delivery/github.ts` (and the fake).
- When authorized, rebase the candidate onto the new base in the worktree,
  snapshot a new candidate (which invalidates evidence) and re-verify;
  otherwise BLOCK as now.
- Tests: authorized rebase re-verifies and delivers once; unauthorized blocks.

### G15. Supervised mode asks only about dependency changes (should)

Covers S5.2. `controller/authorization.ts` turns a lockfile or package change
the policy denies into an approve-once or deny question
(I/controller/supervised-authorization.test.ts). Operations denied inside a
worker (`actions.change_permissions` commands such as `chmod +x`, network
hosts outside `network.allowed_hosts`) are only denied and recorded as
`policy.deny`; supervised mode never offers them for approval.

- In supervised mode, map `policy.deny` decisions recorded by
  `controller/denials.ts` for action-class rules (`actions.*`,
  `network.host`) to `GuardedOperation`s and ask with the same question shape.
- An approve-once grant names the operation and the attempt; `authorize` takes
  an explicit grants parameter so the worker's guard hook allows exactly that
  operation on the retried attempt.
- Test: a supervised worker denied `chmod +x apps/run.sh` produces a question;
  approve-once lets the retried attempt run it; deny sends a scope repair.

### G24. Memory is not limited under the default isolation, and limits are off by default (should)

Covers S5.28. `isolation/limits.ts` sets CPU time, process count and file
size through `ulimit` for srt and none, and docker flags for the container
provider (U/isolation/limits.test.ts, I/isolation/limits.int.test.ts, run on
macOS only). Memory is limited only by the container provider, and every
`isolation.limits` value defaults to null.

- On Linux, wrap srt commands in `systemd-run --user --scope -p MemoryMax=`
  when available, from a new `isolation.limits.max_memory_mb`.
- Add `isolation.require_resource_limits` (default false). When true, the
  environment gate refuses a provider that cannot enforce every configured
  limit, naming the missing one.
- Tests: argv construction per platform, the environment-gate refusal, and the
  Linux int test (run it on Linux CI).

### G47. `orbit verify` judges security findings differently from VERIFYING (should)

Covers S4.3. `cli/commands/verify.ts` calls `scanCandidateSecrets` without
`policy: snapshot.config.static_security` and `now`, and never maps SAST
results through `judgeSastResult`. A finding that `static_security.exceptions`
waives fails `orbit verify` but passes the controller, and a failed SAST check
with only advisory findings fails `orbit verify` but passes VERIFYING. It also
drops the unverified dependency-audit note.

- Extract the VERIFYING evidence collection in `steps/verifying.ts` into one
  exported function that both the step and `verifyCommand` call.
- Test in I/cli/verify-repair.test.ts: a waived secret finding gives exit 0
  from `orbit verify`, matching the run's own evidence report.

### G48. Release mode cannot merge with the default draft pull request (should)

Covers S15.5 in practice. `delivery.pull_request` defaults to `draft`; the
host (and `FakeGitHub`) refuses to merge a draft, and nothing in Orbit marks a
pull request ready. A release-mode run with default delivery settings blocks
at the merge. `policy/config.ts` does not warn about the combination.

- Either add a ledgered `pr_ready` action that `performRelease` runs before
  the merge (with intent, receipt and reconciliation like `merge`), or make
  `releaseRules` refuse `actions.merge: true` with `delivery.pull_request:
  draft`.
- Test in I/delivery/release.test.ts with a draft PR.

### G49. Flaky tests under full parallel load (should)

Three tests failed once on a full parallel run and passed alone:
I/controller/service-loop.test.ts "credentials are checked again while a run
works...", I/recovery/reconcile-workers.test.ts "a worker with its own durable
cancel request is stopped even in a healthy run", and I/cli/lifecycle.test.ts
"records the request while a controller owns the run..." (6 s lease TTL raced
against slow child start-up). A flaky fault or recovery test cannot show that
"fault tests pass".

- Replace wall-clock waits with condition waits on durable events, and drive
  lease expiry with an injected clock or a TTL derived from measured start-up.
- Run each of the three 20 times under `maxWorkers: 4` with the whole suite
  and record zero failures in `docs/testing-journal.md`.

### G14. Within-run parallel writers and merge overhead (should)

Covers S8.25, S8.27. Security and UI reviews now run in parallel
(I/controller/parallel-review.test.ts), and admission weighs browser slots and
context duplication. A run still has one writer: separable changes run in
parallel only as separate runs, and `AgentScheduler` has no merge-overhead
cost.

- Either plan separable work units from the planner's file mapping, run each
  writer in its own worktree, and integrate serially with evidence
  invalidation, with a merge-overhead cost in admission;
- or record in `docs/decisions/` that v1 parallelizes writers only across runs
  and why, and state it in `docs/architecture.md`.

## Nice

### G50. The controller's deploy path has no end-to-end test, and several environments never deploy

Covers S15.6. `performRelease` deploys correctly in I/delivery/release.test.ts,
but I/controller/release.test.ts only asserts `deploy: null`. With more than
one `release.environments` entry, `steps/delivering.ts` deploys nowhere,
because nothing names the run's environment.

- Add a contract or run field for the target environment (set by `orbit run
  --environment <name>`, checked against the profile).
- I/controller test: one environment deploys the merge commit and records
  `release.completed` with it.

### G51. A deploy left UNKNOWN can only be resolved by hand

After a crash mid-deploy with no recorded outcome, the run blocks
(I/delivery/release.test.ts "after a crash mid-deploy..."). No command
records the real outcome.

- Add an optional `verify_command` per environment that reconciles an unknown
  outcome, and an `orbit release resolve <run-id> --deployed|--not-deployed`
  for a person.

### G52. The baseline gate does not list base-revision audit findings

Covers S5.13 reporting only. `evidence/baseline.ts` records the base audit,
but `controller/gates.ts:baselineGate` adds no note for it, so `final.md`
does not show pre-existing vulnerabilities or license problems.

- Add one note per base finding at or above `fail_on` to `baselineGate`, and a
  gate unit test.

### G53. `routing.output_budgets` is an instruction only for Codex

Covers S8.21 for the Codex adapter. Claude enforces the budget through
`CLAUDE_CODE_MAX_OUTPUT_TOKENS` (verified against the real CLI); Codex has no
verified cap, so the budget is a prompt instruction plus a recorded
limitation (I/adapters/output-budget.test.ts).

- Check `docs/interfaces/` for a Codex output cap when Codex is next updated;
  until then keep the disclosed limitation.

### G54. The test-time scheduler probe reads the host

`AgentScheduler` reads free memory and cores from the host, so tests that
start several workers depend on the machine (A/parallel.test.ts now passes an
explicit roomy probe). Make the probe injectable through `ControllerDeps` and
use a fixed probe in every multi-worker test.

### G4. `/goal` integration is not documented for operators

Covers S4.27 documentation only. `skills/run/SKILL.md` offers `/goal` and the
plugin test checks it; `docs/operations.md` does not mention it.

- Add a short section to `docs/operations.md`: when `/goal` helps, the exact
  evidence line, and that the completion gate stays the authority.
