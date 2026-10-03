import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { faultPoint, resetFaults } from '../../../src/core/faults.ts';

const child = fileURLToPath(new URL('./fixtures/fault-child.ts', import.meta.url));

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runChild(faults: string | undefined, point: string, times = 1, killAfterMs?: number): Promise<ChildResult & { killed: boolean }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ORBIT_FAULTS;
    if (faults !== undefined) env.ORBIT_FAULTS = faults;
    const p = spawn(process.execPath, [child, point, String(times)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let killed = false;
    p.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    p.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    p.on('error', reject);
    let timer: NodeJS.Timeout | undefined;
    if (killAfterMs !== undefined) {
      // Count from the moment the child reports it reached the fault point,
      // so a slow start on a loaded machine cannot fake a hang.
      p.stdout.once('data', () => {
        timer = setTimeout(() => {
          killed = p.exitCode === null && p.signalCode === null;
          p.kill('SIGKILL');
        }, killAfterMs);
      });
    }
    p.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, killed });
    });
  });
}

const outcomes = (stdout: string): string[] => {
  const m = /after (.*)\n/.exec(stdout);
  if (!m) throw new Error(`child did not finish: ${stdout}`);
  return JSON.parse(m[1]!) as string[];
};

describe('faultPoint in a child process', () => {
  it('does nothing when ORBIT_FAULTS is unset', async () => {
    const r = await runChild(undefined, 'p', 2);
    expect(r.code).toBe(0);
    expect(outcomes(r.stdout)).toEqual(['none', 'none']);
  });

  it('crash exits immediately with 137, before any later code runs', async () => {
    const r = await runChild('p=crash', 'p');
    expect(r.code).toBe(137);
    expect(r.stdout).toBe('before\n');
    expect(r.stderr).toContain('fault injected at p: crash');
  });

  it('throw raises from the call site, once by default', async () => {
    const r = await runChild('p=throw', 'p', 3);
    expect(r.code).toBe(0);
    expect(outcomes(r.stdout)).toEqual(['threw:fault injected at p', 'none', 'none']);
  });

  it('lose-response returns the marker once, so the caller discards a result it already caused', async () => {
    const r = await runChild('p=lose-response', 'p', 2);
    expect(outcomes(r.stdout)).toEqual(['lose-response', 'none']);
  });

  it('a trailing * makes the fault fire on every call', async () => {
    const r = await runChild('p=lose-response*', 'p', 3);
    expect(outcomes(r.stdout)).toEqual(['lose-response', 'lose-response', 'lose-response']);
    const t = await runChild('p=throw*', 'p', 2);
    expect(outcomes(t.stdout)).toEqual(['threw:fault injected at p', 'threw:fault injected at p']);
  });

  it('only the named point fires; other points and malformed entries are ignored', async () => {
    const r = await runChild('other=crash,p=,=throw,p=explode,q', 'p', 1);
    expect(r.code).toBe(0);
    expect(outcomes(r.stdout)).toEqual(['none']);
  });

  it('parses several entries and trims point names', async () => {
    const r = await runChild('a=crash, p=lose-response', 'p', 1);
    expect(outcomes(r.stdout)).toEqual(['lose-response']);
  });

  it('hang blocks the process until it is killed', async () => {
    const r = await runChild('p=hang', 'p', 1, 500);
    expect(r.killed).toBe(true);
    expect(r.signal).toBe('SIGKILL');
    expect(r.stdout).toBe('before\n');
  });
});

describe('faultPoint in-process', () => {
  const saved = process.env.ORBIT_FAULTS;
  afterEach(() => {
    if (saved === undefined) delete process.env.ORBIT_FAULTS;
    else process.env.ORBIT_FAULTS = saved;
    resetFaults();
  });

  it('re-reads ORBIT_FAULTS after resetFaults and forgets which points fired', () => {
    process.env.ORBIT_FAULTS = 'x=lose-response';
    resetFaults();
    expect(faultPoint('x')).toBe('lose-response');
    expect(faultPoint('x')).toBeUndefined();
    resetFaults();
    expect(faultPoint('x')).toBe('lose-response');
    process.env.ORBIT_FAULTS = 'x=throw';
    resetFaults();
    expect(() => faultPoint('x')).toThrow('fault injected at x');
    expect(faultPoint('y')).toBeUndefined();
  });

  it('caches the table until reset, so changing the environment alone has no effect', () => {
    process.env.ORBIT_FAULTS = '';
    resetFaults();
    expect(faultPoint('x')).toBeUndefined();
    process.env.ORBIT_FAULTS = 'x=throw';
    expect(faultPoint('x')).toBeUndefined();
  });
});
