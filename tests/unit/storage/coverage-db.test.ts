import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OrbitError } from '../../../src/core/errors.ts';
import { migrate, openDb, type OrbitDb } from '../../../src/storage/db.ts';
import { appendEvent } from '../../../src/storage/events.ts';
import { MIGRATIONS } from '../../../src/storage/schema.ts';

let dir: string;
const open: OrbitDb[] = [];
const track = (db: OrbitDb): OrbitDb => {
  open.push(db);
  return db;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orbit-db-cov-'));
});
afterEach(() => {
  for (const db of open.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

const T1 = 'CREATE TABLE t1 (id INTEGER PRIMARY KEY, v TEXT); CREATE TABLE leases (run_id TEXT, owner_id TEXT, expires_at INTEGER)';

/** `db`'s connection, with `other` run once just before its first BEGIN IMMEDIATE: a second opener that wins the race. */
function racedBy(db: OrbitDb, other: () => void): { db: OrbitDb['raw']; raced: () => boolean } {
  let raced = false;
  const racing = new Proxy(db.raw, {
    get(target, key) {
      if (key === 'exec') {
        return (sql: string) => {
          if (sql === 'BEGIN IMMEDIATE' && !raced) {
            raced = true;
            other();
          }
          return target.exec(sql);
        };
      }
      const v = Reflect.get(target, key, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return { db: racing, raced: () => raced };
}
const T2 = 'CREATE TABLE t2 (id INTEGER PRIMARY KEY, v TEXT)';

describe('openDb', () => {
  it('creates missing parent directories, uses WAL for files and enforces foreign keys', () => {
    const path = join(dir, 'nested', 'deeper', 'orbit.db');
    const db = track(openDb(path, { migrations: [T1] }));
    expect(existsSync(path)).toBe(true);
    expect((db.get('PRAGMA journal_mode') as { journal_mode: string }).journal_mode).toBe('wal');
    expect((db.get('PRAGMA foreign_keys') as { foreign_keys: number }).foreign_keys).toBe(1);
    expect((db.get('PRAGMA synchronous') as { synchronous: number }).synchronous).toBe(2);
    expect(db.path).toBe(path);
  });

  it('keeps an in-memory database in memory and applies the busy timeout, truncating fractions', () => {
    const db = track(openDb(':memory:', { busyTimeoutMs: 1234.9, migrations: [] }));
    expect((db.get('PRAGMA busy_timeout') as { timeout: number }).timeout).toBe(1234);
    expect((db.get('PRAGMA journal_mode') as { journal_mode: string }).journal_mode).toBe('memory');
  });

  it('applies the real migrations by default and records the schema version', () => {
    const db = track(openDb(':memory:'));
    expect((db.get('PRAGMA user_version') as { user_version: number }).user_version).toBe(MIGRATIONS.length);
    expect(db.get('SELECT name FROM sqlite_master WHERE name = ?', 'runs')).toBeDefined();
  });
});

describe('migrations', () => {
  it('refuses to migrate while any lease is unexpired and names every run and owner', () => {
    const path = join(dir, 'leased.db');
    const old = openDb(path, { migrations: MIGRATIONS.slice(0, 5) });
    const now = Date.now();
    for (const [id, owner] of [['r1', 'owner-one'], ['r2', 'owner-two']] as const) {
      old.run('INSERT INTO runs (id, repo_root, goal, mode, state, policy_hash, policy_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', id, '/repo', 'g', 'supervised', 'IMPLEMENTING', 'h', '/p', now, now);
      old.run('INSERT INTO leases (run_id, owner_id, acquired_at, heartbeat_at, expires_at) VALUES (?, ?, ?, ?, ?)', id, owner, now, now, now + 60_000);
    }
    old.close();

    let error: unknown;
    try {
      track(openDb(path));
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(OrbitError);
    expect(error).toMatchObject({
      code: 'CONCURRENT_UPDATE',
      message: 'Cannot migrate the state database while an older Orbit is driving these runs: r1 (owner owner-one), r2 (owner owner-two). Let the runs finish, stop them, or use that same Orbit version until their leases end.',
    });

    const unchanged = track(openDb(path, { migrations: MIGRATIONS.slice(0, 5) }));
    expect((unchanged.get('PRAGMA user_version') as { user_version: number }).user_version).toBe(5);
    expect(unchanged.all('SELECT run_id, owner_id, expires_at FROM leases ORDER BY run_id')).toEqual([
      { run_id: 'r1', owner_id: 'owner-one', expires_at: now + 60_000 },
      { run_id: 'r2', owner_id: 'owner-two', expires_at: now + 60_000 },
    ]);
  });

  it('migration 8 keeps the route outcomes an older state database holds and adds what issue #168 records', () => {
    const path = join(dir, 'outcomes.db');
    const old = openDb(path, { migrations: MIGRATIONS.slice(0, 7) });
    old.run("INSERT INTO runs (id, repo_root, goal, mode, state, policy_hash, policy_path, created_at, updated_at) VALUES ('r1', '/repo', 'g', 'supervised', 'SUCCEEDED', 'h', '/p', 1, 1)");
    old.run("INSERT INTO route_outcomes (run_id, work_kind, provider, model_id, outcome, cost_usd, tokens, ts) VALUES ('r1', 'routine-code', 'claude', 'm', 'verified', 0.5, 10, 5)");
    old.run("INSERT INTO route_outcomes (run_id, work_kind, provider, model_id, outcome, cost_usd, tokens, ts) VALUES ('r1', 'routine-code', 'claude', 'm', 'failed', NULL, NULL, 6)");
    old.close();

    const db = track(openDb(path));
    expect((db.get('PRAGMA user_version') as { user_version: number }).user_version).toBe(MIGRATIONS.length);
    // The old rows load with the new fields empty, and two rows without an attempt key do not collide.
    expect(db.all('SELECT outcome, cost_usd, role, effort, difficulty, attempt_key, evidence_ref FROM route_outcomes ORDER BY id')).toEqual([
      { outcome: 'verified', cost_usd: 0.5, role: null, effort: null, difficulty: null, attempt_key: null, evidence_ref: null },
      { outcome: 'failed', cost_usd: null, role: null, effort: null, difficulty: null, attempt_key: null, evidence_ref: null },
    ]);
    // One outcome per attempt of a run is the database's rule too, not only the recorder's.
    const insert = "INSERT INTO route_outcomes (run_id, work_kind, provider, model_id, outcome, ts, attempt_key) VALUES ('r1', 'routine-code', 'claude', 'm', 'verified', 7, 'cand-1')";
    db.run(insert);
    expect(() => db.run(insert)).toThrow(/UNIQUE/);
  });

  it.each([-60_000, 0])('migrates with a lease that expired %i ms from now', (offset) => {
    const path = join(dir, 'expired.db');
    const old = openDb(path, { migrations: MIGRATIONS.slice(0, 5) });
    const now = Date.now();
    old.run("INSERT INTO runs (id, repo_root, goal, mode, state, policy_hash, policy_path, created_at, updated_at) VALUES ('r1', '/repo', 'g', 'supervised', 'IMPLEMENTING', 'h', '/p', 1, 1)");
    old.run('INSERT INTO leases (run_id, owner_id, acquired_at, heartbeat_at, expires_at) VALUES (?, ?, ?, ?, ?)', 'r1', 'crashed-owner', now - 120_000, now - 120_000, now + offset);
    old.close();

    const db = track(openDb(path));
    expect((db.get('PRAGMA user_version') as { user_version: number }).user_version).toBe(MIGRATIONS.length);
    expect(db.get('SELECT owner_id FROM leases WHERE run_id = ?', 'r1')).toEqual({ owner_id: 'crashed-owner' });
  });

  it('runs only the migrations a database has not seen, in order', () => {
    const path = join(dir, 'm.db');
    const first = openDb(path, { migrations: [T1] });
    first.run('INSERT INTO t1 (v) VALUES (?)', 'kept');
    first.close();
    const second = track(openDb(path, { migrations: [T1, T2] }));
    expect((second.get('PRAGMA user_version') as { user_version: number }).user_version).toBe(2);
    expect(second.all('SELECT v FROM t1')).toEqual([{ v: 'kept' }]);
    expect(second.all('SELECT * FROM t2')).toEqual([]);
  });

  it('migration 4 adds runs.environment to a database at schema version 3 and keeps its runs', () => {
    const path = join(dir, 'v3.db');
    const old = openDb(path, { migrations: MIGRATIONS.slice(0, 3) });
    old.run("INSERT INTO runs (id, repo_root, goal, mode, state, policy_hash, policy_path, created_at, updated_at) VALUES ('r1', '/repo', 'g', 'release', 'CREATED', 'sha256:x', '/p', 1, 1)");
    expect((old.get('PRAGMA user_version') as { user_version: number }).user_version).toBe(3);
    expect(old.all<{ name: string }>('PRAGMA table_info(runs)').map((c) => c.name)).not.toContain('environment');
    old.close();
    const db = track(openDb(path));
    expect((db.get('PRAGMA user_version') as { user_version: number }).user_version).toBe(MIGRATIONS.length);
    expect(db.get('SELECT environment FROM runs WHERE id = ?', 'r1')).toEqual({ environment: null });
  });

  it('issue #190: an opener that another migrated past between reading the version and taking the write lock does not migrate again', () => {
    const path = join(dir, 'race.db');
    const ADD = 'ALTER TABLE t1 ADD COLUMN extra TEXT';
    // This opener read version 1; the other opener runs migration 2 just before this one's BEGIN IMMEDIATE.
    const slow = track(openDb(path, { migrations: [T1] }));
    const racing = racedBy(slow, () => openDb(path, { migrations: [T1, ADD] }).close());
    expect(() => migrate(racing.db, [T1, ADD])).not.toThrow();
    expect(racing.raced()).toBe(true);
    expect((slow.get('PRAGMA user_version') as { user_version: number }).user_version).toBe(2);
    expect(slow.all<{ name: string }>('PRAGMA table_info(t1)').map((c) => c.name)).toEqual(['id', 'v', 'extra']);
  });

  it('issue #190: an opener that a newer Orbit migrated past in that moment refuses the database, as it would have before', () => {
    const path = join(dir, 'race-newer.db');
    const slow = track(openDb(path, { migrations: [T1] }));
    const racing = racedBy(slow, () => openDb(path, { migrations: [T1, T2, 'CREATE TABLE t3 (id INTEGER PRIMARY KEY)'] }).close());
    expect(() => migrate(racing.db, [T1, T2])).toThrow('database is at schema version 3, newer than this Orbit (2). Upgrade Orbit.');
    expect((slow.get('PRAGMA user_version') as { user_version: number }).user_version).toBe(3);
  });

  it('refuses a database written by a newer Orbit and leaves it untouched', () => {
    const path = join(dir, 'newer.db');
    openDb(path, { migrations: [T1, T2] }).close();
    expect(() => openDb(path, { migrations: [T1] })).toThrow('database is at schema version 2, newer than this Orbit (1). Upgrade Orbit.');
    const again = track(openDb(path, { migrations: [T1, T2] }));
    expect((again.get('PRAGMA user_version') as { user_version: number }).user_version).toBe(2);
  });

  it('rolls a failing migration back completely, keeping the earlier version', () => {
    const path = join(dir, 'fail.db');
    expect(() => openDb(path, { migrations: [T1, `${T2}; THIS IS NOT SQL`] })).toThrow();
    const db = track(openDb(path, { migrations: [T1] }));
    expect((db.get('PRAGMA user_version') as { user_version: number }).user_version).toBe(1);
    expect(db.get('SELECT name FROM sqlite_master WHERE name = ?', 't2')).toBeUndefined();
  });
});

describe('tx', () => {
  const fresh = () => track(openDb(':memory:', { migrations: [T1] }));

  it('commits on success and returns the callback value', () => {
    const db = fresh();
    expect(db.tx(() => db.run('INSERT INTO t1 (v) VALUES (?)', 'a').lastInsertRowid)).toBe(1);
    expect(db.all('SELECT v FROM t1')).toEqual([{ v: 'a' }]);
  });

  it('rolls everything back when the callback throws, rethrowing the same error', () => {
    const db = fresh();
    const boom = new Error('boom');
    expect(() =>
      db.tx(() => {
        db.run('INSERT INTO t1 (v) VALUES (?)', 'lost');
        throw boom;
      }),
    ).toThrow(boom);
    expect(db.all('SELECT * FROM t1')).toEqual([]);
    // the connection is usable afterwards
    db.tx(() => db.run('INSERT INTO t1 (v) VALUES (?)', 'ok'));
    expect(db.all('SELECT v FROM t1')).toEqual([{ v: 'ok' }]);
  });

  it('refuses an asynchronous callback, rolling back what it wrote before returning the promise', () => {
    const db = fresh();
    expect(() =>
      db.tx((() => {
        db.run('INSERT INTO t1 (v) VALUES (?)', 'async');
        return Promise.resolve(1);
      }) as unknown as () => number),
    ).toThrow('OrbitDb.tx callback returned a Promise; transactions must be synchronous');
    expect(db.all('SELECT * FROM t1')).toEqual([]);
  });

  it('tolerates SQLite having already rolled the transaction back before the error reaches tx', () => {
    const db = fresh();
    expect(() =>
      db.tx(() => {
        db.raw.exec('ROLLBACK');
        throw new Error('after implicit rollback');
      }),
    ).toThrow('after implicit rollback');
    db.tx(() => db.run('INSERT INTO t1 (v) VALUES (?)', 'fine'));
    expect(db.all('SELECT v FROM t1')).toEqual([{ v: 'fine' }]);
  });

  it('nested calls are savepoints: an inner failure undoes only the inner work, and the outer can still commit', () => {
    const db = fresh();
    db.tx(() => {
      db.run('INSERT INTO t1 (v) VALUES (?)', 'outer');
      expect(() =>
        db.tx(() => {
          db.run('INSERT INTO t1 (v) VALUES (?)', 'inner-lost');
          throw new Error('inner');
        }),
      ).toThrow('inner');
      db.tx(() => db.run('INSERT INTO t1 (v) VALUES (?)', 'inner-kept'));
    });
    expect(db.all('SELECT v FROM t1 ORDER BY id')).toEqual([{ v: 'outer' }, { v: 'inner-kept' }]);
  });

  it('an inner failure that the outer callback does not catch rolls back everything', () => {
    const db = fresh();
    expect(() =>
      db.tx(() => {
        db.run('INSERT INTO t1 (v) VALUES (?)', 'outer');
        db.tx(() => {
          throw new Error('inner escapes');
        });
      }),
    ).toThrow('inner escapes');
    expect(db.all('SELECT * FROM t1')).toEqual([]);
  });

  it('a nested transaction deeper than one level still uses unique savepoint names', () => {
    const db = fresh();
    db.tx(() => {
      db.tx(() => {
        db.run('INSERT INTO t1 (v) VALUES (?)', 'a');
        db.tx(() => db.run('INSERT INTO t1 (v) VALUES (?)', 'b'));
      });
      db.tx(() => db.run('INSERT INTO t1 (v) VALUES (?)', 'c'));
    });
    expect(db.all('SELECT v FROM t1 ORDER BY id')).toEqual([{ v: 'a' }, { v: 'b' }, { v: 'c' }]);
  });
});

describe('statements', () => {
  it('get returns undefined for no row, all returns every row, run reports changes and the new id', () => {
    const db = track(openDb(':memory:', { migrations: [T1] }));
    expect(db.get('SELECT * FROM t1')).toBeUndefined();
    expect(db.run('INSERT INTO t1 (v) VALUES (?)', 'x')).toEqual({ changes: 1, lastInsertRowid: 1 });
    expect(db.run('INSERT INTO t1 (v) VALUES (?)', 'y')).toEqual({ changes: 1, lastInsertRowid: 2 });
    expect(db.run('UPDATE t1 SET v = ?', 'z')).toEqual({ changes: 2, lastInsertRowid: 2 });
    expect(db.all('SELECT v FROM t1 ORDER BY id')).toEqual([{ v: 'z' }, { v: 'z' }]);
    expect(db.get<{ v: string }>('SELECT v FROM t1 WHERE id = ?', 2)?.v).toBe('z');
    expect(db.run('DELETE FROM t1 WHERE id = ?', 99).changes).toBe(0);
  });
});

describe('appendEvent', () => {
  it('stores data as JSON, or NULL when there is none, with optional states', () => {
    const db = track(openDb(':memory:'));
    db.run(
      `INSERT INTO runs (id, repo_root, goal, mode, state, policy_hash, policy_path, created_at, updated_at) VALUES ('r1', '/repo', 'g', 'autonomous', 'CREATED', 'h', '/p', 1, 1)`,
    );
    appendEvent(db, 'r1', 'one', 'cli', { a: 1 }, 10, 'CREATED', 'PLANNING');
    appendEvent(db, 'r1', 'two', 'cli', undefined, 11);
    appendEvent(db, 'r1', 'three', 'cli', null, 12);
    appendEvent(db, 'r1', 'four', 'cli', 'text', 13);
    const rows = db.all<{ type: string; from_state: string | null; to_state: string | null; actor: string; data_json: string | null; ts: number }>(
      'SELECT type, from_state, to_state, actor, data_json, ts FROM events WHERE run_id = ? ORDER BY id',
      'r1',
    );
    expect(rows).toEqual([
      { type: 'one', from_state: 'CREATED', to_state: 'PLANNING', actor: 'cli', data_json: '{"a":1}', ts: 10 },
      { type: 'two', from_state: null, to_state: null, actor: 'cli', data_json: null, ts: 11 },
      { type: 'three', from_state: null, to_state: null, actor: 'cli', data_json: 'null', ts: 12 },
      { type: 'four', from_state: null, to_state: null, actor: 'cli', data_json: '"text"', ts: 13 },
    ]);
  });

  it('rejects an event for a run that does not exist (foreign key)', () => {
    const db = track(openDb(':memory:'));
    expect(() => appendEvent(db, 'ghost', 'x', 'cli', {}, 1)).toThrow(/FOREIGN KEY/i);
  });
});
