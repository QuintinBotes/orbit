import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLease, getRun } from '../../../src/controller/run-store.ts';
import { worktreeRootFor } from '../../../src/controller/context.ts';
import { markWorkerRunning, planWorker } from '../../../src/storage/workers.ts';
import { reconcileOnStart } from '../../../src/recovery/reconcile.ts';
import { DEFAULT_WATCHDOG, watchdogTick } from '../../../src/recovery/watchdog.ts';
import { makeUnitLab, OWNER, type UnitLab } from '../controller/coverage-helpers.ts';
import { counters } from './helpers.ts';

const MIN = 60_000;
const DEAD = 2_000_000_000;

let lab: UnitLab;
afterEach(() => lab?.cleanup());

const events = (type: string): { data_json: string | null }[] => lab.db.all('SELECT data_json FROM events WHERE run_id = ? AND type = ? ORDER BY id', lab.runId, type);

function checkout(): string {
  const dir = join(worktreeRootFor(lab.home, getRun(lab.db, lab.runId)), 'wrk-implementer');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'file.txt'), 'x');
  return dir;
}

function lostWorker(): void {
  const dir = join(lab.base, 'workers', 'w1');
  mkdirSync(dir, { recursive: true });
  planWorker(lab.db, { id: 'w1', runId: lab.runId, role: 'implementer', provider: 'claude', workerDir: dir, cwd: lab.repo }, lab.clock);
  markWorkerRunning(lab.db, 'w1', { pid: DEAD, pgid: DEAD, procStart: 'x' }, lab.clock);
}

describe('a run the recovery budget ends EXHAUSTED releases its worktrees, as finishRun does', () => {
  it('reconcile: a lost worker the budget cannot restart', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    counters(lab.db, lab.runId, { recovery_attempts: 0 });
    lostWorker();
    const dir = checkout();
    await reconcileOnStart({ db: lab.db, ownerId: OWNER, clock: lab.clock, adapters: {}, graceMs: 100, orbitHome: lab.home });
    expect(getRun(lab.db, lab.runId).state).toBe('EXHAUSTED');
    expect(existsSync(dir)).toBe(false);
    expect(events('worktrees.released')).toHaveLength(1);
  });

  it('reconcile: a crashed controller whose recovery attempts are spent (enterRecovery)', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    counters(lab.db, lab.runId, { recovery_attempts: 0 });
    const dir = checkout();
    lab.clock.advance(2 * 3_600_000);
    expect(acquireLease(lab.db, lab.runId, 'ctl-2', 60_000, lab.clock)).toMatchObject({ ownerId: 'ctl-2' });
    await reconcileOnStart({ db: lab.db, ownerId: 'ctl-2', clock: lab.clock, adapters: {}, graceMs: 100, orbitHome: lab.home });
    expect(getRun(lab.db, lab.runId).state).toBe('EXHAUSTED');
    expect(existsSync(dir)).toBe(false);
    expect(events('worktrees.released')).toHaveLength(1);
  });

  it('watchdog: a stuck step the budget cannot recover', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    counters(lab.db, lab.runId, { recovery_attempts: 0 });
    const dir = checkout();
    lab.clock.advance(DEFAULT_WATCHDOG.stepTimeoutMs.IMPLEMENTING! + MIN);
    acquireLease(lab.db, lab.runId, OWNER, 60_000, lab.clock);
    const rep = await watchdogTick({ db: lab.db, clock: lab.clock, ownerId: OWNER, adapters: {}, workerActivityAt: () => null, config: { graceMs: 50 }, orbitHome: lab.home });
    expect(rep.findings[0]).toMatchObject({ action: 'exhausted' });
    expect(existsSync(dir)).toBe(false);
    expect(events('worktrees.released')).toHaveLength(1);
  });

  it('a run that recovers (budget left) keeps its worktrees', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    counters(lab.db, lab.runId, { recovery_attempts: 3 });
    const dir = checkout();
    lab.clock.advance(DEFAULT_WATCHDOG.stepTimeoutMs.IMPLEMENTING! + MIN);
    acquireLease(lab.db, lab.runId, OWNER, 60_000, lab.clock);
    await watchdogTick({ db: lab.db, clock: lab.clock, ownerId: OWNER, adapters: {}, workerActivityAt: () => null, config: { graceMs: 50 }, orbitHome: lab.home });
    expect(getRun(lab.db, lab.runId).state).toBe('RECOVERING');
    expect(existsSync(dir)).toBe(true);
    expect(events('worktrees.released')).toHaveLength(0);
  });
});
