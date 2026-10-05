import type * as ChildProcess from 'node:child_process';
import type * as Fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManualClock } from '../../../src/core/clock.ts';

type Proc = typeof import('../../../src/core/proc.ts');

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

function setPlatform(p: string): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

interface Mocks {
  readFileSync: ReturnType<typeof vi.fn>;
  spawnSync: ReturnType<typeof vi.fn>;
}

/** Load a fresh copy of proc.ts (its own-pgid cache is module state) with fs and ps replaced. */
async function load(platform: string, mocks: Partial<Mocks>): Promise<Proc> {
  vi.resetModules();
  setPlatform(platform);
  const readFileSync = mocks.readFileSync ?? vi.fn(() => {
    throw Object.assign(new Error('no'), { code: 'ENOENT' });
  });
  const spawnSync = mocks.spawnSync ?? vi.fn(() => ({ status: 1, stdout: '', stderr: '' }));
  vi.doMock('node:fs', async (orig) => ({ ...(await orig<typeof Fs>()), readFileSync }));
  vi.doMock('node:child_process', async (orig) => ({ ...(await orig<typeof ChildProcess>()), spawnSync }));
  return import('../../../src/core/proc.ts');
}

/** A /proc/<pid>/stat line whose state is `state` and whose starttime (field 22) is `start`. */
function stat(comm: string, state: string, start: string): string {
  const rest = [state, ...Array.from({ length: 18 }, (_, i) => String(i + 1)), start];
  return `1234 (${comm}) ${rest.join(' ')}\n`;
}

afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform);
  vi.doUnmock('node:fs');
  vi.doUnmock('node:child_process');
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('processInfo on linux (injected /proc)', () => {
  it('parses state and start time even when comm contains spaces and parentheses', async () => {
    const readFileSync = vi.fn(() => stat('we ird) name', 'S', '987654'));
    const proc = await load('linux', { readFileSync });
    expect(proc.processInfo(1234)).toEqual({ pid: 1234, state: 'S', start: '987654' });
    expect(readFileSync).toHaveBeenCalledWith('/proc/1234/stat', 'utf8');
    expect(proc.processStartTime(1234)).toBe('987654');
  });

  it('returns null for a pid with no /proc entry (ENOENT and ESRCH)', async () => {
    for (const code of ['ENOENT', 'ESRCH']) {
      const proc = await load('linux', {
        readFileSync: vi.fn(() => {
          throw Object.assign(new Error('gone'), { code });
        }),
      });
      expect(proc.processInfo(4321)).toBeNull();
      expect(proc.processStartTime(4321)).toBeNull();
    }
  });

  it('throws INTERNAL on other read errors, naming the errno', async () => {
    const proc = await load('linux', {
      readFileSync: vi.fn(() => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      }),
    });
    expect(() => proc.processInfo(4321)).toThrow(expect.objectContaining({ code: 'INTERNAL', message: expect.stringContaining('EACCES') }));
  });

  it('describes a non-errno read failure with its text', async () => {
    const proc = await load('linux', {
      readFileSync: vi.fn(() => {
        throw 'weird';
      }),
    });
    expect(() => proc.processInfo(4321)).toThrow(/weird/);
  });

  it('throws INTERNAL when the stat line is truncated or has no comm', async () => {
    const short = await load('linux', { readFileSync: vi.fn(() => '1234 (x) S 1 2 3\n') });
    expect(() => short.processInfo(1234)).toThrow(expect.objectContaining({ code: 'INTERNAL', message: expect.stringContaining('unexpected /proc/1234/stat format') }));
    const noParen = await load('linux', { readFileSync: vi.fn(() => 'garbage') });
    expect(() => noParen.processInfo(1234)).toThrow(/unexpected/);
  });

  it('rejects invalid pids without touching /proc', async () => {
    const readFileSync = vi.fn();
    const proc = await load('linux', { readFileSync });
    for (const bad of [0, -5, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) expect(proc.processInfo(bad)).toBeNull();
    expect(readFileSync).not.toHaveBeenCalled();
  });
});

describe('processInfo on a ps platform (injected ps)', () => {
  it('parses stat and lstart, collapsing whitespace', async () => {
    const spawnSync = vi.fn((..._a: unknown[]) => ({ status: 0, stdout: 'Ss   Sat Oct  3 09:37:05 2026\n', stderr: '' }));
    const proc = await load('darwin', { spawnSync });
    expect(proc.processInfo(4321)).toEqual({ pid: 4321, state: 'Ss', start: 'Sat Oct 3 09:37:05 2026' });
    const call = spawnSync.mock.calls[0]!;
    expect(call[0]).toBe('ps');
    expect((call[2] as { env: Record<string, string> }).env).toMatchObject({ LC_ALL: 'C', TZ: 'UTC' });
  });

  it('returns null when ps exits 1 with no output (no such pid)', async () => {
    const proc = await load('darwin', { spawnSync: vi.fn(() => ({ status: 1, stdout: '  \n', stderr: '' })) });
    expect(proc.processInfo(4321)).toBeNull();
  });

  it('throws INTERNAL when ps cannot run, fails, or prints something unparseable', async () => {
    const missing = await load('darwin', { spawnSync: vi.fn(() => ({ error: new Error('spawn ps ENOENT'), status: null, stdout: '', stderr: '' })) });
    expect(() => missing.processInfo(4321)).toThrow(expect.objectContaining({ code: 'INTERNAL', message: expect.stringContaining('cannot run ps') }));
    const failed = await load('darwin', { spawnSync: vi.fn(() => ({ status: 2, stdout: '', stderr: 'boom' })) });
    expect(() => failed.processInfo(4321)).toThrow(expect.objectContaining({ code: 'INTERNAL', details: expect.objectContaining({ stderr: 'boom' }) }));
    const noStderr = await load('darwin', { spawnSync: vi.fn(() => ({ status: 3, stdout: 'x' })) });
    expect(() => noStderr.processInfo(4321)).toThrow(/exit 3/);
    const garbage = await load('darwin', { spawnSync: vi.fn(() => ({ status: 0, stdout: 'onlyonetoken', stderr: '' })) });
    expect(() => garbage.processInfo(4321)).toThrow(/unexpected ps output/);
    const nullOut = await load('darwin', { spawnSync: vi.fn(() => ({ status: 0, stdout: null, stderr: null })) });
    expect(() => nullOut.processInfo(4321)).toThrow(/unexpected ps output/);
  });
});

describe('isAlive with injected process info', () => {
  it('treats zombies as dead and a different start time as a reused pid', async () => {
    const zombie = await load('linux', { readFileSync: vi.fn(() => stat('x', 'Z', '5')) });
    expect(zombie.isAlive(process.pid)).toBe(false);
    const live = await load('linux', { readFileSync: vi.fn(() => stat('x', 'S', '5')) });
    expect(live.isAlive(process.pid, '5')).toBe(true);
    expect(live.isAlive(process.pid, '  5 ')).toBe(true);
    expect(live.isAlive(process.pid, '6')).toBe(false);
  });

  it('is false when /proc has no entry although the signal probe succeeded', async () => {
    const proc = await load('linux', {});
    expect(proc.isAlive(process.pid)).toBe(false);
  });

  it('answers true without an expected start when ps is unavailable, but rethrows when one is expected', async () => {
    const spawnSync = vi.fn(() => ({ error: new Error('spawn ps ENOENT'), status: null, stdout: '', stderr: '' }));
    const proc = await load('darwin', { spawnSync });
    expect(proc.isAlive(process.pid)).toBe(true);
    expect(proc.isAlive(process.pid, null)).toBe(true);
    expect(() => proc.isAlive(process.pid, 'Sat Oct 3 09:37:05 2026')).toThrow(/cannot run ps/);
  });

  it('is false for a pid the kernel does not know and for invalid pids', async () => {
    const proc = await load('linux', {});
    expect(proc.isAlive(0)).toBe(false);
    expect(proc.isAlive(-1)).toBe(false);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('no such'), { code: 'ESRCH' });
    });
    expect(proc.isAlive(999_999)).toBe(false);
  });

  it('counts a process owned by another user (EPERM on the probe) as existing', async () => {
    const proc = await load('linux', { readFileSync: vi.fn(() => stat('x', 'S', '5')) });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('perm'), { code: 'EPERM' });
    });
    expect(proc.isAlive(999_999, '5')).toBe(true);
  });
});

describe('own process group refusal, per platform', () => {
  it('on linux refuses the pgrp read from /proc/self/stat', async () => {
    const readFileSync = vi.fn((p: string) => (p === '/proc/self/stat' ? '1 (node) S 1 77777 77777 0\n' : stat('x', 'S', '1')));
    const proc = await load('linux', { readFileSync });
    expect(() => proc.killGroup(77777)).toThrow(/refusing to signal process group 77777/);
    expect(() => proc.isGroupAlive(77777)).toThrow(/refusing/);
    // read once, then cached
    expect(() => proc.killGroup(77777)).toThrow(/refusing/);
    expect(readFileSync.mock.calls.filter((c) => c[0] === '/proc/self/stat')).toHaveLength(1);
  });

  it('on a ps platform refuses the pgid reported by ps', async () => {
    const spawnSync = vi.fn((..._a: unknown[]) => ({ status: 0, stdout: ' 66666\n', stderr: '' }));
    const proc = await load('darwin', { spawnSync });
    expect(() => proc.killGroup(66666)).toThrow(/refusing/);
    expect(spawnSync.mock.calls[0]![1]).toEqual(['-o', 'pgid=', '-p', String(process.pid)]);
  });

  it('does not refuse an unrelated group when the own pgid cannot be determined', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    for (const make of [
      () => load('linux', { readFileSync: vi.fn(() => 'garbage with no fields') }),
      () => load('linux', { readFileSync: vi.fn(() => '1 (n) S 1 0 0\n') }),
      () =>
        load('linux', {
          readFileSync: vi.fn(() => {
            throw new Error('unreadable');
          }),
        }),
      () => load('darwin', { spawnSync: vi.fn(() => ({ status: 1, stdout: '', stderr: '' })) }),
      () => load('darwin', { spawnSync: vi.fn(() => ({ status: 0, stdout: 'abc', stderr: '' })) }),
      () => load('darwin', { spawnSync: vi.fn(() => ({ status: 0, stdout: null })) }),
      () =>
        load('darwin', {
          spawnSync: vi.fn(() => {
            throw new Error('no ps');
          }),
        }),
    ]) {
      const proc = await make();
      expect(proc.killGroup(55555, 'SIGTERM')).toBe(true);
      expect(kill).toHaveBeenLastCalledWith(-55555, 'SIGTERM');
    }
  });

  it('refuses unsafe values regardless of platform', async () => {
    const proc = await load('linux', {});
    for (const bad of [0, 1, -3, 1.5, process.pid]) expect(() => proc.killGroup(bad)).toThrow(/refusing/);
  });
});

describe('killGroup, isGroupAlive and terminateGroup signalling errors', () => {
  it('reports ESRCH as false and wraps any other errno as INTERNAL with the cause', async () => {
    const proc = await load('linux', {});
    const kill = vi.spyOn(process, 'kill');
    kill.mockImplementation(() => {
      throw Object.assign(new Error('no such'), { code: 'ESRCH' });
    });
    expect(proc.killGroup(424242)).toBe(false);
    const eperm = Object.assign(new Error('perm'), { code: 'EPERM' });
    kill.mockImplementation(() => {
      throw eperm;
    });
    let caught: unknown;
    try {
      proc.killGroup(424242, 'SIGKILL');
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({ code: 'INTERNAL', details: { pgid: 424242, signal: 'SIGKILL' } });
    expect((caught as Error).message).toContain('EPERM');
    expect((caught as Error).cause).toBe(eperm);
    kill.mockImplementation(() => {
      throw 'odd';
    });
    expect(() => proc.killGroup(424242)).toThrow(/odd/);
    // a group owned by someone else still exists
    kill.mockImplementation(() => {
      throw eperm;
    });
    expect(proc.isGroupAlive(424242)).toBe(true);
  });

  it('terminateGroup reports exited when the group vanishes between the probe and the signal', async () => {
    const proc = await load('linux', {});
    vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 0) return true;
      throw Object.assign(new Error('no such'), { code: 'ESRCH' });
    });
    expect(await proc.terminateGroup(424242, 10, { clock: new ManualClock(0) })).toEqual({ exited: true, signal: null });
  });

  it('terminateGroup escalates INT, TERM, KILL and reports a group that survives KILL', async () => {
    const proc = await load('linux', {});
    const sent: Array<string | number> = [];
    vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      sent.push(signal as string | number);
      return true;
    });
    const clock = new ManualClock(0);
    const result = await proc.terminateGroup(424242, 50, { clock, pollMs: 0 });
    expect(result).toEqual({ exited: false, signal: 'SIGKILL' });
    expect(sent.filter((s) => s !== 0)).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL']);
  });

  it('terminateGroup stops escalating as soon as the group is gone', async () => {
    const proc = await load('linux', {});
    let probes = 0;
    vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal !== 0) return true;
      probes += 1;
      if (probes > 2) throw Object.assign(new Error('no such'), { code: 'ESRCH' });
      return true;
    });
    const result = await proc.terminateGroup(424242, 100, { clock: new ManualClock(0) });
    expect(result).toEqual({ exited: true, signal: 'SIGINT' });
  });

  it('terminateGroup with the default clock still honours a zero grace period', async () => {
    const proc = await load('linux', {});
    const sent: Array<string | number> = [];
    vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      sent.push(signal as string | number);
      if (signal === 'SIGKILL') throw Object.assign(new Error('no such'), { code: 'ESRCH' });
      return true;
    });
    const result = await proc.terminateGroup(424242, 0);
    expect(result.signal).toBe('SIGTERM');
    expect(result.exited).toBe(true);
  });
});
