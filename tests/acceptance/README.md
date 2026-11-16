# Acceptance suite

End-to-end tests for spec section 17 ("Mandatory scenarios") and the safe
stops and demo runs of spec section 2. Each test drives a real controller (the
in-process `Controller`, a controller in its own process, or the `orbit` CLI as
a child process) against a throwaway git repository made from
`examples/demo-app`, with the fake provider CLIs (`tests/fakes`), FakeGitHub and
a bare local remote. Every test asserts the observable outcome (terminal
state, events, evidence report, decisions, actions, PR count) and the run
invariants of `docs/architecture.md` (`helpers/invariants.ts`).

Run it without npm:

```
node node_modules/vitest/vitest.mjs run tests/acceptance
```

Requirements: Node 22.18 or later (type stripping), `examples/demo-app`, and an
npm cache that can install the example offline (otherwise Orbit's own
`node_modules` is linked). Scenarios 17 and 18 and demo 2 need Playwright's
Chromium (`npx playwright install chromium`) and are skipped without it.
Scenario 11 needs the `claude` CLI on PATH and is skipped without it; it never
reaches a real model (the CLI talks to `tests/fakes/fake-anthropic-api.mjs`).

Every test is a plain `it`: no scenario is marked `it.fails`, so the suite
passes only when the runtime meets each one.

## Index

| # | Scenario | File | Test |
|---|---|---|---|
| 1 | Scoped feature passes with behaviour tests | `feature-and-repair.test.ts` | scenario 1: a scoped feature passes with behaviour tests and is delivered as one draft PR of the reviewed tree |
| 2 | Reproducible regression is repaired | `feature-and-repair.test.ts` | scenario 2: a reproducible regression is diagnosed from the failing check and repaired in the next attempt |
| 3 | Reversible ambiguity resolved unattended | `ambiguity.test.ts` | scenario 3: a reversible ambiguity is resolved unattended from the planner recommendation and recorded as a decision |
| 4 | Material ambiguity blocks affected work, independent work continues | `ambiguity.test.ts` | scenario 4: a material ambiguity goes to the Inquisition, blocks the criterion it affects, and the independent criterion is implemented and verified; scenario 4: the blocked criterion keeps the run from success and delivery, and its question waits for a person |
| 5 | Weak tests rejected despite green status | `proof-and-progress.test.ts` | scenario 5: green checks over weakened tests are rejected as proof |
| 6 | Repeated non-progress terminates | `proof-and-progress.test.ts` | scenario 6: attempts that keep failing the same way without progress end the run EXHAUSTED before the hard cap |
| 7 | Restart does not duplicate workers or actions | `restart-and-delivery.test.ts` | scenario 7: a controller killed mid-implementation ...; scenario 7: a controller killed as delivery opens the PR ... |
| 8 | Lost PR response still results in one PR | `restart-and-delivery.test.ts` | scenario 8: a PR whose create response is lost is adopted on reconciliation |
| 9 | Unauthorized protected changes are rejected | `policy-and-evidence.test.ts` | scenario 9: a candidate that edits protected paths is rejected outright |
| 10 | Stale evidence cannot authorize delivery | `policy-and-evidence.test.ts` | scenario 10: evidence that goes stale in the middle of delivery stops the next external action |
| 11 | No permission-prompt deadlock | `credentials-and-routing.test.ts` | scenario 11: an unattended run whose worker asks for edits and commands that need permission ... (real `claude`) |
| 12 | Expired credentials produce a truthful blocker | `credentials-and-routing.test.ts` | scenario 12: reviewer credentials that expire mid-run ... (`orbit resume`); scenario 12: credentials already expired at the start ...; scenario 12: an implementer whose credentials expire mid-run (401) blocks on credentials, not on budget |
| 13 | Simple work uses a low-cost eligible route | `credentials-and-routing.test.ts` | scenario 13: simple work uses the low-cost eligible route |
| 14 | Difficult work escalates only with recorded justification | `credentials-and-routing.test.ts` | scenario 14: difficult work escalates only with recorded justification ... (repeated_failure_threshold 1, so one failure is the repeated equivalent failure); scenario 14: the implementer is not escalated on a single localized failure |
| 15 | Parallel work respects isolation and resource limits | `parallel.test.ts` | scenario 15: two runs work at once ...; scenario 15: with capacity for one run, the second run waits |
| 16 | Cross-provider disagreement becomes a testable claim | `review-and-security.test.ts` | scenario 16: a reviewer claim the implementer's evidence does not settle becomes a testable claim |
| 17 | UI defect reproduced, repaired, reverified | `ui.test.ts` | scenario 17 (and demo run 3): a UI defect is reproduced in Chromium ... |
| 18 | Visual baseline changes cannot hide regressions | `ui.test.ts` | scenario 18: a visual regression shipped with a re-recorded baseline is caught |
| 19 | Security findings follow severity/exception policy | `review-and-security.test.ts` | scenario 19: ... waived with its recorded reason; ... blocks completion; ... reported as advisory |
| 20 | Cancellation remains effective after restart | `restart-and-delivery.test.ts` | scenario 20: a cancellation recorded with `orbit cancel` while the controller is dead ... |

### Reported issues (issue #166, FR-002)

One scenario per issue fixed for #166. Each fails on the sources as they were before the issue's fix and passes after.

| Issue | File | Test |
|---|---|---|
| #130 | `review-gate.test.ts` | issue #130: a review that asks for repair through an advisory finding only is repaired ... |
| #131 | `service-and-launcher.test.ts` | issue #131: a service installed from a session with its own provider config folders finds the same logins (darwin, linux) |
| #132 | `check-environment.test.ts` | issue #132: the dependencies are installed in the implementer worktree before the worker starts ... |
| #133, #158 | `check-environment.test.ts` | issue #133, issue #158: a check checkout that is made again gets its dependencies installed again ... |
| #138 | `cli-admission.test.ts` | issue #138: init proposes checks from the manifests and says it did not read the CLAUDE.md ... |
| #139 | `cli-admission.test.ts` | issue #139: submitting a goal an unfinished run already has is refused ... |
| #140 | `worker-and-watchdog.test.ts` | issue #140: a Claude worker in the claude-sandbox tier gets Rust build state it may write ... |
| #141 | `worker-and-watchdog.test.ts`, `check-environment.test.ts` | issue #141: a baseline whose check runs longer than the stall limit ...; User Story 1, scenario 2 |
| #142 | `cli-admission.test.ts` | issue #142: doctor warns when a mandatory check runs a toolchain whose dependency cache is missing ... |
| #143 | `service-and-launcher.test.ts` | issue #143: a newer Orbit does not migrate the state database under a controller that still holds a run lease |
| #144 | `attempts-and-size.test.ts` | issue #144: a diagnosis after a session that ended at its turn cap is told so ... |
| #154 | `service-and-launcher.test.ts` | issue #154: a development build does not take over the launcher ... |
| #156 | `review-gate.test.ts` | issue #156: every finding of a REPAIR_REQUIRED review is briefed ... |
| #157 | `attempts-and-size.test.ts` | issue #157: a size denial names the files that carry the lines ... |

### User stories of issue #166

| Story | File | Test |
|---|---|---|
| 1.1 A check that imports an installed dependency runs with it present | `check-environment.test.ts` | issue #133, issue #158 |
| 1.2 A baseline where every check fails for one environmental reason blocks and names it | `check-environment.test.ts` | User Story 1, scenario 2 (issue #141) |
| 2.1 A missing module or toolchain is an environment failure; no implementer session starts for it | `check-environment.test.ts` | User Story 1, scenario 2 (a missing module where nothing was installed: no session starts); User Story 2 (a missing toolchain; a missing module in a provisioned checkout stays the change's, two tests); a base revision that imports an undeclared package keeps its baseline exception |
| 3.1 Advisory-only findings with no approval: the run repairs | `review-gate.test.ts` | issue #130 |
| 3.2 A high finding unvalidated across two verified candidates | `review-gate.test.ts` | issue #156 (the run stops and names the finding; the decided behaviour, one fresh independent review told the finding, follows in its own pull request) |
| SC-003 No scenario ends EXHAUSTED holding a verified candidate | `helpers/invariants.ts` | `assertNoVerifiedCandidateExhausted`, part of `assertRunInvariants`, so every scenario is held to it. Three are known expected failures until issue #169 (such a run ends BLOCKED naming the candidate): scenario 16, scenario 19 (the blocking finding) and issue #156. Each is marked where it calls `assertRunInvariants`, and the marker fails once the run no longer ends that way |

### Safe stops (spec section 2)

| Stop | File | Test |
|---|---|---|
| Unauthorized action | `safe-stops.test.ts` | unauthorized action: a delivery the policy does not authorize ... |
| Stale evidence | `policy-and-evidence.test.ts` | scenario 10 (the stale binding refuses the next action; the run re-verifies) |
| Repeated non-progress | `proof-and-progress.test.ts` | scenario 6 |
| Exhausted budget | `safe-stops.test.ts` | exhausted budget: a model-cost cap too small for an honest completion ... |
| Expired credentials | `safe-stops.test.ts`, `credentials-and-routing.test.ts` | expired credentials: ...; scenario 12 |
| Unavailable mandatory reviewer | `safe-stops.test.ts` | unavailable mandatory reviewer: ...; unavailable mandatory reviewer mid-run: ... |

### Demo runs (spec section 2)

| Run | File | Test |
|---|---|---|
| Simple task on a low-cost route | `demo-shapes.test.ts` | demo 1 (driven by `orbit run --foreground` as a child process) |
| Difficult task with evidence-backed escalation | `demo-shapes.test.ts` | demo 2 |
| UI task: fails browser checks, repairs, independent review, draft PR | `ui.test.ts` | scenario 17 (and demo run 3) |

## Helpers

- `helpers/lab.ts`: the lab (template copy of the demo app, bare remote,
  FakeGitHub, fake-backed adapters), `drive`, the CLI child (`orbit`), and a
  controller child (`spawnController`, `helpers/controller-main.ts`).
- `helpers/scenarios.ts`: fake-provider scripts for the demo app's not-found
  feature and its variants. The demo goals reuse `scripts/demo/mock/scenarios.ts`.
- `helpers/invariants.ts`: the architecture invariants, checked from durable state.
