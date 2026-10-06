# Installation

## Prerequisites

| Requirement | Needed for | Notes |
|---|---|---|
| Node.js 22.16 or newer | everything | Orbit uses the built-in `node:sqlite` with FTS5. `orbit doctor` reports `runtime.node` and `runtime.sqlite`. |
| git 2.5 or newer | everything | Workers run in `git worktree` checkouts. The repository needs the configured remote (default `origin`) for delivery. |
| `claude` CLI | everything | Claude Code, version 2.1.284 or newer to route to Sonnet 5.5. |
| `codex` CLI | independent review | Optional only if you set `review.independent_provider_required: false`. Also set `providers.codex.data_policy_eligible: true` when sending sanitized code to it is permitted. |
| `srt` (sandbox-runtime) | default isolation | The one runtime dependency of Orbit; the default isolation does not work without it. A plugin install brings it (see below), and `npm ci` in a clone installs it into the clone's `node_modules`. To put it on your PATH instead: `npm install --global @anthropic-ai/sandbox-runtime`. Orbit looks on PATH first, then in the plugin's own `node_modules/.bin`, then (in a clone) the checkout's; never in a directory further up. On Linux it needs bubblewrap; on macOS it uses Seatbelt. |
| Docker | `isolation.provider: container` | Adds hard CPU, memory and pids limits. The image must already exist locally; Orbit runs containers with `--pull never`. |
| Playwright and its browsers | UI verification | `npm install -D @playwright/test` in the target repository, then `npx playwright install chromium`. For accessibility scans also `@axe-core/playwright`. Under `srt` on macOS only Playwright's bundled Chromium is supported (not Google Chrome, Firefox or WebKit), and browser checks need `srt` 0.0.78; see [Browsers under srt on macOS](#browsers-under-srt-on-macos). |
| `gh` CLI and a `GH_TOKEN` | delivery in `autonomous-delivery` and `release` modes | Use a fine-grained token scoped to the one repository. |
| `gitleaks` | stronger secret scan | Optional. Without it Orbit uses built-in patterns and the evidence says so. |

## Install the plugin

From the marketplace. The `claude-plugins` catalog entry is a `git-subdir`
source: this repository, path `plugin`.

```
/plugin marketplace add QuintinBotes/claude-plugins
/plugin install orbit@quintinbotes
```

When a plugin has a `package.json` and a lockfile, Claude Code installs its
registry dependencies at the locked versions (with scripts disabled, within a
time limit). Orbit's plugin lists one, `@anthropic-ai/sandbox-runtime` (`srt`)
pinned to 0.0.78, so a marketplace install brings `srt` and nothing else; it
needs `npm` and network access at install time. Check the result with
`/orbit:doctor`: its `isolation` line names the `srt` it found.

The plugin provides the skills `/orbit:init`, `/orbit:doctor`, `/orbit:run`,
`/orbit:status`, `/orbit:resume`, `/orbit:verify`, `/orbit:repair` and
`/orbit:inquisition`, seven agents, a SessionStart hook that lists the pending
questions of the repository's unfinished runs (`orbit questions --pending`; it
prints nothing when there are none and never blocks a session), and a PreToolUse
guard hook. It also puts `orbit` on the PATH of Claude Code's Bash tool (its
`bin/orbit`) while the plugin is enabled, but not in the session that ran
`/plugin install` (or `claude plugin install`): there it appears only after
`/reload-plugins`, and in every new session it is there from the start. Until
then:

- the skills need nothing: they run the plugin's own CLI as
  `"${CLAUDE_PLUGIN_ROOT}/bin/orbit"`, which Claude Code replaces with the
  absolute path of the installed version;
- in the Bash tool, call it by its absolute path. A marketplace install puts
  the plugin under `~/.claude/plugins/cache/<marketplace>/orbit/<version>/`
  (under `$CLAUDE_CONFIG_DIR/plugins/cache/` when that is set), so from this
  catalog it is `~/.claude/plugins/cache/quintinbotes/orbit/<version>/bin/orbit`;
  `plugins/installed_plugins.json` beside it lists the `installPath` of each
  installed plugin. With `claude --plugin-dir ./plugin` it is
  `./plugin/bin/orbit` of the clone.

It is never on the PATH of a separate terminal: use a clone (below), or call
the plugin's `bin/orbit` by its absolute path.

Who starts which skill: `/orbit:status`, `/orbit:doctor`, `/orbit:init` and
`/orbit:inquisition` are model-invocable, so an agent asked to use Orbit can
use them itself (status and doctor run their own read-only `orbit` command
without a permission prompt). `/orbit:run`, `/orbit:resume`, `/orbit:repair`
and `/orbit:verify` are started by a person; an agent may prepare the goal and
suggest the command (ADR 0006, addendum). Inside Claude Code (its Bash tool, skills and hooks), messages that tell
you to run `orbit <command>` name the `/orbit:<skill>` instead when they exist (`init`, `doctor`, `run`, `status`, `resume`, `verify`,
`repair`); the other commands (`models refresh`, `decide`, `questions`,
`service install`, `report`, `logs`) run through Claude Code's Bash tool, which
you can ask Claude to do. The plugin's `bin/orbit` run from a plain terminal
(by path or through a symbolic link) names the terminal commands, since those
are the ones that work there; Claude Code marks its own commands with
`CLAUDECODE=1`, and only then are skills named. `bin/orbit` also checks for a
usable Node first (22.16 or newer) and says what it found instead of failing
with a raw error.

A plugin alone does not give persistent execution: without the background
service, `/orbit:run`, `/orbit:resume` and `/orbit:repair` drive the run from the
Claude Code session in the background, and it pauses when the session ends. The
service does outlive the session (see [operations](operations.md)). The service
starts a stable launcher, `~/.orbit/bin/orbit`, which Orbit repoints at the
installed plugin version whenever it runs, so a plugin update needs no service
reinstall.

### From a checkout, before a release

Load the plugin from a clone for one session, with no marketplace:

```bash
git clone https://github.com/QuintinBotes/orbit.git
cd orbit
npm ci
claude --plugin-dir ./plugin
```

`npm ci` supplies `srt` from the clone's `node_modules`, which Orbit finds from
the bundle. To exercise the marketplace path itself, write a marketplace of your
own. A `git-subdir` source takes the clone's `file://` URL (a bare path fails
at install time with "Invalid git URL"), and it installs the committed state of
the clone:

```json
{
  "name": "orbit-local",
  "description": "A local catalog for trying Orbit from a clone",
  "owner": { "name": "you" },
  "plugins": [
    { "name": "orbit", "source": { "source": "git-subdir", "url": "file:///ABSOLUTE/PATH/TO/orbit", "path": "plugin" } }
  ]
}
```

Save it as `.claude-plugin/marketplace.json` in an empty directory, then
`/plugin marketplace add <that directory>` and `/plugin install orbit@orbit-local`.

## Verify a release archive

Each GitHub release carries `orbit-plugin-X.Y.Z.tar.gz` (the committed `plugin/`
tree of the tag), a `SHA256SUMS` file and a GitHub artifact attestation (build
provenance) for the archive, created by the release workflow from the tagged
commit after the full test gate passed. To check one you downloaded:

```bash
sha256sum --check SHA256SUMS            # shasum -a 256 -c SHA256SUMS on macOS
gh attestation verify orbit-plugin-X.Y.Z.tar.gz --repo QuintinBotes/orbit
```

A marketplace install does not need this: it reads the `plugin/` directory at
the catalog's `ref`, which the release workflow points at the new tag through a
pull request on `QuintinBotes/claude-plugins`. How a release is made is in
[CONTRIBUTING.md](../CONTRIBUTING.md#releasing).

## Install the CLI

```bash
git clone https://github.com/QuintinBotes/orbit.git
cd orbit
npm ci
npm install --global .
orbit --version
```

`npm install --global .` does not copy Orbit: it links the global `orbit`
command to this clone (`plugin/dist/orbit.mjs`), so deleting or moving the clone
breaks it, and a `git pull` changes what it runs. Keep the clone. Nor does it
put `srt` on your PATH: `orbit doctor` passes only because Orbit finds the
clone's own `node_modules/.bin/srt`. If you want `srt` independent of the clone,
install it globally (`npm install --global @anthropic-ai/sandbox-runtime`).

`plugin/dist/orbit.mjs` is a committed bundle; its only runtime dependency is
the sandbox runtime `srt`, found on PATH, in the plugin's own `node_modules/.bin` or in the clone's.
A checkout with `npm ci` is all you need to run it without a global install:
`node plugin/dist/orbit.mjs doctor`, or `plugin/bin/orbit doctor`.

## First run in a repository

```bash
cd your-repo
orbit init
orbit doctor
```

`orbit init` (plugin: `/orbit:init`) writes `.orbit/config.yaml` and adds the
state files to `.git/info/exclude`, so nothing runtime-related shows in `git
status` (the config file itself shows as untracked) and nothing is committed for
you. The starter mode is `autonomous`: runs end on a local branch and never push.
Review the file like code and commit it if you want it shared. The README
[quickstart](../README.md#quickstart) lists what to set before the first run:
`scope.allowed_paths`, at least one check, `providers.codex.data_policy_eligible`,
and `orbit models refresh`. See [configuration](configuration.md).

A run starts only from a clean working tree (`.orbit/` is exempt) unless
`repository.allow_dirty_start` is true, and refuses to start, creating nothing,
when the repository's git configuration holds credentials or the environment
check fails (isolation, credentials, reviewer). `orbit doctor` reports the same
problems earlier.

## Authentication

Orbit implements no login flow and never reads, stores, copies or forwards
Anthropic or OpenAI credentials (ADR 0003). It runs the CLIs you installed with
the authentication they are configured to use, and `orbit doctor` reports the
method each one reports.

- Interactive foreground runs can use a subscription login (`claude auth login`,
  `codex login`).
- For an unattended service, use API-key authentication: `ANTHROPIC_API_KEY`
  for Claude and `CODEX_API_KEY` for Codex. Subscription logins are meant for
  interactive use, and a headless service that depends on one can be blocked by
  an expired session.
- Alternatively, run `claude setup-token` and export `CLAUDE_CODE_OAUTH_TOKEN`.
- Orbit writes no credentials into the service definition. Make them visible to
  the service through your user manager (`launchctl setenv` or `systemctl
  --user set-environment`, see [operations](operations.md#installing-the-service)),
  then check `orbit doctor`. `doctor` reads its own environment, so run it with
  the same variables exported.
- An expired or invalid credential blocks the run with an explicit reason. Orbit
  does not retry authentication failures. Fix the credential, then
  `orbit resume <run-id>` (with `--foreground` when no service is running, or the
  run is not driven).
- The starter configuration leaves Fable models out of
  `routing.allowed_models`, because headless Claude Code bills Fable usage
  credits without a consent prompt. Add `fable` yourself if you accept that.

## Installing the plugin offline

The plugin's install fetches its one dependency (the sandbox runtime, `srt`)
with `npm ci`. An install made while offline reports success but leaves the
plugin without `node_modules`; `orbit doctor` then fails `isolation` and says
the plugin's `node_modules` is missing. Reconnect and run `claude plugin update
orbit` (or reinstall), or run `npm ci --omit=dev` in the plugin directory it
names.

## Isolation tiers

Workers run in one of two tiers, recorded on every worker and evidence record
(ADR 0001).

| Tier | How | Requires | Edit and Write confinement |
|---|---|---|---|
| `os-sandbox` (preferred) | the whole `claude` process runs inside `srt` | `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` in the environment, and `isolation.provider: sandbox-runtime` | the operating system |
| `claude-sandbox` | `claude` runs unwrapped with its built-in sandbox required, permission deny rules and the guard hook | nothing extra | Claude Code's permission layer; Bash at the OS level |

A macOS keychain login is invisible to a `claude` process inside `srt`, which is
why the `os-sandbox` tier needs an exported credential. Without one Orbit falls
back to `claude-sandbox` and says so in `orbit doctor` (`claude.worker-tier`)
and in every report. Both tiers load no user, project or local Claude Code
settings, so a repository's own hooks and MCP servers never run in a worker.
Trusted checks always run in `srt` (or the container).

The Codex reviewer follows the same two tiers (ADR 0001, "Codex reviewer
tiers"). Codex's own sandbox cannot start inside `srt` on macOS: a Seatbelt
profile cannot be applied from inside another (`sandbox_apply: Operation not
permitted`, which made the reviewer exit 1 with `Operation not permitted (os
error 1)`). So in the first tier `srt` is the only sandbox.

| Tier | How | Requires | Confinement |
|---|---|---|---|
| `os-sandbox` | `codex exec --sandbox danger-full-access` runs inside `srt`; the flag is passed only together with the `srt` wrapper | `isolation.provider: sandbox-runtime` and an `srt` that starts here, and an API key (`CODEX_API_KEY` or `OPENAI_API_KEY`) in the environment | `srt`: writes only to the worker directory and Codex's state directory (`CODEX_HOME`, default `~/.codex`), never the review checkout; egress only to `api.openai.com` and `chatgpt.com`; credential paths unreadable except Codex's own auth file, which it must read to log in |
| `codex-sandbox` | `codex exec --sandbox read-only`, no `srt` | nothing extra | writes and network blocked for Codex's commands; reads are unrestricted, recorded as a limitation on the worker |

The tier is chosen by login type (ADR 0001, "Second live finding"). Inside
`srt`, Codex with a ChatGPT login connects through the proxy and then fails
with "workspace routing discovery failed"; with an API key it reaches the
provider. So `providers.codex.tier: auto` (the default) uses `os-sandbox` only
when `CODEX_API_KEY` or `OPENAI_API_KEY` is set and `srt` starts here, and
`codex-sandbox` otherwise, with a ChatGPT login or without a working `srt` (or
with the `container` provider, which is not used around Codex). The reviewer
says which in its limitations, and `orbit doctor` reports the tier and why
(`codex.worker-tier`). Set `providers.codex.tier` to `os-sandbox` to demand
`srt` (the run is refused with `ISOLATION_UNAVAILABLE` when it is missing) or
to `codex-sandbox` to never wrap Codex; see
[configuration](configuration.md#isolation-and-providers). Under `os-sandbox`,
Codex's state directory is writable (it refreshes its login there), and a login
stored in the system keychain instead of the auth file has not been verified to
be visible inside `srt`.

Isolation providers for checks and UI fixtures:

- `sandbox-runtime`: filesystem write allowlist, credential read denials and an
  egress host allowlist. CPU time, process count and file size are limited with
  `ulimit` and memory by a resident-memory watchdog (`isolation.limits`); these
  are weaker than a container's kernel limits.
- `container`: Docker with CPU, memory and pids limits and no network.
- `none`: refused in autonomous modes unless `isolation.allow_unisolated` is true.

### Browsers under srt on macOS

Chromium registers a Mach service when it starts
(`org.chromium.Chromium.MachPortRendezvousServer.<pid>`), which `srt`'s Seatbelt
profile does not allow, so without help every browser journey fails. For UI
checks only, Orbit starts `srt`'s own CLI under node with a preload,
`srt-chromium-preload.mjs` (shipped beside `dist/orbit.mjs`), that adds two
rules for that name pattern and nothing else. It applies to Playwright's
bundled Chromium only: install it with `npx playwright install chromium`, and
do not set `channel: 'chrome'` or `chromiumSandbox: true` in the Playwright
config. Firefox and WebKit are not supported under `srt` on macOS.

Browser checks require `@anthropic-ai/sandbox-runtime` 0.0.78, the version the
preload was verified against; with another version they fail with
`ISOLATION_UNAVAILABLE`, and the preload refuses (exit 97) any sandbox command
shape it does not recognise. `orbit doctor` reports this as
`ui.browser-isolation` and launches Playwright's headless Chromium binary
(no repository code) to prove it. On
Linux no rule is needed. What the rules widen is described in
[security](security.md#what-is-not-enforced).
