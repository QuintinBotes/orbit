# 0021. Orbit speaks the open conventions

Status: accepted (2026-11-20). Issue #178.

## Context

Teams adopt a tool that reads and writes what their other tools already use.
Orbit read none of it: `orbit init` proposed checks from manifests only and
once contradicted the commands a repository documented (#138), workers start
with `CLAUDE.md` loading turned off (repository text is untrusted data), the
run report and the other JSON documents had no published schema, and a run
could be observed only through Orbit's own commands and database.

## Decision

- **Repository instructions.** `AGENTS.md` is the cross-vendor default, so it
  is read first, then `CLAUDE.md`. `orbit init` reads the tracked root files and
  prefers a check command they document (in a fenced block or an inline code
  span, starting with a known tool, needing no shell, naming a kind of check)
  over the one it derives from manifests, and says in each proposal where it
  read it. Every worker prompt (planner, implementer, verifier, reviewer,
  explorer, inquisitor) carries both files as the run's base revision has them,
  inside the untrusted-data fences, capped like any untrusted block; the first
  prompt of a run records which it read, with their hashes, in
  `repo-instructions.json` and a `repo.instructions-read` event, and every
  later prompt reuses that record. `CLAUDE.md` loading stays off: the files are
  data a worker follows where they fit, never instructions that outrank the
  policy. The curator gets neither; it works on run records in an empty
  directory, not on the repository. Codex's `AGENTS.override.md` is named by
  init, not read.
- **Published, versioned schemas.** The run report (`orbit.final/1`), the spec
  check result (`orbit.spec-check/1`) and the benchmark scorecard
  (`orbit.scorecard/1`) have JSON Schemas in `schemas/`. A document names its
  version in `schema`; removing or retyping a field is a new version. The run
  report's top level is closed, so a new top-level field needs the schema
  changed with it; nested objects may gain fields within a version. The
  scorecard schema comes before `orbit bench` (#172), which must write to it.
- **OpenTelemetry.** `orbit export <run-id> --otel` writes OTLP/JSON, which a
  collector reads without mapping: a root span for the run and an
  `invoke_agent` span per worker with the GenAI attributes for provider, agent,
  model and tokens. The GenAI conventions are in development, so the export
  pins the semantic conventions release 1.37.0 (the one that renamed
  `gen_ai.system` to `gen_ai.provider.name`) and names it in every `schemaUrl`.
  Cost has no GenAI attribute, so it is `orbit.cost_usd`, absent when no one
  measured it. Trace and span ids derive from the run and worker ids, so a run
  exports the same trace every time. No prompt, message, goal, source or worker
  error text is exported, and there is no option to include it.
- **Agent Skills.** `scripts/check-plugin.mjs` checks every skill against the
  Agent Skills format: `name` (1 to 64 lowercase letters, digits and single
  hyphens, equal to its folder), `description` (1 to 1024 characters),
  `license`, `compatibility` (at most 500 characters), `metadata` (strings to
  strings) and `allowed-tools` (a string, or the list Claude Code also takes).
  The format's reference validator allows no other key, but Orbit's skills need
  Claude Code's `argument-hint` and `disable-model-invocation` (ADR 0006
  addendum); those stay, held to the keys Claude Code documents.
- **The README** says what Orbit does that Claude Code's `/goal`, `/loop` and
  scheduled tasks do not, and when to use those instead.

## Consequences

- A repository's documented test command reaches the proposal and every worker,
  so the #138 kind of contradiction is caught at init, and the warning that
  init did not read the files is gone except for `AGENTS.override.md`.
- Each worker prompt grows by at most two capped blocks.
- A trace can go to any OpenTelemetry backend; a later conventions release is a
  deliberate change of `GENAI_SEMCONV_VERSION` and its tests.
- A skill that uses a key outside the Agent Skills format and Claude Code's
  documented extensions fails `npm run validate:plugin`.
