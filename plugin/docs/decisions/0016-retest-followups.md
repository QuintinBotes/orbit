# 0016. The 0.3.1 retest's open items: probe-decided statements, implementer speed, shallow reviews, ui probes

Status: accepted (2026-10-15)

## Context

The independent audit of the 0.3.1 retest confirmed the 0.3.0 retest's main failures fixed, and left six 0.3.0
items open. The maintainer held 0.3.1 until all six are fixed and chose each design below.

1. The planner writes criteria and assumptions only Orbit can establish ("the new tests fail on the base revision",
   "the unit-tests check runs the new tests"), although its prompt forbids both. A run then succeeds with them
   unverified, or "supported" by a passing test log that says nothing about the base revision.
2. The demo takes about 20 minutes, not 13. The ui goal's first implementer session took 11 of them: it ran at
   xhigh effort, hit its 30-turn cap, and spent turns on denied commands. Its session output (45,643 tokens) was
   also reported as exceeding its output budget (24,000).
3. Codex reviews read only the packet: no tool calls and a few hundred reasoning tokens, although they could open
   files. The report says so ("NO TOOL CALLS") but an approval still clears the tree.
4. Fail-before probes only command checks of category `test`, so browser journeys (category `ui`) get no
   fail-before evidence ("ui is not probed").

## Decision

### 1. The fail-before probe decides statements about fail-before

A contract criterion that states its tests fail on the base revision (or before the change), and an assumption that
a check runs, discovers or collects the new tests, are flagged by their wording. Wording only ever makes Orbit
stricter here: a flagged statement is never credited by its wording, only by the probe. Its status comes from the
fail-before probe of its check (a criterion's proof checks; the check an assumption names, or every probed test
check when it names none): `failed-before` on every such check supports it, anything else leaves it unverified, with
the probe's outcome as the reason. A passing log of the candidate never supports it. With `verification.fail_before:
required`, an unverified flagged statement blocks success like any unmet requirement; with `advisory` it is a
residual risk in the report.

### 2. Implementer speed

- The implementer brief names the commands that were refused in the retest and are always refused: inline code
  (`node -e`, `python -c`), which Claude Code's own command check refuses in a headless session even inside the
  sandbox, and reads outside the worktree. Pipelines into read-only filters already run: the retest's `npm test 2>&1
  | grep` was refused for the `node -e` in the same call, so no shell policy changes.
- A prediction raises a routine implementer's effort at most to `high`: a complex classification and a planned
  coupled change are predictions, not observed difficulty. Only observed difficulty (repeated equivalent failures)
  raises it further, as ADR 0001 already does for the tier.
- The output budget is an instruction about the final structured output, so the overrun event compares that output
  with the budget, not the session's total output, which includes every file the session writes.

### 3. A review that inspected nothing does not clear the tree

An APPROVE whose recorded depth shows zero tool calls, on a tree that changes files, does not clear it. One fresh
review is asked at `high` reasoning effort with a brief to open the changed files and tests before the verdict. If
that review also makes no tool call, the run blocks with the reason instead of passing on a packet-only review. A
review of a tree that changes nothing, and a provider that records no depth, are unaffected.

### 4. Fail-before probes ui journeys

A browser check (a journey check of `ui.journey_check_ids`, or a check of kind `playwright`) whose directory holds a
journey the candidate adds or changes is probed as a test check is: it runs on the base revision with the candidate's
test-owned changes, through the same ui runner and app fixture as verification, and its outcome is recorded per
criterion as a test check's is. The baseline runs command checks only, so a browser check has no result on the base
revision to stand for the probe's control: the probe runs the same journeys on the base revision alone first, once per
run (the result is reused by tree), and a failure is the new journeys' only when that control passed. A failure of the
app or the browser to start, or any process that never reached the repository's code, is an environment cause and
establishes nothing. It adds one browser run per candidate (two when it fails) and one control run per run.

## Limits

The wording that selects a statement for item 1 is a strict grammar, on purpose: the active form ("the unit-tests
check runs the new tests") and one passive shape ("the pytest suite is run by the unit-tests check": the tests, a form
of be or get with the participle, "by", then short agents of which one is a check). Adversarial reviews found a looser
match flagging ordinary sentences ("run by CI without the lint check", "The tests start after ESLint is run by the
lint check"), which under `required` would block a valid run for want of a probe of that check. A phrasing the grammar
misses keeps the planner's own status, as every release before 0.3.1 did, and the planner's brief still forbids such
assumptions; a negated statement is never selected.

## Consequences

- A run whose planner writes a fail-before statement succeeds in advisory mode with it supported or listed as a
  risk by the probe's outcome, never on wording, and blocks in required mode until the probe supports it.
- Routine implementer sessions run at `high` unless failures repeat; the demo's time is measured again by the next
  retest against 13 minutes.
- A packet-only approval costs one more review round, and blocks a run whose reviewer never inspects the change.
- Probing ui journeys makes runs with browser criteria slower by one or two browser runs per candidate, and one
  control run per run.
