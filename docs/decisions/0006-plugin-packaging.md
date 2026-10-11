# 0006. Plugin packaging: a `plugin/` payload with only runtime dependencies

Status: accepted (2026-10-05)

## Context

An end-to-end test as a new user found that installing Orbit from a
marketplace makes Claude Code install the npm dependencies of the plugin
root. The repository root is the development workspace: its `package.json`
lists only devDependencies (Playwright, Vitest, TypeScript, esbuild and
others), so an install pulled about 137 MB and a network dependency at
install time, while the one runtime dependency that matters, the sandbox
runtime `srt`, was present only by accident. Plugin-only users also had no
`orbit` command, so every message that said `run "orbit init"` pointed at
nothing, and skills passed `$ARGUMENTS` to a shell unquoted.

Claude Code's documented behaviour (plugins reference, 2026-10):

- When a plugin has `package.json` and a lockfile, Claude Code installs its
  registry dependencies at the locked versions with `--ignore-scripts` and a
  60-second timeout; this cannot be turned off.
- Executables in a `bin/` directory at the plugin root are added to the PATH
  of the Bash tool while the plugin is enabled (after the user's own entries).
- With a `git-subdir` marketplace source, the subdirectory is the plugin
  root, `${CLAUDE_PLUGIN_ROOT}` points at it, and nothing outside it exists at
  runtime.
- Skills have no safe argument mechanism; the skill must keep user text away
  from shell parsing.

## Decision

1. The plugin is the `plugin/` directory of the repository. It holds exactly:
   `README.md`, `CHANGELOG.md`, `docs/`, `.claude-plugin/plugin.json`, `dist/`
   (the bundle and the srt preload), `hooks/`, `skills/`, `agents/`,
   `bin/orbit`, and a `package.json` plus lockfile whose only dependency is
   `@anthropic-ai/sandbox-runtime`, pinned to the version the preload is
   verified against. The repository root stays the development workspace. The
   default build writes into `plugin/dist/` and copies the README, changelog
   and docs into the payload, and a check fails when the payload contains
   anything else (in particular a devDependency) or any copied documentation
   path is missing.
2. Marketplace entries use `{ "source": "git-subdir", "url":
   "QuintinBotes/orbit", "path": "plugin", "ref": "<release tag>" }`.
3. `bin/orbit` runs the bundle with the current node, so `orbit` works in the
   Bash tool of any session with the plugin enabled. Terminal use outside
   Claude Code stays documented (an alias or `npm install --global`).
4. Orbit finds `srt` on PATH first, then in the plugin's own
   `node_modules/.bin` beside its `dist/`, then in the development checkout's
   `node_modules/.bin`, which counts only when the install directory is
   `plugin/` inside a checkout whose package is `orbit-dev`. It never walks
   further up: a `node_modules/.bin` in a shared parent directory would
   otherwise supply the `srt` that confines every command.
5. Skills pass a goal or any free text to the CLI through a here-document
   with a quoted delimiter and `--goal -`, never as shell words; run ids and
   flags are validated by the CLI. New skills `/orbit:init` and
   `/orbit:doctor` cover setup without a terminal.

## Consequences

A marketplace install brings `srt` and nothing else, so isolation works
without a manual global install. The `node-forge` advisory reported by
`npm audit` arrives through `srt` itself and is tracked upstream. Paths in
tests, scripts and docs move from `dist/` to `plugin/dist/`.

## Addendum (2026-10-06): who invokes which skill

Context. Every skill set `disable-model-invocation: true`, which removes its
description from the model's context, so an agent asked to use Orbit saw no
Orbit skills at all (issue #2). In `claude -p`, the status skill's own `orbit`
command also needed approval.

Decision.

1. Model-invocable (no `disable-model-invocation`): `/orbit:status`,
   `/orbit:doctor`, `/orbit:init` and `/orbit:inquisition`. They read state,
   check the setup, write the starter config (never over an existing one) or
   ask questions; `inquisition` records only answers the person gave.
2. User-only (`disable-model-invocation: true`): `/orbit:run`,
   `/orbit:resume`, `/orbit:repair` and `/orbit:verify`. They start or drive
   work, spend provider budget or take a lease on a run, so a person starts
   them; an agent may prepare the goal and suggest the command. Their
   descriptions say so.
3. `scripts/check-plugin.mjs` holds the allowlist (`MODEL_INVOCABLE_SKILLS`,
   exactly the four above). Any other skill without
   `disable-model-invocation: true` fails the check, and so does a listed skill
   that is missing or that sets it. A new skill is user-only until it is added
   to the list.
4. `status` and `doctor` pre-approve only their own read-only commands with
   `allowed-tools`, in the form
   `Bash(${CLAUDE_PLUGIN_ROOT}/bin/orbit status)` and
   `Bash(${CLAUDE_PLUGIN_ROOT}/bin/orbit status *)` (`doctor` and
   `doctor --probe` for doctor). Claude Code (2.1.291) substitutes
   `${CLAUDE_PLUGIN_ROOT}` in `allowed-tools` as in the body, and the unquoted
   rule matches the quoted command the skill runs. Proven with `claude -p
   --plugin-dir plugin --permission-mode default "/orbit:status"` in a scratch
   repository after `orbit init`: with the rules the status printed and
   `permission_denials` was empty; the same plugin without them was denied
   `"<plugin>/bin/orbit" status`. Nothing that starts work, records a decision
   or edits config is pre-approved.

Consequences. An agent can check and set up Orbit and grill a goal without a
person typing a slash command, but cannot start, resume, repair or verify a
run on its own. Skills with `disable-model-invocation: true` still cannot be
preloaded into subagents; the four model-invocable ones can.
