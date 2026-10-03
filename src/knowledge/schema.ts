/**
 * The knowledge graph's own SQLite schema (`.orbit/knowledge.sqlite` per
 * repository, `~/.orbit/knowledge.sqlite` for the opt-in global graph).
 *
 * It is a separate file from run state on purpose: the global graph has no
 * runs table, a repository's knowledge outlives its run history, and the two
 * evolve on separate migration counters. Same rules as storage/schema.ts:
 * append-only migrations, PRAGMA user_version, epoch-millisecond INTEGER
 * times, *_json TEXT columns, enumerations checked in code.
 */
export const KNOWLEDGE_MIGRATIONS: readonly string[] = [
  /* 1: lesson graph */ `
  -- One row per lesson. lesson_json is the authoritative orbit.lesson/1
  -- document; the other columns are denormalized from it for filtering.
  -- norm_key (kind + normalized statement) is what makes two phrasings of one
  -- lesson the same node.
  CREATE TABLE nodes (
    id           TEXT PRIMARY KEY,
    norm_key     TEXT NOT NULL UNIQUE,
    kind         TEXT NOT NULL,
    status       TEXT NOT NULL,
    scope        TEXT NOT NULL,
    confidence   TEXT NOT NULL,
    code_free    INTEGER NOT NULL,
    source       TEXT NOT NULL,
    statement    TEXT NOT NULL,
    lesson_json  TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX nodes_status ON nodes(status, kind);

  -- Typed edges. dst may name a lesson or an external entity (run:<id>,
  -- evidence:<run>#<artifact>, check:<id>, fingerprint:<fp>). Evidence edges
  -- carry run_id so support is counted per distinct run in SQL.
  CREATE TABLE edges (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    src         TEXT NOT NULL,
    dst         TEXT NOT NULL,
    type        TEXT NOT NULL,
    run_id      TEXT,
    data_json   TEXT,
    created_at  INTEGER NOT NULL,
    UNIQUE (src, dst, type)
  ) STRICT;
  CREATE INDEX edges_dst ON edges(dst, type);
  CREATE INDEX edges_src_type ON edges(src, type, run_id);

  CREATE VIRTUAL TABLE fts USING fts5(
    lesson_id UNINDEXED,
    statement,
    rationale,
    keywords,
    applicability,
    tokenize = 'porter unicode61'
  );

  -- Which lessons went into which worker's prompt, and how that run ended.
  CREATE TABLE retrievals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      TEXT NOT NULL,
    worker_id   TEXT,
    lesson_id   TEXT NOT NULL REFERENCES nodes(id),
    ts          INTEGER NOT NULL,
    score       REAL,
    outcome     TEXT,
    attempts    INTEGER,
    settled_at  INTEGER
  ) STRICT;
  CREATE INDEX retrievals_run ON retrievals(run_id);
  CREATE INDEX retrievals_lesson ON retrievals(lesson_id, outcome);

  -- Append-only audit of merges and status changes, so every promotion and
  -- deprecation can be explained after the fact.
  CREATE TABLE lesson_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    lesson_id  TEXT NOT NULL,
    ts         INTEGER NOT NULL,
    type       TEXT NOT NULL,
    data_json  TEXT
  ) STRICT;
  CREATE INDEX lesson_events_lesson ON lesson_events(lesson_id, id);

  -- Every overlay version is kept; at most one is active per role and scope.
  CREATE TABLE overlays (
    id               TEXT PRIMARY KEY,
    role             TEXT NOT NULL,
    scope            TEXT NOT NULL,
    version          INTEGER NOT NULL,
    status           TEXT NOT NULL,
    content          TEXT NOT NULL,
    lesson_ids_json  TEXT NOT NULL,
    parent_id        TEXT,
    eval_json        TEXT,
    created_at       INTEGER NOT NULL,
    activated_at     INTEGER,
    updated_at       INTEGER NOT NULL,
    UNIQUE (role, scope, version)
  ) STRICT;
  CREATE INDEX overlays_role ON overlays(role, scope, status);

  -- Replay evaluations and live regression checks, one row each.
  CREATE TABLE eval_runs (
    id             TEXT PRIMARY KEY,
    overlay_id     TEXT NOT NULL REFERENCES overlays(id),
    kind           TEXT NOT NULL,
    suite_id       TEXT,
    cases          INTEGER,
    baseline_json  TEXT,
    metrics_json   TEXT NOT NULL,
    decision       TEXT NOT NULL,
    detail_json    TEXT,
    created_at     INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX eval_runs_overlay ON eval_runs(overlay_id, created_at);
  `,
];
