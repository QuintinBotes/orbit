# 0002. A learning layer that cannot grant authority

Status: accepted (2026-10-03)

## Context

The spec describes a loop that plans, verifies and repairs, but each run
starts from nothing. The owner asked for Orbit to learn from everything it
does and from material it is given, in a standard format, and to improve over
time.

Orbit drives hosted models (Claude, Codex). It cannot change their weights.
The spec also forbids workers from modifying trusted runtime or policy, and
treats repository content, logs and web pages as untrusted.

## Decision

Learning happens in three places, all outside the trust boundary:

1. **Knowledge graph.** After each run, deterministic extraction turns
   verified evidence into raw observations (a failure fingerprint and the
   repair that cleared it, a resolved review finding, a CI breakage, a
   decision with its evidence, a scope denial). A curator worker turns them
   into lessons in one standard format (`schemas/lesson.schema.json`):
   statement, rationale, applicability, verification, evidence references,
   PROV-style provenance, qualitative confidence, status and scope. The graph
   is a SQLite property graph with FTS5 and exports to JSON-LD using schema.org
   and W3C PROV-O terms.
2. **Calibration.** Routing, initial allowances and difficulty classes are
   adjusted from measured outcomes (`route_outcomes`, attempts to green,
   cost per accepted run) within the policy's hard caps.
3. **Overlays.** Lessons that keep proving themselves are distilled into a
   per-role prompt overlay. A candidate overlay is evaluated on a replay suite
   of past tasks against the active overlay. It is adopted automatically only
   if it improves verified pass rate or cost with no regression in any metric,
   and it is rolled back automatically when live metrics regress past a
   threshold. Every version is kept.

## Guardrails

- Lessons and overlays are advisory text inside a fenced block. Policy, hard
  caps, protected paths, check definitions, tests and base role prompts are
  not reachable from this layer, so a wrong lesson can cost an attempt but
  cannot authorize anything.
- A lesson starts as `candidate`. It becomes `validated` only with evidence
  from at least two distinct runs and no contradiction; contradictions outnumbering
  support deprecate it.
- Ingested material (docs, PR threads, postmortems, web pages) enters as
  `candidate` with `low` confidence and source `ingest`, and is never
  retrieved as validated until run evidence corroborates it.
- Confidence is qualitative. Support and contradiction counts are reported as
  counts, not probabilities.

## Scope and privacy

- Each repository has its own graph in `.orbit/knowledge.sqlite`.
- A global graph in `~/.orbit/knowledge.sqlite` receives only lessons that are
  `code_free`, come from a repository configured with
  `knowledge.share_globally: true` (default false), and pass the publication
  guard (no private terms, no identities). Client repositories therefore
  never leak into another repository's prompts.
- Overlays are scoped the same way.

## Consequences

- Runs pay a small curation cost at the end. It is bounded by the run's
  remaining budget and skipped when the reserve is needed.
- Replay evals cost real model usage. They run only when a candidate overlay
  exists and the configured eval budget allows.
- Improvement is measurable: `orbit report --learning` shows pass rate,
  attempts and cost per accepted task over time, by overlay version.
