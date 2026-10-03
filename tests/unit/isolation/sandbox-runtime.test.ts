import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isOrbitError } from '../../../src/core/errors.ts';
import { DENIED_RESOLVED_ADDRESSES, SandboxRuntimeIsolation, buildSrtSettings, normalizeHost, seccompHelperFor } from '../../../src/isolation/sandbox-runtime.ts';
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

/**
 * A Linux-shaped host built from fake tools, so these tests run the same on
 * macOS and Linux: the platform check needs bwrap, socat and rg on PATH and
 * srt's seccomp helper where srt 0.0.78 looks for it.
 */
function fakeHost(r: string, srtBody = 'exit 0', opts: { seccomp?: boolean } = {}) {
  const bin = join(r, 'bin');
  for (const tool of ['bwrap', 'socat', 'rg']) writeExecutable(join(bin, tool), 'exit 0');
  const srt = writeExecutable(join(r, 'srt-bin', 'srt'), srtBody);
  if (opts.seccomp !== false) {
    for (const arch of ['x64', 'arm64']) writeExecutable(join(r, 'srt-bin', 'vendor', 'seccomp', arch, 'apply-seccomp'), 'exit 0');
  }
  const settingsDir = join(r, 'settings');
  mkdirSync(settingsDir);
  return { bin, srt, settingsDir };
}

describe('normalizeHost', () => {
  it('accepts hosts, wildcard suffixes, ports and bracketed IPv6', () => {
    expect(normalizeHost(' Registry.NPMJS.org ')).toBe('registry.npmjs.org');
    expect(normalizeHost('*.github.com')).toBe('*.github.com');
    expect(normalizeHost('api.example.com:443')).toBe('api.example.com:443');
    expect(normalizeHost('127.0.0.1:3000')).toBe('127.0.0.1:3000');
    expect(normalizeHost('[::1]:8080')).toBe('[::1]:8080');
  });

  it('refuses URLs, bare wildcards, whitespace and bad ports as configuration errors', () => {
    for (const bad of ['https://example.com', '*', 'a b.com', 'example.com/path', 'example.com:0', 'example.com:70000', '', '-bad.com', 'a.*.com']) {
      expect(codeOf(() => normalizeHost(bad)), bad).toBe('CONFIG_INVALID');
    }
  });
});

describe('buildSrtSettings', () => {
  it('means no network and no writes for an empty profile', () => {
    expect(buildSrtSettings(profile())).toEqual({
      network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true, deniedResolvedAddresses: DENIED_RESOLVED_ADDRESSES, allowLocalBinding: false },
      filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
    });
  });

  it('translates writes, denies and hosts, re-allowing reads of writable paths inside denied regions', () => {
    const r = root();
    const home = join(r, 'home');
    const worktree = join(home, '.orbit', 'worktrees', 'h', 'run', 'w1');
    const elsewhere = join(r, 'scratch');
    mkdirSync(worktree, { recursive: true });
    const s = buildSrtSettings(
      profile({
        writablePaths: [worktree, elsewhere, worktree],
        denyReadPaths: [join(home, '.ssh'), join(home, '.orbit')],
        allowedHosts: ['Registry.npmjs.org', 'registry.npmjs.org', 'api.github.com'],
      }),
    );
    expect(s.filesystem.allowWrite).toEqual([worktree, elsewhere]);
    expect(s.filesystem.denyRead).toEqual([join(home, '.ssh'), join(home, '.orbit')]);
    // The worktree is under the denied ~/.orbit; the scratch dir is readable anyway.
    expect(s.filesystem.allowRead).toEqual([worktree]);
    expect(s.filesystem.denyWrite).toEqual([]);
    expect(s.network.allowedDomains).toEqual(['registry.npmjs.org', 'api.github.com']);
  });

  it('re-allows explicitly readable paths only where a deny covers them', () => {
    const r = root();
    const s = buildSrtSettings(
      profile({ denyReadPaths: [join(r, 'projects')], readablePaths: [join(r, 'projects', 'acme', '.git'), join(r, 'tools')] } as Partial<SandboxProfile>),
    );
    expect(s.filesystem.allowRead).toEqual([join(r, 'projects', 'acme', '.git')]);
  });

  it('keeps nested denies so a deny inside a re-allowed region stays denied, and write-denies it', () => {
    const r = root();
    const wt = join(r, 'home', '.orbit', 'wt');
    const secret = join(wt, '.secrets');
    const s = buildSrtSettings(profile({ writablePaths: [wt], denyReadPaths: [join(r, 'home', '.orbit'), secret] }));
    expect(s.filesystem.denyRead).toEqual([join(r, 'home', '.orbit'), secret]);
    expect(s.filesystem.allowRead).toEqual([wt]);
    expect(s.filesystem.denyWrite).toEqual([secret]);
  });

  it('resolves symlinks so rules match the paths the kernel sees', () => {
    const r = root();
    mkdirSync(join(r, 'real'));
    symlinkSync(join(r, 'real'), join(r, 'link'));
    const s = buildSrtSettings(profile({ writablePaths: [join(r, 'link')], denyReadPaths: [join(r, 'link', 'x')] }));
    expect(s.filesystem.allowWrite).toEqual([join(r, 'real')]);
    expect(s.filesystem.denyRead).toEqual([join(r, 'real', 'x')]);
  });

  it('write-denies read-only paths inside writable paths, keeping them readable', () => {
    const r = root();
    const cfg = join(r, 'home', '.claude-cfg');
    const worker = join(r, 'worker');
    const s = buildSrtSettings(
      profile({
        writablePaths: [cfg, worker],
        readablePaths: [join(cfg, 'settings.json'), join(cfg, 'plugins'), join(worker, 'exit.json'), join(r, 'elsewhere')],
      } as Partial<SandboxProfile>),
    );
    expect(s.filesystem.denyWrite).toEqual([join(cfg, 'settings.json'), join(cfg, 'plugins'), join(worker, 'exit.json')]);
    // Nothing here is read-denied, so nothing needs re-allowing.
    expect(s.filesystem.allowRead).toEqual([]);
    expect(s.filesystem.denyRead).toEqual([]);
  });

  it('refuses a writable path that a read-only path would silently cover', () => {
    const r = root();
    const cfg = join(r, 'cfg');
    expect(codeOf(() => buildSrtSettings(profile({ writablePaths: [cfg, join(cfg, 'plugins', 'x')], readablePaths: [join(cfg, 'plugins')] } as Partial<SandboxProfile>)))).toBe('INTERNAL');
    expect(codeOf(() => buildSrtSettings(profile({ writablePaths: [cfg], readablePaths: [cfg] } as Partial<SandboxProfile>)))).toBe('INTERNAL');
    // A read-only directory outside every writable path does not cover a writable one below it.
    expect(codeOf(() => buildSrtSettings(profile({ writablePaths: [join(cfg, 'w')], readablePaths: [cfg] } as Partial<SandboxProfile>)))).toBeUndefined();
  });

  it('fails closed on paths it cannot express and on contradictions', () => {
    expect(codeOf(() => buildSrtSettings(profile({ writablePaths: ['relative'] })))).toBe('INTERNAL');
    expect(codeOf(() => buildSrtSettings(profile({ denyReadPaths: ['/home/*/secret'] })))).toBe('ISOLATION_UNAVAILABLE');
    expect(codeOf(() => buildSrtSettings(profile({ writablePaths: ['/srv/a[1]'] })))).toBe('ISOLATION_UNAVAILABLE');
    expect(codeOf(() => buildSrtSettings(profile({ writablePaths: ['/srv/same'], denyReadPaths: ['/srv/same'] })))).toBe('INTERNAL');
    expect(codeOf(() => buildSrtSettings(profile({ allowedHosts: ['http://evil.example'] })))).toBe('CONFIG_INVALID');
  });
});

describe('SandboxRuntimeIsolation.resolveSrt', () => {
  it('uses a configured path and never falls back when it is missing', () => {
    const r = root();
    const { bin, srt } = fakeHost(r);
    writeExecutable(join(bin, 'srt'), 'exit 0');
    expect(new SandboxRuntimeIsolation({ srtPath: srt, pathEnv: bin }).resolveSrt()).toEqual({ path: srt, source: 'configured' });
    expect(new SandboxRuntimeIsolation({ srtPath: join(r, 'nope'), pathEnv: bin }).resolveSrt()).toBeNull();
  });

  it('prefers PATH, then the install directory', () => {
    const r = root();
    const install = join(r, 'orbit');
    const bundled = writeExecutable(join(install, 'node_modules', '.bin', 'srt'), 'exit 0');
    const pathBin = join(r, 'pathbin');
    mkdirSync(pathBin);
    expect(new SandboxRuntimeIsolation({ orbitInstallDir: install, pathEnv: pathBin }).resolveSrt()).toEqual({ path: bundled, source: 'install' });
    const onPath = writeExecutable(join(pathBin, 'srt'), 'exit 0');
    expect(new SandboxRuntimeIsolation({ orbitInstallDir: install, pathEnv: pathBin }).resolveSrt()).toEqual({ path: onPath, source: 'PATH' });
    expect(new SandboxRuntimeIsolation({ pathEnv: join(r, 'empty') }).resolveSrt()).toBeNull();
  });
});

describe('SandboxRuntimeIsolation.wrap', () => {
  it('writes a private settings file and returns argv form with an end-of-options marker', () => {
    const r = root();
    const { bin, srt, settingsDir } = fakeHost(r);
    const iso = new SandboxRuntimeIsolation({ srtPath: srt, pathEnv: bin, platform: 'linux', settingsDir });
    const wt = join(r, 'wt');
    mkdirSync(wt);
    const p = profile({ writablePaths: [wt], denyReadPaths: [join(r, 'home', '.ssh')] });
    const w = iso.wrap(['sh', '-c', 'exit 7'], p, { cwd: wt, env: { PATH: '/usr/bin', FOO: 'bar' } });

    expect(w.argv.slice(0, 2)).toEqual([srt, '--settings']);
    expect(w.argv.slice(3)).toEqual(['--', 'sh', '-c', 'exit 7']);
    const file = w.argv[2]!;
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(file, '..')).mode & 0o777).toBe(0o700);
    const written = JSON.parse(readFileSync(file, 'utf8'));
    const expected = buildSrtSettings(p);
    expect(written.network).toEqual(expected.network);
    expect(written.filesystem.allowWrite).toEqual([wt]);
    // Its own settings directory is unreadable from inside.
    expect(written.filesystem.denyRead).toEqual([join(r, 'home', '.ssh'), join(file, '..')]);
    expect(w.env).toEqual({ PATH: '/usr/bin', FOO: 'bar' });

    w.cleanup();
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(settingsDir)).toEqual([]);
    expect(() => w.cleanup()).not.toThrow();
  });

  it('carries a private TMPDIR through srt only when the sandbox can write it', () => {
    const r = root();
    const { bin, srt, settingsDir } = fakeHost(r);
    const iso = new SandboxRuntimeIsolation({ srtPath: srt, pathEnv: bin, platform: 'linux', settingsDir });
    const wt = join(r, 'wt');
    const tmp = join(r, 'worker', 'tmp');
    mkdirSync(wt);
    mkdirSync(tmp, { recursive: true });
    const inside = iso.wrap(['true'], profile({ writablePaths: [wt, join(r, 'worker')] }), { cwd: wt, env: { TMPDIR: tmp } });
    // The child gets the private dir through CLAUDE_CODE_TMPDIR; srt's own TMPDIR (its proxy sockets) stays outside the sandbox's reach.
    expect(inside.env).toEqual({ TMPDIR: tmpdir(), CLAUDE_CODE_TMPDIR: tmp });
    const outside = iso.wrap(['true'], profile({ writablePaths: [wt] }), { cwd: wt, env: { TMPDIR: tmp } });
    expect(outside.env).toEqual({ TMPDIR: tmp });
    const explicit = iso.wrap(['true'], profile({ writablePaths: [tmp] }), { cwd: wt, env: { TMPDIR: tmp, CLAUDE_CODE_TMPDIR: '/elsewhere' } });
    expect(explicit.env.CLAUDE_CODE_TMPDIR).toBe('/elsewhere');
    for (const w of [inside, outside, explicit]) w.cleanup();
  });

  it('states what srt does not enforce, including requested resource limits', () => {
    const r = root();
    const { bin, srt, settingsDir } = fakeHost(r);
    const iso = new SandboxRuntimeIsolation({ srtPath: srt, pathEnv: bin, platform: 'linux', settingsDir });
    const w = iso.wrap(['true'], profile({ limits: { timeoutMs: 1000, memoryMb: 512, cpus: 1, pids: 64 } }), { cwd: r, env: {} });
    const text = w.limitations.join('\n');
    expect(text).toMatch(/no CPU, memory or process-count limits/);
    expect(text).toMatch(/wall-clock limit is not enforced by the sandbox; the caller enforces it by killing the wrapped command's process group/);
    expect(text).toMatch(/SIGTERM or SIGINT, srt exits 0/);
    expect(text).toMatch(/memory 512 MB, 1 CPUs, 64 processes\) are NOT enforced/);
    expect(text).toMatch(/On Linux the mandatory write denies/);
    w.cleanup();
  });

  it('fails closed with ISOLATION_UNAVAILABLE and leaves nothing behind when srt is missing', () => {
    const r = root();
    const { bin, settingsDir } = fakeHost(r);
    const iso = new SandboxRuntimeIsolation({ pathEnv: bin, platform: 'linux', settingsDir });
    expect(codeOf(() => iso.wrap(['true'], profile(), { cwd: r, env: {} }))).toBe('ISOLATION_UNAVAILABLE');
    const configuredMissing = new SandboxRuntimeIsolation({ srtPath: join(r, 'gone', 'srt'), pathEnv: bin, platform: 'linux', settingsDir });
    expect(() => configuredMissing.wrap(['true'], profile(), { cwd: r, env: {} })).toThrow(/configured srt .* is not an absolute path to an executable file/);
    expect(readdirSync(settingsDir)).toEqual([]);
  });

  it('fails closed when the platform prerequisites are missing', () => {
    const r = root();
    const { srt, settingsDir } = fakeHost(r);
    const noTools = join(r, 'empty-bin');
    mkdirSync(noTools);
    const linux = new SandboxRuntimeIsolation({ srtPath: srt, pathEnv: noTools, platform: 'linux', settingsDir });
    expect(() => linux.wrap(['true'], profile(), { cwd: r, env: {} })).toThrow(/bwrap, socat, rg/);
    const windows = new SandboxRuntimeIsolation({ srtPath: srt, platform: 'win32', settingsDir });
    expect(codeOf(() => windows.wrap(['true'], profile(), { cwd: r, env: {} }))).toBe('ISOLATION_UNAVAILABLE');
  });

  it('removes the settings directory when the profile is rejected', () => {
    const r = root();
    const { bin, srt, settingsDir } = fakeHost(r);
    const iso = new SandboxRuntimeIsolation({ srtPath: srt, pathEnv: bin, platform: 'linux', settingsDir });
    expect(codeOf(() => iso.wrap(['true'], profile({ allowedHosts: ['not a host'] }), { cwd: r, env: {} }))).toBe('CONFIG_INVALID');
    expect(codeOf(() => iso.wrap([], profile(), { cwd: r, env: {} }))).toBe('INTERNAL');
    expect(readdirSync(settingsDir)).toEqual([]);
  });
});

describe('SandboxRuntimeIsolation.wrap launcher environment', () => {
  function setup() {
    const r = root();
    const host = fakeHost(r);
    const iso = new SandboxRuntimeIsolation({ srtPath: host.srt, pathEnv: host.bin, platform: 'linux', settingsDir: host.settingsDir });
    const wt = join(r, 'wt');
    const wtBin = join(wt, 'node_modules', '.bin');
    mkdirSync(wtBin, { recursive: true });
    const denied = join(r, 'home', '.orbit', 'other-worktree', 'bin');
    const p = profile({ writablePaths: [wt], denyReadPaths: [join(r, 'home', '.orbit')] });
    return { r, iso, wt, wtBin, denied, p };
  }

  it('keeps the launcher off PATH entries the sandbox can write, and restores them for the command inside', () => {
    const { iso, wt, wtBin, denied, p } = setup();
    // A sandboxed command could plant `env`, `which` or `node` in any of these
    // for the next launch to run unconfined (reproduced against real srt).
    const PATH = ['/usr/bin', wtBin, '', '.', 'relative/bin', denied, '/tmp/claude/bin', '/bin'].join(':');
    const w = iso.wrap(['npm', 'test'], p, { cwd: wt, env: { PATH, HOME: '/home/acme' } });
    expect(w.env.PATH).toBe('/usr/bin:/bin');
    expect(w.argv.slice(3)).toEqual(['--', '/usr/bin/env', '--', `PATH=${PATH}`, 'npm', 'test']);
    w.cleanup();
  });

  it('drops loader variables from the launcher and restores them inside', () => {
    const { iso, wt, p } = setup();
    const env = {
      PATH: '/usr/bin:/bin',
      NODE_OPTIONS: '--require ./test/setup.cjs',
      LD_PRELOAD: '/x.so',
      DYLD_INSERT_LIBRARIES: '/x.dylib',
      BASH_ENV: '/x.sh',
      'BASH_FUNC_env%%': '() { :; }',
      SHELLOPTS: 'xtrace',
      PS4: '$(id)',
      CI: '1',
    };
    const w = iso.wrap(['node', 'test.js'], p, { cwd: wt, env });
    expect(w.env).toEqual({ PATH: '/usr/bin:/bin', CI: '1' });
    const restored = w.argv.slice(w.argv.indexOf('/usr/bin/env') + 2, -2);
    expect(restored.sort()).toEqual(
      ['NODE_OPTIONS=--require ./test/setup.cjs', 'LD_PRELOAD=/x.so', 'DYLD_INSERT_LIBRARIES=/x.dylib', 'BASH_ENV=/x.sh', 'BASH_FUNC_env%%=() { :; }', 'SHELLOPTS=xtrace', 'PS4=$(id)'].sort(),
    );
    expect(w.argv.slice(-2)).toEqual(['node', 'test.js']);
    w.cleanup();
  });

  it('leaves argv and env alone when the environment is already safe', () => {
    const { iso, wt, p } = setup();
    const w = iso.wrap(['npm', 'test'], p, { cwd: wt, env: { PATH: '/usr/bin:/bin', HOME: '/home/acme' } });
    expect(w.argv.slice(3)).toEqual(['--', 'npm', 'test']);
    expect(w.env).toEqual({ PATH: '/usr/bin:/bin', HOME: '/home/acme' });
    w.cleanup();
  });

  it('refuses a command name /usr/bin/env would read as an assignment, leaving nothing behind', () => {
    const { iso, wt, wtBin, p, r } = setup();
    expect(codeOf(() => iso.wrap(['A=B', 'x'], p, { cwd: wt, env: { PATH: `${wtBin}:/usr/bin` } }))).toBe('INTERNAL');
    expect(readdirSync(join(r, 'settings'))).toEqual([]);
  });

  it('refuses an srt the sandbox could rewrite, unless that path is read-only', () => {
    const r = root();
    const host = fakeHost(r);
    // srt bundled under a directory the sandbox may write, like a provider config dir holding Orbit as a plugin.
    const cfg = join(r, 'cfg');
    const srtDist = join(cfg, 'plugins', 'orbit', 'node_modules', 'srt', 'dist');
    const srt = writeExecutable(join(srtDist, 'cli.js'), 'exit 0');
    for (const arch of ['x64', 'arm64']) writeExecutable(join(srtDist, '..', 'vendor', 'seccomp', arch, 'apply-seccomp'), 'exit 0');
    const iso = new SandboxRuntimeIsolation({ srtPath: srt, pathEnv: host.bin, platform: 'linux', settingsDir: host.settingsDir });
    let caught: unknown;
    try {
      iso.wrap(['true'], profile({ writablePaths: [cfg] }), { cwd: cfg, env: {} });
    } catch (err) {
      caught = err;
    }
    expect(isOrbitError(caught, 'ISOLATION_UNAVAILABLE')).toBe(true);
    expect((caught as Error).message).toMatch(/could replace the sandbox itself/);
    expect(readdirSync(host.settingsDir)).toEqual([]);
    // A writable directory inside srt's package is as bad.
    expect(codeOf(() => iso.wrap(['true'], profile({ writablePaths: [join(srtDist, 'tmp')] }), { cwd: r, env: {} }))).toBe('ISOLATION_UNAVAILABLE');
    const w = iso.wrap(['true'], profile({ writablePaths: [cfg], readablePaths: [join(cfg, 'plugins')] } as Partial<SandboxProfile>), { cwd: cfg, env: {} });
    expect(w.argv[0]).toBe(srt);
    w.cleanup();
  });
});

describe('SandboxRuntimeIsolation on Linux without seccomp', () => {
  it('fails closed, because srt would leave every Unix socket reachable', async () => {
    const r = root();
    const host = fakeHost(r, 'if [ "$1" = "--version" ]; then echo 0.0.78; fi; exit 0', { seccomp: false });
    const iso = new SandboxRuntimeIsolation({ srtPath: host.srt, pathEnv: host.bin, platform: 'linux', settingsDir: host.settingsDir });
    expect(codeOf(() => iso.wrap(['true'], profile(), { cwd: r, env: {} }))).toBe('ISOLATION_UNAVAILABLE');
    const status = await iso.available();
    expect(status.ok).toBe(false);
    expect(status.detail).toMatch(/no apply-seccomp helper .* could not block Unix sockets/);
    expect(readdirSync(host.settingsDir)).toEqual([]);
  });

  it('fails closed on an architecture srt ships no helper for', () => {
    const r = root();
    const host = fakeHost(r);
    const iso = new SandboxRuntimeIsolation({ srtPath: host.srt, pathEnv: host.bin, platform: 'linux', settingsDir: host.settingsDir, arch: 'ia32' });
    expect(codeOf(() => iso.wrap(['true'], profile(), { cwd: r, env: {} }))).toBe('ISOLATION_UNAVAILABLE');
    expect(seccompHelperFor(host.srt, 'x64')).toBe(join(r, 'srt-bin', 'vendor', 'seccomp', 'x64', 'apply-seccomp'));
    expect(seccompHelperFor(host.srt, 'ia32')).toBeNull();
  });

  it('does not need the helper on macOS', () => {
    const r = root();
    const host = fakeHost(r, 'exit 0', { seccomp: false });
    const iso = new SandboxRuntimeIsolation({ srtPath: host.srt, platform: 'darwin', settingsDir: host.settingsDir });
    expect(iso.platformCheck(host.srt).ok).toBe(existsSync('/usr/bin/sandbox-exec'));
  });
});

describe('SandboxRuntimeIsolation.resolveSrt with relative paths', () => {
  it('never resolves srt relative to the working directory', () => {
    const r = root();
    const host = fakeHost(r);
    expect(new SandboxRuntimeIsolation({ srtPath: 'srt-bin/srt', pathEnv: host.bin }).resolveSrt()).toBeNull();
    // An empty entry and "." both mean the current directory, which is usually a repository.
    expect(new SandboxRuntimeIsolation({ pathEnv: ':.:srt-bin' }).resolveSrt()).toBeNull();
    expect(new SandboxRuntimeIsolation({ orbitInstallDir: 'relative/orbit', pathEnv: '' }).resolveSrt()).toBeNull();
  });
});

describe('SandboxRuntimeIsolation.available', () => {
  // Confines the probe the way a sandbox would: the directory of the last
  // argument (the canary) is made read-only before the command runs.
  const FAKE_SRT = [
    'if [ "$1" = "--version" ]; then echo 0.0.78; exit 0; fi',
    'if [ "$1" = "--settings" ] && [ -s "$2" ] && [ "$3" = "--" ]; then shift 3; for a; do last="$a"; done; chmod 500 "$(dirname "$last")"; exec "$@"; fi',
    'echo "unexpected args: $*" >&2; exit 9',
  ].join('\n');

  it('passes when srt runs and a sandboxed command starts', async () => {
    const r = root();
    const { bin, srt, settingsDir } = fakeHost(r, FAKE_SRT);
    const status = await new SandboxRuntimeIsolation({ srtPath: srt, pathEnv: bin, platform: 'linux', settingsDir }).available();
    expect(status.ok).toBe(true);
    expect(status.detail).toMatch(/srt 0\.0\.78 \(configured: .*\); Linux bubblewrap with seccomp Unix-socket blocking; sandbox probe passed/);
    expect(readdirSync(settingsDir)).toEqual([]);
  });

  it('fails when srt runs commands without confining them', async () => {
    const r = root();
    const passthrough = ['if [ "$1" = "--version" ]; then echo 0.0.78; exit 0; fi', 'shift 3; exec "$@"'].join('\n');
    const { bin, srt, settingsDir } = fakeHost(r, passthrough);
    const status = await new SandboxRuntimeIsolation({ srtPath: srt, pathEnv: bin, platform: 'linux', settingsDir }).available();
    expect(status.ok).toBe(false);
    expect(status.detail).toMatch(/ran a command without confining it/);
    expect(readdirSync(settingsDir)).toEqual([]);
  });

  it('fails when the sandbox cannot start, naming the reason', async () => {
    const r = root();
    const body = 'if [ "$1" = "--version" ]; then echo 0.0.78; exit 0; fi\necho "sandbox_apply: Operation not permitted" >&2; exit 1';
    const { bin, srt, settingsDir } = fakeHost(r, body);
    const status = await new SandboxRuntimeIsolation({ srtPath: srt, pathEnv: bin, platform: 'linux', settingsDir }).available();
    expect(status).toEqual({ ok: false, detail: 'srt 0.0.78 could not start a sandboxed command (exit 1: sandbox_apply: Operation not permitted)' });
  });

  it('fails within the probe deadline when srt hangs', async () => {
    const r = root();
    const { bin, srt, settingsDir } = fakeHost(r, 'sleep 30');
    const started = Date.now();
    const status = await new SandboxRuntimeIsolation({ srtPath: srt, pathEnv: bin, platform: 'linux', settingsDir, probeTimeoutMs: 300 }).available();
    expect(status.ok).toBe(false);
    expect(status.detail).toMatch(/does not run \(timed out\)/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('reports a missing binary and an unsupported platform without running anything', async () => {
    const r = root();
    const { bin } = fakeHost(r);
    expect(await new SandboxRuntimeIsolation({ pathEnv: bin, platform: 'linux' }).available()).toEqual({
      ok: false,
      detail: 'srt not found on PATH; install @anthropic-ai/sandbox-runtime',
    });
    expect((await new SandboxRuntimeIsolation({ platform: 'freebsd' }).available()).detail).toMatch(/not supported by Orbit on freebsd/);
  });
});
