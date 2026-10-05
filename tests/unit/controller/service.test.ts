import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installService,
  launchctlCommands,
  launchdPlistPath,
  renderLaunchdPlist,
  renderSystemdUnit,
  serviceSpec,
  serviceStatus,
  systemdUnitPath,
  uninstallService,
  pruneDeadControllers,
  type CommandRunner,
} from '../../../src/controller/service.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function home(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-svc-')));
  dirs.push(d);
  return d;
}

/** Records every command and answers from a table; nothing reaches the real launchctl or systemctl. */
function runner(answers: Record<string, number[]> = {}): CommandRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = (async (argv: string[]) => {
    calls.push(argv);
    const key = argv.slice(0, 3).join(' ');
    const queue = answers[key] ?? answers[argv[1] ?? ''] ?? [];
    const code = queue.length > 0 ? queue.shift()! : 0;
    return { exitCode: code, stdout: argv[0] === 'systemctl' && argv.includes('is-active') ? 'active\n' : '', stderr: code === 0 ? '' : 'failed' };
  }) as CommandRunner & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

function spec(h: string) {
  return serviceSpec({ repoRoot: '/work/acme & co', orbitHome: join(h, '.orbit'), entry: '/opt/orbit/dist/orbit.mjs', nodePath: '/opt/node/bin/node', path: '/opt/node/bin:/usr/bin:/bin' });
}

describe('service definitions', () => {
  it('renders a launchd agent that restarts only on failure, throttles, logs under ~/.orbit/logs and escapes XML', () => {
    const h = home();
    const s = spec(h);
    const plist = renderLaunchdPlist(s);
    expect(s.label).toMatch(/^dev\.orbit\.controller\.[0-9a-f]{12}$/);
    expect(plist).toContain('<key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key><false/>');
    expect(plist).toContain('<key>ThrottleInterval</key><integer>10</integer>');
    expect(plist).toContain(`<string>${join(h, '.orbit', 'logs', `${s.label}.out.log`)}</string>`);
    expect(plist).toContain('<string>/work/acme &amp; co</string>');
    // The definition starts the stable launcher, not node and the versioned bundle path, which change on every plugin update (service-launcher.test.ts).
    expect(plist).toContain(`<string>${join(h, '.orbit', 'bin', 'orbit')}</string>\n    <string>service</string>\n    <string>run</string>`);
    expect(plist).not.toContain('/opt/orbit/dist/orbit.mjs');
    expect(plist).not.toContain('<string>/opt/node/bin/node</string>\n    <string>/opt/orbit');
    expect(plist).not.toContain('AbandonProcessGroup');
  });

  it('renders a systemd user unit that keeps workers alive across a controller restart', () => {
    const h = home();
    const unit = renderSystemdUnit(spec(h));
    expect(unit).toContain('KillMode=process');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('RestartSec=5');
    expect(unit).toContain(`ExecStart="${join(h, '.orbit', 'bin', 'orbit')}" "service" "run" "--repo" "/work/acme & co"`);
    expect(unit).not.toContain('/opt/orbit/dist/orbit.mjs');
    expect(unit).toMatch(/StartLimitBurst=10[\s\S]*\[Service\]/);
    expect(unit).toContain('Environment="NODE_OPTIONS=--disable-warning=ExperimentalWarning"');
  });

  it('builds the verified launchctl command shapes', () => {
    expect(launchctlCommands('dev.orbit.controller.x', 501, '/h/p.plist')).toEqual({
      bootout: ['launchctl', 'bootout', 'gui/501/dev.orbit.controller.x'],
      bootstrap: ['launchctl', 'bootstrap', 'gui/501', '/h/p.plist'],
      kickstart: ['launchctl', 'kickstart', '-k', 'gui/501/dev.orbit.controller.x'],
      print: ['launchctl', 'print', 'gui/501/dev.orbit.controller.x'],
    });
  });
});

describe('install, status and uninstall (no real service manager)', () => {
  it('macOS: writes a private-log plist, boots out (exit 3 accepted) then bootstraps, and probes with print', async () => {
    const h = home();
    const s = spec(h);
    const run = runner({ bootout: [3] });
    const status = await installService(s, { platform: 'darwin', homeDir: h, uid: 501, run });
    const path = launchdPlistPath(h, s.label);
    expect(run.calls.map((c) => c[1])).toEqual(['bootout', 'bootstrap', 'print']);
    expect(statSync(path).mode & 0o777).toBe(0o644);
    expect(statSync(s.logDir).mode & 0o777).toBe(0o700);
    expect(status).toMatchObject({ installed: true, loaded: true, definitionPath: path });
  });

  it('macOS: a bootstrap that finds the job still loaded (exit 5) restarts it with kickstart -k', async () => {
    const h = home();
    const run = runner({ bootstrap: [5] });
    await installService(spec(h), { platform: 'darwin', homeDir: h, uid: 501, run });
    expect(run.calls.map((c) => c.slice(0, 3).join(' '))).toEqual(['launchctl bootout gui/501/' + spec(h).label, `launchctl bootstrap gui/501`, 'launchctl kickstart -k', 'launchctl print gui/501/' + spec(h).label]);
  });

  it('macOS: other bootstrap failures are errors; print 113 means not loaded; uninstall removes the plist', async () => {
    const h = home();
    const s = spec(h);
    await expect(installService(s, { platform: 'darwin', homeDir: h, uid: 501, run: runner({ bootstrap: [37] }) })).rejects.toThrow(/bootstrap/);
    const st = await serviceStatus(s.label, { platform: 'darwin', homeDir: h, uid: 501, run: runner({ print: [113] }) });
    expect(st.loaded).toBe(false);
    expect((await serviceStatus(s.label, { platform: 'darwin', homeDir: h, uid: 501, run: runner({ print: [9] }) })).loaded).toBeNull();
    const gone = await uninstallService(s.label, { platform: 'darwin', homeDir: h, uid: 501, run: runner({ bootout: [3], print: [113] }) });
    expect(gone).toMatchObject({ installed: false, loaded: false });
    expect(existsSync(launchdPlistPath(h, s.label))).toBe(false);
  });

  it('Linux: writes the user unit, reloads and enables it; uninstall disables and removes it', async () => {
    const h = home();
    const s = spec(h);
    const run = runner();
    const st = await installService(s, { platform: 'linux', homeDir: h, uid: 1000, run });
    expect(run.calls.map((c) => c.slice(0, 3).join(' '))).toEqual(['systemctl --user daemon-reload', 'systemctl --user enable', 'systemctl --user is-active']);
    expect(readFileSync(systemdUnitPath(h, s.label), 'utf8')).toContain('KillMode=process');
    expect(st.loaded).toBe(true);
    await uninstallService(s.label, { platform: 'linux', homeDir: h, uid: 1000, run });
    expect(existsSync(systemdUnitPath(h, s.label))).toBe(false);
  });

  it('refuses platforms without a supported service manager', async () => {
    const h = home();
    await expect(installService(spec(h), { platform: 'win32', homeDir: h, uid: 0, run: runner() })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });
});


describe('uninstall waits for launchd to let go of the job (P23)', () => {
  /** launchctl print answers 0 (still listed) for the first `listed` probes after bootout, then 113. */
  function lingering(listed: number): CommandRunner & { calls: string[][]; probes: () => number } {
    const calls: string[][] = [];
    let seen = 0;
    const fn = (async (argv: string[]) => {
      calls.push(argv);
      if (argv.includes('print')) {
        seen++;
        return { exitCode: seen <= listed ? 0 : 113, stdout: '', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }) as CommandRunner & { calls: string[][]; probes: () => number };
    fn.calls = calls;
    fn.probes = () => seen;
    return fn;
  }

  it('polls until launchd no longer lists the job, then reports it gone', async () => {
    const h = home();
    const s = spec(h);
    const run = lingering(3);
    const slept: number[] = [];
    const st = await uninstallService(s.label, { platform: 'darwin', homeDir: h, uid: 501, run, pollMs: 100, stopTimeoutMs: 5_000, sleep: async (ms) => void slept.push(ms) });
    expect(st).toMatchObject({ installed: false, loaded: false, stopPending: false });
    expect(run.probes()).toBe(4);
    expect(slept).toEqual([100, 100, 100]);
  });

  it('gives up after the stop timeout and says the stop is still pending instead of claiming it is gone', async () => {
    const h = home();
    const s = spec(h);
    const run = lingering(Number.POSITIVE_INFINITY);
    let now = 0;
    const st = await uninstallService(s.label, { platform: 'darwin', homeDir: h, uid: 501, run, pollMs: 1_000, stopTimeoutMs: 3_000, sleep: async (ms) => void (now += ms), now: () => now });
    expect(st).toMatchObject({ installed: false, loaded: true, stopPending: true });
    expect(st.detail).toMatch(/still stopping/);
  });
});

describe('pruneDeadControllers (P23)', () => {
  it('marks stopped the controllers of this host whose process is gone, and leaves live ones and other hosts alone', async () => {
    const { openDb } = await import('../../../src/storage/db.ts');
    const { ManualClock } = await import('../../../src/core/clock.ts');
    const { registerController, listControllers, getController } = await import('../../../src/storage/controllers.ts');
    const { hostname } = await import('node:os');
    const db = openDb(':memory:');
    const clock = new ManualClock(1_000_000);
    registerController(db, { id: 'ctl-dead', pid: 2_000_000_000, host: hostname(), procStart: 'x', mode: 'foreground' }, clock);
    registerController(db, { id: 'ctl-live', pid: process.pid, host: hostname(), procStart: null, mode: 'foreground' }, clock);
    registerController(db, { id: 'ctl-elsewhere', pid: 2_000_000_001, host: 'another-host.invalid', procStart: null, mode: 'foreground' }, clock);
    const pruned = pruneDeadControllers(db, clock);
    expect(pruned).toEqual(['ctl-dead']);
    expect(getController(db, 'ctl-dead')).toMatchObject({ stopReason: expect.stringMatching(/process is gone/) });
    expect(listControllers(db).map((c) => c.id).sort()).toEqual(['ctl-elsewhere', 'ctl-live']);
  });
});
