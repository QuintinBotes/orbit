/**
 * NM5 and the P28 resume leftovers: the advice a command prints must name a command that actually continues the run.
 * Without a controller, `orbit resume <id>` only clears a flag and the run sits idle, so it is refused (with no state
 * change) and the advice names `--foreground`; with one, the plain command is right.
 */
import { EventEmitter } from 'node:events';
import { hostname } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { systemClock } from '../../../src/core/clock.ts';
import { acquireLease, getRun, releaseLease } from '../../../src/controller/run-store.ts';
import { memoryIo } from '../../../src/cli/io.ts';
import { registerController } from '../../../src/storage/controllers.ts';
import { defineCheck, makeLab, type Lab } from './lab.ts';

const hooks = vi.hoisted(() => ({ fake: false, start: null as null | ((runId: string) => Promise<void>), stops: [] as string[] }));
vi.mock('../../../src/controller/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/controller/index.ts')>();
  class Fake {
    private readonly runId: string;
    constructor(opts: { runId: string }) {
      this.runId = opts.runId;
    }
    async start(): Promise<void> {
      await hooks.start?.(this.runId);
    }
    async stop(reason: string): Promise<void> {
      hooks.stops.push(reason);
    }
  }
  const Wrapper = function (this: unknown, opts: ConstructorParameters<typeof actual.Controller>[0]) {
    return hooks.fake ? new Fake(opts as never) : new actual.Controller(opts);
  } as unknown as typeof actual.Controller;
  return { ...actual, Controller: Wrapper };
});

const labs: Lab[] = [];
const lab = () => {
  const l = makeLab();
  labs.push(l);
  return l;
};
beforeEach(() => {
  hooks.fake = false;
  hooks.start = null;
  hooks.stops = [];
});
afterEach(() => labs.splice(0).forEach((l) => l.close()));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not reached');
    await sleep(5);
  }
}
const withService = (l: Lab) => registerController(l.db(), { id: 'svc-1', pid: process.pid, host: hostname(), mode: 'service' }, systemClock);

describe('NM5: a bare resume with no controller', () => {
  it('refuses, changes nothing, and names the command that continues the run', async () => {
    const l = lab();
    const run = l.newRun();
    l.moveTo(run.id, ['PREFLIGHT']);
    await l.cli(['pause', run.id]);
    const r = await l.cli(['resume', run.id]);
    expect(r.code, r.out).toBe(7);
    expect(r.err).toContain(`orbit resume ${run.id} --foreground`);
    expect(r.err).toMatch(/no controller is running/i);
    expect(getRun(l.db(), run.id).paused).toBe(true);
  });

  it('does not touch a BLOCKED run either: the state change comes only after a controller is there to carry it', async () => {
    const l = lab();
    const run = l.newRun();
    l.moveTo(run.id, ['PREFLIGHT', 'BLOCKED']);
    const r = await l.cli(['resume', run.id]);
    expect(r.code).toBe(7);
    expect(getRun(l.db(), run.id).state).toBe('BLOCKED');
    expect(l.db().get('SELECT 1 AS x FROM events WHERE run_id = ? AND type = ?', run.id, 'run.resumed')).toBeUndefined();
  });

  it('is allowed with --detach, which says what it does without a service', async () => {
    const l = lab();
    const run = l.newRun();
    await l.cli(['pause', run.id]);
    const r = await l.cli(['resume', run.id, '--detach']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`orbit resume ${run.id} --foreground`);
    expect(getRun(l.db(), run.id).paused).toBe(false);
  });

  it('goes through when a service is running', async () => {
    const l = lab();
    const run = l.newRun();
    await l.cli(['pause', run.id]);
    withService(l);
    const r = await l.cli(['resume', run.id]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('unpaused');
    expect(r.out).not.toMatch(/No controller is running/);
  });

  it('goes through when a live foreground controller owns the run, which is a controller as much as the service is', async () => {
    const l = lab();
    const run = l.newRun();
    l.moveTo(run.id, ['PREFLIGHT']);
    await l.cli(['pause', run.id]);
    registerController(l.db(), { id: 'fg-1', pid: process.pid, host: hostname(), mode: 'foreground' }, systemClock);
    acquireLease(l.db(), run.id, 'fg-1', 60_000, systemClock);
    const r = await l.cli(['resume', run.id]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).not.toMatch(/No controller is running/);
    expect(getRun(l.db(), run.id).paused).toBe(false);
    releaseLease(l.db(), run.id, 'fg-1');
  });

  it('a live foreground controller of another run does not count', async () => {
    const l = lab();
    const run = l.newRun();
    await l.cli(['pause', run.id]);
    registerController(l.db(), { id: 'fg-2', pid: process.pid, host: hostname(), mode: 'foreground' }, systemClock);
    const r = await l.cli(['resume', run.id]);
    expect(r.code).toBe(7);
  });

  it('on a terminal, drives the run in the foreground instead of refusing, and says why', async () => {
    const l = lab();
    await l.cli(['init']);
    defineCheck(l);
    const run = l.newRun();
    await l.cli(['pause', run.id]);
    hooks.fake = true;
    hooks.start = async () => {};
    const io = memoryIo();
    (io as { stdoutIsTty: boolean }).stdoutIsTty = true;
    const r = await l.cli(['resume', run.id], { io, seams: { pollMs: 5, controllerDeps: () => ({}) as never, signals: new EventEmitter() } });
    expect(io.stdout).toContain('no service is running, so driving it here');
    expect(io.stdout).toContain('driving it in the foreground (Ctrl-C pauses it)');
    expect(r.code).not.toBe(7);
    expect(getRun(l.db(), run.id).paused).toBe(false);
  });
});

describe('NM5: the advice of the foreground driver', () => {
  it('names --foreground in the Ctrl-C advice when no service is running, and the plain command when one is', async () => {
    for (const service of [false, true]) {
      const l = lab();
      await l.cli(['init']);
      defineCheck(l);
      if (service) withService(l);
      hooks.fake = true;
      hooks.stops = [];
      hooks.start = async () => {
        await until(() => hooks.stops.length > 0);
      };
      const signals = new EventEmitter();
      const done = l.cli(['run', '--goal', 'g', '--foreground'], { seams: { pollMs: 5, controllerDeps: () => ({}) as never, admission: async () => null, signals } });
      await until(() => signals.listenerCount('SIGINT') === 1);
      signals.emit('SIGINT');
      const r = await done;
      expect(r.code).toBe(20);
      const id = /^run (orb-\S+) started/m.exec(r.out)![1]!;
      expect(r.err).toContain(service ? `continue with: orbit resume ${id}\n` : `continue with: orbit resume ${id} --foreground\n`);
      expect(r.out).toContain(service ? `continue with "orbit resume ${id}"` : `continue with "orbit resume ${id} --foreground"`);
    }
  });
});
