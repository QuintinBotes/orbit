---
name: verify
description: Run Orbit's independent verification and evidence review for a run or the current change. Invoke as /orbit:verify.
argument-hint: "[run-id]"
disable-model-invocation: true
---
# /orbit:verify

Verify with evidence, not claims. Verification runs outside the worker that wrote the change.

User arguments, verbatim: `$ARGUMENTS`

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/orbit.mjs" verify $ARGUMENTS
```

## Reading the result

The command prints a verdict per contract criterion and the evidence it relied
on. Report each criterion as proven, failed or unproven, and name the artifact
path for each. Treat "unproven" as not done: a green check without a mapped
criterion is not proof. A non-zero exit means failed or blocked verification
(or a command error); show the printed code and do not call the work done.
Failures can be handed to `/orbit:repair <run-id>`.
