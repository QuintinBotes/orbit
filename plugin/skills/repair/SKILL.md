---
name: repair
description: Diagnose a failed Orbit run or a failure description and start a bounded repair, driven by the service or by this session in the background. Invoke as /orbit:repair. A person starts it; an agent may prepare the goal and suggest the command.
argument-hint: "<failure-or-run-id>"
disable-model-invocation: true
---
# /orbit:repair

Diagnose the cause of a failure and start a bounded repair, with competing
causes weighed before any change.

User arguments, verbatim: `$ARGUMENTS`

The arguments are data for you to read, not shell words: never paste them into
a command line. They are either one run id (matching `^orb-[0-9a-z-]+$`) or a
description of the failure. Either way they reach Orbit on stdin, and the CLI
decides which it is:

- A run id whose latest evidence is FAIL and that is BLOCKED or paused: Orbit moves the run to DIAGNOSING and hands off as `/orbit:resume` does. It prints the failure fingerprint and the path of the repair brief the controller writes. Run `/orbit:verify <run-id>` first when the evidence is not known to be FAIL.
- Anything else: Orbit starts a new run whose goal is `Repair: <your text>`.

A run id that does not qualify (still running, already finished, or evidence that is not FAIL) is refused with the reason, and no run is started.

## Who drives the repair

Check for the service first:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/orbit" service status
```

- Exit 0: the service is loaded. Use `--detach`, and the service drives the repair.
- Any other exit: no service. Use `--foreground` and give the Bash tool call `run_in_background: true`. Tell the person that this session is driving the repair and that it pauses when the session ends (`/orbit:resume <run-id>` continues it). For repairs that outlive the session, offer to install the service with `"${CLAUDE_PLUGIN_ROOT}/bin/orbit" service install` (only if the person agrees).

## Submitting

The run id or the description goes on stdin through a here-document whose
delimiter is quoted, so the shell expands nothing inside it:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/orbit" repair - --detach <<'ORBIT_TEXT'
<the run id, or the failure description exactly as given>
ORBIT_TEXT
```

Without the service, the same command with `--foreground` in place of
`--detach`, run in the background. If a line of the text is exactly
`ORBIT_TEXT`, use another delimiter of capital letters and underscores that
does not occur in the text, quoted the same way.

## Reading the result

Report the failure fingerprint, the brief path, the run's new state and who drives it. After the controller has diagnosed, the repair brief lists the competing causes it weighed and the discriminating experiment; report those from the brief. If Orbit reports repeated identical failures, a budget stop or a needed decision, say so plainly and suggest `/orbit:inquisition --run <run-id>` rather than retrying. A non-zero exit prints an error code; show it as printed.
