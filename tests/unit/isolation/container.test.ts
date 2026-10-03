import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isOrbitError } from '../../../src/core/errors.ts';
import { ContainerIsolation, DEFAULT_CONTAINER_IMAGE, containerEnvFor, planMounts } from '../../../src/isolation/container.ts';
import type { SandboxProfile } from '../../../src/isolation/types.ts';
import { tempRoot, writeExecutable } from './fixtures.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
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

/** A docker CLI stand-in that records its arguments and answers the few subcommands Orbit uses. */
const FAKE_DOCKER = `
echo "$*" >> "$DOCKER_FAKE_LOG"
case "$1" in
  info)
    if [ -n "$DOCKER_FAKE_HANG" ]; then sleep 30; fi
    if [ "$DOCKER_FAKE_INFO" = fail ]; then echo "Cannot connect to the Docker daemon" >&2; exit 1; fi
    echo 29.4.0 ;;
  image)
    if [ -f "$DOCKER_FAKE_STATE/image" ]; then echo sha256:abc; exit 0; fi
    echo "Error: No such image" >&2; exit 1 ;;
  pull)
    if [ "$DOCKER_FAKE_PULL" = fail ]; then echo "pull access denied" >&2; exit 1; fi
    touch "$DOCKER_FAKE_STATE/image" ;;
  rm) exit 0 ;;
esac`;

function fakeDocker(r: string, env: Record<string, string> = {}) {
  const state = join(r, 'docker-state');
  mkdirSync(state);
  const docker = writeExecutable(join(r, 'docker-bin', 'docker'), FAKE_DOCKER);
  const log = join(r, 'docker.log');
  writeFileSync(log, '');
  const envFileDir = join(r, 'envfiles');
  mkdirSync(envFileDir);
  const hostEnv = { PATH: '/usr/bin:/bin', HOME: '/home/acme', DOCKER_FAKE_LOG: log, DOCKER_FAKE_STATE: state, SECRET_TOKEN: 'nope', ...env };
  const calls = () => readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return { docker, log, state, envFileDir, hostEnv, calls };
}

function flagValue(argv: string[], flag: string): string[] {
  const out: string[] = [];
  argv.forEach((a, i) => {
    if (a === flag && argv[i + 1] !== undefined) out.push(argv[i + 1]!);
  });
  return out;
}

describe('ContainerIsolation.wrap', () => {
  it('builds the hardened docker run invocation with the worktree at its own path', () => {
    const r = root();
    const f = fakeDocker(r);
    const wt = join(r, 'wt');
    mkdirSync(join(wt, 'pkg'), { recursive: true });
    const iso = new ContainerIsolation({ image: 'alpine:3', dockerPath: f.docker, hostEnv: f.hostEnv, envFileDir: f.envFileDir, user: { uid: 501, gid: 20 }, labels: { 'orbit.run': 'orb-1' } });
    const w = iso.wrap(['npm', 'test', '--', '-c'], profile({ writablePaths: [wt], limits: { timeoutMs: 1, memoryMb: 256, cpus: 0.5, pids: 64 } }), {
      cwd: join(wt, 'pkg'),
      env: { PATH: '/host/bin', HOME: '/home/acme', FOO: 'bar baz' },
    });
    const a = w.argv;
    expect(a[0]).toBe(f.docker);
    expect(a.slice(1, 6)).toEqual(['run', '--rm', '--pull', 'never', '--name']);
    expect(flagValue(a, '--name')).toEqual([w.containerName]);
    expect(w.containerName).toMatch(/^orbit-[0-9a-f]{12}$/);
    expect(flagValue(a, '--label')).toEqual(['orbit.isolation=container', 'orbit.run=orb-1']);
    expect(flagValue(a, '--network')).toEqual(['none']);
    expect(flagValue(a, '--memory')).toEqual(['256m']);
    expect(flagValue(a, '--memory-swap')).toEqual(['256m']);
    expect(flagValue(a, '--cpus')).toEqual(['0.5']);
    expect(flagValue(a, '--pids-limit')).toEqual(['64']);
    expect(a).toContain('--read-only');
    expect(flagValue(a, '--tmpfs')).toEqual(['/tmp:rw,noexec,nosuid,size=256m']);
    expect(flagValue(a, '--cap-drop')).toEqual(['ALL']);
    expect(flagValue(a, '--security-opt')).toEqual(['no-new-privileges']);
    expect(flagValue(a, '--user')).toEqual(['501:20']);
    expect(a).toContain('--init');
    expect(flagValue(a, '--mount')).toEqual([`type=bind,src=${wt},dst=${wt}`]);
    expect(flagValue(a, '-w')).toEqual([join(wt, 'pkg')]);
    // Image, then the command untouched, at the very end.
    expect(a.slice(-5)).toEqual(['alpine:3', 'npm', 'test', '--', '-c']);

    // The docker CLI gets only what it needs to reach its daemon.
    expect(w.env).toEqual({ PATH: '/usr/bin:/bin', HOME: '/home/acme', DOCKER_FAKE_LOG: f.log, DOCKER_FAKE_STATE: f.state });

    const envFile = flagValue(a, '--env-file')[0]!;
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(envFile, 'utf8')).toBe('FOO=bar baz\nHOME=/tmp\nTMPDIR=/tmp\n');
    expect(w.limitations.join('\n')).toMatch(/not available in containers/);

    w.cleanup();
    expect(existsSync(envFile)).toBe(false);
    expect(readdirSync(f.envFileDir)).toEqual([]);
    w.cleanup();
    expect(f.calls().filter((c) => c.startsWith('rm '))).toEqual([`rm -f ${w.containerName}`]);
  });

  it('uses the configured defaults where the profile leaves limits open', () => {
    const r = root();
    const f = fakeDocker(r);
    const iso = new ContainerIsolation({ dockerPath: f.docker, hostEnv: f.hostEnv, envFileDir: f.envFileDir, user: { uid: 1, gid: 1 }, defaults: { memoryMb: 1024, cpus: 3, pids: 99 } });
    const w = iso.wrap(['true'], profile({ writablePaths: [r] }), { cwd: r, env: {} });
    expect(flagValue(w.argv, '--memory')).toEqual(['1024m']);
    expect(flagValue(w.argv, '--cpus')).toEqual(['3']);
    expect(flagValue(w.argv, '--pids-limit')).toEqual(['99']);
    expect(w.argv).toContain(DEFAULT_CONTAINER_IMAGE);
    w.cleanup();
  });

  it('refuses a host allowlist instead of granting full network, leaving nothing behind', () => {
    const r = root();
    const f = fakeDocker(r);
    const iso = new ContainerIsolation({ dockerPath: f.docker, hostEnv: f.hostEnv, envFileDir: f.envFileDir, user: { uid: 1, gid: 1 } });
    let caught: unknown;
    try {
      iso.wrap(['npm', 'ci'], profile({ writablePaths: [r], allowedHosts: ['registry.npmjs.org'] }), { cwd: r, env: {} });
    } catch (err) {
      caught = err;
    }
    expect(isOrbitError(caught, 'ISOLATION_UNAVAILABLE')).toBe(true);
    expect((caught as Error).message).toMatch(/cannot restrict egress to registry\.npmjs\.org/);
    expect(readdirSync(f.envFileDir)).toEqual([]);
  });

  it('mounts readable paths read-only and hides denied paths inside mounts', () => {
    const r = root();
    const wt = join(r, 'wt');
    mkdirSync(join(wt, 'secrets'), { recursive: true });
    writeFileSync(join(wt, '.env'), 'TOKEN=x');
    const git = join(r, 'repo', '.git');
    mkdirSync(git, { recursive: true });
    const { mounts, notes } = planMounts(
      profile({
        writablePaths: [wt, join(r, 'missing')],
        readablePaths: [git, join(wt, 'inside-writable')],
        denyReadPaths: [join(wt, 'secrets'), join(wt, '.env'), join(wt, 'not-there'), join(r, 'home', '.ssh')],
      } as Partial<SandboxProfile>),
    );
    expect(mounts).toEqual([
      { kind: 'rw', path: wt },
      { kind: 'ro', path: git },
      { kind: 'shadow', path: join(wt, 'secrets'), isDir: true },
      { kind: 'shadow', path: join(wt, '.env'), isDir: false },
    ]);
    expect(notes).toEqual([
      `${join(r, 'missing')} does not exist and was not mounted.`,
      `${join(wt, 'inside-writable')} does not exist, so it could not be mounted read-only and the command can create it.`,
    ]);

    const f = fakeDocker(r);
    const w = new ContainerIsolation({ dockerPath: f.docker, hostEnv: f.hostEnv, envFileDir: f.envFileDir, user: { uid: 1, gid: 1 } }).wrap(
      ['true'],
      profile({ writablePaths: [wt], readablePaths: [git], denyReadPaths: [join(wt, 'secrets'), join(wt, '.env')] } as Partial<SandboxProfile>),
      { cwd: wt, env: {} },
    );
    expect(flagValue(w.argv, '--mount')).toEqual([
      `type=bind,src=${wt},dst=${wt}`,
      `type=bind,src=${git},dst=${git},readonly`,
      `type=tmpfs,dst=${join(wt, 'secrets')},tmpfs-size=65536`,
      `type=bind,src=/dev/null,dst=${join(wt, '.env')},readonly`,
    ]);
    w.cleanup();
  });

  it('keeps read-only paths inside a writable mount read-only', () => {
    const r = root();
    const wd = join(r, 'worker');
    mkdirSync(join(wd, 'hooks'), { recursive: true });
    writeFileSync(join(wd, 'settings.json'), '{}');
    const { mounts } = planMounts(profile({ writablePaths: [wd], readablePaths: [join(wd, 'settings.json'), join(wd, 'hooks')] } as Partial<SandboxProfile>));
    expect(mounts).toEqual([
      { kind: 'rw', path: wd },
      { kind: 'ro', path: join(wd, 'settings.json') },
      { kind: 'ro', path: join(wd, 'hooks') },
    ]);
    expect(codeOf(() => planMounts(profile({ writablePaths: [wd], readablePaths: [wd] } as Partial<SandboxProfile>)))).toBe('INTERNAL');
  });

  it('never resolves the docker CLI relative to the working directory', () => {
    const r = root();
    writeExecutable(join(r, 'docker'), 'exit 0');
    expect(new ContainerIsolation({ dockerPath: 'docker', hostEnv: { PATH: '.:' } }).resolveDocker()).toBeNull();
    expect(new ContainerIsolation({ dockerPath: './docker', hostEnv: { PATH: '' } }).resolveDocker()).toBeNull();
  });

  it('refuses unrepresentable mounts, invisible working directories and bad limits', () => {
    const r = root();
    const f = fakeDocker(r);
    const iso = new ContainerIsolation({ dockerPath: f.docker, hostEnv: f.hostEnv, envFileDir: f.envFileDir, user: { uid: 1, gid: 1 } });
    const comma = join(r, 'a,b');
    mkdirSync(comma);
    expect(codeOf(() => iso.wrap(['true'], profile({ writablePaths: [comma] }), { cwd: comma, env: {} }))).toBe('ISOLATION_UNAVAILABLE');
    mkdirSync(join(r, 'wt'));
    expect(codeOf(() => iso.wrap(['true'], profile({ writablePaths: [join(r, 'wt')] }), { cwd: '/usr', env: {} }))).toBe('INTERNAL');
    expect(codeOf(() => iso.wrap(['true'], profile({ writablePaths: [r], limits: { timeoutMs: 1, memoryMb: 2, cpus: null, pids: null } }), { cwd: r, env: {} }))).toBe('CONFIG_INVALID');
    expect(codeOf(() => iso.wrap(['true'], profile({ writablePaths: [r], limits: { timeoutMs: 1, memoryMb: null, cpus: 0, pids: null } }), { cwd: r, env: {} }))).toBe('CONFIG_INVALID');
    expect(codeOf(() => iso.wrap(['true'], profile({ writablePaths: [r], limits: { timeoutMs: 1, memoryMb: null, cpus: null, pids: 1.5 } }), { cwd: r, env: {} }))).toBe('CONFIG_INVALID');
    expect(codeOf(() => iso.wrap(['true'], profile({ writablePaths: [r] }), { cwd: r, env: { BAD: 'line\nbreak' } }))).toBe('INTERNAL');
    expect(codeOf(() => new ContainerIsolation({ image: '--privileged' }))).toBe('CONFIG_INVALID');
    expect(readdirSync(f.envFileDir)).toEqual([]);
  });

  it('fails closed when the docker CLI is missing', () => {
    const r = root();
    const iso = new ContainerIsolation({ hostEnv: { PATH: join(r, 'nothing') }, user: { uid: 1, gid: 1 } });
    expect(iso.resolveDocker()).toBeNull();
    expect(codeOf(() => iso.wrap(['true'], profile({ writablePaths: [r] }), { cwd: r, env: {} }))).toBe('ISOLATION_UNAVAILABLE');
  });
});

describe('containerEnvFor', () => {
  it('drops host-only variables and points HOME and TMPDIR at the tmpfs', () => {
    expect(containerEnvFor({ PATH: '/x', HOME: '/Users/acme', TMPDIR: '/var/folders/x', CI: '1' })).toEqual({ CI: '1', HOME: '/tmp', TMPDIR: '/tmp' });
    expect(codeOf(() => containerEnvFor({ 'NOT-VALID': 'x' }))).toBe('INTERNAL');
  });
});

describe('ContainerIsolation.available and ensureImage', () => {
  it('is available when the daemon answers and the image is present', async () => {
    const r = root();
    const f = fakeDocker(r);
    writeFileSync(join(f.state, 'image'), '');
    const status = await new ContainerIsolation({ image: 'alpine:3', dockerPath: f.docker, hostEnv: f.hostEnv }).available();
    expect(status).toEqual({ ok: true, detail: 'docker 29.4.0; image alpine:3 present' });
    expect(f.calls()).toEqual(['info --format {{.ServerVersion}}', 'image inspect --format {{.Id}} alpine:3']);
  });

  it('reports an unreachable daemon, a missing image and a missing CLI', async () => {
    const r = root();
    const down = fakeDocker(r, { DOCKER_FAKE_INFO: 'fail' });
    expect((await new ContainerIsolation({ dockerPath: down.docker, hostEnv: down.hostEnv }).available()).detail).toMatch(
      /docker daemon not reachable \(exit 1: Cannot connect to the Docker daemon\)/,
    );
    const r2 = root();
    const noImage = fakeDocker(r2);
    const missing = await new ContainerIsolation({ image: 'orbit-check:node22', dockerPath: noImage.docker, hostEnv: noImage.hostEnv }).available();
    expect(missing.ok).toBe(false);
    expect(missing.detail).toMatch(/image orbit-check:node22 is not present locally; build templates\/worker\.Dockerfile/);
    expect((await new ContainerIsolation({ hostEnv: { PATH: join(r, 'none') } }).available()).ok).toBe(false);
  });

  it('gives up on a hung daemon within the probe timeout', async () => {
    const r = root();
    const f = fakeDocker(r, { DOCKER_FAKE_HANG: '1' });
    const started = Date.now();
    const status = await new ContainerIsolation({ dockerPath: f.docker, hostEnv: f.hostEnv, probeTimeoutMs: 300 }).available();
    expect(status).toEqual({ ok: false, detail: 'docker daemon not reachable (timed out)' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('pulls a missing image once and reports a failed pull as unavailable isolation', async () => {
    const r = root();
    const f = fakeDocker(r);
    const iso = new ContainerIsolation({ image: 'alpine:3', dockerPath: f.docker, hostEnv: f.hostEnv });
    await iso.ensureImage();
    await iso.ensureImage();
    expect(f.calls().filter((c) => c.startsWith('pull'))).toEqual(['pull alpine:3']);

    const r2 = root();
    const bad = fakeDocker(r2, { DOCKER_FAKE_PULL: 'fail' });
    await expect(new ContainerIsolation({ image: 'alpine:3', dockerPath: bad.docker, hostEnv: bad.hostEnv }).ensureImage()).rejects.toMatchObject({
      code: 'ISOLATION_UNAVAILABLE',
      message: expect.stringMatching(/could not pull alpine:3 \(exit 1: pull access denied\)/),
    });
  });
});
