import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isOrbitError } from '../../../src/core/errors.ts';
import { getIsolation } from '../../../src/isolation/index.ts';
import { dockerUlimitArgs, hasLimits, LIMIT_WRAPPER_NAME, limitScript, resourceLimitRefusals, unenforcedLimits, withResourceLimits } from '../../../src/isolation/limits.ts';
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
    expect(limitScript(ALL)).toMatch(/^set \+o posix; orbit_limit\(\) \{.*\}; orbit_limit -t 120 && orbit_limit -u 256 && orbit_limit -f 65536 && exec "\$@"$/);
    expect(limitScript({ ...NONE, max_file_mb: 1 })).toMatch(/; orbit_limit -f 1024 && exec "\$@"$/);
    // Setting uses plain ulimit (soft and hard together), so the command cannot raise a limit back.
    expect(limitScript(ALL)).toContain('ulimit "$1" "$2"');
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

describe('the wrapper under a host that is already stricter (macOS CI runners: hard process limit below 2048)', () => {
  // Lowers the hard process limit first, as such a host has it, then runs the wrapper.
  const underHardLimit = (hard: number, limits: IsolationLimits, cmd: string) =>
    spawnSync('/bin/bash', ['-c', `ulimit -u ${hard} && exec "$@"`, 'host', '/bin/bash', '-c', limitScript(limits), LIMIT_WRAPPER_NAME, '/bin/bash', '-c', cmd], { encoding: 'utf8' });

  it('keeps the stricter host limit and still runs the command', () => {
    const current = Number(spawnSync('/bin/bash', ['-c', 'ulimit -H -u'], { encoding: 'utf8' }).stdout.trim());
    const hard = Math.min(current, 1500) - 1;
    const r = underHardLimit(hard, { ...NONE, max_processes: hard + 500 }, 'ulimit -H -u; exit 0');
    expect(r.status, r.stderr).toBe(0);
    // macOS reports at most kern.maxprocperuid, so compare with what the host itself reads back after setting.
    const hostSees = spawnSync('/bin/bash', ['-c', `ulimit -u ${hard} && ulimit -H -u`], { encoding: 'utf8' }).stdout.trim();
    expect(r.stdout.trim()).toBe(hostSees);
  });

  it('still lowers a limit the host allows, and the command cannot raise it back', () => {
    const r = spawnSync('/bin/bash', ['-c', limitScript({ ...NONE, max_processes: 300 }), LIMIT_WRAPPER_NAME, '/bin/bash', '-c', 'ulimit -H -u; ulimit -u 301 2>/dev/null && echo raised; exit 0'], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe('300');
  });

  it('exits 125 with a message, never 1, when a limit cannot be applied', () => {
    // A stricter host limit is kept, so the remaining failure is a limit bash cannot read: an unknown flag stands in for it.
    const r = spawnSync('/bin/bash', ['-c', limitScript({ ...NONE, cpu_seconds: 60 }).replace('orbit_limit -t 60', 'orbit_limit -Z 60'), LIMIT_WRAPPER_NAME, '/bin/bash', '-c', 'exit 0'], { encoding: 'utf8' });
    expect(r.status).toBe(125);
    expect(r.stderr).toMatch(/^orbit-limits: /m);
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

describe('unenforcedLimits and resourceLimitRefusals (isolation.require_resource_limits, G24)', () => {
  const WITH_MEMORY: IsolationLimits = { ...ALL, memory_mb: 4096 };

  it('CPU time, process count and file size are enforced by every provider; only memory differs', () => {
    for (const kind of ['sandbox-runtime', 'container', 'none'] as const) expect(unenforcedLimits(kind, { ...ALL }, { memory_mb: 4096 }), kind).toEqual([]);
  });

  it('memory: sandbox-runtime only samples, none enforces nothing, the container counts only with a cap no higher than the limit', () => {
    expect(unenforcedLimits('sandbox-runtime', WITH_MEMORY, null)).toEqual([expect.objectContaining({ limit: 'memory_mb', configured: 4096, reason: expect.stringContaining('no hard memory cap') })]);
    expect(unenforcedLimits('none', WITH_MEMORY, null)).toEqual([expect.objectContaining({ limit: 'memory_mb', reason: expect.stringContaining('enforces no memory limit') })]);
    expect(unenforcedLimits('container', WITH_MEMORY, { memory_mb: 4096 })).toEqual([]);
    expect(unenforcedLimits('container', WITH_MEMORY, { memory_mb: 1024 })).toEqual([]);
    expect(unenforcedLimits('container', WITH_MEMORY, { memory_mb: 4097 })).toEqual([expect.objectContaining({ reason: expect.stringContaining('isolation.container.memory_mb (4097 MB), which is higher') })]);
    expect(unenforcedLimits('container', WITH_MEMORY, null)).toEqual([expect.objectContaining({ reason: expect.stringContaining('no isolation.container section') })]);
  });

  it('refusals are empty unless the policy requires the limits, and then say which limit and which provider', () => {
    const base = defaultConfig('autonomous').isolation;
    expect(base.require_resource_limits).toBe(false);
    expect(resourceLimitRefusals(base, 'sandbox-runtime')).toEqual([]);
    const required = { ...base, require_resource_limits: true };
    expect(resourceLimitRefusals(required, 'sandbox-runtime')).toEqual([expect.stringMatching(/^isolation\.require_resource_limits is true but sandbox-runtime cannot enforce isolation\.limits\.memory_mb \(4096 MB\)/)]);
    expect(resourceLimitRefusals({ ...required, limits: { ...base.limits!, memory_mb: null } }, 'sandbox-runtime')).toEqual([]);
    // A snapshot written before the key existed has neither the key nor possibly the limits: nothing is required.
    const { require_resource_limits: _omitted, ...legacy } = base;
    expect(resourceLimitRefusals(legacy, 'none')).toEqual([]);
  });
});
