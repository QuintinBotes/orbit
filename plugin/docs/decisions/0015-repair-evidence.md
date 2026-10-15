# 0015. A repair's test resolves a finding only when it discriminates

Status: accepted (2026-10-13), amended the same day after an adversarial review of the first probe rule

## Context

When a review finding asks for a repair, the implementer writes a fix and usually a test for it. Orbit then
decides whether that test resolves the finding. In 0.3.0 the rule was "a test exercising the claim passes on the
repaired tree", and the 0.3.0 retest showed a high test-quality finding closed because a lint check passed on a
newly written test file.

The first 0.3.1 fix credited a test check whose log named the repair's test. Three adversarial reviews then broke
every version of that rule: a check credited for a test its command excludes, a skipped test counted as run, a
title matched inside another test's title, a sibling test's pass credited to a skipped one, glyph-only skip and
todo markers (the repository's own vitest prints none of the words), a compile warning that names the file. Each
fix added runner-specific reading of test output. Orbit is language-agnostic (decided 2026-10-11) and does not
parse test runner output; deciding evidence from that output is not safe however it is tightened.

The first version of this decision ran each check once on the pre-repair tree with all of the repair's
test-owned changes. A fourth adversarial review showed that this tied the failure to the repair's test changes as
a whole, not to the finding's own test: a skipped test named for one finding was credited with another finding's
failing test, with an unnamed edit to an existing test, with a test that only a second check runs, and with a
pre-repair tree that failed the check by itself (which a baseline exception lets reach review). It also found a
test named for TEST-10 credited to TEST-1, whose id it contains, and a test the review of its own repaired tree
held insufficient credited on a later tree whose repair named no test.

## Decision

A repair's test resolves a review finding only when it discriminates, judged by exit statuses alone, with the
machinery of ADR 0014's fail-before probe:

1. Name the tests. The tests named for a finding are those the implementer's report names for it (in
   `evidence_refs` or `tests_added`) by its fingerprint or its external id as a whole token, so TEST-1 is not
   named by TEST-10, among the paths the repair changed. An external id is unique only within one review, so among
   the findings that share one, an id names those whose fingerprint the reports cite for the same file, when they
   cite any. Only test-owned
   paths (ADR 0014 section 2) can be probed. A file named for more than one finding, of any repair, resolves none
   of them: a check runs whole files, so a failure in it cannot be tied to one finding's test (a test in a file of
   its own can resolve it).
2. Build three probe trees, built the same way and run in the same probe checkout. Two start from the pre-repair
   candidate's tree, its production code unchanged:
   - the **control tree**: the repair's test-owned changes (added, modified and deleted test files) in their
     repaired state, except every test the reports name for a finding, which keep their pre-repair state;
   - the **finding's tree**: the control tree with the tests named for the finding in their repaired state.

   The third is the **repaired tree** itself, the pre-repair tree with every change of the repair, so the
   finding's tests fail before and pass after in one place: a test that fails for the probe checkout's own
   directory or artifacts directory fails on the repaired tree too.
3. Run each required command check of category `test` that passed on the repaired candidate, whose `cwd` holds
   one of the finding's tests, and whose latest run on the pre-repair candidate passed cleanly (not after a rerun),
   on the trees, with the same runner context, repeating a failure once, within one bound per tree. The control
   tree and the repaired tree are run once for all the findings of a repair (the repaired tree only for the checks
   that passed on the control tree), and a tree's decisive results are reused by tree.
4. The finding is resolved by its tests only when a check PASSED on the control tree, PASSED on the repaired tree
   in the probe checkout, FAILED on every attempt on the finding's tree with no ADR 0010 environment signal and its
   logs read whole (ADR 0014 section 3), and PASSED on the repaired candidate. The failure is then the finding's own
   tests', not another finding's test, an unnamed test change, a check its command never runs it in, a pre-repair
   tree that fails by itself, or the probe checkout. A pass on
   the finding's tree (the tests are skipped, filtered, never run by the command, or do not check the fix) leaves
   the finding open; so does a failure on the control tree or on the repaired tree in the probe checkout, a check that did not pass cleanly on the pre-repair
   candidate, and anything not established (timeout, error, environment, manifest or lockfile change in the
   repair, unreadable log, the bound), each with the reason.
5. Nothing reads test output to decide which tests ran. The old log-naming and "only runner" rules are removed.
6. A finding left open goes where an open finding goes today: back to repair, to the Inquisition, or to a person,
   within the existing caps. A review of the repaired tree that raises the finding again keeps it open whatever
   the probe showed, and so does a review of any later tree that already had the test: that test never resolves
   the finding on a later tree, even when the next repair names no test and the finding falls back to it. A
   resolved finding names the attempt whose test resolved it.

## Limits

As in ADR 0014, a compile or import failure of a new symbol on the finding's tree counts as failing: the probe
shows that the test depends on the repair, not that each assertion checks it.

A test may also fail on a probe tree for a reason that involves neither the fix nor the repair. Since the
repaired tree runs in the probe checkout too, the checkout's directory and artifacts directory cannot be that
reason. The probe commits still differ from each other and are pinned under different refs, so a test that reads
the git metadata can tell the trees apart, and a test can read the production files and fail only where they lack
a change that is no fix at all. Exit statuses cannot tell such a test from one that checks the fix. The review of
the repaired tree is the only defence against it, as for a test that asserts nothing.

A file is the smallest unit a check runs, so the finding's tests are judged as whole files: a file named for one
finding that also holds an unnamed test which discriminates is credited with that test's failure.

## Consequences

- Per repaired finding and test check, no model cost: one run on the control tree and one on the repaired tree,
  shared by the repair's findings, and one run (two when it fails, as it must to resolve the finding) on the
  finding's tree.
- Two findings of one repair whose tests each discriminate under one check are both resolved: each finding's
  tree holds only its own named tests. Their tests must be in separate files.
- Findings that a test cannot discriminate (a refactor, a documentation fix) are resolved only by review or a
  person, never by a test.
- A check whose command names the repair's new test file cannot pass on the pre-repair tree without it, so it
  never resolves a finding; checks that discover their tests are unaffected.
- Results are recorded like probe attempts (ADR 0014 section 2), never in `check_runs` or `failures`: one
  `review.repair-probe` decision per probe tree: the control tree's, the repaired tree's and each finding's.
