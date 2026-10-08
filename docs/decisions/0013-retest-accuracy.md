# 0013. Advice and records say what is true: the 0.2.1 retest (issue #33)

Status: accepted (2026-10-07)

## Context

The 0.2.1 retest ran Orbit on a .NET repository and compared every message and
record with what had really happened. None of the findings is a wrong result;
each is a sentence or a record that said more, or less, than was true:

- Doctor kept warning about a fix already applied, and about nothing that
  would happen.
- Doctor said the dependency install restores from the filled NuGet cache, and
  that workers would load, and a report list, plugins that no session loaded.
- The CLI's closing line and `orbit status` pointed at `orbit resume` where a
  resume only blocks again.
- A run blocked at its baseline recorded `gate.baseline` as pass and
  `baseline.recorded` as complete, while `baseline.json` said incomplete.
- `gate.ui` was a pass where nothing was evaluated.
- A curator session ran for a run blocked at PREFLIGHT, and `orbit report`'s
  cost left it out.
- `orbit init` said Codex reviews when usable while its template keeps it from
  reviewing; its closing line asked to define checks that were defined.
- Report and status named a branch that does not exist.
- A route reason quoted the router's failure while the route had been chosen.

Each was confirmed against the run records. The causes differ, so the decisions
below are per area. They share one rule: a message states what Orbit observed or
decided, not what a template of the message assumed.

## Decisions

### Doctor says no more than it knows, and does not repeat advice already applied

`checks.sandbox` on a check that is not mandatory: PREFLIGHT's baseline runs
mandatory checks only (`evidence/baseline.ts`), so "a run would block at its
baseline" was more than doctor knew. Nor is a refused optional check harmless: a
run whose contract requires it runs it on the base revision first and blocks
there as for a mandatory one (ADR 0012). So the warning stays, and its summary
says that a run whose contract requires the check would block at its baseline,
whatever the cause of the refusal (a `dotnet format` that cannot run at all, a
build without `-m:1`). It says "a run would block at its baseline" only where
every run would: the dependency install, a mandatory check, or a toolchain a
mandatory check uses is refused. Where optional checks are refused beside the
application or a release command, it says a run would fail where Orbit starts
them.

The 0.2.1 retest saw doctor repeat "or set `checks.X.mandatory: false`" to a
check that already had it. ADR 0012 takes that half out of the fix for a `dotnet
format` that cannot run (`formatOutsideFix`): remove the check and run it in CI.
The fix doctor gives an optional check is never one it already has. The first
version of this change made such an optional check a pass, with a detail line
saying a contract that names it would fail where its checks run; that rested on
the baseline never running an optional check, which ADR 0012 changed, and was
dropped when the two were combined.

`checks.dotnet-packages`: a cache that holds packages is a pass that says so,
with no fill command; it warns only for an empty cache, or for a floating version,
which a restore looks up at nuget.org however full the cache is (the fix is then
the pin alone). Doctor cannot tell whether a filled cache is stale, so the pass
points at the way to fill it again without printing the command.

What restores from the cache is stated from what runs. Orbit's own dependency
install is `npm ci`, skipped without an npm lockfile ("no lockfile to install
from"), and restores no NuGet package; only a configured
`dependencies.install_command` can. Doctor says "the dependency install and the
checks" when that command restores packages and "the checks that restore"
otherwise, with the reason; the toolchain line's "written by the dependency
install" is likewise said only when an install is configured. Making the claim
true instead (a default `dotnet restore` install) was rejected: it would add an
install step, a network access and a failure mode to every .NET repository to
fix a sentence.

`claude.plugins`: workers start with `--setting-sources ""`. Measured with Claude
Code 2.1.292 and plugins of scope user: a session loads only the built-ins.
Managed plugins are known to load (the session of issue #22 was refused for them,
at collection). A scope doctor cannot place is "may load", also once the policy
allows it, and the report lists what the sessions reported, so doctor says that a
session that loaded none adds none. The report itself is unchanged: it lists the
plugins in the workers' results, which was always true.

### One judgement of whether a resume can clear a block

`newRunNeeded` (`controller/resume.ts`) returns why a resume cannot clear a
BLOCKED run, or null. Two causes:

1. the block is from the frozen policy (the existing marker);
2. a candidate's check could not run for an environment cause and there is no
   baseline exception to approve. `verifying.ts` records such a block with the
   candidate's id and a question id per failure that has one. A resume returns to
   VERIFYING, where the evidence for the candidate is fresh (the policy is frozen
   and nothing of the tree changed), so it is judged again and blocks again,
   whatever is repaired outside. A failure with a baseline-exception question is
   answered instead, and the run resumes. A PREFLIGHT environment block is not
   this: a resume runs its baseline again, which is why it is marked incomplete.

A third cause, "every implementation attempt is used and the stage a resume
returns to spends one", was first included and then removed (review of this
change). The counter is charged when an attempt starts (`startAttempt`), so a run
that blocks in the middle of its last attempt (a supervised authorization
question, an expired login, transient provider failures) has it full, and a resume
goes to `implementingStep`, which calls `continueAttempt` for that same attempt
and spends nothing. Reproduced: supervised mode, `implementation_attempts` 1, a
denied `chmod` in attempt 1; the run blocks at IMPLEMENTING with a question open,
the rule said "a new run is needed" and the closing line withheld "answer with
orbit decide", yet approve-once and a resume ended the run SUCCEEDED. Where a
resume would start an attempt with none left, the run does not block: the counter
refuses the charge (`BUDGET_EXHAUSTED`), and `diagnosingStep` and `reviewingStep`
check it first, so each ends EXHAUSTED. No block exists that a full counter
describes, so the rule could only advise wrongly. Limiting it to a run with no
attempt in progress was rejected for the same reason: it would describe states
the controller does not produce, and need an event lookup in the advice path for
them.

The CLI closing line, `orbit status` ("a new run is needed: ..." in place of
"will return to"), the report's next action and the notification use it, so they
cannot disagree. For a frozen setting that a fix outside the policy can clear
(`frozenPolicyForceHelps`, now in `resume.ts` with the rest of this judgement:
`providers.<x>.model` after `orbit models refresh`), the stage line adds that
`orbit resume --force` is the other way forward, as the outcome reason does. It
is decided before the open questions: with the policy frozen no answer makes
"then resume" right. `orbit resume` itself still resumes such a run (a person may
know better; `--force` exists for frozen policy for that reason); only the advice
changed.

### The baseline is judged as it is recorded

PREFLIGHT classified the base revision's failures (ADR 0010) after `runBaseline`
had written `baseline.json` and recorded `baseline.recorded` (complete: true) and
the gate had passed; only `blockOnBaseline` then rewrote the file as incomplete.
`runBaseline` now takes a `settle` step that PREFLIGHT uses to classify, after the
checkout is removed as before, so file, event and gate are made from one report. A
check that never produced a result of its own (environment, misconfigured) makes
the baseline incomplete; a missing target does not (CONTRACTING acts on it). The
gate for an incomplete baseline is `unverified` (it already was, by definition),
not pass. A reused baseline is classified by PREFLIGHT as before. A `settle` that
throws records neither the file nor the event: an unjudged baseline would say
"complete" again, which is what this change removes, and the step's retry (bounded
by `infrastructure_retries` and the step error limit) measures again. Recording
the unjudged report first, as the code did before this change, was considered and
rejected for that reason. A baseline amendment (ADR 0012) is not settled by
`runBaseline`: its caller classifies the checks it ran (`classifyBaseline`, the
same classification) and writes the file, and it leaves the baseline complete,
since the classification it records is what makes the next amendment run the
check again.

### `not_applicable` is a gate status

`uiGate` returned pass with the evidence line "no UI path changed", though
nothing was evaluated. A gate with nothing to judge is `not_applicable`: it blocks
nothing (`passed` is true), cites no evidence (so the learning layer does not take
its record for an observation), and says why in a note. A note of a gate that is
not applicable is the reason, recorded with the decision; it is not a claim that
something was left unchecked, so verification does not copy it into the report's
`unverified` list (and so not into `final.md`, the pull request body or
`orbit verify`). Adding a status was preferred to leaving the gate out of the
record: the record of the gate sequence stays complete, and says what it did.

The baseline gate uses it too (final review): with no check the policy marks
mandatory, no locked install and no dependency audit, PREFLIGHT ran nothing on
the base revision, yet `gate.baseline` was `pass` with the evidence "0
check(s)". It is now `not_applicable`, saying why. The checks a contract
requires then run through a baseline amendment (ADR 0012), which recorded no
gate; an amendment the run goes on from records `gate.baseline` again, with the
checks it ran, so the latest record says what the base revision ran.

### Learning starts only for a run that did something

`gate.*` decisions cite the evidence they looked at, so every run, however early
it ended, reached the curator as observations. A run with no worker session
(blocked at PREFLIGHT) has nothing of the repository to learn from, so
`learnAtTerminal` skips it and records why. The final report is written when the
run ends, before the curator is charged, and `orbit report` prints that file; it
is written again after learning when a curator ran. Reading the usage rows in
`orbit report` instead was rejected: the report is a record of the run at its end,
and one source for its numbers is simpler than two.

### init reads the configuration it wrote

The review sentence is chosen from `providers.codex.data_policy_eligible` of the
configuration on disk (false in the template, which says how to enable it), and
the closing line from the checks that configuration defines, not from the
proposals, which an existing configuration never has. `--json` gains
`checks_defined`; `checks` is unchanged. A configuration that fails validation for
another reason still defines checks: their ids are read from the YAML without
validating it (nothing is read from a file that is not YAML), and the closing line
says to fix the listed problems, not to define checks. Codex's eligibility is
still read only from a configuration that validates.

### Refs that exist

PREFLIGHT chooses `orbit/<run>` and records it on the run, but the branch is made
at DELIVERING (a local mode points it at the candidate; a delivery mode pushes
it). `controller/run-refs.ts` names it only once it exists (the outcome of a local
delivery, a succeeded run, or a recorded delivery) and gives the candidate ref
(`refs/orbit/<run>/candidates/<seq>`) that exists from the first snapshot. `branch`
in status and report JSON is null until then (it was the planned name), and
`candidate_ref` is new. The next action for a succeeded run with no recorded
branch points at the candidate ref and no longer invents a branch from the run id;
the notification's next action does the same (a final review found it still
named `orbit/<run>`): it names the branch delivery created, else the candidate
ref, else the report.

A branch can exist before a delivery is recorded, and two such cases were
missed. A local delivery made the branch (`update-ref`) and only then ran the
delivery gate, whose refusal blocked the run with a branch behind it: the gate
now judges the tree the branch will carry (the candidate commit's, which is what
the ref pointed at) first, so a refused delivery leaves no branch and the answer
"none" stays true. A delivery mode can push the branch and then fail (the pull
request, the gate on the delivered tree) before `delivery.completed` is recorded:
`createdBranch` also reads a successful `push` action of the run (its target ref,
which `deliver` writes) as proof the branch exists. A failed or unknown push does
not count.

### The route reason

The reason of a route made with no validated model was the router's own failure
message. It now says that no model is validated yet and that the allowed one was
chosen; the summary says the first successful session validates it. That holds
only while nothing allowed is validated. The router also reports "no eligible
claude-cli model" for a validated model it does not take (a tier it does not
justify, such as Fable alone allowed and not warranted), and the fallback can
choose a model whose surface is `available: true`; then neither "not yet
validated" nor "no model is validated" is true. The reason is chosen from the
registry (is any allowed claude-cli model validated), not from the error alone:
where one is, the decision says the model was chosen although the router
reported its message, and `unvalidated` is true only when the chosen model's
surface is not available. Reading the router's `excluded` details instead was
considered: they list models by reason, and the fact the sentence needs (is
anything validated) is in the registry itself.

## Consequences

- Messages changed (doctor details, closing lines, the init sentence, route
  reasons); the machine-readable fields are additive except `branch` of status and
  the report, which is null where it used to be a name nothing had created, and
  the status value `not_applicable` of `gate.ui` and `gate.baseline`. `docs/`
  and the plugin skills say so.
- Doctor's pass for a filled cache rests on the advice having been applied.
  Doctor still warns about an optional check the sandbox refuses, since a run
  whose contract requires it blocks at its baseline (ADR 0012); the summary says
  which run.
- The environment block that needs a new run is recognised from the outcome
  recorded by `blockOnEnvironment`; a block recorded by an older Orbit (no
  candidate id) keeps the old advice.

## Verification

Each change has a test that failed first: `tests/unit/cli/doctor-check-sandbox.test.ts`,
`doctor-dotnet-packages.test.ts`, `doctor-worker-plugins.test.ts`,
`tests/unit/adapters/worker-plugins-check.test.ts`, `new-run-advice.test.ts`,
`candidate-ref-naming.test.ts`, `init.test.ts`, `tests/unit/controller/gates.test.ts`,
`coverage-report-curator.test.ts`, `coverage-workers.test.ts`, `coverage-verification.test.ts`, and the integration
tests `baseline-environment.test.ts`, `base-failure-classification.test.ts`,
`runs.test.ts` (also: no UI line among the unverified items of a run with no UI),
`supervised-authorization.test.ts` (a block in the last attempt still resumes) and
`knowledge/curator-worker.test.ts`.
