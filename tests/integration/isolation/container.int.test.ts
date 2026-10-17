import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContainerIsolation } from '../../../src/isolation/container.ts';
import type { SandboxProfile, WrappedCommand } from '../../../src/isolation/types.ts';
import { which } from '../../../src/isolation/util.ts';
import { tempRoot } from '../../unit/isolation/fixtures.ts';
import { runWrapped, type RunResult } from './run.ts';

/**
 * Real containers on the local engine (OrbStack here). Uses the small
 * alpine image, pulled once if missing; skips with the reason when the
 * daemon is not reachable or the pull fails.
 */
const IMAGE = 'alpine:latest';
const provider = new ContainerIsolation({ image: IMAGE, labels: { 'orbit.test': 'isolation' } });
let status = await provider.available();
if (!status.ok && /not present locally/.test(status.detail)) {
  try {
    await provider.ensureImage(120_000);
    status = await provider.available();
  } catch (err) {
    status = { ok: false, detail: (err as Error).message };
  }
}

describe.skipIf(!status.ok)(status.ok ? 'container isolation (real docker)' : `container isolation skipped: ${status.detail}`, () => {
  // Collection runs this body even when the suite is skipped, so only create files when it will run.
  const t = status.ok ? tempRoot('orbit-docker-int-') : { root: '/nonexistent-orbit-test', remove: () => {} };
  const worktree = join(t.root, 'wt');
  const readonlyDir = join(t.root, 'repo-git');
  // An engine slower to create a container than any fixed wait in a test: its docker holds `docker run` for 4 s.
  const slowDocker = join(t.root, 'slow-docker');
  const slowProvider = new ContainerIsolation({ image: IMAGE, labels: { 'orbit.test': 'isolation' }, dockerPath: slowDocker });
  const wraps: WrappedCommand[] = [];
  const base: SandboxProfile = {
    writablePaths: [worktree],
    denyReadPaths: [],
    allowedHosts: [],
    limits: { timeoutMs: 30_000, memoryMb: 128, cpus: 1, pids: 64 },
  };

  beforeAll(() => {
    mkdirSync(join(worktree, 'secrets'), { recursive: true });
    writeFileSync(join(worktree, 'secrets', 'key'), 'SECRET-IN-WORKTREE');
    writeFileSync(join(worktree, '.env'), 'TOKEN=acme-secret');
    writeFileSync(join(worktree, 'input.txt'), 'from host\n');
    mkdirSync(readonlyDir);
    writeFileSync(join(readonlyDir, 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(slowDocker, `#!/bin/sh\n[ "$1" = run ] && sleep 4\nexec ${JSON.stringify(which('docker', process.env.PATH))} "$@"\n`, { mode: 0o755 });
  });

  afterAll(() => {
    for (const w of wraps) w.cleanup();
    t.remove();
  });

  function wrap(argv: string[], profile: SandboxProfile = base, env: Record<string, string> = {}, p = provider): WrappedCommand {
    const w = p.wrap(argv, profile, { cwd: worktree, env });
    wraps.push(w);
    return w;
  }

  /**
   * Run a wrapped command and check how `docker run` ended before anything reads its output (issue #61). When docker
   * itself fails (exit 125 to 127, its reason on stderr) or never returns (killed at runWrapped's deadline), the command
   * printed nothing at all; read alone, that empty output looks like an isolation result, as "the read-only mount was
   * read back empty" did. The message names docker's own outcome instead.
   */
  async function run(w: WrappedCommand, code = 0): Promise<RunResult> {
    const started = Date.now();
    const r = await runWrapped(w, worktree);
    const how = r.signal ? `was killed (${r.signal}) after ${Date.now() - started} ms` : `exited ${r.code}`;
    expect({ code: r.code, signal: r.signal }, `docker run ${how}; its stderr: ${r.stderr.trim() || '(empty)'}`).toEqual({ code, signal: null });
    return r;
  }

  it('has no network interface but loopback, so egress fails', async () => {
    const r = await run(wrap(['sh', '-c', 'ls /sys/class/net; wget -q -T 3 -O /dev/null http://1.1.1.1/ 2>/dev/null; echo "net=$?"']));
    expect(r.stdout).toMatch(/^lo\nnet=[1-9]\d*\n$/);
  });

  it('applies the memory, CPU and pids limits', async () => {
    const r = await run(wrap(['cat', '/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/pids.max', '/sys/fs/cgroup/cpu.max']));
    expect(r.stdout.trim().split('\n')).toEqual([String(128 * 1024 * 1024), '64', '100000 100000']);
  });

  it('mounts the worktree read-write at its own path, as the host user', async () => {
    const r = await run(wrap(['sh', '-c', 'pwd; cat input.txt; echo from container > out.txt; id -u']));
    expect(r.stdout).toBe(`${worktree}\nfrom host\n${process.getuid!()}\n`);
    expect(readFileSync(join(worktree, 'out.txt'), 'utf8')).toBe('from container\n');
    expect(statSync(join(worktree, 'out.txt')).uid).toBe(process.getuid!());
  });

  it('keeps the root filesystem read-only and drops all capabilities', async () => {
    const r = await run(wrap(['sh', '-c', 'touch /etc/orbit 2>&1; grep -E "^(CapEff|NoNewPrivs)" /proc/self/status']));
    expect(r.stdout).toMatch(/Read-only file system/);
    expect(r.stdout).toMatch(/CapEff:\s+0000000000000000/);
    expect(r.stdout).toMatch(/NoNewPrivs:\s+1/);
  });

  it('hides denied paths inside the worktree and mounts readable paths read-only', async () => {
    const profile = {
      ...base,
      denyReadPaths: [join(worktree, 'secrets'), join(worktree, '.env')],
      readablePaths: [readonlyDir],
    } as SandboxProfile;
    const r = await run(wrap(['sh', '-c', `cat secrets/key .env 2>/dev/null; ls secrets | wc -l; cat ${readonlyDir}/HEAD; echo x > ${readonlyDir}/HEAD 2>/dev/null; echo "ro=$?"`], profile));
    expect(r.stdout).not.toContain('SECRET-IN-WORKTREE');
    expect(r.stdout).not.toContain('acme-secret');
    expect(r.stdout).toContain('ref: refs/heads/main');
    expect(r.stdout).toMatch(/ro=[1-9]/);
    expect(readFileSync(join(worktree, 'secrets', 'key'), 'utf8')).toBe('SECRET-IN-WORKTREE');
  });

  it('keeps a read-only path inside the writable worktree read-only', async () => {
    writeFileSync(join(worktree, 'trusted.json'), '{"frozen":true}');
    const profile = { ...base, readablePaths: [join(worktree, 'trusted.json')] } as SandboxProfile;
    const r = await run(wrap(['sh', '-c', 'echo x > trusted.json 2>/dev/null; echo "ro=$?"; cat trusted.json; echo y > other.txt && echo rw-ok'], profile));
    expect(r.stdout).toMatch(/^ro=[1-9]\d*\n\{"frozen":true\}rw-ok\n$/);
    expect(readFileSync(join(worktree, 'trusted.json'), 'utf8')).toBe('{"frozen":true}');
  });

  it('passes the exit status and the command environment through, without host paths', async () => {
    const r = await run(wrap(['sh', '-c', 'echo "$FOO|$HOME|$TMPDIR"; case "$PATH" in */Users/*) echo host-path;; esac; exit 3'], base, { FOO: 'bar baz', PATH: '/Users/acme/bin', HOME: '/Users/acme' }), 3);
    expect(r.stdout).toBe('bar baz|/tmp|/tmp\n');
  });

  // The CLI is killed once its container says it runs, not after a fixed wait: on a loaded engine a 2.5 s kill came
  // before docker had created the container, so there was nothing to find (issue #61).
  for (const [engine, p, marker] of [['the engine', provider, 'started'], ['an engine slower than a fixed wait', slowProvider, 'started-slow']] as const) it(`removes a container its killed CLI left running, on ${engine}`, async () => {
    const started = join(worktree, marker);
    const w = wrap(['sh', '-c', `touch '${started}' && exec sleep 30`], base, {}, p);
    const docker = w.argv[0]!;
    const running = () => execFileSync(docker, ['ps', '-aq', '--filter', `name=^${(w as unknown as { containerName: string }).containerName}$`], { env: w.env, encoding: 'utf8' }).trim();
    let pid = 0;
    let ended = false;
    const done = runWrapped(w, worktree, { onSpawn: (spawned) => (pid = spawned) }).finally(() => (ended = true));
    while (!existsSync(started) && !ended) await new Promise((r) => setTimeout(r, 50));
    if (ended) expect.fail(`docker run ended before its container started; its stderr: ${(await done).stderr.trim() || '(empty)'}`);
    process.kill(-pid, 'SIGKILL');
    expect((await done).signal).toBe('SIGKILL');
    // SIGKILL of the CLI does not stop the container (platform-runtime.md section 5).
    expect(running()).not.toBe('');
    w.cleanup();
    expect(running()).toBe('');
  });
});
