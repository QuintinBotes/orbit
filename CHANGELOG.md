# Changelog

## 0.1.0

First release.

- Durable goal contracts, an explicit run state machine, and one owner lease
  per run in a repository-local SQLite state database.
- Immutable policy: `.orbit/config.yaml` is validated and frozen into a hashed
  snapshot at run start.
- Isolated workers in git worktrees outside the repository, in the
  `os-sandbox` or `claude-sandbox` tier, with sandbox-runtime or Docker
  isolation for trusted checks.
- Controller-side candidate snapshots, trusted check execution, and evidence
  bound to the candidate tree, check configuration and policy.
- Independent review by a second provider (Codex), with a data-policy gate.
- Adaptive iteration budgets under fixed hard caps; model routing with
  recorded justification; usage and cost accounting.
- Orbit Inquisition for unclear goals, weak evidence and repeated failures.
- Playwright UI journeys with accessibility and visual-baseline handling.
- Delivery through `git` and `gh` with an intent, execute, receipt ledger;
  CI observation and repair.
- Recovery: foreground and service execution (launchd, systemd user unit),
  heartbeats, watchdog, reattachment to workers after a controller crash.
- A learning layer: lesson graph, calibration, prompt overlays with replay
  evaluation and rollback, JSON-LD export, publication guard.
- The `orbit` CLI, six plugin skills, six agents and the guard hook, shipped as
  one committed bundle (`dist/orbit.mjs`).
