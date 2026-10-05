import { beforeEach, describe, expect, it, vi } from 'vitest';

const proc = vi.hoisted(() => ({
  isGroupAlive: vi.fn<(pgid: number) => boolean>(),
  processInfo: vi.fn<(pid: number) => { pid: number; state: string; start: string } | null>(),
}));
vi.mock('../../../src/core/proc.ts', () => proc);

const { bootTimeSeconds, groupOwnership, processOwnership, startToEpochMs } = await import('../../../src/recovery/identity.ts');

const T0 = Date.UTC(2026, 9, 3, 9, 37, 5);
const LSTART = 'Sat Oct 3 09:37:05 2026';

beforeEach(() => {
  proc.isGroupAlive.mockReset();
  proc.processInfo.mockReset();
});

describe('bootTimeSeconds', () => {
  it('is null away from Linux without touching /proc', () => {
    const read = vi.fn(() => 'btime 5\n');
    expect(bootTimeSeconds('darwin', read)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('reads btime from /proc/stat on Linux', () => {
    expect(bootTimeSeconds('linux', (p) => (p === '/proc/stat' ? 'cpu 1 2 3\nbtime 1700000000\nprocesses 9\n' : ''))).toBe(1_700_000_000);
  });

  it('is null when /proc/stat has no btime line or cannot be read', () => {
    expect(bootTimeSeconds('linux', () => 'cpu 1 2 3\n')).toBeNull();
    expect(
      bootTimeSeconds('linux', () => {
        throw new Error('ENOENT');
      }),
    ).toBeNull();
  });

  it('with the real reader, a non-Linux host has no /proc/stat to read and a Linux host reports its boot time', () => {
    const v = bootTimeSeconds('linux');
    if (process.platform === 'linux') expect(v).toBeGreaterThan(1_000_000_000);
    else expect(v).toBeNull();
  });

  it('defaults to the host platform and the real reader without throwing', () => {
    const v = bootTimeSeconds();
    expect(v === null || v > 1_000_000_000).toBe(true);
  });
});

describe('startToEpochMs by platform', () => {
  it('converts Linux clock ticks with the boot time and rounds to milliseconds', () => {
    expect(startToEpochMs('12345', 1_000, 'linux')).toBe(1_000_000 + 123_450);
    expect(startToEpochMs('1', 0, 'linux')).toBe(10);
  });

  it('is null on Linux for a non-numeric start or an unknown boot time', () => {
    expect(startToEpochMs('abc', 1_000, 'linux')).toBeNull();
    expect(startToEpochMs('500', null, 'linux')).toBeNull();
  });

  it('parses the ps lstart text as UTC on other platforms and rejects garbage', () => {
    expect(startToEpochMs(LSTART, null, 'darwin')).toBe(T0);
    expect(startToEpochMs('nonsense', null, 'darwin')).toBeNull();
  });

  it('defaults the platform to the host without throwing', () => {
    expect(() => startToEpochMs('0')).not.toThrow();
  });
});

describe('groupOwnership with a controlled process table', () => {
  it('a group with no members is gone and the leader is never looked up', () => {
    proc.isGroupAlive.mockReturnValue(false);
    expect(groupOwnership(42, T0)).toBe('gone');
    expect(proc.processInfo).not.toHaveBeenCalled();
  });

  it('members that cannot be identified because ps fails are unknown', () => {
    proc.isGroupAlive.mockReturnValue(true);
    proc.processInfo.mockImplementation(() => {
      throw new Error('ps missing');
    });
    expect(groupOwnership(42, T0)).toBe('unknown');
  });

  it('members with no process carrying the leader pid descend from the original leader: ours', () => {
    proc.isGroupAlive.mockReturnValue(true);
    proc.processInfo.mockReturnValue(null);
    expect(groupOwnership(42, T0)).toBe('ours');
  });

  it('a leader whose start cannot be converted is unknown', () => {
    proc.isGroupAlive.mockReturnValue(true);
    proc.processInfo.mockReturnValue({ pid: 42, state: 'S', start: 'garbled' });
    expect(groupOwnership(42, T0)).toBe('unknown');
  });

  it('judges the leader start against the recorded time with the tolerance inclusive', () => {
    proc.isGroupAlive.mockReturnValue(true);
    proc.processInfo.mockReturnValue({ pid: 42, state: 'S', start: LSTART });
    if (process.platform === 'linux') return;
    expect(groupOwnership(42, T0)).toBe('ours');
    expect(groupOwnership(42, T0 + 5_000)).toBe('ours');
    expect(groupOwnership(42, T0 - 5_000)).toBe('ours');
    expect(groupOwnership(42, T0 + 5_001)).toBe('foreign');
    expect(groupOwnership(42, T0 + 5_001, 10_000)).toBe('ours');
  });
});

describe('processOwnership with a controlled process table', () => {
  it('is unknown when the process table cannot be read, so the pid is never signalled', () => {
    proc.processInfo.mockImplementation(() => {
      throw new Error('ps missing');
    });
    expect(processOwnership(7, T0)).toBe('unknown');
  });

  it('is gone for a missing process and for a zombie', () => {
    proc.processInfo.mockReturnValueOnce(null);
    expect(processOwnership(7, T0)).toBe('gone');
    proc.processInfo.mockReturnValueOnce({ pid: 7, state: 'Z+', start: LSTART });
    expect(processOwnership(7, T0)).toBe('gone');
  });

  it('is unknown when the start cannot be converted', () => {
    proc.processInfo.mockReturnValue({ pid: 7, state: 'S', start: 'garbled' });
    expect(processOwnership(7, T0)).toBe('unknown');
  });

  it('is ours within the tolerance and foreign (a recycled pid) outside it', () => {
    proc.processInfo.mockReturnValue({ pid: 7, state: 'S', start: LSTART });
    if (process.platform === 'linux') return;
    expect(processOwnership(7, T0 + 4_000)).toBe('ours');
    expect(processOwnership(7, T0 + 3_600_000)).toBe('foreign');
    expect(processOwnership(7, T0 + 3_600_000, 2 * 3_600_000)).toBe('ours');
  });
});
