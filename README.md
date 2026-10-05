# Orbit

Orbit is a Claude Code plugin and a companion command line runtime for
autonomous, evidence-driven software engineering. You give it a goal and a
policy you wrote beforehand. It turns the goal into a durable contract, runs
isolated worker processes (Claude, with Codex as an independent reviewer),
verifies the result with checks you defined, repairs failures within fixed
budgets, and finishes with a report that states what was and was not verified.
Within the policy it can commit, push a task branch, open a draft pull request
and repair CI, without asking again.

Orbit is a local tool. It drives the `claude` and `codex` programs you
installed, with whatever authentication they already use. It does not offer a
claude.ai login or subscription limits to anyone else (see
[docs/installation.md](docs/installation.md#authentication)).

## What Orbit is not

- It does not give unbounded autonomy or guarantee correctness.
- It does not use permission bypass as a substitute for isolation.
- It does not weaken tests or redefine success to make a run pass.
- It does not let a worker expand its own scope or edit the trusted runtime or
  the active policy.
- It does not merge or deploy to production unless you enable `release` mode
  and the matching action.

## Install

Plugin, from the marketplace once it is public:

```
/plugin marketplace add QuintinBotes/claude-plugins
/plugin install orbit@quintinbotes
```

CLI, from this repository (Node 22.16 or newer):

```bash
git clone https://github.com/QuintinBotes/orbit.git
cd orbit
npm ci
npm install --global .
orbit --version
```

The plugin and the CLI are the same single bundle, `dist/orbit.mjs`, with no
runtime dependencies beyond Node. Prerequisites and optional tools are in
[docs/installation.md](docs/installation.md).

## Quickstart

Run these inside the git repository you want Orbit to work on.

```bash
orbit doctor                       # what is missing, with the exact fix for each item
orbit init                         # writes .orbit/config.yaml and keeps run state out of git status
$EDITOR .orbit/config.yaml         # set scope.allowed_paths and define your checks
orbit doctor                       # should now report no failures
orbit run --goal "Add a CSV export to the reports page" --mode autonomous
```

`orbit run` drives the run in your terminal when no service is installed
(Ctrl-C pauses it). To leave it running in the background:

```bash
orbit service install
orbit run --goal "Add a CSV export to the reports page" --detach
orbit status                       # recent runs
orbit logs <run-id> --follow
orbit report <run-id>              # final report, or --interim while it runs
```

A run ends in `SUCCEEDED`, `BLOCKED` (a question or a missing capability),
`EXHAUSTED` (a hard cap was reached), `IMPOSSIBLE` or `CANCELLED`. A blocked run
is continued with `orbit decide` and `orbit resume`.

From inside Claude Code the same flow is available as skills:
`/orbit:run`, `/orbit:status`, `/orbit:resume`, `/orbit:verify`,
`/orbit:repair` and `/orbit:inquisition`. They call the CLI.

## Commands

| Command | Purpose |
|---|---|
| `orbit doctor [--probe]` | Check every capability a run depends on. `--probe` makes live requests. |
| `orbit init` | Write `.orbit/config.yaml` from the starter template. |
| `orbit run --goal <text>` | Freeze the policy and start a run (`--mode`, `--policy`, `--foreground`, `--detach`). |
| `orbit status [run-id]` | State, stage, attempts, budgets, workers, questions, heartbeat. |
| `orbit logs <run-id>` | Controller and worker logs, redacted (`--follow`, `--lines`, `--controller`, `--workers`, `--worker`). |
| `orbit verify [run-id]` | Independent verification of a run's latest candidate: a verdict per criterion with its evidence. Exit 14 for FAIL, 15 for INCOMPLETE. |
| `orbit repair <run-id \| description>` | Repair a failed run (BLOCKED or paused with FAIL evidence), or start a run to repair a described failure (`--foreground`, `--policy`, plus the `run` options). |
| `orbit stats` | Success rate, cost, repair loops and time to green for this repository (`--since`, `--until`). |
| `orbit gc` | Apply artifact retention to finished runs (`--keep-days`, `--dry-run`). |
| `orbit pause <run-id>` | Pause durably. |
| `orbit resume <run-id>` | Unpause, or continue a blocked run (`--foreground`, `--force`). |
| `orbit cancel <run-id>` | Cancel durably (`--wait`). |
| `orbit report <run-id>` | Final or interim report (`--interim`); `orbit report --learning` shows improvement over time. |
| `orbit questions <run-id>` | Questions a run is waiting on. |
| `orbit decide <run-id> <question-id> <answer>` | Record your answer (`--by`). Approving a baseline-exception question puts the exception in the run's contract. `orbit questions` takes `--all` to include answered ones. |
| `orbit release resolve <run-id>` | Settle a release-mode deploy whose outcome is unknown: runs the environment's `verify_command`, or records `--deployed` / `--not-deployed`. |
| `orbit policy show <run-id>` | The frozen policy, verified against its hash. |
| `orbit models list` / `models refresh` | The model registry and its availability. |
| `orbit learn list / show / ingest / export / overlays / eval` | The learning layer. See [docs/learning.md](docs/learning.md). |
| `orbit service install / uninstall / status / run` | The background service. |

Every command accepts `--repo <dir>`, `--json` and `--help`. Exit codes are
printed by `orbit help exit-codes`. `orbit status` takes `--all`, `orbit logs`
takes `-f` for `--follow`, and `orbit run --goal -` reads the goal from stdin.
Orbit Inquisition has no separate command: `/orbit:inquisition` runs it inside
Claude Code, and the controller runs it for unclear goals. Release mode has no
separate command either: `orbit run --mode release`, with the `release` and
`actions` sections of the policy. See
[release mode](docs/operations.md#release-mode-safeguards).

## Live demo

`scripts/demo/run-live-demo.sh` runs three demo goals against live providers on
a private GitHub repository. **Status: not yet run against real providers.**
Only the mock demo (`scripts/demo/run-mock-demo.sh`) has run, and its tests
use stubbed `gh` and `orbit`. Treat any claim about live behaviour as
unverified until the maintainer has run the live demo and updated this label.
To reproduce it yourself (this spends real money on provider usage):

```bash
scripts/demo/run-live-demo.sh --repo OWNER/NAME --dry-run   # prints the plan, runs nothing
scripts/demo/run-live-demo.sh --repo OWNER/NAME
```

## Documentation

- [Installation](docs/installation.md)
- [Configuration](docs/configuration.md)
- [Operations](docs/operations.md)
- [Security](docs/security.md)
- [The learning layer](docs/learning.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Architecture](docs/architecture.md) and [decision records](docs/decisions/)
- [Contributing](CONTRIBUTING.md), [Security policy](SECURITY.md), [Changelog](CHANGELOG.md)

## License

MIT. See [LICENSE](LICENSE).
