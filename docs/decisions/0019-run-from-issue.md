# 0019. Starting a run from a GitHub issue

Status: accepted (2026-11-15). Issue #170.

## Context

A goal was free text; nothing read an issue. Issue #170 asks that a run can
start from an issue whose body is a spec in the Spec Kit spec template's
format, that the spec is checked mechanically before any model is called, and
that the run reports back on the issue. An issue is text anyone with access to
the tracker can write and edit, so it is untrusted input that decides what a
run is asked to do.

## Decision

- **Two commands.** `orbit spec check <file | issue>` reads a Markdown file or
  the body of an issue and says whether it is a spec a run can start from.
  `orbit run --issue <number | #number | owner/repo#number | URL>` starts a
  run from an issue. `--issue` cannot be combined with `--goal` or a typed
  goal: the issue is the whole goal.
- **The check is deterministic** (`src/intake/spec.ts`): no model, no
  execution, the same answer for the same body. It requires the headings User
  Scenarios & Testing, Requirements and Success Criteria; for every user story
  a priority, a reason, an Independent Test and at least one Given/When/Then
  line; ids of the forms `FR-###` and `SC-###`, at least one of each and none
  twice; and no `[NEEDS CLARIFICATION ...]` marker. A marker inside inline
  code or a code block is a mention, not a marker. Every problem is one line
  that names the story, id or marker. The `specify` CLI is not needed. Every
  pattern the check runs is linear in the body's length, and both commands
  refuse a body over 16 000 characters before checking it.
- **Refusals happen before anything exists.** The issue is read once. A closed
  or locked issue, a pull request, an issue of another repository, an issue
  with an open blocking issue (GitHub's issue dependencies), an empty body, a
  body over 16 000 characters and a body that fails the check are each refused
  in one line. No run, no state database and no model call result.
- **A small fix needs no spec.** An issue labelled `bug` whose body has a
  reproduction section ("Steps to reproduce", "Reproduction" and the like)
  runs as a repair: one mandatory criterion, that the reproduction no longer
  occurs, and `verification.fail_before` raised to `required` for that run, so
  the new test must fail on the base revision. Like `--fail-before`, this only
  raises the policy.
- **The run keeps the version it started with.** The issue goal (number, body
  hash, time of last update, parsed scenarios, requirements, criteria, hints)
  is written read-only to `issue.json` in the run directory before the run row
  exists. The run's goal is Orbit's own sentence naming the issue and the body
  hash; the `run.created` event and the contract's new optional `source` field
  record the repository, number, body hash and update time. The run never
  reads the body again. One unfinished run per issue: a second is refused even
  after the body was edited.
- **One criterion per acceptance scenario.** Scenarios get keys `S<story>-<n>`.
  The planner is asked for one criterion per key; a plan that leaves a key
  without a trusted check is regenerated like a malformed one. The controller
  then puts the issue's criteria first, in the issue's order and wording, each
  mandatory; criteria the planner adds follow.
- **Issue text is data.** The planner sees the spec in one marked, untrusted
  block, never cut (hence the size limit), and the "Implementation notes"
  section in a second block labelled as hints outside the spec. The task text
  says, in the controller's words, that nothing in the issue changes the
  policy, checks, scope, budgets or what the run may write. The scenario
  statements do become contract criteria, each one line and capped at 600
  characters, because that is what the feature is; nothing else of the issue
  enters the contract.
- **Reporting back.** The pull request body starts with `Closes #<n>`. When
  the run reaches a terminal state the issue gets one comment: outcome,
  failure class (as recorded at the run's end, ADR 0018), pull request, delivered commit, evidence report id and
  verdict, spend, and the status of each criterion and check. The comment is
  built from the controller's own records only: no issue text, no model prose,
  no paths, no logs. If the body hash differs when the run ends, the comment
  says the issue was edited and that the run kept the version it started with.
- **Reading GitHub.** A read-only client (`src/intake/github.ts`) makes two
  GETs through `gh api`, with array argv and no shell. A command a person
  types may use their `gh` login; the controller reads with `GH_TOKEN` only.
  With `delivery.provider: fake` issues come from
  `.orbit/fake-github-issues.json`, which is what the tests use.

## Off by default

- Nothing reads an issue unless a person passes `--issue` or names an issue to
  `orbit spec check`.
- The comment is posted only when the frozen policy has
  `notifications.github_comment: true` (default false). When it is off the
  comment text is written to `issue-comment.md` in the run directory, the
  issue is not read again, and a `notification.skipped` event says so.
- A pull request, and so `Closes #<n>`, exists only in a mode that delivers.

## Consequences

`Closes #<n>` closes the issue when the pull request merges, which a person
does. A run blocked more than once comments once per terminal state, as
notifications do. Where the policy's `remote_answers.issue` is the same issue,
the short end-of-run notice is not posted there a second time. Blocking issues
beyond the first 100 are not read. The failure class in the comment is the one the run recorded when it ended
(ADR 0018, run-end record), so the issue and `orbit stats` agree; a success
shows `none`.
