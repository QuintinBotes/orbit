import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../../../src/core/clock.ts';
import { isOrbitError } from '../../../src/core/errors.ts';
import { createRun } from '../../../src/controller/run-store.ts';
import { openDb, type OrbitDb } from '../../../src/storage/db.ts';
import { decisionsPath, getDecision, listDecisions, readDecisionsMirror, recordDecision, syncDecisionsMirror } from '../../../src/storage/decisions.ts';

let dir: string;
let runDir: string;
let db: OrbitDb;
let clock: ManualClock;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orbit-dec-'));
  runDir = join(dir, '.orbit', 'runs', 'r1');
  db = openDb(':memory:');
  clock = new ManualClock();
  createRun(db, { id: 'r1', repoRoot: dir, goal: 'g', mode: 'autonomous', policyHash: 'sha256:x', policyPath: '/p' }, clock);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const lines = () =>
  readFileSync(decisionsPath(runDir), 'utf8')
    .split('\n')
    .filter((l) => l !== '');

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return isOrbitError(err) ? err.code : `non-orbit: ${String(err)}`;
  }
  return undefined;
}

describe('recordDecision', () => {
  it('writes the row, a decision.recorded event and one mirror line', () => {
    const d = recordDecision(db, runDir, { runId: 'r1', kind: 'route', summary: 'low-cost route for a simple change', data: { model: 'model-x', reason: ['simple'] } }, clock);
    expect(d).toMatchObject({ runId: 'r1', kind: 'route', summary: 'low-cost route for a simple change', data: { model: 'model-x', reason: ['simple'] }, createdAt: clock.now() });
    expect(d.id).toMatch(/^dec-[0-9a-f]{12}$/);
    expect(getDecision(db, d.id)).toEqual(d);
    const ev = db.get<{ actor: string; data_json: string }>("SELECT actor, data_json FROM events WHERE type = 'decision.recorded'")!;
    expect(ev.actor).toBe('controller');
    expect(JSON.parse(ev.data_json)).toEqual({ decision_id: d.id, kind: 'route' });
    expect(lines().map((l) => JSON.parse(l))).toEqual([{ id: d.id, run_id: 'r1', kind: 'route', summary: 'low-cost route for a simple change', data: { model: 'model-x', reason: ['simple'] }, created_at: clock.now() }]);
  });

  it('stores absent data as null and keeps the given actor', () => {
    const d = recordDecision(db, runDir, { id: 'dec-a', runId: 'r1', kind: 'policy.deny', summary: 'push to main denied' }, clock, { actor: 'guard' });
    expect(d.data).toBeNull();
    expect(db.get<{ actor: string }>("SELECT actor FROM events WHERE type = 'decision.recorded'")!.actor).toBe('guard');
  });

  it('is idempotent for a repeated id with the same content, even with keys in another order', () => {
    const input = { id: 'dec-1', runId: 'r1', kind: 'allowance.extend', summary: 'one more attempt', data: { a: 1, b: { c: 2 } } };
    const first = recordDecision(db, runDir, input, clock);
    clock.advance(1_000);
    const again = recordDecision(db, runDir, { ...input, data: { b: { c: 2 }, a: 1 } }, clock);
    expect(again).toEqual(first);
    expect(listDecisions(db, 'r1')).toHaveLength(1);
    expect(lines()).toHaveLength(1);
    expect(db.all("SELECT 1 FROM events WHERE type = 'decision.recorded'")).toHaveLength(1);
  });

  it('rejects different content under an existing id', () => {
    recordDecision(db, runDir, { id: 'dec-1', runId: 'r1', kind: 'k', summary: 's' }, clock);
    expect(codeOf(() => recordDecision(db, runDir, { id: 'dec-1', runId: 'r1', kind: 'k', summary: 'other' }, clock))).toBe('CONCURRENT_UPDATE');
    expect(codeOf(() => recordDecision(db, runDir, { id: 'dec-1', runId: 'r1', kind: 'k', summary: 's', data: 1 }, clock))).toBe('CONCURRENT_UPDATE');
    expect(lines()).toHaveLength(1);
  });

  it('rejects an unknown run and an empty kind or summary without writing anything', () => {
    expect(codeOf(() => recordDecision(db, runDir, { runId: 'nope', kind: 'k', summary: 's' }, clock))).toBe('NOT_FOUND');
    expect(codeOf(() => recordDecision(db, runDir, { runId: 'r1', kind: '', summary: 's' }, clock))).toBe('INTERNAL');
    expect(codeOf(() => recordDecision(db, runDir, { runId: 'r1', kind: 'k', summary: '' }, clock))).toBe('INTERNAL');
    expect(readDecisionsMirror(runDir)).toEqual([]);
    expect(db.all('SELECT 1 FROM decisions')).toHaveLength(0);
  });

  it('keeps the row when the mirror cannot be written, and repairs it on retry with the same id', () => {
    mkdirSync(join(dir, '.orbit', 'runs'), { recursive: true });
    writeFileSync(runDir, 'a file where the run directory should be');
    const input = { id: 'dec-9', runId: 'r1', kind: 'k', summary: 's' };
    let err: unknown;
    try {
      recordDecision(db, runDir, input, clock);
    } catch (e) {
      err = e;
    }
    expect(isOrbitError(err, 'INTERNAL')).toBe(true);
    expect((err as { details: Record<string, unknown> }).details.decisionId).toBe('dec-9');
    expect(getDecision(db, 'dec-9')).not.toBeNull();

    rmSync(runDir);
    recordDecision(db, runDir, input, clock);
    expect(lines().map((l) => (JSON.parse(l) as { id: string }).id)).toEqual(['dec-9']);
    expect(listDecisions(db, 'r1')).toHaveLength(1);
  });

  it('starts a new line after a fragment torn by a crash mid-append', () => {
    recordDecision(db, runDir, { id: 'dec-1', runId: 'r1', kind: 'k', summary: 'one' }, clock);
    appendFileSync(decisionsPath(runDir), '{"id":"dec-torn","run_');
    recordDecision(db, runDir, { id: 'dec-2', runId: 'r1', kind: 'k', summary: 'two' }, clock);
    expect(readDecisionsMirror(runDir).map((l) => l.id)).toEqual(['dec-1', 'dec-2']);
    expect(lines()).toHaveLength(3);
  });
});

describe('listDecisions', () => {
  it('returns the decisions of a run in the order made, filtered by kind, limited', () => {
    createRun(db, { id: 'r2', repoRoot: dir, goal: 'g', mode: 'autonomous', policyHash: 'sha256:x', policyPath: '/p' }, clock);
    recordDecision(db, runDir, { id: 'a', runId: 'r1', kind: 'route', summary: '1' }, clock);
    recordDecision(db, runDir, { id: 'b', runId: 'r1', kind: 'inquisition.resolve', summary: '2' }, clock);
    clock.advance(1);
    recordDecision(db, runDir, { id: 'c', runId: 'r1', kind: 'route', summary: '3' }, clock);
    recordDecision(db, join(dir, 'other'), { id: 'z', runId: 'r2', kind: 'route', summary: 'other run' }, clock);
    expect(listDecisions(db, 'r1').map((d) => d.id)).toEqual(['a', 'b', 'c']);
    expect(listDecisions(db, 'r1', { kind: 'route' }).map((d) => d.id)).toEqual(['a', 'c']);
    expect(listDecisions(db, 'r1', { limit: 2 }).map((d) => d.id)).toEqual(['a', 'b']);
    expect(listDecisions(db, 'nope')).toEqual([]);
    expect(getDecision(db, 'nope')).toBeNull();
  });
});

describe('syncDecisionsMirror and readDecisionsMirror', () => {
  it('rebuilds a lost mirror from the rows and is a no-op once complete', () => {
    for (const id of ['a', 'b', 'c']) recordDecision(db, runDir, { id, runId: 'r1', kind: 'k', summary: id }, clock);
    rmSync(decisionsPath(runDir));
    expect(readDecisionsMirror(runDir)).toEqual([]);
    expect(syncDecisionsMirror(db, runDir, 'r1')).toBe(3);
    expect(readDecisionsMirror(runDir).map((l) => l.id)).toEqual(['a', 'b', 'c']);
    expect(syncDecisionsMirror(db, runDir, 'r1')).toBe(0);
  });

  it('appends only the rows the mirror is missing', () => {
    recordDecision(db, runDir, { id: 'a', runId: 'r1', kind: 'k', summary: 'a' }, clock);
    db.run("INSERT INTO decisions (id, run_id, kind, summary, data_json, created_at) VALUES ('b', 'r1', 'k', 'b', '{\"x\":1}', 1)");
    expect(syncDecisionsMirror(db, runDir, 'r1')).toBe(1);
    expect(readDecisionsMirror(runDir)).toEqual([
      expect.objectContaining({ id: 'a' }),
      { id: 'b', run_id: 'r1', kind: 'k', summary: 'b', data: { x: 1 }, created_at: 1 },
    ]);
  });

  it('skips malformed lines and blank lines', () => {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(decisionsPath(runDir), '\n{"id":"ok","run_id":"r1","kind":"k","summary":"s","data":null,"created_at":1}\nnot json\n[1,2]\n{"no_id":true}\n\n');
    expect(readDecisionsMirror(runDir).map((l) => l.id)).toEqual(['ok']);
  });
});

describe('adversarial review', () => {
  it('refuses to record inside an enclosing transaction, where a rollback would leave a mirror line with no row', () => {
    let inner: unknown;
    expect(() =>
      db.tx(() => {
        try {
          recordDecision(db, runDir, { id: 'dec-in-tx', runId: 'r1', kind: 'k', summary: 's' }, clock);
        } catch (err) {
          inner = err;
        }
        throw new Error('lease check failed afterwards');
      }),
    ).toThrow('lease check failed afterwards');
    expect(isOrbitError(inner, 'INTERNAL')).toBe(true);
    expect(getDecision(db, 'dec-in-tx')).toBeNull();
    expect(readDecisionsMirror(runDir)).toEqual([]);
  });

  it('refuses to sync the mirror inside a transaction, which could see rows that then roll back', () => {
    expect(() =>
      db.tx(() => {
        db.run("INSERT INTO decisions (id, run_id, kind, summary, data_json, created_at) VALUES ('ghost', 'r1', 'k', 's', NULL, 1)");
        syncDecisionsMirror(db, runDir, 'r1');
      }),
    ).toThrow(/transaction/);
    expect(getDecision(db, 'ghost')).toBeNull();
    expect(readDecisionsMirror(runDir)).toEqual([]);
  });

  it('works again outside the transaction', () => {
    expect(recordDecision(db, runDir, { id: 'dec-ok', runId: 'r1', kind: 'k', summary: 's' }, clock).id).toBe('dec-ok');
    expect(readDecisionsMirror(runDir).map((l) => l.id)).toEqual(['dec-ok']);
  });
});
