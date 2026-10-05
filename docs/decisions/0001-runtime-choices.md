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

## Browsers under sandbox-runtime on macOS (added after live demo 2)

Chromium registers a Mach service at start
(`bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer.<pid>`) and
its child processes look it up. srt's Seatbelt profile allows only listed
`mach-lookup` names and has no `mach-register` option (also not in the latest
srt), so Chromium aborts and every browser journey fails. Four designs were
prototyped against the demo app's real suite and judged security first:

- **Chosen: two fixed Seatbelt rules.** `mach-register` and `mach-lookup` for
  the name pattern `^org[.]chromium[.]Chromium[.]MachPortRendezvousServer[.][0-9]+$`
  only, added by an Orbit-owned preload on the unmodified srt CLI, for UI-check
  processes only (never the app fixture or workers). Multi-process Chromium runs
  with `--no-sandbox`; srt stays its boundary (write allowlist, credential
  read-deny, egress filter), and a hostile repository gains nothing it lacked,
  since it already runs arbitrary code inside the same confinement. Measured
  8/8 on desktop and mobile across 10 runs. The preload fails closed (exit 97,
  reported as an environment error) if srt's spawn shape differs, and browser
  checks require the srt version the preload was verified against. Disclosed in
  every evidence report: Chromium without its own sandbox, and what the rules
  widen (a sandboxed process can look up or squat another Playwright Chromium's
  rendezvous name, at worst stopping that browser from starting). Only
  Playwright's bundled Chromium is supported under srt on macOS.
- Rejected: one browser per test in `--single-process` mode (any test needing a
  second context crashes; serial suites break); the browser outside srt with
  locked egress (page code could read `file://` paths, override the proxy per
  context, write through downloads and reach every loopback port: protocol
  limits that flags cannot close); a Linux container as the default (Docker
  plus a large image on macOS, Linux visual baselines differ). The container
  remains an explicit opt-in (`ui.isolation: container`), never an automatic
  fallback.
- Upstream: propose `allowMachRegister` to srt, then delete the preload.

On Linux there is no Mach and no rule is needed, but app and tests in separate
srt processes do not share loopback: srt always gives a bubblewrap sandbox its
own network namespace (`allowLocalBinding` is macOS-only), so the application
the app fixture starts is unreachable from the readiness probe, the host and a
browser in a second srt process (ECONNREFUSED). The provider says so
(`privateLoopback`), and each journey check then runs in one sandbox: an
Orbit-owned launcher (`src/ui/single-sandbox.ts`, passed to node as source)
starts the application, waits until it is ready, runs Playwright and stops the
application, under the check's profile plus the run's application directory
(write allowlist, credential read-deny, egress filter; loopback private to the
sandbox). Disclosed with the evidence (`ui-single-sandbox`): the application
gets the check's hosts and writable paths, and the journeys can see the
application's environment and processes. macOS keeps the two-process path.
Verified on arm64 Linux (node:22, srt 0.0.78, bubblewrap) with the demo's real
suite (`tests/integration/ui/ui-single-sandbox-srt.test.ts`): the two-process
path never becomes ready; in one sandbox the 6 functional and accessibility
journeys pass on desktop and mobile, and the 2 visual journeys fail only
because the demo's baselines are recorded for darwin (no baseline is written);
inside, the credential canary is unreadable, HOME is read-only and egress to a
host off the list fails. Not yet verified on x64 Linux CI. The container
provider has the same property (every container runs with `--network none`),
so it says `privateLoopback` too and the launcher runs with the image's
`node`; verified on macOS with OrbStack and the official Playwright image
(`tests/integration/ui/ui-single-container.test.ts`, skipped where that image
is not present): before, the application never became ready; now the 6
functional journeys pass in one container. The default check image
(`templates/worker.Dockerfile`) has no browser, so UI checks under the
container provider need an image with Playwright's browsers. Exploration
(`src/ui/explore.ts`) has no one-sandbox mode: the explorer is a worker in its
own sandbox, so under a provider with `privateLoopback` it does not start the
application and ends `app_failed` with that reason, and doctor says so.
