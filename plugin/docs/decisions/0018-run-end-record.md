# 0018. Every run records why it ended and which Orbit version started it

Status: accepted (2026-11-15). Issue #167.

## Context

Why a run failed lived in prose: `runs.outcome_reason` is a sentence and
`runs.outcome_json` is free-form. Nobody could count environment problems
against model problems without reading reports, and the `runs` table did not
say which Orbit version had started a run, so two releases could not be
compared.

## Decision

Three columns on `runs` (migration 7), all nullable text:

- `failure_class`: one value of `schemas/failure-class.schema.json`, or null.
- `failure_secondary`: the second cause of a run that had two, or null.
- `orbit_version`: the version that started the run, written once by
  `createRun` and never changed, also in the `run.created` event.

The class is set inside `transition()` (`src/controller/run-store.ts`), in the
same transaction as the move into a terminal state. That is the only way a run
changes state, so no path can end a run without one: the steps' `finishRun`,
the credential block, the recovery budget, the watchdog and `orbit cancel` all
pass through it. A blocked run that is resumed has both columns cleared and is
classified again when it ends again.

The rules are in `src/controller/failure-class.ts` (`classifyRunEnd`). They read
only what the run recorded: the terminal state, the keys of the structured
outcome, the data of the ending transition (an error code, a budget counter)
and the `implementation.worker-ended` events. No model is asked and no rule
reads the wording of a reason. Because the stored value is always a member of
the list, nothing a reason quotes (a path, a host name, a token) can reach it.

| End | Class |
|---|---|
| `SUCCEEDED` | none |
| `CANCELLED`, whatever the step had decided | `cancelled` |
| Credential blocker, credentials in the git configuration, `AUTH_*` | `credentials` |
| `misconfigured_checks`, a frozen-policy fix under `checks.` | `check-misconfigured` |
| `environment_failures`, `incomplete_checks`, a refused worker session or plugin, a dirty start, no usable reviewer, a release error or wait, a base conflict, the environment or baseline gate, `ISOLATION_UNAVAILABLE`, `PROVIDER_UNAVAILABLE`, `POLICY_TAMPERED`, `CONFIG_INVALID`, `CONTRACT_INVALID`, the `recovery_attempts` or `infrastructure_retries` counter | `environment` |
| A candidate's scope report, ungranted operations, a size denial, `SCOPE_VIOLATION`, `POLICY_DENIED` | `scope` |
| Open or held review findings, the `review_rounds` counter | `review-dispute` |
| Open questions, blocked criteria, a pending authorization, undecided ledger entries, a fail-before answer, a review gate that did not clear, the delivery or completion gate | `gate-deadlock` |
| `EXHAUSTED` or `IMPOSSIBLE` after an implementer session ended at its turn cap | `turn-cap`, first |
| `EXHAUSTED` | `budget`, last |
| Nothing above | the class the step names, else `model` |

Where several rows hold, the rows are in the order causes stop a run, the first
is the class and the second is `failure_secondary`. A step may name a class for
an end its records carry no marker for (a CI timeout, a failed delivery, a
recovery the watchdog gave up on); a marker always comes before it.

`model` is the default, not a finding: it means the records show no harness
cause. An `EXHAUSTED` run gets it only when its attempts went into the same
failure (non-progress, a denied extension, the attempts cap).

Rows written before the migration keep null in all three columns. They are
shown with no class and version `unknown`, and are never classified after the
fact, because their outcomes were not written with these rules in mind.

`orbit stats` counts ended runs per class and per version (`failure_classes`,
`by_version`) and takes `--orbit-version`. `orbit report` and `orbit timeline`
show both fields: the report in its Outcome section and JSON, the timeline in
its header, on the entry that created the run and on the entry that ended it.

## Consequences

- A new way to end a run needs a marker or a named class, or it is counted as
  `model`. The table test in `tests/unit/controller/failure-class.test.ts`
  holds the scenarios of issues #130 to #158.
- `gate-deadlock` covers both a gate nothing can open (issue #130) and a gate
  that waits for a person. A run that waits on a question is not a defect, but
  an unattended benchmark run that stops there did not finish either.
- The migration is refused while a run lease is live (issue #143), so
  an older controller never meets the new columns mid-run.
- A report saved before this change is printed as saved; its JSON gets the
  three fields from the run's row.

## Addendum (2026-11-15): a run that stops holding a verified candidate (issue #169)

A run that would end `EXHAUSTED` while it holds a candidate that passed
verification, and that delivered no candidate, now ends `BLOCKED`, so a person can deliver
or discard that candidate (`src/controller/verified-candidate.ts`). Its outcome
records `decided: "EXHAUSTED"` and the candidate (`verified_candidate`).

Such a run keeps the class the `EXHAUSTED` end would have had: `classifyRunEnd`
reads a `BLOCKED` run whose outcome says `decided: "EXHAUSTED"` as an
`EXHAUSTED` one. A stop on money or time is `budget`; a review round cap with
open findings, or a review repair that made no progress, is `review-dispute`
with `budget` second; attempts that went into the same failure are `model` with
`budget` second; sessions that ended at their turn cap come first as before. The
class says why the run stopped, and holding a verified candidate does not change
that: it changes what a person can do next. No new class was added, so the
published list is unchanged. `orbit stats` counts these runs on their own as
well (`runs.verified_undelivered`), so they are not read as failures with
nothing to show.

## Addendum (2026-11-20): follow-ups from the review (issue #190)

- **Waiting for a person is its own class.** A run that waits for a decision a
  person gives with `orbit decide` and then resumes (an open question or the
  criteria it blocks, a pending authorization, an undecided ledger entry, a
  fail-before answer) is `awaiting-decision`, no longer `gate-deadlock`, so
  `orbit stats` does not show it among the gates nothing can open.
  `gate-deadlock` keeps a review gate that did not clear, the delivery and
  completion gates, and a declined ledger entry (it needs a new run). The class
  comes after `gate-deadlock` in the order of causes. The published list gains
  the value; the pass rate still counts such a run as finished, as it does a
  run that stopped holding a verified candidate.
- **The turn cap comes after a broken harness.** Sessions that ended at their
  turn cap still make a run that ran out `turn-cap`, but a credential, a
  misconfigured check or an environment failure the records mark comes first:
  a session in an environment that refuses its work runs into its cap as a
  symptom. The turn cap still comes before scope, a review dispute, a gate, the
  model and the budget. One capped session is still enough, as edge case 1
  holds.
- **No class reads a value found in wording.** `frozen_policy.setting` is
  matched from a block's reason (`steps/common.ts` `frozenPolicyCause`), so no
  rule reads it any more. A goal whose paths all lie outside the policy scope
  is `scope` by a marker the draft records (`scope` in the outcome), and a
  policy that allows no paths by one the intake gate records (`scope` in the
  gate's details). A misconfigured check was already marked by
  `misconfigured_checks`.
- **A worker that ended at a session limit is not the model.** A planner (or
  any unit without its own fallback) whose last attempt ended at the turn cap
  names `turn-cap`, and one that timed out names `environment`, which is how
  `recovery/backoff.ts` reads a timeout; a diagnosis that ran out the same way
  does too. Failed or malformed output stays `model`.
- **Mandatory verification that is unavailable names why.** When a mandatory
  check or a journey has no result, verification could not run:
  `environment`, as for issue #158. When every one of them ran, the gap is in
  what the candidate proves (it added no test, say): `turn-cap` when
  implementer sessions ended at their cap, else `model`. Run
  `orb-20261119-081756-112901` (#172) was stored as `environment` although
  both of its sessions had ended at the turn cap and its candidate added no
  test; it would now be `turn-cap`. Stored classes are not rewritten.
- The step tests now check the class each named cause gives, at every step
  that names one.
