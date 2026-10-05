import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../../../src/core/clock.ts';
import { isOrbitError } from '../../../src/core/errors.ts';
import { resetFaults } from '../../../src/core/faults.ts';
import { openDb, type OrbitDb } from '../../../src/storage/db.ts';
import {
  acquireLease,
  createRun,
  findRun,
  getLease,
  getRun,
  listRuns,
  markProgress,
  releaseLease,
  renewLease,
  requestCancel,
  setPaused,
  transition,
  type RunRecord,
} from '../../../src/controller/run-store.ts';
import { RESUMABLE_STATES, RUN_STATES, TERMINAL_STATES, allowedTransitions, canTransition, isRunState, isTerminal, type RunState } from '../../../src/controller/states.ts';

const OWNER = 'owner-a';
const TTL = 30_000;

function setup(path = ':memory:') {
  const db = openDb(path);
  const clock = new ManualClock();
  return { db, clock };
}

function newRun(db: OrbitDb, clock: ManualClock, id = 'r1'): RunRecord {
  return createRun(db, { id, repoRoot: '/repo', goal: 'g', mode: 'autonomous', policyHash: 'sha256:x', policyPath: '/p' }, clock);
}

/** Put a run straight into `state`, bypassing the edge table, to test edges from it. */
function force(db: OrbitDb, id: string, state: RunState, resume: RunState | null = null): void {
  db.run('UPDATE runs SET state = ?, resume_state = ? WHERE id = ?', state, resume, id);
}

function go(db: OrbitDb, clock: ManualClock, to: RunState, extra: Partial<Parameters<typeof transition>[1]> = {}, id = 'r1'): RunRecord {
  return transition(db, { runId: id, to, ownerId: OWNER, reason: `to ${to}`, ...extra }, clock);
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return isOrbitError(err) ? err.code : `non-orbit: ${String(err)}`;
  }
  return undefined;
}

const transitionEvents = (db: OrbitDb, id = 'r1') =>
  db.all<{ from_state: string; to_state: string; actor: string; data_json: string }>("SELECT from_state, to_state, actor, data_json FROM events WHERE run_id = ? AND type = 'state.transition' ORDER BY id", id);

describe('the edge table (states.ts)', () => {
  it('only names known states, never loops to itself, and never returns to CREATED', () => {
    for (const from of RUN_STATES) {
      for (const to of allowedTransitions(from)) {
        expect(isRunState(to), `${from} -> ${to}`).toBe(true);
        expect(to, `${from} self loop`).not.toBe(from);
        expect(to, `${from} -> CREATED`).not.toBe('CREATED');
      }
      expect(new Set(allowedTransitions(from)).size, `${from} has duplicate edges`).toBe(allowedTransitions(from).length);
    }
  });

  it('terminal states have no exits, except the resumable BLOCKED', () => {
    for (const s of TERMINAL_STATES) {
      if (RESUMABLE_STATES.has(s)) continue;
      expect(allowedTransitions(s), s).toEqual([]);
    }
    for (const s of RESUMABLE_STATES) expect(isTerminal(s)).toBe(true);
    expect(allowedTransitions('BLOCKED')).not.toContain('SUCCEEDED');
    expect(allowedTransitions('BLOCKED')).toContain('CANCELLED');
  });

  it('every non-terminal state can be blocked, exhausted or cancelled', () => {
    for (const s of RUN_STATES) {
      if (isTerminal(s)) continue;
      for (const exit of ['BLOCKED', 'EXHAUSTED', 'CANCELLED'] as const) expect(canTransition(s, exit), `${s} -> ${exit}`).toBe(true);
      if (s !== 'RECOVERING') expect(canTransition(s, 'RECOVERING'), `${s} -> RECOVERING`).toBe(true);
    }
  });

  it('success needs independent review: SUCCEEDED only follows REVIEWING, DELIVERING or AWAITING_CI', () => {
    const into = RUN_STATES.filter((s) => canTransition(s, 'SUCCEEDED'));
    expect(into.sort()).toEqual(['AWAITING_CI', 'DELIVERING', 'REVIEWING']);
    expect(canTransition('VERIFYING', 'SUCCEEDED')).toBe(false);
    expect(canTransition('IMPLEMENTING', 'SUCCEEDED')).toBe(false);
  });

  it('every state is reachable from CREATED and every state can reach a terminal one', () => {
    const reach = (from: RunState): Set<RunState> => {
      const seen = new Set<RunState>([from]);
      const queue = [from];
      while (queue.length) for (const n of allowedTransitions(queue.shift()!)) if (!seen.has(n)) (seen.add(n), queue.push(n));
      return seen;
    };
    expect([...reach('CREATED')].sort()).toEqual([...RUN_STATES].sort());
    for (const s of RUN_STATES) expect([...reach(s)].some((x) => isTerminal(x)), s).toBe(true);
  });
});

describe('transition enforces exactly the edge table', () => {
  it('accepts every listed edge and rejects every other pair, with an event only for accepted ones', () => {
    const { db, clock } = setup();
    let n = 0;
    for (const from of RUN_STATES) {
      for (const to of RUN_STATES) {
        const id = `run-${n++}`;
        newRun(db, clock, id);
        force(db, id, from);
        acquireLease(db, id, OWNER, TTL, clock);
        const before = getRun(db, id);
        const eventsBefore = transitionEvents(db, id).length;
        if (canTransition(from, to)) {
          const after = go(db, clock, to, {}, id);
          expect(after.state, `${from} -> ${to}`).toBe(to);
          expect(after.version).toBe(before.version + 1);
          const evs = transitionEvents(db, id);
          expect(evs).toHaveLength(eventsBefore + 1);
          expect(evs.at(-1)).toMatchObject({ from_state: from, to_state: to, actor: 'controller' });
        } else {
          expect(codeOf(() => go(db, clock, to, {}, id)), `${from} -> ${to}`).toBe('TRANSITION_INVALID');
          const after = getRun(db, id);
          expect(after.state).toBe(from);
          expect(after.version).toBe(before.version);
          expect(transitionEvents(db, id)).toHaveLength(eventsBefore);
        }
      }
    }
    expect(n).toBe(RUN_STATES.length ** 2);
  });

  it('records the reason, data and actor on the event', () => {
    const { db, clock } = setup();
    newRun(db, clock);
    acquireLease(db, 'r1', OWNER, TTL, clock);
    go(db, clock, 'PREFLIGHT', { reason: 'start', actor: 'cli', data: { k: 1 } });
    const ev = transitionEvents(db).at(-1)!;
    expect(ev.actor).toBe('cli');
    expect(JSON.parse(ev.data_json)).toEqual({ reason: 'start', data: { k: 1 } });
  });

  it('sets started_at on the first transition and ended_at on a terminal one', () => {
    const { db, clock } = setup();
    newRun(db, clock);
    acquireLease(db, 'r1', OWNER, TTL, clock);
    expect(getRun(db, 'r1').startedAt).toBeNull();
    const t1 = clock.now();
    go(db, clock, 'PREFLIGHT');
    clock.advance(5_000);
    go(db, clock, 'CONTRACTING');
    expect(getRun(db, 'r1').startedAt).toBe(t1);
    expect(getRun(db, 'r1').endedAt).toBeNull();
    clock.advance(1_000);
    const end = go(db, clock, 'IMPOSSIBLE');
    expect(end.endedAt).toBe(clock.now());
    expect(end.updatedAt).toBe(clock.now());
  });

  it('applies a patch atomically with the transition and rejects unknown patch keys without changing anything', () => {
    const { db, clock } = setup();
    newRun(db, clock);
    acquireLease(db, 'r1', OWNER, TTL, clock);
    const r = go(db, clock, 'PREFLIGHT', { patch: { baseRevision: 'abc', branch: 'orbit/r1', worktreePath: null } });
    expect(r).toMatchObject({ baseRevision: 'abc', branch: 'orbit/r1', worktreePath: null });
    const bad = { patch: { state: 'SUCCEEDED' } as unknown as Record<string, string> };
    expect(codeOf(() => go(db, clock, 'CONTRACTING', bad))).toBe('INTERNAL');
    expect(getRun(db, 'r1').state).toBe('PREFLIGHT');
    expect(transitionEvents(db)).toHaveLength(1);
  });

  it('throws NOT_FOUND for an unknown run', () => {
    const { db, clock } = setup();
    expect(codeOf(() => go(db, clock, 'PREFLIGHT', {}, 'nope'))).toBe('NOT_FOUND');
  });
});

describe('resume_state', () => {
  function at(state: RunState, resume: RunState | null = null) {
    const { db, clock } = setup();
    newRun(db, clock);
    force(db, 'r1', state, resume);
    acquireLease(db, 'r1', OWNER, TTL, clock);
    return { db, clock };
  }

  it('remembers the working stage an interruption came from', () => {
    for (const interrupt of ['INQUISITION', 'BLOCKED', 'RECOVERING'] as const) {
      const { db, clock } = at('IMPLEMENTING');
      expect(go(db, clock, interrupt).resumeState, interrupt).toBe('IMPLEMENTING');
    }
  });

  it('keeps the original stage through a chain of interruptions', () => {
    const { db, clock } = at('PLANNING');
    go(db, clock, 'INQUISITION');
    expect(go(db, clock, 'RECOVERING').resumeState).toBe('PLANNING');
    expect(go(db, clock, 'BLOCKED').resumeState).toBe('PLANNING');
    expect(go(db, clock, 'INQUISITION').resumeState).toBe('PLANNING');
  });

  it('is cleared when work resumes, wherever it resumes', () => {
    const { db, clock } = at('VERIFYING');
    go(db, clock, 'RECOVERING');
    const resumed = go(db, clock, 'VERIFYING');
    expect(resumed.resumeState).toBeNull();
    go(db, clock, 'BLOCKED');
    expect(go(db, clock, 'DIAGNOSING').resumeState).toBeNull();
  });

  it('is kept by a terminal transition, so the report can say where the run stopped', () => {
    const { db, clock } = at('REVIEWING');
    go(db, clock, 'RECOVERING');
    expect(go(db, clock, 'EXHAUSTED').resumeState).toBe('REVIEWING');
    const b = at('IMPLEMENTING');
    expect(go(b.db, b.clock, 'CANCELLED').resumeState).toBeNull();
  });
});

describe('optimistic concurrency', () => {
  it('rejects a transition whose expectedFrom no longer holds', () => {
    const { db, clock } = setup();
    newRun(db, clock);
    acquireLease(db, 'r1', OWNER, TTL, clock);
    go(db, clock, 'PREFLIGHT');
    expect(codeOf(() => go(db, clock, 'CONTRACTING', { expectedFrom: 'CREATED' }))).toBe('CONCURRENT_UPDATE');
    expect(getRun(db, 'r1').state).toBe('PREFLIGHT');
    expect(go(db, clock, 'CONTRACTING', { expectedFrom: 'PREFLIGHT' }).state).toBe('CONTRACTING');
  });

  it('rejects and rolls back when the row version moved between read and write', () => {
    const { db, clock } = setup();
    newRun(db, clock);
    acquireLease(db, 'r1', OWNER, TTL, clock);
    // A view of the database whose run reads are one version behind, as if
    // another writer had committed in between.
    const stale: OrbitDb = {
      ...db,
      get<T>(sql: string, ...params: Parameters<OrbitDb['get']>[1][]): T | undefined {
        const row = db.get<Record<string, unknown>>(sql, ...params);
        if (row && sql.startsWith('SELECT * FROM runs')) return { ...row, version: Number(row.version) - 1 } as T;
        return row as T | undefined;
      },
    };
    expect(codeOf(() => transition(stale, { runId: 'r1', to: 'PREFLIGHT', ownerId: OWNER, reason: 'x' }, clock))).toBe('CONCURRENT_UPDATE');
    expect(getRun(db, 'r1').state).toBe('CREATED');
    expect(transitionEvents(db)).toHaveLength(0);
  });

  it('bumps the version by exactly one for every change: transition, cancel, pause', () => {
    const { db, clock } = setup();
    const v0 = newRun(db, clock).version;
    acquireLease(db, 'r1', OWNER, TTL, clock);
    expect(go(db, clock, 'PREFLIGHT').version).toBe(v0 + 1);
    expect(setPaused(db, 'r1', true, 'cli', clock).version).toBe(v0 + 2);
    expect(setPaused(db, 'r1', false, 'cli', clock).version).toBe(v0 + 3);
    expect(requestCancel(db, 'r1', 'cli', clock).version).toBe(v0 + 4);
    markProgress(db, 'r1', 'test', null, clock);
    expect(getRun(db, 'r1').version).toBe(v0 + 4);
  });

  it('a transition that commits survives a failure right after the commit', () => {
    const { db, clock } = setup();
    newRun(db, clock);
    acquireLease(db, 'r1', OWNER, TTL, clock);
    const saved = process.env.ORBIT_FAULTS;
    process.env.ORBIT_FAULTS = 'controller.transition.after-commit=throw';
    resetFaults();
    try {
      expect(() => go(db, clock, 'PREFLIGHT')).toThrow('fault injected');
    } finally {
      if (saved === undefined) delete process.env.ORBIT_FAULTS;
      else process.env.ORBIT_FAULTS = saved;
      resetFaults();
    }
    expect(getRun(db, 'r1').state).toBe('PREFLIGHT');
    expect(transitionEvents(db)).toHaveLength(1);
  });
});

describe('leases', () => {
  it('rejects a transition at the exact expiry instant', () => {
    const { db, clock } = setup();
    newRun(db, clock);
    acquireLease(db, 'r1', OWNER, 1_000, clock);
    clock.advance(999);
    go(db, clock, 'PREFLIGHT');
    clock.advance(1);
    expect(codeOf(() => go(db, clock, 'CONTRACTING'))).toBe('LEASE_LOST');
  });

  it('renewal extends a live lease and fails once it has expired', () => {
    const { db, clock } = setup();
    newRun(db, clock);
    acquireLease(db, 'r1', OWNER, 1_000, clock);
    clock.advance(900);
    expect(renewLease(db, 'r1', OWNER, 1_000, clock)).toBe(true);
    expect(getLease(db, 'r1')!.expiresAt).toBe(clock.now() + 1_000);
    clock.advance(900);
    go(db, clock, 'PREFLIGHT');
    expect(renewLease(db, 'r1', 'someone-else', 1_000, clock)).toBe(false);
    clock.advance(1_000);
    expect(renewLease(db, 'r1', OWNER, 1_000, clock)).toBe(false);
  });

  it('re-acquiring our own lease extends it without a new event', () => {
    const { db, clock } = setup();
    newRun(db, clock);
    acquireLease(db, 'r1', OWNER, 1_000, clock);
    clock.advance(500);
    expect(acquireLease(db, 'r1', OWNER, 1_000, clock)!.expiresAt).toBe(clock.now() + 1_000);
    const types = db.all<{ type: string }>("SELECT type FROM events WHERE type LIKE 'lease.%'").map((e) => e.type);
    expect(types).toEqual(['lease.acquired']);
  });

  it('records a takeover with the previous owner, and a fresh acquire after release', () => {
    const { db, clock } = setup();
    newRun(db, clock);
    acquireLease(db, 'r1', 'a', 1_000, clock);
    clock.advance(1_000);
    expect(acquireLease(db, 'r1', 'b', 1_000, clock)).not.toBeNull();
    releaseLease(db, 'r1', 'a');
    expect(getLease(db, 'r1')!.ownerId).toBe('b');
    releaseLease(db, 'r1', 'b');
    expect(getLease(db, 'r1')).toBeNull();
    expect(acquireLease(db, 'r1', 'a', 1_000, clock)).not.toBeNull();
    const evs = db.all<{ type: string; actor: string; data_json: string | null }>("SELECT type, actor, data_json FROM events WHERE type LIKE 'lease.%' ORDER BY id");
    expect(evs.map((e) => [e.type, e.actor])).toEqual([
      ['lease.acquired', 'a'],
      ['lease.takeover', 'b'],
      ['lease.acquired', 'a'],
    ]);
    expect(JSON.parse(evs[1]!.data_json!)).toMatchObject({ previous_owner: 'a' });
  });
});

describe('cancel, pause and progress', () => {
  it('cancel is a no-op on finished runs but applies to BLOCKED, which then only allows CANCELLED', () => {
    const { db, clock } = setup();
    newRun(db, clock, 'done');
    force(db, 'done', 'SUCCEEDED');
    expect(requestCancel(db, 'done', 'cli', clock).cancelRequested).toBe(false);
    expect(db.all("SELECT 1 FROM events WHERE run_id = 'done' AND type = 'run.cancel-requested'")).toHaveLength(0);

    newRun(db, clock, 'blocked');
    force(db, 'blocked', 'BLOCKED', 'IMPLEMENTING');
    acquireLease(db, 'blocked', OWNER, TTL, clock);
    expect(requestCancel(db, 'blocked', 'cli', clock).cancelRequested).toBe(true);
    expect(codeOf(() => go(db, clock, 'IMPLEMENTING', {}, 'blocked'))).toBe('CANCELLED');
    expect(go(db, clock, 'CANCELLED', {}, 'blocked').state).toBe('CANCELLED');
  });

  it('a cancellation request survives closing and reopening the database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbit-rs-'));
    try {
      const path = join(dir, 'state.sqlite');
      const a = setup(path);
      newRun(a.db, a.clock);
      acquireLease(a.db, 'r1', OWNER, TTL, a.clock);
      go(a.db, a.clock, 'PREFLIGHT');
      requestCancel(a.db, 'r1', 'cli', a.clock);
      a.db.close();
      const b = openDb(path);
      const run = getRun(b, 'r1');
      expect(run.cancelRequested).toBe(true);
      expect(codeOf(() => go(b, a.clock, 'CONTRACTING'))).toBe('CANCELLED');
      expect(go(b, a.clock, 'CANCELLED').state).toBe('CANCELLED');
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pause toggles with events; finished runs refuse, BLOCKED accepts', () => {
    const { db, clock } = setup();
    newRun(db, clock);
    expect(setPaused(db, 'r1', true, 'cli', clock).paused).toBe(true);
    expect(setPaused(db, 'r1', false, 'cli', clock).paused).toBe(false);
    const types = db.all<{ type: string }>("SELECT type FROM events WHERE type LIKE 'run.%paused' ORDER BY id").map((e) => e.type);
    expect(types).toEqual(['run.paused', 'run.unpaused']);
    force(db, 'r1', 'EXHAUSTED');
    expect(codeOf(() => setPaused(db, 'r1', true, 'cli', clock))).toBe('TRANSITION_INVALID');
    force(db, 'r1', 'BLOCKED');
    expect(setPaused(db, 'r1', true, 'cli', clock).paused).toBe(true);
  });

  it('markProgress stamps last_progress_at and appends a progress event', () => {
    const { db, clock } = setup();
    newRun(db, clock);
    clock.advance(42);
    markProgress(db, 'r1', 'candidate', { seq: 1 }, clock);
    expect(getRun(db, 'r1').lastProgressAt).toBe(clock.now());
    const ev = db.get<{ data_json: string }>("SELECT data_json FROM events WHERE type = 'progress'")!;
    expect(JSON.parse(ev.data_json)).toEqual({ kind: 'candidate', detail: { seq: 1 } });
  });
});

describe('creating and reading runs', () => {
  it('rejects a duplicate run id and leaves a single creation event', () => {
    const { db, clock } = setup();
    newRun(db, clock);
    expect(() => newRun(db, clock)).toThrow();
    expect(db.all("SELECT 1 FROM events WHERE type = 'run.created'")).toHaveLength(1);
  });

  it('getRun throws NOT_FOUND, findRun returns null', () => {
    const { db } = setup();
    expect(codeOf(() => getRun(db, 'x'))).toBe('NOT_FOUND');
    expect(findRun(db, 'x')).toBeNull();
  });

  it('listRuns filters by state, orders newest first and limits', () => {
    const { db, clock } = setup();
    for (const id of ['a', 'b', 'c']) {
      newRun(db, clock, id);
      clock.advance(10);
    }
    force(db, 'b', 'BLOCKED');
    expect(listRuns(db).map((r) => r.id)).toEqual(['c', 'b', 'a']);
    expect(listRuns(db, { limit: 2 }).map((r) => r.id)).toEqual(['c', 'b']);
    expect(listRuns(db, { states: ['BLOCKED'] }).map((r) => r.id)).toEqual(['b']);
    expect(listRuns(db, { states: ['CREATED', 'BLOCKED'] }).map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });

  it('refuses to read a run whose stored state is unknown', () => {
    const { db, clock } = setup();
    newRun(db, clock);
    db.run("UPDATE runs SET state = 'WEIRD' WHERE id = 'r1'");
    expect(codeOf(() => getRun(db, 'r1'))).toBe('INTERNAL');
  });
});

describe('resuming a blocked run', () => {
  it('clears ended_at and the blocker outcome when the run leaves BLOCKED', async () => {
    const { openDb } = await import('../../../src/storage/db.ts');
    const { ManualClock } = await import('../../../src/core/clock.ts');
    const rs = await import('../../../src/controller/run-store.ts');
    const db = openDb(':memory:');
    const clock = new ManualClock();
    rs.createRun(db, { id: 'rb', repoRoot: '/r', goal: 'g', mode: 'autonomous', policyHash: 'sha256:x', policyPath: '/p' }, clock);
    rs.acquireLease(db, 'rb', 'o', 60_000, clock);
    rs.transition(db, { runId: 'rb', to: 'PREFLIGHT', ownerId: 'o', reason: 'start' }, clock);
    rs.transition(db, { runId: 'rb', to: 'BLOCKED', ownerId: 'o', reason: 'needs decision', patch: { outcomeReason: 'question Q-1 open' } }, clock);
    expect(rs.getRun(db, 'rb').endedAt).not.toBeNull();
    const resumed = rs.transition(db, { runId: 'rb', to: 'PREFLIGHT', ownerId: 'o', reason: 'decided' }, clock);
    expect(resumed.endedAt).toBeNull();
    expect(resumed.outcomeReason).toBeNull();
    expect(resumed.resumeState).toBeNull();
  });
});
