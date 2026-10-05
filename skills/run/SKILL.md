---
name: run
description: Start an Orbit run for a goal, either supervised in this session or submitted for unattended execution. Invoke as /orbit:run.
argument-hint: "<goal> [--mode supervised|autonomous] [--policy path]"
disable-model-invocation: true
---
# /orbit:run

Start an Orbit run. Orbit turns the goal into a testable contract, runs isolated
workers, verifies the result with independent evidence, and records every
decision under `.orbit/` in the current repository.

User arguments, verbatim: `$ARGUMENTS`

## Supervised use (the person is here)

If the arguments are empty or the goal is vague (no observable outcome, no
acceptance signal), help shape it before submitting:

1. Read the repository enough to ground the goal (README, test layout, `.orbit/config.yaml` if present).
2. Draft a one-paragraph goal that names the observable outcome and how it will be proven.
3. Show any open questions to the person with options, consequences and a recommendation. Ask at most the few that change implementation, proof or scope. Use /orbit:inquisition for a deeper grill.
4. Submit only after the person agrees with the goal text.

## Submitting

Pass the arguments through unchanged. Do not rewrite, quote or reorder them:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/orbit.mjs" run $ARGUMENTS
```

If the person gave a bare goal without `--goal`, run `node "${CLAUDE_PLUGIN_ROOT}/dist/orbit.mjs" run --goal "<goal text>"` with the agreed goal instead.

## Keeping the session on the goal (optional)

After a supervised submit, if the native `/goal` command is available in this session, offer to set it to the run's objective plus the evidence line `evidence: orbit status <run-id> reports SUCCEEDED`. That keeps this conversation pointed at the outcome while the run works.

`/goal` is only a continuation aid. The controller's completion gate stays the authority on whether the goal is met: never report the goal as done because `/goal` is satisfied, only because `/orbit:status <run-id>` shows SUCCEEDED with its evidence. If `/goal` is not available, skip this step; nothing else depends on it.

## Unattended use

For `--mode autonomous` the run must never wait on the keyboard. Orbit persists
questions, continues independent work, and moves to BLOCKED when a decision is
needed. Submit, report the run id, and stop; do not poll in a loop.

## Reading the result

The command prints the run id and its state. Report: the run id, the state,
any pending questions (id, the question, the recommended option), and the
paths printed under `.orbit/runs/<run-id>/`. Exit code non-zero means the
command failed; show the error code and message as printed and do not retry
blindly. Follow up with `/orbit:status <run-id>`.
