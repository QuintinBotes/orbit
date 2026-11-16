# 0020. Working a backlog of issues in dependency order

Status: accepted (2026-11-15). Issue #171.

## Context

ADR 0019 lets a run start from one issue. Nothing took the next one: the
service runs every detached run at once, each from the same base, with no
order, so a set of specs still needed a person to start every run and to
remember what blocks what. Issue #171 asks for a queue that takes only the
frontier of open, unblocked issues labelled `ready-for-agent`, one issue at a
time, each from the base as it stands after the last delivery, and that stops
cleanly.

A project can keep a backlog against a branch that is not the default one
(this repository works its specs against `next`). GitHub closes an issue from a
pull request's `Closes #n` only when the pull request merges into the default
branch, so an issue whose work merged into `next` stays open, and with it every
issue it blocks.

## Decision

- **Two commands.** `orbit queue list` shows the frontier and why every other
  issue waits; it writes nothing. `orbit queue run` works the frontier in this
  process, one issue at a time, exactly as `orbit run --issue <n> --foreground`
  runs one issue (the same intake, admission, refusals and controller).
- **The backlog and its order.** `--parent <issue>` takes that issue's
  sub-issues in the parent's order; without it, the open issues carrying the
  label, oldest first. That order is the priority. Sub-issues of another
  repository are left out. Up to ten pages of 100 issues are read.
- **The frontier is read from GitHub each time** (`src/intake/backlog.ts`,
  pure): every open issue that carries the label (`--label`, default
  `ready-for-agent`), does not carry the label that hands an issue to a person
  (`--human-label`, default `ready-for-human`), has no open blocking issue in
  GitHub's issue dependencies, and is not already Orbit's. An issue is Orbit's
  when a run started from it is unfinished (#139), or when a run started from
  it succeeded and its delivery waits to be merged; a pull request closed
  without merging gives the issue back, so while it carries the label it is
  taken again. Every other open issue is
  held with one line saying why, naming each blocker and what holds that
  blocker. Issues that block one another (a cycle, found as a strongly
  connected component) are reported and none of them runs.
- **One issue at a time, from the current base.** A run starts from the commit
  checked out, so before each issue the queue fetches the base branch
  (`--base`, default `repository.base_branch`) and fast-forwards the checkout
  to it. A checkout on another branch, or a base with commits the remote does
  not have, stops the queue. `--base` is validated as if the policy file said
  it, and every pull request targets it.
- **A dependant waits for the merge.** A delivered issue is closed when its
  pull request has merged into the base branch: by GitHub for the default
  branch, by the queue (a comment naming the pull request, then the close)
  for any other. Only then does a dependant enter the frontier. When the
  frontier is empty but held issues wait on deliveries, the queue looks again
  every minute for up to `--wait-minutes` (default 60). A delivery without a
  pull request (a mode that does not deliver) waits for a person to merge it
  and close the issue. The queue merges nothing: a person merges each pull
  request, and the queue waits. A run in `release` mode with `actions.merge`
  does not merge on its own either: its contract starts with `merge: false`,
  and only a person's approval for that run turns merge on
  (`src/contract/draft.ts`).
- **Attempts and a person.** An issue gets up to `--attempts` runs (default 2).
  A run that ends waiting on an answer is not tried again: a new run would only
  guess. An issue whose runs did not deliver, or whose body fails the spec
  check (refused before any run), is labelled `ready-for-human` and gets one
  comment built from the controller's records (each run's id, state, failure
  class and spend; for a spec, the check's problems). The label keeps every
  later queue off it, so its dependants stay held.
- **Stop rules.** The queue stops when the frontier is empty (after any
  wait), at `--max-issues`, at `--budget-usd`, after two runs in a row end
  without a delivered change (FR-004: on one issue or across issues, a
  delivered run resetting the count; the issue still goes to a person as
  above, and no further run starts), on Ctrl-C (the run is paused, as in a
  foreground run) or SIGTERM (the run stops where it is; no failed run is
  counted and the issue keeps its labels), and on an error that is the
  queue's rather than an issue's (admission, the base branch). Each run's
  `scheduler.hard_limits.model_cost_usd` is lowered to what is left of the
  budget. A run that ends EXHAUSTED under that lowered cap because the money
  ran out stops the queue and does not hand its issue to a person. The money
  ran out when the ending names the cost counter (a cost refusal or the cost
  cap, whatever caused the run trouble first), or when the ending names no
  counter and `budget` is the run's only cause. The failure class alone cannot
  say, since every EXHAUSTED run gets `budget` as its last cause. A run that
  review rounds or the attempt cap ended is the issue's, as without a budget.
- **A record.** `.orbit/queue/<id>.json` is rewritten after every issue:
  per issue the outcome (delivered, person, skipped, budget, interrupted), the
  pull request or branch, and every attempt with its run id, state, failure
  class and spend; why the queue stopped, what it spent, the issues it closed,
  and the backlog as it left it. The same summary is printed. The exit code
  is 0, 10 when an issue was handed to a person, 20 when interrupted.
- **GitHub access.** Reads and the three writes (a label, a comment, closing
  an issue) go through `gh api` with array argv and the body on stdin
  (`GhIssueTracker`), with `GH_TOKEN` or the person's own `gh` login, since a
  person starts the queue. That token or login needs Issues: read and write
  on the repository; a refused write names the permission. The runs
  themselves deliver with `GH_TOKEN` as before. With `delivery.provider: fake` everything lives in
  `.orbit/fake-github-issues.json` and `.orbit/fake-github.json`.

## Consequences

The queue writes to issues it was pointed at: a label, a comment and a close,
each tied to a run record or a merged pull request. Closing an issue whose pull
request merged into a non-default base is what lets its dependants run; an
issue a person reopens after that is closed again by the next queue. The
service is unchanged: it still runs detached runs at once, and a run started by
hand beside a queue is held by the queue as Orbit's. Parallel issues need
disjoint paths and are not part of this change. A sub-issue backlog of more
than 1000 issues, and blockers beyond the first 100 of an issue, are not read.
