---
name: doctor
description: Check every capability an Orbit run depends on in this repository, with the exact fix for each failure. Invoke as /orbit:doctor.
argument-hint: "[--probe]"
disable-model-invocation: true
---
# /orbit:doctor

Check the config, isolation, providers, models, checks, delivery and the
background service, each reported as pass, warn or fail with the missing piece
and the command that fixes it.

User arguments, verbatim: `$ARGUMENTS`

The only argument it takes is `--probe` (it also calls the providers live, which
costs a little). With exactly `--probe`, run the second form; with anything
else, say so and run the first.

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/orbit" doctor
```

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/orbit" doctor --probe
```

## Reading the result

Lead with the totals line. Then list every failure, and every warning that
blocks the person's intended mode, each with its `fix:` line exactly as
printed: never shorten a fix. Without `.orbit/config.yaml`, suggest
`/orbit:init` first. A fix that is an `orbit ...` command runs here with the
plugin's own CLI, `"${CLAUDE_PLUGIN_ROOT}/bin/orbit"` in place of `orbit`; run
one only when the person agrees, and run nothing that installs software, changes credentials or edits
their config without asking. Read-only otherwise: this skill changes nothing.
