import { describe, expect, it } from 'vitest';
import { openDb, type OrbitDb } from '../../../src/storage/db.ts';
import { ManualClock } from '../../../src/core/clock.ts';
import { createRun } from '../../../src/controller/run-store.ts';
import { sessionTurnCap } from '../../../src/controller/workers.ts';
import { decideTurnExtension, deriveTurnCap, percentile, reminderThreshold, successfulTurnHistory, turnCapBounds, turnCapFor, turnReminder, type TurnCapBounds } from '../../../src/scheduling/turn-cap.ts';

const bounds: TurnCapBounds = { floor: 8, ceiling: 25, default: 20, reminderFraction: 0.8 };

function config(turnCap?: { floor: number; ceiling: number; default: number; reminder_fraction: number }, hard = 30) {
  return { scheduler: { hard_limits: { worker_turns_per_session: hard }, ...(turnCap ? { turn_cap: turnCap } : {}) } } as never;
}

describe('deriveTurnCap (AC-1)', () => {
  it('is the 75th percentile of the history', () => {
    expect(percentile([10, 12, 14, 16], 0.75)).toBe(14);
    expect(deriveTurnCap([16, 10, 14, 12], bounds)).toBe(14);
  });
  it('is clamped to the floor and to the ceiling', () => {
    expect(deriveTurnCap([2, 3, 4], bounds)).toBe(8);
    expect(deriveTurnCap([29, 30, 30], bounds)).toBe(25);
  });
  it('yields the default without history', () => {
    expect(deriveTurnCap([], bounds)).toBe(20);
  });
  it('never exceeds the policy hard cap, even with a ceiling above it', () => {
    expect(turnCapBounds(config({ floor: 5, ceiling: 99, default: 99, reminder_fraction: 0.8 })).ceiling).toBe(30);
  });
  it('without a turn_cap section: floor 10, ceiling and default the hard cap, so a repository with no history runs as before', () => {
    expect(turnCapBounds(config())).toEqual({ floor: 10, ceiling: 30, default: 30, reminderFraction: 0.8 });
    expect(turnCapBounds(config(undefined, 6))).toEqual({ floor: 6, ceiling: 6, default: 6, reminderFraction: 0.8 });
  });
});

describe('turn history (AC-1)', () => {
  function seed(): OrbitDb {
    const db = openDb(':memory:');
    const clock = new ManualClock();
    for (const id of ['old', 'other', 'now']) {
      createRun(db, { id, repoRoot: id === 'other' ? '/repo/other' : '/repo/acme', goal: 'g', mode: 'autonomous', policyHash: 'sha256:x', policyPath: '/p' }, clock);
      db.run("UPDATE runs SET difficulty = 'medium' WHERE id = ?", id);
    }
    return db;
  }
  function worker(db: OrbitDb, id: string, runId: string, role: string, status: string, requests: number): void {
    db.run(
      `INSERT INTO workers (id, run_id, role, provider, state, worker_dir, cwd, result_status, result_json, created_at) VALUES (?, ?, ?, 'claude', 'SUCCEEDED', '/w', '/c', ?, ?, 1)`,
      id,
      runId,
      role,
      status,
      JSON.stringify({ modelRequests: requests }),
    );
  }

  it('counts successful sessions of the same role and repository only', () => {
    const db = seed();
    worker(db, 'w1', 'old', 'implementer', 'succeeded', 10);
    worker(db, 'w2', 'old', 'implementer', 'succeeded', 14);
    worker(db, 'w3', 'old', 'implementer', 'max_turns', 30);
    worker(db, 'w4', 'old', 'implementer', 'failed', 3);
    worker(db, 'w5', 'old', 'reviewer', 'succeeded', 6);
    worker(db, 'w6', 'other', 'implementer', 'succeeded', 29);
    expect(successfulTurnHistory(db, 'now', 'implementer').sort((a, b) => a - b)).toEqual([10, 14]);
    expect(successfulTurnHistory(db, 'now', 'reviewer')).toEqual([6]);
  });

  it('keeps difficulties (task classes) separate', () => {
    const db = seed();
    db.run("UPDATE runs SET difficulty = 'complex' WHERE id = 'old'");
    worker(db, 'w1', 'old', 'implementer', 'succeeded', 20);
    expect(successfulTurnHistory(db, 'now', 'implementer')).toEqual([]);
  });

  it('gives a new session the derived cap, and the configured default without history', () => {
    const db = seed();
    const cfg = config({ floor: 5, ceiling: 28, default: 22, reminder_fraction: 0.8 });
    expect(turnCapFor(db, 'now', 'implementer', cfg)).toBe(22);
    for (const [i, n] of [10, 12, 16, 18].entries()) worker(db, `w${i}`, 'old', 'implementer', 'succeeded', n);
    const ctx = { db, run: { id: 'now' }, ledger: null, snapshot: { config: cfg } } as never;
    expect(sessionTurnCap(ctx, 'implementer')).toBe(16);
    expect(sessionTurnCap(ctx, 'reviewer')).toBe(22);
  });
});

describe('turn reminder (AC-2)', () => {
  it('starts at 80% of the cap, at least one turn before it', () => {
    expect(reminderThreshold(30)).toBe(24);
    expect(reminderThreshold(16)).toBe(13);
    expect(reminderThreshold(2)).toBe(1);
  });
  it('is silent before the reminder turn and at the cap', () => {
    expect(turnReminder(0, 30, 24)).toBeNull();
    expect(turnReminder(23, 30, 24)).toBeNull();
    expect(turnReminder(30, 30, 24)).toBeNull();
  });
  it('states the exact number of turns left from the reminder turn on', () => {
    expect(turnReminder(24, 30, 24)).toContain('6 turns of 30 remain');
    expect(turnReminder(29, 30, 24)).toContain('1 turn of 30 remains');
    expect(turnReminder(24, 30, 24)).toContain('next_action.kind to continue-implementation');
  });
});

describe('turn extension (AC-3)', () => {
  const ask = { remainder: 'wire the report', turns: 25, remindAt: 24, granted: 0 };
  it('is granted to a session that reached its reminder and stated what remains', () => {
    expect(decideTurnExtension(ask).granted).toBe(true);
  });
  it('is granted once per attempt', () => {
    expect(decideTurnExtension({ ...ask, granted: 1 })).toMatchObject({ granted: false, reason: 'the attempt already had its one extension' });
  });
  it('is not granted without a stated remainder', () => {
    expect(decideTurnExtension({ ...ask, remainder: '  ' }).granted).toBe(false);
    expect(decideTurnExtension({ ...ask, remainder: null }).granted).toBe(false);
  });
  it('is not granted to a session that stopped before its reminder, or whose cap or turns are unknown', () => {
    expect(decideTurnExtension({ ...ask, turns: 23 }).granted).toBe(false);
    expect(decideTurnExtension({ ...ask, turns: null }).granted).toBe(false);
    expect(decideTurnExtension({ ...ask, remindAt: null }).granted).toBe(false);
  });
});
