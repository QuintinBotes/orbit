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
| `config` | no `.orbit/config.yaml` | Run `orbit init`. |
| `config` | configuration is invalid | Fix each listed problem; unknown keys and contradictory settings are errors. Compare with `templates/config.yaml`. |
| `storage` | SQLite cannot use WAL | The repository is on a network share or a container bind mount. Use a local disk. |
| `storage` | state database problem or not writable | Fix permissions on `.orbit/`. If the database is newer than this Orbit, upgrade Orbit. |
| `checks` | a configured check's executable or script is missing | Install it, or correct the `command` in `checks`. With no checks defined, nothing can be verified. |
| `isolation` | sandbox-runtime unavailable | Install `srt` (`npm install --global @anthropic-ai/sandbox-runtime`); on Linux install bubblewrap. Orbit will not fall back to weaker isolation. |
| `isolation` | container image not present locally | `docker pull <image>`. Containers run with `--pull never`. Make sure the Docker daemon is running. |
| `isolation` | `none` provider warning | Workers run with your full permissions. Use `sandbox-runtime` or `container`. |
| `claude.cli` | claude not usable | Install Claude Code and put it on PATH, or set `providers.claude.command`. Sonnet 5.5 needs 2.1.284 or newer. |
| `claude.auth` | credentials expired, invalid or missing | `claude auth login`, or export `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`. For the service, make the variable visible to it (see [operations](operations.md#installing-the-service)). Then `orbit resume <run-id>`. |
| `claude.worker-tier` | workers use the `claude-sandbox` tier | No exported Claude credential, or not using sandbox-runtime. Export `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` and use `isolation.provider: sandbox-runtime` for the `os-sandbox` tier. |
| `codex.cli`, `codex.auth` | codex missing or logged out | Install the Codex CLI, `codex login` or export `CODEX_API_KEY`. Not required if independent review is off. |
| `review` | independent review would block | Make a second provider usable and set `providers.<id>.data_policy_eligible: true` if sending sanitized code to it is permitted, or turn off `review.independent_provider_required` knowingly. |
| `models` | no allowed Claude model is eligible | Allow `sonnet`, `opus` or `haiku` in `routing.allowed_models`, and upgrade `claude` if a minimum version is shown. `orbit models list` explains each model. |
| `playwright` | `@playwright/test`, browsers or axe missing | `npm install -D @playwright/test @axe-core/playwright` in the repository, then `npx playwright install chromium`. |
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

- **A run is `BLOCKED`.** `orbit status <run-id>` and `orbit report <run-id>
  --interim` give the reason. Answer questions with `orbit decide`, fix the
  environment, then `orbit resume <run-id>`.
- **`resume` exits 5 (CONFLICT).** A live controller owns the run, or open
  questions remain. Answer them, or pass `--force` if you accept the risk.
- **Exit 4 (CONFIG).** The configuration, contract or an action failed policy
  validation. The message lists each problem. `orbit policy show <run-id>`
  shows what the run was frozen with.
- **Exit 7 (ENVIRONMENT).** A provider CLI, credential or isolation capability is missing. Run `orbit doctor`.
- **A run is `EXHAUSTED`.** A hard cap was reached; the report names which. Raise the
  cap in `scheduler.hard_limits` only if the goal justifies it, and start a new run.
- **Scope violations.** A worker changed a path outside `scope.allowed_paths` or
  inside `protected_paths`. Widen the scope in the config yourself if intended.
  Orbit will not let a model do it.
- **The service is not picking up my change to `config.yaml`.** Runs freeze the
  policy when they start. Start a new run.
- **Stale or leftover state.** `orbit cancel <run-id>` works on blocked and
  ownerless runs. Worktrees are under `~/.orbit/worktrees/`.

## Getting more detail

```bash
ORBIT_DEBUG=1 orbit <command>       # stack traces for internal errors
orbit logs <run-id> --controller --lines 500
orbit help exit-codes
```

When you report a bug, include `orbit --version`, `orbit doctor --json` with
secrets removed, and the relevant log lines. Report vulnerabilities privately
(see [SECURITY.md](../SECURITY.md)).
