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
   `.claude-plugin/plugin.json`, `dist/` (the bundle and the srt preload),
   `hooks/`, `skills/`, `agents/`, `bin/orbit`, and a `package.json` plus
   lockfile whose only dependency is `@anthropic-ai/sandbox-runtime`, pinned
   to the version the preload is verified against. The repository root stays
   the development workspace. The build writes into `plugin/dist/`, and a
   check fails when the payload contains anything else (in particular a
   devDependency).
2. Marketplace entries use `{ "source": "git-subdir", "url":
   "QuintinBotes/orbit", "path": "plugin", "ref": "<release tag>" }`.
3. `bin/orbit` runs the bundle with the current node, so `orbit` works in the
   Bash tool of any session with the plugin enabled. Terminal use outside
   Claude Code stays documented (an alias or `npm install --global`).
4. Orbit finds `srt` on PATH first, then in the nearest `node_modules/.bin`
   walking up from its bundle (the plugin's own install, or the development
   checkout).
5. Skills pass a goal or any free text to the CLI through a here-document
   with a quoted delimiter and `--goal -`, never as shell words; run ids and
   flags are validated by the CLI. New skills `/orbit:init` and
   `/orbit:doctor` cover setup without a terminal.

## Consequences

A marketplace install brings `srt` and nothing else, so isolation works
without a manual global install. The `node-forge` advisory reported by
`npm audit` arrives through `srt` itself and is tracked upstream. Paths in
tests, scripts and docs move from `dist/` to `plugin/dist/`.
