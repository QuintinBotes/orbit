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
