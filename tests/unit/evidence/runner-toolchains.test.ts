// A check's toolchain profile (docs/decisions/0009-toolchain-profiles.md): what the runner hands the isolation provider
// and the check for a detected toolchain, and that the check's own env still wins.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { planInstall } from '../../../src/evidence/baseline.ts';
import { candidateSubject, checkEnv, checkToolchains, INSTALL_CHECK_ID, runCheckSet, runChecks } from '../../../src/evidence/runner.ts';
import { NUGET_AUDIT_LIMITATION, toolchainCacheRoot } from '../../../src/isolation/toolchains.ts';
import type { CheckDefinition } from '../../../src/policy/types.ts';
import { checkDef, nodeCheck } from './fixtures.ts';
import { checkDirOf, recordingIsolation, runnerEnv, type RunnerEnv } from '../../integration/evidence/harness.ts';

const envs: RunnerEnv[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const e of envs.splice(0)) await e.close();
});

const GO_REPO = { 'go.mod': 'module acme\n\ngo 1.22\n', 'README.md': 'acme\n' };
const PRINT_ENV = `const k=["GOMODCACHE","GOCACHE","GOPATH","CARGO_HOME","DOTNET_CLI_HOME","HOME"];console.log("ENV="+JSON.stringify(Object.fromEntries(k.map(x=>[x,process.env[x]??null]))))`;

function printed(logPath: string): Record<string, string | null> {
  const line = readFileSync(logPath, 'utf8').split('\n').find((l) => l.startsWith('ENV='));
  if (!line) throw new Error('the check printed no environment');
  return JSON.parse(line.slice(4)) as Record<string, string | null>;
}

async function goEnv(checks = [nodeCheck('unit', PRINT_ENV)]) {
  const isolation = recordingIsolation();
  const e = await runnerEnv(checks, { isolation, files: GO_REPO });
  envs.push(e);
  const cacheRoot = toolchainCacheRoot(join(e.t.root, 'orbit-home'), 'abcdefabcdef');
  return { e, isolation, cacheRoot, ctx: { ...e.ctx, toolchainCacheRoot: cacheRoot } };
}

describe('the runner and toolchain profiles', () => {
  // Review: Orbit turned NuGet's vulnerability audit off (NuGetAudit=false), which a run's evidence did not say: a
  // repository whose CI fails a restore on a vulnerable package passes it under Orbit. The record says so exactly when
  // Orbit turned it off, which is only where the audit cannot run (without the package source in the check's network,
  // or on macOS under srt). A container runs Linux, whatever the host.
  it('records on a .NET check that NuGet\'s vulnerability audit was off exactly when Orbit turned it off', async () => {
    const DOTNET = { 'acme.csproj': '<Project Sdk="Microsoft.NET.Sdk" />\n' };
    const run = async (over: { env?: Record<string, string>; hosts?: string[]; files?: Record<string, string>; kind?: 'none' | 'container' } = {}) => {
      const check = { ...nodeCheck('unit', 'console.log(`NuGetAudit=${process.env.NuGetAudit ?? "unset"}`)'), env: over.env ?? {}, network_hosts: over.hosts ?? [] };
      const isolation = { ...recordingIsolation(), kind: over.kind ?? 'none' } as ReturnType<typeof recordingIsolation>;
      const e = await runnerEnv([check], { isolation, files: over.files ?? DOTNET });
      envs.push(e);
      const [r] = await runChecks({ ...e.ctx, candidate: e.candidate, checkIds: ['unit'] });
      return { limited: r!.isolationLimitations.includes(NUGET_AUDIT_LIMITATION), audit: /NuGetAudit=(\S+)/.exec(readFileSync(r!.logPath, 'utf8'))?.[1] };
    };
    // No host: off on every platform, and the record says so.
    expect(await run()).toEqual({ limited: true, audit: 'false' });
    expect(await run({ kind: 'container' })).toEqual({ limited: true, audit: 'false' });
    // The check's own env wins, and a check that is not .NET's gets nothing.
    expect(await run({ env: { NuGetAudit: 'true' } })).toEqual({ limited: false, audit: 'true' });
    expect(await run({ files: GO_REPO })).toEqual({ limited: false, audit: 'unset' });
    // The host in the check's network: as configured on Linux (a container here), off under an OS sandbox on macOS.
    expect(await run({ hosts: ['api.nuget.org'], kind: 'container' })).toEqual({ limited: false, audit: 'unset' });
    // There a check that turns the audit off itself is the repository's choice, not Orbit's: no limitation.
    expect(await run({ hosts: ['api.nuget.org'], kind: 'container', env: { NuGetAudit: 'false' } })).toEqual({ limited: false, audit: 'false' });
    expect(await run({ hosts: ['api.nuget.org'] })).toEqual(process.platform === 'darwin' ? { limited: true, audit: 'false' } : { limited: false, audit: 'unset' });
    expect(NUGET_AUDIT_LIMITATION).not.toMatch(/[\u2013\u2014]/);
  });

  it('decides NuGet\'s audit from the check\'s own network and the platform it runs on, for a check and the install step', async () => {
    const { e } = await goEnv([]);
    const audit = (def: CheckDefinition, kind: 'sandbox-runtime' | 'container', platform: NodeJS.Platform) =>
      checkToolchains({ ...e.ctx, isolation: { ...e.ctx.isolation, kind } as typeof e.ctx.isolation }, def, e.checkoutDir, { toolchainsDir: '/s' }, '/t', platform).env.NuGetAudit;
    const build = (hosts: string[]) => checkDef('build', { command: ['dotnet', 'build', '-m:1'], network_hosts: hosts });
    expect(audit(build([]), 'sandbox-runtime', 'linux')).toBe('false');
    expect(audit(build(['api.nuget.org']), 'sandbox-runtime', 'linux')).toBeUndefined();
    expect(audit(build(['api.nuget.org']), 'sandbox-runtime', 'darwin')).toBe('false');
    // A container is Linux whatever the host is.
    expect(audit(build(['api.nuget.org']), 'container', 'darwin')).toBeUndefined();
    expect(audit(build([]), 'container', 'darwin')).toBe('false');
    // Orbit's own install step gets the registries its command and the checkout name: as configured on Linux.
    const config = e.ctx.snapshot.config;
    const plan = planInstall({ ...e.ctx.snapshot, config: { ...config, dependencies: { ...config.dependencies, install_command: ['dotnet', 'restore', '-m:1'] } } }, e.checkoutDir);
    if (plan.skip) throw new Error(plan.reason);
    const install = plan.definitions[0]!;
    expect(install.network_hosts).toContain('api.nuget.org');
    expect(audit(install, 'sandbox-runtime', 'linux')).toBeUndefined();
    expect(audit(install, 'sandbox-runtime', 'darwin')).toBe('false');
    // The platform is the host's unless the runner is told another.
    expect(checkToolchains(e.ctx, install, e.checkoutDir, { toolchainsDir: '/s' }, '/t').env.NuGetAudit).toBe(process.platform === 'darwin' ? 'false' : undefined);
  });

  it('points a check in a Go repository at the repository\'s module cache, read-only, and at private per-attempt build state', async () => {
    const { e, isolation, cacheRoot, ctx } = await goEnv();
    const [r] = await runChecks({ ...ctx, candidate: e.candidate, checkIds: ['unit'] });
    expect(r!.status).toBe('PASSED');
    const env = printed(r!.logPath);
    const scratch = join(checkDirOf(e, 'unit'), 'toolchains');
    expect(env).toMatchObject({ GOMODCACHE: join(cacheRoot, 'gomod'), GOCACHE: join(scratch, 'gocache'), GOPATH: join(scratch, 'gopath'), CARGO_HOME: null });
    const [profile] = isolation.profiles as (typeof isolation.profiles[number] & { readablePaths: string[] })[];
    expect(profile!.writablePaths).toContain(scratch);
    expect(profile!.writablePaths).not.toContain(join(cacheRoot, 'gomod'));
    expect(profile!.readablePaths).toContain(join(cacheRoot, 'gomod'));
    // The cache stays (empty: nothing wrote it); the attempt's build state goes with its home and temp directory.
    expect(existsSync(join(cacheRoot, 'gomod'))).toBe(true);
    expect(existsSync(scratch)).toBe(false);
  });

  it('lets only Orbit\'s generated install step write the caches', async () => {
    const { e, isolation, cacheRoot, ctx } = await goEnv([nodeCheck(INSTALL_CHECK_ID, PRINT_ENV)]);
    // A policy check that merely carries the install step's id gets no write access.
    await runChecks({ ...ctx, candidate: e.candidate, checkIds: [INSTALL_CHECK_ID] });
    expect(isolation.profiles[0]!.writablePaths).not.toContain(join(cacheRoot, 'gomod'));

    const other = await goEnv([]);
    const install = nodeCheck(INSTALL_CHECK_ID, PRINT_ENV);
    const subject = { ...candidateSubject(other.e.ctx.runDir, other.e.candidate), source: 'install' as const };
    const [r] = await runCheckSet({ ...other.ctx, definitions: { [INSTALL_CHECK_ID]: install } }, subject, [install]);
    expect(r!.status).toBe('PASSED');
    expect(other.isolation.profiles[0]!.writablePaths).toContain(join(other.cacheRoot, 'gomod'));
    expect(printed(r!.logPath).GOMODCACHE).toBe(join(other.cacheRoot, 'gomod'));
  });

  it('lets the check\'s own env override every toolchain variable', async () => {
    const { e, ctx } = await goEnv([nodeCheck('unit', PRINT_ENV, { env: { GOCACHE: '/acme/gocache', GOMODCACHE: '/acme/mod' } })]);
    const [r] = await runChecks({ ...ctx, candidate: e.candidate, checkIds: ['unit'] });
    expect(printed(r!.logPath)).toMatchObject({ GOCACHE: '/acme/gocache', GOMODCACHE: '/acme/mod' });
    expect(checkEnv(checkDef('x', { env: { CARGO_TARGET_DIR: 'target' } }), { homeDir: '/h', tmpDir: '/t', artifactsDir: '/a' }, '/bin', { CARGO_TARGET_DIR: '/s/cargo-target', CARGO_HOME: '/c/cargo' })).toMatchObject({ CARGO_TARGET_DIR: 'target', CARGO_HOME: '/c/cargo' });
    // A toolchain variable never replaces what the runner itself fixes.
    expect(checkEnv(checkDef('x'), { homeDir: '/h', tmpDir: '/t', artifactsDir: '/a' }, '/bin', { HOME: '/elsewhere', ORBIT_CHECK_ID: 'y' })).toMatchObject({ HOME: '/h', ORBIT_CHECK_ID: 'x' });
  });

  it('without a cache root, keeps the caches in the attempt\'s scratch, and removes scratch a tool made read-only', async () => {
    const isolation = recordingIsolation();
    const script = `const fs=require("fs"),p=require("path");const d=p.join(process.env.GOMODCACHE,"acme@v1");fs.mkdirSync(d,{recursive:true});fs.writeFileSync(p.join(d,"x.go"),"");fs.chmodSync(p.join(d,"x.go"),0o444);fs.chmodSync(d,0o555);${PRINT_ENV}`;
    const e = await runnerEnv([nodeCheck('unit', script)], { isolation, files: GO_REPO });
    envs.push(e);
    const [r] = await runChecks({ ...e.ctx, candidate: e.candidate, checkIds: ['unit'] });
    expect(r!.status).toBe('PASSED');
    const scratch = join(checkDirOf(e, 'unit'), 'toolchains');
    expect(printed(r!.logPath).GOMODCACHE).toBe(join(scratch, 'cache', 'gomod'));
    expect(existsSync(scratch)).toBe(false);
  });

  it('points rustup at the host installation in an OS sandbox, never in a container, which brings its own', async () => {
    const { e } = await goEnv([]);
    const home = join(e.t.root, 'acme-home');
    mkdirSync(join(home, '.rustup'), { recursive: true });
    const def = checkDef('unit', { command: ['cargo', 'test'] });
    const ctx = (kind: 'sandbox-runtime' | 'container') => ({ ...e.ctx, homeDir: home, isolation: { ...e.ctx.isolation, kind } as typeof e.ctx.isolation });
    const sandboxed = checkToolchains(ctx('sandbox-runtime'), def, e.checkoutDir, { toolchainsDir: '/s' }, '/t');
    if (process.env.RUSTUP_HOME === undefined) expect(sandboxed.env.RUSTUP_HOME).toBe(join(home, '.rustup'));
    expect(checkToolchains(ctx('container'), def, e.checkoutDir, { toolchainsDir: '/s' }, '/t').env).not.toHaveProperty('RUSTUP_HOME');
  });

  it('points a JVM check at the host\'s JAVA_HOME in an OS sandbox, never in a container, which brings its own JDK', async () => {
    const { e } = await goEnv([]);
    vi.stubEnv('JAVA_HOME', '/opt/acme-jdk');
    const def = checkDef('unit', { command: ['java', 'Acme.java'] });
    const ctx = (kind: 'sandbox-runtime' | 'container') => ({ ...e.ctx, isolation: { ...e.ctx.isolation, kind } as typeof e.ctx.isolation });
    expect(checkToolchains(ctx('sandbox-runtime'), def, e.checkoutDir, { toolchainsDir: '/s' }, '/t').env.JAVA_HOME).toBe('/opt/acme-jdk');
    expect(checkToolchains(ctx('container'), def, e.checkoutDir, { toolchainsDir: '/s' }, '/t').env).not.toHaveProperty('JAVA_HOME');
  });

  // .NET's CookieContainer reads the NIS domain name, which srt's Seatbelt profile does not allow, so every .NET HTTP
  // client failed under srt on macOS, NuGet's restore in the install step included (ADR 0009, addendum).
  it('lets a check and the install step of a .NET repository read the NIS domain name, and no other check', async () => {
    const isolation = recordingIsolation();
    const e = await runnerEnv([nodeCheck('unit', PRINT_ENV)], { isolation, files: { 'acme.sln': '', 'README.md': 'acme\n' } });
    envs.push(e);
    await runChecks({ ...e.ctx, candidate: e.candidate, checkIds: ['unit'] });
    const install = nodeCheck(INSTALL_CHECK_ID, PRINT_ENV);
    const subject = { ...candidateSubject(e.ctx.runDir, e.candidate), source: 'install' as const };
    await runCheckSet({ ...e.ctx, definitions: { [INSTALL_CHECK_ID]: install } }, subject, [install]);
    expect(isolation.profiles.map((p) => p.nisDomainName)).toEqual([true, true]);
    const go = await goEnv();
    await runChecks({ ...go.ctx, candidate: go.e.candidate, checkIds: ['unit'] });
    expect(go.isolation.profiles[0]!.nisDomainName).toBeFalsy();
  });

  it('sets nothing for a toolchain the check and repository do not use', async () => {
    const isolation = recordingIsolation();
    const e = await runnerEnv([nodeCheck('unit', PRINT_ENV)], { isolation });
    envs.push(e);
    const [r] = await runChecks({ ...e.ctx, toolchainCacheRoot: join(e.t.root, 'orbit-home', 'toolchains', 'k'), candidate: e.candidate, checkIds: ['unit'] });
    expect(printed(r!.logPath)).toMatchObject({ GOMODCACHE: null, GOCACHE: null, CARGO_HOME: null });
    // The .NET first-run settings stay on every check (#10).
    expect(printed(r!.logPath).DOTNET_CLI_HOME).toBe(printed(r!.logPath).HOME);
    expect(existsSync(join(e.t.root, 'orbit-home'))).toBe(false);
  });
});
