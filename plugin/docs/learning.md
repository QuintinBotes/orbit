# The learning layer

Orbit cannot change the weights of the models it drives. What it can do is
remember what worked, and use that to choose routes and to add short advisory
notes to worker prompts. The design is in
[ADR 0002](decisions/0002-learning-layer.md). The rule that matters most: nothing
learned can grant authority. Lessons and overlays are advisory text inside a
fenced block. Policy, hard caps, protected paths, check definitions, tests and
base role prompts are not reachable from this layer, so a wrong lesson can cost
an attempt but cannot authorize anything.

## What is learned

After each run, deterministic code extracts raw observations from verified
evidence: a failure fingerprint and the repair that cleared it, a resolved
review finding, a CI breakage, a decision with its evidence, a scope denial.
A curator worker (a small, cheap model call, bounded by
`knowledge.curator_budget_usd` and skipped when the run needs its reserve, when
the run was cancelled, and when it ended before any worker session, such as a
block at PREFLIGHT: the gates' records of the environment are not lessons about
the repository, and the curator would only cost a session) turns
them into lessons in one standard format (`schemas/lesson.schema.json`):
statement, rationale, applicability, verification, evidence references,
provenance, qualitative confidence, status and scope.

Lesson kinds: `practice`, `failure-pattern`, `repair-recipe`, `convention`,
`hazard`.

Lesson statuses:

| Status | Meaning |
|---|---|
| `candidate` | newly extracted or ingested; retrieved only with a clear label |
| `validated` | supported by evidence from at least two distinct runs and not contradicted |
| `deprecated` | contradictions outnumber support |
| `rejected` | refused by validation or by the publication guard |

Confidence is `low`, `medium` or `high`, and support and contradiction are
reported as counts, not probabilities.

Two other things adapt over time. Calibration adjusts routing, starting
allowances and difficulty classes from measured outcomes, always inside the
policy's hard caps. Overlays (below) are per-role prompt additions distilled
from lessons that keep proving themselves.

Set `knowledge.enabled: false` to turn the layer off. A worker prompt gets at
most `knowledge.max_advisory_tokens` (default 800) of advisory text.

## Where it is stored

| Data | Location |
|---|---|
| Repository lessons | `<repo>/.orbit/knowledge.sqlite` (SQLite with FTS5; kept out of `git status` by `orbit init`) |
| Repository overlays | `<repo>/.orbit/knowledge/` |
| Global lessons and overlays | `~/.orbit/knowledge.sqlite` and `~/.orbit/knowledge/` |

Overlays and lessons never live in the plugin directory.

## share_globally

By default each repository has its own graph, so client or private work never
appears in another repository's prompts. A lesson reaches the global graph only
when all three hold:

1. the source repository sets `knowledge.share_globally: true` (default `false`);
2. the lesson is `code_free`: no code, paths or repository-specific terms;
3. it passes the publication guard (no private terms, no identities).

Leave `share_globally` false for client or private work. With it on,
`orbit doctor` fails if the private-terms file cannot be found, because the
guard would have nothing to check against.

## Overlays and rollback

A distilled overlay starts as `candidate`. Statuses: `candidate`, `evaluating`,
`active`, `retired`, `rolled_back`, `rejected`. A candidate is replayed against a
suite of past successful tasks and compared with the active overlay. It is
adopted automatically (`knowledge.auto_adopt_overlays: true`) only if verified
pass rate or cost improves and no metric regresses. Replays spend real model
usage, so they run only within `knowledge.eval_budget_usd`; the default `0`
disables evaluation and therefore automatic adoption. When live metrics of an
active overlay regress past a threshold, it is rolled back automatically and the
previous known-good overlay is restored. Every version is kept.

Roll back by hand:

```bash
orbit learn overlays                          # list overlays and their evaluations
orbit learn overlays --role implementer --status active
orbit learn overlays rollback <overlay-id> --reason "regressed on lint repairs"
```

Run an evaluation yourself:

```bash
orbit learn eval --role implementer           # distill a candidate and evaluate it
orbit learn eval --overlay <overlay-id> --limit 10
```

## Inspect, ingest and export

```bash
orbit learn list --status validated
orbit learn list --kind failure-pattern --search "lockfile"
orbit learn show <lesson-id>                  # statement, evidence and history
orbit learn list --global                     # the same, in the global graph
orbit learn list --limit 10                    # at most 10 lessons (default 50)
orbit report --learning                       # pass rate, attempts and cost per accepted task over time, by overlay version
orbit stats --since 30d                       # success, cost and repair loops for the last 30 days
```

Learn from a document, URL or pasted text:

```bash
orbit learn ingest docs/postmortem-2026-09.md
orbit learn ingest https://example.com/guide --label "acme guide"
orbit learn ingest --print-task postmortem.md   # show the redacted curator task; nothing is sent
```

Ingested material enters as `candidate`, confidence `low`, source `ingest`, and is
never retrieved as validated until run evidence corroborates it.

Export the graph as JSON-LD (schema.org and W3C PROV-O terms):

```bash
orbit learn export --out lessons.jsonld
orbit learn export --global --out global-lessons.jsonld
```

Review an export before sharing it outside your machine. The publication guard
protects the global graph, not a file you hand to someone else.
