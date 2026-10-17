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
asks for (it says that the starter sets `providers.codex.data_policy_eligible:
false`, so Codex does not review until the person sets it to true, which is
theirs to decide). When this is a linked git worktree, `init` says that the exclude file
it wrote is shared by every worktree of the clone and lives outside this
worktree; pass that on, since a person may not expect a worktree's init to
write into the main checkout's git directory. Offer to help edit `.orbit/config.yaml`, then suggest `/orbit:doctor`.

Relay any warning that no scope or checks were derived, including the reason,
the example scope paths that must be edited, and the marker files init looked
for. Whenever git does not track `.orbit/config.yaml`, including a config that
already existed, `init` prints a line about committing it: relay it as printed.
Once the person has reviewed the file, offer to commit it, and commit only if
they agree, with only that file so nothing else they staged goes in:
`git add -- .orbit/config.yaml`, then
`git commit -m "<message>" -- .orbit/config.yaml`.
When `init` says git ignores the file, do not force-add it: pass on how to find
the rule, `git check-ignore -v .orbit/config.yaml`, and leave changing it to the
person. Never add `.orbit/` to `.gitignore` to quiet `git status`, since that
hides the policy.

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
