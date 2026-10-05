import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandRunner } from '../../../src/controller/service.ts';
import { serviceLabel } from '../../../src/controller/service.ts';
import { makeLab, type Lab } from './lab.ts';

const labs: Lab[] = [];
const lab = () => {
  const l = makeLab();
  labs.push(l);
  return l;
};
afterEach(() => labs.splice(0).forEach((l) => l.close()));

const CONFIG = ['version: 1', 'mode: autonomous', 'isolation: {provider: none, allow_unisolated: true}', ''].join('\n');

function prepare(l: Lab): { entry: string; calls: string[][]; runner: CommandRunner } {
  mkdirSync(join(l.repo, '.orbit'), { recursive: true });
  writeFileSync(join(l.repo, '.orbit', 'config.yaml'), CONFIG);
  const entry = join(l.base, 'orbit.mjs');
  writeFileSync(entry, '// stand-in for dist/orbit.mjs\n');
  const calls: string[][] = [];
  // Never the real service manager: a stand-in that records what would have been run.
  const runner: CommandRunner = async (argv) => {
    calls.push(argv);
    const loaded = calls.some((c) => c[1] === 'bootstrap' || (c[0] === 'systemctl' && c.includes('enable')));
    return { exitCode: argv.includes('print') ? (loaded ? 0 : 113) : 0, stdout: argv.includes('is-active') ? (loaded ? 'active\n' : 'inactive\n') : '', stderr: '' };
  };
  return { entry, calls, runner };
}

describe('orbit service install, status and uninstall', () => {
  it('installs a launchd agent for this repository without writing any credential into it', async () => {
    const l = lab();
    const { entry, calls, runner } = prepare(l);
    const secret = 'sk-ant-api03-synthetic0123456789abcdefghijklmnop';
    const r = await l.cli(['service', 'install', '--entry', entry, '--json'], { platform: 'darwin', uid: 501, seams: { serviceRunner: runner }, env: { PATH: '/usr/bin:/bin', HOME: l.home, ORBIT_HOME: l.orbitHome, ANTHROPIC_API_KEY: secret, GH_TOKEN: 'ghp_synthetic0123456789abcdefghijklmnopqrstuv' } });
    expect(r.code, r.err).toBe(0);
    const j = JSON.parse(r.out) as { label: string; installed: boolean; loaded: boolean; definitionPath: string };
    expect(j.label).toBe(serviceLabel(l.repo));
    expect(j).toMatchObject({ installed: true, loaded: true });
    const plist = readFileSync(j.definitionPath, 'utf8');
    expect(plist).toContain(entry);
    expect(plist).toContain('<string>service</string>');
    expect(plist).toContain(l.repo);
    expect(plist).not.toContain(secret);
    expect(plist).not.toContain('ghp_synthetic');
    expect(plist).not.toContain('ANTHROPIC_API_KEY');
    expect(calls.map((c) => c.slice(0, 2).join(' '))).toEqual(['launchctl bootout', 'launchctl bootstrap', 'launchctl print']);
    expect(r.out).not.toContain(secret);

    const st = await l.cli(['service', 'status', '--json'], { platform: 'darwin', uid: 501, seams: { serviceRunner: runner } });
    expect(st.code).toBe(0);
    expect(JSON.parse(st.out)).toMatchObject({ installed: true, loaded: true, controllers: [] });

    const un = await l.cli(['service', 'uninstall'], { platform: 'darwin', uid: 501, seams: { serviceRunner: runner } });
    expect(un.code, un.err).toBe(0);
    expect(existsSync(j.definitionPath)).toBe(false);
  });

  it('installs a systemd user unit on Linux that leaves workers alone when the controller stops', async () => {
    const l = lab();
    const { entry, runner } = prepare(l);
    const r = await l.cli(['service', 'install', '--entry', entry, '--json'], { platform: 'linux', uid: 1000, seams: { serviceRunner: runner } });
    expect(r.code, r.err).toBe(0);
    const unit = readFileSync((JSON.parse(r.out) as { definitionPath: string }).definitionPath, 'utf8');
    expect(unit).toContain('KillMode=process');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain(`"${entry}"`);
  });

  it('reports a service that is not running with exit code 1, like systemctl is-active', async () => {
    const l = lab();
    const { runner } = prepare(l);
    const r = await l.cli(['service', 'status'], { platform: 'darwin', uid: 501, seams: { serviceRunner: runner } });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/not installed, not loaded/);
    expect(r.out).toMatch(/controller: none has registered/);
  });

  it('refuses to install a service that could not load the policy, or one with no entry script', async () => {
    const l = lab();
    const { runner } = prepare(l);
    const noEntry = await l.cli(['service', 'install', '--entry', join(l.base, 'missing.mjs')], { platform: 'darwin', seams: { serviceRunner: runner } });
    expect(noEntry.code).toBe(3);
    writeFileSync(join(l.repo, '.orbit', 'config.yaml'), 'version: 1\nmode: sideways\n');
    const badConfig = await l.cli(['service', 'install', '--entry', join(l.base, 'orbit.mjs')], { platform: 'darwin', seams: { serviceRunner: runner } });
    expect(badConfig.code).toBe(4);
  });

  it('warns when the service would run from sources rather than a built bundle', async () => {
    const l = lab();
    const { runner } = prepare(l);
    const ts = join(l.base, 'bin.ts');
    writeFileSync(ts, '');
    const r = await l.cli(['service', 'install', '--entry', ts], { platform: 'darwin', uid: 501, seams: { serviceRunner: runner } });
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/not a built dist\/orbit\.mjs/);
  });

  it('says the service is unsupported where there is no service manager', async () => {
    const l = lab();
    const { entry, runner } = prepare(l);
    const r = await l.cli(['service', 'install', '--entry', entry], { platform: 'win32', seams: { serviceRunner: runner } });
    expect(r.code).toBe(4);
    expect(r.err).toMatch(/orbit run --foreground/);
  });
});
