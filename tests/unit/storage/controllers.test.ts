import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../../src/core/clock.ts';
import { isOrbitError } from '../../../src/core/errors.ts';
import { openDb } from '../../../src/storage/db.ts';
import {
  findController,
  getController,
  heartbeatController,
  listControllers,
  listStaleControllers,
  markControllerStopped,
  registerController,
  type NewController,
} from '../../../src/storage/controllers.ts';

function setup() {
  return { db: openDb(':memory:'), clock: new ManualClock() };
}

const ctl = (id: string, over: Partial<NewController> = {}): NewController => ({ id, pid: 100, host: 'acme-host', procStart: 'Sat Oct 3 09:37:05 2026', mode: 'service', ...over });

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return isOrbitError(err) ? err.code : `non-orbit: ${String(err)}`;
  }
  return undefined;
}

describe('controllers', () => {
  it('registers an incarnation with heartbeat equal to its start', () => {
    const { db, clock } = setup();
    const c = registerController(db, ctl('c1', { mode: 'foreground', procStart: null }), clock);
    expect(c).toEqual({ id: 'c1', pid: 100, host: 'acme-host', procStart: null, mode: 'foreground', startedAt: clock.now(), heartbeatAt: clock.now(), lastProgressAt: null, stoppedAt: null, stopReason: null });
  });

  it('refuses to register the same id twice', () => {
    const { db, clock } = setup();
    registerController(db, ctl('c1'), clock);
    expect(codeOf(() => registerController(db, ctl('c1'), clock))).toBe('CONCURRENT_UPDATE');
  });

  it('heartbeats advance heartbeat_at, and progress only when asked', () => {
    const { db, clock } = setup();
    registerController(db, ctl('c1'), clock);
    clock.advance(1_000);
    expect(heartbeatController(db, 'c1', clock)).toBe(true);
    expect(getController(db, 'c1')).toMatchObject({ heartbeatAt: clock.now(), lastProgressAt: null });
    clock.advance(1_000);
    expect(heartbeatController(db, 'c1', clock, { progress: true })).toBe(true);
    expect(getController(db, 'c1')).toMatchObject({ heartbeatAt: clock.now(), lastProgressAt: clock.now() });
  });

  it('a stopped or unknown controller cannot heartbeat, so a declared-dead incarnation learns it', () => {
    const { db, clock } = setup();
    registerController(db, ctl('c1'), clock);
    markControllerStopped(db, 'c1', 'stale heartbeat', clock);
    clock.advance(1_000);
    expect(heartbeatController(db, 'c1', clock)).toBe(false);
    expect(getController(db, 'c1').heartbeatAt).toBe(clock.now() - 1_000);
    expect(heartbeatController(db, 'missing', clock)).toBe(false);
  });

  it('records the first stop reason only', () => {
    const { db, clock } = setup();
    registerController(db, ctl('c1'), clock);
    clock.advance(5);
    const first = markControllerStopped(db, 'c1', 'SIGTERM', clock);
    clock.advance(5);
    const second = markControllerStopped(db, 'c1', 'stale', clock);
    expect(first).toMatchObject({ stoppedAt: clock.now() - 5, stopReason: 'SIGTERM' });
    expect(second).toEqual(first);
    expect(codeOf(() => markControllerStopped(db, 'missing', 'x', clock))).toBe('NOT_FOUND');
  });

  it('lists live controllers by most recent heartbeat, stopped ones on request', () => {
    const { db, clock } = setup();
    for (const id of ['a', 'b', 'c']) registerController(db, ctl(id), clock);
    clock.advance(10);
    heartbeatController(db, 'a', clock);
    markControllerStopped(db, 'b', 'done', clock);
    expect(listControllers(db).map((c) => c.id)).toEqual(['a', 'c']);
    expect(listControllers(db, { includeStopped: true }).map((c) => c.id)).toEqual(['a', 'c', 'b']);
    expect(listControllers(db, { limit: 1 }).map((c) => c.id)).toEqual(['a']);
  });

  it('finds stale controllers at and beyond the threshold, oldest first, ignoring stopped ones', () => {
    const { db, clock } = setup();
    registerController(db, ctl('old'), clock);
    clock.advance(1_000);
    registerController(db, ctl('edge'), clock);
    registerController(db, ctl('stopped'), clock);
    markControllerStopped(db, 'stopped', 'clean exit', clock);
    clock.advance(1_000);
    registerController(db, ctl('fresh'), clock);
    clock.advance(1_000);
    // now: old is 3000 ms stale, edge and stopped 2000, fresh 1000.
    expect(listStaleControllers(db, 2_000, clock).map((c) => c.id)).toEqual(['old', 'edge']);
    expect(listStaleControllers(db, 2_001, clock).map((c) => c.id)).toEqual(['old']);
    expect(listStaleControllers(db, 10_000, clock)).toEqual([]);
    heartbeatController(db, 'old', clock);
    expect(listStaleControllers(db, 2_000, clock).map((c) => c.id)).toEqual(['edge']);
  });

  it('getController throws NOT_FOUND, findController returns null', () => {
    const { db } = setup();
    expect(codeOf(() => getController(db, 'x'))).toBe('NOT_FOUND');
    expect(findController(db, 'x')).toBeNull();
  });
});
