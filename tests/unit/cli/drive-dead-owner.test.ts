// `orbit resume --foreground` after the controller that owned the run was killed (kill -9) on this host: its
// lease has not expired yet, but its process is gone, so the run is not "owned by a live controller" (P16).
import { hostname } from 'node:os';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { driveForeground } from '../../../src/cli/commands/drive.ts';
import { createContext } from '../../../src/cli/context.ts';
import { memoryIo } from '../../../src/cli/io.ts';
import { systemClock } from '../../../src/core/clock.ts';
import { defaultConfig } from '../../../src/policy/config.ts';
import { acquireLease, getLease } from '../../../src/controller/run-store.ts';
import { registerController } from '../../../src/storage/controllers.ts';
import { makeLab, type Lab } from './lab.ts';

const started: string[] = [];
vi.mock('../../../src/controller/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/controller/index.ts')>();
  class Fake {
    private readonly runId: string;
    constructor(opts: { runId: string }) {
      this.runId = opts.runId;
    }
    async start(): Promise<void> {
      started.push(this.runId);
    }
    async stop(): Promise<void> {}
  }
  return { ...actual, Controller: Fake as unknown as typeof actual.Controller };
});

const labs: Lab[] = [];
afterEach(() => {
  started.splice(0);
  labs.splice(0).forEach((l) => l.close());
});

/** A pid that belonged to a process that has exited. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(r.stdout);
}

describe('driveForeground with a lease held by a dead controller', () => {
  it('proceeds when the owner is registered on this host and its process is gone', async () => {
    const l = makeLab();
    labs.push(l);
    const run = l.newRun();
    const db = l.db();
    registerController(db, { id: 'ctl-killed', pid: deadPid(), host: hostname(), procStart: null, mode: 'foreground' }, systemClock);
    acquireLease(db, run.id, 'ctl-killed', 60_000, systemClock);
    const ctx = createContext({ io: memoryIo(), cwd: l.repo, env: process.env, seams: { pollMs: 5, controllerDeps: () => ({}) as never } });
    await driveForeground(ctx, { repoRoot: l.repo, config: defaultConfig('autonomous'), db, runId: run.id, json: false, fromStart: false });
    expect(started).toEqual([run.id]);
    // The dead owner's lease is expired, so the new controller can take it over.
    expect((getLease(db, run.id)?.expiresAt ?? 0) <= Date.now()).toBe(true);
  });

  it('still refuses when the owner is alive on this host', async () => {
    const l = makeLab();
    labs.push(l);
    const run = l.newRun();
    const db = l.db();
    registerController(db, { id: 'ctl-live', pid: process.pid, host: hostname(), procStart: null, mode: 'foreground' }, systemClock);
    acquireLease(db, run.id, 'ctl-live', 60_000, systemClock);
    const ctx = createContext({ io: memoryIo(), cwd: l.repo, env: process.env, seams: { pollMs: 5, controllerDeps: () => ({}) as never } });
    await expect(driveForeground(ctx, { repoRoot: l.repo, config: defaultConfig('autonomous'), db, runId: run.id, json: false, fromStart: false })).rejects.toMatchObject({ code: 'CONCURRENT_UPDATE' });
    expect(started).toEqual([]);
  });
});
