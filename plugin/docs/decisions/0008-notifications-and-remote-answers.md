# 0008. Notifications and remote answers

Status: accepted (2026-10-06)

## Context

An unattended run ends, or stops on a question only a person can answer,
while nobody is looking at the terminal. Until now the only ways to notice
were `orbit status`, the SessionStart hook and reading the draft pull request.
A person away from the machine also had no way to answer: `orbit decide` needs
a shell in the repository.

Two things make this a security boundary rather than a convenience:

- An answer is an authorization. It can approve a contract amendment or a
  baseline exception, and it unblocks work. Whoever can answer can steer the
  run, so answering from a comment must be at least as strict as answering
  from the repository's own shell.
- A notification leaves the machine. Whatever it carries reaches a chat
  service, a desktop notification centre or a public pull request.

## Decision

### Notifications

1. A new policy section, `notifications`, with three channels:
   `desktop` (default on), `webhook` (default off) and `github_comment`
   (default off). It is frozen into the run's policy like every other
   section, so a run notifies the way it was started.
2. Orbit notifies when a run reaches a terminal state (SUCCEEDED, BLOCKED,
   EXHAUSTED, IMPOSSIBLE, CANCELLED; IMPOSSIBLE is the "failed" outcome) and
   when a run raises a question a person must answer. A question already named
   in a terminal notification is not announced again. Each notification has a
   key (`ended:<state>:<ended_at>` or `question:<id>`) recorded in a
   `notification.dispatched` event, so a restarted controller does not repeat
   it; a run that is resumed and blocks again gets a new one.
3. The payload is fixed and small: run id, state, a reason, the next action
   and the open question ids (schema `orbit.notification/1`). It never carries
   code, diffs, secrets or log excerpts: the reason is the first line of the
   outcome reason, cut before anything that looks like a diff or code fence,
   passed through the policy redactor and capped at 160 characters. The next
   action is built from a fixed template per state, never from model prose.
4. Desktop: `osascript` on macOS (the text is passed as arguments to an
   `on run argv` script, never spliced into AppleScript), `notify-send` on
   Linux. A missing program or another platform skips silently.
5. Webhook: the URL is read from the environment variable that
   `notifications.webhook.url_env` names; a URL is never written in the
   config file (the setting must be a variable name). The URL must be
   `https` (plain `http` only for a loopback host), its host must be covered
   by `network.allowed_hosts`, and redirects are refused. The body is JSON
   with a Slack-compatible `text` field and the structured payload under
   `orbit`. The URL is never logged; events record only its host.
6. GitHub comment: a comment on the run's pull request when delivery opened
   one, otherwise on the issue `notifications.remote_answers.issue` links to
   the run, otherwise skipped. It goes through the controller's scoped
   `GH_TOKEN`, as delivery does.
7. Every channel outcome is an event (`notification.sent`,
   `notification.skipped`, `notification.failed`). Delivery failures never
   fail, block or delay the outcome of a run: the terminal transition and the
   final report are written before any notification is attempted, and every
   channel has a timeout.
8. A run whose frozen policy no longer verifies notifies with the default
   channels only (desktop): an unverifiable snapshot cannot choose where data
   is sent.
9. `ORBIT_NOTIFICATIONS=off` in the environment turns every channel off (for
   CI and test suites). `orbit notify test` sends a test notification through
   the configured channels and prints each outcome.

### Remote answers

10. With `notifications.remote_answers.enabled`, a person can answer an open
    question of a BLOCKED run with a comment on the run's pull request, or on
    the issue `remote_answers.issue` names, whose line starts with
    `/orbit answer <question-id> <choice>`.
11. The comment is accepted only when all of these hold, checked in this
    order; anything else is ignored and recorded as
    `remote.answer.refused` with the reason:
    - the author's permission on the repository, read from the GitHub API
      (`collaborators/<login>/permission`, its `role_name`) at the time the
      comment is processed, is `admin`, `maintain` or `write`. `triage`,
      `read`, `none`, a missing collaborator and any value Orbit does not
      know are refused. Nothing in the comment text, the author association
      or the author's name counts as permission, and accounts whose login
      ends in `[bot]` are refused;
    - the question id names a question of that run (a question of another run
      linked to the same issue is left to that run);
    - the question is still open;
    - the choice is one of the question's option labels, or free text when
      the question allows it. Approval questions (contract amendments and
      baseline exceptions) take only their option labels.
12. Orbit's own comments carry a marker and are never read as commands.
13. An accepted answer goes through the same path as `orbit decide`: the
    `inquisition.answer` decision, with the provenance (comment URL, comment
    id, author, permission) in its data, recorded by `github:<login>`; an
    approved amendment is applied at once. A processed comment is recorded
    once (`remote.answer.accepted` or `remote.answer.refused`) and never read
    again.
14. The run continues by the existing resume path. The service polls BLOCKED
    runs that have open questions every `remote_answers.poll_seconds`
    (default 120, minimum 30) through the scoped `GH_TOKEN`, and resumes a
    run once no material question is open and its block did not come from
    the frozen policy. Without a service, `orbit resume` reads the comments
    first, then applies its usual rules.

## Consequences

- Answering from a comment is never wider than answering from a shell: the
  repository's own access control (write permission) decides, checked at
  answer time, and a refused comment changes nothing but an event.
- A token that can read comments and collaborator permissions must be in
  `GH_TOKEN` for remote answers; the docs say so. Delivery already
  requires a token scoped to the repository.
- Polling adds API calls: one list per thread per run per interval, and one
  permission read per command comment. The interval is bounded below.
- Notification text is deliberately terse. Details stay in `orbit report`
  and the run directory, which never leave the machine through this feature.
- Rollback: set `notifications.desktop: false` and leave the other channels
  off; existing runs keep the policy they were started with.
