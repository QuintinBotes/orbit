import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Exec = typeof import('../../../src/core/exec.ts');

class FakeChild extends EventEmitter {
  pid: number | undefined;
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin: PassThrough | null = new PassThrough();
  unref = vi.fn();
  constructor(pid: number | undefined) {
    super();
    this.pid = pid;
  }
}

async function loadWithSpawn(spawn: (...args: unknown[]) => unknown): Promise<Exec> {
  vi.resetModules();
  vi.doMock('node:child_process', async (orig) => ({ ...(await orig<typeof import('node:child_process')>()), spawn }));
  return import('../../../src/core/exec.ts');
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orbit-exec-cov-'));
});
afterEach(() => {
  vi.doUnmock('node:child_process');
  vi.resetModules();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('spawn failures reported as OrbitError', () => {
  const cases: Array<[string, unknown, string, string]> = [
    ['ENOENT', Object.assign(new Error('spawn x ENOENT'), { code: 'ENOENT' }), 'NOT_FOUND', 'command not found: tool'],
    ['EACCES', Object.assign(new Error('spawn x EACCES'), { code: 'EACCES' }), 'INTERNAL', 'could not start tool: EACCES'],
    ['a thrown string', 'kaboom', 'INTERNAL', 'could not start tool: kaboom'],
    ['null', null, 'INTERNAL', 'could not start tool: null'],
  ];
  for (const [label, thrown, code, message] of cases) {
    it(`execCapture maps a synchronous spawn throw (${label}) to ${code}`, async () => {
      const exec = await loadWithSpawn(() => {
        throw thrown;
      });
      await expect(exec.execCapture(['tool'])).rejects.toMatchObject({ code, message });
    });
  }

  it('passes an OrbitError thrown by spawn through unchanged', async () => {
    let original: unknown;
    const exec = await loadWithSpawn(() => {
      throw original;
    });
    // Same module registry as exec.ts, so instanceof sees one class.
    const { OrbitError } = await import('../../../src/core/errors.ts');
    original = new OrbitError('POLICY_DENIED', 'nope');
    await expect(exec.execCapture(['tool'])).rejects.toBe(original);
  });

  it('keeps the original error as the cause', async () => {
    const cause = Object.assign(new Error('x'), { code: 'EMFILE' });
    const exec = await loadWithSpawn(() => {
      throw cause;
    });
    const err = await exec.execCapture(['tool']).catch((e: unknown) => e);
    expect((err as { cause: unknown; details: unknown }).cause).toBe(cause);
    expect((err as { cause: unknown; details: unknown }).details).toEqual({ command: 'tool', errno: 'EMFILE' });
  });

  it('spawnDetached rejects an empty argv and a missing cwd', async () => {
    const exec = await import('../../../src/core/exec.ts');
    expect(() => exec.spawnDetached([], { stdoutPath: join(dir, 'o'), stderrPath: join(dir, 'e') })).toThrow(expect.objectContaining({ code: 'INTERNAL' }));
    expect(() => exec.spawnDetached(['x'], { cwd: join(dir, 'nope'), stdoutPath: join(dir, 'o'), stderrPath: join(dir, 'e') })).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('spawnDetached reports an unusable output location as INTERNAL, not as a missing command', async () => {
    const exec = await import('../../../src/core/exec.ts');
    const blocker = join(dir, 'file');
    writeFileSync(blocker, 'x');
    expect(() => exec.spawnDetached([process.execPath, '-e', '0'], { stdoutPath: join(blocker, 'out.log'), stderrPath: join(blocker, 'err.log') })).toThrow(
      expect.objectContaining({ code: 'INTERNAL', message: expect.stringContaining('could not start') }),
    );
  });

  it('spawnDetached reports NOT_FOUND when the child never gets a pid', async () => {
    const child = new FakeChild(undefined);
    const exec = await loadWithSpawn(() => child);
    expect(() => exec.spawnDetached(['ghost'], { stdoutPath: join(dir, 'o'), stderrPath: join(dir, 'e') })).toThrow(expect.objectContaining({ code: 'NOT_FOUND', details: { command: 'ghost' } }));
    // the late 'error' event must not crash the process
    expect(() => child.emit('error', new Error('late'))).not.toThrow();
  });
});

describe('execCapture with a child that never received a pid', () => {
  it('rejects once with NOT_FOUND and ignores a second error event', async () => {
    const child = new FakeChild(undefined);
    const exec = await loadWithSpawn(() => child);
    const pending = exec.execCapture(['ghost'], { timeoutMs: 0 });
    child.emit('error', Object.assign(new Error('spawn ghost ENOENT'), { code: 'ENOENT' }));
    child.emit('error', Object.assign(new Error('again'), { code: 'ENOENT' }));
    await expect(pending).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('has no group to signal: abort and timeout are harmless and pid reports -1', async () => {
    const child = new FakeChild(undefined);
    const exec = await loadWithSpawn(() => child);
    const ac = new AbortController();
    const pending = exec.execCapture(['ghost'], { abortSignal: ac.signal, timeoutMs: 5, killGraceMs: 5 });
    ac.abort();
    await new Promise((r) => setTimeout(r, 40));
    child.emit('exit', 0, null);
    child.emit('close');
    const r = await pending;
    expect(r).toMatchObject({ pid: -1, cancelled: true, timedOut: true, exitCode: 0 });
  });
});

describe('execCapture when the group cannot be signalled', () => {
  // process.pid is an id killGroup refuses, so every group operation throws before any signal is sent.
  it('swallows a refused signal and an unprobeable group, and still resolves with the exit status', async () => {
    const kill = vi.spyOn(process, 'kill');
    const child = new FakeChild(process.pid);
    const exec = await loadWithSpawn(() => child);
    const ac = new AbortController();
    const pending = exec.execCapture(['x'], { abortSignal: ac.signal, timeoutMs: 10, killGraceMs: 10 });
    ac.abort();
    await new Promise((r) => setTimeout(r, 60));
    child.stdout.write('out');
    child.emit('exit', 3, null);
    child.emit('close');
    const r = await pending;
    expect(r).toMatchObject({ exitCode: 3, cancelled: true, timedOut: true, stdout: 'out', pid: process.pid });
    expect(kill).not.toHaveBeenCalledWith(-process.pid, expect.anything());
  });

  it('treats a failed liveness probe on exit as an empty group', async () => {
    const child = new FakeChild(process.pid);
    const exec = await loadWithSpawn(() => child);
    const pending = exec.execCapture(['x'], { timeoutMs: 0 });
    child.emit('exit', 0, null);
    child.emit('close');
    expect(await pending).toMatchObject({ exitCode: 0, cancelled: false, timedOut: false });
  });

  it('ignores a signalling error event after a successful start', async () => {
    const child = new FakeChild(process.pid);
    const exec = await loadWithSpawn(() => child);
    const pending = exec.execCapture(['x'], { timeoutMs: 0 });
    child.emit('error', new Error('EPERM while signalling'));
    child.emit('exit', 0, null);
    child.emit('close');
    expect((await pending).exitCode).toBe(0);
  });

  it('writes input to a child that has stdin and tolerates a pipe error', async () => {
    const child = new FakeChild(process.pid);
    const chunks: string[] = [];
    child.stdin!.on('data', (c: Buffer) => chunks.push(c.toString()));
    const exec = await loadWithSpawn(() => child);
    const pending = exec.execCapture(['x'], { timeoutMs: 0, input: 'hello' });
    child.stdin!.emit('error', new Error('EPIPE'));
    child.emit('exit', 0, null);
    child.emit('close');
    await pending;
    expect(chunks.join('')).toBe('hello');
  });

  it('closing twice resolves once', async () => {
    const child = new FakeChild(process.pid);
    const exec = await loadWithSpawn(() => child);
    const pending = exec.execCapture(['x'], { timeoutMs: 0 });
    child.emit('close');
    child.emit('close');
    expect((await pending).exitCode).toBeNull();
  });
});
