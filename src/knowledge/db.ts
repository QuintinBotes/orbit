import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { OrbitDb } from '../storage/db.ts';
import { suppressSqliteExperimentalWarning } from '../core/warnings.ts';
import { OrbitError } from '../core/errors.ts';
import { KNOWLEDGE_MIGRATIONS } from './schema.ts';

const require = createRequire(import.meta.url);

/**
 * Open a knowledge graph file with the same pragmas and transaction semantics
 * as storage/db.ts openDb, but its own migration list. openDb always applies
 * run-state migrations, which do not belong in a knowledge file (the global
 * graph in particular has no runs).
 */
export function openKnowledgeDb(path: string, options: { busyTimeoutMs?: number } = {}): OrbitDb {
  suppressSqliteExperimentalWarning();
  const { DatabaseSync: Database } = require('node:sqlite') as typeof import('node:sqlite');
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec(`PRAGMA busy_timeout = ${Math.trunc(options.busyTimeoutMs ?? 10_000)}`);
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = FULL');
  migrate(db);

  let depth = 0;
  let savepoint = 0;

  return {
    path,
    raw: db,
    tx<T>(fn: () => T): T {
      if (depth > 0) {
        const name = `sp_${++savepoint}`;
        db.exec(`SAVEPOINT ${name}`);
        depth++;
        try {
          const result = fn();
          db.exec(`RELEASE ${name}`);
          return result;
        } catch (err) {
          db.exec(`ROLLBACK TO ${name}`);
          db.exec(`RELEASE ${name}`);
          throw err;
        } finally {
          depth--;
        }
      }
      db.exec('BEGIN IMMEDIATE');
      depth = 1;
      try {
        const result = fn();
        if (result instanceof Promise) {
          throw new Error('knowledge tx callback returned a Promise; transactions must be synchronous');
        }
        db.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* already rolled back by SQLite */
        }
        throw err;
      } finally {
        depth = 0;
      }
    },
    get<T>(sql: string, ...params: SQLInputValue[]) {
      return db.prepare(sql).get(...params) as T | undefined;
    },
    all<T>(sql: string, ...params: SQLInputValue[]) {
      return db.prepare(sql).all(...params) as T[];
    },
    run(sql: string, ...params: SQLInputValue[]) {
      const r = db.prepare(sql).run(...params);
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    },
    close() {
      db.close();
    },
  };
}

function migrate(db: DatabaseSync): void {
  const current = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  if (current > KNOWLEDGE_MIGRATIONS.length) {
    throw new OrbitError('INTERNAL', `knowledge graph is at schema version ${current}, newer than this Orbit (${KNOWLEDGE_MIGRATIONS.length}). Upgrade Orbit.`);
  }
  for (let v = current; v < KNOWLEDGE_MIGRATIONS.length; v++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(KNOWLEDGE_MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
