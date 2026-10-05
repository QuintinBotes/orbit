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

## Credential handling

- Orbit has no login flow and never reads, stores, copies or forwards provider
  credentials (ADR 0003). `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` and
  `CODEX_API_KEY` are passed through to the worker environment and nothing
  else. They are never written to disk by Orbit and never sent to another provider.
- `GH_TOKEN` is used by the controller for delivery and never given to a worker
  or a check. Delivery refuses a broad keyring login; use a fine-grained token
  scoped to one repository, with the minimum permissions for branches, pull
  requests and CI.
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
- **The Codex reviewer's two tiers confine different things.** Codex's own
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
- **Verification has limited coverage.** Accessibility scans find only what
  automated rules can find and are not an accessibility audit. Visual checks
  compare pixels to a baseline and do not judge design. Orbit reports these
  limits and never claims complete accessibility or usability. Baseline updates
  require review and are never auto-accepted by default.
- **Evidence shows the checks you defined passed, not that the code is correct.**
  A goal with no meaningful checks produces a report that says so.
- **A reviewer model can be wrong.** Independent review by another provider
  lowers correlated error; it does not remove it.
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
