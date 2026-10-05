/** The CLI keeps the service launcher pointing at the bundle that is running, so a plugin update needs no `service install`. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { launcherPath, launchdPlistPath, readLauncher, serviceLabel, type CommandRunner } from '../../../src/controller/service.ts';
import { makeLab, type Lab } from './lab.ts';

const labs: Lab[] = [];
const lab = () => {
  const l = makeLab();
  labs.push(l);
  return l;
};
afterEach(() => labs.splice(0).forEach((l) => l.close()));

const CONFIG = ['version: 1', 'mode: autonomous', 'isolation: {provider: none, allow_unisolated: true}', ''].join('\n');

function bundle(l: Lab, version: string): string {
  const dir = join(l.base, 'plugin-cache', version, 'dist');
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, 'orbit.mjs');
  writeFileSync(entry, `console.log('bundle ${version}:' + process.argv.slice(2).join(' '));\n`);
  return entry;
}

function prepare(l: Lab): CommandRunner {
  mkdirSync(join(l.repo, '.orbit'), { recursive: true });
  writeFileSync(join(l.repo, '.orbit', 'config.yaml'), CONFIG);
  return async (argv) => ({ exitCode: 0, stdout: argv.includes('is-active') ? 'active\n' : '', stderr: '' });
}

function plistProgram(plist: string): string[] {
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)![1]!;
  return [...block.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]!);
}

describe('the service survives a plugin update without a reinstall', () => {
  it('install from bundle A, then any command from bundle B: the unchanged plist starts B, even after A is deleted', async () => {
    const l = lab();
    const runner = prepare(l);
    const a = bundle(l, '0.1.0');
    const b = bundle(l, '0.2.0');
    const inst = await l.cli(['service', 'install', '--entry', a, '--json'], { platform: 'darwin', uid: 501, entry: a, seams: { serviceRunner: runner } });
    expect(inst.code, inst.err).toBe(0);
    const plistPath = launchdPlistPath(l.home, serviceLabel(l.repo));
    const before = readFileSync(plistPath, 'utf8');
    const [program, ...args] = plistProgram(before);
    expect(program).toBe(launcherPath(l.orbitHome));
    expect(before).not.toContain(a);
    expect(execFileSync(program!, args, { encoding: 'utf8' })).toContain('bundle 0.1.0:service run');

    // The plugin updates: the next orbit command runs from the new versioned path, the old one is removed.
    const st = await l.cli(['service', 'status'], { platform: 'darwin', uid: 501, entry: b, seams: { serviceRunner: runner } });
    expect(st.code, st.err).toBe(0);
    rmSync(join(l.base, 'plugin-cache', '0.1.0'), { recursive: true });

    expect(readFileSync(plistPath, 'utf8')).toBe(before);
    expect(readLauncher(launcherPath(l.orbitHome))!.entry).toBe(b);
    expect(execFileSync(program!, args, { encoding: 'utf8' })).toContain('bundle 0.2.0:service run');
  });

  it('a command that runs where no service was ever installed writes nothing under the Orbit home', async () => {
    const l = lab();
    const runner = prepare(l);
    const b = bundle(l, '0.2.0');
    await l.cli(['service', 'status'], { platform: 'darwin', uid: 501, entry: b, seams: { serviceRunner: runner } });
    expect(existsSync(join(l.orbitHome, 'bin'))).toBe(false);
  });

  it('a worker process never rewrites the launcher', async () => {
    const l = lab();
    const runner = prepare(l);
    const a = bundle(l, '0.1.0');
    const b = bundle(l, '0.2.0');
    await l.cli(['service', 'install', '--entry', a], { platform: 'darwin', uid: 501, entry: a, seams: { serviceRunner: runner } });
    await l.cli(['status', '--json'], { platform: 'darwin', uid: 501, entry: b, seams: { serviceRunner: runner }, env: { ...process.env, HOME: l.home, ORBIT_HOME: l.orbitHome, ORBIT_WORKER: '1' } });
    expect(readLauncher(launcherPath(l.orbitHome))!.entry).toBe(a);
  });

  it('install and status name the launcher and say when its bundle is gone', async () => {
    const l = lab();
    const runner = prepare(l);
    const a = bundle(l, '0.1.0');
    const inst = await l.cli(['service', 'install', '--entry', a], { platform: 'darwin', uid: 501, entry: a, seams: { serviceRunner: runner } });
    expect(inst.out).toContain(`launcher: ${launcherPath(l.orbitHome)}`);
    expect(inst.out).toMatch(/follows plugin updates/);
    // A launcher whose bundle was removed and that no orbit command has repointed yet (an update in progress).
    rmSync(join(l.base, 'plugin-cache', '0.1.0'), { recursive: true });
    const st = await l.cli(['service', 'status', '--json'], { platform: 'darwin', uid: 501, entry: join(l.base, 'gone.ts'), seams: { serviceRunner: runner } });
    const j = JSON.parse(st.out) as { launcher: { path: string; entry: string; bundleExists: boolean } };
    expect(j.launcher).toMatchObject({ path: launcherPath(l.orbitHome), entry: a, bundleExists: false });
    const text = await l.cli(['service', 'status'], { platform: 'darwin', uid: 501, entry: join(l.base, 'gone.ts'), seams: { serviceRunner: runner } });
    expect(text.out).toMatch(/launcher .* runs .*orbit\.mjs.*MISSING/);
  });
});
