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

Give it either a run id or a description of the failure:

- A run id whose latest evidence is FAIL and that is BLOCKED or paused: Orbit moves the run to DIAGNOSING and hands off as `/orbit:resume` does. It prints the failure fingerprint and the path of the repair brief the controller writes. Run `/orbit:verify <run-id>` first when the evidence is not known to be FAIL.
- Anything else: Orbit starts a new run whose goal is `Repair: <your text>`.

A run id that does not qualify (still running, already finished, or evidence that is not FAIL) is refused with the reason, and no run is started.

## Reading the result

Report the failure fingerprint, the brief path and the run's new state. After the controller has diagnosed, the repair brief lists the competing causes it weighed and the discriminating experiment; report those from the brief. If Orbit reports repeated identical failures, a budget stop or a needed decision, say so plainly and suggest `/orbit:inquisition --run <run-id>` rather than retrying. A non-zero exit prints an error code; show it as printed.
