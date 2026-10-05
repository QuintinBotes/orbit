import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type OrbitDb } from '../../../src/storage/db.ts';
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

const T1 = 'CREATE TABLE t1 (id INTEGER PRIMARY KEY, v TEXT)';
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
