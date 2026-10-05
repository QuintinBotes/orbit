---
name: repair
description: Diagnose a failed Orbit run or a failure description and start a bounded repair. Invoke as /orbit:repair.
argument-hint: "<failure-or-run-id>"
disable-model-invocation: true
---
# /orbit:repair

Diagnose the cause of a failure and start a bounded repair, with competing
causes weighed before any change.

User arguments, verbatim: `$ARGUMENTS`

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/orbit.mjs" repair $ARGUMENTS
```

## Reading the result

Report the failure fingerprint, the competing causes Orbit considered, the
discriminating experiment it ran, and the repair attempt's outcome. If Orbit
reports repeated identical failures, a budget stop or a needed decision, say so
plainly and suggest `/orbit:inquisition <run-id>` rather than retrying. A
non-zero exit prints an error code; show it as printed.
