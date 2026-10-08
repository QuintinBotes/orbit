import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { dotnetAuditCheck, dotnetPackagesCheck } from '../../../src/cli/commands/doctor-dotnet.ts';
import { environmentFix } from '../../../src/controller/environment-block.ts';
import { classifyCouldNotRun } from '../../../src/evidence/environment-failure.ts';
import { planInstall } from '../../../src/evidence/baseline.ts';
import { candidateSubject, runCheckSet, runChecks } from '../../../src/evidence/runner.ts';
import { SandboxRuntimeIsolation } from '../../../src/isolation/sandbox-runtime.ts';
import { NUGET_AUDIT_LIMITATION, toolchainCacheRoot } from '../../../src/isolation/toolchains.ts';
import { which } from '../../../src/isolation/util.ts';
import type { CheckDefinition } from '../../../src/policy/types.ts';
import { repoKeyFor } from '../../../src/storage/retention.ts';
import { checkDef } from '../../unit/evidence/fixtures.ts';
import { runnerEnv, type RunnerEnv } from './harness.ts';

/**
 * .NET's HTTP clients under Orbit's real srt profile (docs/decisions/0009-toolchain-profiles.md, addendum). On macOS every
 * .NET HTTP request failed before reaching the network: SocketsHttpHandler builds a CookieContainer, whose type
 * initializer asks libc for the NIS domain name (sysctl kern.nisdomainname), which srt's Seatbelt profile does not let
 * it read ("The type initializer for 'System.Net.CookieContainer' threw an exception ... GetDomainName: -1"). NuGet's
 * restore failed that way (NU1301), and so did any test that makes an HTTP request. Orbit's preload adds one read-only
 * rule for that name to every sandbox that runs .NET. Past it, .NET's dual-stack IPv6 sockets connect to loopback as
 * ::ffff:127.0.0.1, which srt's Seatbelt loopback rule does not match on every macOS release (GitHub's runner denied
 * every request, srt's proxy included, with "Permission denied"; macOS 27 allows it), so .NET there opens IPv4 sockets
 * (DOTNET_SYSTEM_NET_DISABLEIPV6=1), which the loopback program reports.
 *
 * HTTPS needs more on macOS: .NET verifies a server certificate through the system trust service (trustd), which srt
 * keeps out of reach because sandboxed code could have it fetch from any host. So a NuGet restore from nuget.org
 * restores on Linux, and on macOS stops at "The SSL connection could not be established"; there the repository's NuGet
 * cache is filled outside the sandbox, after which the install step and the checks restore and build from it.
 *
 * Skipped where srt or dotnet is missing; the package tests need the network (api.nuget.org).
 */
const installDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const provider = new SandboxRuntimeIsolation({ orbitInstallDir: installDir });
const probe = await provider.available();
const dotnet = which('dotnet', process.env.PATH) ?? [join(homedir(), '.dotnet', 'dotnet')].find((p) => existsSync(p)) ?? null;
const skip = !probe.ok ? `srt unavailable: ${probe.detail}` : dotnet === null ? 'dotnet is not installed' : null;
const NOT_CONTAINER = /CookieContainer|GetDomainName/;

/** A console program that serves one HTTP response on loopback and fetches it with HttpClient: no network, no packages. */
const LOOPBACK = {
  'acme.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net$(NETCoreAppMaximumVersion)</TargetFramework><ImplicitUsings>enable</ImplicitUsings></PropertyGroup></Project>\n',
  'Program.cs': [
    'using System.Net;',
    'using System.Net.Sockets;',
    'var listener = new TcpListener(IPAddress.Loopback, 0);',
    'listener.Start();',
    'var port = ((IPEndPoint)listener.LocalEndpoint).Port;',
    'var server = Task.Run(async () => {',
    '  using var client = await listener.AcceptTcpClientAsync();',
    '  var stream = client.GetStream();',
    '  var buffer = new byte[4096];',
    '  await stream.ReadAsync(buffer);',
    '  var body = "acme 42";',
    '  await stream.WriteAsync(System.Text.Encoding.ASCII.GetBytes($"HTTP/1.1 200 OK\\r\\nContent-Length: {body.Length}\\r\\nConnection: close\\r\\n\\r\\n{body}"));',
    '});',
    'Console.WriteLine($"dual-stack sockets: {Socket.OSSupportsIPv6}");',
    'using var http = new HttpClient();',
    'Console.WriteLine($"fetched: {await http.GetStringAsync($"http://127.0.0.1:{port}/")}");',
    'await server;',
    '',
  ].join('\n'),
};

/** One small package with no dependencies of its own on current .NET. */
const PACKAGE = { id: 'Newtonsoft.Json', version: '13.0.3' };
const PROJECT = {
  'acme.csproj': `<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net$(NETCoreAppMaximumVersion)</TargetFramework></PropertyGroup>\n  <ItemGroup><PackageReference Include="${PACKAGE.id}" Version="${PACKAGE.version}" /></ItemGroup>\n</Project>\n`,
  'Program.cs': 'System.Console.WriteLine(Newtonsoft.Json.JsonConvert.SerializeObject(new { acme = 42 }));\n',
};

const envs: RunnerEnv[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(skip !== null)(skip === null ? '.NET HTTP clients under srt' : `.NET HTTP clients under srt skipped: ${skip}`, () => {
  it('lets a check\'s .NET program make an HTTP request (on loopback), which every one failed on macOS', async () => {
    const e = await runnerEnv([checkDef('http', { command: [`"${dotnet}" build -m:1 && "${dotnet}" run --no-build`], shell: true, timeout_seconds: 300 })], { isolation: provider, files: LOOPBACK });
    envs.push(e);
    const [r] = await runChecks({ ...e.ctx, candidate: e.candidate, checkIds: ['http'] });
    const log = readFileSync(r!.logPath, 'utf8');
    expect(log).not.toMatch(NOT_CONTAINER);
    // On macOS in IPv4, so its connect matches srt's loopback rule on every release, not only where the mapped form does.
    if (process.platform === 'darwin') expect(log).toContain('dual-stack sockets: False');
    expect(log).toContain('fetched: acme 42');
    expect(r).toMatchObject({ status: 'PASSED', isolation: 'sandbox-runtime' });
  }, 300_000);

  /** A repository with one package, its NuGet cache under the run's (denied) Orbit home, and the two checks that build it. */
  async function packaged(files: Readonly<Record<string, string>> = PROJECT, extra: CheckDefinition[] = []) {
    const checks = [checkDef('build', { command: [dotnet!, 'build', '--no-restore', '-m:1'], timeout_seconds: 300 }), checkDef('build-restoring', { command: [dotnet!, 'build', '-m:1'], timeout_seconds: 300 }), ...extra];
    const e = await runnerEnv(checks, { isolation: provider, files });
    envs.push(e);
    const cacheRoot = toolchainCacheRoot(join(e.ctx.homeDir!, '.orbit'), 'abcdefabcdef');
    return { e, cacheRoot, ctx: { ...e.ctx, toolchainCacheRoot: cacheRoot } };
  }

  /** Orbit's dependency install step as a run plans it, for `dependencies.install_command: [dotnet, restore, -m:1]`. */
  async function install(p: Awaited<ReturnType<typeof packaged>>, command: string[] = [dotnet!, 'restore', '-m:1']) {
    const config = p.e.ctx.snapshot.config;
    const plan = planInstall({ ...p.e.ctx.snapshot, config: { ...config, dependencies: { ...config.dependencies, install_command: command } } }, p.e.checkoutDir);
    if (plan.skip) throw new Error(`the install was not planned: ${plan.reason}`);
    const def: CheckDefinition = plan.definitions[0]!;
    expect(def.network_hosts).toContain('api.nuget.org');
    const subject = { ...candidateSubject(p.e.ctx.runDir, p.e.candidate), source: 'install' as const };
    const [r] = await runCheckSet({ ...p.ctx, definitions: { [def.id]: def } }, subject, [def]);
    return { r: r!, log: readFileSync(r!.logPath, 'utf8') };
  }

  /** The checks, with no network and the cache read-only: from the install's restore, and restoring again from the cache. */
  async function buildsFromCache(p: Awaited<ReturnType<typeof packaged>>, ids: string[]) {
    for (const id of ids) {
      const [r] = await runChecks({ ...p.ctx, candidate: p.e.candidate, checkIds: [id] });
      const log = readFileSync(r!.logPath, 'utf8');
      expect(log, id).not.toMatch(NOT_CONTAINER);
      expect(log, id).toMatch(/Build succeeded/);
      // A check has no network, so Orbit turns NuGet's vulnerability audit off there (NU1900), and its record says so.
      expect(log, id).not.toMatch(/NU1900/);
      expect(r!.isolationLimitations, id).toContain(NUGET_AUDIT_LIMITATION);
      expect(r, id).toMatchObject({ status: 'PASSED', isolation: 'sandbox-runtime' });
    }
  }

  /** As the person does on macOS (doctor's checks.dotnet-packages): the repository's NuGet cache filled outside the sandbox, with the network. */
  function fillOutside(p: Awaited<ReturnType<typeof packaged>>, files: Readonly<Record<string, string>>) {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-nuget-fill-')));
    dirs.push(outside);
    for (const [rel, text] of Object.entries(files)) writeFileSync(join(outside, rel), text);
    execFileSync(dotnet!, ['restore', '-m:1'], { cwd: outside, stdio: 'pipe', timeout: 300_000, env: { ...process.env, NUGET_PACKAGES: join(p.cacheRoot, 'nuget'), DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' } });
    expect(readdirSync(join(p.cacheRoot, 'nuget'))).toContain(PACKAGE.id.toLowerCase());
  }

  // A repository that treats warnings as errors (#10): NuGet's vulnerability audit cannot reach nuget.org from a check
  // (on macOS from no process in the sandbox), and its warning NU1900 was then "error NU1900: Warning As Error", so the
  // install step and every restoring check failed after the cache was filled, and the base revision's failure became a
  // baseline exception question. Orbit turns the audit off only there: the install on Linux reaches nuget.org and
  // audits as the repository configures it (this package has no known vulnerability), as the repository's CI does.
  it('restores and builds a project that treats warnings as errors: the vulnerability audit is off where it cannot reach nuget.org, and runs where it can', async () => {
    const strict = { ...PROJECT, 'acme.csproj': PROJECT['acme.csproj'].replace('</TargetFramework>', '</TargetFramework><TreatWarningsAsErrors>true</TreatWarningsAsErrors>') };
    const p = await packaged(strict);
    if (process.platform === 'darwin') fillOutside(p, strict);
    const i = await install(p);
    expect(i.log).not.toMatch(/NU1900/);
    expect(i.r.status, i.log).toBe('PASSED');
    expect(i.r.isolationLimitations.includes(NUGET_AUDIT_LIMITATION)).toBe(process.platform === 'darwin');
    await buildsFromCache(p, ['build', 'build-restoring']);
  }, 600_000);

  // The one setting Orbit's NuGetAudit=false (an environment variable, in every .NET process on macOS) does not
  // override: the repository's own NuGetAudit. With warnings as errors, NU1900 fails the install again; doctor's
  // checks.dotnet-audit says so before a run, and the form its fix names lets Orbit's setting through.
  it.skipIf(process.platform !== 'darwin')('on macOS follows doctor\'s checks.dotnet-audit: a project\'s own NuGetAudit fails the install on NU1900, and the form doctor names passes', async () => {
    const strict = { ...PROJECT, 'acme.csproj': PROJECT['acme.csproj'].replace('</TargetFramework>', '</TargetFramework><TreatWarningsAsErrors>true</TreatWarningsAsErrors>') };
    const withAudit = (property: string) => ({ ...strict, 'Directory.Build.props': `<Project><PropertyGroup>${property}</PropertyGroup></Project>\n` });
    const doctor = (p: Awaited<ReturnType<typeof packaged>>, files: Record<string, string>) => {
      const config = p.e.ctx.snapshot.config;
      return dotnetAuditCheck({ config: { ...config, dependencies: { ...config.dependencies, install_command: [dotnet!, 'restore', '-m:1'] } }, repo: p.e.r.repo, files: Object.keys(files), provider, available: true, platform: 'darwin', orbitHome: join(p.e.ctx.homeDir!, '.orbit') });
    };
    const on = withAudit('<NuGetAudit>true</NuGetAudit>');
    const before = await packaged(on);
    const [finding] = doctor(before, on);
    expect(finding?.status).toBe('fail');
    fillOutside(before, on);
    const failed = await install(before);
    expect(failed.log).toMatch(/error NU1900: Warning As Error/);
    expect(failed.r.status).toBe('FAILED');
    // The change doctor names, as the person would make it.
    const form = /(<NuGetAudit Condition=.+?>true<\/NuGetAudit>)/.exec(finding!.fix!)?.[1];
    expect(form).toBeDefined();
    const deferring = withAudit(form!);
    const after = await packaged(deferring);
    expect(doctor(after, deferring)).toEqual([]);
    fillOutside(after, deferring);
    const i = await install(after);
    expect(i.log).not.toMatch(/NU1900/);
    expect(i.r.status, i.log).toBe('PASSED');
    await buildsFromCache(after, ['build', 'build-restoring']);
  }, 600_000);

  // Review: the fill command mirrored an install of `dotnet tool restore` alone, so the projects' packages were never
  // cached. It fills both; local tools go to the same cache, and the install restores them from it in the sandbox.
  it.skipIf(process.platform !== 'darwin')('on macOS follows doctor\'s fill command for a repository with local tools: the install restores them from the cache, and a check runs one', async () => {
    const files = { ...PROJECT, '.config/dotnet-tools.json': '{ "version": 1, "isRoot": true, "tools": { "csharpier": { "version": "0.30.6", "commands": ["dotnet-csharpier"] } } }\n' };
    // A check's HOME is its own, where `dotnet tool restore` records the tools it found, so a check restores them itself
    // (from the cache, with no network) before it runs one.
    const base = await packaged(files, [checkDef('tool', { command: [`"${dotnet}" tool restore && "${dotnet}" csharpier --version`], shell: true, timeout_seconds: 120 })]);
    const orbitHome = join(base.e.ctx.homeDir!, '.orbit');
    const config = base.e.ctx.snapshot.config;
    const restoreTools = [dotnet!, 'tool', 'restore'];
    const [c] = dotnetPackagesCheck({ config: { ...config, dependencies: { ...config.dependencies, install_command: restoreTools } }, repo: base.e.r.repo, files: Object.keys(files), provider, available: true, platform: 'darwin', orbitHome });
    expect(c!.status).toBe('fail');
    const command = /: (\(cd .+\)); the dependency install and the checks then restore offline from that cache/.exec(c!.fix!)?.[1];
    expect(command).toMatch(/ && dotnet restore -m:1 && dotnet tool restore\)$/);
    execFileSync('/bin/sh', ['-c', command!], { stdio: 'pipe', timeout: 300_000, env: { ...process.env, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' } });
    const cacheRoot = toolchainCacheRoot(orbitHome, repoKeyFor(base.e.r.repo));
    expect(readdirSync(join(cacheRoot, 'nuget'))).toEqual(expect.arrayContaining(['csharpier', PACKAGE.id.toLowerCase()]));
    const p = { ...base, cacheRoot, ctx: { ...base.ctx, toolchainCacheRoot: cacheRoot } };
    const i = await install(p, restoreTools);
    expect(i.r.status, i.log).toBe('PASSED');
    await buildsFromCache(p, ['build-restoring']);
    const [tool] = await runChecks({ ...p.ctx, candidate: p.e.candidate, checkIds: ['tool'] });
    const log = readFileSync(tool!.logPath, 'utf8');
    expect(log).toContain('0.30.6');
    expect(tool!.status, log).toBe('PASSED');
  }, 600_000);

  it.skipIf(process.platform === 'darwin')('restores the package in the dependency install step, then builds from the read-only cache with no network', async () => {
    const p = await packaged();
    const i = await install(p);
    expect(i.log).not.toMatch(NOT_CONTAINER);
    expect(i.r.status, i.log).toBe('PASSED');
    expect(readdirSync(join(p.cacheRoot, 'nuget'))).toContain(PACKAGE.id.toLowerCase());
    await buildsFromCache(p, ['build', 'build-restoring']);
  }, 600_000);

  it.skipIf(process.platform !== 'darwin')('on macOS gets the install step\'s restore past CookieContainer to TLS, and restores and builds from a cache filled outside the sandbox', async () => {
    const denied = await packaged();
    const first = await install(denied);
    expect(first.log).not.toMatch(NOT_CONTAINER);
    // The next refusal: the certificate check needs the system trust service, which srt keeps out of reach.
    expect(first.log).toMatch(/error NU1301: .*The SSL connection could not be established/);
    expect(first.r.status).toBe('FAILED');
    // Review: on the base revision this was a pre-existing failure with a baseline-exception question; it is the
    // environment's, and its fix is the cache filled outside the sandbox.
    const found = classifyCouldNotRun({ checkId: 'install', output: first.log, insideRoots: [denied.e.checkoutDir, dirname(first.r.logPath)] });
    expect(found?.signals).toEqual(['nuget-tls-denied']);
    expect(environmentFix([found!], 'darwin')).toMatch(/fill the repository's NuGet cache outside the sandbox with the command orbit doctor prints \(checks\.dotnet-packages\)/);
    // The way out on macOS: the person fills the repository's cache outside the sandbox, as the restore would, before
    // the run (a new checkout, as a run's is).
    const p = await packaged();
    fillOutside(p, PROJECT);
    // The install step then restores from the cache with nothing to download (the vulnerability audit, which cannot
    // reach nuget.org on macOS, is off), and the checks build from it, read-only and with no network.
    const again = await install(p);
    expect(again.log).not.toMatch(NOT_CONTAINER);
    expect(again.r.status, again.log).toBe('PASSED');
    await buildsFromCache(p, ['build', 'build-restoring']);
  }, 600_000);

  // The person's side of it (checks.dotnet-packages): doctor names the problem before a run, with one command; that
  // command, run outside the sandbox, fills the cache at the path doctor computed for this repository; the install step
  // and the checks then restore and build from it under srt, with nothing to download.
  it.skipIf(process.platform !== 'darwin')('on macOS follows doctor\'s checks.dotnet-packages: its command fills the cache, then the install and the checks build offline', async () => {
    const base = await packaged();
    const orbitHome = join(base.e.ctx.homeDir!, '.orbit');
    const config = base.e.ctx.snapshot.config;
    const doctor = () =>
      dotnetPackagesCheck({ config: { ...config, dependencies: { ...config.dependencies, install_command: [dotnet!, 'restore', '-m:1'] } }, repo: base.e.r.repo, files: Object.keys(PROJECT), provider, available: true, platform: 'darwin', orbitHome })[0]!;
    const before = doctor();
    expect(before.status).toBe('fail');
    expect(before.summary).toMatch(/cannot be downloaded inside the sandbox on macOS \(it keeps the system trust service out of reach, so \.NET cannot verify nuget\.org's certificate\)/);
    const command = /: (\(cd .+\)); the dependency install and the checks then restore offline from that cache/.exec(before.fix!)?.[1];
    expect(command).toBeDefined();
    // As the person would, in a terminal outside the sandbox.
    execFileSync('/bin/sh', ['-c', command!], { stdio: 'pipe', timeout: 300_000, env: { ...process.env, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' } });
    const cacheRoot = toolchainCacheRoot(orbitHome, repoKeyFor(base.e.r.repo));
    expect(readdirSync(join(cacheRoot, 'nuget'))).toContain(PACKAGE.id.toLowerCase());
    const after = doctor();
    // Filled: reported as filled, with nothing left to warn of (issue #33).
    expect(after.status).toBe('pass');
    expect(after.details.find((d) => d.startsWith('NuGet cache '))).toMatch(/^NuGet cache .+: holds \d+ packages?$/);
    const p = { ...base, cacheRoot, ctx: { ...base.ctx, toolchainCacheRoot: cacheRoot } };
    const i = await install(p);
    expect(i.log).not.toMatch(NOT_CONTAINER);
    expect(i.r.status, i.log).toBe('PASSED');
    await buildsFromCache(p, ['build', 'build-restoring']);
  }, 600_000);
});
