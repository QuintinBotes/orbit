/**
 * The service definition must survive a plugin update. The plugin's bundle lives under a versioned path that changes
 * on every update, so the launchd plist and the systemd unit point at a stable launcher under the Orbit home, and the
 * launcher (not the definition) records the current bundle and node.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installService, launcherPath, launchdPlistPath, readLauncher, refreshLauncher, renderLaunchdPlist, renderSystemdUnit, serviceSpec, systemdUnitPath, writeLauncher, type CommandRunner } from '../../../src/controller/service.ts';
import { profileForWorker } from '../../../src/isolation/profiles.ts';
import { snapshotFor } from '../isolation/fixtures.ts';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function home(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-launcher-')));
  dirs.push(d);
  return d;
}

const ok: CommandRunner = async (argv) => ({ exitCode: 0, stdout: argv.includes('is-active') ? 'active\n' : '', stderr: '' });

/** A stand-in bundle that says which install it is. */
function bundle(root: string, name: string): string {
  const dir = join(root, 'plugins', name, 'dist');
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, 'orbit.mjs');
  writeFileSync(entry, `console.log('bundle ${name}:' + process.argv.slice(2).join(' '));\n`);
  return entry;
}

function specFor(h: string, entry: string) {
  return serviceSpec({ repoRoot: join(h, 'repo'), orbitHome: join(h, '.orbit'), entry, nodePath: process.execPath, path: '/usr/bin:/bin' });
}

/** What launchd does at login or on a restart: run the first program argument of the plist, then the rest. */
function plistProgram(plist: string): string[] {
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)![1]!;
  return [...block.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]!.replace(/&amp;/g, '&'));
}

describe('a stable launcher under the Orbit home', () => {
  it('points the plist and the systemd unit at the launcher, never at the versioned bundle path', () => {
    const h = home();
    const entry = bundle(h, '0.1.0');
    const s = specFor(h, entry);
    expect(s.launcher).toBe(join(h, '.orbit', 'bin', 'orbit'));
    const plist = renderLaunchdPlist(s);
    expect(plistProgram(plist)).toEqual([s.launcher, 'service', 'run', '--repo', join(h, 'repo')]);
    expect(plist).not.toContain(entry);
    const unit = renderSystemdUnit(s);
    expect(unit).toContain(`ExecStart="${s.launcher}" "service" "run"`);
    expect(unit).not.toContain(entry);
  });

  it('writes the launcher on install: atomically, owned by the user, private, and holding the bundle and node', async () => {
    const h = home();
    const entry = bundle(h, '0.1.0');
    const s = specFor(h, entry);
    await installService(s, { platform: 'darwin', homeDir: h, uid: 501, run: ok });
    const st = lstatSync(s.launcher);
    expect(st.isFile()).toBe(true);
    expect(st.mode & 0o777).toBe(0o700);
    expect(st.uid).toBe(process.getuid!());
    const dir = lstatSync(join(h, '.orbit', 'bin'));
    expect(dir.mode & 0o077).toBe(0);
    expect(dir.uid).toBe(process.getuid!());
    // The write is a rename of a temporary file: none is left behind.
    expect(readdirSync(join(h, '.orbit', 'bin'))).toEqual(['orbit']);
    expect(readLauncher(s.launcher)).toEqual({ node: process.execPath, entry });
  });

  it('tightens a launcher directory that is group or world writable, and replaces a symlink instead of writing through it', async () => {
    const h = home();
    const s = specFor(h, bundle(h, '0.1.0'));
    mkdirSync(join(h, '.orbit', 'bin'), { recursive: true });
    chmodSync(join(h, '.orbit', 'bin'), 0o777);
    const victim = join(h, 'victim');
    writeFileSync(victim, 'keep');
    symlinkSync(victim, s.launcher);
    await installService(s, { platform: 'linux', homeDir: h, uid: 1000, run: ok });
    expect(lstatSync(join(h, '.orbit', 'bin')).mode & 0o022).toBe(0);
    expect(lstatSync(s.launcher).isSymbolicLink()).toBe(false);
    expect(readFileSync(victim, 'utf8')).toBe('keep');
  });

  it('refuses a launcher directory that is itself a symbolic link', async () => {
    const h = home();
    const s = specFor(h, bundle(h, '0.1.0'));
    mkdirSync(join(h, '.orbit'), { recursive: true });
    mkdirSync(join(h, 'elsewhere'));
    symlinkSync(join(h, 'elsewhere'), join(h, '.orbit', 'bin'));
    await expect(installService(s, { platform: 'linux', homeDir: h, uid: 1000, run: ok })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    expect(existsSync(join(h, 'elsewhere', 'orbit'))).toBe(false);
  });

  it('survives a plugin update: install from path A, run from path B, and the unchanged service definition starts B', async () => {
    const h = home();
    const a = bundle(h, '0.1.0');
    const b = bundle(h, '0.2.0');
    const s = specFor(h, a);
    await installService(s, { platform: 'darwin', homeDir: h, uid: 501, run: ok });
    const plistPath = launchdPlistPath(h, s.label);
    const before = readFileSync(plistPath, 'utf8');
    const [program, ...args] = plistProgram(before);
    expect(execFileSync(program!, args, { encoding: 'utf8' })).toContain('bundle 0.1.0:service run');

    // The update: the CLI runs from the new bundle (any command does), and the old versioned directory goes away.
    expect(refreshLauncher({ orbitHome: join(h, '.orbit'), entry: b, nodePath: process.execPath })).toBe('updated');
    rmSync(join(h, 'plugins', '0.1.0'), { recursive: true });

    expect(readFileSync(plistPath, 'utf8')).toBe(before);
    const started = execFileSync(program!, args, { encoding: 'utf8' });
    expect(started).toContain('bundle 0.2.0:service run --repo');
    expect(started).not.toContain('0.1.0');
  });

  it('survives an update under systemd the same way', async () => {
    const h = home();
    const a = bundle(h, '0.1.0');
    const b = bundle(h, '0.2.0');
    const s = specFor(h, a);
    await installService(s, { platform: 'linux', homeDir: h, uid: 1000, run: ok });
    const unitPath = systemdUnitPath(h, s.label);
    const before = readFileSync(unitPath, 'utf8');
    refreshLauncher({ orbitHome: join(h, '.orbit'), entry: b, nodePath: process.execPath });
    expect(readFileSync(unitPath, 'utf8')).toBe(before);
    expect(execFileSync(s.launcher, ['service', 'run'], { encoding: 'utf8' })).toContain('bundle 0.2.0:service run');
  });

  it('passes arguments through verbatim, including spaces and quotes, and quotes odd paths', async () => {
    const h = home();
    const odd = join(h, "it's here", 'dist');
    mkdirSync(odd, { recursive: true });
    const entry = join(odd, 'orbit.mjs');
    writeFileSync(entry, "console.log(JSON.stringify(process.argv.slice(2)));\n");
    const s = specFor(h, entry);
    await installService(s, { platform: 'linux', homeDir: h, uid: 1000, run: ok });
    expect(JSON.parse(execFileSync(s.launcher, ['a b', "c'd", '$HOME'], { encoding: 'utf8' }))).toEqual(['a b', "c'd", '$HOME']);
  });

  it('refresh does nothing when the launcher is current or when no service was ever installed', () => {
    const h = home();
    const a = bundle(h, '0.1.0');
    const orbitHome = join(h, '.orbit');
    expect(refreshLauncher({ orbitHome, entry: a, nodePath: process.execPath })).toBe('absent');
    expect(existsSync(join(orbitHome, 'bin'))).toBe(false);
  });

  it('refresh leaves alone a launcher it did not write, and never repoints it at a TypeScript source entry', async () => {
    const h = home();
    const a = bundle(h, '0.1.0');
    const orbitHome = join(h, '.orbit');
    await installService(specFor(h, a), { platform: 'linux', homeDir: h, uid: 1000, run: ok });
    const ts = join(h, 'src', 'main.ts');
    mkdirSync(join(h, 'src'));
    writeFileSync(ts, '');
    expect(refreshLauncher({ orbitHome, entry: ts, nodePath: process.execPath })).toBe('skipped');
    expect(readLauncher(launcherPath(orbitHome))!.entry).toBe(a);
    const mine = launcherPath(orbitHome);
    writeFileSync(mine, '#!/bin/sh\necho hand written\n', { mode: 0o700 });
    expect(refreshLauncher({ orbitHome, entry: bundle(h, '0.2.0'), nodePath: process.execPath })).toBe('foreign');
    expect(readFileSync(mine, 'utf8')).toContain('hand written');
  });

  it('refresh repoints the node as well as the bundle, and is a no-op the second time', async () => {
    const h = home();
    const a = bundle(h, '0.1.0');
    const orbitHome = join(h, '.orbit');
    await installService(specFor(h, a), { platform: 'linux', homeDir: h, uid: 1000, run: ok });
    const node2 = join(h, 'node22', 'bin', 'node');
    mkdirSync(join(h, 'node22', 'bin'), { recursive: true });
    writeFileSync(node2, '');
    expect(refreshLauncher({ orbitHome, entry: a, nodePath: node2 })).toBe('updated');
    expect(readLauncher(launcherPath(orbitHome))).toEqual({ node: node2, entry: a });
    expect(refreshLauncher({ orbitHome, entry: a, nodePath: node2 })).toBe('current');
  });
});

describe('issue #154: launcher ownership and recovery', () => {
  function cachedBundle(cache: string, version: string): string {
    const entry = join(cache, version, 'dist', 'orbit.mjs');
    mkdirSync(join(entry, '..'), { recursive: true });
    writeFileSync(entry, `console.log(JSON.stringify({ version: ${JSON.stringify(version)}, args: process.argv.slice(2) }));\n`);
    return entry;
  }

  it.each([undefined, '0', 'true'])('refuses a newer development bundle outside a plugin cache (override: %s)', (override) => {
    vi.stubEnv('ORBIT_LAUNCHER_REPOINT', override);
    const h = home();
    const orbitHome = join(h, '.orbit');
    const installed = cachedBundle(join(h, 'plugins', 'cache', 'marketplace', 'orbit'), '0.3.1');
    const development = bundle(join(h, '.claude', 'worktrees', 'development'), 'plugin');
    const launcher = writeLauncher(orbitHome, { node: process.execPath, entry: installed, version: '0.3.1' });
    const before = readFileSync(launcher, 'utf8');
    expect(refreshLauncher({ orbitHome, entry: development, nodePath: process.execPath, version: '0.3.2' })).toBe('other-install');
    expect(readFileSync(launcher, 'utf8')).toBe(before);
  });

  it.each(['0.3.0', '0.3.2'])('allows a development bundle at %s with ORBIT_LAUNCHER_REPOINT=1', (version) => {
    vi.stubEnv('ORBIT_LAUNCHER_REPOINT', '1');
    const h = home();
    const orbitHome = join(h, '.orbit');
    const installed = cachedBundle(join(h, 'plugins', 'cache', 'marketplace', 'orbit'), '0.3.1');
    const development = bundle(join(h, '.claude', 'worktrees', 'development'), 'plugin');
    writeLauncher(orbitHome, { node: process.execPath, entry: installed, version: '0.3.1' });
    expect(refreshLauncher({ orbitHome, entry: development, nodePath: process.execPath, version })).toBe('updated');
    expect(readLauncher(launcherPath(orbitHome))).toMatchObject({ entry: development, version });
  });

  it('lets an installed bundle replace a missing entry that claimed a newer version', () => {
    vi.stubEnv('ORBIT_LAUNCHER_REPOINT', undefined);
    const h = home();
    const orbitHome = join(h, '.orbit');
    const installed = cachedBundle(join(h, 'plugins', 'cache', 'marketplace', 'orbit'), '0.3.1');
    const missing = join(h, '.claude', 'worktrees', 'deleted', 'plugin', 'dist', 'orbit.mjs');
    writeLauncher(orbitHome, { node: process.execPath, entry: missing, version: '9.9.9' });
    expect(refreshLauncher({ orbitHome, entry: installed, nodePath: process.execPath, version: '0.3.1' })).toBe('updated');
    expect(readLauncher(launcherPath(orbitHome))).toMatchObject({ entry: installed, version: '0.3.1' });
  });

  it('refreshes an old installed launcher to record its cache even when the target is unchanged', () => {
    const h = home();
    const orbitHome = join(h, '.orbit');
    const cache = join(h, 'plugins', 'cache', 'marketplace', 'orbit');
    const entry = cachedBundle(cache, '0.3.1');
    const launcher = writeLauncher(orbitHome, { node: process.execPath, entry, version: '0.3.1' });
    writeFileSync(launcher, `#!/bin/sh\n# orbit-launcher v1\n# node: ${process.execPath}\n# entry: ${entry}\n# version: 0.3.1\n`);
    expect(refreshLauncher({ orbitHome, entry, nodePath: process.execPath, version: '0.3.1' })).toBe('updated');
    expect(readLauncher(launcher)).toMatchObject({ cacheDir: cache });
    expect(refreshLauncher({ orbitHome, entry, nodePath: process.execPath, version: '0.3.1' })).toBe('current');
  });

  it.each([
    ['0.9.99', '0.10.1', '0.10.11'],
    ['1.2.99', '1.9.99', '1.10.0'],
    ['0.99.99', '1.99.99', '2.0.0'],
  ])('sh falls back to the newest cached version among %s, %s, %s', (a, b, newest) => {
    const h = home();
    const cache = join(h, "it's here", 'plugins', 'cache', 'market place', 'orbit');
    const entry = cachedBundle(cache, '0.3.1');
    for (const version of [newest, a, b]) cachedBundle(cache, version);
    mkdirSync(join(cache, '99.0.0', 'dist'), { recursive: true });
    cachedBundle(join(h, 'plugins', 'cache', 'other', 'orbit'), '100.0.0');
    const launcher = writeLauncher(join(h, '.orbit'), { node: process.execPath, entry, version: '0.3.1' });
    rmSync(entry);
    const args = ['a b', "c'd", '$HOME'];
    const result = spawnSync('sh', [launcher, ...args], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ version: newest, args });
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    expect(result.stderr).toContain(join(cache, newest, 'dist', 'orbit.mjs'));
    expect(readLauncher(launcher)).toMatchObject({ cacheDir: cache });
  });

  it('sh uses a present entry even when a newer cached version exists', () => {
    const h = home();
    const cache = join(h, 'plugins', 'cache', 'marketplace', 'orbit');
    const entry = cachedBundle(cache, '0.3.1');
    cachedBundle(cache, '0.3.2');
    const launcher = writeLauncher(join(h, '.orbit'), { node: process.execPath, entry });
    const result = spawnSync('sh', [launcher], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ version: '0.3.1', args: [] });
    expect(result.stderr).toBe('');
  });

  it.each([true, false])('sh exits with the missing entry and fix when no fallback exists (cached: %s)', (cached) => {
    const h = home();
    const entry = cached
      ? cachedBundle(join(h, 'plugins', 'cache', 'marketplace', 'orbit'), '0.3.1')
      : bundle(h, 'development');
    const launcher = writeLauncher(join(h, '.orbit'), { node: process.execPath, entry });
    rmSync(entry);
    const result = spawnSync('sh', [launcher], { encoding: 'utf8' });
    expect(result.status).not.toBeNull();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(entry);
    expect(result.stderr).toContain("run the installed plugin's bin/orbit, or orbit service install");
  });

  it('reads an old launcher without a cache directory header', () => {
    const h = home();
    const launcher = join(h, 'old-launcher');
    writeFileSync(launcher, '#!/bin/sh\n# orbit-launcher v1\n# node: /usr/bin/node\n# entry: /old/dist/orbit.mjs\n# version: 0.3.1\nexec /usr/bin/node /old/dist/orbit.mjs "$@"\n');
    expect(readLauncher(launcher)).toEqual({ node: '/usr/bin/node', entry: '/old/dist/orbit.mjs', version: '0.3.1' });
  });
});

describe('sandbox reach of the launcher (profiles.ts)', () => {
  it('is outside every writable path of a worker profile and inside its read-deny list, in the default layout', () => {
    const h = home();
    const repo = join(h, 'projects', 'acme');
    const gitdir = join(repo, '.git', 'worktrees', 'w1');
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(gitdir, 'commondir'), '../..\n');
    const worktree = join(h, '.orbit', 'worktrees', 'k', 'orb-1', 'w1');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, '.git'), `gitdir: ${gitdir}\n`);
    const workerDir = join(repo, '.orbit', 'runs', 'orb-1', 'workers', 'w1');
    mkdirSync(workerDir, { recursive: true });
    for (const provider of ['claude', 'codex'] as const) {
      const p = profileForWorker({ worktree, workerDir, snapshot: snapshotFor({ repoRoot: repo }), provider, claudeConfigDir: join(h, '.claude-alt'), homeDir: h, codexHome: join(h, '.codex'), env: {} });
      const launcher = launcherPath(join(h, '.orbit'));
      expect(p.writablePaths.filter((w) => launcher === w || launcher.startsWith(`${w}/`))).toEqual([]);
      expect(p.denyReadPaths).toContain(join(h, '.orbit'));
    }
  });
});
