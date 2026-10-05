import { readFileSync } from 'node:fs';
import { isGroupAlive, processInfo } from '../core/proc.ts';

/**
 * Identity of processes whose record carries no start time of its own.
 *
 * A check's pid.json holds the check's pid and process group, and when the
 * record was written, but not the start time core/proc compares. When the
 * shim that owned the check is gone, the only way to tell the orphaned check
 * from an unrelated process that recycled the pid is to compare the process's
 * start with the time the record was written. A recycled pid starts long
 * after that, so a tolerance of a few seconds (ps reports whole seconds)
 * separates them.
 */

const CLOCK_TICKS_PER_SECOND = 100;

/** Epoch milliseconds for a start string from core/proc, or null when it cannot be converted. */
export function startToEpochMs(start: string, btimeSeconds: number | null = bootTimeSeconds(), platform: NodeJS.Platform = process.platform): number | null {
  if (platform === 'linux') {
    const ticks = Number(start);
    if (!Number.isFinite(ticks) || btimeSeconds === null) return null;
    return btimeSeconds * 1000 + Math.round((ticks / CLOCK_TICKS_PER_SECOND) * 1000);
  }
  // `ps -o lstart=` under TZ=UTC: "Sat Oct 3 09:37:05 2026".
  const ms = Date.parse(`${start} UTC`);
  return Number.isFinite(ms) ? ms : null;
}

/** Boot time in epoch seconds from /proc/stat (Linux only); the platform and the reader are injectable for tests. */
export function bootTimeSeconds(platform: NodeJS.Platform = process.platform, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): number | null {
  if (platform !== 'linux') return null;
  try {
    const m = /^btime\s+(\d+)/m.exec(read('/proc/stat'));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

export type GroupOwnership =
  /** No process in the group. */
  | 'gone'
  /** Members exist and, as far as the record can tell, are what the dead owner started. */
  | 'ours'
  /** A process with the group leader's pid exists but started at another time: a recycled pid. */
  | 'foreign'
  /** Members exist but their identity cannot be established (no ps, unparseable start). */
  | 'unknown';

/**
 * Whether process group `pgid` is what was started at `startedAtMs` (real
 * wall-clock time, as recorded by the process that wrote the record).
 */
export function groupOwnership(pgid: number, startedAtMs: number, toleranceMs = 5_000): GroupOwnership {
  if (!isGroupAlive(pgid)) return 'gone';
  let leader;
  try {
    leader = processInfo(pgid);
  } catch {
    return 'unknown';
  }
  // No process has the group's id as its pid, yet the group has members. A pid
  // is not reused while a group of that id exists, so they descend from the
  // original leader.
  if (!leader) return 'ours';
  const started = startToEpochMs(leader.start);
  if (started === null) return 'unknown';
  return Math.abs(started - startedAtMs) <= toleranceMs ? 'ours' : 'foreign';
}

/**
 * Whether process `pid` is the one that recorded itself at `recordedAtMs`
 * (real wall-clock time), for records that carry a pid but no start time: a
 * check shim known only from its pid.json because the controller died before
 * writing launch.json. 'foreign' means the pid was recycled; 'unknown' means
 * the process exists but its identity cannot be established, and it must not
 * be signalled.
 */
export function processOwnership(pid: number, recordedAtMs: number, toleranceMs = 5_000): GroupOwnership {
  let info;
  try {
    info = processInfo(pid);
  } catch {
    return 'unknown';
  }
  if (!info || info.state.startsWith('Z')) return 'gone';
  const started = startToEpochMs(info.start);
  if (started === null) return 'unknown';
  return Math.abs(started - recordedAtMs) <= toleranceMs ? 'ours' : 'foreign';
}
