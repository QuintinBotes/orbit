# 0001. Runtime choices and deviations from the spec defaults

Status: accepted (2026-10-03)

The spec lists implementation defaults (§3) and asks for a recorded
justification wherever the implementation differs. Each choice below cites the
verified interface notes in `docs/interfaces/`.

## Storage: `node:sqlite`, not a native SQLite addon

Plugins installed from a marketplace get no reliable build step, and native
addons such as `better-sqlite3` fail there (`claude-code-plugin.md`,
Implications 3). Node 22.13+ ships SQLite unflagged; it prints an
ExperimentalWarning, which `core/warnings.ts` filters (and only that one).
SQLite 3.50 in Node includes FTS5, which the learning layer uses.

## Distribution: one committed bundle

`dist/orbit.mjs` is an esbuild bundle with no runtime dependencies beyond
Node, committed to the repository and checked against the sources in CI
(`npm run check:dist`). The plugin works straight from a git install, and the
same file is the `orbit` CLI (`package.json` `bin`). There is no top-level
`bin/` directory: a plugin `bin/` is put on the Bash PATH and blocks claude.ai
and Cowork installs (`claude-code-plugin.md`). Skills call
`node "${CLAUDE_PLUGIN_ROOT}/dist/orbit.mjs"`.

## Workers: `claude -p` and `codex exec` as detached processes

The Agent SDK talks to the CLI over the parent's stdio, so a controller crash
ends the conversation; the SDK's `canUseTool` callback would also make policy
depend on a live process (`claude-headless-and-sandbox.md` §6). Workers are
therefore CLI processes spawned detached by a shim, with output streamed to
files, a session id recorded before spawn, permission mode `dontAsk` with
explicit tool lists, and policy hooks supplied through `--settings`. A
restarted controller reattaches from the files.

## Isolation: sandbox-runtime by default, containers for resource limits

The spec asks for containers "or equivalent". Orbit's default provider is
Anthropic's open-source sandbox runtime (`srt`, Seatbelt on macOS, bubblewrap
on Linux): filesystem write allowlists, credential read denials and an egress
domain allowlist, failing closed on bad configuration. It does not limit CPU,
memory or process count; Orbit enforces wall time by killing the process
group, and `orbit doctor` and every evidence record state the gap. The
`container` provider (Docker) adds CPU, memory and pids limits for checks and
UI fixtures. Claude Code's built-in Bash sandbox is not relied on as the
boundary, because an invalid settings file silently disables it.

## Worktrees outside the repository

Worker worktrees live under `~/.orbit/worktrees/`, so a worker's writable set
never contains the main checkout or its `.orbit/` directory.

## Extra state: AWAITING_CI

The spec folds CI observation into DELIVERING. It is a separate state so a
restarted controller knows the push and pull request already happened and
only CI remains.

## Extra modules

`core/`, `contract/`, `isolation/`, `review/`, `knowledge/` and `guard/`
exist beside the spec's directory list because each is a separate trust or
responsibility boundary (see `docs/architecture.md`).

## Worker isolation tiers (added after interface verification)

Verification found that a macOS keychain (subscription) login is invisible to
a `claude` process running inside srt, and that Claude Code's built-in sandbox
cannot run inside srt (`docs/interfaces/gaps-and-contradictions.md`). Workers
therefore run in one of two tiers, recorded on every worker and evidence
record:

| Tier | How | Requires | Edit/Write confinement |
|---|---|---|---|
| `os-sandbox` (preferred) | the whole `claude` process inside srt (`srt ... -- claude ...`) | a credential the user put in the environment: `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`) | OS level |
| `claude-sandbox` | `claude` unwrapped; built-in sandbox on with `failIfUnavailable`; permission deny rules; PreToolUse guard | nothing extra | Claude Code permission layer; Bash at OS level |

Both tiers load no user, project or local settings (`--setting-sources ""`,
`--strict-mcp-config`), so the repository's own hooks and MCP servers never
run. The controller's independent diff inspection gates either tier. Trusted
checks always run in srt.

## Workers outlive the controller

A controller crash must not kill workers; the next controller reattaches
(spec §4). Workers are started in their own session and process group, and
the systemd unit uses `KillMode=process` so a restart of the controller
service does not take the workers with it. Orphans are terminated by
reconciliation when their run is terminal or cancelled.

## Static security gate

The secret scan uses gitleaks when installed, always with Orbit's trusted
configuration and `--ignore-gitleaks-allow`, because a repository's own
`.gitleaks.toml` or allow comments would otherwise switch it off; without
gitleaks, Orbit's built-in secret patterns run and the evidence says so.
SAST runs only as checks the user defines in policy. With none defined, the
report lists static analysis as unverified rather than passed.

## Implementer escalation (gap G11)

The implementer starts on the routine tier (Sonnet) and escalates to Opus
only on observed difficulty: the same failure fingerprint recurring up to
`scheduler.repeated_failure_threshold`, or a diagnosis that records evidence
of a coupled or complex causal failure. A single failed attempt gets a repair
brief on the same tier. Once the diagnosis is solved, routine follow-up work
routes back down. Expected cost per verified task, not worker confidence,
drives the choice (spec §8).

## Codex reviewer tiers (added after the first live run)

The first live run showed that Codex's own read-only sandbox cannot start
inside srt on macOS: applying a Seatbelt profile from inside another fails
with `sandbox_apply: Operation not permitted` (reproduced with
`srt -- sandbox-exec ...`). The Codex reviewer therefore follows the same
two tiers as Claude workers:

| Tier | How | Read confinement |
|---|---|---|
| `os-sandbox` (preferred) | srt is the only sandbox; Codex runs with `--sandbox danger-full-access` inside it; srt allows writes only to the worker directory and Codex's own state, never the review checkout, egress only to the provider's hosts, and denies credential reads | OS level |
| `codex-sandbox` | no srt; Codex runs with `--sandbox read-only` | writes and network blocked for its commands; reads unrestricted, recorded as a limitation |

`danger-full-access` is passed only together with the srt wrapper; the
adapter refuses that flag in any other combination.

Second live finding: with a ChatGPT login, Codex inside srt connects through
the proxy (srt logs every request to chatgpt.com as allowed, and curl
reaches it through the same proxy) yet fails with "workspace routing
discovery failed". The cause is inside Codex's client and is not pursued
further here. The tier is therefore chosen by login type: with a ChatGPT
login Codex runs in the `codex-sandbox` tier; with an API key
(`CODEX_API_KEY` or `OPENAI_API_KEY`) it runs in the `os-sandbox` tier, which
was verified to reach the provider. `providers.codex.tier` (`auto`,
`os-sandbox`, `codex-sandbox`) overrides the choice, and the evidence always
records the tier and its limitations.
