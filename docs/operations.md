# Operations

## Foreground and service execution

Both run the same reconcile loop. The difference is who keeps the controller alive.

| | Foreground | Service |
|---|---|---|
| Start | `orbit run --goal "..." --foreground` (the default when no service is running) | `orbit service install`, then `orbit run --goal "..." --detach` |
| Survives closing the terminal | No. Ctrl-C pauses the run (exit code 20); `orbit resume <run-id> --foreground` continues it. | Yes |
| Restarts after a controller crash | No | Yes, on failure only, throttled |
| Credentials | your shell's environment | only what the service process can see; see below |

A foreground run exits with a code that names the state it ended in: 0
`SUCCEEDED`, 10 `BLOCKED`, 11 `EXHAUSTED`, 12 `IMPOSSIBLE`, 13 `CANCELLED`, 20
paused. `orbit help exit-codes` prints the whole table.

## Installing the service

```bash
orbit service install
orbit service status
```

Orbit writes no credentials into the service definition. The service process
gets only `PATH` (copied from your shell at install time), `NODE_OPTIONS` and
`ORBIT_HOME`, plus whatever launchd or systemd provides. Make the credentials
it needs visible to the user manager, then restart the service:

```bash
# macOS
launchctl setenv ANTHROPIC_API_KEY "$ANTHROPIC_API_KEY"
launchctl setenv GH_TOKEN "$GH_TOKEN"
# Linux
systemctl --user set-environment ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" GH_TOKEN="$GH_TOKEN"
orbit service install     # reloads the service
```

These variables live in the user manager's memory, not in a file Orbit
manages, and must be set again after a reboot (or use a mechanism you already
trust, such as a root-only systemd drop-in). A login the `claude` CLI stored
for itself in your home directory is also visible to the service. See
[installation](installation.md#authentication) for which method suits which tier.

The service is one launchd user agent (macOS) or one systemd user unit (Linux)
per repository, running `orbit service run --repo <root>`. The label is
`dev.orbit.controller.<repo-key>`.

| Platform | Definition | Notes |
|---|---|---|
| macOS | `~/Library/LaunchAgents/dev.orbit.controller.<key>.plist` | loaded with `launchctl bootstrap gui/<uid>` |
| Linux | `~/.config/systemd/user/dev.orbit.controller.<key>.service` | `Restart=on-failure`, `KillMode=process`. Run `loginctl enable-linger <user>` or the service stops at logout. |

The definition uses absolute paths for Node and the bundle, restarts only on
failure, throttles restarts, and writes logs under `~/.orbit/logs`. Installing
again reloads it. `orbit service uninstall` removes it; runs and state are
untouched. `orbit service status` exits 0 only when the service is loaded.
Other platforms have no service; use `orbit run --foreground`.

## Command reference

Every command accepts `--repo <dir>`, `--json` and `--help`.

| Command | Flags |
|---|---|
| `orbit doctor` | `--probe` makes live requests (a few cents) |
| `orbit init` | none |
| `orbit run` | `--goal <text>` (or `-` for stdin), `--mode supervised\|autonomous\|autonomous-delivery\|release`, `--environment <name>` (release mode: deploy only there), `--policy <path>`, `--foreground`, `--detach` |
| `orbit status [run-id]` | `--all` lists every run, not the latest 10 |
| `orbit logs <run-id>` | `--follow` / `-f`, `--lines <n>`, `--controller`, `--workers`, `--worker <id>` |
| `orbit pause <run-id>` | none |
| `orbit resume <run-id>` | `--foreground`, `--force`, `--policy <path>` |
| `orbit cancel <run-id>` | `--wait <seconds>` |
| `orbit report [run-id]` | `--interim`, `--learning` |
| `orbit questions <run-id>` | `--all` includes answered and withdrawn questions |
| `orbit decide <run-id> <question-id> <answer...>` | `--by <name>` (models and workers cannot decide) |
| `orbit verify [run-id]` | see below |
| `orbit repair <run-id \| description>` | `--foreground`, `--policy <path>`, and the `orbit run` options other than `--goal` and `--environment` |
| `orbit stats` | `--since <when>`, `--until <when>`: an ISO date or time, or a span such as `90m`, `24h`, `7d`, `2w` |
| `orbit gc` | `--keep-days <n>` (at least 1; default `retention.keep_runs_days`), `--dry-run` |
| `orbit release resolve <run-id>` | `--deployed`, `--not-deployed`, `--environment <name>`, `--by <name>`; see [Release mode safeguards](#release-mode-safeguards) |
| `orbit policy show <run-id>` | none |
| `orbit models list` / `models refresh` | `--probe` on refresh |
| `orbit learn ...` | see [the learning layer](learning.md) |
| `orbit service install / uninstall / status / run` | `--entry <path>` on install |

### verify, repair, inquisition

`orbit verify [run-id]` (default: the most recent run) re-runs the independent
verification of the run's latest candidate: a clean checkout of the exact
candidate tree, the frozen policy's checks, scope inspection and the evidence
evaluation. It prints a verdict per contract criterion with the artifacts it
rests on. It takes a short lease so it never runs beside a live controller and
never changes the run's state. It uses the same evidence function as the
VERIFYING step, so a waived finding gives the same verdict in both. Exit 0
means PASS, 14 means FAIL (a check failed or scope was violated), 15 means
INCOMPLETE (a mandatory criterion is unproven; treat it as not done).

`orbit repair <run-id>` hands the failure of a `BLOCKED` or paused run with FAIL
evidence to a repair. A run id that does not qualify is refused with the
reason. Given a description instead of a run id, it starts a new run with the
goal `Repair: <description>`.

Orbit Inquisition is not a command. The controller runs it for unclear goals,
weak evidence and repeated failures, and `/orbit:inquisition` runs it
interactively inside Claude Code. Questions it persists appear in
`orbit questions` and are answered with `orbit decide`.

### stats and gc

`orbit stats` prints success rate, cost, token and cache use, repair loops and
time to green for this repository, read-only. `orbit gc` deletes the run
directories and worktrees of finished runs that ended more than
`retention.keep_runs_days` ago. Database rows stay and `BLOCKED` runs are never
touched. Use `--dry-run` first.

## Using the native /goal command

Claude Code has a native `/goal` command that keeps an interactive session
pointed at an objective. It is an optional aid for supervised work and Orbit
does not depend on it. It never decides that a run is done.

When it helps: after a supervised `/orbit:run` submit, while you stay in the
session and wait. The `/orbit:run` skill offers to set it. Set it to the run's
objective plus this exact evidence line, with your run id:

```
evidence: orbit status <run-id> reports SUCCEEDED
```

The controller is the completion authority. A run is `SUCCEEDED` only when the
controller has fresh passing evidence and an approving review of the same
candidate tree, and the evidence line above only reads that state. If `/goal`
says the goal is met while `orbit status` says otherwise, or a session believes
the work is done, trust `orbit status` and `orbit verify`. Do not use `/goal`
to bypass a `BLOCKED` run: answer the question with `orbit decide` and resume.

## Release mode safeguards

`orbit run --mode release` is the only way Orbit merges or deploys, and each
needs its own action: `actions.merge` and `actions.deploy_production`. The
safeguards:

- `release` must be configured (not null), and `actions.merge` or
  `actions.deploy_production` must be true. Deploy needs at least one
  environment with `allowed_branches`.
- Merging requires green CI for the checks in `release.merge.require_checks`
  and an approving review of the exact tree. The merge, like every external
  action, is recorded as intent, executed, then recorded as a receipt, and a
  lost response is looked up rather than repeated.
- `delivery.pull_request` defaults to `draft`, and a draft cannot be merged.
  With `release.merge.mark_ready: true` (the default) release mode first marks
  the pull request ready for review as its own ledgered action, then merges.
  Set it to `false` to refuse to merge a draft instead.
- If the base branch moved, Orbit rebases the task branch only when
  `actions.rebase_task_branch` is true (default false). Otherwise the run
  blocks and asks you.
- `orbit run --mode release --environment <name>` names the one environment the
  run deploys to. Without it, a release deploys every environment in
  `release.environments` that the deployed branch is allowed for, in profile
  order, and reports the rest as skipped. With it, only that environment
  deploys, and the run is refused when the name is not defined (at the command,
  before any run exists, and again at the intake gate) or when
  `allowed_branches` does not cover the branch the deploy comes from (the base
  branch with a merge, else the task branch). The branch check happens before
  the merge, so a refused environment leaves the pull request open. The name is
  stored on the run and in the contract as `delivery.environment`, and an
  amendment cannot change it; `--environment` needs `--mode release` and is not
  an option of `orbit repair`.
- A deploy runs the environment's `deploy_command` (an argv, never a shell)
  only from an allowed branch, with `require_ci_green` honoured, inside the
  timeout and the environment's `network_hosts`. If the outcome is unknown,
  for example the command timed out, Orbit never repeats it blindly. When the
  environment has `verify_command` (a trusted argv that reports whether the
  deploy took effect), Orbit runs it to reconcile the unknown deploy. Without
  one the run blocks for you to decide.
- `orbit release resolve <run-id>` settles a deploy that is still unknown.
  With no flag it runs the environment's `verify_command` in a checkout of the
  deployed commit (exit 0 means deployed, exit 1 means not deployed, anything
  else leaves it unknown and changes nothing). `--deployed` records that you
  found the deploy took effect, so it is adopted and never run again;
  `--not-deployed` records that it did not, so the next release attempt may run
  it once. `--environment <name>` picks one when several are unresolved.
  Models and workers cannot resolve a deploy. Continue a blocked run with
  `orbit resume <run-id>` afterwards.
- Workers never hold `GH_TOKEN` or deploy credentials. Only the controller acts.

## Resource limits per isolation provider

| Limit | `sandbox-runtime` | `container` | `none` |
|---|---|---|---|
| Wall time | process group killed at the timeout | killed at the timeout | killed at the timeout |
| CPU seconds (`isolation.limits.cpu_seconds`, default 3600) | `ulimit` inside the sandbox | `docker --ulimit` | `ulimit` |
| Processes (`max_processes`, default 2048) | `ulimit -u`, per user id | `--pids-limit` and `--ulimit` | `ulimit -u` |
| Largest file written (`max_file_mb`, default 2048) | `ulimit` | `docker --ulimit` | `ulimit` |
| Memory (`memory_mb`, default 4096) | resident-memory watchdog on the process group | container memory limit (`isolation.container.memory_mb`) | not enforced |
| Network and filesystem | allowlists, write confinement | no network, container filesystem | none |

Set a limit to `null` to turn it off. `max_processes` counts every process of
your user id, so keep it well above what the account already runs. The
sandbox-runtime memory limit is a watchdog, not a kernel cap: it samples the
group's resident memory and kills the group when it exceeds the limit, so a
fast allocation can overshoot before it is caught. Use `container` when you
need a hard memory ceiling. When limits are set and no `bash` is found, a
command is refused rather than run without them. Set
`isolation.require_resource_limits: true` to have Orbit refuse a run at
preflight, and `orbit doctor` fail, when the provider cannot enforce a limit
that is set (today only `memory_mb`: `sandbox-runtime` and `none` cannot hard-cap
it, `container` can when `container.memory_mb` is no higher); the message
names the limit and the fix. `none` is refused in
autonomous modes unless `isolation.allow_unisolated` is true.

## Logs

```bash
orbit logs <run-id>                 # tail of the controller and every worker, redacted
orbit logs <run-id> --follow
orbit logs <run-id> --workers
orbit logs <run-id> --worker <worker-id> --lines 500
```

Files on disk:

- `~/.orbit/logs/controller.jsonl`: the controller log, shared by every run.
- `~/.orbit/logs/<label>.out.log` and `.err.log`: the service's stdout and stderr.
- `<repo>/.orbit/runs/<run-id>/`: the frozen policy, contract, evidence, the final
  report (`final.md`) and `workers/<worker-id>/` with prompt, log, exit record and result.
- `~/.orbit/worktrees/<repo-hash>/<run-id>/<worker-id>`: worker checkouts, outside
  the repository on purpose.

Logs are redacted before they are stored. Add patterns of your own with
`retention.redact_patterns`.

## Pause, resume, cancel

```bash
orbit pause <run-id>      # durable; workers keep running and are collected on resume
orbit resume <run-id>
orbit cancel <run-id>     # durable, works for blocked and ownerless runs; --wait <seconds>
```

Each request is written to the state database first, so it survives a
controller restart. After a durable cancel the run can only reach `CANCELLED`.

A `BLOCKED` run names its reason: an open question, an expired credential, an
unavailable mandatory reviewer, an unauthorized action. Answer questions with
`orbit questions <run-id>` and `orbit decide <run-id> <question-id> <answer>`,
repair the environment (`orbit doctor`), then `orbit resume <run-id>`.
`resume --force` continues even though material questions are open; use it
knowingly.

A run that is `BLOCKED` on an environment failure (a mandatory check that fails
on the candidate as it failed on the base revision, with a sandbox or
environment denial in its output) spent no repair attempt. Its reason names the
check and offers two ways forward. Fixing the environment or the check
definition means a new run, because the run's policy and recorded check results
are frozen. Approving the baseline exception with `orbit decide <run-id>
<question-id> Approve`, then `orbit resume <run-id>`, carries this run on: the
failure is accepted as recorded, and the next verification judges the recorded
check results under the amended contract.

## Heartbeats and the watchdog

Each controller registers itself and publishes a heartbeat every 5 seconds. A
run is held by one owner lease with a 60 second lifetime, renewed on every
tick. `orbit status` shows the heartbeat age and the last-progress time per run.

The watchdog tells a stalled run from a busy one using last-progress time,
worker log activity, step age and controller heartbeats. Defaults: a run with
no progress for 10 minutes is reported as stalled; a controller heartbeat older
than 90 seconds is stale; a step that outlives its timeout (for example 60
minutes for `IMPLEMENTING`, 15 for `RECOVERING`) is abandoned, its workers are
stopped, and the run moves to `RECOVERING`. The watchdog never steals a lease:
a dead controller's leases expire on their own, and the next controller takes
them over.

## Recovery behaviour

A worker or check is a detached process that records itself in files, so a new
controller can tell from files and the process table whether it is running,
finished or lost, without starting a duplicate. On start and on lease takeover
the controller:

- takes the lease of every run whose owner is gone;
- moves a run whose owner died mid-step to `RECOVERING`, spending one of
  `recovery_attempts` (default 3), or to `EXHAUSTED` when none are left;
- reattaches to running workers, collects the results of finished ones, and
  marks lost ones, with a bounded restart;
- reconciles external actions from the action ledger: each commit, push and pull
  request is recorded as an intent before it happens and a receipt after, so a
  lost response is looked up rather than repeated.

Workers outlive the controller: they run in their own session and process
group, and the systemd unit uses `KillMode=process`. Orphans are terminated by
reconciliation when their run is terminal or cancelled. Expired credentials
block a run; they are never retried.

## Upgrading the state database

The state database is `<repo>/.orbit/state.sqlite` (WAL mode), with
`knowledge.sqlite` beside it. Schema migrations run automatically, in order,
when Orbit opens the database, and the applied count is stored in
`PRAGMA user_version`. `orbit doctor` shows it as `schema version N/M`.

To upgrade:

1. `orbit service uninstall` (or stop foreground runs). Runs and workers keep their state.
2. Copy `.orbit/state.sqlite*` and `.orbit/knowledge.sqlite*` somewhere safe. Copy all
   files that match, including the `-wal` and `-shm` files, with no controller running.
3. Install the new Orbit, then run `orbit doctor`. Reinstall the service with
   `orbit service install`; the definition points at the bundle path, so
   reinstall after moving or updating it.

A database written by a newer Orbit is refused with "database is at schema
version N, newer than this Orbit"; upgrade Orbit rather than editing the file.
There is no downgrade: restore the backup.
