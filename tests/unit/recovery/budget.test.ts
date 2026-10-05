import { describe, expect, it } from 'vitest';
import { acquireLease, getRun } from '../../../src/controller/run-store.ts';
import { enterRecovery, spendRecoveryAttempt } from '../../../src/recovery/budget.ts';
import { counters, eventTypes, makeRun, setup } from './helpers.ts';

describe('enterRecovery', () => {
  it('moves a working run to RECOVERING, remembering the stage to resume, and spends one recovery attempt', () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    counters(db, 'r1', { recovery_attempts: 3 });
    const out = enterRecovery(db, clock, { runId: 'r1', ownerId: 'ctl-1', reason: 'crash' });
    expect(out.outcome).toBe('recovering');
    const run = getRun(db, 'r1');
    expect(run.state).toBe('RECOVERING');
    expect(run.resumeState).toBe('IMPLEMENTING');
    expect(db.get<{ used: number }>("SELECT used FROM budget_counters WHERE run_id = 'r1' AND counter = 'recovery_attempts'")?.used).toBe(1);
    expect(eventTypes(db, 'r1')).toContain('recovery.attempt');
  });

  it('a crash during recovery spends another attempt but keeps the original resume stage', () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    counters(db, 'r1', { recovery_attempts: 3 });
    enterRecovery(db, clock, { runId: 'r1', ownerId: 'ctl-1', reason: 'crash' });
    const again = enterRecovery(db, clock, { runId: 'r1', ownerId: 'ctl-1', reason: 'crash again' });
    expect(again.outcome).toBe('already-recovering');
    expect(getRun(db, 'r1').resumeState).toBe('IMPLEMENTING');
    expect(db.get<{ used: number }>("SELECT used FROM budget_counters WHERE run_id = 'r1' AND counter = 'recovery_attempts'")?.used).toBe(2);
  });

  it('is unlimited nowhere: the budget spent, the run ends EXHAUSTED instead of looping', () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    counters(db, 'r1', { recovery_attempts: 2 });
    expect(enterRecovery(db, clock, { runId: 'r1', ownerId: 'ctl-1', reason: 'crash 1' }).outcome).toBe('recovering');
    expect(enterRecovery(db, clock, { runId: 'r1', ownerId: 'ctl-1', reason: 'crash 2' }).outcome).toBe('already-recovering');
    const third = enterRecovery(db, clock, { runId: 'r1', ownerId: 'ctl-1', reason: 'crash 3' });
    expect(third.outcome).toBe('exhausted');
    const run = getRun(db, 'r1');
    expect(run.state).toBe('EXHAUSTED');
    expect(run.outcomeReason).toMatch(/recovery budget exhausted/);
    expect(db.get<{ used: number }>("SELECT used FROM budget_counters WHERE run_id = 'r1' AND counter = 'recovery_attempts'")?.used).toBe(2);
  });

  it('bounds recovery by recorded attempts while the run has no budget counters yet', () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1', ['PREFLIGHT']);
    for (let i = 0; i < 2; i++) expect(enterRecovery(db, clock, { runId: 'r1', ownerId: 'ctl-1', reason: 'crash', fallbackMax: 2 }).outcome).not.toBe('exhausted');
    expect(enterRecovery(db, clock, { runId: 'r1', ownerId: 'ctl-1', reason: 'crash', fallbackMax: 2 }).outcome).toBe('exhausted');
  });

  it('spends through the controller\'s ledger when one is supplied', () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    const spent: string[] = [];
    enterRecovery(db, clock, { runId: 'r1', ownerId: 'ctl-1', reason: 'crash', ledgerFor: () => ({ consume: (c, n) => spent.push(`${c}:${n}`) }) });
    expect(spent).toEqual(['recovery_attempts:1']);
  });

  it('refuses to act for a controller that does not hold the lease, and leaves the run alone', () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    expect(() => enterRecovery(db, clock, { runId: 'r1', ownerId: 'ctl-2', reason: 'crash' })).toThrow(/does not hold the lease/);
    expect(getRun(db, 'r1').state).toBe('IMPLEMENTING');
  });

  it('does nothing for a new run, a terminal run, or a run with a durable cancellation request', () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'new', 'ctl-1', []);
    expect(enterRecovery(db, clock, { runId: 'new', ownerId: 'ctl-1', reason: 'x' }).outcome).toBe('not-applicable');
    makeRun(db, clock, 'cx', 'ctl-1');
    db.run('UPDATE runs SET cancel_requested = 1 WHERE id = ?', 'cx');
    expect(enterRecovery(db, clock, { runId: 'cx', ownerId: 'ctl-1', reason: 'x' }).outcome).toBe('cancel-pending');
    expect(getRun(db, 'cx').state).toBe('IMPLEMENTING');
    makeRun(db, clock, 'done', 'ctl-1', ['PREFLIGHT', 'BLOCKED']);
    acquireLease(db, 'done', 'ctl-1', 1000, clock);
    expect(enterRecovery(db, clock, { runId: 'done', ownerId: 'ctl-1', reason: 'x' }).outcome).toBe('not-applicable');
  });
});

describe('spendRecoveryAttempt', () => {
  it('records the refusal as a budget.exhausted event with the counter state', () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    counters(db, 'r1', { recovery_attempts: 1 });
    spendRecoveryAttempt(db, 'r1', clock, { actor: 'ctl-1', why: 'one' });
    expect(() => spendRecoveryAttempt(db, 'r1', clock, { actor: 'ctl-1', why: 'two' })).toThrow(/recovery_attempts exhausted/);
    const ev = db.get<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = 'r1' AND type = 'budget.exhausted'");
    expect(JSON.parse(ev!.data_json)).toMatchObject({ counter: 'recovery_attempts', used: 1, allowance: 1 });
  });
});
