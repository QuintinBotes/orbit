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
| `candidate` | newly extracted or ingested; never put in a prompt (only validated lessons are) |
| `validated` | supported by evidence from at least two distinct runs and not contradicted |
| `deprecated` | contradictions outnumber support, or two distinct runs contradicted it |
| `rejected` | refused by validation or by the publication guard |

Confidence is `low`, `medium` or `high`, and support and contradiction are
reported as counts, not probabilities.

Two other things adapt over time. Routing reads the measured outcomes of
earlier implementation attempts (next section). Overlays (below) are per-role
prompt additions distilled from lessons that keep proving themselves. Starting
allowances and difficulty classes are not adjusted from outcomes: they come
from the policy and from the planner's assessment of each run.

Set `knowledge.enabled: false` to turn the layer off. Lessons and overlays
enter worker prompts only with `knowledge.lessons_in_prompts: true`, which is
off by default until a full benchmark shows that they help; everything else in
this section runs either way. With it on, a worker prompt gets at most
`knowledge.max_prompt_lessons` (default 3) validated lessons and at most
`knowledge.max_advisory_tokens` (default 800) of advisory text.

## Cited, re-checked, contradicted and expired lessons

Every lesson curated from a run cites that run and, where the run's records name
one, the file and line, the check or the review finding it came from (`citation`
in `schemas/lesson.schema.json`), taken from the controller's own observations,
never from the curator. A run lesson that cites no file or check (one resting
only on a CI failure or a decision, say) cannot be re-checked and stays out of
prompts. A lesson
that names a secret or a person (an email address, a home directory, a value the
redactor masks) is refused when it is written.

Before a lesson may enter a prompt, and at the end of every run, it is
re-checked against the repository: its cited file must still exist (and the
cited line be inside it), its cited check must still be configured, and it must
have had supporting evidence within `knowledge.lesson_expiry_days` (default 28).
A lesson that fails is marked stale with the reason and is not retrieved; it is
eligible again once the check passes. A lesson from a run that cites no file or
check cannot be re-checked and is not retrieved. Seeds and ingested material
cite their source, not the repository, and are checked for age only.

When a run ends, the lessons it was shown are settled from its records alone. A
lesson shown to a worker that was repairing a failure fingerprint is
contradicted when that worker's own candidate fails with the same fingerprint
again; contradictions from two distinct runs deprecate it. A run that succeeded
supports only the lessons whose cited file, path globs or checks it touched: a
file one of its candidates changed, or a check that failed on one.

A run that ends without succeeding also stores an observation keyed by its
failure class, naming each check that failed or could not run with its
fingerprint or signature (table `observations`). It is written without a model
call, also when the run's budget reserve cannot pay for curation.

`orbit learn list` shows each lesson's status (with `stale` or `expired` when
it is not eligible), supporting and contradicting runs, and age;
`orbit learn show` names its citation and why it is not eligible.

## The shared memory store (off by default)

The owner's memory plugin can be the one store of lessons across tools. Orbit
keeps its own store either way; `knowledge.shared_memory` adds a bridge, and it
is off until the benchmark (#172) shows no loss:

```yaml
knowledge:
  lessons_in_prompts: true
  shared_memory:
    enabled: true
    command: [memory]        # argv of the memory command; `recall` or `mcp` is appended
```

With it on, a worker's advisory block also carries up to three shared items
(ids shown, same fence, same `max_advisory_tokens`, and within `max_prompt_lessons` together with the local lessons), read with the plugin's
`recall --orbit` run in the repository, which is how the plugin keeps another
tenant's items out. At the end of a run Orbit proposes each lesson it left
validated to memory (evidence: `orbit run <id>`) and reports a recalled item
wrong when the run repeated the failure it was shown for. Orbit never activates
an item; the owner approves proposals in memory. If memory cannot be reached the
run goes on without it, skips it for the rest of that run, and the event
`learning.memory-unavailable` records the operation once. `orbit doctor` checks the command when the bridge is on.

## Routing from measured outcomes

Every implementation attempt whose evidence settles records one row in the
state database's `route_outcomes` table: the role, provider, model and effort
the attempt was routed to, its task class (the work kind and the run's
difficulty class), the result and the cost.

| Result | When it is recorded |
|---|---|
| `failed` | a trusted check or a required browser journey ran on the attempt's candidate to its end and failed |
| `rejected` | verification passed and review sent the candidate back to repair |
| `verified` | verification passed and review cleared the tree |

Nothing is recorded when the result says nothing about the model: an attempt
that never became a candidate (the provider was unavailable, the session was
lost or refused), a failure the environment caused, a check or journey that
timed out or could not run, a refusal by a gate that ran no check (scope,
size, the static security gate), or a run that stopped before its candidate
was judged. A cost is recorded only when every session of the attempt reported
one; otherwise it is stored as unknown, never as zero. Each implementation
attempt is recorded once. A repair that reproduces an earlier attempt's tree
gets the earlier candidate back, and is still recorded as its own attempt with
its own route and cost.

When a run ends with the failure class `environment` or `check-misconfigured`
on the evidence of an attempt that was recorded, routing does not read that
attempt's outcome and `orbit stats` counts it as not judged. The run's other
attempts were judged on the work and still count.

Only implementation attempts are recorded, so only an implementation attempt's
route reads outcomes, and only the implementer's. The planner, diagnoses, the
reviewer and the inquisitor always keep the routing table's choice.

When a new attempt is routed, Orbit reads the outcomes of the same task class
from the last `routing.learning.window_days` days (default 90). The routing
table still gives the starting model. A model one tier cheaper displaces it
only when all of these hold:

- it has at least `routing.learning.min_samples` judged outcomes in that class
  and window (default 20);
- its measured pass rate, verified over verified plus failed plus rejected, is
  at least `routing.learning.min_pass_rate` (default 0.8);
- its expected cost per verified task is more than 10% below that of the
  table's choice. Without a measured cost the model's list price is used, and
  a model with neither is never chosen for being cheaper.

When that model's measured pass rate falls below the threshold, the table's
choice is used again. Failures older than the window are no longer read, so a
model is not held back forever; it is used again once it has enough outcomes
above the threshold, which it only collects from runs that route to it (an
entry in `routing.overrides`, for example), since Orbit does not try a cheaper
model on its own. A tier above the table's choice displaces it only when both
are measured and it is clearly cheaper per verified task, and never Fable.

What this cannot do: choose a model outside `routing.allowed_models`, override
an entry in `routing.overrides`, change a route while repeated failures are
escalating it, or route an attempt below the tier the run's previous attempt
ran on. The same recorded outcomes always give the same route; ties go to the
lower expected cost, then the lower tier, then the model id. The recorded
reason says which costs were measured and which are list prices.

`routing.learning.min_samples` is also the number of measured outcomes every
other measured routing decision needs: when a route's cost counts as measured,
and when measured evidence justifies Fable.

Each route decision that read outcomes records what it read under `learning`:
the table's choice, the counts, the pass rate, the window and one sentence
saying why the table's choice was displaced or kept. `orbit status <run>`
shows that sentence for the run's newest implementation attempt on a
`routing:` line. `orbit stats` lists every
route with its pass rate and its cost per accepted task (the cost of all its
attempts, failed ones included, over its verified ones; a dash when a cost is
unknown). Set `routing.learning.enabled: false` to switch this off: outcomes
are still recorded, and routing reads none of them.

## Where it is stored

| Data | Location |
|---|---|
| Route outcomes | `<repo>/.orbit/state.sqlite`, table `route_outcomes` |
| Repository lessons and run-end observations | `<repo>/.orbit/knowledge.sqlite` (SQLite with FTS5; kept out of `git status` by `orbit init`) |
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
disables evaluation and therefore automatic adoption. When an evaluation also
has a result from the benchmark's held-out scenarios, a candidate whose pass
rate there is lower than the current prompt's is not adopted, and the reason is
recorded with the evaluation. Until the benchmark (issue #172) supplies that
result, evaluations have none. A replay puts the overlay under test in the
replay's prompts whatever `knowledge.lessons_in_prompts` says, since measuring
it there is the point. When live metrics of an
active overlay regress past a threshold, it is rolled back automatically and the
previous known-good overlay is restored. Live runs judge an overlay only while
`knowledge.lessons_in_prompts` is on: with it off no prompt carries the
overlay, and the runs that ended with it off are left out of the window when it
is turned on again. Every version is kept.

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
