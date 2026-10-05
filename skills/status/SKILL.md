---
name: status
description: Show the state, progress, budget and pending questions of an Orbit run, or list recent runs. Invoke as /orbit:status.
argument-hint: "[run-id]"
disable-model-invocation: true
---
# /orbit:status

User arguments, verbatim: `$ARGUMENTS`

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/orbit.mjs" status $ARGUMENTS
```

## Reading the result

Lead with the state (for example RUNNING, BLOCKED, VERIFYING, DONE, FAILED),
then last-progress time, spend against budget, and any pending questions with
their ids. BLOCKED means a decision or credential is needed: say which, and
point to `/orbit:inquisition --run <run-id>` for questions or `/orbit:resume
<run-id>` once the blocker is cleared. With no run id the command lists runs;
summarise them in a short table. Read-only: this skill changes nothing.
