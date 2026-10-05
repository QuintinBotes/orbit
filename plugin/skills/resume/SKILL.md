---
name: resume
description: Resume a paused or blocked Orbit run after reconciling its workers and state, driven by the service or by this session in the background. Invoke as /orbit:resume.
argument-hint: "<run-id>"
disable-model-invocation: true
---
# /orbit:resume

Resume a paused, blocked or interrupted run. Orbit reconciles existing workers
and persisted intents first, so resuming never duplicates work or external
effects.

User arguments, verbatim: `$ARGUMENTS`

The arguments must be exactly one run id matching `^orb-[0-9a-z-]+$`. If they
are anything else, say so, suggest `/orbit:status` to list the runs, and run
nothing. Never paste the arguments into a command line as they are; type the
validated run id in place of `<run-id>` below.

## Who drives the run

Resuming only clears the pause or the block; a controller has to drive the run
afterwards. Check for the service first:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/orbit" service status
```

- Exit 0: the service is loaded. Hand the run to it:

  ```bash
  "${CLAUDE_PLUGIN_ROOT}/bin/orbit" resume <run-id> --detach
  ```

- Any other exit: no service. Drive the run from this session with `--foreground`, and give the Bash tool call `run_in_background: true`:

  ```bash
  "${CLAUDE_PLUGIN_ROOT}/bin/orbit" resume <run-id> --foreground
  ```

  Tell the person that this session is driving the run and that it pauses when the session ends. For runs that outlive the session, offer to install the service with `"${CLAUDE_PLUGIN_ROOT}/bin/orbit" service install` (only if the person agrees), then resume with `--detach`.

## Reading the result

Report the run's new state, who drives it, and what was reconciled (adopted
workers, orphans terminated, intents completed). If the run is still BLOCKED,
name the blocker (unanswered question, expired credential, exhausted budget)
and do not resume again until the person has dealt with it. A block caused by
the frozen policy (for example a check definition or an isolation setting)
cannot be cleared by resuming: say so and suggest a new run after the fix.
Follow up with `/orbit:status <run-id>`.
