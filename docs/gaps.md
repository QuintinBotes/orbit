# Gaps against the spec

What is still not done after the final re-audit of 2026-10-05 (see
`docs/traceability.md`). The audit went through spec sections 1 to 21
requirement by requirement, checked that every test cited in the traceability
table exists under the quoted name, and read the tests behind every row that
changed in the last two waves. Each gap is listed once, with the requirement
ids it covers. Gap ids carry over from earlier audits where the gap is the
same; new ids start at G55.

Closed since the previous versions of this file, each with the test or
measurement that proves it:

- G50 (named release environment): `orbit run --environment <name>` stores the
  name on the run (`runs.environment`, migration 4) and in the contract as
  `delivery.environment`; `controller/gates.ts:intakeGate` refuses a name the
  release profile does not define, and `delivery/release.ts` deploys only the
  named environment and refuses it before the merge when it is undefined or not
  allowed for the deployed branch. Tests: U/cli/run-environment.test.ts,
  U/contract/release-environment.test.ts, U/controller/gates.test.ts "the
  release environment a run names (G50)", U/delivery/coverage-release.test.ts "a
  named environment is refused before anything is merged (G50)",
  I/controller/release-deploy.test.ts "a run that names its environment
  (orbit run --environment) deploys only that one", "a named environment the base
  branch is not allowed for blocks the release before the pull request is merged"
  and "a run that names an environment the release profile does not define is
  refused at intake".
- G55 (baseline exception approved mid-run): `controller/steps/verifying.ts`
  applies any approved, unapplied baseline-exception answer before it judges
  the evidence. Test: U/inquisition/baseline-exception-run.test.ts "an approval
  recorded after planning, whose apply step never ran, is applied when
  VERIFYING starts".
- G56 (rebased candidate that fails verification): I/controller/base-conflict.test.ts
  "a rebased candidate that then fails verification goes to DIAGNOSING and is
  never pushed" (a test only; the behaviour was already right).
- G57 (per-file coverage floor and saturation probe):
  `scripts/check-coverage-floor.mjs` runs after vitest in
  `npm run test:coverage` and fails with the files under 80% lines
  (U/scripts/coverage-floor.test.ts); F/saturation.test.ts passes its saturated
  probe through `ControllerDeps.schedulerProbe` and no longer mocks `node:os`,
  and `labDeps` defaults to `FIXED_PROBE`. What is left of G57 is the journal
  entry, below.
- G24 (`isolation.require_resource_limits`): when true, `environmentGate` blocks
  a run whose provider cannot enforce a configured limit and `orbit doctor`
  fails with the same message (`isolation/limits.ts:unenforcedLimits`). Tests:
  U/controller/gates.test.ts "environmentGate: isolation.require_resource_limits
  (G24)", U/isolation/limits.test.ts "unenforcedLimits and
  resourceLimitRefusals", U/cli/coverage-doctor-system.test.ts "fails when
  isolation.require_resource_limits is true", U/policy/config.test.ts,
  I/controller/require-resource-limits.test.ts. What is left of G24 is the Linux
  hard cap, below.

- G40 (coverage): `vitest.config.ts` now restricts coverage to `src/**`,
  reports on failure and enforces lines 95, functions 95, statements 95 and
  branches 90. Measured totals: lines 99.68%, functions 99.69%, statements
  99.11%, branches 96.39%. The lowest file is `src/inquisition/impact.ts` at
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

Blockers: 1. Should: 0. Nice: 3.

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

### G24. Memory hard cap under sandbox-runtime on Linux (nice)

Covers S5.28 (done for the default provider). `isolation.limits` is on by
default (CPU 3600 s, 2048 processes, 2048 MB files, 4096 MB memory) and
`memory_mb` is enforced under sandbox-runtime by a resident-memory watchdog
(`isolation/memory.ts`, I/isolation/memory.int.test.ts under the real srt).
`isolation.require_resource_limits` already refuses a provider that cannot
enforce a configured limit, and counts the watchdog as no hard cap. What
remains:

- On Linux, use a hard cap (`systemd-run --user --scope -p MemoryMax=<mb>M`)
  when it is available, in place of the sampling watchdog, which a fast
  allocation between samples can overshoot. Test: the existing
  I/isolation/memory.int.test.ts on a Linux CI runner. When this lands,
  `unenforcedLimits` must stop reporting sandbox-runtime for memory on a host
  where the cap is in use (a U/isolation/limits.test.ts case with the cap
  available and not).

### G53. `routing.output_budgets` is an instruction only for Codex (nice)

Covers S8.21 (done for Claude). Claude enforces the budget through
`CLAUDE_CODE_MAX_OUTPUT_TOKENS` (I/adapters/output-budget.test.ts, real CLI).
Codex has no verified output cap (checked against codex 0.153.4, guarded in
U/adapters/codex.test.ts), so the budget is a prompt instruction, overruns are
measured and recorded, and the limitation is disclosed.

- When Codex is next updated, check `docs/interfaces/codex-cli.md` and the
  Codex help output for an output-token setting; if one exists, pass it in
  `adapters/codex.ts` and replace the guard test with an argv assertion.

### G57. Testing journal entry for G40 and G49 (nice)

- `docs/testing-journal.md` still lists G40 as open with the first
  measurement, and has no entry for the G49 repeat runs. Add an entry with the
  final totals, the four flaky-test root causes, and the repeat runs (full
  suite three times at 4 workers, once at 8 workers, the touched files 4 times
  under 20 CPU burners).
