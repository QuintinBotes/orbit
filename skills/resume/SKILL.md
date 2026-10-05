---
name: resume
description: Resume a paused or blocked Orbit run after reconciling its workers and state. Invoke as /orbit:resume.
argument-hint: "<run-id>"
disable-model-invocation: true
---
# /orbit:resume

Resume a paused, blocked or interrupted run. Orbit reconciles existing workers
and persisted intents first, so resuming never duplicates work or external
effects.

User arguments, verbatim: `$ARGUMENTS`

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/orbit.mjs" resume $ARGUMENTS
```

## Reading the result

Report the run's new state and what was reconciled (adopted workers, orphans
terminated, intents completed). If the run is still BLOCKED, name the blocker
(unanswered question, expired credential, exhausted budget) and do not resume
again until the person has dealt with it. Follow up with `/orbit:status <run-id>`.
