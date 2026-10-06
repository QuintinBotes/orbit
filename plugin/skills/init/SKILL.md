---
name: init
description: Set up Orbit in the current repository without a terminal - writes .orbit/config.yaml from the starter template and keeps run state out of git status. Use when asked to set up or start using Orbit in a repository that has no .orbit/config.yaml. Invoke as /orbit:init.
argument-hint: ""
---
# /orbit:init

Set up Orbit in this repository. It writes `.orbit/config.yaml` from the starter
template when there is none (it never overwrites one) and adds rules to
`.git/info/exclude` so run state stays out of `git status`. It is safe to run
again.

User arguments, verbatim: `$ARGUMENTS`

`init` takes no arguments; ignore any that were given and say so.

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/orbit" init
```

## Reading the result

Report whether the config was created or already existed, the
`scope.allowed_paths` it derived from the repository layout (if it printed
any), the checks it proposed from what the repository declares (each is commented in the
config for review) and the tools it skipped, and every problem listed under "The
configuration does not validate yet". The starter is a template, not a working policy: the person must review
it, define the checks that prove a change, and set the provider settings it
asks for. Offer to help edit `.orbit/config.yaml`, then suggest `/orbit:doctor`.

## The background service

Runs make progress only while a controller drives them. The service drives them
unattended and survives the end of this session. Offer to install it; run this
only if the person agrees:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/orbit" service install
```

The service starts a stable launcher (`~/.orbit/bin/orbit`) that Orbit
repoints at the current plugin version whenever it runs, so a plugin update
needs no reinstall. Without the service, `/orbit:run`, `/orbit:resume` and
`/orbit:repair` drive runs from the session in the background.
