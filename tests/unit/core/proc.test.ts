import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../../../src/core/clock.ts';
import { findProcesses, findProcessesWithEnv, isAlive, isGroupAlive, killGroup, normalizeStart, processInfo, processStartTime, terminateGroup } from '../../../src/core/proc.ts';

const NODE = process.execPath;

/** A detached child (its own process group) that prints "ready" once its signal handlers are installed. */
async function startGroup(code: string): Promise<{ child: ChildProcess; pid: number; exited: Promise<void> }> {
  const child = spawn(NODE, ['-e', code], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
  started.push(child);
  await new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    let buf = '';
    child.stdout!.on('data', (c: Buffer) => {
      buf += c.toString();
      if (buf.includes('ready')) resolve();
    });
  });
  return { child, pid: child.pid!, exited };
}

async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return cond();
}

const started: ChildProcess[] = [];
afterEach(() => {
  for (const c of started.splice(0)) {
    try {
      if (c.pid) process.kill(-c.pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
});

describe('processStartTime', () => {
  it('returns a stable, normalized start time for a live process', () => {
    const a = processStartTime(process.pid);
    expect(a).toBeTruthy();
    expect(a).toBe(processStartTime(process.pid));
    expect(a).toBe(normalizeStart(a!));
  });

  it('matches the platform source described in docs/interfaces/platform-runtime.md', () => {
    const start = processStartTime(process.pid)!;
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
      expect(start).toBe(stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19]);
    } else {
      const ps = spawnSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
      expect(start).toBe(normalizeStart(ps.stdout));
      expect(start).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/);
    }
  });

  it('returns null for a process that has exited and for impossible pids', async () => {
    const { pid, child, exited } = await startGroup("console.log('ready')");
    await exited;
    expect(child.exitCode).toBe(0);
    expect(processStartTime(pid)).toBeNull();
    expect(processStartTime(0)).toBeNull();
    expect(processStartTime(-1)).toBeNull();
    expect(processStartTime(1.5)).toBeNull();
    expect(processStartTime(Number.NaN)).toBeNull();
    expect(processStartTime(99_999_999)).toBeNull();
  });
});

describe('isAlive', () => {
  it('is true for this process, with or without its recorded start time', () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(process.pid, processStartTime(process.pid))).toBe(true);
    expect(isAlive(process.pid, null)).toBe(true);
  });

  it('compares start times after collapsing whitespace, as raw ps output has padding', () => {
    const start = processStartTime(process.pid)!;
    expect(isAlive(process.pid, `  ${start.replace(/ /g, '   ')} \n`)).toBe(true);
  });

  it('treats a live pid with a different start time as dead: the pid was reused', async () => {
    const { pid } = await startGroup("console.log('ready'); setInterval(() => {}, 1000)");
    const start = processStartTime(pid)!;
    expect(isAlive(pid, start)).toBe(true);
    // What a reused pid looks like from a stored fingerprint: same number, other process.
    expect(isAlive(pid, 'Thu Jan 1 00:00:00 1970')).toBe(false);
    expect(isAlive(pid, '1')).toBe(false);
  });

  it('is false once the recorded process has been killed', async () => {
    const { pid, exited } = await startGroup("console.log('ready'); setInterval(() => {}, 1000)");
    const start = processStartTime(pid)!;
    process.kill(pid, 'SIGKILL');
    await exited;
    expect(isAlive(pid)).toBe(false);
    expect(isAlive(pid, start)).toBe(false);
  });

  it('is false for invalid pids', () => {
    for (const pid of [0, -1, -process.pid, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(isAlive(pid), String(pid)).toBe(false);
  });

  it('counts a process owned by another user (EPERM) as alive', () => {
    // pid 1 (launchd or init) always exists and is root's.
    expect(isAlive(1)).toBe(true);
  });

  it('treats a zombie as dead even though kill(pid, 0) still succeeds', async () => {
    // `exec sleep` replaces the shell, so nothing ever reaps the backgrounded child.
    const child = spawn('sh', ['-c', 'sleep 0.1 & echo $!; exec sleep 30'], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
    started.push(child);
    const zombie = await new Promise<number>((resolve) => child.stdout!.once('data', (c: Buffer) => resolve(Number(c.toString().trim()))));
    expect(await waitFor(() => processInfo(zombie)?.state.startsWith('Z') ?? false)).toBe(true);
    expect(() => process.kill(zombie, 0)).not.toThrow();
    expect(isAlive(zombie)).toBe(false);
  });
});

describe('killGroup and isGroupAlive', () => {
  it('refuses process groups whose negative kill would hit us or everything we own', () => {
    for (const pgid of [0, 1, -5, 1.5, Number.NaN, process.pid]) {
      expect(() => killGroup(pgid, 'SIGTERM'), String(pgid)).toThrow(/refusing/);
      expect(() => isGroupAlive(pgid), String(pgid)).toThrow(/refusing/);
    }
  });

  it('signals every member of the group and reports a missing group as false', async () => {
    const { pid, exited } = await startGroup(
      "const { spawn } = require('node:child_process'); const c = spawn('sleep', ['30'], { stdio: 'ignore' }); console.log('ready ' + c.pid); setInterval(() => {}, 1000)",
    );
    expect(isGroupAlive(pid)).toBe(true);
    expect(killGroup(pid, 'SIGTERM')).toBe(true);
    await exited;
    expect(await waitFor(() => !isGroupAlive(pid))).toBe(true);
    expect(killGroup(pid, 'SIGTERM')).toBe(false);
  });
});

describe('terminateGroup', () => {
  it('stops at SIGINT when that is enough', async () => {
    const { pid } = await startGroup("console.log('ready'); setInterval(() => {}, 1000)");
    expect(await terminateGroup(pid, 2_000)).toEqual({ exited: true, signal: 'SIGINT' });
  });

  it('escalates to SIGTERM when SIGINT is handled', async () => {
    const { pid } = await startGroup("process.on('SIGINT', () => {}); console.log('ready'); setInterval(() => {}, 1000)");
    // A generous grace so a loaded machine still dies on SIGTERM rather than reaching SIGKILL.
    expect(await terminateGroup(pid, 1_500)).toEqual({ exited: true, signal: 'SIGTERM' });
  });

  it('escalates to SIGKILL when SIGINT and SIGTERM are both ignored, and takes the grandchildren too', async () => {
    const { pid } = await startGroup(
      "process.on('SIGINT', () => {}); process.on('SIGTERM', () => {}); const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', \"process.on('SIGINT', () => {}); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' }); console.log('ready'); setInterval(() => {}, 1000)",
    );
    const t0 = Date.now();
    const result = await terminateGroup(pid, 300);
    expect(result).toEqual({ exited: true, signal: 'SIGKILL' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(550);
    // The group outlives its leader while the grandchild lives, so this covers it too.
    expect(isGroupAlive(pid)).toBe(false);
  });

  it('reports an already-finished group without sending anything', async () => {
    const { pid, exited } = await startGroup("console.log('ready')");
    await exited;
    expect(await waitFor(() => !isGroupAlive(pid))).toBe(true);
    expect(await terminateGroup(pid, 100)).toEqual({ exited: true, signal: null });
  });

  it('honours an injected clock for its grace periods', async () => {
    const { pid } = await startGroup("process.on('SIGINT', () => {}); process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)");
    const clock = new ManualClock();
    const before = clock.now();
    // With a manual clock the waits elapse instantly, so the run escalates
    // straight through; SIGKILL then needs real time to land.
    const result = await terminateGroup(pid, 60_000, { clock, pollMs: 30_000 });
    expect(result.signal).toBe('SIGKILL');
    expect(clock.now() - before).toBeGreaterThanOrEqual(120_000);
    expect(await waitFor(() => !isGroupAlive(pid))).toBe(true);
  });
});

describe('adversarial review', () => {
  it('refuses to signal the group this process belongs to even when it is not the group leader', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/own-group.ts', import.meta.url));
    // `; true` keeps the shell alive as the group leader instead of exec'ing node.
    const sh = spawn('sh', ['-c', `"${NODE}" "${fixture}" $$; true`], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
    started.push(sh);
    let out = '';
    sh.stdout!.on('data', (c: Buffer) => (out += c.toString()));
    await new Promise<void>((resolve) => sh.on('close', () => resolve()));
    const report = JSON.parse(out) as { outcome: string; pid: number; pgid: number };
    expect(report.pgid).toBe(sh.pid);
    expect(report.pid).not.toBe(report.pgid);
    expect(report.outcome).toBe('refused');
  });
});

describe('findProcesses', () => {
  it('finds a live process by a marker on its command line, and no longer once it has ended', async () => {
    const marker = `orbit-find-${process.pid}-${Date.now()}`;
    const has = (line: string): boolean => line.split(' ').includes(marker);
    const child = spawn(NODE, ['-e', 'setInterval(() => {}, 1000)', '--', marker], { stdio: 'ignore' });
    started.push(child);
    expect(await waitFor(() => findProcesses(has).length > 0)).toBe(true);
    expect(findProcesses(has)).toEqual([child.pid]);
    child.kill('SIGKILL');
    expect(await waitFor(() => findProcesses(has).length === 0)).toBe(true);
  });
});

describe('findProcesses and findProcessesWithEnv on Linux (a /proc of the test\'s making)', () => {
  let procDir: string;
  /** A /proc entry: its NUL-separated command line and environment, as the kernel gives them (null: no such file). */
  function entry(pid: number | string, cmdline: string[] | null, environ: string[] | null = []): void {
    const d = join(procDir, String(pid));
    mkdirSync(d, { recursive: true });
    if (cmdline !== null) writeFileSync(join(d, 'cmdline'), cmdline.length === 0 ? '' : cmdline.join('\0') + '\0');
    if (environ !== null) writeFileSync(join(d, 'environ'), environ.length === 0 ? '' : environ.join('\0') + '\0');
  }
  afterEach(() => rmSync(procDir, { recursive: true, force: true }));

  it('reads each command line from /proc/<pid>/cmdline as raw bytes, so a non-ASCII argument matches, and needs no ps', () => {
    procDir = mkdtempSync(join(tmpdir(), 'orbit-fakeproc-'));
    const dir = '/home/dev/Código/.orbit/runs/orb-1/evidence/1/unit';
    entry(101, ['node', '/home/dev/Código/.orbit/runs/orb-1/check-shim.mjs', dir, 'a1b2c3']);
    // A zombie or a kernel thread has an empty command line; an entry that went away has none at all.
    entry(102, []);
    entry(103, null);
    entry(process.pid, ['node', dir, 'a1b2c3']);
    entry('self', ['node', dir, 'a1b2c3']);
    const opts = { platform: 'linux' as const, procDir };
    expect(findProcesses((line) => line.endsWith(` ${dir} a1b2c3`), opts)).toEqual([101]);
    expect(findProcesses((line) => ` ${line} `.includes(' a1b2c3 '), opts)).toEqual([101]);
    expect(findProcesses((line) => line === '', opts)).toEqual([]);
  });

  it('finds a process by one entry of its environment, the whole entry and nothing longer, and skips one it may not read', () => {
    procDir = mkdtempSync(join(tmpdir(), 'orbit-fakeproc-'));
    entry(201, ['sh', '-c', 'make test'], ['PATH=/usr/bin', 'ORBIT_CHECK_TOKEN=f00d']);
    entry(202, ['sh'], ['ORBIT_CHECK_TOKEN=f00dd']);
    entry(203, ['sh'], ['XORBIT_CHECK_TOKEN=f00d']);
    entry(204, ['sh'], null);
    entry(205, ['sh'], ['ORBIT_CHECK_TOKEN=f00d']);
    // Another user's process, or one that made itself undumpable: its environment cannot be read.
    chmodSync(join(procDir, '205', 'environ'), 0o000);
    const opts = { platform: 'linux' as const, procDir };
    const found = findProcessesWithEnv('ORBIT_CHECK_TOKEN', 'f00d', opts);
    expect(found).toContain(201);
    expect(found.filter((p) => p !== 205)).toEqual([201]);
  });

  it('throws when /proc itself cannot be read, so an empty answer always means no such process', () => {
    procDir = join(tmpdir(), `orbit-noproc-${process.pid}-${Date.now()}`);
    const opts = { platform: 'linux' as const, procDir };
    expect(() => findProcesses(() => true, opts)).toThrow(expect.objectContaining({ code: 'INTERNAL', message: expect.stringContaining('cannot read') }));
    expect(() => findProcessesWithEnv('A', 'b', opts)).toThrow(expect.objectContaining({ code: 'INTERNAL' }));
  });
});

describe('findProcesses and findProcessesWithEnv on this host', () => {
  it('finds a live process by a non-ASCII argument, whatever the locale would make ps print', async () => {
    const marker = `/tmp/Código-${process.pid}-${Date.now()}/evidence/1/unit`;
    const child = spawn(NODE, ['-e', 'setInterval(() => {}, 1000)', '--', marker, 'c0ffee'], { detached: true, stdio: 'ignore', env: { PATH: process.env.PATH, LC_ALL: 'C' } });
    started.push(child);
    const has = (line: string): boolean => line.endsWith(` ${marker} c0ffee`);
    expect(await waitFor(() => findProcesses(has).length > 0)).toBe(true);
    expect(findProcesses(has)).toEqual([child.pid]);
  });

  it('finds a live process by an entry of its environment, and not a process without it', async () => {
    const token = `t${process.pid}x${Date.now()}`;
    const carrier = spawn(NODE, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', env: { PATH: process.env.PATH, ORBIT_CHECK_TOKEN: token } });
    const other = spawn(NODE, ['-e', 'setInterval(() => {}, 1000)', '--', `ORBIT_CHECK_TOKEN=${token}x`], { detached: true, stdio: 'ignore', env: { PATH: process.env.PATH, ORBIT_CHECK_TOKEN: `${token}x` } });
    started.push(carrier, other);
    expect(await waitFor(() => findProcessesWithEnv('ORBIT_CHECK_TOKEN', token).length > 0)).toBe(true);
    expect(findProcessesWithEnv('ORBIT_CHECK_TOKEN', token)).toEqual([carrier.pid]);
    carrier.kill('SIGKILL');
    expect(await waitFor(() => findProcessesWithEnv('ORBIT_CHECK_TOKEN', token).length === 0)).toBe(true);
  });
});
