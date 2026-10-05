import { describe, expect, it } from 'vitest';
import { OrbitError } from '../../../src/core/errors.ts';
import type { OrbitDb } from '../../../src/storage/db.ts';
import { acquireLease, getRun, requestCancel, transition } from '../../../src/controller/run-store.ts';
import { appendEvent } from '../../../src/storage/events.ts';
import { enterRecovery, exhaustRecovery, recoveryAttemptsRemaining, spendRecoveryAttempt, type RecoveryLedger } from '../../../src/recovery/budget.ts';
import { blockRunOnCredentials, authBlocker, checkRunCredentials, credentialCheckDue, validateCredentials, CREDENTIALS_CHECKED_EVENT } from '../../../src/recovery/credentials.ts';
import { classifyFailure, decideRetry, type RetryContext } from '../../../src/recovery/backoff.ts';
import type { CredentialStatus, ProviderAdapter } from '../../../src/adapters/types.ts';
import { counters, eventTypes, makeRun, setup } from './helpers.ts';

function exhausted(): OrbitError {
  return new OrbitError('BUDGET_EXHAUSTED', 'no recovery left', { counter: 'recovery_attempts' });
}

describe('spendRecoveryAttempt through a ledger', () => {
  it('spends through the ledger and records one attempt event with the reason', () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    const spent: number[] = [];
    const ledger: RecoveryLedger = { consume: (_c, n) => void spent.push(n) };
    spendRecoveryAttempt(db, 'r1', clock, { ledgerFor: () => ledger, actor: 'ctl-1', why: 'crash' });
    expect(spent).toEqual([1]);
    expect(eventTypes(db, 'r1')).toContain('recovery.attempt');
  });

  it('rethrows a refusal that is not a spent budget and records nothing', () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    const boom = new Error('ledger unavailable');
    const ledger: RecoveryLedger = {
      consume: () => {
        throw boom;
      },
    };
    expect(() => spendRecoveryAttempt(db, 'r1', clock, { ledgerFor: () => ledger, actor: 'ctl-1', why: 'crash' })).toThrow(boom);
    expect(eventTypes(db, 'r1')).not.toContain('recovery.attempt');
  });

  it('throws the ledger BUDGET_EXHAUSTED after the transaction, without recording an attempt', () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    const ledger: RecoveryLedger = {
      consume: () => {
        throw exhausted();
      },
    };
    expect(() => spendRecoveryAttempt(db, 'r1', clock, { ledgerFor: () => ledger, actor: 'ctl-1', why: 'crash' })).toThrow(/no recovery left/);
    expect(eventTypes(db, 'r1')).not.toContain('recovery.attempt');
  });

  it('falls back to counting events when ledgerFor answers null, and records why the counter ran out', () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    spendRecoveryAttempt(db, 'r1', clock, { ledgerFor: () => null, fallbackMax: 1, actor: 'ctl-1', why: 'first' });
    expect(() => spendRecoveryAttempt(db, 'r1', clock, { ledgerFor: () => null, fallbackMax: 1, actor: 'ctl-1', why: 'second' })).toThrow(/exhausted at 1: used 1/);
    const ev = db.get<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = 'r1' AND type = 'budget.exhausted'");
    expect(JSON.parse(ev!.data_json)).toMatchObject({ counter: 'recovery_attempts', used: 1, allowance: 1, counted_from: 'events' });
  });

  it('uses the default fallback of three attempts when none is given', () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    for (let i = 0; i < 3; i++) spendRecoveryAttempt(db, 'r1', clock, { actor: 'ctl-1', why: `n${i}` });
    expect(() => spendRecoveryAttempt(db, 'r1', clock, { actor: 'ctl-1', why: 'n3' })).toThrow(/exhausted at 3/);
  });
});

describe('recoveryAttemptsRemaining', () => {
  it('reads the counter when it exists, never below zero', () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    counters(db, 'r1', { recovery_attempts: 3 });
    expect(recoveryAttemptsRemaining(db, 'r1', undefined)).toBe(3);
    db.run("UPDATE budget_counters SET used = 5 WHERE run_id = 'r1' AND counter = 'recovery_attempts'");
    expect(recoveryAttemptsRemaining(db, 'r1', undefined)).toBe(0);
  });

  it('without counters it is the fallback less the recorded attempts, defaulting to three', () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    expect(recoveryAttemptsRemaining(db, 'r1', undefined)).toBe(3);
    appendEvent(db, 'r1', 'recovery.attempt', 'ctl-1', {}, clock.now());
    expect(recoveryAttemptsRemaining(db, 'r1', undefined)).toBe(2);
    expect(recoveryAttemptsRemaining(db, 'r1', 1)).toBe(0);
    expect(recoveryAttemptsRemaining(db, 'r1', 0)).toBe(0);
  });
});

describe('exhaustRecovery', () => {
  it('ends a working run EXHAUSTED naming the counter and the reason', () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    const ended = exhaustRecovery(db, clock, { runId: 'r1', ownerId: 'ctl-1', why: 'worker w1 could not be restarted' });
    expect(ended?.state).toBe('EXHAUSTED');
    expect(ended?.outcomeReason).toBe('recovery_attempts exhausted: worker w1 could not be restarted');
    expect(JSON.parse(ended!.outcomeJson!)).toMatchObject({ state: 'EXHAUSTED', limit: 'recovery_attempts' });
  });

  it('does nothing for a run that already ended', () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    exhaustRecovery(db, clock, { runId: 'r1', ownerId: 'ctl-1', why: 'first' });
    expect(exhaustRecovery(db, clock, { runId: 'r1', ownerId: 'ctl-1', why: 'second' })).toBeNull();
    expect(getRun(db, 'r1').outcomeReason).toContain('first');
  });

  it('does nothing while a cancellation is pending: CANCELLED wins', () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    requestCancel(db, 'r1', 'user', clock);
    expect(exhaustRecovery(db, clock, { runId: 'r1', ownerId: 'ctl-1', why: 'x' })).toBeNull();
    expect(getRun(db, 'r1').state).toBe('IMPLEMENTING');
  });
});

describe('enterRecovery refusals', () => {
  it('has nothing to recover for a run that has not started working', () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1', []);
    const out = enterRecovery(db, clock, { runId: 'r1', ownerId: 'ctl-1', reason: 'crash' });
    expect(out.outcome).toBe('not-applicable');
    expect(getRun(db, 'r1').state).toBe('CREATED');
    expect(eventTypes(db, 'r1')).not.toContain('recovery.attempt');
  });

  it('records the caller\'s data on the transition into RECOVERING', () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    counters(db, 'r1', { recovery_attempts: 3 });
    enterRecovery(db, clock, { runId: 'r1', ownerId: 'ctl-1', reason: 'crash', data: { step: 'implement:1' } });
    const ev = db.get<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = 'r1' AND type = 'state.transition' AND to_state = 'RECOVERING'");
    expect(JSON.parse(ev!.data_json)).toMatchObject({ data: { step: 'implement:1' } });
  });

  it('a pending cancellation wins and spends no attempt', () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    counters(db, 'r1', { recovery_attempts: 3 });
    requestCancel(db, 'r1', 'user', clock);
    expect(enterRecovery(db, clock, { runId: 'r1', ownerId: 'ctl-1', reason: 'crash' }).outcome).toBe('cancel-pending');
    expect(db.get<{ used: number }>("SELECT used FROM budget_counters WHERE run_id = 'r1'")?.used).toBe(0);
  });

  it('a refusal by the ledger ends the run EXHAUSTED and records the budget event afresh', () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    const out = enterRecovery(db, clock, {
      runId: 'r1',
      ownerId: 'ctl-1',
      reason: 'crash',
      ledgerFor: () => ({
        consume: () => {
          throw exhausted();
        },
      }),
    });
    expect(out.outcome).toBe('exhausted');
    expect(getRun(db, 'r1').state).toBe('EXHAUSTED');
    expect(eventTypes(db, 'r1')).toContain('budget.exhausted');
  });

  it('rethrows a failure that is not a spent budget and leaves the run where it was', () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    const boom = new Error('ledger down');
    expect(() =>
      enterRecovery(db, clock, {
        runId: 'r1',
        ownerId: 'ctl-1',
        reason: 'crash',
        ledgerFor: () => ({
          consume: () => {
            throw boom;
          },
        }),
      }),
    ).toThrow(boom);
    expect(getRun(db, 'r1').state).toBe('IMPLEMENTING');
  });

  it('a cancellation that lands between the refusal and the exhaustion leaves the run alone', () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    // After the refused transaction rolls back, another process records a cancellation request.
    const racing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'tx') {
          return (fn: () => unknown) => {
            try {
              return target.tx(fn as never);
            } catch (err) {
              requestCancel(target, 'r1', 'user', clock);
              throw err;
            }
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as OrbitDb;
    const out = enterRecovery(racing, clock, {
      runId: 'r1',
      ownerId: 'ctl-1',
      reason: 'crash',
      ledgerFor: () => ({
        consume: () => {
          throw exhausted();
        },
      }),
    });
    expect(out.outcome).toBe('not-applicable');
    expect(getRun(db, 'r1').state).toBe('IMPLEMENTING');
  });
});

function adapterStub(state: CredentialStatus['state'], extra: Record<string, unknown> = {}): ProviderAdapter {
  return { id: 'x', validateCredentials: async () => ({ state, method: 'api_key', detail: 'd' }), ...extra } as unknown as ProviderAdapter;
}

describe('credential checks: edges', () => {
  it('reports a provider with no adapter as an error, not a block', async () => {
    const out = await validateCredentials({ providers: ['ghost', 'ghost'], adapters: {} });
    expect(out).toEqual([{ provider: 'ghost', verdict: 'error', status: null, live: false, error: 'no adapter for provider ghost' }]);
  });

  it('uses the live probe for listed providers and passes the timeout; falls back to the status query otherwise', async () => {
    const seen: unknown[] = [];
    const probed = adapterStub('expired', { probeCredentials: async (o: unknown) => (seen.push(o), { state: 'valid', method: 'oauth', detail: 'live' }) });
    const plain = adapterStub('valid');
    const out = await validateCredentials({ providers: ['claude', 'codex'], adapters: { claude: probed, codex: plain }, liveProviders: ['claude'], timeoutMs: 1234 });
    expect(seen).toEqual([{ timeoutMs: 1234 }]);
    expect(out.map((c) => [c.provider, c.verdict, c.live])).toEqual([
      ['claude', 'valid', true],
      ['codex', 'valid', false],
    ]);
    const noTimeout = await validateCredentials({ providers: ['claude'], adapters: { claude: probed }, live: true });
    expect(seen.at(-1)).toEqual({});
    expect(noTimeout[0]?.live).toBe(true);
  });

  it('a throwing adapter is an error with redacted text, not a block, and a non-Error is stringified', async () => {
    const thrower = (v: unknown) => adapterStub('valid', { validateCredentials: async () => Promise.reject(v) });
    const out = await validateCredentials({ providers: ['a', 'b'], adapters: { a: thrower(new Error('cli missing')), b: thrower('plain text failure') } });
    expect(out.map((c) => [c.verdict, c.error])).toEqual([
      ['error', 'cli missing'],
      ['error', 'plain text failure'],
    ]);
  });

  it('credentialCheckDue is true with no check yet, false inside the interval and true at its end', () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    expect(credentialCheckDue(db, 'r1', clock, 1000)).toBe(true);
    appendEvent(db, 'r1', CREDENTIALS_CHECKED_EVENT, 'ctl-1', {}, clock.now());
    clock.advance(999);
    expect(credentialCheckDue(db, 'r1', clock, 1000)).toBe(false);
    clock.advance(1);
    expect(credentialCheckDue(db, 'r1', clock, 1000)).toBe(true);
  });
});

describe('blockRunOnCredentials: states it will not block', () => {
  const blocker = authBlocker({ provider: 'claude', state: 'expired', runId: 'r1' });

  it('is already-blocked for the same provider and not-applicable for another blocker or an unreadable outcome', () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    expect(blockRunOnCredentials(db, clock, 'ctl-1', 'r1', blocker).outcome).toBe('blocked');
    expect(blockRunOnCredentials(db, clock, 'ctl-1', 'r1', blocker).outcome).toBe('already-blocked');
    expect(blockRunOnCredentials(db, clock, 'ctl-1', 'r1', authBlocker({ provider: 'codex', state: 'missing' })).outcome).toBe('not-applicable');
    db.run("UPDATE runs SET outcome_json = '{not json' WHERE id = 'r1'");
    expect(blockRunOnCredentials(db, clock, 'ctl-1', 'r1', blocker).outcome).toBe('not-applicable');
    db.run('UPDATE runs SET outcome_json = NULL WHERE id = ?', 'r1');
    expect(blockRunOnCredentials(db, clock, 'ctl-1', 'r1', blocker).outcome).toBe('not-applicable');
    db.run("UPDATE runs SET outcome_json = '{}' WHERE id = 'r1'");
    expect(blockRunOnCredentials(db, clock, 'ctl-1', 'r1', blocker).outcome).toBe('not-applicable');
  });

  it('is not-applicable for a run that already ended some other way', () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    transition(db, { runId: 'r1', to: 'EXHAUSTED', ownerId: 'ctl-1', reason: 'done', expectedFrom: 'IMPLEMENTING' }, clock);
    expect(blockRunOnCredentials(db, clock, 'ctl-1', 'r1', blocker).outcome).toBe('not-applicable');
    expect(getRun(db, 'r1').state).toBe('EXHAUSTED');
  });

  it('a pending cancellation wins over a block', () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    requestCancel(db, 'r1', 'user', clock);
    expect(blockRunOnCredentials(db, clock, 'ctl-1', 'r1', blocker).outcome).toBe('cancel-pending');
    expect(getRun(db, 'r1').state).toBe('IMPLEMENTING');
  });
});

describe('checkRunCredentials: who may block', () => {
  const expired = adapterStub('expired');

  it('reports without blocking when the caller does not hold the lease', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    clock.advance(120_000); // the lease of ctl-1 lapses
    acquireLease(db, 'r1', 'ctl-2', 60_000, clock);
    const rep = await checkRunCredentials({ db, clock, ownerId: 'ctl-1', runId: 'r1', providers: ['claude'], adapters: { claude: expired }, loginCommands: { claude: 'acme login' } });
    expect(rep.blocked).toMatchObject({ outcome: 'not-applicable', blocker: { command: 'acme login' } });
    expect(getRun(db, 'r1').state).toBe('IMPLEMENTING');
  });

  it('rethrows anything else that goes wrong while blocking', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    let calls = 0;
    const broken = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'tx') {
          return (fn: () => unknown) => {
            if (++calls === 2) throw new Error('disk full');
            return target.tx(fn as never);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as OrbitDb;
    await expect(checkRunCredentials({ db: broken, clock, ownerId: 'ctl-1', runId: 'r1', providers: ['claude'], adapters: { claude: expired } })).rejects.toThrow('disk full');
  });

  it('records the verdicts without blocking when a provider is merely unverified', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    const rep = await checkRunCredentials({ db, clock, ownerId: 'ctl-1', runId: 'r1', providers: ['claude'], adapters: { claude: adapterStub('unknown') } });
    expect(rep.blocked).toBeNull();
    expect(eventTypes(db, 'r1')).toContain(CREDENTIALS_CHECKED_EVENT);
  });
});

describe('backoff edges', () => {
  const base: RetryContext = { classification: { kind: 'transient', reason: 'r', retryAfterMs: null }, attempt: 1, infrastructureRetriesRemaining: 3, wallRemainingMs: null, costRemainingUsd: null };

  it('classifies a bare string failure by its text, and a null or empty one as unrecognised', () => {
    expect(classifyFailure({ error: 'HTTP 429 rate limit' }).kind).toBe('transient');
    expect(classifyFailure({ error: 'invalid api key' }).kind).toBe('authentication');
    expect(classifyFailure({ error: 42 }).reason).toBe('unrecognized failure');
    expect(classifyFailure({ error: '' }).kind).toBe('permanent');
  });

  it('the block text names a generic provider and the resume placeholder when none is known', () => {
    const d = decideRetry({ ...base, classification: { kind: 'authentication', reason: 'x', retryAfterMs: null } });
    expect(d.action).toBe('block');
    if (d.action === 'block') {
      expect(d.blocker.provider).toBe('the model provider');
      expect(d.blocker.message).toContain('orbit resume <run-id>');
    }
    const named = decideRetry({ ...base, provider: 'codex', runId: 'orb-1', classification: { kind: 'authentication', reason: 'x', retryAfterMs: null } });
    if (named.action === 'block') expect(named.blocker.message).toContain('orbit resume orb-1');
  });

  it('words the regeneration limit in the singular and the plural', () => {
    const malformed = { ...base, classification: { kind: 'malformed_output' as const, reason: 'm', retryAfterMs: null } };
    expect(decideRetry({ ...malformed, regenerationsUsed: 1, maxRegenerations: 1 })).toMatchObject({ action: 'stop', limit: 'regenerations', reason: 'output still malformed after 1 regeneration' });
    expect(decideRetry({ ...malformed, regenerationsUsed: 2, maxRegenerations: 2 })).toMatchObject({ reason: 'output still malformed after 2 regenerations' });
    expect(decideRetry({ ...malformed, regenerationsUsed: 0 })).toMatchObject({ action: 'regenerate', regeneration: 1, remaining: 1 });
  });
});
