# 0003. Orbit never handles model-provider credentials

Status: accepted (2026-10-03)

## Context

Anthropic's Agent SDK documentation states that, unless previously approved,
third-party developers may not offer claude.ai login or claude.ai rate limits
in their products, and should use API-key authentication
(`docs/interfaces/claude-headless-and-sandbox.md` §6). Orbit is open-source
software that runs the user's own Claude Code CLI on the user's own machine.

## Decision

- Orbit implements no login flow and never reads, stores, copies or forwards
  Anthropic or OpenAI credentials. It runs the `claude` and `codex` CLIs the
  user installed, with whatever authentication those CLIs are configured to
  use.
- `orbit doctor` reports the authentication method each CLI reports, and
  recommends API-key authentication (`ANTHROPIC_API_KEY`, `CODEX_API_KEY`) for
  unattended service execution. The documentation says the same.
- Expired or invalid credentials block the run with an explicit reason; Orbit
  never retries authentication failures (spec §14).
- Fable models are excluded from `routing.allowed_models` in the starter
  configuration: headless Claude Code bills Fable usage credits without a
  consent prompt (`claude-headless-and-sandbox.md` §5). A user who wants Fable
  routing adds it explicitly.

## Consequences

The project's README must not present Orbit as a way to use a claude.ai
subscription in another product. It is a local automation layer over the
user's installed tools.

## Credentials and the strongest worker tier

The `os-sandbox` worker tier (ADR 0001) cannot see a keychain login, so it
uses a credential the user exported (`ANTHROPIC_API_KEY`, or
`CLAUDE_CODE_OAUTH_TOKEN` created with `claude setup-token`). Orbit passes the
variable through to the worker's environment and nothing else: it is never
written to disk by Orbit, never logged (redaction covers it), and never sent
to any other provider. Without such a variable Orbit falls back to the
`claude-sandbox` tier and says so in `orbit doctor` and in every report.
