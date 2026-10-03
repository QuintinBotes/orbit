import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';

/** Run ids sort by creation time and are safe in paths and branch names. */
export function newRunId(now: number = Date.now()): string {
  const d = new Date(now);
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  return `orb-${stamp}-${randomBytes(3).toString('hex')}`;
}

export function newId(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString('hex')}`;
}

/**
 * Identifies one controller incarnation. A restarted controller on the same
 * pid is still a different owner, which is what lease takeover needs.
 */
export function newOwnerId(): string {
  return `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
