/**
 * The worker shim, run in this process. The shim normally runs as its own
 * session leader and signals its whole process group, so these tests give it
 * a fake `host` (group signals become signals to the one provider child, the
 * group listing and the signal source are scripted) and a real provider
 * process. Nothing here signals the test runner's own group.
 */
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EXIT_FILE,
  LOG_FILE,
  PID_FILE,
  STDERR_FILE,
  argvHash,
  groupMembers,
  parseShimArgs,
  readExitRecord,
  readFrom,
  readPgid,
  readPidRecord,
  runShim,
  shimArgs,
  shimMain,
  type ExitRecord,
  type ProcessEntry,
  type ShimHost,
  type ShimOptions,
} from '../../../src/adapters/shim.ts';
import * as proc from '../../../src/core/proc.ts';

vi.mock('../../../src/core/proc.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/proc.ts')>();
  return { ...actual, processStartTime: vi.fn(actual.processStartTime) };
});

const dirs: string[] = [];
function tmp(prefix = 'orbit-shimcov-'): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NODE = process.execPath;
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not reached');
    await sleepMs(10);
  }
}

/** A provider that ends on SIGINT and SIGTERM only when `quitOn` says so, and otherwise ignores them. */
/** Readiness is a marker file the provider writes itself: the shim copies the provider's output into the log from its own event loop, which waitForUp holds still. */
const stubborn = `process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.env.ORBIT_TEST_READY&&require('node:fs').writeFileSync(process.env.ORBIT_TEST_READY,'1');console.log('up')`;
const polite = `process.on('SIGINT',()=>process.exit(0));process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);process.env.ORBIT_TEST_READY&&require('node:fs').writeFileSync(process.env.ORBIT_TEST_READY,'1');console.log('up')`;
const plain = `setInterval(()=>{},1000)`;

interface Rig {
  dir: string;
  signals: string[];
  /** Signals the sweep sent to single processes, as [pid, signal]. */
  processSignals: Array<[number, string]>;
  members: number[][];
  emitter: EventEmitter;
  host: ShimHost;
  /** True when the provider announces readiness with a line, so signals are held back until it does. */
  awaitsUp: boolean;
  childPid(): number;
  started(): Promise<void>;
  run(over?: Partial<ShimOptions> & { argv?: string[] }): Promise<ExitRecord>;
}

const READY_FILE = '.ready';
const READY_ENV = 'ORBIT_TEST_READY';

/**
 * Block until the provider has installed its handlers and written its readiness marker. A signal sent before
 * that would end it by the default action, so a stubborn or polite provider would race its own start-up under
 * load. Blocking here is safe: the provider is another process and writes the marker itself. It must not wait
 * on the log: the shim moves provider output into the log from its own event loop, which this wait holds still.
 */
function waitForUp(dir: string, ms = 20_000): void {
  const end = Date.now() + ms;
  const cell = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < end) {
    try {
      if (existsSync(join(dir, READY_FILE))) return;
    } catch {
      /* nothing to read yet */
    }
    Atomics.wait(cell, 0, 0, 5);
  }
  throw new Error('the provider never reported readiness');
}

function rig(
  behaviour: {
    throwOn?: string[];
    echoSelf?: boolean;
    pgid?: number | null;
    deliver?: boolean;
    processes?: (rig: Rig) => ProcessEntry[] | null;
    onGroupSignal?: (pgid: number, signal: NodeJS.Signals) => void;
  } = {},
): Rig {
  const dir = tmp();
  const signals: string[] = [];
  const processSignals: Array<[number, string]> = [];
  const emitter = new EventEmitter();
  const members: number[][] = [];
  const r: Rig = {
    dir,
    signals,
    processSignals,
    members,
    emitter,
    host: {
      pgidOf: () => (behaviour.pgid === undefined ? process.pid : behaviour.pgid),
      signalGroup: (_pgid, sig) => {
        signals.push(sig);
        behaviour.onGroupSignal?.(_pgid, sig);
        if (behaviour.throwOn?.includes(sig)) throw new Error('no such group');
        if (behaviour.deliver !== false) {
          if (r.awaitsUp) waitForUp(dir);
          const pid = r.childPid();
          if (pid) {
            try {
              process.kill(pid, sig);
            } catch {
              /* already gone */
            }
          }
        }
        if (behaviour.echoSelf && (sig === 'SIGINT' || sig === 'SIGTERM')) queueMicrotask(() => emitter.emit(sig));
      },
      signalProcess: (pid, sig) => {
        processSignals.push([pid, sig]);
      },
      groupMembers: () => members.shift() ?? [],
      processes: () => behaviour.processes?.(r) ?? null,
      onSignal: (sig, listener) => {
        emitter.on(sig, listener);
      },
    },
    awaitsUp: false,
    childPid: () => readPidRecord(dir)?.childPid ?? 0,
    started: () => until(() => (readPidRecord(dir)?.childPid ?? 0) > 0),
    run(over = {}) {
      const { argv = [NODE, '-e', 'process.exit(0)'], ...rest } = over;
      r.awaitsUp = argv.some((a) => a.includes("console.log('up')"));
      return runShim({ workerDir: dir, argv, env: { PATH: process.env.PATH, [READY_ENV]: join(dir, READY_FILE) }, cwd: dir, timeoutMs: 0, graceMs: 50, host: r.host, ...rest });
    },
  };
  return r;
}

describe('runShim: a provider that runs to its end', () => {
  it('records pid.json and exit.json, keeps the provider output in the log files and notes the first output', async () => {
    const r = rig();
    writeFileSync(join(r.dir, 'prompt.md'), 'hello from the prompt');
    const rec = await r.run({
      argv: [NODE, '-e', "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log(JSON.stringify({type:'echo',s}));console.error('warn');process.exit(3)})"],
      stdinPath: join(r.dir, 'prompt.md'),
      sessionId: 'sess-1',
    });
    expect(rec).toMatchObject({ version: 1, code: 3, signal: null, timedOut: false, cancelled: false, aborted: null, error: null, escalation: [] });
    expect(typeof rec.firstOutputAt).toBe('number');
    expect(rec.endedAt).toBeGreaterThanOrEqual(rec.startedAt);
    expect(readExitRecord(r.dir)).toEqual(rec);
    expect(readFileSync(join(r.dir, LOG_FILE), 'utf8')).toContain('"s":"hello from the prompt"');
    expect(readFileSync(join(r.dir, STDERR_FILE), 'utf8')).toContain('warn');
    const pid = readPidRecord(r.dir)!;
    expect(pid).toMatchObject({ version: 1, shimPid: process.pid, pgid: process.pid, sessionId: 'sess-1' });
    expect(pid.childPid).toBeGreaterThan(0);
    expect(pid.shimStart).not.toBeNull();
    expect(statSync(join(r.dir, PID_FILE)).mode & 0o777).toBe(0o600);
    expect(statSync(join(r.dir, EXIT_FILE)).mode & 0o777).toBe(0o600);
  });

  it('records an argv hash that tells one launch from another and a null session when none is given', async () => {
    const r = rig();
    const argv = [NODE, '-e', 'process.exit(0)'];
    await r.run({ argv });
    const pid = readPidRecord(r.dir)!;
    expect(pid.argvHash).toBe(argvHash(argv));
    expect(pid.argvHash).not.toBe(argvHash([...argv, 'x']));
    expect(pid.sessionId).toBeNull();
  });

  it('reports no first output when the provider writes nothing, and ignores output that predates the launch', async () => {
    const r = rig();
    writeFileSync(join(r.dir, LOG_FILE), '{"old":true}\n');
    const rec = await r.run({ argv: [NODE, '-e', 'process.exit(0)'] });
    expect(rec.firstOutputAt).toBeNull();
    expect(readFileSync(join(r.dir, LOG_FILE), 'utf8')).toBe('{"old":true}\n');
  });

  it('polls until output arrives, so a late first line still gets a timestamp', async () => {
    const r = rig();
    const rec = await r.run({ argv: [NODE, '-e', "setTimeout(()=>{console.log('late');},150);setTimeout(()=>process.exit(0),400)"] });
    expect(typeof rec.firstOutputAt).toBe('number');
  });

  it('drops environment entries that are not strings', async () => {
    const r = rig();
    await r.run({
      argv: [NODE, '-e', "console.log(JSON.stringify({a:process.env.ORBIT_T_A??null,b:process.env.ORBIT_T_B??null}))"],
      env: { PATH: process.env.PATH, ORBIT_T_A: 'yes', ORBIT_T_B: undefined },
    });
    expect(readFileSync(join(r.dir, LOG_FILE), 'utf8').trim()).toBe('{"a":"yes","b":null}');
  });

  it.skipIf(process.platform !== 'darwin')('sweeps a remembered descendant after it is reparented into another process group', async () => {
    const escapedPid = 987_654;
    let escapedAlive = true;
    let captures = 0;
    const r = rig({
      processes: (current) => {
        const childPid = current.childPid();
        if (!childPid) return [];
        captures++;
        if (captures === 1) {
          return [
            { pid: childPid, ppid: process.pid, pgid: process.pid, start: 'provider-start' },
            { pid: escapedPid, ppid: childPid, pgid: escapedPid, start: 'escaped-start' },
          ];
        }
        return escapedAlive ? [{ pid: escapedPid, ppid: 1, pgid: escapedPid, start: 'escaped-start' }] : [];
      },
      onGroupSignal: (pgid, signal) => {
        if (pgid === escapedPid && signal === 'SIGTERM') escapedAlive = false;
      },
    });
    const rec = await r.run({ argv: [NODE, '-e', 'process.exit(0)'], graceMs: 50 });
    expect(rec).toMatchObject({ code: 0, signal: null, escalation: [] });
    expect(captures).toBeGreaterThan(1);
    expect(r.signals).toContain('SIGTERM');
    expect(escapedAlive).toBe(false);
  });
  it.skipIf(process.platform !== 'darwin')('signals a descendant alone when it joins a group it does not lead', async () => {
    const joinedPid = 987_655;
    const foreignLeader = 987_600;
    let joinedAlive = true;
    const groupSignals: Array<[number, string]> = [];
    const r = rig({
      processes: (current) => {
        const childPid = current.childPid();
        if (!childPid) return [];
        return [
          { pid: childPid, ppid: process.pid, pgid: process.pid, start: 'provider-start' },
          { pid: foreignLeader, ppid: 1, pgid: foreignLeader, start: 'leader-start' },
          ...(joinedAlive ? [{ pid: joinedPid, ppid: childPid, pgid: foreignLeader, start: 'joined-start' }] : []),
        ];
      },
      onGroupSignal: (pgid, signal) => {
        groupSignals.push([pgid, signal]);
      },
    });
    const rec = await r.run({ argv: [NODE, '-e', 'setTimeout(()=>process.exit(0),300)'], graceMs: 50 });
    expect(rec).toMatchObject({ code: 0, signal: null });
    expect(groupSignals.some(([pgid]) => pgid === foreignLeader)).toBe(false);
    expect(r.processSignals).toContainEqual([joinedPid, 'SIGTERM']);
    expect(r.processSignals.every(([pid]) => pid === joinedPid)).toBe(true);
  });
});

describe('runShim: a provider that cannot start', () => {
  it('records the errno when the command does not exist, and still writes pid.json', async () => {
    const r = rig();
    const rec = await r.run({ argv: ['/nonexistent/orbit-provider'] });
    expect(rec).toMatchObject({ code: null, signal: null, error: 'could not start /nonexistent/orbit-provider: ENOENT' });
    expect(readPidRecord(r.dir)).toMatchObject({ childPid: null, childStart: null });
    expect(readExitRecord(r.dir)?.error).toMatch(/ENOENT/);
  });

  it('records the errno when the prompt file cannot be opened', async () => {
    const r = rig();
    const rec = await r.run({ stdinPath: join(r.dir, 'missing-prompt.md') });
    expect(rec.error).toBe(`could not start ${NODE}: ENOENT`);
    expect(rec.code).toBeNull();
    expect(readPidRecord(r.dir)?.childPid).toBeNull();
  });

  it('keeps a pid.json left by an earlier launch in the same directory when the new provider cannot start', async () => {
    const r = rig();
    writeFileSync(join(r.dir, PID_FILE), JSON.stringify({ version: 1, shimPid: 1, pgid: 1, childPid: 9, argvHash: 'sha256:old' }));
    const rec = await r.run({ argv: ['/nonexistent/orbit-provider'] });
    expect(rec.error).toMatch(/ENOENT/);
    expect(readPidRecord(r.dir)).toMatchObject({ shimPid: 1, childPid: 9, argvHash: 'sha256:old' });
  });

  it('creates a missing worker directory for its records when the log cannot be opened there', async () => {
    const base = tmp();
    const dir = join(base, 'not-yet');
    const rec = await runShim({ workerDir: dir, argv: [NODE, '-e', '0'], env: {}, cwd: base, timeoutMs: 0, host: { pgidOf: () => process.pid } });
    expect(rec.error).toMatch(/ENOENT/);
    expect(rec.firstOutputAt).toBeNull();
    expect(existsSync(join(dir, EXIT_FILE))).toBe(true);
    expect(readPidRecord(dir)?.childPid).toBeNull();
  });

  it('leaves shimStart null when the shim cannot read its own start time', async () => {
    vi.mocked(proc.processStartTime).mockImplementation(() => {
      throw new Error('no ps');
    });
    const r = rig();
    await r.run();
    const pid = readPidRecord(r.dir)!;
    expect(pid.shimStart).toBeNull();
    expect(pid.childStart).toBeNull();
    expect(pid.childPid).toBeGreaterThan(0);
  });
});

describe('runShim: preconditions', () => {
  it('refuses to run unless the process leads its own group', () => {
    const r = rig({ pgid: process.pid + 1 });
    expect(() => r.run()).toThrow(/must lead its own process group/);
    const none = rig({ pgid: null });
    expect(() => none.run()).toThrow(/pgid null/);
  });

  it('refuses an empty provider command', () => {
    const r = rig();
    expect(() => r.run({ argv: [] })).toThrow(/needs a provider command/);
    expect(() => r.run({ argv: [''] })).toThrow(/needs a provider command/);
  });
});

describe('runShim: timeout and escalation', () => {
  it('ends a provider that outlives its timeout with SIGINT first', async () => {
    const r = rig({ echoSelf: true });
    const rec = await r.run({ argv: [NODE, '-e', plain], timeoutMs: 150 });
    expect(rec).toMatchObject({ timedOut: true, cancelled: false, signal: 'SIGINT', escalation: ['SIGINT'] });
    // The shim received its own group signal and swallowed it instead of treating it as a cancellation.
    expect(r.signals).toEqual(['SIGINT']);
  });

  it('goes through SIGINT, SIGTERM and SIGKILL for a provider that ignores both, writing exit.json before the kill', async () => {
    const r = rig({ echoSelf: true });
    const rec = await r.run({ argv: [NODE, '-e', stubborn], timeoutMs: 100, graceMs: 80 });
    expect(rec).toMatchObject({ timedOut: true, cancelled: false, signal: 'SIGKILL', escalation: ['SIGINT', 'SIGTERM', 'SIGKILL'] });
    expect(r.signals).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL']);
    expect(readExitRecord(r.dir)).toEqual(rec);
  });

  it('still counts a stage whose group signal failed because the group is gone, and carries on', async () => {
    const r = rig({ throwOn: ['SIGINT'] });
    const rec = await r.run({ argv: [NODE, '-e', plain], timeoutMs: 100, graceMs: 60 });
    expect(rec.escalation).toEqual(['SIGINT', 'SIGTERM']);
    expect(rec.timedOut).toBe(true);
    expect(rec.signal).toBe('SIGTERM');
  });

  it('survives the group already being gone at the final SIGKILL', async () => {
    const r = rig({ throwOn: ['SIGKILL'] });
    const rec = await r.run({ argv: [NODE, '-e', stubborn], timeoutMs: 80, graceMs: 60 });
    expect(rec.escalation).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL']);
    expect(rec.signal).toBe('SIGKILL');
    expect(readExitRecord(r.dir)?.escalation).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL']);
    // The provider outlived the shim's record; when it does end, the late exit changes nothing.
    process.kill(r.childPid(), 'SIGKILL');
    await sleepMs(150);
    expect(readExitRecord(r.dir)).toEqual(rec);
  });

  it('splits a timeout longer than a timer can hold and still fires at the end', async () => {
    const real = globalThis.setTimeout;
    const delays: number[] = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      // Shrink the maximal timer so the test does not wait 24 days.
      return real(fn, ms === 2_147_483_647 ? 5 : ms);
    }) as unknown as typeof setTimeout);
    const r = rig();
    const rec = await r.run({ argv: [NODE, '-e', plain], timeoutMs: 2_147_483_647 + 60, graceMs: 50 });
    expect(delays).toContain(2_147_483_647);
    expect(delays).toContain(60);
    expect(rec).toMatchObject({ timedOut: true, escalation: ['SIGINT'] });
  });

  it('does not start a second escalation while one is running', async () => {
    const r = rig();
    const done = r.run({ argv: [NODE, '-e', stubborn], timeoutMs: 60, graceMs: 200 });
    await r.started();
    await until(() => r.signals.length === 1);
    r.emitter.emit('SIGTERM');
    const rec = await done;
    expect(rec.timedOut).toBe(true);
    expect(rec.cancelled).toBe(true);
    // One ladder: SIGINT from the timeout, then SIGTERM and SIGKILL; the external SIGTERM added none of its own.
    expect(rec.escalation).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL']);
  });
});

describe('runShim: the real process-level defaults', () => {
  it('uses the real group probe, group signal, group listing and signal registration unless told otherwise', async () => {
    // Without a host the shim looks up its own group, which is not its own here.
    const dir = tmp();
    expect(() => runShim({ workerDir: dir, argv: [NODE, '-e', '0'], env: {}, cwd: dir, timeoutMs: 0 })).toThrow(/must lead its own process group/);

    // With only the group probe replaced, the remaining defaults are real; process.on and process.kill are
    // intercepted so no handler is installed on, and no group signal leaves, the test runner.
    const handlers: string[] = [];
    const killed: Array<[number, string | number | undefined]> = [];
    vi.spyOn(process, 'on').mockImplementation(((ev: string) => {
      handlers.push(ev);
      return process;
    }) as typeof process.on);
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
      killed.push([pid, sig]);
      return true;
    }) as typeof process.kill);
    const done = runShim({ workerDir: dir, argv: [NODE, '-e', stubborn], env: {}, cwd: dir, timeoutMs: 80, graceMs: 40, host: { pgidOf: () => process.pid } });
    const rec = await done;
    const childPid = readPidRecord(dir)!.childPid!;
    vi.mocked(process.kill).mockRestore();
    process.kill(childPid, 'SIGKILL');
    expect(handlers).toEqual(expect.arrayContaining(['SIGINT', 'SIGTERM', 'SIGHUP']));
    expect(killed.filter(([pid]) => pid === -process.pid)).toEqual([[-process.pid, 'SIGINT'], [-process.pid, 'SIGTERM'], [-process.pid, 'SIGKILL']]);
    // The faked group is not the child's real one, so on macOS the sweep sees the child outside the shim
    // group. Its real group is led by the test runner, not by a descendant, so only the child itself is signalled.
    expect(killed.filter(([pid]) => pid !== -process.pid).every(([pid]) => pid === childPid)).toBe(true);
    expect(rec.escalation).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL']);
  });
});

describe('runShim: the default group listing', () => {
  it('asks the real ps about the group when the provider ends, and signals only that group', async () => {
    const dir = tmp();
    const killed: Array<[number, string | number | undefined]> = [];
    vi.spyOn(process, 'on').mockImplementation((() => process) as typeof process.on);
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
      killed.push([pid, sig]);
      return true;
    }) as typeof process.kill);
    const rec = await runShim({ workerDir: dir, argv: [NODE, '-e', 'process.exit(0)'], env: {}, cwd: dir, timeoutMs: 0, graceMs: 20, host: { pgidOf: () => process.pid } });
    expect(rec).toMatchObject({ code: 0, error: null });
    // Whatever else shares this test runner's group is treated as leftovers; no signal went anywhere else.
    expect(killed.every(([pid]) => pid === -process.pid)).toBe(true);
    expect(rec.escalation.length).toBe(killed.length);
  });
});

describe('runShim: signals from outside', () => {
  it('forwards SIGINT to a provider that ends its turn on it, and records the cancellation', async () => {
    const r = rig();
    const done = r.run({ argv: [NODE, '-e', polite], graceMs: 100 });
    await r.started();
    await until(() => existsSync(join(r.dir, LOG_FILE)) && readFileSync(join(r.dir, LOG_FILE), 'utf8').includes('up'));
    r.emitter.emit('SIGINT');
    const rec = await done;
    expect(rec).toMatchObject({ cancelled: true, timedOut: false, code: 0, escalation: [] });
  });

  it('turns SIGHUP into SIGTERM for the provider', async () => {
    const r = rig();
    const done = r.run({ argv: [NODE, '-e', polite], graceMs: 100 });
    await r.started();
    await until(() => readFileSync(join(r.dir, LOG_FILE), 'utf8').includes('up'));
    r.emitter.emit('SIGHUP');
    const rec = await done;
    expect(rec).toMatchObject({ cancelled: true, code: 0, escalation: [] });
  });

  it('after SIGINT the stubborn provider gets SIGTERM then SIGKILL, each after the grace period', async () => {
    const r = rig();
    const done = r.run({ argv: [NODE, '-e', stubborn], graceMs: 80 });
    await r.started();
    await until(() => readFileSync(join(r.dir, LOG_FILE), 'utf8').includes('up'));
    r.emitter.emit('SIGINT');
    const rec = await done;
    expect(rec).toMatchObject({ cancelled: true, escalation: ['SIGTERM', 'SIGKILL'], signal: 'SIGKILL' });
  });

  it('after SIGTERM the stubborn provider goes straight to SIGKILL after the grace period', async () => {
    const r = rig();
    const done = r.run({ argv: [NODE, '-e', stubborn], graceMs: 80 });
    await r.started();
    await until(() => readFileSync(join(r.dir, LOG_FILE), 'utf8').includes('up'));
    r.emitter.emit('SIGTERM');
    const rec = await done;
    expect(rec).toMatchObject({ cancelled: true, escalation: ['SIGKILL'], signal: 'SIGKILL' });
  });

  it('ignores a signal that arrives after the provider has ended', async () => {
    const r = rig();
    const rec = await r.run();
    r.emitter.emit('SIGTERM');
    r.emitter.emit('SIGINT');
    expect(readExitRecord(r.dir)).toEqual(rec);
    expect(readExitRecord(r.dir)?.cancelled).toBe(false);
    expect(r.signals).toEqual([]);
  });
});

describe('runShim: abort patterns', () => {
  it('cancels the provider on the first output line that matches a pattern and records which one', async () => {
    const r = rig();
    const script = [
      "console.log('not json at all');",
      "console.log('{broken json');",
      "console.log('[1,2,3]');",
      "console.log(JSON.stringify({type:'system',subtype:'init'}));",
      "console.log(JSON.stringify({type:'system',subtype:'api_retry',error:'authentication_failed'}));",
      'setInterval(()=>{},1000)',
    ].join('');
    const rec = await r.run({
      argv: [NODE, '-e', script],
      abortOn: [{ type: 'result', is_error: 'true' }, { type: 'system', error: 'authentication_failed' }],
    });
    expect(rec.aborted).toBe(JSON.stringify({ type: 'system', error: 'authentication_failed' }));
    expect(rec).toMatchObject({ timedOut: false, cancelled: false, signal: 'SIGINT', escalation: ['SIGINT'] });
  }, 15_000);

  it('reassembles a line that was written in two pieces across polls', async () => {
    const r = rig();
    const script = "process.stdout.write('{\"type\":\"sys');setTimeout(()=>process.stdout.write('tem\",\"error\":\"boom\"}\\n'),450);setInterval(()=>{},1000)";
    const rec = await r.run({ argv: [NODE, '-e', script], abortOn: [{ error: 'boom' }] });
    expect(rec.aborted).toBe('{"error":"boom"}');
  }, 15_000);

  it('keeps watching while nothing matches, and stops once the provider ended on its own', async () => {
    const r = rig();
    const rec = await r.run({ argv: [NODE, '-e', "console.log(JSON.stringify({type:'ok'}));setTimeout(()=>process.exit(0),500)"], abortOn: [{ type: 'never' }] });
    expect(rec).toMatchObject({ aborted: null, code: 0, escalation: [] });
  });

  it('stops scanning while an escalation is already running', async () => {
    const r = rig();
    const rec = await r.run({ argv: [NODE, '-e', stubborn], abortOn: [{ type: 'never' }], timeoutMs: 100, graceMs: 450 });
    expect(rec).toMatchObject({ timedOut: true, aborted: null, escalation: ['SIGINT', 'SIGTERM', 'SIGKILL'] });
  }, 15_000);

  it('keeps polling when the log cannot be read, and the provider still ends on cancellation', async () => {
    const r = rig();
    const done = r.run({ argv: [NODE, '-e', polite], abortOn: [{ type: 'never' }], graceMs: 100 });
    await r.started();
    await until(() => readFileSync(join(r.dir, LOG_FILE), 'utf8').includes('up'));
    rmSync(join(r.dir, LOG_FILE));
    await sleepMs(500);
    r.emitter.emit('SIGINT');
    const rec = await done;
    expect(rec).toMatchObject({ aborted: null, cancelled: true, code: 0 });
  }, 15_000);

  it('does not watch at all with an empty pattern list', async () => {
    const r = rig();
    const rec = await r.run({ argv: [NODE, '-e', "console.log(JSON.stringify({type:'system',error:'x'}))"], abortOn: [] });
    expect(rec.aborted).toBeNull();
  });
});

describe('runShim: helpers the provider leaves behind', () => {
  function fakeClock() {
    let t = 1_000;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  }

  it('lets helpers finish when they end within the grace period, after one SIGTERM to the group', async () => {
    const r = rig({ deliver: false });
    r.members.push([process.pid, 4242], [process.pid, 4242], [process.pid]);
    const rec = await r.run({ clock: fakeClock() });
    expect(rec).toMatchObject({ code: 0, escalation: ['SIGTERM'], signal: null });
    expect(r.signals).toEqual(['SIGTERM']);
  });

  it('kills the group when helpers are still there after the grace period, keeping the provider\'s own exit', async () => {
    const r = rig({ deliver: false });
    for (let i = 0; i < 100; i++) r.members.push([4242]);
    const rec = await r.run({ clock: fakeClock(), argv: [NODE, '-e', 'process.exit(5)'] });
    expect(rec).toMatchObject({ code: 5, signal: null, escalation: ['SIGTERM', 'SIGKILL'] });
    expect(r.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(readExitRecord(r.dir)).toEqual(rec);
  });

  it('does not wait when the only group member is the shim itself', async () => {
    const r = rig({ deliver: false });
    r.members.push([process.pid]);
    const rec = await r.run();
    expect(rec.escalation).toEqual([]);
    expect(r.signals).toEqual([]);
  });
});

describe('runShim: cleanup paths', () => {
  it('removes only directories Orbit made in the temp directory', async () => {
    const r = rig();
    const mine = join(tmpdir(), `orbit-shimcov-clean-${process.pid}-${Date.now()}`);
    mkdirSync(mine);
    writeFileSync(join(mine, 'settings.json'), '{}');
    const notOrbit = tmp('shimcov-keep-');
    const nested = join(r.dir, 'orbit-nested');
    mkdirSync(nested);
    await r.run({ cleanupPaths: [mine, notOrbit, nested, 'orbit-relative', join(tmpdir(), 'orbit-does-not-exist-xyz')] });
    expect(existsSync(mine)).toBe(false);
    expect(existsSync(notOrbit)).toBe(true);
    expect(existsSync(nested)).toBe(true);
  });

  it('cleans up even when the provider could not start', async () => {
    const r = rig();
    const mine = join(tmpdir(), `orbit-shimcov-fail-${process.pid}-${Date.now()}`);
    mkdirSync(mine);
    await r.run({ argv: ['/nonexistent/orbit-provider'], cleanupPaths: [mine] });
    expect(existsSync(mine)).toBe(false);
  });
});

describe('record readers', () => {
  it('return null for a missing, torn or foreign file', () => {
    const d = tmp();
    expect(readPidRecord(d)).toBeNull();
    writeFileSync(join(d, PID_FILE), '{"shimPid":');
    expect(readPidRecord(d)).toBeNull();
    writeFileSync(join(d, PID_FILE), '[1]');
    expect(readPidRecord(d)).toBeNull();
    writeFileSync(join(d, PID_FILE), '"x"');
    expect(readPidRecord(d)).toBeNull();
    writeFileSync(join(d, PID_FILE), '{"shimPid":"1","pgid":2}');
    expect(readPidRecord(d)).toBeNull();
    writeFileSync(join(d, PID_FILE), '{"shimPid":1,"pgid":2}');
    expect(readPidRecord(d)).toEqual({ shimPid: 1, pgid: 2 });
    writeFileSync(join(d, EXIT_FILE), '{"timedOut":true}');
    expect(readExitRecord(d)).toBeNull();
    writeFileSync(join(d, EXIT_FILE), '{"timedOut":true,"endedAt":5}');
    expect(readExitRecord(d)).toMatchObject({ endedAt: 5 });
  });
});

describe('readFrom', () => {
  it('reads from an offset, caps the length, and gives null for an unreadable path', () => {
    const d = tmp();
    const f = join(d, 'log');
    writeFileSync(f, 'abcdefghij');
    expect(readFrom(f, 3)?.toString()).toBe('defghij');
    expect(readFrom(f, 3, 2)?.toString()).toBe('de');
    expect(readFrom(f, 10)?.length).toBe(0);
    expect(readFrom(f, 50)?.length).toBe(0);
    expect(readFrom(join(d, 'missing'), 0)).toBeNull();
    // A directory opens but cannot be read.
    expect(readFrom(d, 0)).toBeNull();
  });
});

describe('process group helpers', () => {
  it('readPgid reads the group of a live process and null for one that does not exist', () => {
    expect(readPgid(process.pid)).toBeGreaterThan(0);
    expect(readPgid(2 ** 30)).toBeNull();
  });

  it('readPgid on linux parses /proc/<pid>/stat even when the command name holds spaces and parentheses', () => {
    const procDir = tmp();
    mkdirSync(join(procDir, '77'));
    writeFileSync(join(procDir, '77', 'stat'), '77 (we ird) name) S 1 4242 4242 0 -1 4194560');
    expect(readPgid(77, { platform: 'linux', procDir })).toBe(4242);
    mkdirSync(join(procDir, '78'));
    writeFileSync(join(procDir, '78', 'stat'), '78 (x) S 1 0 0');
    expect(readPgid(78, { platform: 'linux', procDir })).toBeNull();
    mkdirSync(join(procDir, '79'));
    writeFileSync(join(procDir, '79', 'stat'), '79 (x) S 1 abc 0');
    expect(readPgid(79, { platform: 'linux', procDir })).toBeNull();
    expect(readPgid(80, { platform: 'linux', procDir })).toBeNull();
  });

  it('readPgid with platform linux reads the real /proc by default', () => {
    expect(readPgid(process.pid, { platform: 'linux' })).toBe(process.platform === 'linux' ? readPgid(process.pid) : null);
  });

  it('groupMembers lists exactly the processes of a group, and nothing for an unused group', async () => {
    const child = spawn(NODE, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
    try {
      await until(() => child.pid !== undefined && groupMembers(child.pid).length > 0);
      expect(groupMembers(child.pid!)).toEqual([child.pid]);
      expect(groupMembers(2 ** 30)).toEqual([]);
    } finally {
      process.kill(-child.pid!, 'SIGKILL');
    }
  });

  it('groupMembers and readPgid answer empty when ps cannot run', () => {
    const saved = process.env.PATH;
    process.env.PATH = '';
    try {
      expect(groupMembers(1)).toEqual([]);
      // The linux branch reads /proc and never runs ps, so ask for the ps branch explicitly.
      expect(readPgid(process.pid, { platform: 'darwin' })).toBeNull();
    } finally {
      process.env.PATH = saved;
    }
  });
});

describe('shimArgs', () => {
  it('writes only the options that were given, provider argv last after --', () => {
    expect(shimArgs({ workerDir: '/w', timeoutMs: 7, argv: ['p', '-x'] })).toEqual(['--worker-dir', '/w', '--timeout-ms', '7', '--', 'p', '-x']);
    expect(shimArgs({ workerDir: '/w', timeoutMs: 0, graceMs: 0, sessionId: null, stdinPath: null, cwd: null, abortOn: [], cleanupPaths: [], argv: ['p'] })).toEqual(['--worker-dir', '/w', '--timeout-ms', '0', '--grace-ms', '0', '--', 'p']);
    const full = shimArgs({ workerDir: '/w', timeoutMs: 1, sessionId: 's', stdinPath: '/p', cwd: '/c', abortOn: [{ a: 'b' }], cleanupPaths: ['/orbit-x', '/orbit-y'], argv: ['p'] });
    expect(parseShimArgs(full)).toMatchObject({ sessionId: 's', stdinPath: '/p', cwd: '/c', abortOn: [{ a: 'b' }], cleanupPaths: ['/orbit-x', '/orbit-y'] });
  });
});

describe('parseShimArgs', () => {
  it('rejects a missing provider command, a dangling flag and a bad number', () => {
    expect(() => parseShimArgs(['--worker-dir', '/w', '--'])).toThrow(/expected --/);
    expect(() => parseShimArgs(['--worker-dir', '/w', '--timeout-ms', '1.5', '--', 'x'])).toThrow(/non-negative integer/);
    expect(() => parseShimArgs(['--worker-dir', '/w', '--grace-ms', 'abc', '--', 'x'])).toThrow(/non-negative integer/);
    expect(() => parseShimArgs(['--worker-dir', '/w', '--cwd', '--', 'x'])).toThrow();
    expect(() => parseShimArgs(['--worker-dir', '/w', '--abort-on', 'null', '--', 'x'])).toThrow(/JSON object/);
    expect(() => parseShimArgs(['--worker-dir', '/w', '--abort-on', '{"a":1}', '--', 'x'])).toThrow(/JSON object/);
    expect(() => parseShimArgs(['--abort-on', '{"a":"b"}', '--', 'x'])).toThrow(/absolute/);
  });

  it('defaults the optional fields', () => {
    expect(parseShimArgs(['--worker-dir', '/w', '--', 'x', 'y'])).toEqual({ workerDir: '/w', timeoutMs: 0, graceMs: 5000, sessionId: null, stdinPath: null, cwd: null, abortOn: [], cleanupPaths: [], argv: ['x', 'y'] });
  });
});

describe('shimMain', () => {
  let stderr: string;
  beforeEach(() => {
    stderr = '';
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write);
  });

  it('answers 2 with the problem on stderr when the arguments are bad', async () => {
    expect(await shimMain(['--worker-dir', 'relative', '--', 'x'])).toBe(2);
    expect(stderr).toBe('orbit shim: --worker-dir must be an absolute path\n');
    stderr = '';
    expect(await shimMain([])).toBe(2);
    expect(stderr).toMatch(/expected -- followed by the provider command/);
  });

  it('without a host it needs to lead its own process group, which a test runner does not', async () => {
    const dir = tmp();
    await expect(shimMain(['--worker-dir', dir, '--', NODE, '-e', '0'])).rejects.toThrow(/must lead its own process group/);
  });

  it('supervises the provider named after -- and answers 0 once exit.json is written', async () => {
    const dir = tmp();
    const host: Partial<ShimHost> = { pgidOf: () => process.pid, onSignal: () => {}, groupMembers: () => [] };
    const code = await shimMain(['--worker-dir', dir, '--timeout-ms', '0', '--session-id', 's9', '--cwd', dir, '--', NODE, '-e', 'console.log(process.cwd());process.exit(4)'], host);
    expect(code).toBe(0);
    expect(readExitRecord(dir)).toMatchObject({ code: 4, error: null });
    expect(readPidRecord(dir)?.sessionId).toBe('s9');
    expect(realpathSync(readFileSync(join(dir, LOG_FILE), 'utf8').trim())).toBe(dir);
  });

  it('runs the provider in the current directory when --cwd is not given, and passes --stdin through', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'p.md'), 'prompt text');
    const host: Partial<ShimHost> = { pgidOf: () => process.pid, onSignal: () => {}, groupMembers: () => [] };
    const code = await shimMain(['--worker-dir', dir, '--stdin', join(dir, 'p.md'), '--', NODE, '-e', "process.stdin.pipe(process.stdout);"], host);
    expect(code).toBe(0);
    expect(readFileSync(join(dir, LOG_FILE), 'utf8')).toBe('prompt text');
  });
});

describe('runShim: provider output is redacted before it is persisted', () => {
  // Synthetic values built at runtime so no literal credential sits in the repository.
  const TOKEN = ['ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
  const ENV_VALUE = ['opaque', 'value', 'for', 'the', 'test', '0123'].join('-');

  const provider = [
    `const T=${JSON.stringify(TOKEN)};const E=process.env.ACME_SERVICE_TOKEN;`,
    "console.log(JSON.stringify({type:'user',message:{content:[{type:'tool_result',content:'out: '+T+'\\n'}]}}));",
    "console.log(JSON.stringify({type:'user',message:{content:[{type:'tool_result',content:'API_KEY=\"abc\\\\\"def123456\" done'}]}}));",
    "console.log(JSON.stringify({type:'assistant',note:'kept as is',n:1}));",
    "console.log('plain line with '+T+' inside');",
    "console.log('env value '+E);",
    "console.error('provider error: '+T);",
    "process.stdout.write('no newline at the end '+T);",
  ].join('');

  it('writes no credential to log.jsonl or stderr.log and keeps every JSON line parseable', async () => {
    const r = rig();
    const rec = await r.run({ argv: [NODE, '-e', provider], env: { PATH: process.env.PATH, ACME_SERVICE_TOKEN: ENV_VALUE } });
    expect(rec.code).toBe(0);
    const log = readFileSync(join(r.dir, LOG_FILE), 'utf8');
    const err = readFileSync(join(r.dir, STDERR_FILE), 'utf8');
    for (const text of [log, err]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(ENV_VALUE);
      expect(text).not.toContain('def123456');
      expect(text).toContain('[REDACTED:');
    }
    const lines = log.split('\n').filter((l) => l.startsWith('{'));
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
    expect(JSON.parse(lines[2]!)).toEqual({ type: 'assistant', note: 'kept as is', n: 1 });
    expect(log).toContain('no newline at the end [REDACTED:');
    expect(err).toContain('provider error: [REDACTED:');
  });

  it('still notes the first output and leaves ordinary output byte for byte', async () => {
    const r = rig();
    const rec = await r.run({ argv: [NODE, '-e', "console.log(JSON.stringify({type:'system',subtype:'init'}));console.error('warn: slow')"] });
    expect(typeof rec.firstOutputAt).toBe('number');
    expect(readFileSync(join(r.dir, LOG_FILE), 'utf8')).toBe('{"type":"system","subtype":"init"}\n');
    expect(readFileSync(join(r.dir, STDERR_FILE), 'utf8')).toBe('warn: slow\n');
  });
});

describe('runShim: a multi-line private key block in provider output is persisted as one marker', () => {
  // Built at runtime so no key-shaped literal sits in the repository.
  const LABEL = ['OPENSSH', 'PRIVATE', 'KEY'].join(' ');
  const BEGIN = ['-----', 'BEGIN ', LABEL, '-----'].join('');
  const END = ['-----', 'END ', LABEL, '-----'].join('');
  const bodyLine = (i: number): string => Buffer.from(`acme-synthetic-key-material-${i}-`.repeat(3)).toString('base64').slice(0, 64);
  const body = (n: number): string[] => Array.from({ length: n }, (_, i) => bodyLine(i));

  /** A provider that prints the given lines, one per console call, to the chosen stream. */
  const printing = (stream: 'log' | 'error', lines: string[]): string[] => [NODE, '-e', `for (const l of ${JSON.stringify(lines)}) console.${stream}(l);`];

  it.each(['log', 'error'] as const)('removes a physical PEM block from %s and keeps the lines around it', async (stream) => {
    const r = rig();
    const lines = ['before the key', BEGIN, ...body(25), END, 'after the key'];
    await r.run({ argv: printing(stream, lines) });
    const text = readFileSync(join(r.dir, stream === 'log' ? LOG_FILE : STDERR_FILE), 'utf8');
    expect(text).not.toContain(BEGIN);
    expect(text).not.toContain(END);
    for (const l of body(25)) expect(text, l).not.toContain(l);
    expect(text).toBe('before the key\n[REDACTED:private-key]\nafter the key\n');
  });

  it('suppresses the key on both streams at once, with JSON lines around it staying valid', async () => {
    const r = rig();
    const script = [
      `const K=${JSON.stringify([BEGIN, ...body(10), END])};`,
      "console.log(JSON.stringify({type:'assistant',n:1}));",
      'for (const l of K) console.log(l);',
      'for (const l of K) console.error(l);',
      "console.log(JSON.stringify({type:'assistant',n:2}));",
    ].join('');
    await r.run({ argv: [NODE, '-e', script] });
    const log = readFileSync(join(r.dir, LOG_FILE), 'utf8');
    const err = readFileSync(join(r.dir, STDERR_FILE), 'utf8');
    for (const text of [log, err]) {
      expect(text).not.toContain(body(10)[0]!);
      expect(text).toContain('[REDACTED:private-key]');
    }
    const lines = log.split('\n').filter((l) => l.startsWith('{'));
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ type: 'assistant', n: 1 }, { type: 'assistant', n: 2 }]);
  });

  it('keeps suppressing past the bound when no END arrives, says so once, and drops the rest of the stream', async () => {
    const r = rig();
    const lines = ['before', BEGIN, ...body(260), 'a line that is never written', 'neither is this one'];
    await r.run({ argv: printing('log', lines) });
    const text = readFileSync(join(r.dir, LOG_FILE), 'utf8');
    for (const l of [BEGIN, bodyLine(0), bodyLine(199), bodyLine(259), 'a line that is never written', 'neither is this one']) expect(text, l).not.toContain(l);
    const out = text.split('\n').filter(Boolean);
    expect(out[0]).toBe('before');
    expect(out[1]).toBe('[REDACTED:private-key]');
    expect(out).toHaveLength(3);
    expect(out[2]).toMatch(/^\[REDACTED:private-key\].*no END line within 200 lines.*rest of this stream/);
  });

  it('redacts a block whose END is the last line without a newline, and text before the BEGIN on its line', async () => {
    const r = rig();
    const script = `process.stdout.write(${JSON.stringify(['key: ' + BEGIN, ...body(3), END].join('\n'))})`;
    await r.run({ argv: [NODE, '-e', script] });
    expect(readFileSync(join(r.dir, LOG_FILE), 'utf8')).toBe('key: [REDACTED:private-key]\n');
  });

  it('does not start a block for a complete JSON line that merely mentions a header', async () => {
    const r = rig();
    const lines = [JSON.stringify({ type: 'assistant', text: `the file starts with ${BEGIN}` }), JSON.stringify({ type: 'assistant', n: 2 }), 'plain tail'];
    await r.run({ argv: printing('log', lines) });
    const out = readFileSync(join(r.dir, LOG_FILE), 'utf8').split('\n').filter(Boolean);
    expect(out).toHaveLength(3);
    expect(JSON.parse(out[0]!)).toMatchObject({ type: 'assistant' });
    expect(out[0]).not.toContain(BEGIN);
    expect(JSON.parse(out[1]!)).toEqual({ type: 'assistant', n: 2 });
    expect(out[2]).toBe('plain tail');
  });
});
