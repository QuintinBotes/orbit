import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../../../src/core/clock.ts';
import { OrbitError } from '../../../src/core/errors.ts';
import { resetFaults } from '../../../src/core/faults.ts';
import { createRun, requestCancel } from '../../../src/controller/run-store.ts';
import { openDb, type OrbitDb } from '../../../src/storage/db.ts';
import { ACTION_STATES, ActionLedger, isDefinitiveFailure, type ActionInput } from '../../../src/delivery/actions.ts';

const allow = { allowed: true, rule: 'test', reason: 'ok' } as const;

let dir: string;
let db: OrbitDb;
let clock: ManualClock;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orbit-actions-'));
  db = openDb(':memory:');
  clock = new ManualClock();
  createRun(db, { id: 'r1', repoRoot: dir, goal: 'g', mode: 'autonomous-delivery', policyHash: 'sha256:x', policyPath: join(dir, 'p.json') }, clock);
});

afterEach(() => {
  delete process.env.ORBIT_FAULTS;
  resetFaults();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function input(over: Partial<ActionInput> = {}): ActionInput {
  return { runId: 'r1', kind: 'pr_create', idempotencyKey: 'k1', target: { head: 'orbit/r1' }, ...over };
}

function ledger(opts: ConstructorParameters<typeof ActionLedger>[2] = {}): ActionLedger {
  return new ActionLedger(db, clock, { backoffMs: () => 5, ...opts });
}

describe('ActionLedger.performAction', () => {
  it('persists intent, executes and stores the receipt', async () => {
    const l = ledger();
    let calls = 0;
    const r = await l.performAction(input(), { execute: async () => ({ n: ++calls }), reconcile: async () => null }, { authorization: allow });
    expect(r.outcome).toBe('executed');
    expect(r.receipt).toEqual({ n: 1 });
    expect(r.action.state).toBe('SUCCEEDED');
    expect(r.action.attempts).toBe(1);
    const events = db.all<{ type: string }>("SELECT type FROM events WHERE type LIKE 'action.%' ORDER BY id").map((e) => e.type);
    expect(events).toEqual(['action.intent', 'action.executing', 'action.succeeded']);
  });

  it('exports the state list for other modules', () => {
    expect(ACTION_STATES).toEqual(['INTENT', 'EXECUTING', 'SUCCEEDED', 'UNKNOWN', 'FAILED']);
  });

  it('never executes a finished action twice and never duplicates its row', async () => {
    const l = ledger();
    let calls = 0;
    const h = { execute: async () => ({ n: ++calls }), reconcile: async () => null };
    await l.performAction(input(), h, { authorization: allow });
    const again = await ledger().performAction(input(), h, { authorization: allow });
    expect(again.outcome).toBe('already-done');
    expect(again.receipt).toEqual({ n: 1 });
    expect(calls).toBe(1);
    expect(db.all('SELECT id FROM actions')).toHaveLength(1);
  });

  it('refuses an unauthorized action before persisting anything', async () => {
    const l = ledger();
    await expect(
      l.performAction(input(), { execute: async () => 1, reconcile: async () => null }, { authorization: { allowed: false, rule: 'actions.push_task_branch', reason: 'nope' } }),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(db.all('SELECT id FROM actions')).toHaveLength(0);
    expect(db.get("SELECT 1 AS x FROM events WHERE type = 'action.denied'")).toBeTruthy();
  });

  it('runs the precheck before the intent is persisted', async () => {
    const l = ledger();
    await expect(
      l.performAction(input(), { execute: async () => 1, reconcile: async () => null }, {
        authorization: allow,
        precheck: () => {
          throw new OrbitError('STALE_EVIDENCE', 'stale');
        },
      }),
    ).rejects.toMatchObject({ code: 'STALE_EVIDENCE' });
    expect(db.all('SELECT id FROM actions')).toHaveLength(0);
  });

  it('re-runs the precheck before a retry, so evidence that went stale blocks it', async () => {
    const l = ledger();
    let checks = 0;
    let executes = 0;
    await expect(
      l.performAction(input(), {
        execute: async () => {
          executes++;
          throw new OrbitError('PROVIDER_TRANSIENT', 'boom');
        },
        reconcile: async () => null,
      }, {
        authorization: allow,
        precheck: () => {
          if (++checks >= 3) throw new OrbitError('STALE_EVIDENCE', 'went stale');
        },
      }),
    ).rejects.toMatchObject({ code: 'STALE_EVIDENCE' });
    expect(executes).toBe(1);
  });

  it('after an error, reconciles BEFORE retrying and adopts what the remote already has', async () => {
    const l = ledger();
    const order: string[] = [];
    const r = await l.performAction(input(), {
      execute: async () => {
        order.push('execute');
        throw new OrbitError('PROVIDER_TRANSIENT', 'connection reset');
      },
      reconcile: async () => {
        order.push('reconcile');
        return { url: 'found' };
      },
    }, { authorization: allow });
    expect(order).toEqual(['execute', 'reconcile']);
    expect(r.outcome).toBe('reconciled');
    expect(r.receipt).toEqual({ url: 'found' });
    expect(r.action.attempts).toBe(1);
  });

  it('retries only when the remote shows the action is absent, and sleeps between attempts', async () => {
    const l = ledger({ backoffMs: () => 250 });
    const order: string[] = [];
    let n = 0;
    const t0 = clock.now();
    const r = await l.performAction(input(), {
      execute: async () => {
        order.push('execute');
        if (++n === 1) throw new OrbitError('PROVIDER_TRANSIENT', 'flaky');
        return { ok: true };
      },
      reconcile: async () => {
        order.push('reconcile');
        return null;
      },
    }, { authorization: allow });
    expect(order).toEqual(['execute', 'reconcile', 'execute']);
    expect(r.outcome).toBe('executed');
    expect(r.action.attempts).toBe(2);
    expect(clock.now() - t0).toBe(250);
  });

  it('honours a retry-after hint larger than the backoff', async () => {
    const l = ledger({ backoffMs: () => 10 });
    let n = 0;
    const t0 = clock.now();
    await l.performAction(input(), {
      execute: async () => {
        if (++n === 1) throw new OrbitError('PROVIDER_TRANSIENT', 'rate limited', { retryAfterMs: 4000 });
        return 1;
      },
      reconcile: async () => null,
    }, { authorization: allow });
    expect(clock.now() - t0).toBe(4000);
  });

  it('bounds attempts, leaves the action UNKNOWN, and still reconciles on later calls', async () => {
    const l = ledger({ maxAttempts: 2 });
    let executes = 0;
    const failing = {
      execute: async () => {
        executes++;
        throw new OrbitError('PROVIDER_TRANSIENT', 'down');
      },
      reconcile: async () => null,
    };
    await expect(l.performAction(input(), failing, { authorization: allow })).rejects.toMatchObject({ code: 'DELIVERY_FAILED' });
    expect(executes).toBe(2);
    expect(l.find('k1')).toMatchObject({ state: 'UNKNOWN', attempts: 2 });

    // A later call (even a new ledger) does not execute again, but it does look at the remote.
    await expect(ledger({ maxAttempts: 2 }).performAction(input(), failing, { authorization: allow })).rejects.toMatchObject({ code: 'DELIVERY_FAILED' });
    expect(executes).toBe(2);

    const late = await ledger({ maxAttempts: 2 }).performAction(input(), { execute: async (): Promise<unknown> => 'never', reconcile: async (): Promise<unknown> => ({ landed: true }) }, { authorization: allow });
    expect(late.outcome).toBe('reconciled');
    expect(late.action.state).toBe('SUCCEEDED');
  });

  it('records a definitive failure as FAILED and does not retry it', async () => {
    const l = ledger();
    let executes = 0;
    let reconciles = 0;
    await expect(
      l.performAction(input(), {
        execute: async () => {
          executes++;
          throw new OrbitError('AUTH_EXPIRED', 'HTTP 401: Bad credentials ghp_abcdefghijklmnopqrstuvwxyz0123456789');
        },
        reconcile: async () => {
          reconciles++;
          return null;
        },
      }, { authorization: allow }),
    ).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
    expect(executes).toBe(1);
    expect(reconciles).toBe(0);
    const row = l.find('k1')!;
    expect(row.state).toBe('FAILED');
    expect(row.error).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('after a FAILED action, a later call reconciles first and then retries within the budget', async () => {
    const l = ledger();
    await expect(
      l.performAction(input(), { execute: async () => { throw new OrbitError('AUTH_EXPIRED', 'expired'); }, reconcile: async () => null }, { authorization: allow }),
    ).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
    const order: string[] = [];
    const r = await ledger().performAction(input(), {
      execute: async () => {
        order.push('execute');
        return { ok: 1 };
      },
      reconcile: async () => {
        order.push('reconcile');
        return null;
      },
    }, { authorization: allow });
    expect(order).toEqual(['reconcile', 'execute']);
    expect(r.action.attempts).toBe(2);
  });

  it('resolves an action left EXECUTING by a crash through reconcile, not a blind retry', async () => {
    const l = ledger();
    const { action } = l.recordIntent(input());
    l.markExecuting(action); // the old controller died right here
    const fresh = ledger(); // a restarted controller
    let executes = 0;
    const r = await fresh.performAction(input(), { execute: async (): Promise<unknown> => { executes++; return 1; }, reconcile: async (): Promise<unknown> => ({ found: 1 }) }, { authorization: allow });
    expect(executes).toBe(0);
    expect(r.outcome).toBe('reconciled');
    expect(db.all('SELECT id FROM actions')).toHaveLength(1);
  });

  it('a failing reconcile leaves the action UNKNOWN and executes nothing', async () => {
    const l = ledger();
    const { action } = l.recordIntent(input());
    l.markExecuting(action);
    let executes = 0;
    await expect(
      ledger().performAction(input(), { execute: async () => { executes++; return 1; }, reconcile: async () => { throw new OrbitError('PROVIDER_TRANSIENT', 'cannot read'); } }, { authorization: allow }),
    ).rejects.toMatchObject({ code: 'PROVIDER_TRANSIENT' });
    expect(executes).toBe(0);
    expect(l.find('k1')!.state).toBe('UNKNOWN');
  });

  it('refuses a key reused for a different action', async () => {
    const l = ledger();
    l.recordIntent(input());
    expect(() => l.recordIntent(input({ target: { head: 'orbit/other' } }))).toThrow(expect.objectContaining({ code: 'CONCURRENT_UPDATE' }));
    expect(() => l.recordIntent(input({ kind: 'push' }))).toThrow(expect.objectContaining({ code: 'CONCURRENT_UPDATE' }));
  });

  it('does not start a new action after a durable cancellation', async () => {
    const l = ledger();
    requestCancel(db, 'r1', 'test', clock);
    let executes = 0;
    await expect(l.performAction(input(), { execute: async () => { executes++; return 1; }, reconcile: async () => null }, { authorization: allow })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(executes).toBe(0);
  });

  it('only one of two executors can start the same attempt', () => {
    const a = ledger();
    const b = ledger();
    const { action } = a.recordIntent(input());
    a.markExecuting(action);
    expect(() => b.markExecuting(action)).toThrow(expect.objectContaining({ code: 'CONCURRENT_UPDATE' }));
  });

  it('honours the lose-response fault after execute: the receipt is discarded and reconcile decides', async () => {
    process.env.ORBIT_FAULTS = 'delivery.pr_create.after-execute=lose-response';
    resetFaults();
    const l = ledger();
    let executes = 0;
    const remote: unknown[] = [];
    const r = await l.performAction(input(), {
      execute: async () => {
        executes++;
        remote.push({ pr: 1 });
        return { pr: 1 };
      },
      reconcile: async () => (remote[0] as { pr: number } | undefined) ?? null,
    }, { authorization: allow });
    expect(executes).toBe(1);
    expect(remote).toHaveLength(1);
    expect(r.outcome).toBe('reconciled');
    expect(r.action.attempts).toBe(1);
  });

  it('a thrown fault before execute behaves like a crash: EXECUTING, reconciled on the next call', async () => {
    process.env.ORBIT_FAULTS = 'delivery.pr_create.before-execute=throw';
    resetFaults();
    const l = ledger();
    let executes = 0;
    const h = { execute: async () => { executes++; return { pr: 1 }; }, reconcile: async () => null };
    await expect(l.performAction(input(), h, { authorization: allow })).rejects.toThrow(/fault injected/);
    expect(l.find('k1')).toMatchObject({ state: 'EXECUTING', attempts: 1 });
    const r = await ledger().performAction(input(), h, { authorization: allow });
    expect(executes).toBe(1);
    expect(r.action.attempts).toBe(2);
  });

  it('records each reconciliation as a decision when given a run directory', async () => {
    const l = ledger({ runDir: dir });
    await l.performAction(input(), { execute: async () => { throw new OrbitError('PROVIDER_TRANSIENT', 'x'); }, reconcile: async () => ({ ok: 1 }) }, { authorization: allow });
    const lines = readFileSync(join(dir, 'decisions.jsonl'), 'utf8').trim().split('\n').map((s) => JSON.parse(s) as { kind: string; data: { found: boolean } });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: 'action.reconcile', data: { found: true } });
  });

  it('rejects a nonsensical attempt budget', () => {
    expect(() => ledger({ maxAttempts: 0 })).toThrow(/maxAttempts/);
  });
});

describe('isDefinitiveFailure', () => {
  it('treats refusals as definitive and transport errors as uncertain', () => {
    expect(isDefinitiveFailure(new OrbitError('AUTH_EXPIRED', 'x'))).toBe(true);
    expect(isDefinitiveFailure(new OrbitError('GIT_FAILED', 'rejected', { definitive: true }))).toBe(true);
    expect(isDefinitiveFailure(new OrbitError('GIT_FAILED', 'unknown'))).toBe(false);
    expect(isDefinitiveFailure(new OrbitError('PROVIDER_TRANSIENT', 'x'))).toBe(false);
    expect(isDefinitiveFailure(new Error('plain'))).toBe(false);
  });
});

describe('ActionLedger: reconciliation after a transient failure', () => {
  it('waits out the retry-after hint BEFORE the reconciling read, not only before the retry', async () => {
    const l = ledger({ backoffMs: () => 10 });
    const t0 = clock.now();
    const reconcileAt: number[] = [];
    let n = 0;
    await l.performAction(input(), {
      execute: async () => {
        if (++n === 1) throw new OrbitError('PROVIDER_TRANSIENT', 'rate limited', { retryAfterMs: 4000 });
        return 1;
      },
      reconcile: async () => {
        reconcileAt.push(clock.now() - t0);
        return null;
      },
    }, { authorization: allow });
    // A read sent straight into a rate limit would fail and abort; it goes after the wait.
    expect(reconcileAt).toEqual([4000]);
  });
});
