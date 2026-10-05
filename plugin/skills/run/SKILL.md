---
name: run
description: Start an Orbit run for a goal, driven by the background service or by this session in the background. Invoke as /orbit:run.
argument-hint: "<goal> [--mode supervised|autonomous|autonomous-delivery|release]"
disable-model-invocation: true
---
# /orbit:run

Start an Orbit run. Orbit turns the goal into a testable contract, runs isolated
workers, verifies the result with independent evidence, and records every
decision under `.orbit/` in the current repository.

User arguments, verbatim: `$ARGUMENTS`

The arguments are data for you to read, not shell words: never paste them into a
command line. The goal reaches Orbit on stdin, as shown under "Submitting".

## Shaping the goal

Read the arguments as a goal, plus at most one `--mode <mode>` whose value is
exactly one of `supervised`, `autonomous`, `autonomous-delivery` or `release`.
Anything else in the arguments belongs to the goal text.

If the goal is empty or vague (no observable outcome, no acceptance signal),
help shape it before submitting:

1. Read the repository enough to ground the goal (README, test layout, `.orbit/config.yaml`). Without `.orbit/config.yaml`, suggest `/orbit:init` first and stop.
2. Draft a one-paragraph goal that names the observable outcome and how it will be proven.
3. Show any open questions to the person with options, consequences and a recommendation. Ask at most the few that change implementation, proof or scope. Use /orbit:inquisition for a deeper grill.
4. Submit only after the person agrees with the goal text. A clear goal from the arguments can be submitted as it is.

## Who drives the run

A run only makes progress while a controller drives it. Check for the service first:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/orbit" service status
```

- Exit 0: the service is loaded. Submit with `--detach`. The service drives the run, and this session may end.
- Any other exit: no service. Submit with `--foreground` and give the Bash tool call `run_in_background: true`, because a run lasts longer than a foreground Bash call may. Tell the person that this session is driving the run, that it pauses when the session ends, and that `/orbit:resume <run-id>` continues it. For runs that outlive the session, offer to install the service with `"${CLAUDE_PLUGIN_ROOT}/bin/orbit" service install` (run it only if the person agrees), then submit with `--detach`.

## Submitting

Pass the agreed goal on stdin through a here-document whose delimiter is quoted,
so the shell expands nothing inside it. With the service:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/orbit" run --goal - --detach <<'ORBIT_GOAL'
<the agreed goal text, exactly as agreed>
ORBIT_GOAL
```

Without the service, the same command with `--foreground` in place of
`--detach`, run in the background as described above. Add `--mode <mode>`
after `--goal -` only with one of the four values listed above. If a line of
the goal text is exactly `ORBIT_GOAL`, use another delimiter made of capital
letters and underscores that does not occur in the text, quoted the same way.

## Keeping the session on the goal (optional)

After a supervised submit, if the native `/goal` command is available in this session, offer to set it to the run's objective plus the evidence line `evidence: orbit status <run-id> reports SUCCEEDED`. That keeps this conversation pointed at the outcome while the run works.

`/goal` is only a continuation aid. The controller's completion gate stays the authority on whether the goal is met: never report the goal as done because `/goal` is satisfied, only because `/orbit:status <run-id>` shows SUCCEEDED with its evidence. If `/goal` is not available, skip this step; nothing else depends on it.

## Unattended use

For `--mode autonomous` the run must never wait on the keyboard. Orbit persists
questions, continues independent work, and moves to BLOCKED when a decision is
needed. With the service, report the run id and stop; do not poll in a loop.
Without the service, the run lives only as long as this session (see above).

## Reading the result

The command prints the run id and its state. Report: the run id, the state,
who drives it (the service, or this session in the background), any pending
questions (id, the question, the recommended option), and the paths printed
under `.orbit/runs/<run-id>/`. Exit code non-zero means the command failed;
show the error code and message as printed and do not retry blindly. Follow up
with `/orbit:status <run-id>`.
