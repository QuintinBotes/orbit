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
| `checks.sandbox` | `the sandbox refuses the executable of check X; a run would block at its baseline` | Under `sandbox-runtime`, doctor starts each check's executable (one installed outside the repository) in the sandbox that check gets, with a harmless argument (`--version`; `dotnet help`, which runs the .NET SDK's first-run steps; `go version`). The detail line shows what was refused. See [A check cannot run in the sandbox](#run-problems). A tool that exits non-zero with no denial in its output (an unknown `--version` flag) is not counted. |
| `isolation` | sandbox-runtime unavailable | Install `srt` (`npm install --global @anthropic-ai/sandbox-runtime`); on Linux install bubblewrap. A plugin install and a clone after `npm ci` carry their own `srt`; if doctor says it is missing there, the plugin's or the clone's install did not finish (run `npm ci` in the clone, or reinstall the plugin). Orbit will not fall back to weaker isolation. |
| `isolation` | container image not present locally | `docker pull <image>`. Containers run with `--pull never`. Make sure the Docker daemon is running. |
| `isolation` | `none` provider warning | Workers run with your full permissions. Use `sandbox-runtime` or `container`. |
| `isolation` | `isolation.require_resource_limits is true but ... cannot enforce isolation.limits.memory_mb` | The provider has no hard memory cap. Use `isolation.provider: container` with `container.memory_mb` no higher than `limits.memory_mb`, set `limits.memory_mb: null`, or set `require_resource_limits: false`. |
| `claude.cli` | claude not usable | Install Claude Code and put it on PATH, or set `providers.claude.command`. Sonnet 5.5 needs 2.1.284 or newer. |
| `claude.auth` | credentials expired, invalid or missing | `claude auth login`, or export `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`. For the service, make the variable visible to it (see [operations](operations.md#installing-the-service)). Then `orbit resume <run-id>`. |
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
  continues the same run. The cases are listed in
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
- **A check cannot run in the sandbox.** The run blocks at PREFLIGHT with "check X
  could not run on the base revision ..., and the output shows an environment
  cause, not a pre-existing failure", the first error line, the log and a fix. The
  check never got as far as the repository's code: the sandbox or the operating
  system refused it a filesystem operation outside its checkout (EPERM, "Operation
  not permitted", a Seatbelt `deny(1) file-...` line; on Linux, where `srt` mounts
  everything outside the writable paths read-only, EROFS, "Read-only file
  system"), or it was killed by a crash
  signal before printing anything. Such a failure is not recorded as pre-existing
  and no baseline exception is offered, since accepting one would let a run pass
  with a check that never ran. The same refusal on a candidate blocks the run
  without a repair attempt. Output that shows a compile error or a failing test
  is never read this way: that failure stays the code's. Run `orbit doctor`
  (`checks.sandbox`) to see what the tool is refused, then let it keep its files
  in the check's `HOME` or `TMPDIR` (each check gets a private, empty one; set
  the tool's variables in the check's `env`) or change the check. `orbit resume
  <run-id>` runs the baseline again once the environment is fixed; a changed
  check definition needs a new run.
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
  Linux). Two cases remain yours to decide:
  code under test that creates a named `Mutex` or `Semaphore` needs
  `/tmp/.dotnet` and cannot run under `sandbox-runtime` (change the code to use
  an unnamed one or a file lock in `TMPDIR`; `isolation.provider: container`
  gives each check its own `/tmp`, which Orbit has not verified with .NET); and a project with NuGet packages restores them into
  the check's empty home on every run, so list the feeds (`api.nuget.org` and
  your own) in the check's `network_hosts`.
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
