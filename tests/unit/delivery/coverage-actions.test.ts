import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRun } from '../../../src/controller/run-store.ts';
import { ManualClock } from '../../../src/core/clock.ts';
import { OrbitError } from '../../../src/core/errors.ts';
import { openDb, type OrbitDb } from '../../../src/storage/db.ts';
import { ActionLedger, type ActionInput } from '../../../src/delivery/actions.ts';

const allow = { allowed: true, rule: 'test', reason: 'ok' } as const;

let dir: string;
let db: OrbitDb;
let clock: ManualClock;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orbit-actions-cov-'));
  db = openDb(':memory:');
  clock = new ManualClock();
  createRun(db, { id: 'r1', repoRoot: dir, goal: 'g', mode: 'autonomous-delivery', policyHash: 'sha256:x', policyPath: join(dir, 'p.json') }, clock);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const input = (over: Partial<ActionInput> = {}): ActionInput => ({ runId: 'r1', kind: 'pr_create', idempotencyKey: 'k1', target: { head: 'orbit/r1' }, ...over });

describe('ActionLedger lookups and receipts', () => {
  it('get refuses an id that has no row', () => {
    expect(() => new ActionLedger(db, clock).get('act-nope')).toThrow(expect.objectContaining({ code: 'NOT_FOUND', message: 'no action act-nope' }));
  });

  it('stores an absent receipt as JSON null and reads it back as null', () => {
    const l = new ActionLedger(db, clock);
    const { action } = l.recordIntent(input());
    const done = l.recordReceipt(l.markExecuting(action), undefined, 'execute');
    expect(done.state).toBe('SUCCEEDED');
    expect(done.receipt).toBeNull();
    expect(db.get<{ receipt_json: string }>('SELECT receipt_json FROM actions WHERE id = ?', done.id)!.receipt_json).toBe('null');
  });
});

describe('ActionLedger default backoff', () => {
  it('waits 500 ms, then 1000 ms, between attempts when no backoff is configured, and records plain error text', async () => {
    const l = new ActionLedger(db, clock, { maxAttempts: 3 });
    const failures: unknown[] = [new Error('socket hang up'), 'plain string failure'];
    const slept: number[] = [];
    const real = clock.sleep.bind(clock);
    clock.sleep = async (ms: number) => {
      slept.push(ms);
      await real(ms);
    };
    const r = await l.performAction(
      input(),
      {
        execute: async () => {
          const next = failures.shift();
          if (next !== undefined) throw next;
          return { ok: true };
        },
        reconcile: async () => null,
      },
      { authorization: allow },
    );
    expect(r.receipt).toEqual({ ok: true });
    expect(r.action.attempts).toBe(3);
    expect(slept).toEqual([500, 1000]);
    const unknownEvents = db.all<{ data_json: string }>("SELECT data_json FROM events WHERE type = 'action.unknown' ORDER BY id").map((e) => (JSON.parse(e.data_json) as { error: string }).error);
    expect(unknownEvents).toEqual(['socket hang up', 'plain string failure']);
  });

  it('caps the default backoff at 30 seconds', async () => {
    const l = new ActionLedger(db, clock, { maxAttempts: 12 });
    const slept: number[] = [];
    const real = clock.sleep.bind(clock);
    clock.sleep = async (ms: number) => {
      slept.push(ms);
      await real(ms);
    };
    await expect(l.performAction(input(), { execute: async () => Promise.reject(new Error('down')), reconcile: async () => null }, { authorization: allow })).rejects.toMatchObject({ code: 'DELIVERY_FAILED' });
    expect(slept[0]).toBe(500);
    expect(Math.max(...slept)).toBe(30_000);
    expect(slept.every((ms) => ms <= 30_000)).toBe(true);
  });

  it('prefers a longer retry-after hint over the backoff', async () => {
    const l = new ActionLedger(db, clock, { backoffMs: () => 10 });
    const slept: number[] = [];
    const real = clock.sleep.bind(clock);
    clock.sleep = async (ms: number) => {
      slept.push(ms);
      await real(ms);
    };
    let first = true;
    await l.performAction(
      input(),
      {
        execute: async () => {
          if (first) {
            first = false;
            throw new OrbitError('PROVIDER_TRANSIENT', 'rate limited', { retryAfterMs: 7000 });
          }
          return 1;
        },
        reconcile: async () => null,
      },
      { authorization: allow },
    );
    expect(slept).toEqual([7000]);
  });
});
