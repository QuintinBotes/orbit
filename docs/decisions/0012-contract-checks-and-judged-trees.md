# 0012. Checks the contract adds run on the base revision first; a repair that returns a judged tree ends the loop

Status: accepted (2026-10-07)

## Context

Issue #32, found by the 0.2.1 retest on a .NET repository. `orbit doctor`
advised `checks.format.mandatory: false` for a `dotnet format` check that
cannot run in the macOS check sandbox (ADR 0009, addendum; ADR 0010). With it
set, PREFLIGHT skipped the check: it runs the command checks the policy marks
mandatory. The planner then cited `format` in an optional criterion, and
`draftContract` added it to the contract's required checks
(`contract.check-added: format`, "criterion AC-2 cites it as evidence"). Every
check the contract requires is mandatory for the verdict (`evaluateEvidence`),
so on the candidate `format` failed on the sandbox's refused named pipe.

ADR 0010 gates the denials it added, `pipe-denied` among them, on a candidate:
they count only when the same check's base-revision result had the same
classification, because otherwise the change may have brought the denial. The
base revision had never run `format`, so the gate could not tell the
environment from the code. The run went to diagnosis, the repair returned the
identical tree, verification reused its recorded result, and the run ended
`EXHAUSTED` with nothing explained.

Reproduced with the controller and the fake adapters
(`tests/integration/controller/contract-added-checks.test.ts`, a stand-in
`dotnet` that prints what the real `dotnet format` printed under `srt` on macOS
with SDK 9.0.305): PREFLIGHT, CONTRACTING, PLANNING, IMPLEMENTING, VERIFYING,
DIAGNOSING, REPAIRING, VERIFYING, DIAGNOSING, EXHAUSTED.

The second half of the report is the repair loop itself
(`tests/integration/controller/judged-tree-repair.test.ts`): a repair attempt
that ends on a tree an earlier attempt produced becomes the same candidate
(`snapshotCandidate`), whose recorded check results and evidence are reused, so
it is judged exactly as before. DIAGNOSING then asked for another diagnosis
and dispatched another implementer, until the non-progress threshold (three
attempts without progress by default), the diagnosis's own novelty check or the
attempt budget ended it. Each of those sessions costs money and cannot change
the outcome.

## Decision

### 1. A check the contract requires is run on the base revision before any candidate is judged

Before a candidate is judged against a contract, every command check the
contract requires that the recorded baseline has no result for is run on the
base revision, in a fresh checkout of it, and added to the baseline (a
**baseline amendment**, `steps/baseline-amendment.ts`, `runBaseline` with
`amend`). PLANNING does it for the contract CONTRACTING accepted, so before any
attempt; VERIFYING does it again for a contract an approved amendment changed
since (`add_criterion`, `add_required_checks`). PLANNING is the first step at
which the contract is the run's (CONTRACTING writes it on the transition that
leaves it), so a block there resumes at PLANNING with the same contract instead
of asking the planner again.

The amendment is recorded: the baseline keeps `amendments` (the checks, the
step, the time), the amended checks' entries and failures (a failure of a
check the policy does not mark mandatory included, since the contract requires
it), and a `baseline.amended` decision names each check, its status on the base
revision, its classification and the criteria that cite it. What PREFLIGHT
recorded for every other check, and the dependency audit, are kept. The
amendment's checkout is fresh, so the locked install runs again in it rather
than being reused from PREFLIGHT's record (a resumed PREFLIGHT whose classified
checks run again gets the same, which it lacked).

The `baseline.amended` decision is recorded once the amendment is judged: with
its block, or after its baseline-exception questions and expected flips. An
amendment the baseline records without that decision was cut short in
between (a crash, a failed step), so the next pass amends again for its checks
instead of taking them as judged: a failure of the code is reused as recorded
(`runBaseline` reuses a final base run that carries no classification), a
classified one runs again, and either is judged as above. Otherwise such a
pre-existing failure would never be asked about. A later amendment that judged
the same check settles it; only the latest amendment of each check counts.

Each amended check is classified exactly as PREFLIGHT classifies a mandatory
one (ADR 0010), and the outcome is the same:

- **An environment failure or a misconfigured check blocks the run**, at the
  step that ran the amendment, with PREFLIGHT's reason and one more sentence,
  second: "The contract requires check format (criterion AC-2 cites it as
  evidence), which the policy does not mark mandatory, so it was run on the
  base revision before any change was judged (a baseline amendment)". The
  decisions `baseline.environment-failure` and `baseline.check-misconfigured`
  carry the step. An environment block is cleared by fixing the environment
  and `orbit resume`: the next amendment runs the classified check again (its
  recorded result is set aside, as for a resumed PREFLIGHT).
- **A missing target is settled against the contract**: expected to flip when
  a criterion names the check, misconfigured (the CONTRACTING block of ADR
  0010, at this step) when none does. It is judged again on every PLANNING
  and VERIFYING pass, against that pass's contract, and only while the
  contract requires the check: an approved `remove_required_checks` that
  drops it (from the required checks and every criterion) leaves nothing to
  judge, since verification never runs it.
- **A pre-existing failure follows the existing rules**: a
  baseline-exception question, withdrawn when the contract names the check as
  the proof of a criterion (P18); and on a candidate the same failure with an
  environment cause blocks as ADR 0010 says.
- **A pass establishes a clean base**: a failure on a candidate is the
  change's, and goes to repair.
- **A check the runner could not start at all** (status `ERROR`: an argv
  command whose executable is missing, say) has no output to classify and no
  result. The amendment records it so (`lint ERROR` in `baseline.amended`) and
  the run goes on, as PREFLIGHT goes on for a mandatory check it could not
  start (`gate.baseline` unverified). It is not counted as covered, so every
  later amendment runs it on the base revision again, and its run on the
  candidate blocks the run for the environment (ADR 0010's rule for a check
  that could not execute), after the first attempt. Blocking such a check
  before any attempt would treat an amended check more strictly than a
  mandatory one; it was found by the final review and left as it is for both.

With this, every check a candidate is judged on was run on the base revision
first (until a rebase, below), so ADR 0010's candidate gate has the base result
it asks for, except for a check that produced no result there, as above.

An amended check's missing target and PREFLIGHT's are judged at different
times, and this is intended. PREFLIGHT's mandatory checks are judged at
CONTRACTING, as ADR 0010 says, and a later contract amendment does not judge
them again: the candidate's result does. An amended check is judged at the
step that ran it, on every pass, so it also sees a later amendment: one that
keeps the check required while no criterion cites it any more
(`remove_criterion`, or `remove_required_checks` for one criterion) blocks the
next VERIFYING as misconfigured. The two differ in why the contract requires
the check. A mandatory check is required by the policy whatever the contract
cites. An optional check is required because the contract asks for it, almost
always because a criterion cites it (`contract.check-added`), and a check the
contract requires that names something the base revision lacks, with no
criterion saying the goal creates it, is exactly the misconfigured check of
ADR 0010, whenever that comes about. Judging mandatory checks again after an
amendment would change a released rule nobody reported a problem with, and
would block a run whose candidate already created the target.

### 2. The planner may add a check the policy does not mark mandatory; doctor never offers "optional" as a fix

`mandatory: false` keeps its meaning: the check is not required of every run,
and a contract requires it when its goal needs it. That is the only thing an
optional check is for (nothing else runs it), so forbidding the planner to name
one would remove the setting. A check a contract requires is held to what a
mandatory one is held to, the baseline included, so making a check optional is
no way around a check that cannot run in the sandbox. Doctor's advice says so:
the fix for a `dotnet format` check that cannot run (`formatOutsideFix`) is to
remove it from `.orbit/config.yaml` and run it in CI, no longer "or set
`checks.<id>.mandatory: false`", and the run's block reason gives the same fix.
An optional check doctor finds refused is still a warning, not a failure, and
its summary says what happens: "a run whose contract requires it would block at
its baseline". The planner is told, when the policy has an optional check, that
naming one runs it on the base revision first and stops the run if it cannot
run there, so it names one only as the proof of a criterion that needs it.

### 3. A repair that ends on an already judged tree ends the repair loop

In DIAGNOSING, before any diagnosis is asked for: when the latest attempt
produced the current candidate, an earlier attempt produced the same candidate
(the same tree), and verification judges it `FAIL` exactly as it did before the
latest attempt started (the verdict, the checks that did not pass, each
criterion's status and the UI journeys, compared), the run ends `EXHAUSTED` as
non-progress (`stalledRepair`): "attempt 2 ended on tree <tree>, the tree
attempt 1 produced, and verification judged it FAIL again as it did then
(failing: unit): the same evidence, diagnosis and repair brief would follow, so
no further attempt is dispatched on it". A `repair.non-progress` decision
records the attempt, the earlier attempt, the tree, the verdict and the failing
checks. A tree that undid a later attempt (attempt 3 back to attempt 1's tree)
stops the same way. That stop is conservative, not exact: the next attempt would
start from the tree and the evidence attempt 2 started from, but its diagnosis
would also know attempts 2 and 3 and their hypotheses, so it might brief a
repair that works. It is kept because such a run has already gone round once
on that tree and the stop never passes a tree; the maintainer is asked to
confirm it (final review).

It does not stop, and the loop goes on under the existing rules, when the tree
is new, when its judgement changed since (a contract amendment or an approved
baseline exception that re-judged it), when a person resumed the run or
asked for the repair (`orbit repair`) after the latest attempt started (an
answer or a repaired environment is new information), or when the latest
attempt's session stopped before it finished (max turns, a timeout, a
failure, malformed output: the `implementation.worker-ended` event). Such a
session never judged the tree it left, so its tree says nothing about what
the brief can achieve, and `EXHAUSTED` is terminal: there would be no way to
ask for the attempt it did not make. The non-progress threshold, the
diagnosis's novelty check and the allowance still bound such attempts.
`orbit repair` records its request (`run.repair-requested`) also for a run
paused in DIAGNOSING, where it makes no transition, before it unpauses it.
When an open material question blocks a criterion, the run ends `BLOCKED` for
the answer instead, as a stalled review repair does (`stalledReviewRepair`,
which already ended the review loop the same way). Everything else about the budget is unchanged: the
non-progress threshold, the allowance and its extension, and the hard caps.

### Limits

- A rebase in AWAITING_CI moves the run to a new base revision, and the
  recorded baseline is of the old one, so a baseline amendment after it finds
  no baseline to amend and does nothing. Every baseline-dependent gate has the
  same limit today (ADR 0010's candidate gate reads no base result after a
  rebase either); running the baseline again on the new base is a separate
  change.
- The stop of section 3 covers the repair loop of DIAGNOSING, whose candidate
  verification judged `FAIL`. A CI repair (AWAITING_CI) repairs a candidate
  verification judged `PASS`, so there is no verdict to compare; it stays
  bounded by the CI repair cycles (`delivery.max_ci_repair_cycles` within
  `scheduler.hard_limits.ci_repair_cycles`).

## Why

An environment failure misread as a code failure costs a diagnosis and an
implementation session per attempt and ends in an outcome that explains
nothing; read at the baseline, it costs one check run and ends in a block that
names the cause and the fix. Running a required check on the base revision is
what PREFLIGHT already does for a mandatory one; doing it for the checks a
contract adds closes the one way a required check reached a candidate without
a base result. A repair that reproduces a judged tree cannot be judged
differently, since its check results are reused, so continuing only spends.

## Consequences

- A run whose contract cites an optional check that cannot run in the sandbox
  ends `BLOCKED` at PLANNING after the planner, before any implementer, with
  the cause and the fix; doctor warns about such a check beforehand with the
  same fix. A check whose command cannot be started at all blocks only on the
  candidate, after the first attempt (section 1).
- An optional check a contract requires runs on the base revision once per run
  (and again after a resume that follows its block), which takes the check's
  time before the first attempt.
- A run whose repair returns the same tree ends after two implementer sessions
  and one diagnosis, not after the non-progress threshold, when the repair's
  session finished; one that stopped early is followed under the existing
  rules.
- `baseline.json` may carry `amendments`, and `failures` may hold a check the
  policy does not mark mandatory. Readers that took every failure to be a
  mandatory check's (the candidate gate, baseline exceptions, P18) now see the
  amended ones too, which is the point.
