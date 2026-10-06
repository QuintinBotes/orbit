import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Clock } from './clock.ts';
import { OrbitError } from './errors.ts';

/**
 * Process identity and group signalling for workers and checks that outlive
 * the controller incarnation that started them (docs/interfaces/platform-runtime.md §4).
 *
 * A pid alone is not an identity: after a crash and a reboot, or simply a busy
 * machine, the same number can belong to an unrelated process. Every stored
 * pid is paired with its start time, and a pid whose start time differs from
 * the recorded one is treated as dead. Start times are opaque strings compared
 * for equality only:
 *   macOS  `LC_ALL=C TZ=UTC ps -o lstart=`, whitespace collapsed ("Sat Oct 3 09:37:05 2026")
 *   Linux  field 22 (starttime, clock ticks since boot) of /proc/<pid>/stat
 */

export interface ProcessInfo {
  pid: number;
  /** ps STAT / /proc state letter(s); 'Z' means zombie. */
  state: string;
  start: string;
}

/** Start time of `pid`, or null when no such process exists. Throws when it cannot be determined. */
export function processStartTime(pid: number): string | null {
  return processInfo(pid)?.start ?? null;
}

/** State and start time of a live (or zombie) process; null when it does not exist. */
export function processInfo(pid: number): ProcessInfo | null {
  if (!isValidPid(pid)) return null;
  if (process.platform === 'linux') return linuxInfo(pid);
  return psInfo(pid);
}

/**
 * True only when the process exists, is not a zombie, and (when
 * `expectedStart` is given) started at the recorded time. A different start
 * time means the pid was reused, so the process we cared about is gone.
 */
export function isAlive(pid: number, expectedStart?: string | null): boolean {
  if (!isValidPid(pid)) return false;
  if (!signalZero(pid)) return false;
  let info: ProcessInfo | null;
  try {
    info = processInfo(pid);
  } catch (err) {
    // Without ps we can still answer the unqualified question; with an
    // expected start time a guess could mean a duplicate worker or a kill of
    // an unrelated process, so the caller has to decide.
    if (expectedStart == null) return true;
    throw err;
  }
  if (!info) return false;
  if (info.state.startsWith('Z')) return false;
  if (expectedStart != null && normalizeStart(expectedStart) !== info.start) return false;
  return true;
}

/** True while any process in group `pgid` exists (zombies included; the kernel cannot tell us more cheaply). */
export function isGroupAlive(pgid: number): boolean {
  assertSafePgid(pgid);
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return errno(err) === 'EPERM';
  }
}

/**
 * Signal every process in group `pgid`. Returns false when the group no
 * longer exists. Refuses pgid 0 and 1, our own pid and the group we belong
 * to, where a negative kill would reach this process or every process the
 * user owns.
 */
export function killGroup(pgid: number, signal: NodeJS.Signals = 'SIGTERM'): boolean {
  assertSafePgid(pgid);
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (err) {
    if (errno(err) === 'ESRCH') return false;
    throw new OrbitError('INTERNAL', `cannot send ${signal} to process group ${pgid}: ${errno(err) ?? String(err)}`, { pgid, signal }, { cause: err });
  }
}

export interface TerminateResult {
  /** Whether the group was gone when we stopped waiting. */
  exited: boolean;
  /** The last signal actually delivered, or null when the group was already gone. */
  signal: NodeJS.Signals | null;
}

/**
 * Stop a process group politely, then firmly: SIGINT (Claude and Codex end
 * the turn cleanly on it), SIGTERM, SIGKILL, waiting up to `graceMs` after
 * each for the whole group to disappear.
 */
export async function terminateGroup(pgid: number, graceMs: number, options: { clock?: Clock; pollMs?: number } = {}): Promise<TerminateResult> {
  assertSafePgid(pgid);
  const clock = options.clock ?? realClock;
  const pollMs = Math.max(1, options.pollMs ?? 25);
  let last: NodeJS.Signals | null = null;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGKILL'] as const) {
    if (!isGroupAlive(pgid)) return { exited: true, signal: last };
    try {
      if (!killGroup(pgid, signal)) return { exited: true, signal: last };
      last = signal;
    } catch (err) {
      // Darwin refuses a signal to a group whose members have all exited but are not yet reaped (EPERM), while the
      // probe above still sees the group. Nothing is left to signal: wait for it to go, as after a delivered signal.
      if (errno((err as { cause?: unknown }).cause) !== 'EPERM') throw err;
    }
    const deadline = clock.now() + Math.max(0, graceMs);
    while (clock.now() < deadline) {
      await clock.sleep(Math.min(pollMs, Math.max(1, deadline - clock.now())));
      if (!isGroupAlive(pgid)) return { exited: true, signal: last };
    }
  }
  return { exited: !isGroupAlive(pgid), signal: last };
}

/** Collapse whitespace so start times recorded by different callers compare equal. */
export function normalizeStart(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------

// Same as clock.systemClock. Imported as a type only so this module also loads
// under Node's strip-only TypeScript (test fixtures, a source-run shim), which
// rejects the parameter property in clock.ts.
const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

function isValidPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0;
}

function assertSafePgid(pgid: number): void {
  if (!Number.isSafeInteger(pgid) || pgid <= 1 || pgid === process.pid || pgid === ownPgid()) {
    throw new OrbitError('INTERNAL', `refusing to signal process group ${String(pgid)}`, { pgid });
  }
}

let ownGroup: number | null | undefined;

/**
 * The process group this process belongs to. Under npm, a shell pipeline or a
 * test runner it is not our pid, and a stale pgid read back from the database
 * could name it after a reboot. Node has no getpgrp, so it is read once
 * (nothing in Node can change it later); null when it cannot be read.
 */
function ownPgid(): number | null {
  if (ownGroup !== undefined) return ownGroup;
  ownGroup = null;
  try {
    if (process.platform === 'linux') {
      // Field 5 (pgrp) is the third field after the parenthesised comm.
      const stat = readFileSync('/proc/self/stat', 'utf8');
      const n = Number(stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[2]);
      if (Number.isSafeInteger(n) && n > 0) ownGroup = n;
    } else {
      const r = spawnSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
      const n = Number((r.stdout ?? '').trim());
      if (r.status === 0 && Number.isSafeInteger(n) && n > 0) ownGroup = n;
    }
  } catch {
    ownGroup = null;
  }
  return ownGroup;
}

function signalZero(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to another user.
    return errno(err) === 'EPERM';
  }
}

function errno(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

function psInfo(pid: number): ProcessInfo | null {
  // lstart's format follows the locale and timezone, so both are pinned.
  const r = spawnSync('ps', ['-o', 'stat=', '-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' },
    timeout: 10_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.error) throw new OrbitError('INTERNAL', `cannot run ps to inspect pid ${pid}: ${r.error.message}`, { pid }, { cause: r.error });
  const out = (r.stdout ?? '').trim();
  // ps exits 1 with no output when the pid does not exist.
  if (r.status === 1 && out === '') return null;
  if (r.status !== 0) throw new OrbitError('INTERNAL', `ps failed inspecting pid ${pid} (exit ${String(r.status)})`, { pid, stderr: (r.stderr ?? '').slice(0, 500) });
  const m = /^(\S+)\s+(\S.*)$/.exec(out);
  if (!m) throw new OrbitError('INTERNAL', `unexpected ps output for pid ${pid}`, { pid, output: out.slice(0, 200) });
  return { pid, state: m[1]!, start: normalizeStart(m[2]!) };
}

function linuxInfo(pid: number): ProcessInfo | null {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch (err) {
    if (errno(err) === 'ENOENT' || errno(err) === 'ESRCH') return null;
    throw new OrbitError('INTERNAL', `cannot read /proc/${pid}/stat: ${errno(err) ?? String(err)}`, { pid }, { cause: err });
  }
  // comm (field 2) is parenthesised and may contain spaces or ')', so split after the last ')'.
  const close = stat.lastIndexOf(')');
  const rest = stat.slice(close + 1).trim().split(/\s+/);
  const state = rest[0];
  const start = rest[19];
  if (close === -1 || !state || !start) throw new OrbitError('INTERNAL', `unexpected /proc/${pid}/stat format`, { pid });
  return { pid, state, start };
}
