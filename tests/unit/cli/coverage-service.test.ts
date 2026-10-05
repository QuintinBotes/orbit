/** `orbit service`: output shapes, warnings, the Linux linger probe and `service run`. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lingerState } from '../../../src/cli/commands/service.ts';
import { createContext } from '../../../src/cli/context.ts';
import { memoryIo } from '../../../src/cli/io.ts';
import { systemClock } from '../../../src/core/clock.ts';
import { serviceLabel, type CommandRunner } from '../../../src/controller/service.ts';
import { registerController, heartbeatController } from '../../../src/storage/controllers.ts';
import { makeLab, type Lab } from './lab.ts';

const hooks = vi.hoisted(() => ({
  exec: null as null | ((argv: readonly string[]) => unknown),
  fake: false,
  started: [] as Array<Record<string, unknown>>,
  startFails: null as null | Error,
}));
vi.mock('../../../src/core/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/exec.ts')>();
  return {
    ...actual,
    execCapture: (argv: readonly string[], opts: never) => {
      const fake = hooks.exec?.(argv);
      if (fake instanceof Error) return Promise.reject(fake);
      return fake !== undefined ? Promise.resolve(fake) : actual.execCapture(argv, opts);
    },
  };
});
vi.mock('../../../src/controller/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/controller/index.ts')>();
  class Fake {
    readonly ownerId = 'ctl-fake-1';
    constructor(opts: Record<string, unknown>) {
      hooks.started.push(opts);
    }
    async start(): Promise<void> {
      if (hooks.startFails) throw hooks.startFails;
    }
  }
  const Wrapper = function (this: unknown, opts: ConstructorParameters<typeof actual.Controller>[0]) {
    return hooks.fake ? new Fake(opts as never) : new actual.Controller(opts);
  } as unknown as typeof actual.Controller;
  return { ...actual, Controller: Wrapper };
});

const labs: Lab[] = [];
const lab = () => {
  const l = makeLab();
  labs.push(l);
  return l;
};
beforeEach(() => {
  hooks.exec = null;
  hooks.fake = false;
  hooks.started = [];
  hooks.startFails = null;
});
afterEach(() => {
  vi.restoreAllMocks();
  labs.splice(0).forEach((l) => l.close());
});

const CONFIG = ['version: 1', 'mode: autonomous', 'isolation: {provider: none, allow_unisolated: true}', ''].join('\n');

function prepare(l: Lab, entryName = 'orbit.mjs') {
  mkdirSync(join(l.repo, '.orbit'), { recursive: true });
  writeFileSync(join(l.repo, '.orbit', 'config.yaml'), CONFIG);
  const entry = join(l.base, entryName);
  writeFileSync(entry, '// stand-in\n');
  const calls: string[][] = [];
  const runner: CommandRunner = async (argv) => {
    calls.push(argv);
    const loaded = calls.some((c) => c[1] === 'bootstrap' || (c[0] === 'systemctl' && c.includes('enable')));
    return { exitCode: argv.includes('print') ? (loaded ? 0 : 113) : 0, stdout: argv.includes('is-active') ? (loaded ? 'active\n' : 'inactive\n') : '', stderr: '' };
  };
  return { entry, calls, runner };
}

describe('lingerState', () => {
  const ctx = (platform: NodeJS.Platform) => createContext({ io: memoryIo(), platform, user: 'alice', env: { PATH: '/bin' } });

  it('is unknown anywhere but Linux, without asking', async () => {
    hooks.exec = () => {
      throw new Error('must not be called');
    };
    expect(await lingerState(ctx('darwin'))).toBe('unknown');
  });

  it('reads the Linger property of the user, and treats anything else, or a failure, as unknown', async () => {
    const asked: string[][] = [];
    const answer = (stdout: string) => (argv: readonly string[]) => (asked.push([...argv]), { exitCode: 0, signal: null, stdout, stderr: '' });
    hooks.exec = answer('Linger=yes\n');
    expect(await lingerState(ctx('linux'))).toBe('yes');
    expect(asked[0]).toEqual(['loginctl', 'show-user', 'alice', '--property=Linger']);
    hooks.exec = answer('Linger=no\n');
    expect(await lingerState(ctx('linux'))).toBe('no');
    hooks.exec = answer('Linger=maybe\n');
    expect(await lingerState(ctx('linux'))).toBe('unknown');
    hooks.exec = () => new Error('spawn loginctl ENOENT');
    expect(await lingerState(ctx('linux'))).toBe('unknown');
  });
});

describe('orbit service install', () => {
  it('prints the definition, the log directory and the credential note, and warns about an entry that is not a built bundle', async () => {
    const l = lab();
    const { entry, runner } = prepare(l, 'orbit.ts');
    const r = await l.cli(['service', 'install', '--entry', entry], { platform: 'darwin', uid: 501, seams: { serviceRunner: runner } });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(new RegExp(`^service ${serviceLabel(l.repo)} installed \\(darwin\\): loaded\\n`));
    expect(r.out).toContain(`logs: ${join(l.orbitHome, 'logs')}\n`);
    expect(r.out).toContain('No credentials were written to the definition.');
    expect(r.err).toBe(`warning: the service will run ${entry}, not a built dist/orbit.mjs; build the bundle for a durable installation\n`);
  });

  it('without PATH in the environment installs a definition that carries none', async () => {
    const l = lab();
    const { entry, runner } = prepare(l);
    const r = await l.cli(['service', 'install', '--entry', entry, '--json'], { platform: 'darwin', uid: 501, seams: { serviceRunner: runner }, env: { HOME: l.home, ORBIT_HOME: l.orbitHome } });
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ installed: true, warnings: [] });
  });

  it('warns on Linux that the service stops at logout when lingering is off, and not when it is on', async () => {
    const l = lab();
    const { entry, runner } = prepare(l);
    hooks.exec = (argv) => (argv[0] === 'loginctl' ? { exitCode: 0, signal: null, stdout: 'Linger=no\n', stderr: '' } : undefined);
    const off = await l.cli(['service', 'install', '--entry', entry, '--json'], { platform: 'linux', uid: 1000, seams: { serviceRunner: runner } });
    expect((JSON.parse(off.out) as { warnings: string[] }).warnings).toEqual(['lingering is off for alice, so the service stops when you log out; run "loginctl enable-linger alice" to keep it running']);
    const text = await l.cli(['service', 'install', '--entry', entry], { platform: 'linux', uid: 1000, seams: { serviceRunner: runner } });
    expect(text.err).toBe('warning: lingering is off for alice, so the service stops when you log out; run "loginctl enable-linger alice" to keep it running\n');
    hooks.exec = (argv) => (argv[0] === 'loginctl' ? { exitCode: 0, signal: null, stdout: 'Linger=yes\n', stderr: '' } : undefined);
    const on = await l.cli(['service', 'install', '--entry', entry], { platform: 'linux', uid: 1000, seams: { serviceRunner: runner } });
    expect(on.err).toBe('');
  });

  it('says what is missing when there is no entry script, with the unknown entry spelled out', async () => {
    const l = lab();
    const { runner } = prepare(l);
    const missing = await l.cli(['service', 'install', '--entry', join(l.base, 'nope.mjs')], { seams: { serviceRunner: runner } });
    expect(missing.code).toBe(3);
    expect(missing.err).toContain(`the orbit entry script ${join(l.base, 'nope.mjs')} does not exist; pass --entry <path to dist/orbit.mjs>`);
    const unknown = await l.cli(['service', 'install'], { entry: '', seams: { serviceRunner: runner } });
    expect(unknown.err).toContain('the orbit entry script (unknown) does not exist');
  });

  it('refuses to install a service whose policy does not load, before touching the service manager', async () => {
    const l = lab();
    const { entry, calls, runner } = prepare(l);
    writeFileSync(join(l.repo, '.orbit', 'config.yaml'), 'version: [broken\n');
    const r = await l.cli(['service', 'install', '--entry', entry], { seams: { serviceRunner: runner } });
    expect(r.code).toBe(4);
    expect(calls).toEqual([]);
  });
});

describe('orbit service uninstall and status', () => {
  it('uninstall confirms in words or in JSON', async () => {
    const l = lab();
    const { runner } = prepare(l);
    const text = await l.cli(['service', 'uninstall'], { platform: 'darwin', uid: 501, seams: { serviceRunner: runner } });
    expect(text.out).toBe(`service ${serviceLabel(l.repo)} uninstalled; runs and their state are untouched\n`);
    const j = await l.cli(['service', 'uninstall', '--json'], { platform: 'darwin', uid: 501, seams: { serviceRunner: runner } });
    expect(JSON.parse(j.out)).toMatchObject({ label: serviceLabel(l.repo), installed: false });
  });

  it('says the state is unknown when the service manager gives no clear answer, and exits 1', async () => {
    const l = lab();
    prepare(l);
    const runner: CommandRunner = async () => ({ exitCode: 5, stdout: '', stderr: '' });
    const r = await l.cli(['service', 'status'], { platform: 'darwin', uid: 501, seams: { serviceRunner: runner } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('not installed, state unknown (launchctl print exited 5)\n');
    const linux = await l.cli(['service', 'status'], { platform: 'linux', uid: 1000, seams: { serviceRunner: async () => ({ exitCode: 3, stdout: 'inactive\n', stderr: '' }) } });
    expect(linux.out).toContain('not installed, not loaded\n');
    const mystery = await l.cli(['service', 'status'], { platform: 'linux', uid: 1000, seams: { serviceRunner: async () => ({ exitCode: 4, stdout: 'weird\n', stderr: '' }) } });
    expect(mystery.out).toContain('state unknown (weird)');
  });

  it('lists the controllers registered in this repository, live and stale', async () => {
    const l = lab();
    const { entry, runner } = prepare(l);
    await l.cli(['service', 'install', '--entry', entry], { platform: 'darwin', uid: 501, seams: { serviceRunner: runner } });
    const db = l.db();
    registerController(db, { id: 'ctl-live', pid: process.pid, host: hostname(), mode: 'service' }, systemClock);
    heartbeatController(db, 'ctl-live', systemClock, { progress: true });
    const old = { now: () => Date.now() - 10 * 60_000, sleep: systemClock.sleep };
    registerController(db, { id: 'ctl-old', pid: 2 ** 22 + 99, host: 'elsewhere.invalid', mode: 'foreground' }, old);
    const text = await l.cli(['service', 'status'], { platform: 'darwin', uid: 501, seams: { serviceRunner: runner } });
    expect(text.code).toBe(0);
    expect(text.out).toContain(': installed, loaded\n');
    expect(text.out).toMatch(new RegExp(`controller ctl-live: service, pid ${process.pid}, heartbeat \\d+s ago \\(live\\)\\n`));
    expect(text.out).toMatch(/controller ctl-old: foreground, pid \d+, heartbeat 10m ago \(stale\)\n/);
    expect(text.out).not.toContain('none has registered');
    const j = JSON.parse((await l.cli(['service', 'status', '--json'], { platform: 'darwin', uid: 501, seams: { serviceRunner: runner } })).out) as { controllers: Array<{ id: string; live: boolean }> };
    expect(j.controllers.map((c) => [c.id, c.live]).sort()).toEqual([['ctl-live', true], ['ctl-old', false]]);
  });
});

describe('orbit service run', () => {
  it('announces the controller it starts in service mode and answers 0 when it ends', async () => {
    const l = lab();
    prepare(l);
    hooks.fake = true;
    const r = await l.cli(['service', 'run'], { seams: { controllerDeps: () => ({}) as never, controller: { tickIntervalMs: 7 } } });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe(`orbit controller ctl-fake-1 started in service mode for ${l.repo} (pid ${process.pid})\n`);
    expect(hooks.started).toEqual([expect.objectContaining({ mode: 'service', handleSignals: true, tickIntervalMs: 7 })]);
  });

  it('still closes the state database when the controller fails, and reports the error', async () => {
    const l = lab();
    prepare(l);
    hooks.fake = true;
    hooks.startFails = new Error('controller crashed');
    const r = await l.cli(['service', 'run'], { seams: { controllerDeps: () => ({}) as never } });
    expect(r.code).toBe(1);
    expect(r.err).toBe('orbit: controller crashed\n');
  });

  it('refuses extra arguments and a policy that does not load', async () => {
    const l = lab();
    prepare(l);
    expect((await l.cli(['service', 'run', 'now'])).code).toBe(2);
    writeFileSync(join(l.repo, '.orbit', 'config.yaml'), 'mode: nonsense\n');
    expect((await l.cli(['service', 'run'])).code).toBe(4);
  });
});
