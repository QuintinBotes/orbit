import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isOrbitError } from '../../../src/core/errors.ts';
import { getIsolation } from '../../../src/isolation/index.ts';
import { dockerUlimitArgs, hasLimits, LIMIT_WRAPPER_NAME, limitScript, withResourceLimits } from '../../../src/isolation/limits.ts';
import { NoIsolation } from '../../../src/isolation/none.ts';
import { SandboxRuntimeIsolation, SRT_LIMITATIONS } from '../../../src/isolation/sandbox-runtime.ts';
import type { SandboxProfile } from '../../../src/isolation/types.ts';
import { defaultConfig } from '../../../src/policy/config.ts';
import type { IsolationLimits } from '../../../src/policy/types.ts';
import { tempRoot, writeExecutable } from './fixtures.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const ALL: IsolationLimits = { cpu_seconds: 120, max_processes: 256, max_file_mb: 64, memory_mb: null };
const NONE: IsolationLimits = { cpu_seconds: null, max_processes: null, max_file_mb: null, memory_mb: null };

function profile(writable: string[] = []): SandboxProfile {
  return { writablePaths: writable, denyReadPaths: [], allowedHosts: [], limits: { timeoutMs: 60_000, memoryMb: null, cpus: null, pids: null } };
}

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return isOrbitError(err) ? err.code : `non-orbit: ${String(err)}`;
  }
  return undefined;
}

describe('resource limit argv (isolation.limits)', () => {
  it('builds a bash ulimit wrapper that sets hard limits and execs the command as "$@"', () => {
    expect(limitScript(ALL)).toBe('set +o posix; ulimit -t 120 && ulimit -u 256 && ulimit -f 65536 && exec "$@"');
    expect(limitScript({ ...NONE, max_file_mb: 1 })).toBe('set +o posix; ulimit -f 1024 && exec "$@"');
    expect(withResourceLimits(['npm', 'test', '--', '$(rm -rf /)'], ALL, { shell: '/bin/bash' })).toEqual([
      '/bin/bash',
      '-c',
      limitScript(ALL),
      LIMIT_WRAPPER_NAME,
      'npm',
      'test',
      '--',
      '$(rm -rf /)',
    ]);
  });

  it('leaves the command alone when no limit is set, and fails closed when bash is missing', () => {
    expect(hasLimits(NONE)).toBe(false);
    expect(hasLimits(undefined)).toBe(false);
    expect(withResourceLimits(['npm', 'test'], NONE, { shell: null })).toEqual(['npm', 'test']);
    expect(withResourceLimits(['npm', 'test'], null)).toEqual(['npm', 'test']);
    expect(code(() => withResourceLimits(['npm', 'test'], ALL, { shell: null }))).toBe('ISOLATION_UNAVAILABLE');
    expect(code(() => limitScript({ ...NONE, cpu_seconds: 1.5 }))).toBe('CONFIG_INVALID');
    expect(code(() => limitScript({ ...NONE, max_processes: 0 }))).toBe('CONFIG_INVALID');
  });

  it('passes the same limits to docker as --ulimit flags, in bytes for file size', () => {
    expect(dockerUlimitArgs(ALL)).toEqual(['--ulimit', 'cpu=120:120', '--ulimit', 'nproc=256:256', '--ulimit', `fsize=${64 * 1024 * 1024}:${64 * 1024 * 1024}`]);
    expect(dockerUlimitArgs(NONE)).toEqual([]);
  });
});

describe('providers apply isolation.limits', () => {
  it('sandbox-runtime puts the wrapper inside the sandbox, after srt, and says what it enforces', () => {
    const t = tempRoot('orbit-limits-');
    cleanups.push(t.remove);
    const bin = join(t.root, 'bin');
    for (const tool of ['bwrap', 'socat', 'rg']) writeExecutable(join(bin, tool), 'exit 0');
    const srt = writeExecutable(join(t.root, 'srt-bin', 'srt'), 'exit 0');
    for (const arch of ['x64', 'arm64']) writeExecutable(join(t.root, 'srt-bin', 'vendor', 'seccomp', arch, 'apply-seccomp'), 'exit 0');
    const settingsDir = join(t.root, 'settings');
    mkdirSync(settingsDir);
    const wt = join(t.root, 'wt');
    mkdirSync(wt);

    const iso = new SandboxRuntimeIsolation({ srtPath: srt, pathEnv: bin, platform: 'linux', settingsDir, limits: ALL, limitShell: '/bin/bash' });
    const w = iso.wrap(['sh', '-c', 'exit 7'], profile([wt]), { cwd: wt, env: { PATH: '/usr/bin' } });
    cleanups.push(w.cleanup);
    expect(w.argv.slice(3)).toEqual(['--', '/bin/bash', '-c', limitScript(ALL), LIMIT_WRAPPER_NAME, 'sh', '-c', 'exit 7']);
    expect(w.limitations[0]).toMatch(/ulimit hard limits inside the sandbox \(CPU time 120 s per process, 256 processes for the user id, files up to 64 MB\)/);
    expect(w.limitations).not.toContain(SRT_LIMITATIONS[0]);

    const plain = new SandboxRuntimeIsolation({ srtPath: srt, pathEnv: bin, platform: 'linux', settingsDir });
    const p = plain.wrap(['sh', '-c', 'exit 7'], profile([wt]), { cwd: wt, env: { PATH: '/usr/bin' } });
    cleanups.push(p.cleanup);
    expect(p.argv.slice(3)).toEqual(['--', 'sh', '-c', 'exit 7']);
    expect(p.limitations[0]).toBe(SRT_LIMITATIONS[0]);

    const noBash = new SandboxRuntimeIsolation({ srtPath: srt, pathEnv: bin, platform: 'linux', settingsDir, limits: ALL, limitShell: null });
    expect(code(() => noBash.wrap(['true'], profile([wt]), { cwd: wt, env: {} }))).toBe('ISOLATION_UNAVAILABLE');
  });

  it('getIsolation hands the configured limits to sandbox-runtime and none', () => {
    const cfg = { ...defaultConfig().isolation, limits: ALL };
    const none = getIsolation({ ...cfg, provider: 'none', allow_unisolated: true }, { orbitInstallDir: '/opt/orbit', mode: 'supervised' });
    expect(none).toBeInstanceOf(NoIsolation);
    const w = none.wrap(['true'], profile(), { cwd: '/', env: {} });
    expect(w.argv.slice(1, 4)).toEqual(['-c', limitScript(ALL), LIMIT_WRAPPER_NAME]);
    expect(w.limitations.join('\n')).toMatch(/only ulimit hard limits apply/);
    expect(getIsolation(defaultConfig().isolation, { orbitInstallDir: '/opt/orbit' })).toBeInstanceOf(SandboxRuntimeIsolation);
    expect(new NoIsolation().wrap(['true'], profile(), { cwd: '/', env: {} }).argv).toEqual(['true']);
  });
});
