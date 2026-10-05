import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isOrbitError } from '../../../src/core/errors.ts';
import { ContainerIsolation } from '../../../src/isolation/container.ts';
import { getIsolation } from '../../../src/isolation/index.ts';
import { MEMORY_WATCHDOG_SOURCE, RESOURCE_LIMIT_EXIT_CODE, RESOURCE_LIMIT_MARKER, resourceLimitNote, withMemoryWatchdog } from '../../../src/isolation/memory.ts';
import { NoIsolation } from '../../../src/isolation/none.ts';
import { SandboxRuntimeIsolation } from '../../../src/isolation/sandbox-runtime.ts';
import type { SandboxProfile } from '../../../src/isolation/types.ts';
import { defaultConfig } from '../../../src/policy/config.ts';
import type { IsolationLimits } from '../../../src/policy/types.ts';
import { tempRoot, writeExecutable } from './fixtures.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const MEM: IsolationLimits = { cpu_seconds: null, max_processes: null, max_file_mb: null, memory_mb: 512 };
const PS = '/bin/ps';

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return isOrbitError(err) ? err.code : `non-orbit: ${String(err)}`;
  }
  return undefined;
}

function profile(writable: string[] = []): SandboxProfile {
  return { writablePaths: writable, denyReadPaths: [], allowedHosts: [], limits: { timeoutMs: 60_000, memoryMb: null, cpus: null, pids: null } };
}

describe('withMemoryWatchdog argv', () => {
  it('runs the command after the supervisor, with ps, the limit and the sampling interval as plain arguments', () => {
    const argv = withMemoryWatchdog(['npm', 'test', '--', '$(rm -rf /)'], 512, { ps: PS, node: process.execPath, intervalMs: 250 });
    expect(argv).toEqual([process.execPath, '-e', MEMORY_WATCHDOG_SOURCE, PS, '512', '250', 'npm', 'test', '--', '$(rm -rf /)']);
  });

  it('leaves the command alone without a limit and fails closed when it cannot sample or the limit is not usable', () => {
    expect(withMemoryWatchdog(['npm', 'test'], null, { ps: null })).toEqual(['npm', 'test']);
    expect(withMemoryWatchdog(['npm', 'test'], undefined)).toEqual(['npm', 'test']);
    expect(code(() => withMemoryWatchdog(['npm', 'test'], 512, { ps: null }))).toBe('ISOLATION_UNAVAILABLE');
    expect(code(() => withMemoryWatchdog(['npm', 'test'], 512, { ps: PS, node: '/nonexistent/node' }))).toBe('ISOLATION_UNAVAILABLE');
    expect(code(() => withMemoryWatchdog(['npm', 'test'], 8, { ps: PS }))).toBe('CONFIG_INVALID');
    expect(code(() => withMemoryWatchdog(['npm', 'test'], 512.5, { ps: PS }))).toBe('CONFIG_INVALID');
  });

  it('reads the marker line a stopped command leaves, and only a line that starts with it', () => {
    expect(resourceLimitNote(`some output\n${RESOURCE_LIMIT_MARKER} memory: the command used 900 MB resident, over isolation.limits.memory_mb (512 MB); the command was stopped\n`)).toBe(
      'memory: the command used 900 MB resident, over isolation.limits.memory_mb (512 MB); the command was stopped',
    );
    expect(resourceLimitNote(`echo ${RESOURCE_LIMIT_MARKER} not at the start\n`)).toBeNull();
    expect(resourceLimitNote('')).toBeNull();
    expect(RESOURCE_LIMIT_EXIT_CODE).toBe(198);
  });
});

describe('providers and isolation.limits.memory_mb', () => {
  function srtFixture() {
    const t = tempRoot('orbit-memory-');
    cleanups.push(t.remove);
    const bin = join(t.root, 'bin');
    for (const tool of ['bwrap', 'socat', 'rg']) writeExecutable(join(bin, tool), 'exit 0');
    const srt = writeExecutable(join(t.root, 'srt-bin', 'srt'), 'exit 0');
    for (const arch of ['x64', 'arm64']) writeExecutable(join(t.root, 'srt-bin', 'vendor', 'seccomp', arch, 'apply-seccomp'), 'exit 0');
    const settingsDir = join(t.root, 'settings');
    mkdirSync(settingsDir);
    const wt = join(t.root, 'wt');
    mkdirSync(wt);
    return { bin, srt, settingsDir, wt };
  }

  it('sandbox-runtime puts the watchdog outside the sandbox, around srt, and says what it can and cannot see', () => {
    const f = srtFixture();
    const iso = new SandboxRuntimeIsolation({ srtPath: f.srt, pathEnv: f.bin, platform: 'linux', settingsDir: f.settingsDir, limits: MEM, memory: { ps: PS, intervalMs: 100 } });
    const w = iso.wrap(['sh', '-c', 'exit 7'], profile([f.wt]), { cwd: f.wt, env: { PATH: '/usr/bin' } });
    cleanups.push(w.cleanup);
    expect(w.argv.slice(0, 6)).toEqual([process.execPath, '-e', MEMORY_WATCHDOG_SOURCE, PS, '512', '100']);
    expect(w.argv[6]).toBe(f.srt);
    expect(w.argv.slice(-4)).toEqual(['--', 'sh', '-c', 'exit 7']);
    expect(w.limitations[0]).toMatch(/a watchdog kills the command's processes when their summed resident memory passes 512 MB/);
    expect(w.limitations[0]).toMatch(/sampled every 500 ms/);
    expect(w.limitations[0]).not.toMatch(/Memory is not limited/);

    const noMemory = new SandboxRuntimeIsolation({ srtPath: f.srt, pathEnv: f.bin, platform: 'linux', settingsDir: f.settingsDir, limits: { ...MEM, memory_mb: null }, memory: { ps: PS } });
    const n = noMemory.wrap(['true'], profile([f.wt]), { cwd: f.wt, env: { PATH: '/usr/bin' } });
    cleanups.push(n.cleanup);
    expect(n.argv[0]).toBe(f.srt);

    const noPs = new SandboxRuntimeIsolation({ srtPath: f.srt, pathEnv: f.bin, platform: 'linux', settingsDir: f.settingsDir, limits: MEM, memory: { ps: null } });
    expect(code(() => noPs.wrap(['true'], profile([f.wt]), { cwd: f.wt, env: {} }))).toBe('ISOLATION_UNAVAILABLE');
  });

  it('getIsolation passes the default limits, memory included, to sandbox-runtime', () => {
    const iso = getIsolation(defaultConfig().isolation, { orbitInstallDir: '/opt/orbit' });
    expect(iso).toBeInstanceOf(SandboxRuntimeIsolation);
    expect((iso as unknown as { opts: { limits: IsolationLimits } }).opts.limits).toEqual({ cpu_seconds: 3600, max_processes: 2048, max_file_mb: 2048, memory_mb: 4096 });
  });

  it('none and the container provider say the limit is not theirs to enforce', () => {
    const none = new NoIsolation({ limits: MEM, limitShell: null }).wrap(['true'], profile(), { cwd: '/', env: {} });
    expect(none.argv).toEqual(['true']);
    expect(none.limitations.join('\n')).toMatch(/isolation\.limits\.memory_mb 512 MB is not enforced without a sandbox-runtime/);
    expect(new NoIsolation({ limits: { ...MEM, cpu_seconds: 5 }, limitShell: '/bin/bash' }).wrap(['true'], profile(), { cwd: '/', env: {} }).limitations.join('\n')).toMatch(/No memory limit \(isolation\.limits\.memory_mb 512 MB is not enforced/);
  });

  it('the container provider keeps its own memory limit and says memory_mb is not what it enforces', () => {
    const t = tempRoot('orbit-memory-container-');
    cleanups.push(t.remove);
    const docker = writeExecutable(join(t.root, 'docker-bin', 'docker'), 'exit 0');
    const envFileDir = join(t.root, 'envfiles');
    mkdirSync(envFileDir);
    const wt = join(t.root, 'wt');
    mkdirSync(wt);
    writeFileSync(join(wt, 'f'), '');
    const iso = new ContainerIsolation({ image: 'alpine:3', dockerPath: docker, hostEnv: { PATH: '/usr/bin:/bin', HOME: '/home/acme' }, envFileDir, user: { uid: 1, gid: 1 }, defaults: { memoryMb: 1024, cpus: 1, pids: 64 }, ulimits: MEM });
    const w = iso.wrap(['true'], profile([wt]), { cwd: wt, env: {} });
    cleanups.push(w.cleanup);
    expect(w.argv[w.argv.indexOf('--memory') + 1]).toBe('1024m');
    expect(w.argv[0]).toBe(docker);
    expect(w.limitations.join('\n')).toMatch(/isolation\.limits\.memory_mb \(512 MB\) is not used by the container provider; Docker enforces 1024 MB/);
  });
});
