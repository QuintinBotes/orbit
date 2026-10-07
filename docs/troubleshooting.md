# Troubleshooting

Start with `orbit doctor`. Every failure and warning prints what is missing and
the fix. `orbit doctor --probe` also makes small live requests to confirm that
credentials and each eligible model actually answer. `orbit doctor --json`
gives the same information for scripts. The command exits 1 when any check
fails.

Failures are fatal for a run that needs the capability. Warnings are
degraded but usable.

| Check id | Symptom | Cause and fix |
|---|---|---|
| `runtime.node` | Node is older than 22.16.0 | Install a current Node 22 LTS. The service uses the Node that ran `orbit service install`. |
| `runtime.sqlite` | `node:sqlite` is not usable | The Node build lacks `node:sqlite` or FTS5. Use Node 22.16 or newer from nodejs.org or a version manager. |
| `git.cli` | git is missing or too old | Install git 2.5 or newer. |
| `git.repo` | not a repository, base branch or remote missing, dirty tree | Run inside a git repository. Create the base branch, add the remote (`git remote add origin <url>`), or commit or stash changes (or set `repository.allow_dirty_start: true`). |
| `config` | no `.orbit/config.yaml` | Run `orbit init` (plugin: `/orbit:init`). |
| `config` | configuration is invalid | Fix each listed problem; unknown keys and contradictory settings are errors. Compare with `templates/config.yaml`. |
| `storage` | SQLite cannot use WAL | The repository is on a network share or a container bind mount. Use a local disk. |
| `storage` | state database problem or not writable | Fix permissions on `.orbit/`. If the database is newer than this Orbit, upgrade Orbit. |
| `scope` | `scope.allowed_paths (...) matches no tracked file` (warning) | The template's example globs match nothing in this repository, so a worker could change nothing. Set `scope.allowed_paths` to globs that match your source and test directories; the warning suggests some. |
| `checks` | a configured check's executable or script is missing | Install it, or correct the `command` in `checks`. With no checks defined, nothing can be verified. |
| `checks` | `orbit init` proposed no check, or fewer than expected | Init proposes only for tools on `PATH` that the repository declares, and only when it writes a new config; it prints each tool it skipped and why (`checks.not_proposed` with `--json`). Install the tool, or add the check by hand; see [Checks that `orbit init` proposes](configuration.md#checks-that-orbit-init-proposes). A proposed check that fails offline needs `network_hosts` for its dependencies. |
| `checks.sandbox` | `the sandbox refuses the executable of check X; a run would block at its baseline` | Under `sandbox-runtime`, doctor starts each check's executable (one installed outside the repository) in the sandbox that check gets, with a harmless argument (`--version`; `dotnet help`, which runs the .NET SDK's first-run steps; `go version`). The detail line shows what was refused. See [A check cannot run in the sandbox](#run-problems). A tool that exits non-zero with no denial in its output (an unknown `--version` flag) is not counted. |
| `checks.sandbox` | `check X would start MSBuild worker nodes, which the sandbox refuses; a run would block at its baseline` | The check (or `dependencies.install_command`, named so) runs `dotnet build`, `test`, `publish`, `pack`, `restore`, `clean`, `msbuild` or `run` itself (its command, the command `env` starts, or a command of a chain joined by `&&` or `;`) without `-m:1`, and its own `env` does not set `DOTNET_PROCESSOR_COUNT=1`. It is refused without being started; the fix is its command with `-m:1` added, ready to paste, with the reason once after all such fixes. A `-m:1` after the `--` of `dotnet test` goes to the test runner and does not count. See [.NET builds and MSBuild worker nodes](#run-problems). |
| `checks.sandbox` | `doctor cannot tell whether check X runs MSBuild on one node` (warning) | The check runs dotnet through make, a script, a wrapper or a shell line with a pipe, `\|\|`, a substitution or a redirection, which its definition does not show. Make sure every dotnet build, test, publish, pack, restore, clean or msbuild it starts passes `-m:1`; one that does not is stopped as soon as MSBuild records the refused node. `DOTNET_PROCESSOR_COUNT=1` in the check's `env` also clears this warning. See [.NET builds and MSBuild worker nodes](#run-problems). |
| `checks.sandbox` | `the sandbox refuses the go toolchain; checks that use it would block at their baseline` | One `toolchain <name>:` line per toolchain the checks or the repository use (Go, Rust, Python, JVM, .NET): whether its executable starts in the check sandbox with that toolchain's environment, where the repository's dependency caches live (`<orbit home>/toolchains/<repo key>/...`, "not created yet" before the first dependency install; on macOS, for a .NET repository with packages, that they are restored into it outside the sandbox, as `checks.dotnet-packages` says) and which build state is private to each check attempt. See [Toolchains under the sandbox](#run-problems). For .NET the line does more than start `dotnet`: it builds three generated projects with no packages (offline, from the SDK alone) in the sandbox of the check that uses .NET, its `env` included (so `DOTNET_PROCESSOR_COUNT=1` there gives the probe one node too), with the node switch MSBuild gets from that check's command (`-m:1` for a check that runs dotnet through make or a script, or whose dotnet commands do not build), so a build the sandbox refuses (an MSBuild worker node denied its pipe) shows here with the refused node and the fix. A refused toolchain, of any kind, fails doctor when a mandatory check runs the toolchain's executable itself, and is a warning otherwise. |
| `checks.sandbox` | `check X runs dotnet format, which loads the project through a build host the sandbox refuses its named pipe; a run would block at its baseline` | Every form of `dotnet format` but `dotnet format whitespace --folder` loads the project through a build host whose named pipe .NET binds under `/tmp`, which the sandbox refuses. The check is refused without being started (a warning when it is optional); the fix is its command with `dotnet format whitespace --folder --verify-no-changes` in place of that `dotnet format`, in the folder of the solution or project it names and with its `--include` and `--exclude`, ready to paste. See [dotnet format under the sandbox](#run-problems). |
| `checks.dotnet-packages` | `this repository's NuGet packages cannot be downloaded inside the sandbox on macOS (...)` (warning), or `dependencies.install_command restores NuGet packages, which cannot be downloaded inside the sandbox on macOS (...), and this repository's NuGet cache is empty` (or `and a package version floats, which every restore looks up at nuget.org`) | macOS under `srt`, a .NET repository with packages (a `PackageReference`, `packages.lock.json`, `Directory.Packages.props`, `packages.config`, a local tool manifest, or an MSBuild SDK that NuGet resolves, in its tracked files). The sandbox keeps the system trust service out of reach, so .NET cannot verify nuget.org's certificate. Run the command the fix prints, once, in a terminal (outside the sandbox), and again whenever the packages change: it restores the projects' packages and the local tools into this repository's NuGet cache, at the path the detail line shows. The dependency install and the checks then restore offline from it, except a floating version (`13.*`), which the detail lines name: pin it or use a lock file. See [.NET HTTP clients and NuGet restore on macOS](#run-problems). |
| `checks.dotnet-audit` | `NuGet's vulnerability audit cannot reach nuget.org from the sandbox on macOS, and Directory.Build.props turns it on where Orbit turns it off: with warnings as errors, its warning NU1900 fails dependencies.install_command and check build` | macOS under `srt`, a .NET repository with packages that sets `NuGetAudit` to true itself (a project or MSBuild import, a check's `env`, or `-p:NuGetAudit=true`) while warnings are errors (`TreatWarningsAsErrors`, `NU1900` in `WarningsAsErrors`, `-warnaserror`). Orbit turns the audit off in the sandbox through the environment, which such a setting overrides, so `NU1900` fails every restore there. Make the change the fix names: in each file, `<NuGetAudit Condition="'$(NuGetAudit)' == ''">true</NuGetAudit>`, which keeps the audit on everywhere else; a check's `env` or command loses its setting. A fail when the dependency install or a mandatory check restores; a warning when only optional checks, make or a script, or a setting under a condition doctor cannot evaluate are involved. See [.NET HTTP clients and NuGet restore on macOS](#run-problems). |
| `checks.dotnet-tests` | `check X sets DOTNET_PROCESSOR_COUNT=1 in its env, which its test host gets too: xunit before 2.8 deadlocks a test that blocks on async code there, and the check times out` (warning) | A tracked test project references xunit before 2.8 (the detail lines name each project and version), and a .NET check whose command names tests sets the variable in its own `env` (which `checks.sandbox` accepts as one MSBuild node). Remove it and pass `-m:1` in the command instead, or upgrade xunit; see [.NET builds and MSBuild worker nodes](#run-problems). |
| `isolation` | sandbox-runtime unavailable | Install `srt` (`npm install --global @anthropic-ai/sandbox-runtime`); on Linux install bubblewrap. A plugin install and a clone after `npm ci` carry their own `srt`; if doctor says it is missing there, the plugin's or the clone's install did not finish (run `npm ci` in the clone, or reinstall the plugin). Orbit will not fall back to weaker isolation. |
| `isolation` | container image not present locally | `docker pull <image>`. Containers run with `--pull never`. Make sure the Docker daemon is running. |
| `isolation` | `none` provider warning | Workers run with your full permissions. Use `sandbox-runtime` or `container`. |
| `isolation` | `isolation.require_resource_limits is true but ... cannot enforce isolation.limits.memory_mb` | The provider has no hard memory cap. Use `isolation.provider: container` with `container.memory_mb` no higher than `limits.memory_mb`, set `limits.memory_mb: null`, or set `require_resource_limits: false`. |
| `claude.cli` | claude not usable | Install Claude Code and put it on PATH, or set `providers.claude.command`. Sonnet 5.5 needs 2.1.284 or newer. |
| `claude.auth` | credentials expired, invalid or missing | `claude auth login`, or export `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`. For the service, make the variable visible to it (see [operations](operations.md#installing-the-service)). Then `orbit resume <run-id>`. |
| `claude.plugins` | `workers would load N plugin(s) the policy does not allow, so every worker session would be refused` (failure), or `workers may load ...` (warning) | A managed plugin is loaded into every worker. Add the exact ids doctor prints to `agents.allowed_plugins` (or set `agents.allow_managed_plugins: true` to allow every managed plugin) in `.orbit/config.yaml`; a plugin can add hooks and tools to workers. `orbit run --foreground` refuses to start with the same message and fix, before a run, a check or a model call exists; a run handed to the service (`--detach`) is blocked at the start of PREFLIGHT with nothing spent. A run that already exists keeps its frozen policy: cancel it and start a new run. See [Plugins in worker sessions](configuration.md#plugins-in-worker-sessions). |
| `claude.worker-tier` | workers use the `claude-sandbox` tier | No exported Claude credential, or not using sandbox-runtime. Export `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` and use `isolation.provider: sandbox-runtime` for the `os-sandbox` tier. |
| `codex.worker-tier` | the Codex reviewer uses the `codex-sandbox` tier | No `CODEX_API_KEY` or `OPENAI_API_KEY` in the environment (a ChatGPT login cannot run under `srt`), or not using sandbox-runtime. Export an API key and use `isolation.provider: sandbox-runtime` for the `os-sandbox` tier. With `providers.codex.tier: os-sandbox` and no `srt` the check fails and a run is refused with `ISOLATION_UNAVAILABLE`; set the tier to `auto` or `codex-sandbox`, or fix `srt`. |
| `codex.cli`, `codex.auth` | codex missing or logged out | Install the Codex CLI, `codex login` or export `CODEX_API_KEY`. Not required if independent review is off. |
| `review` | independent review would block | Read the reason. `providers.codex.data_policy_eligible is not true`: set it to `true` if sending sanitized code to Codex is permitted. `"codex" has no model qualified for review`: run `orbit models refresh` (it reads Codex's model catalog) or set `providers.codex.model` to a model you accept. Codex logged out: `codex login`. Or turn off `review.independent_provider_required` knowingly. A run that is already frozen keeps its policy; see [A run is `BLOCKED`](#run-problems). |
| `models` | no allowed Claude model is eligible | Allow `sonnet`, `opus` or `haiku` in `routing.allowed_models`, and upgrade `claude` if a minimum version is shown. `orbit models list` explains each model. |
| `playwright` | `@playwright/test`, browsers or axe missing | `npm install -D @playwright/test @axe-core/playwright` in the repository, then `npx playwright install chromium`. |
| `ui.browser-isolation` | `srt X is not 0.0.78 ... browser checks are refused` (macOS) | The Chromium preload was verified against `srt` 0.0.78 only, so UI checks raise `ISOLATION_UNAVAILABLE` with any other version. Install `@anthropic-ai/sandbox-runtime@0.0.78`. |
| `ui.browser-isolation` | `headless Chromium did not start under srt`, or `did not render the test page` (macOS) | Run `npx playwright install chromium` in the repository. Only Playwright's bundled Chromium is supported under `srt` on macOS: not `channel: 'chrome'`, Firefox or WebKit, and not `chromiumSandbox: true`. |
| `ui.browser-isolation` | `Linux: ... one sandbox (ui-single-sandbox)` (pass) | Information, not a fault. Every `srt` sandbox on Linux has its own loopback, so each journey check starts the application and runs the browser in one sandbox, and the evidence says so. UI exploration (`ui.exploration`) ends `app_failed` under `srt` on Linux, because neither the explorer nor a reproduction spec could reach the application. |
| `delivery` | `gh` not found | Install the GitHub CLI. |
| `delivery` | `GH_TOKEN` not set | Export a fine-grained token scoped to the repository in the environment the controller runs in. A keyring login is refused. |
| `delivery` | `gh auth status` failed | Create a new valid token and export it. |
| `gitleaks` | not installed (warning) | Optional. Install gitleaks for a stronger secret scan. |
| `service` | no service installed (warning) | `orbit service install`. Without it runs progress only while a terminal is attached. |
| `service` | installed but not loaded | `orbit service install` reloads it. |
| `service` | heartbeat is stale | The controller may be wedged. Read `~/.orbit/logs`, then `orbit service install` to restart it. |
| `service` | lingering is off (Linux) | `loginctl enable-linger <user>`, or the service stops at logout. |
| `guard.terms` | no publish-guard terms file | Create `~/.config/publish-guard/terms.txt`, or set `guard.terms_file`. Required when `knowledge.share_globally` is true. |

## Run problems

- **`orbit run` refuses to start.** "cannot start a run: ... No run was created and
  no model was called". The message names the cause: uncommitted changes (commit or
  stash them; `.orbit/` is exempt; or set `repository.allow_dirty_start`), git
  configuration that holds credentials (remove them and use a credential helper),
  or a failing environment check (isolation, credentials, reviewer: run
  `orbit doctor`). Nothing needs cleaning up.
- **A run is `BLOCKED`.** `orbit status <run-id>` and `orbit report <run-id>
  --interim` give the reason. Answer questions with `orbit decide`, fix the
  environment, then `orbit resume <run-id>` (with `--foreground` when no service
  is running: without a service, `resume` clears the block and says "No controller
  is running"). **Exception: a block that comes from the frozen policy.** If the
  reason says "This comes from the run's frozen policy (...)", the run keeps the
  policy it started with, so editing `.orbit/config.yaml` and resuming blocks
  again, and `orbit resume` refuses with exit 5. Fix the config, `orbit cancel
  <run-id>`, and start a new run with `orbit run`. If the fix was outside the
  policy (for example `orbit models refresh`), `orbit resume <run-id> --force`
  continues the same run; not for a misconfigured check, whose command is the
  policy's: a forced resume runs the same command again, so it blocks again
  unless the tool changed outside the policy, and the reason names only a new
  run. A missing target the contract does not name is a frozen-policy block too
  (`orbit resume` refuses it, exit 5), but its reason says "Check X is
  misconfigured ... the contract does not name it as the proof of any criterion"
  and gives advice by cause, not "fix the config" (see "A check's target does not exist yet" below);
  a new run in every case, since even a forced resume reads the recorded baseline
  and blocks again. The cases are listed in
  [operations](operations.md#pause-resume-cancel).
- **`resume` exits 5 (CONFLICT).** A live controller owns the run, open material
  questions remain, or the block comes from the frozen policy. Answer the
  questions, start a new run, or pass `--force` if you accept the risk.
- **`orbit verify` exits 14 or 15.** 14 means the evidence verdict is FAIL; hand it to
  `orbit repair <run-id>`. 15 means a mandatory criterion is unproven; treat the work as
  not done and look at which criterion has no evidence. A criterion reading "no new
  evidence" means its checks were already green on the base revision and the candidate
  adds or changes no test, so the green result proves nothing about the change; an
  INCOMPLETE verdict on a candidate that changes nothing means the same.
- **A worker fails with "exceeded the N output token maximum".** The response outgrew
  `routing.output_budgets` for its role. Orbit retries the unit once with the cap doubled
  (up to 32000) and records `worker.output-cap-raised`; if it still overflows, raise that
  role's budget in the config and start a new run.
- **A release run is BLOCKED at the merge or deploy.** Read `orbit status <run-id>`. Common
  causes: the pull request is still a draft and `release.merge.mark_ready` is false; the base
  branch moved and `actions.rebase_task_branch` is false; a deploy outcome is unknown and the
  environment has no `verify_command`. See [release mode safeguards](operations.md#release-mode-safeguards).
- **A UI check ends in ERROR with "the browser could not start under sandbox-runtime".**
  The run blocks at once as an environment failure; no repair is spent. The
  reason names the cause: "Chromium could not register its Mach rendezvous
  service" (the `bootstrap_check_in ... MachPortRendezvousServer` FATAL: the
  rules were not applied, for example an `srt` that Orbit did not start with its
  preload); "Chromium's own sandbox could not start inside srt" (the
  repository's Playwright config sets `chromiumSandbox: true`; remove it);
  "only Playwright's bundled Chromium is supported" (a project uses Firefox,
  WebKit or Google Chrome); or "the srt preload refused srt's sandbox command
  (exit 97)" (the installed `srt` builds its sandbox command in a shape the
  preload was not verified against; install `@anthropic-ai/sandbox-runtime@0.0.78`).
  Only `srt` on macOS is classified this way, only when no journey passed, and
  only from Playwright's own `browserType.launch` errors; a preload refusal
  counts only when the preload recorded it in Orbit's settings directory (a
  command's own exit 97 does not). Anything else stays a journey failure.
  `orbit doctor` (`ui.browser-isolation`) launches Playwright's real headless
  Chromium binary through the preload, with no repository code, to check this.
- **A check cannot run in the sandbox.** The run blocks at PREFLIGHT with "Check X
  could not run on the base revision ..., and the output shows an environment
  cause, not a pre-existing failure", the first error line, the log and a fix
  (checks with the same cause are named together, with their evidence once). The
  check never got as far as the repository's code: the sandbox or the operating
  system refused it a filesystem operation outside its checkout (EPERM, "Operation
  not permitted", EACCES, "Permission denied", a Seatbelt `deny(1) file-...` line;
  on Linux, where `srt` mounts everything outside the writable paths read-only,
  EROFS, "Read-only file system"); refused MSBuild the named pipe of a worker node,
  a Unix socket under `/tmp` the sandbox does not let a check create (the
  runner's note "the check sandbox denied MSBuild node (pid N) its named pipe"
  with the fix for the check's command, written when it stopped the check, or
  `MSBUILD : error MSB1025` with `System.Net.Sockets.SocketException (13):
  Permission denied` from `dotnet test`: build on one MSBuild node with `-m:1`
  on the check's dotnet command, for example `[dotnet, test, -m:1]`, when it is
  one that hands its arguments to MSBuild; see ".NET builds and MSBuild worker
  nodes"); refused `dotnet format`'s build host its named pipe (a
  `TimeoutException` under `BuildHostProcessManager` on macOS, "unable to
  connect to it's pipe" on Linux: `dotnet format` takes no `-m:1`, so use the
  form that loads no project, see "dotnet format under the sandbox");
  refused a connection through its network proxy (`curl:
  (56) CONNECT tunnel failed, response 403`, `X-Proxy-Error:
  blocked-by-allowlist`, NuGet's "The proxy tunnel request ... failed with status
  code '403'": add the host to the check's `network_hosts`, or restore
  dependencies in the dependency install); NuGet's HTTP client could not start in
  the sandbox (`error NU1301: The type initializer for
  'System.Net.CookieContainer' threw an exception` with `GetDomainName: -1`:
  Orbit adds the rule .NET needs for it only with the `srt` it ships, and the
  check's record says when it was not added; see ".NET HTTP clients and NuGet
  restore on macOS"); the program its
  command runs is not installed where it runs (the shell's "command not found",
  exit 127: install it or give the check a PATH that holds it, or correct a
  misspelled name, which needs a new run); or it was killed by a crash signal
  before printing anything. Such a failure is not recorded as pre-existing and no
  baseline exception is offered, since accepting one would let a run pass with a
  check that never ran. Output that shows a compile error or a failing test is
  never read this way (a failing test in any runner's report: TAP, Jest,
  pytest, unittest, go, cargo, VSTest's `Failed!  - Failed: 1`,
  Microsoft.Testing.Platform's `failed X (12ms)` and `failed: 1`, which xunit v3,
  MSTest's runner and TUnit print, and xunit's `[FAIL]`): that failure stays the
  code's, and so does a socket refused to the repository's own program. A
  restore error inside `dotnet build` on the base revision is read this way even
  though MSBuild counts it in "N Error(s)", when every error it counted is a
  restore error (`NUxxxx`) or `MSB1025`; on a candidate that count is the
  change's unless the base revision failed the same way. On a candidate the same
  refusal blocks the run without a repair attempt only when the check showed it
  on the base revision too (EACCES, a socket, a .NET named pipe, the network
  proxy and NuGet's client need the same one there); a refusal the change
  brought is repaired. Run `orbit doctor` (`checks.sandbox`) to see what the
  tool is refused, then let it keep its files in the check's `HOME` or `TMPDIR`
  (each check gets a private, empty one; set the tool's variables in the
  check's `env`) or change the check. `orbit resume <run-id>` runs those checks
  again once the environment is fixed; a changed check definition needs a new
  run. The rules are in
  [ADR 0010](decisions/0010-base-failure-classification.md).
- **A check is misconfigured.** The run blocks at PREFLIGHT with "Check X is
  misconfigured, not a pre-existing failure", the tool's error line, "command in
  checks.X.command" and the log. The tool the check runs rejected the command
  line itself: an MSBuild command-line error (`MSB1001` unknown switch outside
  `dotnet test`, `MSB1008` more than one project), go's `flag provided but not
  defined` or `unknown command` (exit 2), or cargo's `unexpected argument`. No
  baseline exception is offered, and none can be approved. Run the command by
  hand in a clean checkout, correct it in `.orbit/config.yaml` and start a new run
  (`orbit resume` refuses, because the command is in the run's frozen policy; a
  forced resume runs the same command again, so it blocks again unless the tool
  changed outside the policy).
  Only the check's own direct invocation of the tool is read this way: its program
  (after a leading env assignment, `env`, an npx-style runner or `python -m`) is
  the tool, the command is not a shell chain or pipeline, and what the error names
  is what the command names. A usage error printed by a script of the repository
  (`npm test` whose script runs a wrong command, or `cd client && npm test` in a
  package with no test script: npm's `> acme@1.0.0 test` banner shows it ran the
  check's script), a chain (`dotnet restore && npm test`) or a program the check
  runs (`dotnet run --project build/...` printing
  `MSB1008`) is the repository's code, so it stays a pre-existing failure; so is
  an argument from the repository's own configuration (pytest's `addopts`, a
  `Directory.Build.rsp`).
- **A check's target does not exist yet.** The check's command names something
  the base revision does not have: `MSB1003` (no project in the directory),
  `MSB1009` (no such project), `MSB1011` (more than one in the directory, which
  the goal may leave with one), `dotnet test`'s `MSB1001` unknown switch (a test
  platform's option, `--report-trx`, before the repository runs its tests on
  it), `npm error Missing script` for the script the command runs, pytest's
  `file or directory not found` or `unrecognized arguments` (exit 4; an option
  of a plugin or a `conftest.py` not there yet, `--cov` without pytest-cov or
  `-n` without pytest-xdist, says the same as a misspelled one), dotnet's "Could
  not execute because the specified command or file was not found", cargo's `no
  such command` (exit 101), or a script of the repository the shell cannot find
  (exit 127). PREFLIGHT lets the run go on, because the goal may be to create it.
  When the contract names the check as the proof of a criterion, its question is
  withdrawn and the check is expected to pass on the candidate. When it does not,
  the run blocks at CONTRACTING with "Check X is misconfigured, not a pre-existing
  failure: ... the contract does not name it as the proof of any criterion" and
  advice of its own, by cause. If the goal is meant to create what the command
  names, start a new run whose goal says so. If a tool that is not installed or
  restored yet provides it (a cargo plugin, a dotnet local tool, a pytest
  plugin), install or restore it and then start a new run. If the command is wrong, correct `checks.X.command` in
  `.orbit/config.yaml` and start a new run. Each needs a new run because
  CONTRACTING reads the baseline PREFLIGHT recorded: `orbit resume` would read
  the same failure and block again, so the reason does not offer `--force`. It is
  never accepted as a baseline exception: a check whose target does not exist
  tests nothing.
- **.NET checks under the sandbox.** A check's `HOME` is new and empty, so every
  `dotnet` command is the SDK's first run, and its first-run NuGet migrations take
  a named mutex. The .NET runtime keeps named mutexes under `/tmp/.dotnet` (and
  creates it through `/tmp/.coreclr.XXXXXX`): a path compiled into the runtime that
  ignores `TMPDIR` and `HOME`, and that no check's sandbox may write, because it is
  shared by every .NET process on the machine. The only override,
  `DOTNET_SANDBOX_APPLICATION_GROUP_ID`, points at an existing macOS app group
  container under the real home directory, not at the check's temp directory.
  Without help the check died in about two seconds with `mkdir("/tmp/.dotnet/shm/session...")
  == -1; errno == EPERM` (or `mkdtemp("/tmp/.coreclr...")`) before building
  anything. Orbit now prepares every check for it: the check's home records the
  NuGet migrations as done (`~/.local/share/NuGet/Migrations/1`; a new home has
  nothing to migrate), `DOTNET_CLI_HOME` is the check's private home, and
  `DOTNET_CLI_TELEMETRY_OPTOUT=1`, `DOTNET_NOLOGO=1`,
  `DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1`, `DOTNET_GENERATE_ASPNET_CERTIFICATE=false`
  (no login keychain), `DOTNET_ADD_GLOBAL_TOOLS_TO_PATH=false` (no shell profile)
  and `DOTNET_SKIP_WORKLOAD_INTEGRITY_CHECK=1` are set, as is
  `EnableSourceControlManagerQueries=false`, an MSBuild property MSBuild reads
  from the environment: the build no longer asks git for the commit, branch and
  remote that SourceLink embeds, which a check's result does not need. On Linux
  that query cannot run: `srt` protects the files that can make git run code
  (`.gitmodules`, `.gitconfig`...) by binding an unopenable device over each one
  the checkout lacks, so the SDK failed with "Error reading git repository
  information: Access to the path '.../.gitmodules' is denied". A check's own `env`
  overrides any of them. With that, `dotnet build` of a console project runs
  under `srt` (verified with the .NET 9 SDK on macOS, and the .NET 9 and 10 SDKs on
  Linux). Three cases remain yours to decide:
  code under test that creates a named `Mutex` or `Semaphore` needs
  `/tmp/.dotnet` and cannot run under `sandbox-runtime` (change the code to use
  an unnamed one or a file lock in `TMPDIR`; `isolation.provider: container`
  gives each check its own `/tmp`, which Orbit has not verified with .NET); a project with NuGet packages reads them
  from the repository's read-only NuGet cache (`NUGET_PACKAGES`), so restore them in the dependency install
  (`dependencies.install_command: [dotnet, restore, --locked-mode, -m:1]`, which reaches `api.nuget.org`; on macOS
  see ".NET HTTP clients and NuGet restore on macOS" below).
- **.NET builds and MSBuild worker nodes.** `dotnet build`, `dotnet test` and the
  like run MSBuild with one node per processor. Whenever a restore or build has two
  projects to work on at once (a test project referencing two libraries, any
  solution), MSBuild starts a worker node, a separate process that binds a named
  pipe, which .NET implements as a Unix socket at `/tmp/MSBuild<pid>`: a path MSBuild
  fixes whatever `TMPDIR` says, outside every check's writable paths and shared by
  every MSBuild on the machine. The sandbox refuses it (macOS Seatbelt denies
  `file-write-create` of the socket; on Linux `srt`'s seccomp filter
  refuses every Unix socket), the node dies with `System.Net.Sockets.SocketException
  (13): Permission denied`, and the build fails: on macOS after MSBuild has waited
  30 s for each of ten node starts (five minutes, then `Build FAILED` with no error
  from `dotnet build`, `MSBUILD : error MSB1025` from `dotnet test`), on Linux
  within a second and with no error at all.

  So every dotnet command a check runs pins one node itself: add `-m:1` (or
  `-maxcpucount:1`) to `dotnet build`, `test`, `publish`, `pack`, `restore`,
  `clean` and `msbuild`, in place of any `-m:N`. `dotnet run` hands `-m:1` to
  the program instead of MSBuild, so build first and run without building:

  ```yaml
  checks:
    test:
      command: [dotnet, test, tests/Acme.Tests, -m:1]
    smoke:
      command: ["dotnet build -m:1 && dotnet run --project src/Acme --no-build"]
      shell: true
  dependencies:
    install_command: [dotnet, restore, --locked-mode, -m:1]
  ```

  `orbit doctor` fails a mandatory check (and the dependency install command)
  that runs one of these itself without `-m:1`, before starting anything, and
  prints its command with `-m:1` added; an optional one is a warning. It reads
  each command of a chain joined by `&&`, `;` or a new line (`cd src && dotnet
  test -m:1`, and the `dotnet run` form above, pass), the command `env` starts,
  and the script of `sh -c`. A `-m:1` after the `--` of `dotnet test` goes to
  the test runner, not to MSBuild, so put it before the `--`. A check that runs
  MSBuild through make, a script or a shell line with a pipe, `||`, a
  substitution or a redirection cannot be judged from its definition: doctor
  warns that it cannot tell, and the same fix applies to every dotnet command it
  starts. If one runs
  without `-m:1` anyway, the runner stops it as soon as MSBuild records the
  refused node (a crash report in the check's private `TMPDIR`) and records it
  FAILED with the pipe and the fix for that check's command, instead of waiting
  out the five minutes. On the base revision the run then blocks with that fix
  as an environment failure, with no baseline exception question. On a
  candidate the same record goes to repair, unless the check showed it on the
  base revision too: a node the base revision did not start is the change's (a
  second project under a check without `-m:1`, a test that runs `dotnet
  build`), as for every denial in [ADR 0010](decisions/0010-base-failure-classification.md).
  `orbit init` proposes `-m:1` already. Workers in a .NET repository are told
  the same in their instructions.

  `DOTNET_PROCESSOR_COUNT=1` in a check's `env` also keeps MSBuild on one node,
  but Orbit does not set it: it reaches the test host too, where **xunit before
  2.8 deadlocks** a test that blocks on async code (`.Result` or `.Wait()` on a
  method whose continuation comes back to xunit's context; xunit runs a test
  assembly on one thread per processor, and the continuation waits behind the
  blocked test forever), and the check times out with a log that ends at
  `Starting test execution`. A check may still set it in its own `env`:
  `orbit doctor` accepts that as one node (unless a switch asks for more), and
  `checks.dotnet-tests` names the tracked test projects on such an xunit.
  Opening the pipes instead is not an option: `/tmp/MSBuild<pid>` would have to
  be writable by every check, and a check that could connect there could hand
  work to an idle MSBuild node of yours, outside the sandbox.
- **.NET HTTP clients and NuGet restore on macOS.** Every .NET HTTP client reads
  the machine's NIS domain name when it starts, which `srt`'s Seatbelt profile
  does not allow on its own: a restore failed with `error NU1301: ... The type
  initializer for 'System.Net.CookieContainer' threw an exception ...
  GetDomainName: -1`, and so did a test that makes an HTTP request. Orbit adds
  one read-only rule for that name to the checks, the dependency install,
  workers and doctor's probes that run .NET (ADR 0009, addendum); it needs
  `srt` 0.0.78, the version Orbit ships, and the check's record says when it was
  not added. Approved operations, the UI app and release commands do not get it
  yet. HTTPS needs the system trust service as
  well, which the sandbox keeps out of reach (it could fetch from any host for a
  sandboxed process), so on macOS a restore from nuget.org inside the sandbox
  stops at `NU1301: ... The SSL connection could not be established`. Fill the
  repository's NuGet cache outside the sandbox instead, once and whenever its
  packages change: `orbit doctor` (`checks.dotnet-packages`) prints the exact
  command for the repository, for example `(cd ~/src/acme && NUGET_PACKAGES=<orbit
  home>/toolchains/<repo key>/nuget dotnet restore -m:1)`, or the dependency
  install's own restore with `-m:1`, followed by `dotnet tool restore` when the
  repository has a local tool manifest (`.config/dotnet-tools.json`) or the
  install restores tools: local tools are NuGet packages in the same cache. It
  counts as packages a `PackageReference`, a lock file, `Directory.Packages.props`,
  `packages.config`, a tool manifest, and an MSBuild SDK that NuGet resolves
  (`Sdk="MSTest.Sdk/3.6.0"`, `<Sdk Name="..." Version="..." />`, `msbuild-sdks`
  in `global.json`), which the fill command's restore caches too. Doctor fails
  while `dependencies.install_command` restores packages and that cache is
  empty, since the install would fail. Run it
  in a terminal, on your own checkout: like any `dotnet restore`, it evaluates
  the repository's MSBuild files outside the sandbox. The dependency install and the checks then restore
  from it with nothing to download. A check runs with a home of its own, so a
  check that runs a local tool restores it first (`dotnet tool restore &&
  dotnet csharpier --check .`), from the cache, with no network. A floating
  version (`Version="13.*"`) is the exception: every restore looks it up at
  nuget.org, cache or not (`NU1301`), so doctor names it and fails while the
  install restores projects; pin it, or restore with a lock file
  (`RestorePackagesWithLockFile`, then `packages.lock.json`), which restores
  from the cache. NuGet's vulnerability audit cannot reach
  nuget.org from the sandbox either (on Linux a check has no network unless it
  lists the host), so Orbit sets `NuGetAudit=false` in the environment of every
  .NET process there: otherwise each restore waits on it and warns `NU1900`,
  and a repository that treats warnings as errors (`TreatWarningsAsErrors`,
  `-warnaserror`) fails the install and every restoring check with `error
  NU1900: Warning As Error`. A check's own `env` can set it back. A project or
  MSBuild import that sets `NuGetAudit` itself overrides the environment:
  `orbit doctor` (`checks.dotnet-audit`) fails such a repository on macOS when
  warnings are errors, and names the change, `<NuGetAudit
  Condition="'$(NuGetAudit)' == ''">true</NuGetAudit>`, which keeps the audit
  everywhere else. On Linux, or with `isolation.provider:
  container`, the dependency install downloads the packages itself. After the
  dependency install, checks can build with `--no-restore`, which needs no
  network on any SDK; a restore in a check reached nuget.org with Ubuntu's own
  `dotnet-sdk-8.0` package, which also downloads the app host pack.
- **dotnet format under the sandbox.** Every form of `dotnet format` except
  `dotnet format whitespace --folder` (`whitespace` without `--folder`, `style`,
  `analyzers`, and `dotnet format --verify-no-changes`, with or without
  `--no-restore`) loads the project through Roslyn's MSBuildWorkspace, which
  evaluates it in a build host: a separate process that binds a named pipe at
  `/tmp/<guid>`, a path .NET fixes whatever `TMPDIR` says, like MSBuild's
  `/tmp/MSBuild<pid>` (SDK 9 and later; SDK 8 loads the project in its own
  process, see below). The sandbox refuses it, and the build host exits at once.
  On macOS (SDK 9) `dotnet format` then waits 60 s for it and fails with
  `Unhandled exception: System.TimeoutException: The operation has timed out`
  under `BuildHostProcessManager`, with nothing in its output about the
  sandbox; on Linux (SDK 10) it fails at once with "The build host was started
  but we were unable to connect to it's pipe". Its implicit restore of a
  project with project references is also refused MSBuild worker nodes, and no
  switch of `dotnet format` passes `-m:1` to it. Orbit opens nothing for it:
  `/tmp` is shared by every process of yours, and Unix sockets in the check's
  private temp directory would not reach that pipe. So under `sandbox-runtime`
  a format check is the form that loads no project:

  ```yaml
  checks:
    format:
      command: [dotnet, format, whitespace, --folder, --verify-no-changes]
  ```

  It reads the files and checks whitespace only, from the `.editorconfig`; run
  the style and analyzer checks (`dotnet format --verify-no-changes`) outside
  Orbit, in CI. Given a solution or project (`dotnet format src/Acme.sln
  --exclude gen`), it reads that file's folder, and keeps `--include`,
  `--exclude` (read from that folder) and `--include-generated`: `[dotnet,
  format, whitespace, src, --folder, --verify-no-changes, --exclude, gen]`.
  `orbit doctor` fails a mandatory check that runs another form, before
  starting anything, with this command as the fix (an optional one is a
  warning); a check that also builds without `-m:1` (`dotnet build && dotnet
  format --verify-no-changes`) gets one command with both changes. One that
  runs anyway, through make or a script, fails and is recorded as an
  environment failure when MSBuild or the build host left a sign of the
  refusal: the run blocks with the fix instead of asking a baseline exception
  question (measured on macOS; on Linux the build host's refusal is read, and
  a refused restore only when MSBuild recorded the node).

  With the .NET 8 SDK pinned by a `global.json` (`"sdk": {"version":
  "8.0.303"}`, and a `rollForward` that stays on 8), `dotnet format` evaluates
  the project in its own process, with no build host: every form runs, and
  only its implicit restore of a project with references is refused worker
  nodes. Measured under `srt` on macOS (8.0.303): `dotnet restore <project> -m:1
  && dotnet format <project> --verify-no-changes --no-restore` passed, and so
  did the plain form with `DOTNET_PROCESSOR_COUNT=1` in the check's `env`.
  Doctor and the runner read the nearest `global.json` from the check's
  directory up: with SDK 8 they refuse only a format that restores first, and
  name that pinned restore and `--no-restore` as the fix. Without a
  `global.json` the SDK is whichever is newest, so doctor judges it as SDK 9.
  Workers are told which form runs.
- **Toolchains under the sandbox.** Each check (and worker) gets its toolchain's
  dependency cache read-only from `<orbit home>/toolchains/<repo key>/` and its
  build state in a private directory per attempt (ADR 0009; the variables are in
  [configuration](configuration.md#toolchain-caches-and-build-state)). A check
  that needs a dependency the install did not fetch fails with the tool's own
  "read-only" or "operation not permitted" message on a path under that
  directory: fetch it in the install step (`dependencies.install_command`, for
  example `[cargo, fetch, --locked]`) rather than giving the check network.
  Go module downloads inside `srt` on macOS fail with `tls: failed to verify
  certificate: x509: OSStatus -26276`, because Go verifies certificates through
  the system trust service, which the sandbox does not let it reach: vendor the
  modules (`go mod vendor`), use `isolation.provider: container`, or run on
  Linux. A check that expects build output in the checkout (`./target/release/acme`)
  needs `CARGO_TARGET_DIR: target` in its `env`. To start a repository's caches
  again, remove `<orbit home>/toolchains/<repo key>` (Go writes its module cache
  read-only: `chmod -R u+w` it first).
- **A command is killed for memory under `sandbox-runtime`.** The resident-memory watchdog
  hit `isolation.limits.memory_mb`. Raise it, or use `isolation.provider: container`.
- **Disk is filling with old runs.** `orbit gc --dry-run`, then `orbit gc`.
- **Exit 4 (CONFIG).** The configuration, contract or an action failed policy
  validation. The message lists each problem. `orbit policy show <run-id>`
  shows what the run was frozen with.
- **Exit 7 (ENVIRONMENT).** A provider CLI, credential or isolation capability is missing. Run `orbit doctor`.
- **A run is `EXHAUSTED`.** The report names the cause: a spent cost, time or
  admission cap ("budget is spent"), or a stop such as non-progress or exhausted
  repair attempts, with any material question nobody answered. Raise the cap in
  `scheduler.hard_limits` only if a cap was the cause and the goal justifies it,
  and start a new run. A session that failed before any model output (launch,
  authentication, or an exit with no output) is charged $0, not its ceiling.
- **Scope violations.** A worker changed a path outside `scope.allowed_paths` or
  inside `protected_paths`. Widen the scope in the config yourself if intended.
  Orbit will not let a model do it. After `orbit resume`, the worktree is reset to
  the last valid candidate (or the base revision) and the implementer gets a
  scope brief; if it produces the violating tree again, the run blocks again.
- **A run is `BLOCKED` on an open material question during review.** A reviewer
  finding on a criterion that an unanswered material question blocks is not
  repaired by guessing: the run blocks naming the question. Answer it with
  `orbit decide <run-id> <question-id> <answer>` (ids are not case-sensitive),
  then `orbit resume <run-id>`. A review repair that reproduces the tree it was
  sent to fix ends the loop too: `BLOCKED` while a question is open, otherwise
  `EXHAUSTED` as non-progress, and the report names that cause instead of a
  spent budget.
- **The service is not picking up my change to `config.yaml`.** Runs freeze the
  policy when they start. Start a new run.
- **Stale or leftover state.** `orbit cancel <run-id>` works on blocked and
  ownerless runs. Worktrees are under `~/.orbit/worktrees/`; a run that ends
  `SUCCEEDED` or `CANCELLED` removes its own, and `orbit gc` removes the others
  (`--keep-days 0` for every finished run now).
- **`orbit service uninstall` says the service manager is "still stopping" the
  controller.** The controller finishes its current step before it stops. Check with
  `orbit service status`; it exits 1 and says the job is still held until it is gone.
- **A command you ran from a plugin install says `orbit: command not found`.** The
  plugin's `orbit` is on the PATH of Claude Code's Bash tool only, and only after `/reload-plugins` or in a new session following the install. Use the skills, ask
  Claude to run the command, or install the CLI from a clone (see
  [installation](installation.md#install-the-cli)).

## Getting more detail

```bash
ORBIT_DEBUG=1 orbit <command>       # stack traces for internal errors
orbit logs <run-id> --controller --lines 500
orbit help exit-codes
```

When you report a bug, include `orbit --version`, `orbit doctor --json` with
secrets removed, and the relevant log lines. Report vulnerabilities privately
(see [SECURITY.md](../SECURITY.md)).
