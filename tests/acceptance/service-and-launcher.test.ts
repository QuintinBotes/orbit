/**
 * Issue #166, FR-002: the background service, the stable launcher and the shared state database, as the first
 * outside runs met them (issues #131, #143 and #154). The service manager is never the real one: a stand-in records
 * what would have been run, and the definition and the launcher it wrote are read back as launchd, systemd or `sh`
 * would read them.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launcherPath, readLauncher, writeLauncher, type CommandRunner } from '../../src/controller/service.ts';
import { stateDbPath } from '../../src/controller/start.ts';
import { openDb } from '../../src/storage/db.ts';
import { MIGRATIONS } from '../../src/storage/schema.ts';
import { makeLab as makeCliLab, type Lab as CliLab } from '../unit/cli/lab.ts';
import { makeLab, orbitOnce, READY, type Lab } from './helpers/lab.ts';

const labs: { close(): void }[] = [];
const dirs: string[] = [];
afterEach(() => {
  labs.splice(0).forEach((l) => l.close());
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function cliLab(): CliLab {
  const l = makeCliLab();
  labs.push(l);
  mkdirSync(join(l.repo, '.orbit'), { recursive: true });
  writeFileSync(join(l.repo, '.orbit', 'config.yaml'), ['version: 1', 'mode: autonomous', 'isolation: {provider: none, allow_unisolated: true}', ''].join('\n'));
  return l;
}
function lab(): Lab {
  const l = makeLab();
  labs.push(l);
  return l;
}

/** A service manager that records what would have been run and answers as one that loaded the job. */
function manager(): CommandRunner {
  const calls: string[][] = [];
  return async (argv) => {
    calls.push(argv);
    const loaded = calls.some((c) => c[1] === 'bootstrap' || (c[0] === 'systemctl' && c.includes('enable')));
    return { exitCode: argv.includes('print') ? (loaded ? 0 : 113) : 0, stdout: argv.includes('is-active') ? (loaded ? 'active\n' : 'inactive\n') : '', stderr: '' };
  };
}

/** The environment a service definition gives its process: launchd's EnvironmentVariables or systemd's Environment= lines. */
function definitionEnv(text: string, platform: 'darwin' | 'linux'): Record<string, string> {
  const pairs = platform === 'darwin' ? [...text.matchAll(/<key>([A-Z_]+)<\/key><string>([^<]*)<\/string>/g)].map((m) => [m[1]!, m[2]!]) : [...text.matchAll(/^Environment="([A-Z_]+)=(.*)"$/gm)].map((m) => [m[1]!, m[2]!]);
  return Object.fromEntries(pairs) as Record<string, string>;
}

/** A stand-in bundle that says which version ran and with what arguments. */
function bundle(dir: string, version: string): string {
  const entry = join(dir, 'dist', 'orbit.mjs');
  mkdirSync(join(entry, '..'), { recursive: true });
  writeFileSync(entry, `console.log(JSON.stringify({ version: ${JSON.stringify(version)}, args: process.argv.slice(2) }));\n`);
  return entry;
}

describe.skipIf(!READY)('acceptance: the service, the launcher and the state database (issue #166, FR-002)', () => {
  it.each(['darwin', 'linux'] as const)('issue #131: a service installed from a session with its own provider config folders finds the same logins (%s)', async (platform) => {
    // Given a session whose Claude and Codex logins live in config folders of their own, and an exported credential.
    const l = cliLab();
    const entry = bundle(join(l.base, 'plugin'), '0.0.0');
    const session = { PATH: '/usr/bin:/bin', HOME: l.home, ORBIT_HOME: l.orbitHome, CLAUDE_CONFIG_DIR: join(l.home, 'claude-config-acme'), CODEX_HOME: join(l.home, 'codex-home-acme'), ANTHROPIC_API_KEY: 'sk-ant-api03-synthetic0123456789abcdefghijklmnop', CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-oauth-token' };

    // When the service is installed from that session.
    const r = await l.cli(['service', 'install', '--entry', entry], { platform, uid: 501, seams: { serviceRunner: manager() }, env: session });
    expect(r.code, r.err).toBe(0);

    // Then the process the service manager starts looks for the logins where the session did, and the definition
    // carries locations only: no credential is written into it.
    const definition = readFileSync(/^definition: (.+)$/m.exec(r.out)![1]!, 'utf8');
    expect(definitionEnv(definition, platform)).toMatchObject({ CLAUDE_CONFIG_DIR: session.CLAUDE_CONFIG_DIR, CODEX_HOME: session.CODEX_HOME, ORBIT_HOME: l.orbitHome });
    expect(definition).not.toMatch(/ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|sk-ant-api03|synthetic-oauth-token/);
    // The install says which locations it carried, by name.
    expect(r.out).toContain('location variables: CLAUDE_CONFIG_DIR, CODEX_HOME');
    expect(r.out).not.toContain(session.CLAUDE_CONFIG_DIR);
  });

  it('issue #143: a newer Orbit does not migrate the state database under a controller that still holds a run lease', async () => {
    // Given a state database one schema version behind, with a run an older controller still drives.
    const l = lab();
    const path = stateDbPath(l.repo);
    const older = MIGRATIONS.slice(0, MIGRATIONS.length - 1);
    const now = Date.now();
    const old = openDb(path, { migrations: older });
    old.run('INSERT INTO runs (id, repo_root, goal, mode, state, policy_hash, policy_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', 'orb-older-run', l.repo, 'a goal', 'autonomous', 'IMPLEMENTING', 'sha256:x', join(l.repo, '.orbit', 'runs', 'orb-older-run', 'policy.json'), now, now);
    old.run('INSERT INTO leases (run_id, owner_id, acquired_at, heartbeat_at, expires_at) VALUES (?, ?, ?, ?, ?)', 'orb-older-run', 'ctl-older-orbit', now, now, now + 10 * 60_000);
    old.close();
    const version = (): number => {
      const db = openDb(path, { migrations: older });
      try {
        return (db.get('PRAGMA user_version') as { user_version: number }).user_version;
      } finally {
        db.close();
      }
    };
    expect(version()).toBe(older.length);

    // When this Orbit runs a command against that repository.
    const refused = await orbitOnce(l, ['status', '--json']);

    // Then it refuses, names the run and its owner and the ways forward, and leaves the database as the older controller reads it.
    expect(refused.code, refused.out).not.toBe(0);
    expect(refused.out).toContain('Cannot migrate the state database while an older Orbit is driving these runs: orb-older-run (owner ctl-older-orbit)');
    expect(refused.out).toContain('Let the runs finish, stop them, or use that same Orbit version until their leases end.');
    expect(version()).toBe(older.length);

    // Once the lease has ended the same command migrates and answers.
    const release = openDb(path, { migrations: older });
    release.run('UPDATE leases SET expires_at = ? WHERE run_id = ?', Date.now() - 1, 'orb-older-run');
    release.close();
    const ok = await orbitOnce(l, ['status', '--json']);
    expect(ok.code, ok.out).toBe(0);
    expect(ok.out).toContain('orb-older-run');
    const migrated = openDb(path);
    try {
      expect((migrated.get('PRAGMA user_version') as { user_version: number }).user_version).toBe(MIGRATIONS.length);
    } finally {
      migrated.close();
    }
  }, 120_000);

  it('issue #154: a development build does not take over the launcher, and a launcher whose entry is gone runs the newest installed plugin and says so', async () => {
    // Given the launcher of an installed plugin, in the plugin cache.
    const l = cliLab();
    const cache = join(l.home, 'plugins', 'cache', 'marketplace', 'orbit');
    const installed = bundle(join(cache, '0.0.1'), '0.0.1');
    const launcher = writeLauncher(l.orbitHome, { node: process.execPath, entry: installed, version: '0.0.1' });
    expect(launcher).toBe(launcherPath(l.orbitHome));

    // When a newer development build in a temporary worktree runs an orbit command.
    const development = bundle(join(l.base, 'orbit', '.claude', 'worktrees', 'land-108', 'plugin'), 'development');
    const status = await l.cli(['status', '--json'], { platform: 'darwin', uid: 501, entry: development, homeDir: l.home, seams: { serviceRunner: manager() } });
    expect(status.code, status.err).toBe(0);

    // Then the launcher still starts the installed plugin, so removing the worktree breaks nothing.
    expect(readLauncher(launcher)).toMatchObject({ entry: installed, cacheDir: cache });
    rmSync(join(l.base, 'orbit'), { recursive: true, force: true });
    const viaLauncher = spawnSync('sh', [launcher, 'status'], { encoding: 'utf8' });
    expect(viaLauncher.status, viaLauncher.stderr).toBe(0);
    expect(JSON.parse(viaLauncher.stdout)).toEqual({ version: '0.0.1', args: ['status'] });

    // And when the launcher's own entry is gone (the plugin was updated, its old version removed), the launcher runs
    // the newest version in the cache and names the build it used, instead of failing with MODULE_NOT_FOUND.
    const newest = bundle(join(cache, '0.10.0'), '0.10.0');
    bundle(join(cache, '0.9.9'), '0.9.9');
    rmSync(join(cache, '0.0.1'), { recursive: true, force: true });
    const fallback = spawnSync('sh', [launcher, 'status', '--json'], { encoding: 'utf8' });
    expect(fallback.status, fallback.stderr).toBe(0);
    expect(JSON.parse(fallback.stdout)).toEqual({ version: '0.10.0', args: ['status', '--json'] });
    expect(fallback.stderr).toContain(newest);
    expect(fallback.stderr).not.toContain('MODULE_NOT_FOUND');

    // With nothing to fall back to, the failure names the missing entry and the fix.
    const lone = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-acc-launcher-')));
    dirs.push(lone);
    const gone = bundle(join(lone, 'worktree', 'plugin'), 'development');
    const orphan = writeLauncher(join(lone, '.orbit'), { node: process.execPath, entry: gone });
    rmSync(gone);
    const failed = spawnSync('sh', [orphan, 'status'], { encoding: 'utf8' });
    expect(failed.status).not.toBe(0);
    expect(failed.stdout).toBe('');
    expect(failed.stderr).toContain(gone);
    expect(failed.stderr).toMatch(/orbit service install|bin\/orbit/);
  }, 120_000);
});
