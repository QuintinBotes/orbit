import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NPM_REGISTRY_HOSTS, planInstall } from '../../../src/evidence/baseline.ts';
import { profileForCheck } from '../../../src/isolation/profiles.ts';
import { checkConfigHash } from '../../../src/policy/snapshot.ts';
import { fakeSnapshot } from './report-fixtures.ts';
import { tempRoot } from './fixtures.ts';

const roots: ReturnType<typeof tempRoot>[] = [];
afterEach(() => roots.splice(0).forEach((r) => r.remove()));

function project(files: string[]): string {
  const t = tempRoot();
  roots.push(t);
  for (const f of files) {
    mkdirSync(join(t.root, f, '..'), { recursive: true });
    writeFileSync(join(t.root, f), '{}');
  }
  return t.root;
}

const snap = (deps: Partial<ReturnType<typeof fakeSnapshot>['config']['dependencies']> = {}) =>
  fakeSnapshot([], (c) => {
    Object.assign(c.dependencies, deps);
  });

describe('planInstall', () => {
  it('skips, saying why, when policy forbids installing', () => {
    expect(planInstall(snap({ install_existing_lockfile: false }), project(['package-lock.json']))).toEqual({ skip: true, reason: expect.stringContaining('does not allow') });
  });

  it('never creates a lockfile and points at install_command for lockfiles it does not drive', () => {
    expect(planInstall(snap(), project(['package.json']))).toEqual({ skip: true, reason: expect.stringContaining('no lockfile') });
    expect(planInstall(snap(), project(['pnpm-lock.yaml']))).toEqual({ skip: true, reason: expect.stringContaining('dependencies.install_command') });
  });

  it('uses npm ci --ignore-scripts by default and plain npm ci only when scripts are allowed', () => {
    const dir = project(['package-lock.json']);
    const cmd = (p: ReturnType<typeof planInstall>) => (p.skip ? null : p.definitions.map((d) => d.command));
    expect(cmd(planInstall(snap({ install_scripts: 'deny' }), dir))).toEqual([['npm', 'ci', '--ignore-scripts']]);
    expect(cmd(planInstall(snap({ install_scripts: 'deny-unless-allowlisted' }), dir))).toEqual([['npm', 'ci', '--ignore-scripts']]);
    expect(cmd(planInstall(snap({ install_scripts: 'allow' }), dir))).toEqual([['npm', 'ci']]);
    expect(cmd(planInstall(snap(), project(['npm-shrinkwrap.json'])))).toEqual([['npm', 'ci', '--ignore-scripts']]);
  });

  it('rebuilds only allowlisted packages after the script-free install', () => {
    const plan = planInstall(snap({ install_scripts: 'deny-unless-allowlisted', install_script_allowlist: ['esbuild', 'sharp'] }), project(['package-lock.json']));
    expect(plan.skip).toBe(false);
    if (plan.skip) return;
    expect(plan.definitions.map((d) => d.command)).toEqual([['npm', 'ci', '--ignore-scripts'], ['npm', 'rebuild', 'esbuild', 'sharp']]);
    // An allowlist under 'deny' is ignored: deny means deny.
    const denied = planInstall(snap({ install_scripts: 'deny', install_script_allowlist: ['esbuild'] }), project(['package-lock.json']));
    expect(denied.skip ? [] : denied.definitions).toHaveLength(1);
  });

  it('honours a configured install command, denying scripts through the environment', () => {
    const plan = planInstall(snap({ install_command: ['pnpm', 'install', '--frozen-lockfile'] }), project([]));
    expect(plan.skip).toBe(false);
    if (plan.skip) return;
    expect(plan.definitions[0]).toMatchObject({ command: ['pnpm', 'install', '--frozen-lockfile'], env: expect.objectContaining({ npm_config_ignore_scripts: 'true', YARN_ENABLE_SCRIPTS: 'false' }) });
    const allowed = planInstall(snap({ install_command: ['pnpm', 'install'], install_scripts: 'allow' }), project([]));
    expect(allowed.skip ? {} : allowed.definitions[0]!.env).not.toHaveProperty('npm_config_ignore_scripts');
  });

  it('gives the install registry network only, never the policy hosts, and is not a mandatory check', () => {
    const dir = project(['package-lock.json']);
    const snapshot = snap();
    expect(snapshot.config.network.allowed_hosts).toContain('github.com');
    const plan = planInstall(snapshot, dir);
    if (plan.skip) throw new Error('unexpected skip');
    const def = plan.definitions[0]!;
    expect(def.network_hosts).toEqual([...NPM_REGISTRY_HOSTS]);
    expect(def.mandatory).toBe(false);
    expect(def.shell).toBe(false);
    const profile = profileForCheck({ worktree: dir, check: def, snapshot, homeDir: dir });
    expect(profile.allowedHosts).toEqual(['registry.npmjs.org']);
    expect(planInstall(snapshot, dir, { registryHosts: ['npm.internal.acme.test'] }).skip).toBe(false);
    const custom = planInstall(snapshot, dir, { registryHosts: ['npm.internal.acme.test'] });
    expect(custom.skip ? [] : custom.definitions[0]!.network_hosts).toEqual(['npm.internal.acme.test']);
  });

  it('lets a configured install command reach the registries of the toolchains it serves, and nothing else (ADR 0009)', () => {
    const rust = planInstall(snap({ install_command: ['cargo', 'fetch', '--locked'] }), project(['Cargo.toml', 'Cargo.lock']));
    expect(rust.skip ? [] : rust.definitions[0]!.network_hosts).toEqual(['registry.npmjs.org', 'index.crates.io', 'static.crates.io']);
    // Detected from the command as well as from the repository.
    const go = planInstall(snap({ install_command: ['go', 'mod', 'download'] }), project([]));
    expect(go.skip ? [] : go.definitions[0]!.network_hosts).toEqual(['registry.npmjs.org', 'proxy.golang.org', 'sum.golang.org']);
    const plain = planInstall(snap({ install_command: ['make', 'deps'] }), project([]));
    expect(plain.skip ? [] : plain.definitions[0]!.network_hosts).toEqual(['registry.npmjs.org']);
    // npm's own install needs no other registry.
    const npm = planInstall(snap(), project(['package-lock.json', 'go.mod']));
    expect(npm.skip ? [] : npm.definitions[0]!.network_hosts).toEqual(['registry.npmjs.org']);
  });

  it('produces stable definitions, so their configuration hash is reproducible', () => {
    const dir = project(['package-lock.json']);
    const a = planInstall(snap(), dir);
    const b = planInstall(snap(), dir);
    expect(a.skip ? '' : checkConfigHash(a.definitions[0]!)).toBe(b.skip ? ' ' : checkConfigHash(b.definitions[0]!));
  });
});
