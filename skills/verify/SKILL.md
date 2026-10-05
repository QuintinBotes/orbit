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

With no run id it verifies the newest run. It checks the run's latest candidate in a clean checkout under the run's frozen policy, takes a short lease (it refuses while a live controller owns the run) and never changes the run's state.

## Reading the result

The command prints a verdict per contract criterion and the artifact paths it relied on. Report each criterion as supported, unsupported or unverified, and name the artifact path for each. Treat unverified as not done: a green check without a mapped criterion is not proof.

Exit codes: 0 means the verdict is PASS. 14 means FAIL (a check failed, the scope was violated or a secret was found). 15 means INCOMPLETE (nothing failed, but a mandatory criterion is unproven). Any other non-zero code is a command error (3 no such run, 5 a controller owns the run or there is no candidate yet); show the printed code and do not call the work done. A FAIL can be handed to `/orbit:repair <run-id>`.
