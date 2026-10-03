import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbitError } from '../../../src/core/errors.ts';
import { execCapture, spawnDetached, TRUNCATION_MARKER } from '../../../src/core/exec.ts';
import { isAlive, killGroup } from '../../../src/core/proc.ts';

const NODE = process.execPath;
const node = (code: string, ...args: string[]): string[] => [NODE, '-e', code, ...args];

async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return cond();
}

const leftovers: number[] = [];
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orbit-exec-'));
});
afterEach(() => {
  for (const pid of leftovers.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('execCapture', () => {
  it('captures stdout, stderr and the exit code', async () => {
    const r = await execCapture(node("process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 3"));
    expect(r).toMatchObject({ exitCode: 3, signal: null, stdout: 'out', stderr: 'err', timedOut: false, cancelled: false, stdoutTruncated: false, stderrTruncated: false });
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(r.pid).toBeGreaterThan(0);
  });

  it('passes arguments verbatim, with no shell interpretation', async () => {
    const tricky = ['$(echo pwned)', '; rm -rf /', '*', '"quoted"', 'a b', '`id`', ''];
    const r = await execCapture(node('process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...tricky));
    expect(JSON.parse(r.stdout)).toEqual(tricky);
  });

  it('feeds input on stdin and closes it', async () => {
    const r = await execCapture(node('process.stdin.pipe(process.stdout)'), { input: 'hello\nworld' });
    expect(r.stdout).toBe('hello\nworld');
    const bytes = await execCapture(node("let n=0;process.stdin.on('data',c=>n+=c.length).on('end',()=>process.stdout.write(String(n)))"), { input: new Uint8Array(70_000) });
    expect(bytes.stdout).toBe('70000');
  });

  it('gives an empty stdin when no input is supplied, so a reader never waits', async () => {
    const r = await execCapture(node("let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write('len '+d.length))"), { timeoutMs: 10_000 });
    expect(r.stdout).toBe('len 0');
    expect(r.timedOut).toBe(false);
  });

  it('tolerates a child that exits without reading a large input', async () => {
    const r = await execCapture(node('process.exit(0)'), { input: 'x'.repeat(4 * 1024 * 1024) });
    expect(r.exitCode).toBe(0);
  });

  it('uses exactly the given environment and working directory', async () => {
    const r = await execCapture(node('process.stdout.write(JSON.stringify([process.env.ORBIT_X ?? null, process.env.HOME ?? null, process.cwd()]))'), {
      cwd: dir,
      env: { ORBIT_X: 'acme', PATH: process.env.PATH, DROPPED: undefined },
    });
    const [x, home, cwd] = JSON.parse(r.stdout) as [string, string | null, string];
    expect(x).toBe('acme');
    expect(home).toBeNull();
    expect(realpathSync(cwd)).toBe(realpathSync(dir));
  });

  it('reports death by signal', async () => {
    const r = await execCapture(node("process.kill(process.pid, 'SIGTERM'); setTimeout(() => {}, 5000)"));
    expect(r.exitCode).toBeNull();
    expect(r.signal).toBe('SIGTERM');
    expect(r.timedOut).toBe(false);
  });

  it('on timeout kills the whole process group, grandchildren included', async () => {
    const r = await execCapture(['sh', '-c', 'sleep 30 & echo $!; sleep 30 & echo $!; wait'], { timeoutMs: 400, killGraceMs: 500 });
    expect(r.timedOut).toBe(true);
    const pids = r.stdout.trim().split('\n').map(Number);
    expect(pids).toHaveLength(2);
    leftovers.push(...pids);
    for (const pid of pids) expect(await waitFor(() => !isAlive(pid))).toBe(true);
    expect(r.durationMs).toBeLessThan(5_000);
  });

  it('escalates to SIGKILL when the group ignores SIGTERM', async () => {
    const r = await execCapture(node("process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"), { timeoutMs: 500, killGraceMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.signal).toBe('SIGKILL');
    expect(r.stdout).toBe('ready\n');
    expect(r.durationMs).toBeGreaterThanOrEqual(700);
  });

  it('stops background processes the command left behind when it exits', async () => {
    const t0 = Date.now();
    const r = await execCapture(['sh', '-c', 'sleep 30 & echo $!'], { timeoutMs: 20_000 });
    const pid = Number(r.stdout.trim());
    leftovers.push(pid);
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(await waitFor(() => !isAlive(pid))).toBe(true);
  });

  it('with killGroupOnExit false leaves them running but still returns', async () => {
    const r = await execCapture(['sh', '-c', 'sleep 30 & echo $!'], { timeoutMs: 20_000, killGroupOnExit: false, killGraceMs: 100 });
    const pid = Number(r.stdout.trim());
    leftovers.push(pid);
    expect(r.exitCode).toBe(0);
    expect(isAlive(pid)).toBe(true);
    killGroup(r.pid, 'SIGKILL');
  });

  it('truncates output beyond maxOutputBytes and says so', async () => {
    const r = await execCapture(node("process.stdout.write('x'.repeat(100000)); process.stderr.write('e'.repeat(10))"), { maxOutputBytes: 1_000 });
    expect(r.stdoutTruncated).toBe(true);
    expect(r.stderrTruncated).toBe(false);
    expect(r.stdout.startsWith('x'.repeat(1_000) + '\n')).toBe(true);
    expect(r.stdout).toContain(`${TRUNCATION_MARKER} 99000 bytes dropped after the first 1000]`);
    expect(r.stderr).toBe('eeeeeeeeee');
  });

  it('never splits a multi-byte character at the truncation point', async () => {
    const r = await execCapture(node("process.stdout.write('é'.repeat(1000))"), { maxOutputBytes: 1_001 });
    const head = r.stdout.split('\n')[0]!;
    expect(head).toBe('é'.repeat(500));
    expect(head).not.toContain('�');
  });

  it('a cancelled command stops like a timeout and is reported as cancelled', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const r = await execCapture(node('setInterval(() => {}, 1000)'), { abortSignal: ac.signal, timeoutMs: 20_000 });
    expect(r.cancelled).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(r.signal).toBe('SIGTERM');
  });

  it('an already-aborted signal stops the command at once', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await execCapture(node('setInterval(() => {}, 1000)'), { abortSignal: ac.signal });
    expect(r.cancelled).toBe(true);
  });

  it('rejects with NOT_FOUND for a missing executable or working directory', async () => {
    await expect(execCapture(['orbit-definitely-not-a-command-xyz'])).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const missing = execCapture(node('1'), { cwd: join(dir, 'missing') });
    await expect(missing).rejects.toBeInstanceOf(OrbitError);
    await expect(missing).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects an empty argv', async () => {
    await expect(execCapture([])).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('timeoutMs 0 disables the timeout', async () => {
    const r = await execCapture(node('setTimeout(() => {}, 300)'), { timeoutMs: 0 });
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
  });
});

describe('spawnDetached', () => {
  it('runs in its own process group with output in files and returns pid == pgid', async () => {
    const out = join(dir, 'w', 'out.log');
    const err = join(dir, 'w', 'err.log');
    const { pid, pgid } = spawnDetached(node("console.log('to out'); console.error('to err')"), { cwd: dir, stdoutPath: out, stderrPath: err });
    leftovers.push(pid);
    expect(pgid).toBe(pid);
    expect(await waitFor(() => !isAlive(pid))).toBe(true);
    expect(readFileSync(out, 'utf8')).toBe('to out\n');
    expect(readFileSync(err, 'utf8')).toBe('to err\n');
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'w')).mode & 0o777).toBe(0o700);
  });

  it('is the leader of a new group, so a group kill reaches its children', async () => {
    const out = join(dir, 'out.log');
    const { pid, pgid } = spawnDetached(['sh', '-c', 'sleep 30 & echo $!; wait'], { stdoutPath: out, stderrPath: out });
    leftovers.push(pid);
    expect(await waitFor(() => readFileSync(out, 'utf8').trim() !== '')).toBe(true);
    const grandchild = Number(readFileSync(out, 'utf8').trim());
    leftovers.push(grandchild);
    const ps = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' });
    expect(Number(ps.stdout.trim())).toBe(pgid);
    expect(killGroup(pgid, 'SIGKILL')).toBe(true);
    expect(await waitFor(() => !isAlive(pid) && !isAlive(grandchild))).toBe(true);
  });

  it('appends to existing files and interleaves both streams when the paths match', async () => {
    const log = join(dir, 'both.log');
    writeFileSync(log, 'previous\n');
    const { pid } = spawnDetached(node("console.log('o'); console.error('e')"), { stdoutPath: log, stderrPath: log });
    leftovers.push(pid);
    expect(await waitFor(() => !isAlive(pid))).toBe(true);
    const text = readFileSync(log, 'utf8');
    expect(text.startsWith('previous\n')).toBe(true);
    expect(text).toContain('o\n');
    expect(text).toContain('e\n');
  });

  it('passes the environment to the child', async () => {
    const out = join(dir, 'env.log');
    const { pid } = spawnDetached(node('process.stdout.write(process.env.ORBIT_Y ?? "none")'), { env: { ORBIT_Y: 'acme' }, stdoutPath: out, stderrPath: out });
    leftovers.push(pid);
    expect(await waitFor(() => !isAlive(pid))).toBe(true);
    expect(readFileSync(out, 'utf8')).toBe('acme');
  });

  it('does not keep the spawning process alive, and the child outlives it', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/detach-parent.ts', import.meta.url));
    const t0 = Date.now();
    const parent = spawn(NODE, [fixture, join(dir, 'child.log')], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    parent.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    const code = await new Promise<number | null>((resolve) => parent.on('close', resolve));
    const pid = Number(stdout);
    leftovers.push(pid);
    expect(code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(isAlive(pid)).toBe(true);
    expect(killGroup(pid, 'SIGKILL')).toBe(true);
  });

  it('throws NOT_FOUND synchronously for a missing executable or cwd', () => {
    const out = join(dir, 'x.log');
    expect(() => spawnDetached(['orbit-definitely-not-a-command-xyz'], { stdoutPath: out, stderrPath: out })).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(() => spawnDetached(node('1'), { cwd: join(dir, 'missing'), stdoutPath: out, stderrPath: out })).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(existsSync(join(dir, 'missing'))).toBe(false);
  });
});

describe('execCapture: adversarial review', () => {
  it('a command that exits before its timeout is not reported as timed out while an escaped descendant holds its pipes', async () => {
    // The grandchild starts its own session, so the group kill cannot reach it
    // and it keeps stdout open well past the timeout.
    const code =
      "const { spawn } = require('node:child_process'); const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }); c.unref(); console.log(c.pid)";
    const r = await execCapture(node(code), { timeoutMs: 600, killGraceMs: 300 });
    leftovers.push(Number(r.stdout.trim()));
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.cancelled).toBe(false);
  });

  it('never sends SIGKILL to a group that already exited after SIGTERM, since its id may be reused', async () => {
    const kill = vi.spyOn(process, 'kill');
    try {
      const leftover = await execCapture(['sh', '-c', 'sleep 30 & echo $!'], { timeoutMs: 20_000, killGraceMs: 400 });
      leftovers.push(Number(leftover.stdout.trim()));
      const timedOut = await execCapture(node('setInterval(() => {}, 1000)'), { timeoutMs: 200, killGraceMs: 400 });
      expect(timedOut.timedOut).toBe(true);
      expect(timedOut.signal).toBe('SIGTERM');
      // Past both grace periods.
      await new Promise((resolve) => setTimeout(resolve, 800));
      const sigkills = kill.mock.calls.filter(([, sig]) => sig === 'SIGKILL').map(([pid]) => pid);
      expect(sigkills).not.toContain(-leftover.pid);
      expect(sigkills).not.toContain(-timedOut.pid);
    } finally {
      kill.mockRestore();
    }
  });
});
