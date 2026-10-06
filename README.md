# Orbit

[![CI](https://github.com/QuintinBotes/orbit/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/QuintinBotes/orbit/actions/workflows/ci.yml)
[![CodeQL](https://github.com/QuintinBotes/orbit/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/QuintinBotes/orbit/actions/workflows/codeql.yml)
[![Release](https://img.shields.io/github/v/release/QuintinBotes/orbit)](https://github.com/QuintinBotes/orbit/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

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

## Status

Orbit 0.1.0 is the first release. Where this document says what Orbit does, it describes the
code in this repository. [Live runs and what is not proven yet](#live-runs-and-what-is-not-proven-yet) says
what has been run against real providers.

## Install

Orbit needs Node.js 22.16 or newer, git, and the `claude` and `codex` programs
you already use (with their own logins). Everything else is in
[docs/installation.md](docs/installation.md).

**As a plugin**, from the `claude-plugins` catalog (a `git-subdir` entry that
points at the `plugin/` directory of this repository):

```
/plugin marketplace add QuintinBotes/claude-plugins
/plugin install orbit@quintinbotes
```

Claude Code installs the plugin's one dependency, the sandbox runtime `srt`, as
part of the install (this needs `npm` and network access). You get the skills
`/orbit:init`, `/orbit:doctor`, `/orbit:run`, `/orbit:status`, `/orbit:resume`,
`/orbit:verify`, `/orbit:repair` and `/orbit:inquisition`. The plugin also puts
`orbit` on the PATH of Claude Code's Bash tool, but not in the session you
installed it from: only after `/reload-plugins` there, or in a new session.
Until then the skills run it as `"${CLAUDE_PLUGIN_ROOT}/bin/orbit"`, and in the
Bash tool you use the absolute path to the plugin's `bin/orbit`
(`~/.claude/plugins/cache/quintinbotes/orbit/<version>/bin/orbit` for this
catalog, see [installation](docs/installation.md#install-the-plugin)). It is
never on the PATH of your own terminal: for that, use the clone below.

An agent asked to use Orbit uses the model-invocable skills (`/orbit:status`,
`/orbit:doctor`, `/orbit:init` and `/orbit:inquisition`) and the `orbit` CLI; a
person starts `/orbit:run`, `/orbit:resume`, `/orbit:repair` and `/orbit:verify`.

**From a clone** (the CLI, and a way to try the plugin before it is released):

```bash
git clone https://github.com/QuintinBotes/orbit.git
cd orbit
npm ci
npm install --global .
orbit --version
```

`npm install --global .` links `orbit` to this clone instead of copying it, so
keep the clone where it is: deleting it breaks `orbit`. `npm ci` is what
installs `srt` (in the clone's `node_modules`, where Orbit finds it; it is not
put on your PATH). To load the plugin from the clone for one Claude Code session,
without a marketplace:

```bash
claude --plugin-dir ./plugin
```

## Quickstart

Follow these steps in order, in the git repository you want Orbit to work on.
It needs at least one commit and a clean working tree. Each step gives the
`orbit` command (from a clone, in a terminal or in Claude Code's Bash tool) and,
in parentheses, what to use instead in Claude Code with the plugin installed.

**1. Initialise.** `orbit init` (plugin: `/orbit:init`)

This writes `.orbit/config.yaml` from the starter template and adds rules to
`.git/info/exclude`, so run state stays out of `git status` (the config file
itself shows up as untracked: commit it if you want it shared). The starter mode
is `autonomous`: Orbit works on a local branch `orbit/<run-id>` and never
pushes. `init` also replaces the template's example `scope.allowed_paths` with
globs that match your layout, and tells you so.

**2. Edit `.orbit/config.yaml`.** Three edits are needed before a run can pass.
Each key below already exists in the file (`checks:` has only commented
examples), so change it in place rather than pasting a second copy:

```yaml
scope:
  allowed_paths: ["src/**", "tests/**"]     # everything a worker may change, tests included

checks:                                      # the only commands Orbit runs as evidence
  unit-tests:
    command: [npm, test]

providers:
  codex:
    data_policy_eligible: true               # only if sending sanitized code to Codex is allowed
```

Without a check nothing can be verified. Without `data_policy_eligible: true`
the independent review (by Codex) cannot run and runs that need it stop as
`BLOCKED`. If sending code to Codex is not allowed, see
[review](docs/configuration.md#agents-and-review) for turning independent review
off knowingly. Every other setting has a working default.

**3. Read the Codex model catalog.** `orbit models refresh`
(plugin: ask Claude to run it, or accept it when `/orbit:doctor` suggests it)

Without it, Orbit does not know which Codex model may review, and doctor fails
`review`. The catalog describes your Codex client, not one repository, so it is
saved under `ORBIT_HOME` (`~/.orbit/models/`) and every repository of yours
uses it for 7 days; refresh again after that, or after upgrading Codex. The
alternative is to name a model in `providers.codex.model`.

**4. Check.** `orbit doctor` (plugin: `/orbit:doctor`)

It should end with `0 failed`. Warnings are normal on a fresh setup and each one
prints its `fix:` line. With a subscription login (rather than exported API
keys) you will typically see `claude.worker-tier`, `codex.worker-tier` and
`service`: runs work, with the weaker `claude-sandbox` and `codex-sandbox`
tiers and no background service (see [installation](docs/installation.md#isolation-tiers)).
Any `FAIL` names what is missing and the command that fixes it.

**5. First run.** `orbit run --goal "Add a CSV export to the reports page"`
(plugin: `/orbit:run Add a CSV export to the reports page`)

Before it creates anything, `orbit run` refuses, and says why, when the working
tree has uncommitted changes (only `.orbit/` is exempt), the repository has no
commits, the policy defines no check, a `ui` section or Playwright check has no
`@playwright/test` installed, the repository's git configuration holds
credentials, or the environment gate fails (a delivering mode also needs the
`gh` CLI and a `GH_TOKEN`). No run exists
and no model has been called in that case. Otherwise it drives the run in your
terminal and prints each step; Ctrl-C pauses it (`orbit resume <run-id>
--foreground` continues it when no service is running). From a plugin session with no service, `/orbit:run`
starts the run in the background of that session and says so.

When it ends, `orbit report <run-id>` prints the final report, including the
verdict per criterion and the branch. The change is on the local branch
`orbit/<run-id>`; your working tree and your branch are untouched. Look at it
with `git log orbit/<run-id>` and merge it yourself.

**To let Orbit deliver**, set `mode: autonomous-delivery`, install the `gh` CLI
and export a fine-grained `GH_TOKEN`. Commit, push, pull request and CI repair
then turn on by themselves (the template leaves those actions out so that they
follow the mode). A run then pushes `orbit/<run-id>` and opens a draft pull
request.

**To run unattended**, install the background service, then hand runs to it:

```bash
orbit service install
orbit run --goal "..." --detach
orbit status                       # recent runs
orbit timeline <run-id> --follow   # what it is doing, one readable line per step
```

Plugin skills need the service for runs that outlive the Claude Code session.
Make credentials visible to it as described in
[operations](docs/operations.md#installing-the-service).

A run ends in `SUCCEEDED`, `BLOCKED` (a question or a missing capability),
`EXHAUSTED` (a hard cap was reached), `IMPOSSIBLE` or `CANCELLED`. A blocked run
is continued with `orbit decide` and `orbit resume`, except when the block comes
from the run's frozen policy: then fix the config, cancel the run and start a new
one ([troubleshooting](docs/troubleshooting.md#run-problems)).

## Commands

| Command | Purpose |
|---|---|
| `orbit doctor [--probe]` | Check every capability a run depends on. `--probe` makes live requests. |
| `orbit init` | Write `.orbit/config.yaml` from the starter template. |
| `orbit run --goal <text>` | Freeze the policy and start a run (`--mode`, `--environment`, `--policy`, `--foreground`, `--detach`). |
| `orbit status [run-id]` | State, stage, attempts, budgets, workers, questions, heartbeat. |
| `orbit timeline <run-id>` | What happened in a run, one readable line per step in order, with local time: state changes and their reasons, routing and escalation with the evidence, each attempt and candidate with its verification verdict, check results, review outcome and reviewer, questions asked and answered, delivery actions, and the cost so far (measured against charged). `--follow` streams a running run, `--last <n>` cuts it, `--all` adds housekeeping, `--json` is for machines. |
| `orbit logs <run-id>` | The raw controller and worker logs, redacted (`--follow`, `--lines`, `--controller`, `--workers`, `--worker`). For a readable history use `orbit timeline`. |
| `orbit verify [run-id]` | Independent verification of a run's latest candidate: a verdict per criterion with its evidence. Exit 14 for FAIL, 15 for INCOMPLETE. |
| `orbit repair <run-id \| description \| ->` | Repair a failed run (BLOCKED or paused with FAIL evidence), or start a run to repair a described failure (`--foreground`, `--detach`, `--mode`, `--policy`). `-` reads the description from stdin. |
| `orbit stats` | Success rate, cost, repair loops and time to green for this repository (`--since`, `--until`). |
| `orbit gc` | Apply artifact retention to finished runs (`--keep-days`, `--dry-run`). |
| `orbit pause <run-id>` | Pause durably. |
| `orbit resume <run-id>` | Unpause, or continue a blocked run. Needs a controller: with a service it leaves the run to it; with none it refuses (changing nothing) unless you pass `--foreground`, or `--detach` to release it to a service you start later (`--force`). On a terminal with no service it drives the run itself. |
| `orbit cancel <run-id>` | Cancel durably (`--wait <seconds>`). |
| `orbit report <run-id>` | Final or interim report (`--interim`); `orbit report --learning` shows improvement over time. |
| `orbit questions <run-id>` | Questions a run is waiting on (`--all` includes answered ones). `orbit questions --pending` lists those of every unfinished run (`--quiet` prints nothing when there are none). |
| `orbit decide <run-id> <question-id> <answer>` | Record your answer (`--by`). Approving a baseline-exception question puts the exception in the run's contract. With remote answers on, a `/orbit answer <question-id> <choice>` comment on the run's pull request by someone with write access does the same. |
| `orbit notify test` | Send a test notification through the configured channels (desktop, webhook, GitHub comment). See [notifications](docs/operations.md#notifications-and-remote-answers). |
| `orbit release resolve <run-id>` | Settle a release-mode deploy whose outcome is unknown: runs the environment's `verify_command`, or records `--deployed` / `--not-deployed`. |
| `orbit policy show <run-id>` | The frozen policy, verified against its hash. |
| `orbit models list` / `models refresh` | The model registry and its availability. |
| `orbit learn list / show / ingest / export / overlays / eval` | The learning layer. See [docs/learning.md](docs/learning.md). |
| `orbit service install / uninstall / status / run` | The background service. |

Every command accepts `--repo <dir>`, `--json` and `--help`. Exit codes are
printed by `orbit help exit-codes`. `orbit status` takes `--all`, `orbit logs` and
`orbit timeline` take `-f` for `--follow`, and `orbit run --goal -` reads the goal from stdin.
Orbit Inquisition has no separate command: `/orbit:inquisition` runs it inside
Claude Code, and the controller runs it for unclear goals. Release mode has no
separate command either: `orbit run --mode release`, with the `release` and
`actions` sections of the policy. See
[release mode](docs/operations.md#release-mode-safeguards).

Releasing Orbit itself is not an `orbit` command: pushing a `v*` tag runs the
release workflow, which gates the tag, publishes the GitHub release with an
attested plugin archive and opens the catalog pull request. See
[Releasing](CONTRIBUTING.md#releasing) and
[verifying a release archive](docs/installation.md#verify-a-release-archive).

## Live runs and what is not proven yet

`scripts/demo/run-live-demo.sh` runs three demo goals against live providers on
the public demo repository [QuintinBotes/orbit-demo](https://github.com/QuintinBotes/orbit-demo),
Claude writing and Codex reviewing. The closing run on 2026-10-06 (reports in
[docs/demos/2026-10-06](docs/demos/2026-10-06/README.md)), unattended, with real delivery:

| Goal | Outcome |
|---|---|
| simple | `SUCCEEDED` on the routine tier (Sonnet) in one attempt; draft pull request opened |
| difficult | `SUCCEEDED` with an evidence-backed escalation to Opus (subsystem coupling), browser checks under `srt`; draft pull request opened |
| ui | `SUCCEEDED`: CSV export with download journeys on desktop and mobile, plus the existing accessibility and visual journeys, under `srt`; escalated to Opus; draft pull request opened |

The spec's third demo also asks for a UI task whose first attempt fails its
browser checks. Current models solve the demo goal on the first attempt, even
when the implementer starts on the cheapest tier, and Orbit does not plant
failures. The repair path for a UI defect is proven by acceptance scenario 17
(real Chromium with fake providers: the defect is reproduced, diagnosed,
repaired, reverified, reviewed and delivered as a draft pull request); a live
run on 2026-10-06 also went from a failed browser check through diagnosis to a
repair attempt, though that failure came from a sandbox defect that is now fixed
(see [the testing journal](docs/testing-journal.md)).

No CI ran in the demo repository, so the reports say CI is unverified. These
have **not** been run against real providers: CI observation and repair, release
mode (merge and deploy), container isolation, the `os-sandbox` tier with a valid
exported key, gitleaks, the learning
layer beyond curator calls, and the service on Linux. They are covered by the
mock demo (`scripts/demo/run-mock-demo.sh`, which runs with stubbed `gh` and
`orbit`) and the automated tests only; treat a claim about their live behaviour
as unverified. To reproduce the live demo yourself (this spends real money on
provider usage):

```bash
scripts/demo/run-live-demo.sh --repo OWNER/NAME --dry-run   # prints the plan, runs nothing
scripts/demo/run-live-demo.sh --repo OWNER/NAME
```

## Contributing

Contributions are welcome: read [CONTRIBUTING.md](CONTRIBUTING.md) and the
[code of conduct](CODE_OF_CONDUCT.md). Report security problems privately as
described in [SECURITY.md](SECURITY.md).

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
