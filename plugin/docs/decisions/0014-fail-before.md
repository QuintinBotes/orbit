# 0014. Fail-before evidence: reported always, required on request (issue #65)

Status: accepted (2026-10-12); amended 2026-10-13 (0.3.1, see the addendum)

## Context

Orbit 0.2.0, a Python repository checked with pytest. The goal asked for "unit tests under tests/ that fail
before the change and pass after". The run ended SUCCEEDED with every criterion `supported` by the
candidate's one check log, and nothing showed the new tests failing on the base revision. The
implementer's own `git stash` attempt was rightly denied (`bash.vcs-write`), and nothing else did the
check. The planner's assumption that the check runs the new tests stayed `unverified`, and the run still
succeeded. The code today:

- `newEvidenceGap` (`src/evidence/report.ts`) supports a criterion whose cited checks passed on base once
  any changed path is a test by `isTestPath` (ADR 0011). `testChanged` is set per candidate, not per check,
  so a test that cannot fail, one the check never selects, or another criterion's test supports them all.
- The `green_without_proof` challenge asks for "a test for AC-n that fails without the change; run it
  against the base and the candidate", and INQUISITION's repair brief expects exactly that. No step runs it.

Constraint (decided 2026-10-11): Orbit stays language-agnostic and does not parse test runner output.

Two designs were weighed: a strict default with a planner-set escape for refactors, and an advisory
default that is strict only when a person asks. An adversarial review of the first found that exit
statuses cannot tell a test that fails to load (a missing helper, a new symbol) from one whose assertion
fails, so a strict default would block legitimate refactors and dependency upgrades while still passing
some tests that assert nothing; and a planner-set escape hands the evidence rule back to a model. The
maintainer chose the advisory default.

## Decision

### 1. Modes

`verification.fail_before: off | advisory | required`, default `advisory`, frozen in the policy snapshot
like `allow_flaky_pass`. Only a person sets it: in `.orbit/config.yaml`, or per run with
`orbit run --fail-before <mode>`. The run flag can only raise the policy's mode (`off` < `advisory` <
`required`), never lower it, because an agent can type a command line. No contract or planner field
changes the mode or the rule.

- **off.** Today's rule, and `unverified` says the fail-before probe was not run.
- **advisory.** The probe runs and its outcome is reported per check and per criterion. No status, verdict,
  repair or question changes because of it.
- **required.** The probe's outcome decides whether new tests support a criterion (section 4).

### 2. The probe

The probe runs once per candidate that is otherwise acceptable: every required check passed, the candidate
changes at least one test-owned path, and at least one criterion cites a `test`-category command check
that passed on base. It does not run on every repair iteration. Playwright checks are not probed.

**The tree.** The base tree with every test-owned path set to its candidate state: added and modified
files take the candidate's blob and mode, deleted files are removed, and a rename is both. A test-owned
path is one `isTestPath` (ADR 0011) recognizes, plus the files only a test build reads under ADR 0011's
layouts (test directories, Go `testdata/`, JVM test source sets and their `resources/`, a test project's
own folder and project file). A source that is a test only by its content (a Rust `#[test]` in `src/`) is
not test-owned. Production code, build files, runner configuration, manifests and lockfiles stay the
base's. The tree is written in a private index (`read-tree`, `update-index --index-info`, `write-tree`),
committed deterministically with Orbit's identity, pinned under `refs/orbit/<run>/fail-before/<seq>`, and
checked out beside the candidate's check worktree; the same cleanup removes it. A path git refuses (a
file where base has a directory, a gitlink) makes the probe not established, never partial.

**Not probed.** A candidate that changes a dependency manifest or lockfile outside test-owned paths: with
the base's manifests a new test can fail for a dependency the change adds, and with the candidate's the
base code can fail for an upgraded package; either would read as fail-before. Its outcome is not
established, with that reason.

**Runs.** Each affected check runs on the probe tree with the candidate's runner context (isolation,
sandbox, hosts, toolchain cache, locked install, per-command timeout). A failing run is repeated once,
even when `flaky_reruns` is 0. The whole probe has one wall-clock bound, `verification.fail_before_timeout_seconds`
(default 900), and is skipped as not established when the run's remaining wall-time budget is smaller;
its time is charged to `wall_ms`. No model cost.

**Records.** Probe results never enter `check_runs` or `failures`: an expected failure on the probe tree
is not the run's, and diagnosis, repeated-failure counts, the baseline readers, reconcile and the learning
layer all read those tables. They go in a dedicated `fail_before_probes` table (a schema migration) keyed
by run, candidate, probe tree, check, configuration hash and attempt, with status, exit code, ADR 0010
signals and log path; logs go under `evidence/<seq>/fail-before/`. A probe interrupted by a crash is not
established and runs again on resume. Results are reused for a later candidate only when the probe tree,
the check configuration hash and the policy hash all match (a repair that changes production code only).

### 3. Outcomes

Each probed check gets one outcome, judged over every attempt:

- **failed-before.** Every attempt ended `FAILED` (at least two), and no attempt shows an ADR 0010
  environment signal, read with `BASE_GATED_SIGNALS` ungated.
- **passed-before.** Every attempt ended `PASSED`.
- **not established.** Anything else: `TIMEOUT`, `ERROR`, `CANCELLED`, a start or install failure, mixed
  results, any environment signal, a refused tree, a manifest change, or the probe budget.

The words are honest about what they show. failed-before means "the tests this check runs depend on the
change": a compile, collection or import error counts, so a test that only names a new symbol, or needs a
helper left outside test-owned paths, also fails on base. The report says "failed on the base revision with
the new tests", never "assertion failed". The granularity is the check, not the criterion.

### 4. What the outcome changes

Test evidence becomes per check in every mode: a criterion is supported through new tests only by a check
it cites that passed on base and whose run includes a test-owned change. A test change under another
criterion's check no longer counts.

Under `required`, for a criterion whose support comes from new tests:

- **failed-before** on a cited check: supported. ~~The review packet carries the probe log, and the
  reviewer brief asks whether the failure is an assertion about the criterion or only a load failure; a
  reviewer finding of a load-only failure is a blocking finding like any other.~~ Superseded on
  2026-10-13 (addendum, items 2, 3 and 5): the outcome is not a finding, and the packet shows the log's
  failing lines.
- **passed-before** on all cited test checks: unverified, with the note "the new tests pass on the base
  revision: unit passed on <base> with N test files overlaid (log), so they do not show the change, or unit
  does not run them". This goes to repair through `green_without_proof` with the probe log in the brief,
  bounded by ADR 0012's judged-tree stop, the non-progress threshold and the attempt limit. If the attempts
  run out, the run asks a person whether to accept the criterion without fail-before (a refactor or a
  characterization test). The answer is recorded, bound to the candidate tree, and listed in `unverified`.
- **not established**: the run is BLOCKED with the cause and one question per criterion: accept without
  fail-before for this tree, or not. An environment, `ERROR` or install cause is never offered for
  acceptance (ADR 0010); it is fixed, and `orbit resume` reruns only the probe.

Under `advisory`, each criterion's report entry carries the outcome, and `unverified` gains one line when
any criterion's new tests passed on base or could not be probed. Nothing else changes (and since 2026-10-13
no reviewer or inquiry is shown it: addendum, item 1).

### 5. Report and timeline

Each criterion in `report.json` gains `fail_before`: `mode`, `outcome`, `checks` (id, outcome, attempts with
status, exit code and log), `probe_tree`, `test_paths` (first 20 and a count) and `reason`. One
`verification.fail-before` decision per probe records the tree, the base, each check's outcome and the
criteria it covers; `orbit timeline` shows it as "unit failed on the base revision with the new tests (exit
1, 2 attempts): AC-1, AC-2".

## Why

A test that cannot fail is no evidence, and today the only proof that one can is a model's word. Running a
trusted check on a tree that differs from the passing base only by the new tests gives a signal from exit
statuses in any language. It is a weak signal: it shows dependence on the change, not that an assertion
discriminates. Reported everywhere, it costs one install and one or two runs per affected check and
misleads no one. Made a gate everywhere, it would block legitimate refactors and dependency changes while
passing some tests that assert nothing. So it gates only where a person asks, and even there a person, not
a model, accepts the cases it cannot judge.

## Consequences

- Every run with new tests pays one probe (an install and one or two runs per affected test check) once
  per accepted candidate. `off` avoids it.
- A criterion supported only by another criterion's test change becomes unverified in every mode.
- Rust inline tests, dependency changes and probe timeouts are reported as not established; under
  `required` they become a question.

## Not decided here

- Linking planner assumptions to criteria so an unverified assumption can gate a criterion. It ships
  separately if at all.
- Telling a load failure from an assertion failure. A runner-neutral report format a check may declare
  (JUnit XML distinguishes `<failure>` from `<error>`) could add phase evidence later without Orbit reading
  any one runner's output.

## Addendum (2026-10-13, 0.3.1): what the reviewer and the Inquisition see

The 0.3.0 retest ran the probe in Python, .NET and Node repositories. The probe did what this decision says;
what Orbit did with its outcome did not. Five changes, each with the run that showed why.

1. **Advisory and off stay out of review and out of the Inquisition.** Section 1 says that under `advisory`
   no status, verdict, repair or question changes because of the probe. Yet the advisory packet carried a
   Fail-before section, and the reviewer brief told every reviewer, in every mode, to judge the probe log. A
   reviewer raised "the fail-before evidence only shows a load failure" as a high finding: in the Python run
   (orb-20261013-080355-6ac27f) it drove two repairs and two amendments of AC-4's proof, and in the demo UI run
   (orb-20261013-080027-02f61e) two REPAIR_REQUIRED rounds. Now, under `advisory` or `off`, the packet has no
   fail-before section and no fail-before line among what is not verified, and the reviewer brief's
   fail-before paragraph applies only under `required`. So no review finding, and through it no Inquisition
   trigger, amendment or repair brief, rests on the probe's outcome or log. The report keeps the outcome for
   the person, as before.
2. **Under `required`, a compile, collection or import failure of a new symbol is fail-before, not a
   finding.** Section 3 already counts it. Section 4 then asked the reviewer whether a failure was "only a
   load failure" and made that a blocking finding. A test of a new function can fail on the base revision no
   other way, so the canonical test-first goal could not succeed: the Python required run
   (orb-20261013-081148-e86c15) and both .NET runs (orb-20261013-083016-84a30d and
   orb-20261013-083337-df06a4) ended EXHAUSTED on such a finding. The packet and the brief now say that the
   outcome is Orbit's to record and is not a finding, and ask only about the quality of the new tests, as for
   any test: a tautology, or an assertion that cannot fail with any implementation. They ask for no mutant
   run, stub implementation or probe rerun, which no check produces. That sentence of section 4 is
   superseded.
3. **A finding that only disputes a classification Orbit recorded is a note.** A repair changes the
   candidate, never the base revision, so a repair sent to answer a finding about the probe's outcome
   reproduced the same tree, and the .NET runs ended on non-progress. The review resolver now reports a
   finding whose subject is a classification Orbit made of its own evidence as an `advisory` note, recorded as
   a `review.finding.noted` decision, in every mode: it never blocks, is never a claim to test, and goes to
   neither repair nor the Inquisition. Today the one such classification is the fail-before outcome, which
   the finding's claim names and disputes (a load, compile or import failure, not an assertion); a finding
   about the tests themselves (a tautology, a test that passes for any implementation) is still a claim.
   Delivery still needs an approving review, so a review that asked for repair only through such notes
   approves nothing: the run stops BLOCKED and names them, instead of spending an attempt on the same tree.
4. **The planner does not promise fail-before.** In the required run the planner wrote AC-4, "The new tests
   fail on the base revision (ImportError for round_price)". The candidate's passing log was then cited to
   support it, and an inquiry told the implementer to keep the import error "as the contract states". The
   planner brief now forbids a criterion that the new tests fail on the base revision, and an assumption that
   a check runs the new tests: both are Orbit's to establish. The contract draft drops a criterion whose
   every clause is about tests failing on the base revision or passing, with a `contract.criterion-dropped`
   decision. A criterion that also states behaviour is kept, the other criteria keep their ids, and the last
   mandatory criterion is never dropped. An assumption that a check runs the new tests is not recognised in
   code, and the Inquisitor brief forbids an amendment that requires evidence no check produces.
5. **The packet shows the tests that failed.** The packet showed the last 2,000 characters of each probe
   log, which for a test runner are its passing suites and summary, so the reviewer never saw which tests
   failed (the demo UI run's `reviews/1/packet.md`, lines 119 to 131). Under `required`, the one mode whose
   packet still shows the probe, it now shows the lines of each log that report a failure, in any runner's
   words, with a little context, within 4,000 characters, and the head and tail of a log without one; and it
   says the log is check-wide, every test the check runs and not one criterion's.
