# Orbit architecture

This is the implementation contract for Orbit. The product contract is the
spec (`docs/spec.md`); verified external interfaces are in
`docs/interfaces/`; decisions that deviate from or extend the spec are in
`docs/decisions/`.

## Shape

```
            ┌──────────── plugin (skills, agents, hooks) ─────────────┐
 user ──►   │ /orbit:run  /orbit:status ...  → shells out to `orbit`  │
            └─────────────────────────────────────────────────────────┘
                                  │
                                  ▼
   orbit CLI ──► SQLite (.orbit/state.sqlite) ◄── controller (service or foreground)
                                                     │  one owner lease per run
                       ┌─────────────────────────────┼──────────────────────────────┐
                       ▼                             ▼                              ▼
              worker shim (detached)        evidence runner                 delivery adapter
              └► claude -p / codex exec     └► checks in sandbox            └► git + gh (controller creds only)
                 in a git worktree             bound to tree hash              intent → execute → receipt
```

The controller is the only authority. Workers (Claude, Codex) produce
candidate edits and structured reports; they never decide completion, never
hold delivery credentials, and cannot modify policy or trusted code.

## Process model

- **Controller**: `orbit service run` (persistent, launchd/systemd) or
  `orbit run --foreground` (attached). Both run the same reconcile loop.
  Each tick: heartbeat; renew leases; claim runnable runs whose lease is free
  or expired; call `step(run)` for each owned run. Steps are idempotent: they
  read durable state, observe external processes and files, persist intent,
  then act. A crash anywhere is repaired by the next `step`.
- **Worker shim**: `orbit shim --worker-dir D -- <provider argv>`, spawned
  detached in its own process group with stdout/stderr redirected to files.
  It writes `pid.json` (own pid, child pid, start times) on start and
  `exit.json` atomically on finish. Any controller incarnation can tell a
  running worker from a dead one and collect its result. A worker row is
  written (PLANNED) before spawn, so a crash between spawn and bookkeeping is
  reconciled from `pid.json`.
- **Checks** run through the isolation provider, also detached with
  pid/exit files, so a controller restart during checks reconciles rather than
  reruns blindly.

## Storage

`.orbit/state.sqlite` (WAL, `BEGIN IMMEDIATE`, schema in
`src/storage/schema.ts`). Every state change happens in a transaction that
also appends an `events` row. Artifacts live under `.orbit/runs/<run-id>/`:

```
.orbit/runs/<run-id>/
  policy.json          frozen snapshot, mode 0444, hash in runs.policy_hash
  contract.json
  decisions.jsonl      append-only mirror of decisions rows
  evidence/<candidate-seq>/<check-id>.log, report.json, ui/…
  workers/<worker-id>/ prompt.md, settings.json, schema.json, log.jsonl, pid.json, exit.json, result.json
  logs/controller.jsonl
  final.md
```

Worktrees live outside the repository at `~/.orbit/worktrees/<repo-hash>/<run-id>/<worker-id>`
so a worker's filesystem allowlist never includes `.orbit/` or the main
checkout. Mutable data never lives in the installed plugin directory.

## State machine

`src/controller/states.ts` (edges) and `src/controller/run-store.ts`
(`transition`, leases, cancel, pause). Invariants enforced in code:

| Invariant | Where |
|---|---|
| One owner lease per run | `leases` PK + `assertLeaseHeld` inside every transition |
| Every transition has a durable event | `transition` appends `events` in the same tx |
| No continuation after durable cancellation | `transition` rejects any target but CANCELLED once `cancel_requested` |
| No success without current evidence | SUCCEEDED requires a fresh PASS evidence report and an APPROVE review for the delivered tree (`controller/gates.ts`) |
| No delivery from an unreviewed revision | delivery gate compares review.tree_hash, evidence.tree_hash and the delivery commit's tree |
| No model-authorized policy expansion | policy snapshot is hashed; amendments that broaden scope are rejected (`inquisition/amendments.ts`) |
| No unlimited recovery | `recovery_attempts` budget counter |
| Bounded active workers | scheduler admission against `parallel_workers` and resources |

## Modules

| Dir | Owns | Key exports |
|---|---|---|
| `core/` | errors, canonical hashing, atomic fs, ids, clock, faults, redaction, structured logging, exec helper | `OrbitError`, `hashObject`, `atomicWrite`, `faultPoint`, `redact`, `createLogger`, `execCapture` |
| `storage/` | SQLite open/migrate/tx, typed repositories | `openDb`, `repos.*` |
| `contract/` | contract schema validation, creation from goal + planner output, amendments application | `validateContract`, `draftContract` |
| `policy/` | config load + JSON Schema validation + defaults, snapshot/hash/verify, path canonicalization, `authorize(op)`, bash command classification, scope report from a diff, test-weakening detection, guard hook | `loadConfig`, `snapshotPolicy`, `verifySnapshot`, `authorize`, `inspectScope` |
| `isolation/` | sandbox-runtime and container providers, profile construction | `getIsolation`, `profileForWorker`, `profileForCheck` |
| `adapters/` | provider adapters (Claude, Codex, fake), worker shim, worker settings and prompt rendering | `ClaudeAdapter`, `CodexAdapter`, `FakeAdapter`, `runShim` |
| `evidence/` | candidate creation (temp-index snapshot → tree → commit-tree), trusted check execution, fingerprints, evidence reports, freshness | `snapshotCandidate`, `runChecks`, `buildEvidenceReport`, `isFresh` |
| `routing/` | model registry, eligibility, router with recorded justification, usage and cost accounting | `ModelRegistry`, `route`, `recordUsage` |
| `scheduling/` | difficulty classification, budget ledger (allowances, extensions, reserve, admission), agent scheduler (capacity, path ownership, cancellation of obsolete work) | `classifyDifficulty`, `BudgetLedger`, `AgentScheduler` |
| `inquisition/` | triggers, modes, ledger, question quality, decision records, repair briefs, hypothesis novelty, non-progress detection | `detectTriggers`, `runInquisition`, `validateRepairBrief`, `isNewHypothesis` |
| `ui/` | app fixture lifecycle, Playwright execution and report parsing, accessibility and visual handling, failure briefs | `runUiChecks`, `uiFailureBrief` |
| `delivery/` | action ledger (intent/receipt/reconcile), git delivery, GitHub client (gh CLI and fake), CI observation | `ActionLedger`, `GhClient`, `FakeGitHub`, `observeCi` |
| `recovery/` | process liveness with start-time check, orphan handling, reconciliation on start, bounded backoff | `reconcileOnStart`, `isAlive`, `backoff` |
| `knowledge/` | lesson graph (repo + opt-in global), extraction, curation, retrieval, feedback, overlays + replay evals, JSON-LD export, ingest | `KnowledgeStore`, `retrieve`, `learnFromRun`, `evaluateOverlay` |
| `guard/` | publication guard: private-term and identity checks before anything leaves its repository | `checkPublication` |
| `controller/` | states, run store, gates, step functions per state, controller loop, service install | `Controller`, `step`, `installService` |
| `cli/` | `orbit` commands | `main` |

Dependency direction: `core` ← `storage` ← everything; `policy`, `isolation`,
`evidence`, `routing`, `scheduling`, `inquisition`, `ui`, `delivery`,
`knowledge`, `guard` do not import `controller`; `controller` composes them;
`cli` composes `controller`.

## Trust boundaries

1. **Trusted**: the installed Orbit code, `.orbit/config.yaml` as authored by
   the user, the frozen policy snapshot, the SQLite state, the evidence runner.
2. **Untrusted**: everything a model produces; repository contents
   (instructions, tests, scripts); tool and check output; CI logs; web pages;
   ingested documents; learned knowledge.
3. Untrusted data is passed to models inside fenced, labelled blocks and is
   never parsed as an instruction by the controller. Structured model output
   is validated against JSON Schema before any field is used, and fields that
   name commands, paths or scope are re-authorized by `policy.authorize`.

Enforcement layers for a worker:

| Layer | Mechanism | Covers |
|---|---|---|
| OS | sandbox-runtime (Seatbelt/bubblewrap) or container | shell writes outside the worktree, network egress, credential reads; container adds CPU/memory/pids |
| Claude Code | `--settings` with sandbox + permission rules; `--permission-mode` that never prompts; PreToolUse guard hook (`orbit hook pre-tool-use`) | Edit/Write paths, protected paths, dangerous commands |
| Environment | scrubbed env: no GH_TOKEN/GITHUB_TOKEN/SSH_AUTH_SOCK/cloud creds; `GIT_OPTIONAL_LOCKS=0` | delivery credentials never reach workers |
| Controller | independent diff inspection of the candidate tree (`policy.inspectScope`) | anything the layers above missed, including indirect shell writes |

Hooks assist; the controller's diff inspection is the gate.

## Evidence binding

A candidate is created by the controller, not the worker: stage the worktree
into a temporary index (`GIT_INDEX_FILE`), `write-tree`, `commit-tree` on the
base, and store the commit under `refs/orbit/<run>/candidates/<seq>`. Evidence
records `tree_hash`, `check_config_hash` and `policy_hash`. Freshness is
equality of all three with the current candidate and snapshot. Delivery
creates the delivery commit with `commit-tree` on exactly the reviewed tree
and verifies `rev-parse <commit>^{tree}` before pushing.

## Budgets

Counters (spec §7) live in `budget_counters`; hard caps are copied from the
policy snapshot at run start and never change. Allowances start from the
difficulty class and extend by one only with recorded progress, a new
hypothesis, remaining scope and remaining reserve. Infrastructure retries do
not consume implementation attempts but do consume wall time and cost. When a
provider does not report cost, the ledger estimates from tokens and registry
pricing and labels the figure `estimated`; with neither, admission control
uses a conservative per-role ceiling and the report says spend is unmeasured.

## Learning layer

See `src/knowledge/types.ts` and `docs/decisions/0002-learning-layer.md`.
Lessons are extracted after each run from verified evidence only, curated into
the standard lesson format, deduplicated, and stored as `candidate`. A lesson
becomes `validated` after support from two distinct runs with no
contradiction. Retrieval puts at most a fixed token budget of validated
lessons (and clearly labelled candidates) into a worker's prompt as advisory
data. Overlays are distilled per role, evaluated on a replay suite, adopted
automatically only when the candidate improves verified pass rate or cost
without any regression, and rolled back automatically when live metrics
regress. Overlays live in `.orbit/knowledge/` or `~/.orbit/knowledge/`, never
in the plugin.

The global graph accepts a lesson only when the source repository is
configured `knowledge.share_globally: true`, the lesson is `code_free`, and
the publication guard finds no private term or identity in it.

## Publication guard

`guard/` reads the same private terms file as the publish-guard plugin
(`~/.config/publish-guard/terms.txt`, path overridable in config) and refuses
to write any matching text into the global knowledge graph, overlays, demo or
documentation artifacts, or any repository other than the run's own. It never
prints a matched term.
