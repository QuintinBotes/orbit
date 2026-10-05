import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../../src/core/clock.ts';
import { isOrbitError } from '../../../src/core/errors.ts';
import { createRun, requestCancel } from '../../../src/controller/run-store.ts';
import { TERMINAL_STATES } from '../../../src/controller/states.ts';
import { openDb, type OrbitDb } from '../../../src/storage/db.ts';
import {
  countActiveWorkers,
  findWorker,
  finishWorker,
  getWorker,
  isWorkerActive,
  isWorkerState,
  listActiveWorkers,
  listWorkers,
  markWorkerRunning,
  planWorker,
  planWorkerRestart,
  requestWorkerCancel,
  WORKER_STATES,
  type NewWorker,
} from '../../../src/storage/workers.ts';

function setup() {
  const db = openDb(':memory:');
  const clock = new ManualClock();
  for (const id of ['r1', 'r2']) createRun(db, { id, repoRoot: '/repo', goal: 'g', mode: 'autonomous', policyHash: 'sha256:x', policyPath: '/p' }, clock);
  return { db, clock };
}

const spec = (id: string, over: Partial<NewWorker> = {}): NewWorker => ({
  id,
  runId: 'r1',
  role: 'implementer',
  provider: 'claude',
  model: 'model-x',
  effort: 'medium',
  attempt: 1,
  workerDir: `/repo/.orbit/runs/r1/workers/${id}`,
  cwd: `/home/acme/.orbit/worktrees/h/r1/${id}`,
  ...over,
});

const PROC = { pid: 4242, pgid: 4242, procStart: 'Sat Oct 3 09:37:05 2026' };

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return isOrbitError(err) ? err.code : `non-orbit: ${String(err)}`;
  }
  return undefined;
}

const events = (db: OrbitDb) => db.all<{ type: string; data_json: string }>("SELECT type, data_json FROM events WHERE type LIKE 'worker.%' ORDER BY id");

describe('planWorker', () => {
  it('writes a PLANNED row and a worker.planned event before anything is spawned', () => {
    const { db, clock } = setup();
    const w = planWorker(db, spec('w1', { ownedPaths: ['src/a.ts', 'src/b/**'], purpose: 'implement csv export', candidateId: 'c1' }), clock);
    expect(w).toMatchObject({
      id: 'w1',
      runId: 'r1',
      role: 'implementer',
      provider: 'claude',
      model: 'model-x',
      state: 'PLANNED',
      attempt: 1,
      candidateId: 'c1',
      ownedPaths: ['src/a.ts', 'src/b/**'],
      pid: null,
      pgid: null,
      procStart: null,
      restartCount: 0,
      cancelRequested: false,
      createdAt: clock.now(),
    });
    expect(events(db).map((e) => e.type)).toEqual(['worker.planned']);
    expect(JSON.parse(events(db)[0]!.data_json)).toMatchObject({ worker_id: 'w1', role: 'implementer', provider: 'claude' });
  });

  it('stores optional fields as null', () => {
    const { db, clock } = setup();
    const w = planWorker(db, { id: 'w', runId: 'r1', role: 'reviewer', provider: 'codex', workerDir: '/d', cwd: '/c' }, clock);
    expect(w).toMatchObject({ purpose: null, model: null, effort: null, attempt: null, candidateId: null, ownedPaths: null });
  });

  it('rejects an unknown run and a duplicate worker id', () => {
    const { db, clock } = setup();
    expect(codeOf(() => planWorker(db, spec('w1', { runId: 'nope' }), clock))).toBe('NOT_FOUND');
    planWorker(db, spec('w1'), clock);
    expect(codeOf(() => planWorker(db, spec('w1'), clock))).toBe('CONCURRENT_UPDATE');
    expect(events(db)).toHaveLength(1);
  });

  it('rolls back with an enclosing transaction', () => {
    const { db, clock } = setup();
    expect(() =>
      db.tx(() => {
        planWorker(db, spec('w1'), clock);
        throw new Error('lease check failed');
      }),
    ).toThrow('lease check failed');
    expect(findWorker(db, 'w1')).toBeNull();
    expect(events(db)).toHaveLength(0);
  });
});

describe('markWorkerRunning', () => {
  it('moves PLANNED to RUNNING with the process identity', () => {
    const { db, clock } = setup();
    planWorker(db, spec('w1'), clock);
    clock.advance(100);
    const w = markWorkerRunning(db, 'w1', PROC, clock);
    expect(w).toMatchObject({ state: 'RUNNING', ...PROC, spawnedAt: clock.now() });
    expect(events(db).map((e) => e.type)).toEqual(['worker.planned', 'worker.started']);
  });

  it('keeps an explicit spawn time from pid.json', () => {
    const { db, clock } = setup();
    planWorker(db, spec('w1'), clock);
    expect(markWorkerRunning(db, 'w1', { ...PROC, spawnedAt: 123 }, clock).spawnedAt).toBe(123);
  });

  it('is idempotent for the same process, so reconciliation can replay it', () => {
    const { db, clock } = setup();
    planWorker(db, spec('w1'), clock);
    markWorkerRunning(db, 'w1', PROC, clock);
    expect(markWorkerRunning(db, 'w1', PROC, clock).state).toBe('RUNNING');
    expect(events(db).filter((e) => e.type === 'worker.started')).toHaveLength(1);
  });

  it('rejects a different process for a running worker, and any finished worker', () => {
    const { db, clock } = setup();
    planWorker(db, spec('w1'), clock);
    markWorkerRunning(db, 'w1', PROC, clock);
    expect(codeOf(() => markWorkerRunning(db, 'w1', { ...PROC, pid: 5, pgid: 5 }, clock))).toBe('TRANSITION_INVALID');
    expect(codeOf(() => markWorkerRunning(db, 'w1', { ...PROC, procStart: 'other' }, clock))).toBe('TRANSITION_INVALID');
    finishWorker(db, 'w1', { state: 'FAILED' }, clock);
    expect(codeOf(() => markWorkerRunning(db, 'w1', PROC, clock))).toBe('TRANSITION_INVALID');
    expect(codeOf(() => markWorkerRunning(db, 'missing', PROC, clock))).toBe('NOT_FOUND');
  });
});

describe('finishWorker', () => {
  it('records the outcome, result JSON and end time', () => {
    const { db, clock } = setup();
    planWorker(db, spec('w1'), clock);
    markWorkerRunning(db, 'w1', PROC, clock);
    clock.advance(60_000);
    const w = finishWorker(db, 'w1', { state: 'SUCCEEDED', exitCode: 0, resultStatus: 'succeeded', result: { summary: 'done', files: ['a.ts'] } }, clock);
    expect(w).toMatchObject({ state: 'SUCCEEDED', exitCode: 0, signal: null, resultStatus: 'succeeded', endedAt: clock.now(), error: null });
    expect(JSON.parse(w.resultJson!)).toEqual({ summary: 'done', files: ['a.ts'] });
    expect(JSON.parse(events(db).at(-1)!.data_json)).toMatchObject({ worker_id: 'w1', state: 'SUCCEEDED', result_status: 'succeeded', exit_code: 0 });
  });

  it('repeating the same final state is a no-op; a different one is rejected', () => {
    const { db, clock } = setup();
    planWorker(db, spec('w1'), clock);
    markWorkerRunning(db, 'w1', PROC, clock);
    const first = finishWorker(db, 'w1', { state: 'FAILED', exitCode: 1, signal: null, error: 'boom' }, clock);
    clock.advance(1_000);
    const again = finishWorker(db, 'w1', { state: 'FAILED', exitCode: 1 }, clock);
    expect(again.endedAt).toBe(first.endedAt);
    expect(events(db).filter((e) => e.type === 'worker.finished')).toHaveLength(1);
    expect(codeOf(() => finishWorker(db, 'w1', { state: 'SUCCEEDED' }, clock))).toBe('TRANSITION_INVALID');
  });

  it('lets a PLANNED worker fail, be cancelled or be lost, but never succeed', () => {
    const { db, clock } = setup();
    for (const [id, state] of [['a', 'FAILED'], ['b', 'CANCELLED'], ['c', 'LOST']] as const) {
      planWorker(db, spec(id), clock);
      expect(finishWorker(db, id, { state, error: 'spawn failed' }, clock).state).toBe(state);
    }
    planWorker(db, spec('d'), clock);
    expect(codeOf(() => finishWorker(db, 'd', { state: 'SUCCEEDED' }, clock))).toBe('TRANSITION_INVALID');
    expect(getWorker(db, 'd').state).toBe('PLANNED');
  });

  it('records a signal for a killed worker', () => {
    const { db, clock } = setup();
    planWorker(db, spec('w1'), clock);
    markWorkerRunning(db, 'w1', PROC, clock);
    expect(finishWorker(db, 'w1', { state: 'CANCELLED', signal: 'SIGTERM', resultStatus: 'cancelled' }, clock)).toMatchObject({ exitCode: null, signal: 'SIGTERM' });
  });
});

describe('requestWorkerCancel', () => {
  it('sets the durable flag once, with an event, and ignores finished workers', () => {
    const { db, clock } = setup();
    planWorker(db, spec('w1'), clock);
    expect(requestWorkerCancel(db, 'w1', clock, 'cli', 'obsolete').cancelRequested).toBe(true);
    requestWorkerCancel(db, 'w1', clock);
    const cancels = events(db).filter((e) => e.type === 'worker.cancel-requested');
    expect(cancels).toHaveLength(1);
    expect(JSON.parse(cancels[0]!.data_json)).toEqual({ worker_id: 'w1', reason: 'obsolete' });

    planWorker(db, spec('w2'), clock);
    finishWorker(db, 'w2', { state: 'FAILED' }, clock);
    expect(requestWorkerCancel(db, 'w2', clock).cancelRequested).toBe(false);
  });

  it('a cancelled-but-starting worker can still be marked running, so it can be stopped', () => {
    const { db, clock } = setup();
    planWorker(db, spec('w1'), clock);
    requestWorkerCancel(db, 'w1', clock);
    expect(markWorkerRunning(db, 'w1', PROC, clock)).toMatchObject({ state: 'RUNNING', cancelRequested: true });
  });
});

describe('planWorkerRestart', () => {
  it('returns a FAILED or LOST worker to PLANNED, clearing process and result fields', () => {
    const { db, clock } = setup();
    planWorker(db, spec('w1'), clock);
    markWorkerRunning(db, 'w1', PROC, clock);
    finishWorker(db, 'w1', { state: 'LOST', error: 'controller restarted', resultStatus: 'lost' }, clock);
    const w = planWorkerRestart(db, 'w1', clock);
    expect(w).toMatchObject({ state: 'PLANNED', restartCount: 1, pid: null, pgid: null, procStart: null, spawnedAt: null, endedAt: null, exitCode: null, resultStatus: null, resultJson: null, error: null });
    markWorkerRunning(db, 'w1', { ...PROC, pid: 7, pgid: 7 }, clock);
    finishWorker(db, 'w1', { state: 'FAILED' }, clock);
    expect(planWorkerRestart(db, 'w1', clock).restartCount).toBe(2);
    expect(JSON.parse(events(db).at(-1)!.data_json)).toEqual({ worker_id: 'w1', previous_state: 'FAILED', restart_count: 2 });
  });

  it('never restarts a succeeded, cancelled, active or cancel-requested worker', () => {
    const { db, clock } = setup();
    planWorker(db, spec('ok'), clock);
    markWorkerRunning(db, 'ok', PROC, clock);
    finishWorker(db, 'ok', { state: 'SUCCEEDED' }, clock);
    expect(codeOf(() => planWorkerRestart(db, 'ok', clock))).toBe('TRANSITION_INVALID');
    planWorker(db, spec('cx'), clock);
    finishWorker(db, 'cx', { state: 'CANCELLED' }, clock);
    expect(codeOf(() => planWorkerRestart(db, 'cx', clock))).toBe('TRANSITION_INVALID');
    planWorker(db, spec('live'), clock);
    expect(codeOf(() => planWorkerRestart(db, 'live', clock))).toBe('TRANSITION_INVALID');
    planWorker(db, spec('fl'), clock);
    requestWorkerCancel(db, 'fl', clock);
    finishWorker(db, 'fl', { state: 'FAILED' }, clock);
    expect(codeOf(() => planWorkerRestart(db, 'fl', clock))).toBe('CANCELLED');
  });
});

describe('queries', () => {
  it('lists by run, state and role in planning order, with limits', () => {
    const { db, clock } = setup();
    planWorker(db, spec('a'), clock);
    clock.advance(1);
    planWorker(db, spec('b', { role: 'reviewer', provider: 'codex' }), clock);
    clock.advance(1);
    planWorker(db, spec('c', { runId: 'r2' }), clock);
    clock.advance(1);
    planWorker(db, spec('d'), clock);
    markWorkerRunning(db, 'a', PROC, clock);
    finishWorker(db, 'd', { state: 'FAILED' }, clock);

    expect(listWorkers(db).map((w) => w.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(listWorkers(db, { runId: 'r1' }).map((w) => w.id)).toEqual(['a', 'b', 'd']);
    expect(listWorkers(db, { role: 'reviewer' }).map((w) => w.id)).toEqual(['b']);
    expect(listWorkers(db, { states: ['RUNNING'] }).map((w) => w.id)).toEqual(['a']);
    expect(listWorkers(db, { states: [] })).toEqual([]);
    expect(listWorkers(db, { limit: 2 }).map((w) => w.id)).toEqual(['a', 'b']);
    expect(listActiveWorkers(db).map((w) => w.id)).toEqual(['a', 'b', 'c']);
    expect(listActiveWorkers(db, 'r1').map((w) => w.id)).toEqual(['a', 'b']);
    expect(countActiveWorkers(db)).toBe(3);
    expect(countActiveWorkers(db, 'r2')).toBe(1);
    expect(countActiveWorkers(db, 'none')).toBe(0);
  });

  it('getWorker throws NOT_FOUND, findWorker returns null', () => {
    const { db } = setup();
    expect(codeOf(() => getWorker(db, 'x'))).toBe('NOT_FOUND');
    expect(findWorker(db, 'x')).toBeNull();
  });

  it('refuses to read a row with an unknown state', () => {
    const { db, clock } = setup();
    planWorker(db, spec('w1'), clock);
    db.run("UPDATE workers SET state = 'ZOMBIE' WHERE id = 'w1'");
    expect(codeOf(() => getWorker(db, 'w1'))).toBe('INTERNAL');
  });

  it('state helpers agree with the state list', () => {
    expect(WORKER_STATES.filter(isWorkerActive)).toEqual(['PLANNED', 'RUNNING']);
    expect(WORKER_STATES.every(isWorkerState)).toBe(true);
    expect(isWorkerState('planned')).toBe(false);
  });
});

describe('adversarial review', () => {
  it('refuses to plan a worker once the run has a durable cancellation request, inside the same transaction', () => {
    const { db, clock } = setup();
    // The controller read the run before `orbit cancel` committed; the plan must still lose.
    requestCancel(db, 'r1', 'cli', clock);
    expect(codeOf(() => planWorker(db, spec('w1'), clock))).toBe('CANCELLED');
    expect(findWorker(db, 'w1')).toBeNull();
    expect(events(db)).toHaveLength(0);
    // Other runs are unaffected.
    expect(planWorker(db, spec('w2', { runId: 'r2' }), clock).state).toBe('PLANNED');
  });

  it('refuses to restart a failed worker once its run is cancelled', () => {
    const { db, clock } = setup();
    planWorker(db, spec('w1'), clock);
    finishWorker(db, 'w1', { state: 'FAILED' }, clock);
    requestCancel(db, 'r1', 'cli', clock);
    expect(codeOf(() => planWorkerRestart(db, 'w1', clock))).toBe('CANCELLED');
    expect(getWorker(db, 'w1')).toMatchObject({ state: 'FAILED', restartCount: 0 });
  });

  it('refuses new or restarted workers for a run in any terminal state, BLOCKED included', () => {
    const { db, clock } = setup();
    planWorker(db, spec('w1'), clock);
    finishWorker(db, 'w1', { state: 'LOST' }, clock);
    for (const state of TERMINAL_STATES) {
      db.run('UPDATE runs SET state = ? WHERE id = ?', state, 'r1');
      expect(codeOf(() => planWorker(db, spec(`n-${state}`), clock)), state).toBe('TRANSITION_INVALID');
      expect(codeOf(() => planWorkerRestart(db, 'w1', clock)), state).toBe('TRANSITION_INVALID');
    }
    expect(listWorkers(db, { runId: 'r1' }).map((w) => w.id)).toEqual(['w1']);
  });

  it('plans a curator, and only a curator, on a terminal run; a cancellation request still refuses it', () => {
    const { db, clock } = setup();
    for (const state of TERMINAL_STATES) {
      db.run('UPDATE runs SET state = ? WHERE id = ?', state, 'r1');
      for (const role of ['planner', 'implementer', 'verifier', 'reviewer', 'inquisitor'] as const) {
        expect(codeOf(() => planWorker(db, spec(`n-${role}-${state}`, { role }), clock)), `${role} on ${state}`).toBe('TRANSITION_INVALID');
      }
      const w = planWorker(db, spec(`cur-${state}`, { role: 'curator' }), clock);
      expect(w).toMatchObject({ role: 'curator', state: 'PLANNED' });
      expect(markWorkerRunning(db, w.id, PROC, clock).state).toBe('RUNNING');
      expect(finishWorker(db, w.id, { state: 'SUCCEEDED' }, clock).state).toBe('SUCCEEDED');
      expect(codeOf(() => planWorkerRestart(db, w.id, clock)), state).toBe('TRANSITION_INVALID');
    }
    db.run('UPDATE runs SET cancel_requested = 1 WHERE id = ?', 'r1');
    expect(codeOf(() => planWorker(db, spec('cur-cancelled', { role: 'curator' }), clock))).toBe('CANCELLED');
  });

  it('still records and finishes a worker spawned before the cancellation landed, so it can be stopped', () => {
    const { db, clock } = setup();
    planWorker(db, spec('w1'), clock);
    requestCancel(db, 'r1', 'cli', clock);
    expect(markWorkerRunning(db, 'w1', PROC, clock).state).toBe('RUNNING');
    expect(finishWorker(db, 'w1', { state: 'CANCELLED', signal: 'SIGINT' }, clock).state).toBe('CANCELLED');
  });

  it('treats start times that differ only in whitespace as the same process when replaying pid.json', () => {
    const { db, clock } = setup();
    planWorker(db, spec('w1'), clock);
    // Raw `ps -o lstart=` pads single-digit days with a second space.
    const w = markWorkerRunning(db, 'w1', { ...PROC, procStart: 'Sat Oct  3 09:37:05 2026' }, clock);
    expect(w.procStart).toBe('Sat Oct 3 09:37:05 2026');
    expect(markWorkerRunning(db, 'w1', { ...PROC, procStart: 'Sat Oct 3 09:37:05 2026' }, clock).state).toBe('RUNNING');
    expect(events(db).filter((e) => e.type === 'worker.started')).toHaveLength(1);
  });

  it('rejects a state that is not final when finishing, even from untyped callers', () => {
    const { db, clock } = setup();
    planWorker(db, spec('w1'), clock);
    for (const state of ['RUNNING', 'PLANNED', 'DONE']) {
      expect(codeOf(() => finishWorker(db, 'w1', { state: state as 'FAILED' }, clock)), state).toBe('INTERNAL');
    }
    expect(getWorker(db, 'w1').state).toBe('PLANNED');
    expect(events(db).filter((e) => e.type === 'worker.finished')).toHaveLength(0);
  });
});
