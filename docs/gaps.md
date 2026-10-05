# Gaps against the spec

What is still not done after the final re-audit of 2026-10-05 (see
`docs/traceability.md`). The audit went through spec sections 1 to 21
requirement by requirement, checked that every test cited in the traceability
table exists under the quoted name, and read the tests behind every row that
changed in the last two waves. Each gap is listed once, with the requirement
ids it covers. Gap ids carry over from earlier audits where the gap is the
same; new ids start at G55.

Closed since the previous version of this file, each with the test or
measurement that proves it:

- G40 (coverage): `vitest.config.ts` now restricts coverage to `src/**`,
  reports on failure and enforces lines 95, functions 95, statements 95 and
  branches 90. Measured totals: lines 99.68%, functions 99.69%, statements
  99.11%, branches 96.40%. The lowest file is `src/inquisition/impact.ts` at
  96.87% lines. The child-process entries (`cli/main.ts`, `cli/hook.ts`,
  `cli/commands/internal.ts`, `adapters/shim.ts`, `adapters/hook-main.ts`,
  `adapters/shim-main.ts`) are covered by in-process entry tests
  (U/adapters/coverage-entry-main.test.ts, U/adapters/coverage-entry-shim.test.ts,
  U/cli/coverage-entry-process.test.ts). What is left is hygiene, see G57.
- G49 (flaky tests): the four root causes were fixed (lease TTL raced against
  child start-up in I/cli/lifecycle.test.ts; wall-clock credential recheck in
  I/controller/service-loop.test.ts, now an injected clock; kill order in
  F/worker-crash.test.ts; signal delivery before the provider's handlers in
  U/adapters/coverage-entry-shim.test.ts). The full suite then passed at 4
  workers three times, at 8 workers once, and again in this audit's coverage
  run. Recording the repeat runs in `docs/testing-journal.md` is part of G57.

Severity:

- **blocker**: the stated goal ("implemented fully as per the spec and 100%
  tested, with all feedback and findings addressed") cannot be claimed while it
  is open. This covers a failing test, a mandatory scenario or fault test, a
  definition-of-delivered item, a broken user-facing command, a security
  setting that is silently ignored, and any runtime behaviour with no test.
- **should**: a spec requirement that is missing or partial while the core loop
  still works.
- **nice**: conformance, hardening or hygiene with little behavioural effect.

Blockers: 1. Should: 0. Nice: 6.

## Blockers

### G39. The live demo has never run against real providers (blocker)

Covers S2.9 (untested), S18.9 (partial), S19.4 (partial). Only the mock demo
runs (I/demo/mock-demo.test.ts, A/demo-shapes.test.ts). `docs/demos/` does not
exist, so there is no report from a live run.
`scripts/demo/run-live-demo.sh` is tested with stubbed `gh` and `orbit` only
(I/demo/live-script.test.ts). The README "Live demo" section already labels
the live demo unverified and gives the reproduction commands, as spec section
2 asks for environment-blocked work.

Fix (needs real Anthropic and Codex credentials, a fine-grained `GH_TOKEN`
and a private repository, so it cannot be closed from the test suite):

1. `scripts/demo/run-live-demo.sh --repo OWNER/NAME --dry-run`, then the same
   without `--dry-run`. Exit 0 means all three runs SUCCEEDED.
2. Commit the three `final.md` reports the script writes to
   `docs/demos/<date>/`, after checking them for tokens, personal names and
   host paths.
3. Change the README "Live demo" status line to name the date and the reports,
   and set S2.9, S18.9 and S19.4 to done in `docs/traceability.md`.

## Should

None.

## Nice

### G24. Memory and process limits: what is left (nice)

Covers S5.28 (done for the default provider). `isolation.limits` is on by
default (CPU 3600 s, 2048 processes, 2048 MB files, 4096 MB memory) and
`memory_mb` is enforced under sandbox-runtime by a resident-memory watchdog
(`isolation/memory.ts`, I/isolation/memory.int.test.ts under the real srt).
What remains:

- Add `isolation.require_resource_limits` (default false) to
  `policy/config.ts`, `schemas/config.schema.json` and `templates/config.yaml`.
  When true, `controller/gates.ts:environmentGate` refuses a provider that
  cannot enforce every configured limit and names the missing one. Today the
  container provider ignores `limits.memory_mb` (it has its own `--memory`)
  and `none` enforces no memory limit; both say so in their limitations but
  nothing refuses them. Test: a U/controller/gates.test.ts case per provider,
  with the key on and off.
- On Linux, use a hard cap (`systemd-run --user --scope -p MemoryMax=<mb>M`)
  when it is available, in place of the sampling watchdog, which a fast
  allocation between samples can overshoot. Test: the existing
  I/isolation/memory.int.test.ts on a Linux CI runner.

### G50. A run does not name its release environment (nice)

Covers S15.6 (done). With `environments: 'all'` the controller deploys every
environment whose `allowed_branches` cover the ref, in profile order, and
reports the rest as skipped (I/controller/release-deploy.test.ts). No run or
contract field names the target, so a profile with staging and production
deploys to both when the branch allows it.

- Add `orbit run --environment <name>` and a contract field
  `delivery.environment`, validated against `release.environments` at intake
  (`controller/gates.ts:intakeGate`), and make `delivery/release.ts` deploy
  only that environment. Tests: an intake refusal for an unknown name, and a
  release-deploy case where only the named environment runs.

### G53. `routing.output_budgets` is an instruction only for Codex (nice)

Covers S8.21 (done for Claude). Claude enforces the budget through
`CLAUDE_CODE_MAX_OUTPUT_TOKENS` (I/adapters/output-budget.test.ts, real CLI).
Codex has no verified output cap (checked against codex 0.153.4, guarded in
U/adapters/codex.test.ts), so the budget is a prompt instruction, overruns are
measured and recorded, and the limitation is disclosed.

- When Codex is next updated, check `docs/interfaces/codex-cli.md` and the
  Codex help output for an output-token setting; if one exists, pass it in
  `adapters/codex.ts` and replace the guard test with an argv assertion.

### G55. A baseline exception approved mid-run is applied only at PLANNING and INQUISITION (nice)

Covers S6.6 (done). `orbit decide` applies an approved baseline exception at
once (`inquisition/questions.ts:answerQuestion`), and PLANNING and INQUISITION
retry any answer still unapplied (`applyBaselineExceptionAnswers`). If the
apply step does not complete after the answer is recorded (the process dies
between the two), a run already past PLANNING reaches VERIFYING without the
exception and repairs a failure the person accepted.

- Call `applyBaselineExceptionAnswers` at the start of
  `controller/steps/verifying.ts` as well. Test: record an "Approve" answer
  with no applied amendment (insert the answer decision directly), drive the
  run from IMPLEMENTING, and assert the evidence report accepts the failure
  and the run does not enter DIAGNOSING.

### G56. No controller test for a rebased candidate that then fails verification (nice)

Covers S14.11 (done). I/controller/base-conflict.test.ts proves a clean rebase
invalidates the old evidence and verifies and reviews the rebased candidate
again, and that a conflicting rebase blocks. No test shows a rebased candidate
that fails its checks going to DIAGNOSING, with the rebase counted against the
limit of 3 and no push of the failing tree.

- Add a base-conflict case where the moved base breaks a mandatory check
  (for example a test file on the base that the candidate's change fails), and
  assert DIAGNOSING, an invalidated first report, no second `push` action
  until a repaired candidate passes, and one pull request.

### G57. Test-quality hygiene left after G40 and G49 (nice)

- The coverage floor in `docs/testing-journal.md` includes "no file under 80%
  lines", but `vitest.config.ts` enforces only the global thresholds. Every
  file is above 96% today, so nothing fails; a regression in one small file
  would pass. Add a per-file check (a glob threshold with `perFile`, or a short
  script over `coverage-summary.json` run by `npm run test:coverage`) and a
  test that a file under the floor fails it.
- `docs/testing-journal.md` still lists G40 as open with the first
  measurement, and has no entry for the G49 repeat runs. Add an entry with the
  final totals, the four flaky-test root causes, and the repeat runs (full
  suite three times at 4 workers, once at 8 workers, the touched files 4 times
  under 20 CPU burners).
- F/saturation.test.ts replaces `node:os` `freemem` through a module mock for
  the two-run controller case. `ControllerDeps.schedulerProbe` already exists
  (`controller/context.ts`); pass a saturated probe there so the test does not
  depend on module mocking order.
