import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { groupOwnership, startToEpochMs } from '../../../src/recovery/identity.ts';

const kids: ChildProcess[] = [];
afterEach(() => {
  for (const k of kids.splice(0)) {
    try {
      process.kill(-k.pid!, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
});

function leader(): number {
  const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  child.unref();
  kids.push(child);
  return child.pid!;
}

describe('startToEpochMs', () => {
  it.skipIf(process.platform === 'linux')('reads the ps lstart format as UTC', () => {
    expect(startToEpochMs('Sat Oct 3 09:37:05 2026')).toBe(Date.UTC(2026, 9, 3, 9, 37, 5));
  });

  it('returns null for something it cannot read', () => {
    expect(startToEpochMs('not a date', 1_700_000_000)).toBeNull();
  });

  it.skipIf(process.platform !== 'linux')('converts /proc ticks using the boot time', () => {
    expect(startToEpochMs('500', 1_000)).toBe(1_000 * 1000 + 5_000);
  });
});

describe('groupOwnership', () => {
  it('a live leader that started when the record says is ours; one that started long before or after is a recycled pid', () => {
    const pgid = leader();
    const now = Date.now();
    expect(groupOwnership(pgid, now)).toBe('ours');
    expect(groupOwnership(pgid, now - 24 * 3_600_000)).toBe('foreign');
    expect(groupOwnership(pgid, now + 24 * 3_600_000)).toBe('foreign');
  });

  it('an empty group is gone', () => {
    expect(groupOwnership(2_000_000_000, Date.now())).toBe('gone');
  });
});
