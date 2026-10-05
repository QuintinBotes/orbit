import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManualClock } from '../../../src/core/clock.ts';
import { nullLogger } from '../../../src/core/log.ts';
import { openDb } from '../../../src/storage/db.ts';
import { defaultCheck, defaultConfig, loadConfig } from '../../../src/policy/config.ts';
import { verifySnapshot } from '../../../src/policy/snapshot.ts';
import type { ProviderAdapter } from '../../../src/adapters/types.ts';
import { defaultControllerDeps, defaultOrbitHome, orbitDir, orbitInstallDir, stateDbPath, startRun } from '../../../src/controller/start.ts';
import { getRun } from '../../../src/controller/run-store.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-start-')));
  dirs.push(d);
  return d;
}

describe('start paths', () => {
  it('keeps run state under .orbit in the repository', () => {
    expect(orbitDir('/work/acme')).toBe('/work/acme/.orbit');
    expect(stateDbPath('/work/acme')).toBe('/work/acme/.orbit/state.sqlite');
  });

  it('takes the Orbit home from ORBIT_HOME and otherwise from the user home', () => {
    expect(defaultOrbitHome({ ORBIT_HOME: '/srv/orbit-home' })).toBe('/srv/orbit-home');
    expect(defaultOrbitHome({})).toBe(join(homedir(), '.orbit'));
    expect(defaultOrbitHome({ ORBIT_HOME: undefined })).toBe(join(homedir(), '.orbit'));
  });

  it('finds the install directory three levels up from the sources and one up from the bundle', () => {
    expect(orbitInstallDir('/opt/orbit/src/controller')).toBe('/opt/orbit');
    expect(orbitInstallDir('/opt/orbit/dist')).toBe('/opt/orbit');
    // The default is this checkout's sources.
    expect(existsSync(join(orbitInstallDir(), 'package.json'))).toBe(true);
  });
});

describe('startRun', () => {
  it('freezes the policy read-only before the run row that names it exists, and records the actor', () => {
    const repo = tmp();
    const db = openDb(':memory:');
    const clock = new ManualClock();
    const config = defaultConfig('autonomous');
    const run = startRun({ db, repoRoot: repo, goal: 'Add a mul function', config, clock, runId: 'orb-fixed', actor: 'tester' });
    expect(run.id).toBe('orb-fixed');
    expect(run.repoRoot).toBe(repo);
    expect(run.goal).toBe('Add a mul function');
    expect(run.mode).toBe('autonomous');
    expect(run.policyPath).toBe(join(repo, '.orbit', 'runs', 'orb-fixed', 'policy.json'));
    expect(statSync(run.policyPath).mode & 0o777).toBe(0o444);
    expect(verifySnapshot(run.policyPath, run.policyHash).run_id).toBe('orb-fixed');
    const created = db.get<{ actor: string }>("SELECT actor FROM events WHERE run_id = 'orb-fixed' ORDER BY id LIMIT 1");
    expect(created?.actor).toBe('tester');
  });

  it('resolves a symlinked repository path to its real location and generates an id from the clock', () => {
    const repo = tmp();
    const link = join(tmp(), 'link');
    symlinkSync(repo, link);
    const db = openDb(':memory:');
    const run = startRun({ db, repoRoot: link, goal: 'g', config: defaultConfig('autonomous'), clock: new ManualClock() });
    expect(run.repoRoot).toBe(repo);
    expect(run.id).toMatch(/^orb-/);
    const other = startRun({ db, repoRoot: repo, goal: 'g', config: defaultConfig('autonomous'), clock: new ManualClock() });
    expect(other.id).not.toBe(run.id);
  });

  it('defaults the actor to cli', () => {
    const repo = tmp();
    const db = openDb(':memory:');
    const run = startRun({ db, repoRoot: repo, goal: 'g', config: defaultConfig('autonomous'), clock: new ManualClock() });
    expect(db.get<{ actor: string }>('SELECT actor FROM events WHERE run_id = ? ORDER BY id LIMIT 1', run.id)?.actor).toBe('cli');
  });

  it('refuses a second snapshot for the same run id and does not write the run row', () => {
    const repo = tmp();
    const db = openDb(':memory:');
    const config = defaultConfig('autonomous');
    startRun({ db, repoRoot: repo, goal: 'g', config, clock: new ManualClock(), runId: 'orb-once' });
    expect(() => startRun({ db, repoRoot: repo, goal: 'g2', config, clock: new ManualClock(), runId: 'orb-once' })).toThrow(/already exists/);
    expect(getRun(db, 'orb-once').goal).toBe('g');
  });

  it('fails for a repository that does not exist', () => {
    expect(() => startRun({ db: openDb(':memory:'), repoRoot: join(tmp(), 'missing'), goal: 'g', config: defaultConfig('autonomous') })).toThrow();
  });
});

describe('defaultControllerDeps', () => {
  const stub = { id: 'claude' } as unknown as ProviderAdapter;

  it('assembles the collaborators from explicit inputs without opening anything it was given', () => {
    const repo = tmp();
    const db = openDb(':memory:');
    const env = { ORBIT_HOME: join(repo, 'home'), PATH: '/bin' };
    const clock = new ManualClock();
    const deps = defaultControllerDeps({ repoRoot: repo, db, clock, logger: nullLogger, config: defaultConfig('autonomous'), adapters: { claude: stub }, env });
    expect(deps.db).toBe(db);
    expect(deps.clock).toBe(clock);
    expect(deps.logger).toBe(nullLogger);
    expect(deps.adapters).toEqual({ claude: stub });
    expect(deps.orbitHome).toBe(join(repo, 'home'));
    expect(deps.hostEnv).toBe(env);
    expect(deps.homeDir).toBe(homedir());
    expect(deps.orbitInstallDir).toBe(orbitInstallDir());
    expect(deps.registry).toBeDefined();
  });

  it('prefers an explicit orbit home over the environment', () => {
    const repo = tmp();
    const deps = defaultControllerDeps({ repoRoot: repo, db: openDb(':memory:'), config: defaultConfig('autonomous'), adapters: {}, orbitHome: '/x/home', env: { ORBIT_HOME: '/y/home' } });
    expect(deps.orbitHome).toBe('/x/home');
  });

  it('creates adapters for every configured provider, with the live process environment by default', () => {
    const repo = tmp();
    const config = defaultConfig('autonomous');
    config.isolation = { provider: 'none', allow_unisolated: true, container: null };
    const deps = defaultControllerDeps({ repoRoot: repo, db: openDb(':memory:'), config, orbitHome: join(repo, 'h') });
    expect(Object.keys(deps.adapters).sort()).toEqual(Object.keys(config.providers).sort());
    expect(deps.hostEnv).toBe(process.env);
    expect(existsSync(join(repo, 'h', 'logs', 'controller.jsonl'))).toBe(false);
  });

  it('still builds adapters when the configured isolation cannot be constructed', () => {
    const repo = tmp();
    const config = defaultConfig('autonomous');
    // 'none' is refused for an unattended run unless allowed: construction throws and the adapters are built without isolation.
    config.isolation = { provider: 'none', allow_unisolated: false, container: null };
    const deps = defaultControllerDeps({ repoRoot: repo, db: openDb(':memory:'), config, orbitHome: join(repo, 'h'), env: { PATH: '/bin' } });
    expect(Object.keys(deps.adapters).length).toBeGreaterThan(0);
  });

  it('opens the repository state database and loads the live config when none are passed', () => {
    const repo = tmp();
    mkdirSync(join(repo, '.orbit'), { recursive: true });
    const config = defaultConfig('autonomous');
    config.checks = { unit: { ...defaultCheck('unit'), command: ['node', '-e', '0'] } };
    config.isolation = { provider: 'none', allow_unisolated: true, container: null };
    const path = join(repo, '.orbit', 'config.json');
    writeFileSync(path, JSON.stringify(config));
    const loaded = loadConfig(repo, path);
    expect(loaded.checks.unit).toBeDefined();
    const deps = defaultControllerDeps({ repoRoot: repo, config: loaded, orbitHome: join(repo, 'h'), env: { PATH: '/bin' }, adapters: {} });
    expect(existsSync(stateDbPath(repo))).toBe(true);
    deps.db.close();
  });

  it('writes its default logger under the orbit home', () => {
    const repo = tmp();
    const home = join(repo, 'home');
    const deps = defaultControllerDeps({ repoRoot: repo, db: openDb(':memory:'), config: defaultConfig('autonomous'), adapters: {}, orbitHome: home, env: {} });
    deps.logger?.info('hello');
    expect(existsSync(join(home, 'logs', 'controller.jsonl'))).toBe(true);
  });

  it('refuses a repository that does not exist', () => {
    expect(() => defaultControllerDeps({ repoRoot: join(tmp(), 'nope'), db: openDb(':memory:'), config: defaultConfig('autonomous'), adapters: {} })).toThrow();
  });
});
