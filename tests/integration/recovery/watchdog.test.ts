import { afterEach, describe, expect, it } from 'vitest';
import { getRun } from '../../../src/controller/run-store.ts';
import { watchdogTick } from '../../../src/recovery/watchdog.ts';
import { IMPLEMENTER_OUTPUT, OWNER, alive, canStripTypes, cleanupAll, clock, counterUsed, makeEnv, makeRun, seedCounters, sleep, startWorker, waitFor, workerRow } from './helpers.ts';

afterEach(cleanupAll);

describe.skipIf(!canStripTypes)('watchdog with a real worker', () => {
  it('a hung step is abandoned: the worker process group is stopped and the run moves to RECOVERING with its resume stage', async () => {
    const env = makeEnv();
    makeRun(env);
    seedCounters(env, { recovery_attempts: 3 });
    const { shimPid, childPid } = await startWorker(env, { sleepMs: 60_000, structured: IMPLEMENTER_OUTPUT });
    await sleep(350);
    const rep = await watchdogTick({
      db: env.db,
      clock,
      ownerId: OWNER,
      adapters: env.adapters,
      config: { stepTimeoutMs: { IMPLEMENTING: 300 }, stallMs: 100, graceMs: 300 },
      // The worker is silent: no log activity counts as life in this test.
      workerActivityAt: () => null,
    });
    expect(rep.findings).toMatchObject([{ kind: 'stuck-step', runId: env.runId, action: 'abandoned-to-recovering' }]);
    await waitFor(() => (!alive(shimPid) && !alive(childPid)) || null);
    expect(getRun(env.db, env.runId)).toMatchObject({ state: 'RECOVERING', resumeState: 'IMPLEMENTING' });
    expect(workerRow(env)).toMatchObject({ state: 'CANCELLED' });
    expect(counterUsed(env, 'recovery_attempts')).toBe(1);
  });

  it('a worker that keeps writing its log is not abandoned, however long the step runs', async () => {
    const env = makeEnv();
    makeRun(env);
    const { shimPid } = await startWorker(env, { sleepMs: 60_000, structured: IMPLEMENTER_OUTPUT });
    await sleep(350);
    // Default activity source: the mtime of the worker's real log file, written when the fake started.
    const rep = await watchdogTick({ db: env.db, clock, ownerId: OWNER, adapters: env.adapters, config: { stepTimeoutMs: { IMPLEMENTING: 5_000 }, stallMs: 5_000 } });
    expect(rep.findings).toEqual([]);
    expect(getRun(env.db, env.runId).state).toBe('IMPLEMENTING');
    expect(alive(shimPid)).toBe(true);
  });
});
