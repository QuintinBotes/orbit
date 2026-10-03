/**
 * Durable state. One SQLite file per repository (`.orbit/state.sqlite`),
 * WAL mode, every state change inside a BEGIN IMMEDIATE transaction.
 *
 * Migrations are append-only: never edit a shipped entry, add a new one.
 * PRAGMA user_version records how many have been applied.
 *
 * Conventions: times are epoch milliseconds (INTEGER); *_json columns hold
 * JSON text; enumerated columns are TEXT checked by the repositories, not by
 * CHECK constraints, so adding a value never needs a table rebuild.
 */
export const MIGRATIONS: readonly string[] = [
  /* 1: initial schema */ `
  CREATE TABLE runs (
    id                TEXT PRIMARY KEY,
    repo_root         TEXT NOT NULL,
    goal              TEXT NOT NULL,
    mode              TEXT NOT NULL,
    state             TEXT NOT NULL,
    resume_state      TEXT,
    contract_json     TEXT,
    contract_hash     TEXT,
    policy_hash       TEXT NOT NULL,
    policy_path       TEXT NOT NULL,
    base_revision     TEXT,
    base_tree         TEXT,
    branch            TEXT,
    worktree_path     TEXT,
    difficulty        TEXT,
    difficulty_json   TEXT,
    outcome_reason    TEXT,
    outcome_json      TEXT,
    paused            INTEGER NOT NULL DEFAULT 0,
    cancel_requested  INTEGER NOT NULL DEFAULT 0,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    started_at        INTEGER,
    ended_at          INTEGER,
    last_progress_at  INTEGER,
    version           INTEGER NOT NULL DEFAULT 0
  ) STRICT;
  CREATE INDEX runs_state ON runs(state);

  -- Append-only. Every state transition writes one row in the same transaction.
  CREATE TABLE events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      TEXT NOT NULL REFERENCES runs(id),
    ts          INTEGER NOT NULL,
    type        TEXT NOT NULL,
    from_state  TEXT,
    to_state    TEXT,
    actor       TEXT NOT NULL,
    data_json   TEXT
  ) STRICT;
  CREATE INDEX events_run ON events(run_id, id);

  -- One owner per run. A controller may act on a run only while it holds an unexpired lease.
  CREATE TABLE leases (
    run_id        TEXT PRIMARY KEY REFERENCES runs(id),
    owner_id      TEXT NOT NULL,
    acquired_at   INTEGER NOT NULL,
    heartbeat_at  INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL
  ) STRICT;

  -- Controller incarnations, for heartbeat publishing and the watchdog.
  CREATE TABLE controllers (
    id                TEXT PRIMARY KEY,
    pid               INTEGER NOT NULL,
    host              TEXT NOT NULL,
    proc_start        TEXT,
    mode              TEXT NOT NULL,
    started_at        INTEGER NOT NULL,
    heartbeat_at      INTEGER NOT NULL,
    last_progress_at  INTEGER,
    stopped_at        INTEGER,
    stop_reason       TEXT
  ) STRICT;

  -- A worker row is written (PLANNED) before the process is spawned, so a crash
  -- between spawn and bookkeeping is reconciled from the worker directory's pid file.
  CREATE TABLE workers (
    id                TEXT PRIMARY KEY,
    run_id            TEXT NOT NULL REFERENCES runs(id),
    role              TEXT NOT NULL,
    purpose           TEXT,
    provider          TEXT NOT NULL,
    model             TEXT,
    effort            TEXT,
    state             TEXT NOT NULL,
    attempt           INTEGER,
    candidate_id      TEXT,
    worker_dir        TEXT NOT NULL,
    cwd               TEXT NOT NULL,
    owned_paths_json  TEXT,
    pid               INTEGER,
    pgid              INTEGER,
    proc_start        TEXT,
    spawned_at        INTEGER,
    ended_at          INTEGER,
    exit_code         INTEGER,
    signal            TEXT,
    result_status     TEXT,
    result_json       TEXT,
    error             TEXT,
    restart_count     INTEGER NOT NULL DEFAULT 0,
    cancel_requested  INTEGER NOT NULL DEFAULT 0,
    created_at        INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX workers_run_state ON workers(run_id, state);

  -- A candidate is an exact tree. Evidence, reviews and delivery bind to tree_hash.
  CREATE TABLE candidates (
    id              TEXT PRIMARY KEY,
    run_id          TEXT NOT NULL REFERENCES runs(id),
    seq             INTEGER NOT NULL,
    attempt         INTEGER NOT NULL,
    worker_id       TEXT,
    commit_sha      TEXT NOT NULL,
    tree_hash       TEXT NOT NULL,
    parent_sha      TEXT NOT NULL,
    status          TEXT NOT NULL,
    diff_stat_json  TEXT,
    scope_json      TEXT,
    created_at      INTEGER NOT NULL,
    UNIQUE (run_id, seq)
  ) STRICT;

  CREATE TABLE check_runs (
    id                 TEXT PRIMARY KEY,
    run_id             TEXT NOT NULL REFERENCES runs(id),
    candidate_id       TEXT,
    check_id           TEXT NOT NULL,
    kind               TEXT NOT NULL,
    tree_hash          TEXT NOT NULL,
    check_config_hash  TEXT NOT NULL,
    policy_hash        TEXT NOT NULL,
    command_json       TEXT NOT NULL,
    cwd                TEXT NOT NULL,
    isolation          TEXT NOT NULL,
    status             TEXT NOT NULL,
    exit_code          INTEGER,
    timed_out          INTEGER NOT NULL DEFAULT 0,
    cancelled          INTEGER NOT NULL DEFAULT 0,
    flaky              INTEGER NOT NULL DEFAULT 0,
    rerun_of           TEXT,
    pid                INTEGER,
    log_path           TEXT,
    log_sha256         TEXT,
    fingerprint        TEXT,
    excerpt            TEXT,
    artifacts_json     TEXT,
    started_at         INTEGER NOT NULL,
    ended_at           INTEGER
  ) STRICT;
  CREATE INDEX check_runs_candidate ON check_runs(run_id, candidate_id, check_id);

  CREATE TABLE evidence_reports (
    id                  TEXT PRIMARY KEY,
    run_id              TEXT NOT NULL REFERENCES runs(id),
    candidate_id        TEXT NOT NULL,
    tree_hash           TEXT NOT NULL,
    check_config_hash   TEXT NOT NULL,
    policy_hash         TEXT NOT NULL,
    verdict             TEXT NOT NULL,
    report_json         TEXT NOT NULL,
    report_path         TEXT,
    created_at          INTEGER NOT NULL,
    invalidated_at      INTEGER,
    invalidated_reason  TEXT
  ) STRICT;

  CREATE TABLE reviews (
    id              TEXT PRIMARY KEY,
    run_id          TEXT NOT NULL REFERENCES runs(id),
    candidate_id    TEXT NOT NULL,
    tree_hash       TEXT NOT NULL,
    round           INTEGER NOT NULL,
    provider        TEXT NOT NULL,
    model           TEXT,
    worker_id       TEXT,
    verdict         TEXT NOT NULL,
    packet_sha256   TEXT,
    findings_json   TEXT,
    created_at      INTEGER NOT NULL,
    invalidated_at  INTEGER
  ) STRICT;

  CREATE TABLE findings (
    id                    TEXT PRIMARY KEY,
    run_id                TEXT NOT NULL REFERENCES runs(id),
    review_id             TEXT NOT NULL REFERENCES reviews(id),
    external_id           TEXT,
    severity              TEXT NOT NULL,
    category              TEXT,
    location              TEXT,
    claim                 TEXT NOT NULL,
    evidence              TEXT,
    suggested_validation  TEXT,
    status                TEXT NOT NULL,
    resolution            TEXT,
    resolution_json       TEXT,
    created_at            INTEGER NOT NULL,
    updated_at            INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE decisions (
    id          TEXT PRIMARY KEY,
    run_id      TEXT NOT NULL REFERENCES runs(id),
    kind        TEXT NOT NULL,
    summary     TEXT NOT NULL,
    data_json   TEXT,
    created_at  INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX decisions_run ON decisions(run_id, created_at);

  CREATE TABLE questions (
    id              TEXT PRIMARY KEY,
    run_id          TEXT NOT NULL REFERENCES runs(id),
    mode            TEXT NOT NULL,
    question        TEXT NOT NULL,
    evidence        TEXT NOT NULL,
    options_json    TEXT NOT NULL,
    recommendation  TEXT,
    safe_default    TEXT,
    material        INTEGER NOT NULL,
    affected_json   TEXT,
    unblocked_json  TEXT,
    status          TEXT NOT NULL,
    answer          TEXT,
    answered_by     TEXT,
    answered_at     INTEGER,
    created_at      INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE ledger (
    id             TEXT PRIMARY KEY,
    run_id         TEXT NOT NULL REFERENCES runs(id),
    claim          TEXT NOT NULL,
    source         TEXT NOT NULL,
    confidence     TEXT NOT NULL,
    consequence    TEXT,
    reversibility  TEXT NOT NULL,
    experiment     TEXT,
    status         TEXT NOT NULL,
    evidence_json  TEXT,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE amendments (
    id                  TEXT PRIMARY KEY,
    run_id              TEXT NOT NULL REFERENCES runs(id),
    field               TEXT NOT NULL,
    old_json            TEXT,
    new_json            TEXT,
    evidence            TEXT NOT NULL,
    reason              TEXT NOT NULL,
    approval_required   INTEGER NOT NULL,
    approved_by         TEXT,
    affected_json       TEXT,
    status              TEXT NOT NULL,
    created_at          INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE hypotheses (
    id                    TEXT PRIMARY KEY,
    run_id                TEXT NOT NULL REFERENCES runs(id),
    statement             TEXT NOT NULL,
    normalized_hash       TEXT NOT NULL,
    experiment            TEXT,
    expected_observation  TEXT,
    status                TEXT NOT NULL,
    result                TEXT,
    created_at            INTEGER NOT NULL,
    updated_at            INTEGER NOT NULL
  ) STRICT;

  -- Failure fingerprints, compared across attempts for non-progress detection.
  CREATE TABLE failures (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id        TEXT NOT NULL REFERENCES runs(id),
    candidate_id  TEXT,
    source        TEXT NOT NULL,
    source_id     TEXT,
    fingerprint   TEXT NOT NULL,
    excerpt       TEXT,
    created_at    INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX failures_run ON failures(run_id, fingerprint);

  CREATE TABLE budget_counters (
    run_id     TEXT NOT NULL REFERENCES runs(id),
    counter    TEXT NOT NULL,
    used       REAL NOT NULL DEFAULT 0,
    allowance  REAL NOT NULL,
    hard_cap   REAL NOT NULL,
    PRIMARY KEY (run_id, counter)
  ) STRICT;

  CREATE TABLE usage (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id              TEXT NOT NULL REFERENCES runs(id),
    worker_id           TEXT,
    provider            TEXT NOT NULL,
    model               TEXT,
    input_tokens        INTEGER,
    output_tokens       INTEGER,
    cache_read_tokens   INTEGER,
    cache_write_tokens  INTEGER,
    cost_usd            REAL,
    cost_source         TEXT NOT NULL,
    duration_ms         INTEGER,
    ts                  INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX usage_run ON usage(run_id);

  -- External actions: intent is persisted before execution, a receipt after.
  -- idempotency_key is UNIQUE so a retried intent can never create a second action row.
  CREATE TABLE actions (
    id               TEXT PRIMARY KEY,
    run_id           TEXT NOT NULL REFERENCES runs(id),
    kind             TEXT NOT NULL,
    idempotency_key  TEXT NOT NULL UNIQUE,
    target_json      TEXT NOT NULL,
    candidate_id     TEXT,
    tree_hash        TEXT,
    commit_sha       TEXT,
    state            TEXT NOT NULL,
    attempts         INTEGER NOT NULL DEFAULT 0,
    receipt_json     TEXT,
    error            TEXT,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX actions_run ON actions(run_id, state);

  CREATE TABLE model_registry (
    model_id          TEXT PRIMARY KEY,
    provider          TEXT NOT NULL,
    family            TEXT,
    surfaces_json     TEXT NOT NULL,
    capabilities_json TEXT NOT NULL,
    limits_json       TEXT,
    pricing_json      TEXT,
    eligibility_json  TEXT,
    eval_json         TEXT,
    latency_ms        INTEGER,
    available         INTEGER NOT NULL DEFAULT 0,
    refreshed_at      INTEGER
  ) STRICT;

  -- Measured outcomes per route, the input to expected-cost routing.
  CREATE TABLE route_outcomes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      TEXT NOT NULL REFERENCES runs(id),
    work_kind   TEXT NOT NULL,
    provider    TEXT NOT NULL,
    model_id    TEXT NOT NULL,
    outcome     TEXT NOT NULL,
    cost_usd    REAL,
    tokens      INTEGER,
    ts          INTEGER NOT NULL
  ) STRICT;
  `,
];
