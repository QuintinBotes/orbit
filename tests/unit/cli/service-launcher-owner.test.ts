/**
 * Nm2: the service launcher belongs to the installation that ran `service install`. `service uninstall` removes it
 * (once no Orbit service definition is left), and a command run from some other copy of Orbit (a stale clone) does not
 * repoint it; only the installed bundle (new node, or the next version of the same plugin) and a newer version may.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { launcherPath, launchdPlistPath, readLauncher, refreshLauncher, serviceLabel, writeLauncher, type CommandRunner } from '../../../src/controller/service.ts';
import { makeLab, type Lab } from './lab.ts';

const labs: Lab[] = [];
const lab = () => {
  const l = makeLab();
  labs.push(l);
  return l;
};
afterEach(() => labs.splice(0).forEach((l) => l.close()));

const CONFIG = ['version: 1', 'mode: autonomous', 'isolation: {provider: none, allow_unisolated: true}', ''].join('\n');
const darwin = (l: Lab, entry: string, runner: CommandRunner) => ({ platform: 'darwin' as const, uid: 501, entry, seams: { serviceRunner: runner, serviceStopTimeoutMs: 1 }, homeDir: l.home });

function bundleAt(l: Lab, ...segments: string[]): string {
  const dir = join(l.base, ...segments, 'dist');
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, 'orbit.mjs');
  writeFileSync(entry, 'console.log("bundle");\n');
  return entry;
}

/** launchctl answers "not loaded" (113) to a print once the job is booted out, so uninstall does not wait. */
function runner(): CommandRunner {
  return async (argv) => ({ exitCode: argv.includes('print') ? 113 : 0, stdout: '', stderr: '' });
}

function prepare(l: Lab): void {
  mkdirSync(join(l.repo, '.orbit'), { recursive: true });
  writeFileSync(join(l.repo, '.orbit', 'config.yaml'), CONFIG);
}

describe('Nm2: uninstall removes the launcher it installed', () => {
  it('install then uninstall leaves no launcher and says so', async () => {
    const l = lab();
    prepare(l);
    const entry = bundleAt(l, 'plugin-cache', 'orbit', '0.1.0');
    const r = runner();
    expect((await l.cli(['service', 'install', '--entry', entry], darwin(l, entry, r))).code).toBe(0);
    expect(existsSync(launcherPath(l.orbitHome))).toBe(true);
    const un = await l.cli(['service', 'uninstall'], darwin(l, entry, r));
    expect(un.code, un.err).toBe(0);
    expect(existsSync(launchdPlistPath(l.home, serviceLabel(l.repo)))).toBe(false);
    expect(existsSync(launcherPath(l.orbitHome))).toBe(false);
    expect(un.out).toMatch(/launcher .* removed/);
  });

  it('keeps it while another repository\'s service definition remains, and removes it with the last one', async () => {
    const l = lab();
    prepare(l);
    const entry = bundleAt(l, 'plugin-cache', 'orbit', '0.1.0');
    const r = runner();
    await l.cli(['service', 'install', '--entry', entry], darwin(l, entry, r));
    // Another repository's service shares the launcher (one per user).
    const otherPlist = launchdPlistPath(l.home, 'dev.orbit.controller.other-repo');
    writeFileSync(otherPlist, '<plist/>');
    const first = await l.cli(['service', 'uninstall'], darwin(l, entry, r));
    expect(first.code, first.err).toBe(0);
    expect(existsSync(launcherPath(l.orbitHome))).toBe(true);
    expect(first.out).not.toMatch(/launcher .* removed/);
    // Removing the other repository's definition by hand and uninstalling here again: nothing is left to serve.
    const { rmSync } = await import('node:fs');
    rmSync(otherPlist);
    const second = await l.cli(['service', 'uninstall'], darwin(l, entry, r));
    expect(second.code, second.err).toBe(0);
    expect(existsSync(launcherPath(l.orbitHome))).toBe(false);
  });

  it('never deletes a launcher Orbit did not write', async () => {
    const l = lab();
    prepare(l);
    const entry = bundleAt(l, 'plugin-cache', 'orbit', '0.1.0');
    mkdirSync(join(l.orbitHome, 'bin'), { recursive: true });
    writeFileSync(launcherPath(l.orbitHome), '#!/bin/sh\necho mine\n');
    await l.cli(['service', 'uninstall'], darwin(l, entry, runner()));
    expect(existsSync(launcherPath(l.orbitHome))).toBe(true);
  });
});

describe('Nm2: only the installed bundle may repoint the launcher', () => {
  const node = process.execPath;

  it('a command run from another copy of Orbit leaves it alone, whichever command it is', async () => {
    const l = lab();
    prepare(l);
    const installed = bundleAt(l, 'plugin-cache', 'orbit', '0.1.0');
    const staleClone = bundleAt(l, 'old-clone', 'plugin');
    const r = runner();
    await l.cli(['service', 'install', '--entry', installed], darwin(l, installed, r));
    await l.cli(['status', '--json'], darwin(l, staleClone, r));
    expect(readLauncher(launcherPath(l.orbitHome))!.entry).toBe(installed);
  });

  it('the next version of the installed plugin (same place, new version directory) does repoint it', async () => {
    const l = lab();
    prepare(l);
    const installed = bundleAt(l, 'plugin-cache', 'orbit', '0.1.0');
    const updated = bundleAt(l, 'plugin-cache', 'orbit', '0.2.0');
    const r = runner();
    await l.cli(['service', 'install', '--entry', installed], darwin(l, installed, r));
    await l.cli(['status', '--json'], darwin(l, updated, r));
    expect(readLauncher(launcherPath(l.orbitHome))!.entry).toBe(updated);
  });

  it('refreshLauncher: same entry follows a new node, another place needs a newer version, an older or unknown version is refused', () => {
    const l = lab();
    const installed = bundleAt(l, 'plugin-cache', 'orbit', '0.1.0');
    const elsewhere = bundleAt(l, 'elsewhere', 'plugin');
    writeLauncher(l.orbitHome, { node, entry: installed, version: '0.1.0' });
    expect(refreshLauncher({ orbitHome: l.orbitHome, entry: elsewhere, nodePath: node, version: '0.1.0' })).toBe('other-install');
    expect(refreshLauncher({ orbitHome: l.orbitHome, entry: elsewhere, nodePath: node, version: '0.0.9' })).toBe('other-install');
    expect(refreshLauncher({ orbitHome: l.orbitHome, entry: elsewhere, nodePath: node })).toBe('other-install');
    expect(readLauncher(launcherPath(l.orbitHome))!.entry).toBe(installed);
    expect(refreshLauncher({ orbitHome: l.orbitHome, entry: elsewhere, nodePath: node, version: '0.2.0' })).toBe('updated');
    expect(readLauncher(launcherPath(l.orbitHome))).toMatchObject({ entry: elsewhere, version: '0.2.0' });
    // The same entry with the same node: nothing to do.
    expect(refreshLauncher({ orbitHome: l.orbitHome, entry: elsewhere, nodePath: node, version: '0.2.0' })).toBe('current');
  });
});
