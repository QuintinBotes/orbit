---
name: status
description: Show the state, progress, budget and pending questions of an Orbit run, or list recent runs. Invoke as /orbit:status.
argument-hint: "[run-id]"
disable-model-invocation: true
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

With a run id, type the validated id in place of `<run-id>`:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/orbit" status <run-id>
```

## Reading the result

Lead with the state exactly as printed (for example VERIFYING, REVIEWING, BLOCKED, SUCCEEDED, EXHAUSTED, IMPOSSIBLE or CANCELLED; SUCCEEDED, EXHAUSTED, IMPOSSIBLE and CANCELLED are final),
then last-progress time, spend against budget, and any pending questions with
their ids. BLOCKED means a decision or credential is needed: say which, and
point to `/orbit:inquisition --run <run-id>` for questions or `/orbit:resume
<run-id>` once the blocker is cleared. A run that is not final but shows no
recent progress may have no controller: point to `/orbit:resume <run-id>`.
With no run id the command lists runs; summarise them in a short table.
Read-only: this skill changes nothing.
