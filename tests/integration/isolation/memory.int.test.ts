import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { findPs, RESOURCE_LIMIT_EXIT_CODE, RESOURCE_LIMIT_MARKER, withMemoryWatchdog } from '../../../src/isolation/memory.ts';
import { SandboxRuntimeIsolation } from '../../../src/isolation/sandbox-runtime.ts';
import type { SandboxProfile } from '../../../src/isolation/types.ts';
import type { IsolationLimits } from '../../../src/policy/types.ts';
import { tempRoot } from '../../unit/isolation/fixtures.ts';
import { runWrapped } from './run.ts';

/**
 * The memory watchdog (G24) on this host's real ps and node: it kills a
 * command whose resident memory passes the limit, with its descendants,
 * leaves ordinary commands (exit codes, signals) alone, and under the real
 * srt it wraps the sandbox from outside.
 */
const ps = findPs();
const env = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
const HOLD = (mb: number, ms: number) => `const a=[];for(let i=0;i<${mb / 10};i++)a.push(Buffer.alloc(10*1024*1024,1));console.log('allocated');setTimeout(()=>{},${ms})`;

function wrapped(argv: string[], memoryMb: number) {
  return { argv: withMemoryWatchdog(argv, memoryMb, { intervalMs: 100 }), env, cleanup: () => {}, limitations: [] };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!ps)('memory watchdog with the host ps', () => {
  it('stops a command past the limit, kills its descendants and exits with the resource-limit status', async () => {
    // The parent spawns a child that holds the memory, and prints the child pid.
    const script = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(HOLD(400, 20_000))}],{stdio:'ignore'});console.log('child='+c.pid);setTimeout(()=>{},20000)`;
    const r = await runWrapped(wrapped([process.execPath, '-e', script], 150), process.cwd(), { timeoutMs: 20_000 });
    expect(r.code, r.stderr).toBe(RESOURCE_LIMIT_EXIT_CODE);
    expect(r.stderr).toContain(RESOURCE_LIMIT_MARKER);
    expect(r.stderr).toMatch(/memory: the command used \d+ MB resident, over isolation\.limits\.memory_mb \(150 MB\)/);
    const pid = Number(/child=(\d+)/.exec(r.stdout)?.[1]);
    expect(pid).toBeGreaterThan(1);
    await new Promise((done) => setTimeout(done, 200));
    expect(alive(pid)).toBe(false);
  });

  it('passes the exit status, output and a clean run through when the command stays under the limit', async () => {
    const r = await runWrapped(wrapped([process.execPath, '-e', 'console.log("fine"); console.error("warn"); process.exit(3)'], 2048), process.cwd());
    expect(r).toMatchObject({ code: 3, stdout: 'fine\n', stderr: 'warn\n' });
    const ok = await runWrapped(wrapped([process.execPath, '-e', HOLD(40, 600)], 2048), process.cwd());
    expect(ok.code).toBe(0);
    expect(ok.stdout).toBe('allocated\n');
  });

  it('forwards a termination signal so the command can shut down by itself', async () => {
    const script = `process.on('SIGTERM',()=>{console.log('got term');process.exit(0)});console.log('ready');setTimeout(()=>{},20000)`;
    const r = await runWrapped(wrapped([process.execPath, '-e', script], 2048), process.cwd(), { killAfterMs: 1200, killSignal: 'SIGTERM', timeoutMs: 15_000 });
    expect(r.stdout).toContain('got term');
    expect(r.code).toBe(0);
  });

  it('reports a command that cannot start with 127', async () => {
    const r = await runWrapped(wrapped(['/nonexistent/orbit-command'], 2048), process.cwd());
    expect(r.code).toBe(127);
    expect(r.stderr).toMatch(/could not start \/nonexistent\/orbit-command/);
  });
});

const orbitInstallDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const srtProbe = new SandboxRuntimeIsolation({ orbitInstallDir });
const status = await srtProbe.available();

describe.skipIf(!status.ok || !ps)('memory watchdog under the real srt', () => {
  const t = status.ok ? tempRoot('orbit-memory-srt-') : { root: '/nonexistent-orbit-test', remove: () => {} };
  afterAll(() => t.remove());
  const limits: IsolationLimits = { cpu_seconds: null, max_processes: null, max_file_mb: null, memory_mb: 150 };

  it('stops a sandboxed command that holds too much memory', async () => {
    const provider = new SandboxRuntimeIsolation({ orbitInstallDir, limits, memory: { intervalMs: 100 } });
    const profile: SandboxProfile = { writablePaths: [t.root], denyReadPaths: [], allowedHosts: [], limits: { timeoutMs: 30_000, memoryMb: null, cpus: null, pids: null } };
    const w = provider.wrap([process.execPath, '-e', HOLD(400, 20_000)], profile, { cwd: t.root, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: t.root } });
    try {
      const r = await runWrapped(w, t.root, { timeoutMs: 25_000 });
      expect(r.code, r.stderr).toBe(RESOURCE_LIMIT_EXIT_CODE);
      expect(r.stderr).toContain(RESOURCE_LIMIT_MARKER);
    } finally {
      w.cleanup();
    }
  });
});
