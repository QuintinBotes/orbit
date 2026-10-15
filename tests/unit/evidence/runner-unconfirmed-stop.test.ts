/**
 * The live check runner closes an attempt's row only when its process is confirmed absent: once the shim is spawned, a
 * failed bookkeeping step, a cancellation the shim did not answer, or a lost shim ends the row only after the shim and
 * the check's group are confirmed gone. When they cannot be, the row stays open (it is what keeps the run's release from
 * removing the checkout beneath the check), the wrapper is not cleaned up, and the runner rejects with why.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Proc = typeof import('../../../src/core/proc.ts');
const hooks = vi.hoisted(() => ({ isGroupAlive: vi.fn<Proc['isGroupAlive']>() }));
vi.mock('../../../src/core/proc.ts', async (orig) => {
  const actual = await orig<Proc>();
  hooks.isGroupAlive.mockImplementation(actual.isGroupAlive);
  return { ...actual, isGroupAlive: hooks.isGroupAlive };
});

const real = await vi.importActual<Proc>('../../../src/core/proc.ts');
const { NoIsolation } = await import('../../../src/isolation/none.ts');
const { CHECK_RUN_RECORDS, runChecks } = await import('../../../src/evidence/runner.ts');
const { listCheckRuns } = await import('../../../src/evidence/store.ts');
const { nodeCheck } = await import('./fixtures.ts');
const { checkDirOf, runnerEnv, waitFor } = await import('../../integration/evidence/harness.ts');
type RunnerEnv = import('../../integration/evidence/harness.ts').RunnerEnv;
type IsolationProvider = import('../../../src/isolation/types.ts').IsolationProvider;
type WrappedCommand = import('../../../src/isolation/types.ts').WrappedCommand;
type Clock = import('../../../src/core/clock.ts').Clock;

const envs: RunnerEnv[] = [];
const markers: string[] = [];
afterEach(async () => {
  hooks.isGroupAlive.mockReset().mockImplementation(real.isGroupAlive);
  for (const m of markers.splice(0)) {
    for (const pid of real.findProcesses((line) => line.includes(m))) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  }
  for (const e of envs.splice(0)) await e.close();
});

function counting(): { provider: IsolationProvider; cleaned: () => number } {
  let cleaned = 0;
  const inner = new NoIsolation();
  const provider = {
    kind: inner.kind,
    wrap: (argv, profile, opts) => {
      const w: WrappedCommand = inner.wrap(argv, profile, opts);
      return { ...w, cleanup: () => { cleaned++; w.cleanup(); } };
    },
  } as IsolationProvider;
  return { provider, cleaned: () => cleaned };
}

/** A records.running that fails once the shim has started the check (pid.json), as a database error after the spawn would. */
function failOnceStarted(dir: string): never {
  const end = Date.now() + 10_000;
  while (!existsSync(join(dir, 'pid.json')) && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  throw new Error('database is locked');
}

async function setup(marker: string, opts: { isolation: IsolationProvider; clock?: Clock }): Promise<RunnerEnv> {
  markers.push(marker);
  const e = await runnerEnv([nodeCheck('long', `setInterval(()=>{},1000) /* ${marker} */`, { timeout_seconds: 120 })], opts);
  envs.push(e);
  return e;
}

describe('a spawned check that cannot be confirmed stopped', () => {
  it('when the attempt cannot be marked running: the row stays open, the wrapper stays, and the runner says why', async () => {
    const marker = `UNCONFIRMED-${process.pid}-${Date.now()}`;
    const c = counting();
    const e = await setup(marker, { isolation: c.provider });
    // The check's group never reads as gone: its end cannot be confirmed.
    hooks.isGroupAlive.mockReturnValue(true);
    const records = { ...CHECK_RUN_RECORDS, running: () => failOnceStarted(checkDirOf(e, 'long')) };
    await expect(runChecks({ ...e.ctx, candidate: e.candidate, checkIds: ['long'], records })).rejects.toMatchObject({ message: expect.stringMatching(/database is locked.*could not be confirmed stopped/) });
    expect(listCheckRuns(e.run.db, { runId: e.run.runId }).map((r) => r.status)).toEqual(['PLANNED']);
    expect(c.cleaned()).toBe(0);
  });

  it('when a cancellation the shim did not answer cannot be confirmed: the row stays open and the wrapper stays', async () => {
    const marker = `UNCONFIRMED-${process.pid}-${Date.now()}`;
    const c = counting();
    const ac = new AbortController();
    let e!: RunnerEnv;
    let t = 1_700_000_000_000;
    let n = 0;
    const clock: Clock = {
      now: () => (t += 20),
      async sleep(ms: number) {
        if (++n === 1) {
          await waitFor(() => existsSync(join(checkDirOf(e, 'long'), 'pid.json')));
          const { shimPid } = JSON.parse(readFileSync(join(checkDirOf(e, 'long'), 'pid.json'), 'utf8')) as { shimPid: number };
          // The shim cannot answer the cancellation, and the check's group never reads as gone.
          process.kill(shimPid, 'SIGSTOP');
          hooks.isGroupAlive.mockReturnValue(true);
          ac.abort();
        }
        t += ms;
      },
    };
    e = await setup(marker, { isolation: c.provider, clock });
    await expect(runChecks({ ...e.ctx, candidate: e.candidate, checkIds: ['long'], clock, pollMs: 20, killGraceMs: 200, signal: ac.signal })).rejects.toMatchObject({ message: expect.stringMatching(/could not be confirmed stopped/) });
    expect(listCheckRuns(e.run.db, { runId: e.run.runId }).map((r) => r.status)).toEqual(['RUNNING']);
    expect(c.cleaned()).toBe(0);
  }, 30_000);
});
