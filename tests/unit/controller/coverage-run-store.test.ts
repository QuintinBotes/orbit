import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../../src/core/clock.ts';
import { openDb, type OrbitDb } from '../../../src/storage/db.ts';
import { acquireLease, assertLeaseHeld, createRun, findRun, getLease, getRun, listRuns, markProgress, releaseLease, renewLease, requestCancel, setPaused, transition } from '../../../src/controller/run-store.ts';

function fresh(): { db: OrbitDb; clock: ManualClock } {
  const db = openDb(':memory:');
  const clock = new ManualClock();
  createRun(db, { id: 'r1', repoRoot: '/repo', goal: 'g', mode: 'autonomous', policyHash: 'sha256:x', policyPath: '/p' }, clock);
  acquireLease(db, 'r1', 'ctl', 60_000, clock);
  return { db, clock };
}
const go = (db: OrbitDb, clock: ManualClock, to: Parameters<typeof transition>[1]['to'], extra: Partial<Parameters<typeof transition>[1]> = {}) => transition(db, { runId: 'r1', to, ownerId: 'ctl', reason: 'test', ...extra }, clock);
const types = (db: OrbitDb): string[] => db.all<{ type: string }>("SELECT type FROM events WHERE run_id = 'r1' ORDER BY id").map((r) => r.type);

describe('the release environment a run names', () => {
  it('is stored with the run and its created event, and is null when the run names none', () => {
    const { db, clock } = fresh();
    expect(getRun(db, 'r1').environment).toBeNull();
    const named = createRun(db, { id: 'r2', repoRoot: '/repo', goal: 'g', mode: 'release', policyHash: 'sha256:x', policyPath: '/p', environment: 'staging' }, clock);
    expect(named.environment).toBe('staging');
    expect(getRun(db, 'r2').environment).toBe('staging');
    expect(JSON.parse(db.get<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = 'r2' AND type = 'run.created'")!.data_json)).toEqual({ mode: 'release', policy_hash: 'sha256:x', environment: 'staging' });
    expect(JSON.parse(db.get<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = 'r1' AND type = 'run.created'")!.data_json)).toEqual({ mode: 'autonomous', policy_hash: 'sha256:x' });
  });
});

describe('transition patches and resume', () => {
  it('a blocked run that resumes is live again: end time and outcome are cleared unless the patch sets them', () => {
    const { db, clock } = fresh();
    go(db, clock, 'PREFLIGHT');
    go(db, clock, 'BLOCKED', { patch: { outcomeReason: 'needs login', outcomeJson: '{"blocker":1}' } });
    expect(getRun(db, 'r1')).toMatchObject({ state: 'BLOCKED', outcomeReason: 'needs login', endedAt: clock.now(), resumeState: 'PREFLIGHT' });
    const resumed = go(db, clock, 'PREFLIGHT');
    expect(resumed).toMatchObject({ state: 'PREFLIGHT', endedAt: null, outcomeReason: null, outcomeJson: null, resumeState: null });
    go(db, clock, 'BLOCKED', { patch: { outcomeReason: 'again', outcomeJson: '{}' } });
    const keep = go(db, clock, 'PREFLIGHT', { patch: { outcomeReason: 'kept', outcomeJson: '{"k":1}' } });
    expect(keep).toMatchObject({ outcomeReason: 'kept', outcomeJson: '{"k":1}' });
  });

  it('applies column patches with an undefined value as null, and refuses a column it does not know', () => {
    const { db, clock } = fresh();
    const run = go(db, clock, 'PREFLIGHT', { patch: { baseRevision: 'abc', branch: undefined, worktreePath: '/wt' } });
    expect(run).toMatchObject({ baseRevision: 'abc', branch: null, worktreePath: '/wt' });
    expect(() => go(db, clock, 'CONTRACTING', { patch: { bogus: 1 } as never })).toThrow(/cannot patch bogus in a transition/);
    expect(getRun(db, 'r1').state).toBe('PREFLIGHT');
  });

  it('records the start once, the stage to resume across an interruption, and the data on the event', () => {
    const { db, clock } = fresh();
    expect(getRun(db, 'r1').startedAt).toBeNull();
    clock.advance(10);
    go(db, clock, 'PREFLIGHT', { data: { why: 1 }, actor: 'someone' });
    const started = getRun(db, 'r1').startedAt;
    expect(started).toBe(clock.now());
    go(db, clock, 'CONTRACTING');
    go(db, clock, 'RECOVERING');
    expect(getRun(db, 'r1').resumeState).toBe('CONTRACTING');
    go(db, clock, 'CONTRACTING');
    expect(getRun(db, 'r1')).toMatchObject({ resumeState: null, startedAt: started });
    const ev = db.get<{ actor: string; data_json: string }>("SELECT actor, data_json FROM events WHERE type = 'state.transition' AND to_state = 'PREFLIGHT'");
    expect(ev?.actor).toBe('someone');
    expect(JSON.parse(ev!.data_json)).toEqual({ reason: 'test', data: { why: 1 } });
  });

  it('refuses a transition by a controller that does not hold the lease, or the wrong edge', () => {
    const { db, clock } = fresh();
    expect(() => transition(db, { runId: 'r1', to: 'PREFLIGHT', ownerId: 'other', reason: 'x' }, clock)).toThrow(expect.objectContaining({ code: 'LEASE_LOST' }));
    expect(() => go(db, clock, 'SUCCEEDED')).toThrow(expect.objectContaining({ code: 'TRANSITION_INVALID' }));
  });
});

describe('progress, cancellation and pause', () => {
  it('records progress with its kind and detail', () => {
    const { db, clock } = fresh();
    markProgress(db, 'r1', 'checks', { passed: 3 }, clock);
    expect(getRun(db, 'r1').lastProgressAt).toBe(clock.now());
    expect(types(db)).toContain('progress');
  });

  it('a cancellation request is recorded for a live or blocked run, and ignored for one that already ended', () => {
    const { db, clock } = fresh();
    go(db, clock, 'PREFLIGHT');
    expect(requestCancel(db, 'r1', 'user', clock).cancelRequested).toBe(true);
    go(db, clock, 'CANCELLED');
    const before = types(db).length;
    expect(requestCancel(db, 'r1', 'user', clock).state).toBe('CANCELLED');
    expect(types(db)).toHaveLength(before);

    const b = fresh();
    go(b.db, b.clock, 'PREFLIGHT');
    go(b.db, b.clock, 'BLOCKED');
    expect(requestCancel(b.db, 'r1', 'user', b.clock).cancelRequested).toBe(true);
  });

  it('pauses and unpauses, recording each, and refuses for a run that ended', () => {
    const { db, clock } = fresh();
    expect(setPaused(db, 'r1', true, 'user', clock).paused).toBe(true);
    expect(setPaused(db, 'r1', false, 'user', clock).paused).toBe(false);
    expect(types(db)).toEqual(expect.arrayContaining(['run.paused', 'run.unpaused']));
    go(db, clock, 'CANCELLED');
    expect(() => setPaused(db, 'r1', true, 'user', clock)).toThrow('run r1 is CANCELLED; nothing to pause');
    expect(() => setPaused(db, 'r1', false, 'user', clock)).toThrow('nothing to resume');
  });

  it('a blocked run can be paused', () => {
    const { db, clock } = fresh();
    go(db, clock, 'PREFLIGHT');
    go(db, clock, 'BLOCKED');
    expect(setPaused(db, 'r1', true, 'user', clock).paused).toBe(true);
  });
});

describe('lookup and leases', () => {
  it('finds, lists and refuses runs', () => {
    const { db, clock } = fresh();
    expect(findRun(db, 'nope')).toBeNull();
    expect(() => getRun(db, 'nope')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    createRun(db, { id: 'r2', repoRoot: '/repo', goal: 'g2', mode: 'supervised', policyHash: 'sha256:x', policyPath: '/p' }, clock, 'tester');
    expect(listRuns(db).map((r) => r.id).sort()).toEqual(['r1', 'r2']);
    expect(listRuns(db, { states: ['CREATED'], limit: 1 })).toHaveLength(1);
  });

  it('a held lease cannot be taken until it expires; the takeover names the previous owner and the same owner re-acquires silently', () => {
    const { db, clock } = fresh();
    expect(acquireLease(db, 'r1', 'other', 60_000, clock)).toBeNull();
    const again = acquireLease(db, 'r1', 'ctl', 30_000, clock);
    expect(again).toMatchObject({ ownerId: 'ctl', expiresAt: clock.now() + 30_000 });
    expect(types(db).filter((t) => t.startsWith('lease.'))).toEqual(['lease.acquired']);
    clock.advance(30_001);
    expect(acquireLease(db, 'r1', 'other', 60_000, clock)?.ownerId).toBe('other');
    const ev = db.get<{ data_json: string }>("SELECT data_json FROM events WHERE type = 'lease.takeover'");
    expect(JSON.parse(ev!.data_json)).toMatchObject({ previous_owner: 'ctl' });
    expect(getLease(db, 'r1')?.ownerId).toBe('other');
  });

  it('renews only a live lease of its owner, releases only its own, and asserts the holder at the given instant', () => {
    const { db, clock } = fresh();
    expect(renewLease(db, 'r1', 'other', 60_000, clock)).toBe(false);
    expect(renewLease(db, 'r1', 'ctl', 60_000, clock)).toBe(true);
    releaseLease(db, 'r1', 'other');
    expect(getLease(db, 'r1')).not.toBeNull();
    expect(() => assertLeaseHeld(db, 'r1', 'ctl', clock.now())).not.toThrow();
    expect(() => assertLeaseHeld(db, 'r1', 'other', clock.now())).toThrow(expect.objectContaining({ code: 'LEASE_LOST' }));
    expect(() => assertLeaseHeld(db, 'r1', 'ctl', clock.now() + 60_000)).toThrow(/does not hold the lease/);
    clock.advance(61_000);
    expect(renewLease(db, 'r1', 'ctl', 60_000, clock)).toBe(false);
    releaseLease(db, 'r1', 'ctl');
    expect(getLease(db, 'r1')).toBeNull();
    expect(() => assertLeaseHeld(db, 'r1', 'ctl', clock.now())).toThrow(/does not hold the lease/);
  });
});
