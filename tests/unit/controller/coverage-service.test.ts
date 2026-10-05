import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exec = vi.hoisted(() => ({ execCapture: vi.fn() }));
vi.mock('../../../src/core/exec.ts', async (orig) => ({ ...(await orig<typeof import('../../../src/core/exec.ts')>()), execCapture: exec.execCapture }));

const { installService, logPaths, renderLaunchdPlist, renderSystemdUnit, serviceLabel, serviceSpec, serviceStatus, systemctlCommands, systemdUnitPath, uninstallService, launchdPlistPath } = await import('../../../src/controller/service.ts');
type CommandRunner = import('../../../src/controller/service.ts').CommandRunner;

const dirs: string[] = [];
afterEach(() => {
  exec.execCapture.mockReset();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function home(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-svc2-')));
  dirs.push(d);
  return d;
}

const results = (...rs: { exitCode: number | null; stdout?: string; stderr?: string }[]): CommandRunner & { calls: string[][] } => {
  const calls: string[][] = [];
  const fn = (async (argv: string[]) => {
    calls.push(argv);
    const r = rs.shift() ?? { exitCode: 0 };
    return { exitCode: r.exitCode, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }) as CommandRunner & { calls: string[][] };
  fn.calls = calls;
  return fn;
};

describe('service definitions: defaults and escaping', () => {
  it('defaults the node path to this process and the PATH to the system directories, and keys the label by repository', () => {
    const s = serviceSpec({ repoRoot: '/work/acme', orbitHome: '/h/.orbit', entry: '/o/orbit.mjs' });
    expect(s.nodePath).toBe(process.execPath);
    expect(s.env.PATH).toBe('/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin');
    expect(s.label).toBe(serviceLabel('/work/acme'));
    expect(serviceLabel('/work/acme')).not.toBe(serviceLabel('/work/other'));
    expect(logPaths(s)).toEqual({ out: join('/h/.orbit', 'logs', `${s.label}.out.log`), err: join('/h/.orbit', 'logs', `${s.label}.err.log`) });
  });

  it('escapes every XML special character in the plist', () => {
    const s = serviceSpec({ repoRoot: `/work/a<b>&"c'd`, orbitHome: '/h', entry: '/o/orbit.mjs', nodePath: '/n', path: '/bin' });
    const plist = renderLaunchdPlist(s);
    expect(plist).toContain('/work/a&lt;b&gt;&amp;&quot;c&apos;d');
    expect(plist).not.toContain('a<b>');
  });

  it('quotes backslashes, quotes and percent signs for systemd and keeps the description on one line', () => {
    const s = serviceSpec({ repoRoot: '/work/a\\b"c%d\nx', orbitHome: '/h', entry: '/o/orbit.mjs', nodePath: '/n', path: '/bin' });
    const unit = renderSystemdUnit(s);
    expect(unit).toContain('"/work/a\\\\b\\"c%%d\nx"');
    expect(unit).toContain('Description=Orbit controller (/work/a\\b"c%d x)');
    expect(unit.split('\n').filter((l) => l.startsWith('Description='))).toHaveLength(1);
  });

  it('never restarts a systemd service faster than five seconds', () => {
    const fast = { ...serviceSpec({ repoRoot: '/r', orbitHome: '/h', entry: '/e' }), throttleSeconds: 2 };
    expect(renderSystemdUnit(fast)).toContain('RestartSec=5');
    const slow = { ...fast, throttleSeconds: 40 };
    expect(renderSystemdUnit(slow)).toContain('RestartSec=20');
  });

  it('knows where each manager keeps its definition', () => {
    expect(launchdPlistPath('/h', 'x.y')).toBe('/h/Library/LaunchAgents/x.y.plist');
    expect(systemdUnitPath('/h', 'x.y')).toBe('/h/.config/systemd/user/x.y.service');
    expect(systemctlCommands('x.y').isActive).toEqual(['systemctl', '--user', 'is-active', 'x.y.service']);
  });
});

describe('the default command runner', () => {
  it('runs the real command through execCapture with a bounded timeout', async () => {
    exec.execCapture.mockResolvedValue({ exitCode: 0, stdout: 'active\n', stderr: '', signal: null, timedOut: false });
    const h = home();
    const st = await serviceStatus('x.y', { platform: 'linux', homeDir: h, uid: 1 });
    expect(exec.execCapture).toHaveBeenCalledWith(['systemctl', '--user', 'is-active', 'x.y.service'], { timeoutMs: 30_000 });
    expect(st).toMatchObject({ loaded: true, detail: 'active', installed: false });
  });

  it('is also the runner install and uninstall use when none is given', async () => {
    exec.execCapture.mockResolvedValue({ exitCode: 0, stdout: 'inactive\n', stderr: '', signal: null, timedOut: false });
    const h = home();
    const spec = serviceSpec({ repoRoot: '/r', orbitHome: join(h, '.orbit'), entry: '/e', nodePath: '/n', path: '/bin' });
    const installed = await installService(spec, { platform: 'linux', homeDir: h, uid: 1 });
    expect(installed).toMatchObject({ installed: true, loaded: false });
    expect(exec.execCapture.mock.calls.map((c) => (c[0] as string[]).slice(0, 3).join(' '))).toEqual(['systemctl --user daemon-reload', 'systemctl --user enable', 'systemctl --user is-active']);
    const removed = await uninstallService(spec.label, { platform: 'linux', homeDir: h, uid: 1 });
    expect(removed.installed).toBe(false);
  });
});

describe('status interpretation', () => {
  const opts = (run: CommandRunner, platform: NodeJS.Platform = 'linux') => ({ platform, homeDir: home(), uid: 1, run });

  it.each([
    ['active', true],
    ['activating', true],
    ['reloading', true],
    ['inactive', false],
    ['failed', false],
    ['deactivating', null],
  ])('systemd answer %j means loaded=%j', async (word, loaded) => {
    const st = await serviceStatus('x.y', opts(results({ exitCode: 3, stdout: `${word}\n` })));
    expect(st.loaded).toBe(loaded);
    expect(st.detail).toBe(word);
  });

  it('with no answer the detail names the exit code or the signal', async () => {
    expect((await serviceStatus('x.y', opts(results({ exitCode: 4 })))).detail).toBe('systemctl exited 4');
    expect((await serviceStatus('x.y', opts(results({ exitCode: null })))).detail).toBe('systemctl exited by signal');
  });

  it('launchctl: 0 is loaded, 113 is not loaded, anything else (including a signal) is unknown', async () => {
    expect(await serviceStatus('x.y', opts(results({ exitCode: 0 }), 'darwin'))).toMatchObject({ loaded: true, detail: 'loaded' });
    expect(await serviceStatus('x.y', opts(results({ exitCode: 113 }), 'darwin'))).toMatchObject({ loaded: false, detail: 'not loaded' });
    expect((await serviceStatus('x.y', opts(results({ exitCode: null }), 'darwin'))).detail).toBe('launchctl print exited by signal');
  });

  it('reports an installed definition even when the manager does not know it', async () => {
    const h = home();
    const p = systemdUnitPath(h, 'x.y');
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, '[Unit]\n');
    const st = await serviceStatus('x.y', { platform: 'linux', homeDir: h, uid: 1, run: results({ exitCode: 3, stdout: 'inactive\n' }) });
    expect(st).toMatchObject({ installed: true, loaded: false, definitionPath: p });
  });
});

describe('failures and unsupported platforms', () => {
  it('a command killed by a signal is an error that says so, with the start of its stderr', async () => {
    const h = home();
    const spec = serviceSpec({ repoRoot: '/r', orbitHome: join(h, '.orbit'), entry: '/e' });
    await expect(installService(spec, { platform: 'darwin', homeDir: h, uid: 1, run: results({ exitCode: null, stderr: ' boom ' }) })).rejects.toThrow('launchctl bootout gui/1/' + spec.label + ' failed (exit signal): boom');
    await expect(installService(spec, { platform: 'linux', homeDir: h, uid: 1, run: results({ exitCode: 1, stderr: 'no bus' }) })).rejects.toThrow(/systemctl --user daemon-reload failed \(exit 1\): no bus/);
  });

  it('uninstall on Linux with no unit installed does not ask systemd to disable it, and a failed reload is an error', async () => {
    const h = home();
    const run = results({ exitCode: 0 }, { exitCode: 3, stdout: 'inactive\n' });
    const st = await uninstallService('x.y', { platform: 'linux', homeDir: h, uid: 1, run });
    expect(run.calls.map((c) => c[2])).toEqual(['daemon-reload', 'is-active']);
    expect(st.installed).toBe(false);
    await expect(uninstallService('x.y', { platform: 'linux', homeDir: h, uid: 1, run: results({ exitCode: 1, stderr: 'x' }) })).rejects.toThrow(/daemon-reload failed/);
  });

  it('uninstall on Linux disables an installed unit first and ignores a failed disable', async () => {
    const h = home();
    const p = systemdUnitPath(h, 'x.y');
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, '[Unit]\n');
    const run = results({ exitCode: 5 }, { exitCode: 0 }, { exitCode: 3, stdout: 'inactive\n' });
    await uninstallService('x.y', { platform: 'linux', homeDir: h, uid: 1, run });
    expect(run.calls.map((c) => c[2])).toEqual(['disable', 'daemon-reload', 'is-active']);
    expect(existsSync(p)).toBe(false);
  });

  it.each(['win32', 'freebsd'] as const)('uninstall and status are refused on %s as well', async (platform) => {
    const h = home();
    await expect(uninstallService('x.y', { platform, homeDir: h, uid: 0, run: results() })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(serviceStatus('x.y', { platform, homeDir: h, uid: 0, run: results() })).rejects.toThrow(new RegExp(`not ${platform}`));
  });
});
