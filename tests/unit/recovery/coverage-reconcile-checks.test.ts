import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Proc = typeof import('../../../src/core/proc.ts');
const hooks = vi.hoisted(() => ({
  isAlive: vi.fn<Proc['isAlive']>(),
  terminateGroup: vi.fn<Proc['terminateGroup']>(),
  processInfo: vi.fn<Proc['processInfo']>(),
}));
vi.mock('../../../src/core/proc.ts', async (orig) => {
  const actual = await orig<Proc>();
  hooks.isAlive.mockImplementation(actual.isAlive);
  hooks.terminateGroup.mockImplementation(actual.terminateGroup);
  hooks.processInfo.mockImplementation(actual.processInfo);
  return { ...actual, isAlive: hooks.isAlive, terminateGroup: hooks.terminateGroup, processInfo: hooks.processInfo };
});

const { OrbitError } = await import('../../../src/core/errors.ts');
const { processStartTime, isAlive: realIsAlive, terminateGroup: realTerminate, processInfo: realInfo } = await vi.importActual<Proc>('../../../src/core/proc.ts');
const { requestCancel } = await import('../../../src/controller/run-store.ts');
const { planCheckRun, markCheckRunning } = await import('../../../src/evidence/store.ts');
const { shimPath } = await import('../../../src/evidence/check-shim.ts');
const { reconcileOnStart, stopRowProcess } = await import('../../../src/recovery/reconcile.ts');
const { makeRun, setup } = await import('./helpers.ts');
type OrbitDb = import('../../../src/storage/db.ts').OrbitDb;

const DEAD = 2_000_000_000;
const OWNER = 'ctl-1';
const kids: ChildProcess[] = [];
const dirs: string[] = [];
let base: string;

beforeEach(() => {
  hooks.isAlive.mockImplementation(realIsAlive);
  hooks.terminateGroup.mockImplementation(realTerminate);
  hooks.processInfo.mockImplementation(realInfo);
  base = mkdtempSync(join(tmpdir(), 'orbit-rcc-'));
  dirs.push(base);
});
afterEach(() => {
  for (const k of kids.splice(0)) {
    try {
      process.kill(-k.pid!, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function proc(args: string[], cmd = 'sleep'): { pid: number; start: string } {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.unref();
  kids.push(child);
  return { pid: child.pid!, start: processStartTime(child.pid!)! };
}

/** A process that ignores SIGINT and SIGTERM, so only SIGKILL ends it. */
function stubborn(): { pid: number; start: string } {
  return proc(['-e', "process.on('SIGTERM', () => {}); process.on('SIGINT', () => {}); setInterval(() => {}, 1000);"], process.execPath);
}

async function untilGone(pid: number, ms = 5_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

function openCheck(db: OrbitDb, clock: ReturnType<typeof setup>['clock'], files: { launch?: object; pid?: object; intentWrittenAt?: number }) {
  const row = planCheckRun(db, { runId: 'r1', candidateId: null, checkId: 'lint', kind: 'command', treeHash: 't', checkConfigHash: 'c', policyHash: 'sha256:x', command: ['sleep', '30'], cwd: '/repo', isolation: 'none', limitations: [] }, clock);
  markCheckRunning(db, row.id, 1, clock);
  const dir = join(base, 'run', 'baseline', 'lint');
  mkdirSync(dir, { recursive: true });
  writeFileSync(shimPath(dir, 'intent'), JSON.stringify({ token: 'tok', checkRunId: row.id, argv: ['sleep', '30'], cwd: '/repo', timeoutMs: 1000, killGraceMs: 50, maxOutputBytes: 1000, writtenAt: files.intentWrittenAt ?? Date.now() }));
  if (files.launch) writeFileSync(shimPath(dir, 'launch'), JSON.stringify({ token: 'tok', ...files.launch }));
  if (files.pid) writeFileSync(shimPath(dir, 'pid'), JSON.stringify({ token: 'tok', ...files.pid }));
  return { id: row.id, dir };
}

const reconcile = (db: OrbitDb, clock: ReturnType<typeof setup>['clock']) => reconcileOnStart({ db, ownerId: OWNER, clock, adapters: {}, graceMs: 50, runDirFor: () => join(base, 'run') });

describe('stopRowProcess when the process table cannot be read', () => {
  it('a verification that throws is unknown, never a guess', async () => {
    const s = proc(['60']);
    hooks.isAlive.mockImplementation((_pid, start) => {
      if (start != null) throw new Error('ps missing');
      return true;
    });
    expect(await stopRowProcess(50, { pid: s.pid, pgid: s.pid, procStart: s.start } as never)).toBe('unknown');
    expect(() => process.kill(s.pid, 0)).not.toThrow();
  });
});

describe('reconcile: a check of an ended run whose shim identity is in doubt', () => {
  it('without a recorded start time and an unreadable process table, the shim is not signalled and the reason is recorded', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', OWNER);
    const s = proc(['60']);
    openCheck(db, clock, { launch: { pid: s.pid, procStart: null } });
    hooks.processInfo.mockImplementation(() => {
      throw new Error('ps missing');
    });
    requestCancel(db, 'r1', 'user', clock);
    const rep = await reconcile(db, clock);
    expect(rep.runs[0]!.checks[0]).toMatchObject({ observation: 'running', terminated: false, closed: true });
    expect(rep.runs[0]!.checks[0]!.detail).toContain(`process ${s.pid} may be this check's shim, but its identity cannot be established, so it was not signalled`);
    expect(() => process.kill(s.pid, 0)).not.toThrow();
  });

  it('with a recorded start time and a failing identity check the answer is the same', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', OWNER);
    const s = proc(['60']);
    openCheck(db, clock, { launch: { pid: s.pid, procStart: s.start } });
    hooks.isAlive.mockImplementation(() => {
      throw new Error('ps missing');
    });
    requestCancel(db, 'r1', 'user', clock);
    const rep = await reconcile(db, clock);
    expect(rep.runs[0]!.checks[0]).toMatchObject({ observation: 'running', terminated: false });
    expect(rep.runs[0]!.checks[0]!.detail).toContain('identity cannot be established');
  });
});

describe('reconcile: stopping a check shim that is ours', () => {
  it('SIGTERMs the shim and then its check group, and both are gone', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', OWNER);
    const shim = proc(['60']);
    const child = proc(['60']);
    openCheck(db, clock, { launch: { pid: shim.pid, procStart: shim.start }, pid: { shimPid: shim.pid, childPid: child.pid, childPgid: child.pid, startedAt: Date.now() } });
    requestCancel(db, 'r1', 'user', clock);
    const rep = await reconcile(db, clock);
    expect(rep.runs[0]!.checks[0]).toMatchObject({ observation: 'orphan-terminated', terminated: true, closed: true });
    expect(await untilGone(shim.pid)).toBe(true);
    expect(await untilGone(child.pid)).toBe(true);
  });

  it('a shim that ignores SIGTERM is killed once the wait runs out', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', OWNER);
    const shim = stubborn();
    // Give the process time to install its handlers before the TERM arrives.
    await new Promise((r) => setTimeout(r, 400));
    openCheck(db, clock, { launch: { pid: shim.pid, procStart: shim.start } });
    requestCancel(db, 'r1', 'user', clock);
    const rep = await reconcile(db, clock);
    expect(rep.runs[0]!.checks[0]).toMatchObject({ observation: 'orphan-terminated', terminated: true });
    expect(await untilGone(shim.pid)).toBe(true);
  }, 15_000);
});

describe('reconcile: an orphaned check group whose shim died', () => {
  function lostShim(db: OrbitDb, clock: ReturnType<typeof setup>['clock']) {
    const child = proc(['60']);
    openCheck(db, clock, { pid: { shimPid: DEAD, childPid: child.pid, childPgid: child.pid, startedAt: Date.now() } });
    return child;
  }

  it('terminates the group when it is verifiably the check that was started', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', OWNER);
    const child = lostShim(db, clock);
    const rep = await reconcile(db, clock);
    expect(rep.runs[0]!.checks[0]).toMatchObject({ observation: 'lost', terminated: true });
    expect(await untilGone(child.pid)).toBe(true);
  });

  it('reports a group that cannot be signalled as not terminated', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', OWNER);
    const child = lostShim(db, clock);
    hooks.terminateGroup.mockRejectedValueOnce(new OrbitError('INTERNAL', 'refusing to signal process group', {}));
    const rep = await reconcile(db, clock);
    expect(rep.runs[0]!.checks[0]).toMatchObject({ observation: 'lost', terminated: false });
    expect(() => process.kill(child.pid, 0)).not.toThrow();
  });

  it('lets any other failure to signal surface as that run\'s error, not a silent success', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', OWNER);
    lostShim(db, clock);
    hooks.terminateGroup.mockRejectedValueOnce(new Error('EPERM'));
    const rep = await reconcile(db, clock);
    expect(rep.errors).toEqual([{ runId: 'r1', message: 'EPERM' }]);
    expect(rep.runs).toEqual([]);
  });
});
