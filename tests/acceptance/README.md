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
`node_modules` is linked). Scenarios 17 and 18 need Playwright's Chromium
(`npx playwright install chromium`) and are skipped without it. Scenario 11
needs the `claude` CLI on PATH and is skipped without it; it never reaches a
real model (the CLI talks to `tests/fakes/fake-anthropic-api.mjs`).

Tests marked `it.fails` assert spec behaviour that the runtime does not meet
yet; each carries a `DEFECT:` comment with the cause.

## Index

| # | Scenario | File | Test |
|---|---|---|---|
| 1 | Scoped feature passes with behaviour tests | `feature-and-repair.test.ts` | scenario 1: a scoped feature passes with behaviour tests and is delivered as one draft PR of the reviewed tree |
| 2 | Reproducible regression is repaired | `feature-and-repair.test.ts` | scenario 2: a reproducible regression is diagnosed from the failing check and repaired in the next attempt |
| 3 | Reversible ambiguity resolved unattended | `ambiguity.test.ts` | scenario 3: a reversible ambiguity is resolved unattended from the planner recommendation and recorded as a decision |
| 4 | Material ambiguity blocks affected work, independent work continues | `ambiguity.test.ts` | scenario 4: a material ambiguity goes to the Inquisition, blocks the criterion it affects, and the independent criterion is implemented and verified; scenario 4: the blocked criterion keeps the run from success and delivery (`it.fails`, DEFECT) |
| 5 | Weak tests rejected despite green status | `proof-and-progress.test.ts` | scenario 5: green checks over weakened tests are rejected as proof |
| 6 | Repeated non-progress terminates | `proof-and-progress.test.ts` | scenario 6: attempts that keep failing the same way without progress end the run EXHAUSTED before the hard cap |
| 7 | Restart does not duplicate workers or actions | `restart-and-delivery.test.ts` | scenario 7: a controller killed mid-implementation ...; scenario 7: a controller killed as delivery opens the PR ... |
| 8 | Lost PR response still results in one PR | `restart-and-delivery.test.ts` | scenario 8: a PR whose create response is lost is adopted on reconciliation |
| 9 | Unauthorized protected changes are rejected | `policy-and-evidence.test.ts` | scenario 9: a candidate that edits protected paths is rejected outright |
| 10 | Stale evidence cannot authorize delivery | `policy-and-evidence.test.ts` | scenario 10: evidence that goes stale in the middle of delivery stops the next external action |
| 11 | No permission-prompt deadlock | `credentials-and-routing.test.ts` | scenario 11: an unattended run whose worker asks for edits and commands that need permission ... (real `claude`) |
| 12 | Expired credentials produce a truthful blocker | `credentials-and-routing.test.ts` | scenario 12: reviewer credentials that expire mid-run ... (`orbit resume`); scenario 12: credentials already expired at the start ...; scenario 12: an implementer whose credentials expire mid-run (401) ... (`it.fails`, DEFECT) |
| 13 | Simple work uses a low-cost eligible route | `credentials-and-routing.test.ts` | scenario 13: simple work uses the low-cost eligible route |
| 14 | Difficult work escalates only with recorded justification | `credentials-and-routing.test.ts` | scenario 14: difficult work escalates only with recorded justification ...; scenario 14: the implementer is not escalated on a single localized failure (`it.fails`, DEFECT) |
| 15 | Parallel work respects isolation and resource limits | `parallel.test.ts` | scenario 15: two runs work at once ...; scenario 15: with capacity for one run, the second run waits |
| 16 | Cross-provider disagreement becomes a testable claim | `review-and-security.test.ts` | scenario 16: a reviewer claim the implementer's evidence does not settle becomes a testable claim |
| 17 | UI defect reproduced, repaired, reverified | `ui.test.ts` | scenario 17 (and demo run 3): a UI defect is reproduced in Chromium ... |
| 18 | Visual baseline changes cannot hide regressions | `ui.test.ts` | scenario 18: a visual regression shipped with a re-recorded baseline is caught |
| 19 | Security findings follow severity/exception policy | `review-and-security.test.ts` | scenario 19: ... waived with its recorded reason; ... blocks completion; ... reported as advisory |
| 20 | Cancellation remains effective after restart | `restart-and-delivery.test.ts` | scenario 20: a cancellation recorded with `orbit cancel` while the controller is dead ... |

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
