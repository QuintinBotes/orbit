# 0004. UI configuration: journeys are Playwright checks, with enforced flags

Status: accepted (2026-10-05)

## Context

Spec section 13 sketches the `ui:` block with declarative journeys
(`journeys[].id` plus a list of step sentences) and an `artifacts:` block
(`screenshots`, `traces`, `console_errors`, `failed_requests`). The shipped
configuration differs in three ways:

- journeys are not declared in Orbit's configuration. `ui.journey_check_ids`
  names checks of `kind: playwright`, and the journeys are the specs those
  checks run;
- there is no `artifacts:` block. What is recorded is fixed by the runner;
- `accessibility` and `visual` carry the fields the spec shows, plus
  `baseline_changes_require_review` and `baseline_globs`, and
  `visual_baseline_auto_accept` exists only as the constant `false`.

## Decision

1. **Journeys stay in Playwright.** A journey is a Playwright test in the
   repository, selected by a check. Orbit does not interpret step sentences.
   The step names a person sees in a failure brief are the `test.step` titles
   of the spec ("Open reports", "Apply a filter", and so on, as in the spec's
   example), read back from Playwright's own report.
2. **Recording flags are enforced, not configured.** The runner always adds
   `--reporter=json`, `--update-snapshots=none`, `--trace=retain-on-failure`,
   its own `--output` and `--retries`, and rejects a check command that
   carries a flag which would change them (`-u`, `--update-snapshots`,
   `--reporter`, `--output`, `--trace`, `--retries`, `--pass-with-no-tests`,
   `--headed`, `--debug`, `--ui`). Screenshots on failure come from the
   `orbit-fixtures.ts` template. Console errors and failed requests are always
   recorded as the `orbit-diagnostics` attachment. `UI_ENFORCEMENT_VERSION`
   is part of the configuration hash, so changing what is enforced invalidates
   old evidence.
3. **The accessibility switch is passed to the journey.**
   `ui.accessibility.fail_on_new_serious_or_critical` reaches the fixture as
   `ORBIT_A11Y_FAIL_ON`: `serious,critical` when true, `none` when false. With
   `none` a new violation is recorded as advisory (`UiA11yScan.advisory`,
   `UiRunResult.a11yAdvisory`, and a line in `unverified`) and does not fail
   the journey. The result binding records which setting applied.
4. **Keyboard navigation is a fixture helper.** `expectKeyboardReachable`
   checks tab order, reachability and a visible focus indicator for the listed
   selectors and attaches `orbit-keyboard`. The binding reports how many scans
   ran and how many found a problem.
5. **Exploration is opt in and bounded.** `ui.exploration` is
   `{ enabled, max_minutes, budget_usd }`, disabled by default. An explorer
   worker proposes candidate findings; each counts only after a Playwright
   test written from it fails on every one of several runs against the
   candidate. Findings are work for the implementer and never acceptance
   evidence.

## Why not the spec's shape

- Declarative step sentences cannot be executed. Orbit would need its own
  interpreter for them, or a model to translate them on every run, and a
  translation that drifts between runs is exactly the evidence problem
  section 13 warns about. A Playwright test is the translation, written once
  and reviewed by people.
- Recording options are what make a result trustworthy. If a repository could
  turn traces off, set retries, or let the check update snapshots, a green
  run would no longer say what Orbit claims it says. Fixing them in the
  runner removes the question; a configurable `artifacts:` block would
  reintroduce it.
- Journeys keep working without Orbit: a repository's own CI runs the same
  specs.

## Consequences

- The spec's example `journeys:` list has no equivalent key. Users who want a
  named journey give the Playwright test that name; the evidence report uses
  it as the journey id.
- A repository with a hand-written Playwright config is accepted as long as
  its check command carries only selection arguments.
- A step-by-step view of a journey comes from the spec's `test.step` titles,
  so a journey without steps shows only its failing assertion.
- Reviewers of a change to `UI_ENFORCEMENT_VERSION` should treat it like a
  change to a schema: old UI evidence no longer matches.
