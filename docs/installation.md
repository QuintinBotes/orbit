# Installation

## Prerequisites

| Requirement | Needed for | Notes |
|---|---|---|
| Node.js 22.16 or newer | everything | Orbit uses the built-in `node:sqlite` with FTS5. `orbit doctor` reports `runtime.node` and `runtime.sqlite`. |
| git 2.5 or newer | everything | Workers run in `git worktree` checkouts. The repository needs the configured remote (default `origin`) for delivery. |
| `claude` CLI | everything | Claude Code, version 2.1.284 or newer to route to Sonnet 5.5. |
| `codex` CLI | independent review | Optional only if you set `review.independent_provider_required: false`. Also set `providers.codex.data_policy_eligible: true` when sending sanitized code to it is permitted. |
| `srt` (sandbox-runtime) | default isolation | `npm install --global @anthropic-ai/sandbox-runtime`. On Linux it needs bubblewrap; on macOS it uses Seatbelt. Orbit also finds an `srt` in its own `node_modules/.bin`. |
| Docker | `isolation.provider: container` | Adds hard CPU, memory and pids limits. The image must already exist locally; Orbit runs containers with `--pull never`. |
| Playwright and its browsers | UI verification | `npm install -D @playwright/test` in the target repository, then `npx playwright install chromium`. For accessibility scans also `@axe-core/playwright`. |
| `gh` CLI and a `GH_TOKEN` | delivery in `autonomous-delivery` and `release` modes | Use a fine-grained token scoped to the one repository. |
| `gitleaks` | stronger secret scan | Optional. Without it Orbit uses built-in patterns and the evidence says so. |

## Install the plugin

From the marketplace, once it is public:

```
/plugin marketplace add QuintinBotes/claude-plugins
/plugin install orbit@quintinbotes
```

The plugin provides the skills `/orbit:run`, `/orbit:status`, `/orbit:resume`,
`/orbit:verify`, `/orbit:repair` and `/orbit:inquisition`, six agents, and a
PreToolUse guard hook. The skills call `node "${CLAUDE_PLUGIN_ROOT}/dist/orbit.mjs"`.
A plugin alone does not give persistent execution; the service does (see
[operations](operations.md)).

## Install the CLI

```bash
git clone https://github.com/QuintinBotes/orbit.git
cd orbit
npm ci
npm install --global .
orbit --version
```

`dist/orbit.mjs` is a committed bundle with no runtime dependencies, so a
checkout is all you need to run it: `node dist/orbit.mjs doctor`.

## First run in a repository

```bash
cd your-repo
orbit init
orbit doctor
```

`orbit init` writes `.orbit/config.yaml` and adds the state files to
`.git/info/exclude`, so nothing runtime-related shows in `git status` and
nothing is committed for you. Review the file like code and commit it if you
want it shared. See [configuration](configuration.md).

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
  `orbit resume <run-id>`.
- The starter configuration leaves Fable models out of
  `routing.allowed_models`, because headless Claude Code bills Fable usage
  credits without a consent prompt. Add `fable` yourself if you accept that.

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
| `os-sandbox` (preferred) | `codex exec --sandbox danger-full-access` runs inside `srt`; the flag is passed only together with the `srt` wrapper | `isolation.provider: sandbox-runtime` and an `srt` that starts here, a Codex login kept in `$CODEX_HOME/auth.json` (the default) or `CODEX_API_KEY` | `srt`: writes only to the worker directory and Codex's state directory (`CODEX_HOME`, default `~/.codex`), never the review checkout; egress only to `api.openai.com` and `chatgpt.com`; credential paths unreadable except Codex's own auth file, which it must read to log in |
| `codex-sandbox` | `codex exec --sandbox read-only`, no `srt` | nothing extra | writes and network blocked for Codex's commands; reads are unrestricted, recorded as a limitation on the worker |

Without a working `srt` (or with the `container` provider, which is not used
around Codex) the reviewer runs in `codex-sandbox` and says so in its
limitations. Under `os-sandbox`, Codex's state directory is writable (it
refreshes its login there), and a login stored in the system keychain instead
of the auth file has not been verified to be visible inside `srt`.

Isolation providers for checks and UI fixtures:

- `sandbox-runtime`: filesystem write allowlist, credential read denials and an
  egress host allowlist. CPU time, process count and file size are limited with
  `ulimit` and memory by a resident-memory watchdog (`isolation.limits`); these
  are weaker than a container's kernel limits.
- `container`: Docker with CPU, memory and pids limits and no network.
- `none`: refused in autonomous modes unless `isolation.allow_unisolated` is true.
