/**
 * Nm1: a lease whose owner is a controller of this host whose process is gone is not "a live controller". `resume
 * --foreground` already knew (P16); cancel, verify, repair and the resume of a BLOCKED run take the run over at once
 * instead of waiting out the lease (40 to 60 seconds of exit 5, or of a cancellation that nothing carries out).
 */
import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createContext, withCliLease } from '../../../src/cli/context.ts';
import { memoryIo } from '../../../src/cli/io.ts';
import { systemClock } from '../../../src/core/clock.ts';
import { acquireLease, getLease, getRun } from '../../../src/controller/run-store.ts';
import { registerController } from '../../../src/storage/controllers.ts';
import { makeLab, type Lab } from './lab.ts';

const labs: Lab[] = [];
const lab = () => {
  const l = makeLab();
  labs.push(l);
  return l;
};
afterEach(() => labs.splice(0).forEach((l) => l.close()));

function deadPid(): number {
  return Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
}
function killedOwner(l: Lab, runId: string, id = 'ctl-killed'): void {
  registerController(l.db(), { id, pid: deadPid(), host: hostname(), procStart: null, mode: 'foreground' }, systemClock);
  acquireLease(l.db(), runId, id, 60_000, systemClock);
}

describe('Nm1: a dead owner does not hold the run', () => {
  it('cancel finishes the run at once', async () => {
    const l = lab();
    const run = l.newRun();
    l.moveTo(run.id, ['PREFLIGHT']);
    killedOwner(l, run.id);
    const r = await l.cli(['cancel', run.id]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).not.toMatch(/cancellation recorded/);
    expect(getRun(l.db(), run.id).state).toBe('CANCELLED');
  });

  it('cancel still only records the request when the owner is alive', async () => {
    const l = lab();
    const run = l.newRun();
    l.moveTo(run.id, ['PREFLIGHT']);
    registerController(l.db(), { id: 'ctl-live', pid: process.pid, host: hostname(), procStart: null, mode: 'foreground' }, systemClock);
    acquireLease(l.db(), run.id, 'ctl-live', 60_000, systemClock);
    const r = await l.cli(['cancel', run.id]);
    expect(r.out).toMatch(/cancellation recorded/);
    expect(getRun(l.db(), run.id).state).toBe('PREFLIGHT');
  });

  it('resuming a BLOCKED run takes it over', async () => {
    const l = lab();
    const run = l.newRun();
    l.moveTo(run.id, ['PREFLIGHT', 'BLOCKED']);
    killedOwner(l, run.id);
    const r = await l.cli(['resume', run.id, '--detach']);
    expect(r.code, r.err).toBe(0);
    expect(getRun(l.db(), run.id).state).toBe('PREFLIGHT');
  });

  it('withCliLease (used by verify and repair) takes a dead owner\'s lease, and tells a live owner\'s apart with the time to retry', async () => {
    const l = lab();
    const run = l.newRun();
    killedOwner(l, run.id);
    const ctx = createContext({ io: memoryIo(), cwd: l.repo, env: process.env });
    expect(await withCliLease(ctx, l.db(), run.id, (owner) => getLease(l.db(), run.id)?.ownerId === owner)).toBe(true);

    registerController(l.db(), { id: 'ctl-live', pid: process.pid, host: hostname(), procStart: null, mode: 'foreground' }, systemClock);
    acquireLease(l.db(), run.id, 'ctl-live', 30_000, systemClock);
    await expect(withCliLease(ctx, l.db(), run.id, () => 1)).rejects.toMatchObject({ code: 'CONCURRENT_UPDATE', message: expect.stringMatching(/\(in \d+s; retry then/) });
  });
});
