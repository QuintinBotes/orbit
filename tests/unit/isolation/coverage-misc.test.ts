import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isOrbitError } from '../../../src/core/errors.ts';
import { ContainerIsolation, planMounts } from '../../../src/isolation/container.ts';
import { findLimitShell, withResourceLimits } from '../../../src/isolation/limits.ts';
import { findPs, withMemoryWatchdog } from '../../../src/isolation/memory.ts';
import { orbitTmpRoot, profileForCheck } from '../../../src/isolation/profiles.ts';
import { isExecutableFile, probeFailure, runBounded } from '../../../src/isolation/util.ts';
import type { SandboxProfile } from '../../../src/isolation/types.ts';
import { checkFor, snapshotFor, tempRoot, writeExecutable } from './fixtures.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (cleanups.length) cleanups.pop()!();
});
function root(): string {
  const t = tempRoot();
  cleanups.push(t.remove);
  return t.root;
}

function profile(over: Partial<SandboxProfile> & { readablePaths?: string[] } = {}): SandboxProfile {
  return { writablePaths: [], denyReadPaths: [], allowedHosts: [], limits: { timeoutMs: 60_000, memoryMb: null, cpus: null, pids: null }, ...over };
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return isOrbitError(err) ? err.code : `non-orbit: ${String(err)}`;
  }
  return undefined;
}

describe('ContainerIsolation edge cases', () => {
  function iso(r: string, extra: Record<string, unknown> = {}) {
    const docker = writeExecutable(join(r, 'bin', 'docker'), 'exit 0');
    const envFileDir = join(r, 'envfiles');
    mkdirSync(envFileDir);
    return { docker, envFileDir, provider: new ContainerIsolation({ dockerPath: docker, hostEnv: { PATH: '/usr/bin:/bin' }, envFileDir, ...extra }) };
  }

  it('cannot pull an image without a docker CLI', async () => {
    const provider = new ContainerIsolation({ dockerPath: '/nonexistent/dir/docker', hostEnv: { PATH: '/usr/bin' } });
    await expect(provider.ensureImage()).rejects.toMatchObject({ code: 'ISOLATION_UNAVAILABLE', message: 'docker CLI not found' });
  });

  it('refuses an image reference that is not one', () => {
    expect(codeOf(() => new ContainerIsolation({ image: 'bad image' }))).toBe('CONFIG_INVALID');
  });

  it('runs the container as the host user when none is configured', () => {
    const r = root();
    const { provider } = iso(r);
    const w = provider.wrap(['true'], profile({ writablePaths: [r] }), { cwd: r, env: {} });
    const at = w.argv.indexOf('--user');
    expect(w.argv[at + 1]).toBe(`${process.getuid!()}:${process.getgid!()}`);
    w.cleanup();
  });

  it('refuses to guess a user when the host has no uid or gid', () => {
    const r = root();
    const { provider, envFileDir } = iso(r);
    vi.spyOn(process, 'getuid').mockReturnValue(undefined as never);
    expect(codeOf(() => provider.wrap(['true'], profile({ writablePaths: [r] }), { cwd: r, env: {} }))).toBe('ISOLATION_UNAVAILABLE');
    expect(readdirSync(envFileDir)).toEqual([]);
  });

  it('keeps its env file in the system temp directory by default, and removes it on cleanup', () => {
    const r = root();
    const docker = writeExecutable(join(r, 'bin', 'docker'), 'exit 0');
    const provider = new ContainerIsolation({ dockerPath: docker, hostEnv: { PATH: '/usr/bin:/bin' }, user: { uid: 1, gid: 1 } });
    const w = provider.wrap(['true'], profile({ writablePaths: [r] }), { cwd: r, env: {} });
    const envFile = w.argv[w.argv.indexOf('--env-file') + 1]!;
    expect(existsSync(envFile)).toBe(true);
    w.cleanup();
    expect(existsSync(envFile)).toBe(false);
  });

  it('cleans up and rethrows when building the command fails half way', () => {
    const r = root();
    const { provider, envFileDir } = iso(r, { user: { uid: 1, gid: 1 }, labels: { 'bad key': 'v' } });
    expect(codeOf(() => provider.wrap(['true'], profile({ writablePaths: [r] }), { cwd: r, env: {} }))).toBe('INTERNAL');
    expect(readdirSync(envFileDir)).toEqual([]);
    const withNewline = iso(root(), { user: { uid: 1, gid: 1 }, labels: { ok: 'a\nb' } });
    expect(codeOf(() => withNewline.provider.wrap(['true'], profile({ writablePaths: [r] }), { cwd: r, env: {} }))).toBe('INTERNAL');
  });

  it('refuses a working directory that is not mounted, and an ulimit note on memory', () => {
    const r = root();
    const { provider } = iso(r, { user: { uid: 1, gid: 1 }, ulimits: { cpu_seconds: null, max_processes: null, max_file_mb: null, memory_mb: 512 } });
    const other = join(r, 'elsewhere');
    mkdirSync(other);
    expect(codeOf(() => provider.wrap(['true'], profile({ writablePaths: [join(r, 'wt')] }), { cwd: other, env: {} }))).toBe('INTERNAL');
    const wt = join(r, 'wt');
    mkdirSync(wt);
    const w = provider.wrap(['true'], profile({ writablePaths: [wt] }), { cwd: wt, env: {} });
    expect(w.limitations.join('\n')).toMatch(/isolation\.limits\.memory_mb \(512 MB\) is not used by the container provider/);
    w.cleanup();
  });

  it('refuses limits that docker cannot enforce', () => {
    const r = root();
    const { provider } = iso(r, { user: { uid: 1, gid: 1 } });
    const limits = (memoryMb: number | null, cpus: number | null, pids: number | null) => profile({ writablePaths: [r], limits: { timeoutMs: 1, memoryMb, cpus, pids } });
    expect(codeOf(() => provider.wrap(['true'], limits(5, null, null), { cwd: r, env: {} }))).toBe('CONFIG_INVALID');
    expect(codeOf(() => provider.wrap(['true'], limits(100.5, null, null), { cwd: r, env: {} }))).toBe('CONFIG_INVALID');
    expect(codeOf(() => provider.wrap(['true'], limits(null, 0, null), { cwd: r, env: {} }))).toBe('CONFIG_INVALID');
    expect(codeOf(() => provider.wrap(['true'], limits(null, Number.NaN, null), { cwd: r, env: {} }))).toBe('CONFIG_INVALID');
    expect(codeOf(() => provider.wrap(['true'], limits(null, null, 0), { cwd: r, env: {} }))).toBe('CONFIG_INVALID');
    expect(codeOf(() => provider.wrap(['true'], limits(null, null, 1.5), { cwd: r, env: {} }))).toBe('CONFIG_INVALID');
  });

  it('refuses a path that cannot be written into --mount, and a path both mounted and read-denied', () => {
    const r = root();
    const odd = join(r, 'a,b');
    mkdirSync(odd);
    expect(codeOf(() => planMounts(profile({ writablePaths: [odd] })))).toBe('ISOLATION_UNAVAILABLE');
    const wt = join(r, 'wt');
    mkdirSync(wt);
    expect(codeOf(() => planMounts(profile({ writablePaths: [wt], denyReadPaths: [wt] })))).toBe('INTERNAL');
  });

  it('notes a writable path that does not exist instead of mounting it', () => {
    const r = root();
    const { mounts, notes } = planMounts(profile({ writablePaths: [join(r, 'nope')] }));
    expect(mounts).toEqual([]);
    expect(notes).toEqual([`${join(r, 'nope')} does not exist and was not mounted.`]);
  });
});

describe('resource limit helpers', () => {
  it('finds no limit shell or ps among candidates that are not executable files', () => {
    const r = root();
    expect(findLimitShell([join(r, 'missing'), r])).toBeNull();
    expect(findPs([join(r, 'missing'), r])).toBeNull();
    const sh = writeExecutable(join(r, 'bash'), 'exit 0');
    expect(findLimitShell([join(r, 'missing'), sh])).toBe(sh);
    expect(findPs([sh])).toBe(sh);
  });

  it('searches the usual locations by default', () => {
    expect(findPs()).toMatch(/\/ps$/);
    expect(findLimitShell()).toMatch(/bash$/);
  });

  it('fails closed when asked for a limit with no tool to apply it', () => {
    expect(codeOf(() => withResourceLimits(['true'], { cpu_seconds: 5, max_processes: null, max_file_mb: null, memory_mb: null }, { shell: null }))).toBe('ISOLATION_UNAVAILABLE');
    expect(withResourceLimits(['true'], null)).toEqual(['true']);
  });

  it('uses the discovered ps and the default sampling interval for the memory watchdog', () => {
    const argv = withMemoryWatchdog(['sleep', '1'], 256);
    expect(argv[0]).toBe(process.execPath);
    expect(argv.slice(-2)).toEqual(['sleep', '1']);
    expect(argv[argv.length - 5]).toMatch(/ps$/);
    expect(argv[argv.length - 4]).toBe('256');
    expect(Number(argv[argv.length - 3])).toBeGreaterThan(0);
    expect(codeOf(() => withMemoryWatchdog(['x'], 256, { ps: null }))).toBe('ISOLATION_UNAVAILABLE');
    expect(codeOf(() => withMemoryWatchdog(['x'], 256, { node: '/nonexistent/node' }))).toBe('ISOLATION_UNAVAILABLE');
    expect(codeOf(() => withMemoryWatchdog(['x'], 8))).toBe('CONFIG_INVALID');
    expect(withMemoryWatchdog(['x'], null)).toEqual(['x']);
  });
});

describe('isolation util', () => {
  it('reports a process that cannot be started as a spawn error without throwing', async () => {
    const res = await runBounded('bad\0name', [], { timeoutMs: 1000 });
    expect(res.spawnError).toBeTruthy();
    expect(res.code).toBeNull();
    const missing = await runBounded('/nonexistent/binary', [], { timeoutMs: 1000 });
    expect(missing.spawnError).toMatch(/ENOENT/);
  });

  it('does not treat a directory as an executable file', () => {
    const r = root();
    expect(isExecutableFile(r)).toBe(false);
    const f = join(r, 'plain');
    writeFileSync(f, 'x', { mode: 0o644 });
    expect(isExecutableFile(f)).toBe(false);
  });

  it('describes a failed probe in one line', () => {
    const base = { code: 1, signal: null, stdout: '', stderr: '', timedOut: false, spawnError: null };
    expect(probeFailure({ ...base, spawnError: 'ENOENT' })).toBe('ENOENT');
    expect(probeFailure({ ...base, timedOut: true })).toBe('timed out');
    expect(probeFailure(base)).toBe('exit 1');
    expect(probeFailure({ ...base, code: null, signal: 'SIGKILL' })).toBe('signal SIGKILL');
    expect(probeFailure({ ...base, stderr: 'first\nlast line here\n' })).toBe('exit 1: last line here');
    expect(probeFailure({ ...base, stdout: 'from stdout' })).toBe('exit 1: from stdout');
    expect(probeFailure({ ...base, stderr: 'x'.repeat(500) })).toBe(`exit 1: ${'x'.repeat(300)}`);
  });
});

describe('profile defaults', () => {
  it('derives provider directories from the process environment and the real home when none is given', () => {
    const r = root();
    const wt = join(r, 'wt');
    mkdirSync(wt);
    const built = profileForCheck({ snapshot: snapshotFor({ repoRoot: r }), check: checkFor(), worktree: wt });
    expect(built.writablePaths).toEqual([wt]);
    expect(built.denyReadPaths.length).toBeGreaterThan(0);
  });

  it('names the temp root without a uid when the host has none', () => {
    vi.spyOn(process, 'getuid').mockReturnValue(undefined as never);
    expect(orbitTmpRoot()).toMatch(/\/tmp\/orbit$/);
    vi.restoreAllMocks();
    expect(orbitTmpRoot(7)).toMatch(/\/tmp\/orbit-7$/);
  });
});
