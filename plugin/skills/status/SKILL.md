---
name: status
description: Show the state, progress, budget and pending questions of an Orbit run, or list the recent runs of this repository. Use when asked how an Orbit run is going or which runs exist. Read-only. Invoke as /orbit:status.
argument-hint: "[run-id]"
allowed-tools:
  - Bash(${CLAUDE_PLUGIN_ROOT}/bin/orbit status)
  - Bash(${CLAUDE_PLUGIN_ROOT}/bin/orbit status *)
  - Bash(${CLAUDE_PLUGIN_ROOT}/bin/orbit timeline *)
---
# /orbit:status

User arguments, verbatim: `$ARGUMENTS`

The arguments are either empty or exactly one run id matching
`^orb-[0-9a-z-]+$`. With anything else, say so and run nothing. Never paste the
arguments into a command line as they are.

With no arguments, list the runs:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/orbit" status
```

With a run id, type the validated id in place of `<run-id>`, and read the
status first and then how the run got there:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/orbit" status <run-id>
```

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/orbit" timeline <run-id> --last 40
```

The timeline is one line per step with its local time: state changes and their
reasons, routing and escalation decisions with their evidence, each attempt and
candidate with its verification verdict, check results, the review outcome and
reviewer, questions asked and answered, delivery actions, and the cost so far
(measured against charged). For the whole history leave out `--last 40`; for
the raw worker output, `orbit logs <run-id>` is the place, but the timeline is
what to read first.

## Reading the result

Lead with the state exactly as printed (for example VERIFYING, REVIEWING, BLOCKED, SUCCEEDED, EXHAUSTED, IMPOSSIBLE or CANCELLED; SUCCEEDED, EXHAUSTED, IMPOSSIBLE and CANCELLED are final),
then last-progress time, spend against budget, and any pending questions with
their ids. With a run id, add a short account of the timeline: what was tried,
what failed and why, where it escalated, and what it cost. BLOCKED means a decision or credential is needed: say which, and
point to `/orbit:inquisition --run <run-id>` for questions or `/orbit:resume
<run-id>` once the blocker is cleared. When the stage line says a new run is
needed (a frozen-policy or check-definition block, or an environment block with no
baseline exception to approve), do not point to resume: say that and suggest
cancelling the run and starting a new one after the fix the reason names. A run
with every implementation attempt used that waits in its last attempt is not one
of these: its stage line says what it returns to, and answering then resuming
continues that attempt. A run that is not final but shows no
recent progress may have no controller: point to `/orbit:resume <run-id>`.
With no run id the command lists runs; summarise them in a short table.
Read-only: this skill changes nothing.
