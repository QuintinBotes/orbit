# Security

## Threat model

Orbit lets language models edit code and run commands unattended. The risks it
is designed against are: a model, or text a model read (repository files, logs,
web pages, CI output, ingested documents), steering a worker into acting outside
its scope; a worker reaching credentials; success being reported without
evidence; a crash causing duplicate external actions; and learned content
gaining authority.

Orbit does not defend against a malicious user, a compromised operating system,
or a compromised Claude Code, Codex, git or gh binary. It reduces blast radius
for the common failure, a confused or manipulated worker, and it labels what it
could not verify.

## Trust boundaries

Trusted: the installed Orbit code, `.orbit/config.yaml` as you wrote it, the
frozen policy snapshot, the SQLite state, and the evidence runner.

Untrusted: everything a model produces, repository contents (instructions,
tests, scripts), tool and check output, CI logs, web pages, ingested documents
and learned knowledge. Untrusted data reaches models inside fenced, labelled
blocks and is never parsed by the controller as an instruction. Structured model
output is validated against a JSON Schema before any field is used, and fields
naming commands, paths or scope are re-authorized against the policy. A model
never supplies a command that Orbit runs as a check.

Workers cannot modify policy or trusted code: the policy is hashed at run start,
`.orbit/**` and the policy file are protected paths, worker worktrees live
outside the repository, and `orbit decide`, `resume`, `cancel` and other
mutating commands are refused inside a worker process.

Remote answers (ADR 0008) are a trust boundary of their own: a pull request or
issue comment is untrusted text. An `/orbit answer` comment counts only when the
GitHub API, asked through `GH_TOKEN` when Orbit reads the comment, says its
author has `write`, `maintain` or `admin` permission on the repository; nothing
in the comment, its author association or the author's name counts, bot
accounts are refused, Orbit's own comments are never read as commands, and
approval questions take only their option labels. A refused comment changes
nothing but a `remote.answer.refused` event. Notification payloads carry no
code, diffs, secrets or log excerpts, and the webhook URL is read from an
environment variable, never from the config file, and must be `https` to a host
in `network.allowed_hosts`.

## Enforcement layers

| Layer | Mechanism | Covers |
|---|---|---|
| Operating system | sandbox-runtime (Seatbelt or bubblewrap), or a Docker container; for the Codex reviewer, sandbox-runtime alone, or Codex's own read-only sandbox when it is unavailable | shell writes outside the worktree, network egress by host, credential reads; the container adds CPU, memory and pids limits |
| Claude Code | `--settings` with permission rules, a permission mode that never prompts, the PreToolUse guard hook | Edit and Write paths, protected paths, dangerous commands |
| Environment | scrubbed worker environment: no `GH_TOKEN`, `GITHUB_TOKEN`, `SSH_AUTH_SOCK` or cloud credentials | delivery credentials never reach a worker |
| Controller | independent diff inspection of the candidate tree against scope, protected paths and test-weakening rules | anything the layers above missed, including indirect shell writes |
| Evidence | trusted checks run by the controller; evidence bound to tree hash, check configuration hash and policy hash | success requires fresh passing evidence and an approving review of the same tree |
| Delivery | intent, execute, receipt ledger; the delivery commit is built on exactly the reviewed tree and verified before push | no duplicate or unreviewed external action |

The hooks assist. The controller's diff inspection is the gate.

Who gets Bash is decided in one place (`src/policy/role-grants.ts`): writers
(implementer, repair) get it; read-only workers do not, except the diagnosis
verifier, which runs experiments (a test command, a reproduction). Its Bash runs
in the sandbox with the worktree denied for writing, so it can write only its
scratch directory, and it gets no Edit or Write allow rules.

## Plugin install and skills

- **What the install brings.** The plugin payload is the `plugin/` directory:
  the bundle, hooks, skills, agents and a `package.json` with one dependency,
  the sandbox runtime `srt`, pinned to 0.0.78 with a lockfile. Claude Code
  installs it at the locked version with install scripts disabled. A check
  (`npm run validate:plugin`) fails the build when the payload holds anything
  else, in particular a development dependency. The `node-forge` advisory
  `npm audit` reports arrives through `srt` itself and is tracked upstream.
- **Skills keep your text away from the shell.** A goal or other free text
  reaches the CLI on stdin through a here-document with a quoted delimiter
  (`--goal -`, `repair -`), never as shell words, and run ids are checked against
  `^orb-[0-9a-z-]+$` before they are used. The skill arguments are data for the
  model to read, not command text.
- **The hooks.** The SessionStart hook runs `orbit questions --pending --quiet`
  and prints only open questions of the repository's unfinished runs; it reports
  its own failures on stderr and never blocks a session. The PreToolUse guard
  hook is described under "What is not enforced" (it fails open on timeout).
- **Run admission.** `orbit run` refuses, before creating a run, a repository
  whose git configuration carries credentials a worker could read (for example a
  token in a remote URL), and a dirty working tree unless
  `repository.allow_dirty_start` is true.

## Credential handling

- Orbit has no login flow and never reads, stores, copies or forwards provider
  credentials (ADR 0003). `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` and
  `CODEX_API_KEY` are passed through to the worker environment and nothing
  else. They are never written to disk by Orbit and never sent to another provider.
- `GH_TOKEN` is used by the controller for delivery and never given to a worker
  or a check. Delivery refuses a broad keyring login; use a fine-grained token
  scoped to one repository, with the minimum permissions for branches, pull
  requests and CI. Remote answers and `notifications.github_comment` read
  comments and collaborator permissions, and post comments, through the same
  token.
- Logs, reports and artifacts are redacted before storage or before they are
  sent to a provider. `retention.redact_patterns` adds your own patterns.
- The secret scan uses gitleaks with Orbit's own configuration and
  `--ignore-gitleaks-allow`, so a repository cannot switch it off. Without
  gitleaks, built-in patterns run and the evidence says so.
- The publication guard checks private terms and identities before anything is
  written outside its repository. It never prints a matched term.

## What is not enforced

State these plainly to yourself before running unattended.

- **sandbox-runtime confines filesystem and network, not resources.** Orbit
  adds wall time (it kills the process group), `ulimit` limits for CPU time,
  process count and file size, and a resident-memory watchdog on the process
  group (`isolation.limits.memory_mb`). The watchdog samples, so a fast
  allocation can overshoot before the group is killed, and the process limit is
  per user id. Use `isolation.provider: container` for a hard memory, CPU and
  pids ceiling. See [resource limits](operations.md#resource-limits-per-isolation-provider).
- **Reads are broad.** Under sandbox-runtime, reads are allowed everywhere except
  denied paths, so the rest of your home directory is readable by a worker.
  Egress is filtered by host name, and traffic to an allowed host is not inspected.
- **Checks may use loopback.** A check's `local_binding` (default true) lets its
  process listen on 127.0.0.1, which a test suite that starts an HTTP server
  needs. Under sandbox-runtime that also lets it connect to other services on
  this machine's loopback while it runs; it opens no route to any other host.
  Set `local_binding: false` on a check that never needs it.
- **Static classification of bash commands is advisory.** It catches common
  dangerous shapes but cannot prove an arbitrary shell command safe. The OS
  sandbox and the controller's diff inspection are what hold.
- **Hooks fail open on timeout.** A PreToolUse hook that times out lets the tool
  call proceed, so the controller's inspection of the final diff is the real gate.
- **The `claude-sandbox` tier is weaker than `os-sandbox`.** Edit and Write
  confinement depends on Claude Code's permission layer, not the OS. `orbit
  doctor` warns when a run would use it.
- **The Codex reviewer's two tiers confine different things, and the login
  type picks one.** A ChatGPT login cannot run inside `srt` (Codex fails with
  "workspace routing discovery failed"), so `providers.codex.tier: auto` uses
  the `os-sandbox` tier only with `CODEX_API_KEY` or `OPENAI_API_KEY` in the
  environment and an `srt` that starts, and the weaker `codex-sandbox` tier
  otherwise; `orbit doctor` warns when it falls back. An explicit `os-sandbox`
  without `srt` is refused, never run unwrapped. Codex's own
  sandbox cannot start inside `srt` on macOS, so in the `os-sandbox` tier Codex
  runs with `--sandbox danger-full-access` and `srt` is the only sandbox: it
  allows writes only to the worker directory and Codex's state directory (never
  the review checkout), egress only to the Codex provider hosts, and denies
  credential reads except Codex's own auth file, which it must read to log in.
  That state directory stays writable, and other reads are broad. Without
  `srt` the `codex-sandbox` tier runs Codex unwrapped with `--sandbox
  read-only`, which blocks writes and network for its commands but not reads:
  any file you can read may reach the provider, and the worker record says so.
  Orbit passes `danger-full-access` only together with the `srt` wrapper and
  refuses it in any other combination.
- **Under `srt` on macOS a UI check's browser has no sandbox of its own.**
  Chromium's sandbox cannot start inside Seatbelt, so Playwright's bundled
  Chromium runs with `--no-sandbox` and `srt` is its only boundary: the write
  allowlist, the credential read-denies and the egress filter still apply, and
  page content can only come from allowlisted hosts. A hostile repository gains
  nothing from this, since its own test code already runs inside the same
  confinement. For Chromium to start at all, an Orbit preload on the
  unmodified `srt` CLI adds two Seatbelt rules, for UI-check processes only
  (never the application under test or a worker): `mach-register` and
  `mach-lookup` for names matching
  `^org[.]chromium[.]Chromium[.]MachPortRendezvousServer[.][0-9]+$`. That
  widens one thing: a sandboxed process can look up the rendezvous port of
  another Playwright Chromium run by the same user, or claim the name a
  starting one will use, which at worst stops that browser from starting. The
  preload refuses (exit 97) any `srt` command shape it was not verified
  against and records why in Orbit's settings directory, which the sandbox can
  neither read nor write (only that record makes a run an environment failure,
  since `srt` passes a command's own exit code through), browser checks
  require `srt` 0.0.78, and every evidence report that
  used the rules says so (`isolationAdjustments: ["chromium-mach-rendezvous"]`
  and the `srt` version on the check run). Chromium on macOS ignores `TMPDIR`
  and keeps its temp files (a download is written there first) in the
  per-user temp directory, which the sandbox cannot write, so every download
  was cancelled; for the same UI-check processes Orbit sets
  `MAC_CHROMIUM_TMPDIR` to the check's private temp directory, and only when
  that directory is already in the write allowlist. This is an environment
  variable, not a rule: the Seatbelt profile, the allowlist, the read-denies
  and the egress filter do not change, and repository code could set the
  variable itself. Only Playwright's bundled Chromium is
  supported under `srt` on macOS; Google Chrome, Firefox and WebKit are not.
  `orbit doctor`'s browser check runs no repository code: it starts the
  headless Chromium binary itself, with every credential path and the
  repository read-denied, and passes only when the page's script ran.
  See ADR 0001, "Browsers under sandbox-runtime on macOS".
- **Under `srt` on macOS a process that runs .NET may read the NIS domain
  name.** .NET's HTTP clients read it when they start, so without it every one
  failed in the sandbox, NuGet's restore included. The same preload adds one
  read-only Seatbelt rule, `sysctl-read` of `kern.nisdomainname`, to the checks,
  dependency install, workers and doctor probes that use .NET, and to nothing
  else. The name is empty unless the machine is bound to NIS, is no secret, and
  says less than the host name, which `srt` already lets every process read.
  A check's evidence record says when it ran with the rule (a limitation names
  it), and when it was not added. The system trust service
  (`com.apple.trustd.agent`), which .NET also needs for HTTPS, stays out of
  reach: a sandboxed process that could ask it to evaluate a certificate could
  make it fetch from any host, outside the egress allowlist. So on macOS a
  repository's NuGet packages are restored into its cache outside the sandbox,
  by the person, with the command `orbit doctor` prints
  (`checks.dotnet-packages`). That command is an ordinary `dotnet restore`: it
  evaluates the repository's MSBuild files with the person's own permissions
  and NuGet configuration, so run it on a tree you trust (your checkout), not on
  a candidate's. See ADR 0009, addendum.
- **NuGet's vulnerability audit does not run in the sandbox.** Every .NET
  process there gets `NuGetAudit=false`. Where the audit cannot reach nuget.org
  (on macOS nothing in the sandbox can verify its certificate; on Linux a check
  has no network unless it lists the host) it could only warn `NU1900`, which
  fails every restore of a repository that treats warnings as errors. It is off
  for the dependency install too, although on Linux the install may reach
  nuget.org, so that a check's restore matches the install's: a candidate that
  adds a package with a known vulnerability fails a restore that treats `NU1903`
  as an error in CI and passes under Orbit. Each .NET check's record says the
  audit was off (a limitation). Orbit's checks therefore say nothing about
  vulnerable packages; the repository's CI, or a restore outside Orbit, still
  does. A check's own `env` can set it back. See ADR 0009, addendum, item 12.
- **No Unix socket is allowed in a sandbox, so .NET's named pipes under `/tmp`
  stay refused.** MSBuild's worker nodes (`/tmp/MSBuild<pid>`) and the build
  host `dotnet format` loads a project with (`/tmp/<guid>`) bind their pipes at
  paths .NET fixes under `/tmp`, which every process of the user shares, so a
  check that could bind or connect there could also reach the user's own,
  unsandboxed MSBuild and Roslyn servers. Orbit opens none: a dotnet check pins
  one MSBuild node with `-m:1`, a format check on Linux uses `dotnet format
  whitespace --folder`, which loads no project, and `orbit doctor` refuses what
  it can see of the rest; on macOS that form cannot list the folders above a
  run's checkout, which sit in the read-denied Orbit home, and Orbit does not
  open their listing (`srt` would open everything below them, the run's other
  checkouts included), so `dotnet format` with SDK 9 and later runs in CI; a
  check that meets the refusal anyway on the base revision is
  recorded as an environment failure, and on a candidate only when the base
  revision showed the same refusal (ADR 0010). Allowing Unix sockets only under
  a check's private temp directory on macOS (`srt`'s `allowUnixSockets`) was
  evaluated and not adopted, because these pipes are not there; on Linux `srt`
  can only allow every Unix socket, the Docker socket and SSH agent included.
  See ADR 0009, addendum.
- **Toolchain dependency caches are shared within one repository.** Go,
  Rust, Python, JVM and .NET dependency caches live under
  `<orbit home>/toolchains/<repo key>/`, one set per repository and never the
  user's own (`~/.cargo`, `~/go`, `~/.m2`, `~/.nuget/packages`). Only Orbit's
  dependency-install step may write them; every other check and every worker
  gets them read-only, and a write is refused by the sandbox. Build state
  (`GOCACHE`, `CARGO_TARGET_DIR`, `__pycache__`) is private to each check
  attempt, so a cached object or test result from one candidate never reaches
  another's evidence. The install step trusts its command: a configured
  `dependencies.install_command` that evaluates repository code (MSBuild during
  `dotnet restore`, a Gradle build script, a Python sdist build) runs a
  candidate's code with that repository's cache writable. Remove the
  directory to start clean. See ADR 0009.
- **Verification has limited coverage.** Accessibility scans find only what
  automated rules can find and are not an accessibility audit. Visual checks
  compare pixels to a baseline and do not judge design. Orbit reports these
  limits and never claims complete accessibility or usability. Baseline updates
  require review and are never auto-accepted by default.
- **Evidence shows the checks you defined passed, not that the code is correct.**
  A goal with no meaningful checks produces a report that says so.
- **A reviewer model can be wrong.** Independent review by another provider
  lowers correlated error; it does not remove it.
- **Review is not always independent.** By default
  (`review.when_unavailable: claude`, [ADR 0007](decisions/0007-reviewer-availability.md)),
  when no independent reviewer is usable Claude reviews its own provider's
  change in a separate session at the opus-class floor. That review shares the
  implementer's blind spots. It is never presented as independent: the report,
  the decision record and `orbit doctor` say it was a same-provider review and
  why the independent reviewer was unavailable. Set `when_unavailable: ask` to
  approve each such run yourself, or `block` when independence must be
  guaranteed.
- **Data leaves the machine.** Running Orbit sends code and diffs to Claude, and
  to Codex when `providers.codex.data_policy_eligible` is true. Decide that per repository.
- **Fable models** are excluded by default because headless Claude Code bills
  them without a consent prompt.

## Release mode

Merge and production deploy are off in every mode except `release`, and each
needs its own action flag. They run only in the controller, with a token no
worker holds, as ledgered actions with intent, receipt and reconciliation.
Marking a draft pull request ready, rebasing a moved task branch
(`actions.rebase_task_branch`, default false) and verifying an unknown deploy
(`release.environments[*].verify_command`) are separate, explicit steps. See
[release mode safeguards](operations.md#release-mode-safeguards). A native
`/goal` in an interactive session never completes a run; the controller does.

## Learning layer

Learned lessons and prompt overlays are advisory text. They cannot reach policy,
hard caps, protected paths, check definitions, tests or base role prompts. See
[the learning layer](learning.md). Ingested documents enter as low-confidence candidates.

## Reporting vulnerabilities

Report privately through GitHub security advisories, as described in
[SECURITY.md](../SECURITY.md). Do not open public issues for vulnerabilities.
