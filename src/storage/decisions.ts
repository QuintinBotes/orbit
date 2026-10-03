import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { OrbitDb } from './db.ts';
import type { Clock } from '../core/clock.ts';
import { OrbitError } from '../core/errors.ts';
import { appendJsonl } from '../core/fsx.ts';
import { canonicalJson } from '../core/hash.ts';
import { newId } from '../core/ids.ts';
import { appendEvent } from './events.ts';

/**
 * Decision records: every model choice, allowance extension, inquisition
 * resolution, policy denial and the like (spec §16), with the evidence that
 * justified it.
 *
 * The decisions table is the authority. `<runDir>/decisions.jsonl` is an
 * append-only mirror for people and reports, written after the row commits:
 * a crash in between leaves the row without its line, never a line without a
 * row, and `syncDecisionsMirror` (or simply recording the same id again)
 * appends what is missing. Lines therefore appear in append order, which can
 * differ from created_at order after a repair.
 */

export const DECISIONS_FILE = 'decisions.jsonl';

export interface DecisionRecord {
  id: string;
  runId: string;
  /** e.g. 'route', 'allowance.extend', 'inquisition.resolve', 'policy.deny'. */
  kind: string;
  summary: string;
  data: unknown;
  createdAt: number;
}

export interface NewDecision {
  /** Supply one to make recording idempotent across retries. */
  id?: string;
  runId: string;
  kind: string;
  summary: string;
  data?: unknown;
}

/** Shape of one decisions.jsonl line; snake_case like the other run artifacts. */
export interface DecisionLine {
  id: string;
  run_id: string;
  kind: string;
  summary: string;
  data: unknown;
  created_at: number;
}

interface DecisionRow {
  id: string;
  run_id: string;
  kind: string;
  summary: string;
  data_json: string | null;
  created_at: number;
}

function toRecord(r: DecisionRow): DecisionRecord {
  return { id: r.id, runId: r.run_id, kind: r.kind, summary: r.summary, data: r.data_json === null ? null : JSON.parse(r.data_json), createdAt: r.created_at };
}

function toLine(d: DecisionRecord): DecisionLine {
  return { id: d.id, run_id: d.runId, kind: d.kind, summary: d.summary, data: d.data, created_at: d.createdAt };
}

export function decisionsPath(runDir: string): string {
  return join(runDir, DECISIONS_FILE);
}

/**
 * Insert the decision (and a `decision.recorded` event) in one transaction,
 * then append it to the run's decisions.jsonl. Recording an id that already
 * exists with the same content returns the stored record and only repairs the
 * mirror; different content under that id is rejected.
 *
 * Refused inside an enclosing `db.tx`: there the line would be appended
 * before the outer transaction commits, and a rollback would leave a line
 * with no row.
 */
export function recordDecision(db: OrbitDb, runDir: string, input: NewDecision, clock: Clock, opts: { actor?: string } = {}): DecisionRecord {
  assertNoTransaction(db, 'recordDecision');
  if (!input.kind || !input.summary) throw new OrbitError('INTERNAL', 'a decision needs a kind and a summary');
  const id = input.id ?? newId('dec');
  const dataJson = input.data === undefined ? null : JSON.stringify(input.data);
  const now = clock.now();

  const { record, fresh } = db.tx(() => {
    const existing = db.get<DecisionRow>('SELECT * FROM decisions WHERE id = ?', id);
    if (existing) {
      const same =
        existing.run_id === input.runId &&
        existing.kind === input.kind &&
        existing.summary === input.summary &&
        canonicalJson(existing.data_json === null ? null : JSON.parse(existing.data_json)) === canonicalJson(dataJson === null ? null : JSON.parse(dataJson));
      if (!same) throw new OrbitError('CONCURRENT_UPDATE', `decision ${id} already exists with different content`, { decisionId: id });
      return { record: toRecord(existing), fresh: false };
    }
    if (!db.get('SELECT 1 AS x FROM runs WHERE id = ?', input.runId)) throw new OrbitError('NOT_FOUND', `no run ${input.runId}`);
    db.run('INSERT INTO decisions (id, run_id, kind, summary, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, input.runId, input.kind, input.summary, dataJson, now);
    appendEvent(db, input.runId, 'decision.recorded', opts.actor ?? 'controller', { decision_id: id, kind: input.kind }, now);
    return { record: toRecord(db.get<DecisionRow>('SELECT * FROM decisions WHERE id = ?', id)!), fresh: true };
  });

  try {
    if (fresh || !mirroredIds(runDir).has(id)) appendLine(runDir, record);
  } catch (err) {
    // The row is durable; the caller can retry with this id or run syncDecisionsMirror.
    throw new OrbitError('INTERNAL', `decision ${id} was recorded but ${DECISIONS_FILE} could not be appended: ${(err as Error).message}`, { decisionId: id, runDir }, { cause: err });
  }
  return record;
}

export function getDecision(db: OrbitDb, id: string): DecisionRecord | null {
  const row = db.get<DecisionRow>('SELECT * FROM decisions WHERE id = ?', id);
  return row ? toRecord(row) : null;
}

/** A run's decisions in the order they were made. */
export function listDecisions(db: OrbitDb, runId: string, opts: { kind?: string; limit?: number } = {}): DecisionRecord[] {
  const limit = opts.limit ?? -1;
  const rows =
    opts.kind === undefined
      ? db.all<DecisionRow>('SELECT * FROM decisions WHERE run_id = ? ORDER BY created_at, rowid LIMIT ?', runId, limit)
      : db.all<DecisionRow>('SELECT * FROM decisions WHERE run_id = ? AND kind = ? ORDER BY created_at, rowid LIMIT ?', runId, opts.kind, limit);
  return rows.map(toRecord);
}

/**
 * Parse decisions.jsonl, skipping lines that are not valid JSON. The mirror is
 * not the authority, and such a line can only be a fragment torn by a crash
 * mid-append (or a hand edit); the row it belonged to is re-appended by sync.
 */
export function readDecisionsMirror(runDir: string): DecisionLine[] {
  const path = decisionsPath(runDir);
  if (!existsSync(path)) return [];
  const out: DecisionLine[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as DecisionLine;
      if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string') out.push(parsed);
    } catch {
      /* torn fragment */
    }
  }
  return out;
}

/** Append every decision row missing from the mirror. Returns how many lines were added. Refused inside a transaction. */
export function syncDecisionsMirror(db: OrbitDb, runDir: string, runId: string): number {
  // Inside a transaction it could mirror rows that are then rolled back.
  assertNoTransaction(db, 'syncDecisionsMirror');
  const have = mirroredIds(runDir);
  let added = 0;
  for (const d of listDecisions(db, runId)) {
    if (have.has(d.id)) continue;
    appendLine(runDir, d);
    added++;
  }
  return added;
}

function assertNoTransaction(db: OrbitDb, fn: string): void {
  // node:sqlite reports this from 22.16; on older Nodes it is undefined and
  // the check is skipped, leaving the documented precondition.
  if (db.raw.isTransaction === true) {
    throw new OrbitError('INTERNAL', `${fn} must run outside a transaction: ${DECISIONS_FILE} is written only for committed rows`);
  }
}

function appendLine(runDir: string, d: DecisionRecord): void {
  const path = decisionsPath(runDir);
  // A fragment left by a crash mid-append has no newline; without this the
  // next record would be glued onto it and lost to readers as well.
  if (existsSync(path)) {
    const fd = openSync(path, 'a+');
    try {
      const size = fstatSync(fd).size;
      const last = Buffer.alloc(1);
      if (size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a) writeSync(fd, '\n');
    } finally {
      closeSync(fd);
    }
  }
  appendJsonl(path, toLine(d));
}

function mirroredIds(runDir: string): Set<string> {
  return new Set(readDecisionsMirror(runDir).map((l) => l.id));
}
