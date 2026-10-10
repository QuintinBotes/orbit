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
- **Downloads (added after live demo 3): an environment variable, not a
  rule.** Every browser download was cancelled under srt, with no logged
  denial. Bisecting the generated profile (deny default replaced with allow
  default, then one denied operation class at a time) narrowed it to
  `file-write-create` under `/private/var/folders/<..>/T`: Chromium writes a
  download to a temp file (`.org.chromium.Chromium.XXXXXX`) first, and on
  macOS its `base::GetTempDir` ignores `TMPDIR`, reading `MAC_CHROMIUM_TMPDIR`
  and otherwise the per-user temp directory, which is outside the write
  allowlist. For the same UI-check processes the provider sets
  `MAC_CHROMIUM_TMPDIR` to the check's private temp directory (the child's
  TMPDIR, `CLAUDE_CODE_TMPDIR`), only when that directory is already in the
  allowlist, never srt's shared `/tmp/claude`. Playwright passes its own
  environment to the browser unless a config sets `launchOptions.env`, so this
  reaches repositories whose Playwright config Orbit does not own; Playwright
  has no environment variable for launch arguments, and no Chromium switch
  for the temp directory was found. Security impact: none on the boundary. The
  Seatbelt profile still holds the two Mach rules and nothing more, no path,
  host or service is added, and repository code could set the variable
  itself. Rejected: allowing writes to the per-user temp directory (other
  applications' temp files live there) and widening the profile for
  `vfs.disk-space` or `com.apple.hiservices-xpcservice` (their denials were
  real but did not cause the cancellation). Verified by a CSV-download
  journey under the real srt (`tests/integration/ui/browser-isolation-srt.test.ts`,
  case g): cancelled before, passing on desktop and mobile twice after; case
  c checks the per-user temp directory stays unwritable inside.
- Rejected: one browser per test in `--single-process` mode (any test needing a
  second context crashes; serial suites break); the browser outside srt with
  locked egress (page code could read `file://` paths, override the proxy per
  context, write through downloads and reach every loopback port: protocol
  limits that flags cannot close); a Linux container as the default (Docker
  plus a large image on macOS, Linux visual baselines differ). The container
  remains an explicit opt-in (`ui.isolation: container`), never an automatic
  fallback.
- Upstream: propose `allowMachRegister` to srt, then delete the preload.
- The preload's rules are named sets, chosen by the query of its URL
  (`?rules=chromium`). A second set, one read-only rule for the sysctl
  `kern.nisdomainname` that .NET's HTTP clients need, is added for processes
  that run .NET (ADR 0009, addendum); without it the preload adds nothing.

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

## Workers and loopback (addendum, 2026-10-07, issue #31)

Context. In the 0.2.1 retest on a .NET repository (macOS), five of six
implementer sessions ran their own `dotnet test -m:1`, which built the project
and then aborted: `System.Net.Sockets.SocketException (13): Permission denied`
at `Socket.Bind`, from VSTest's `TestRequestSender.InitializeCommunication` and
`SocketServer.Start`, which listen on `IPAddress.Loopback:0` for the test host
to connect back to. The workers reported "tests not executed" and submitted
untested code, while the checks ran the same tests under `srt`, where a check
may listen (`local_binding`, default true, since the first live run).

Cause. Neither worker tier lets a worker listen. In the `os-sandbox` tier
`profileForWorker` sets no `allowLocalBinding`, so `srt` gets `false`. In the
`claude-sandbox` tier, the one the retest ran in (no Claude credential
exported), the `sandbox.network` block Orbit writes had no `allowLocalBinding`,
which Claude Code reads as `false`. Reproduced on macOS 27 with SDK 9.0.305 and
an xunit project, each with exactly what Orbit builds: `dotnet test -m:1` under
`srt` with the worker profile (`SocketException (13)` at `Socket.Bind`), and
the real `claude` CLI against a fake API with Orbit's settings file, its Bash
step running the same command ("Test Run Aborted", the same stack).

What granting it would grant (measured on macOS 27.0.1, `srt` 0.0.78, Claude
Code 2.1.292). A Node listener in the sandbox on each address, and a connection
from outside the sandbox, made to this machine's network (LAN) address for the
wildcard addresses, as another machine's would be:

| listener | `srt`, `allowLocalBinding` true | `srt`, false | Claude Code's sandbox, true | false |
| --- | --- | --- | --- | --- |
| 127.0.0.1 | accepted | EPERM | accepted | EPERM |
| ::1 | accepted | EPERM | accepted | EPERM |
| ::ffff:127.0.0.1 | accepted | EPERM | not measured | not measured |
| 0.0.0.0, connect via the LAN address | accepted | EPERM | accepted | EPERM |
| `::`, connect via the LAN address | accepted | EPERM | accepted | EPERM |

`srt` writes `(allow network-bind (local ip "*:*"))`, `(allow network-inbound
(local ip "*:*"))` and `(allow network-outbound (remote ip "localhost:*"))`.
Claude Code's sandbox was measured with the settings file Orbit wrote for an
implementer and a real `claude -p` session whose Bash steps started the
listeners. So the permission is not loopback only: a server on every
interface answers a connection made to the machine's network address while it
runs, as it would one from another machine (not measured from one), unless the
macOS firewall refuses it. The outbound rule is as wide (measured by the final
review, 2026-10-08, and again for this addendum): a process with the permission
reached a TCP service on this machine bound only to its LAN address, and a UDP
datagram it sent to that address arrived, so a check that may listen reaches
services on any address of this machine, not only on loopback. With the
permission off it can bind no UDP socket either.

Narrowing it in Orbit, where Orbit writes the Seatbelt rules (the `srt` tier
on macOS, for checks and workers), was tried with `srt`'s own rule off and each
candidate added by the `srt` preload, the named rule-set mechanism of
`chromium` and `nis-domainname`:

- `network-inbound` is what gates `listen()`: a `network-bind` rule alone left
  every listener refused, an inbound rule alone admitted them.
- `(local ip "localhost:*")` on bind and inbound, with outbound `(remote ip
  "localhost:*")`: listeners on 0.0.0.0, `::` and the LAN address itself were
  admitted, and each accepted a connection made to the LAN address. In a local
  address filter "localhost" matches every address of this machine (`srt`'s
  own source notes it matches the any-address for a connect). `tcp4` behaves
  the same; `ip6` divides by address family, not by address.
- A numeric host (`"127.0.0.1:*"`, or `"127.0.0.1:47123"`) is refused by
  `sandbox-exec` ("unsupported syntax"); Seatbelt accepts `*` and `localhost`
  only.
- A `remote` filter on `network-inbound` refuses every listener, loopback too
  (there is no peer at `listen()`), and `(deny network-inbound (remote ip
  "*:*"))` beside the listen rule, in either order, still let every connection
  in: Seatbelt does not check a connection's peer when it is accepted.

Apple's own profiles (`/System/Library/Sandbox/Profiles`) use "localhost" only
in remote filters. On macOS no Seatbelt rule limits a listener to loopback: a
sandboxed process listens on every address of this machine or on none. The
bare form, `sandbox-exec` with `(deny network-inbound)` and `(allow
network-inbound (local ip "localhost:*"))`, is pinned in
`tests/integration/isolation/worker-loopback.int.test.ts`, which also holds
the `srt` cases above for Orbit's own profiles. On Linux, from `srt` 0.0.78's
source: `sandbox-manager.js` treats any `network.allowedDomains`, empty
included, as a network restriction (Orbit always writes it) and passes
`allowLocalBinding` to the macOS wrapper only, and `linux-sandbox-utils.js`
then always starts `bwrap --unshare-net`: every sandbox has a network
namespace, and so a loopback, of its own, which its commands may use and
nothing outside can reach; its one way out is `srt`'s proxy bridge. Claude
Code 2.1.292 carries `srt`'s profile code, and its settings schema describes
`sandbox.network.allowLocalBinding` as "macOS only: If true, sandboxed commands
can bind to localhost ports", which on macOS the table above contradicts.

Decision. A worker gets no permission to listen, in either tier.
`profileForWorker` sets no `allowLocalBinding`; the Claude adapter hands the
provider `allowLocalBinding: false` whatever profile it is given; the
`claude-sandbox` settings write `sandbox.network.allowLocalBinding: false`,
which the strict settings schema holds (`const`). A worker runs model-driven
commands, and with the permission a server it started on 0.0.0.0 could serve
what it may read (the rest of the home directory, its Claude config directory)
to the network; Orbit can narrow that in neither tier. On Linux, where the
permission changes nothing, workers keep their private loopback, so a worker's
`dotnet test` runs there. There is no policy key: on macOS the one value Orbit
allows workers is none, and on Linux a key would change nothing. The
`network.local_binding` key this branch first added (default true) was never
released and is gone, with its handling of frozen snapshots. Checks keep
`local_binding` (default true) unchanged: their listener reaches the network
as measured above, as since the first live run, and narrowing it needs the
loopback-only rule Seatbelt cannot express; set `local_binding: false` on a
check that never serves. `orbit doctor` (`workers.loopback`) warns on macOS
for a .NET or Gradle repository, whose test runs always listen: workers cannot
run test hosts that need a loopback socket, in either tier, and the checks
that may listen run them; it says what to keep (the checks' `local_binding`)
and that Linux runs them in workers. It passes on macOS for other
repositories, saying the same, and on Linux.

Consequences. On macOS a worker's own run of a runner that listens is refused
in both tiers, and the worker reports those tests as not run; the checks run
them on every candidate and their failures go to diagnosis and repair as
before. The runners, measured under the worker profile in `srt` (all of them)
and in Claude Code's sandbox (those that listen, except Go's: there Go cannot
build at all, below), one shape each
(`tests/integration/isolation/loopback-runners.ts`). Refused in a worker on
macOS, and passing once `srt` may bind, as in a check: VSTest (`dotnet test
-m:1` of an xunit project, and its shape), a forked JVM that connects back over
loopback (how Gradle's test workers and Surefire's TCP fork channel work;
Gradle and Maven were not installed, so the shape stands in for them), Go's
`httptest` server under `go test -json`, a Python `http.server` and a Node
server in a test. Needing none, so running in a worker: `go test -json` itself
(test2json reads a pipe), a forked JVM over pipes (Surefire's default fork
channel), Node's child_process IPC and worker threads (Jest's and Vitest's
pools) and a child Python over pipes (pytest-xdist's execnet gateways);
pytest-xdist 3.8.0 and Jest 30.5 themselves passed under `srt` without it too.

Rejected: `srt`'s or Claude Code's `allowLocalBinding` for workers (what this
branch first did; it serves the network, measured above); a loopback rule set
in the preload (Seatbelt cannot express it, measured above); per-runner
settings in the repository (no runner setting changes which addresses Seatbelt
admits); turning the checks' `local_binding` off as well (it would stop the
checks running these tests, and their exposure is the existing one). Not
decided here, and left to the maintainer: a policy switch that opts workers
into `srt`'s broad rule knowingly, on macOS, for a repository that wants
workers to run VSTest at the cost above.

Not changed here, found while verifying: in the `claude-sandbox` tier the
toolchain scratch under the worker directory (`GOCACHE`, `CARGO_TARGET_DIR`,
`GRADLE_USER_HOME`) is not writable by sandboxed Bash, so a worker's `go test`
fails there before any test runs ("failed to initialize build cache"); a
separate follow-up. The review asked for doctor to say so, as the issue did:
`workers.toolchains` warns in that tier for a repository that uses Go, Rust or
the JVM (Go and Cargo measured with the real CLI, Gradle and Maven by their
variables), with the `os-sandbox` tier as the fix.

Found by CI (2026-10-08, GitHub's Ubuntu runner, .NET SDK 10): on Linux a
worker's own `dotnet build` never reached its listener. `srt` binds an
unopenable device over each git file a writable directory lacks, so
SourceLink's git query, which checks have had off since #10, failed every
build in a worker's worktree with "Error reading git repository information",
in both tiers; the .NET toolchain profile now turns it off for every process
that uses .NET, workers included. A worker's `HOME` remains the account's and
read-only. Before the controller starts a .NET worker, it gives `dotnet` a
private CLI home, so NuGet creates its config and first-run state there; the
worker cannot write the account home. `orbit doctor` warns about this first-use
state and names `dotnet restore`, run once outside Orbit, as the manual fix.
On GitHub's macOS runners the JDK
is found through `JAVA_HOME` alone, which a worker gets only in a repository
with a JVM build file (the toolchain's markers), as every Maven or Gradle
repository has.

Review (2026-10-07). An independent review of the branch's first form, which
let workers listen, measured what its argument had missed; each item was
reproduced before it was changed, and the changes stand now that workers do
not listen.

- IDE extensions' tokens. A running IDE extension (VS Code, JetBrains) writes
  `<config dir>/ide/<port>.lock` with the auth token of its MCP server on
  loopback, whose tools open, diff and save files in the editor and run code
  in a Jupyter kernel, outside every sandbox. Measured with the real `claude`
  CLI against a fake API and a stand-in server that answers only that token,
  while workers could reach loopback: in the `os-sandbox` tier the worker's
  Bash read the lock and the server accepted the token; in the
  `claude-sandbox` tier Bash could not read it (`EPERM`), but the Read tool,
  which runs outside Claude Code's sandbox there, returned the token to the
  model, and a Bash command carrying it was accepted. A check cannot read the
  lock: its profile denies every Claude config directory. Decision: the worker
  profile denies `<config dir>/ide` for reading and writing
  (`CLAUDE_CONFIG_DENIED`; in `srt` a denied path inside a writable one is
  write-denied too), and the worker settings deny `Read` on it in both tiers,
  for the config directory the CLI runs with (`CLAUDE_CONFIG_DIR`, else
  `~/.claude`). The test keeps loopback open in the `os-sandbox` tier (for its
  fake API), where the probe now ends `READ-FAIL EPERM` and the Read tool is
  refused (`tests/integration/adapters/worker-ide-lock.test.ts`). What is
  left, and stated in docs/security.md: the worker's own `.claude.json`
  (`~/.claude.json`, or the custom config directory's) stays readable, because
  the CLI must read it and in the `os-sandbox` tier runs inside the sandbox; it
  can hold the headers of MCP servers the user configured. A private config
  directory per worker would close that; Orbit does not create one yet.

  Final review (2026-10-08). This deny is not a second barrier behind "workers
  reach no loopback", as the draft said: a worker cannot reach the server, but
  a check can. A check with the default `local_binding` may connect to any
  loopback port on macOS, and it runs the code the worker wrote: a token the
  worker copies into the worktree reaches the server through it (measured by
  the review on this branch and on main: an `srt` check under
  `profileForCheck` read the token from a worktree file and a stand-in IDE
  server on 127.0.0.1 answered `200`). So keeping the token from the worker is
  the barrier for that path,
  and it had a gap. Claude Code 2.1.292 looks for lock files in `~/.claude/ide`
  whenever `CLAUDE_CONFIG_DIR` is set, so an IDE extension writes there for a
  worker whose config directory is another, and the settings denied `Read` on
  the worker's own `ide/` only: in the `claude-sandbox` tier the Read tool
  returned the token from `~/.claude/ide` (reproduced with the real CLI, a
  fake home and `CLAUDE_CONFIG_DIR` set elsewhere; the `os-sandbox` tier was
  not affected, since `srt` denies the other login whole). Decision: the
  settings deny `Read` on every other Claude login Orbit knows of
  (`otherClaudeLogins`: `CLAUDE_CONFIG_DIR` and `~/.claude`, with their
  `.claude.json`) whole, as the worker profile already denied them to the
  sandbox, and on its `ide/` alone when it holds a path the worker must read
  (a deny beats every allow); `~/.claude/ide/**` is a home credential
  location, so the guard hook refuses it too. The real-CLI test has both tiers
  with `CLAUDE_CONFIG_DIR` set elsewhere. Not covered: an IDE lock directory
  Orbit cannot know of, such as a config directory set only in the editor's
  environment. Narrowing what a check may reach on loopback would close the
  relay itself; Seatbelt cannot (above), so it is not done.
- Long commands that hold a session open. `claude -p` writes its result and
  then does not exit while a background task of the session is alive. A server
  the model started with `run_in_background`, or a foreground one Claude Code
  moved to the background when it outlived its Bash timeout, kept the session
  alive until the worker timeout (30 minutes for an implementer), and the
  adapter reported `timeout`, which recovery sends to diagnosis, for finished
  work. Measured with the real CLI against a fake API in both tiers (worker
  timeout 45 s): both shapes wrote their result within seconds and ended at
  45 s. In the review's control a background `sleep` did the same without
  loopback, so the defect does not depend on listening. Decision:
  `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` in every Claude worker's
  environment (adapters/env.ts), which removes `run_in_background` from the
  Bash tool and ends a foreground command at its timeout; both sessions now end
  with their result in seconds, with a long command that needs no listener
  (`tests/integration/adapters/worker-background.test.ts`), and the
  implementer and diagnosis prompts say to start and stop a server within one
  command. Rejected: ending the session in the shim once the result line is
  written (it would change how every provider's exit is judged, for a cause one
  environment variable removes), and a prompt alone (advisory). Not contained,
  and stated: a process a worker detaches itself (`nohup ... &`, `setsid`)
  outlives the session on macOS, because Claude Code starts each Bash command
  in a process group of its own (measured: the shell's process group is its own
  pid, not the shim's), beyond the shim's group kill, and Seatbelt has no
  process namespace. On Linux `srt` starts bubblewrap with a PID namespace and
  `--die-with-parent`, so what a command leaves ends with its sandbox (from
  `srt`'s source, not measured here). A sweep by environment marker is not
  possible on macOS 27, where `ps` shows no other process's environment, and a
  sweep by process tree misses a process whose shell has already exited;
  containing it is a follow-up. Such a process keeps the worker's sandbox and
  so its write access to the worktree, and it can go on editing the worktree
  after the session (final review: in both tiers a `nohup ... &` and a
  `spawn(..., { detached: true })` grandchild were alive three seconds after
  the adapter collected the result, their files in the worktree still
  changing). What it writes before the candidate is snapshotted is judged as
  the worker's change; what it writes later is in the tree the next attempt
  starts from. docs/security.md says so.
