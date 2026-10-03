import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/storage/db.ts';
import { ManualClock } from '../../src/core/clock.ts';
import { acquireLease, createRun, getRun, renewLease, requestCancel, transition } from '../../src/controller/run-store.ts';

function setup() {
  const db = openDb(':memory:');
  const clock = new ManualClock();
  createRun(db, { id: 'r1', repoRoot: '/repo', goal: 'g', mode: 'autonomous', policyHash: 'sha256:x', policyPath: '/p' }, clock);
  return { db, clock };
}

describe('run store foundation', () => {
  it('requires the lease and appends an event per transition', () => {
    const { db, clock } = setup();
    expect(() => transition(db, { runId: 'r1', to: 'PREFLIGHT', ownerId: 'a', reason: 'start' }, clock)).toThrow(/lease/);
    expect(acquireLease(db, 'r1', 'a', 30_000, clock)).not.toBeNull();
    expect(acquireLease(db, 'r1', 'b', 30_000, clock)).toBeNull();
    transition(db, { runId: 'r1', to: 'PREFLIGHT', ownerId: 'a', reason: 'start' }, clock);
    expect(getRun(db, 'r1').state).toBe('PREFLIGHT');
    expect(() => transition(db, { runId: 'r1', to: 'DELIVERING', ownerId: 'a', reason: 'skip' }, clock)).toThrow(/not an allowed/);
    const events = db.all<{ type: string }>('SELECT type FROM events WHERE run_id = ?', 'r1').map((e) => e.type);
    expect(events).toEqual(['run.created', 'lease.acquired', 'state.transition']);
  });

  it('lets another owner take over only after expiry, and the old owner then fails', () => {
    const { db, clock } = setup();
    acquireLease(db, 'r1', 'a', 1_000, clock);
    clock.advance(1_001);
    expect(acquireLease(db, 'r1', 'b', 1_000, clock)).not.toBeNull();
    expect(renewLease(db, 'r1', 'a', 1_000, clock)).toBe(false);
    expect(() => transition(db, { runId: 'r1', to: 'PREFLIGHT', ownerId: 'a', reason: 'x' }, clock)).toThrow(/lease/);
  });

  it('remembers the interrupted stage and blocks everything but CANCELLED after cancel', () => {
    const { db, clock } = setup();
    acquireLease(db, 'r1', 'a', 30_000, clock);
    for (const to of ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'INQUISITION'] as const) transition(db, { runId: 'r1', to, ownerId: 'a', reason: to }, clock);
    expect(getRun(db, 'r1').resumeState).toBe('PLANNING');
    transition(db, { runId: 'r1', to: 'PLANNING', ownerId: 'a', reason: 'resolved' }, clock);
    expect(getRun(db, 'r1').resumeState).toBeNull();
    requestCancel(db, 'r1', 'cli', clock);
    expect(() => transition(db, { runId: 'r1', to: 'IMPLEMENTING', ownerId: 'a', reason: 'x' }, clock)).toThrow(/cancellation/);
    expect(transition(db, { runId: 'r1', to: 'CANCELLED', ownerId: 'a', reason: 'cancel' }, clock).state).toBe('CANCELLED');
  });

  it('rolls back the whole transaction on error', () => {
    const { db } = setup();
    expect(() => db.tx(() => { db.run("UPDATE runs SET goal = 'changed' WHERE id = 'r1'"); throw new Error('boom'); })).toThrow('boom');
    expect(getRun(db, 'r1').goal).toBe('g');
  });
});
