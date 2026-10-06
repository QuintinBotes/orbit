/** Nm3: `status` does not report state that is no longer true: controllers whose process is gone, or another run's controller as a heartbeat. */
import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { systemClock } from '../../../src/core/clock.ts';
import { registerController } from '../../../src/storage/controllers.ts';
import { acquireLease } from '../../../src/controller/run-store.ts';
import { makeLab, type Lab } from './lab.ts';

const labs: Lab[] = [];
const lab = () => {
  const l = makeLab();
  labs.push(l);
  return l;
};
afterEach(() => labs.splice(0).forEach((l) => l.close()));

const deadPid = () => Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);

describe('Nm3: stale controller state', () => {
  it('status prunes controllers whose process is gone, so none is listed as live or stale', async () => {
    const l = lab();
    l.newRun();
    registerController(l.db(), { id: 'ctl-gone', pid: deadPid(), host: hostname(), procStart: null, mode: 'foreground' }, systemClock);
    const j = JSON.parse((await l.cli(['status', '--json'])).out) as { controllers: { id: string }[] };
    expect(j.controllers).toEqual([]);
    expect((await l.cli(['status'])).out).toContain('controllers: none running');
  });

  it('a live controller stays listed', async () => {
    const l = lab();
    l.newRun();
    registerController(l.db(), { id: 'ctl-here', pid: process.pid, host: hostname(), procStart: null, mode: 'service' }, systemClock);
    const j = JSON.parse((await l.cli(['status', '--json'])).out) as { controllers: { id: string; live: boolean }[] };
    expect(j.controllers).toMatchObject([{ id: 'ctl-here', live: true }]);
  });

  it('a finished run shows no heartbeat, and an unowned run shows only a service, never another run\'s foreground controller', async () => {
    const l = lab();
    const ended = l.newRun('ended');
    l.moveTo(ended.id, ['PREFLIGHT', 'CANCELLED']);
    const idle = l.newRun('idle');
    const other = l.newRun('other');
    registerController(l.db(), { id: 'fg-other', pid: process.pid, host: hostname(), procStart: null, mode: 'foreground' }, systemClock);
    acquireLease(l.db(), other.id, 'fg-other', 60_000, systemClock);

    const endedJson = JSON.parse((await l.cli(['status', ended.id, '--json'])).out) as { heartbeat: unknown };
    expect(endedJson.heartbeat).toBeNull();
    expect((await l.cli(['status', ended.id])).out).not.toMatch(/live\)/);
    const idleJson = JSON.parse((await l.cli(['status', idle.id, '--json'])).out) as { heartbeat: unknown };
    expect(idleJson.heartbeat).toBeNull();
    expect((await l.cli(['status', idle.id])).out).toMatch(/heartbeat: no controller is running/);

    registerController(l.db(), { id: 'svc', pid: process.pid, host: hostname(), procStart: null, mode: 'service' }, systemClock);
    const withService = JSON.parse((await l.cli(['status', idle.id, '--json'])).out) as { heartbeat: { controller_id: string } };
    expect(withService.heartbeat.controller_id).toBe('svc');
    const owner = JSON.parse((await l.cli(['status', other.id, '--json'])).out) as { heartbeat: { controller_id: string } };
    expect(owner.heartbeat.controller_id).toBe('fg-other');
  });
});
