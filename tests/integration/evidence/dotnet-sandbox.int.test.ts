import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { checkSandboxCheck } from '../../../src/cli/commands/doctor-sandbox.ts';
import { runChecks } from '../../../src/evidence/runner.ts';
import { classifyCouldNotRun } from '../../../src/evidence/environment-failure.ts';
import { SandboxRuntimeIsolation } from '../../../src/isolation/sandbox-runtime.ts';
import { which } from '../../../src/isolation/util.ts';
import { defaultCheck, defaultConfig } from '../../../src/policy/config.ts';
import { checkDef } from '../../unit/evidence/fixtures.ts';
import { runnerEnv, type RunnerEnv } from './harness.ts';

/**
 * Issue #10: a `dotnet build` check under Orbit's real srt check profile. Before the fix the SDK's first-run NuGet
 * migrations took a named mutex under /tmp/.dotnet, which the sandbox denies, and the check died in about two seconds
 * with errno EPERM before building anything. Skipped where dotnet or srt is missing.
 */
const installDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const provider = new SandboxRuntimeIsolation({ orbitInstallDir: installDir });
const probe = await provider.available();
const dotnet = which('dotnet', process.env.PATH) ?? [join(homedir(), '.dotnet', 'dotnet')].find((p) => existsSync(p)) ?? null;
const skip = !probe.ok ? `srt unavailable: ${probe.detail}` : dotnet === null ? 'dotnet is not installed' : null;

/** The newest framework the SDK carries, so a project builds offline whichever SDK is installed (net9.0 needed a download with SDK 10 alone). */
const TFM = '<TargetFramework>net$(NETCoreAppMaximumVersion)</TargetFramework>';

const PROJECT = {
  'acme.csproj': `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType>${TFM}</PropertyGroup></Project>\n`,
  'Program.cs': 'System.Console.WriteLine("hello acme");\n',
};

/**
 * Issue #10, reopened: a test project referencing two libraries. Its restore walks both references at once, so MSBuild
 * starts a worker node, which binds a named pipe at /tmp/MSBuild<pid>; the sandbox denied it, and MSBuild waited 30 s
 * for each of ten node starts before failing (MSB1025, SocketException (13)). No packages: it builds offline.
 */
/** The fix names the check's command with -m:1, and the alternative with its cost to the test host. */
const MSBUILD_FIX = /-m:1.*DOTNET_PROCESSOR_COUNT=1 in checks\.build\.env also works, but the test host then gets one processor too/;
const SOLUTION = {
  'src/Acme/Acme.csproj': `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>${TFM}</PropertyGroup></Project>\n`,
  'src/Acme/Calc.cs': 'namespace Acme;\npublic static class Calc { public static int Add(int a, int b) => a + b; }\n',
  'src/Acme.Extra/Acme.Extra.csproj': `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>${TFM}</PropertyGroup></Project>\n`,
  'src/Acme.Extra/Twice.cs': 'namespace Acme.Extra;\npublic static class Twice { public static int Of(int a) => a * 2; }\n',
  'tests/Acme.Tests/Acme.Tests.csproj': `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType>${TFM}</PropertyGroup><ItemGroup><ProjectReference Include="../../src/Acme/Acme.csproj" /><ProjectReference Include="../../src/Acme.Extra/Acme.Extra.csproj" /></ItemGroup></Project>\n`,
  'tests/Acme.Tests/Program.cs': 'return Acme.Calc.Add(2, 3) == 5 && Acme.Extra.Twice.Of(3) == 6 ? 0 : 1;\n',
};

const envs: RunnerEnv[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

/** `orbit doctor`'s checks.sandbox for one check, through the real srt provider. */
async function doctorProbe(command: string[], opts: { orbitHome?: string; env?: Record<string, string> } = {}) {
  const repo = temp('orbit-dotnet-repo-');
  const config = defaultConfig('autonomous');
  config.checks = { build: { ...defaultCheck('build'), command, mandatory: true, ...(opts.env ? { env: opts.env } : {}) } };
  return checkSandboxCheck({ config, repo, provider, available: true, env: process.env, homeDir: homedir(), ...(opts.orbitHome ? { orbitHome: opts.orbitHome } : {}) });
}

describe.skipIf(skip !== null)(skip === null ? 'a dotnet check under the srt check profile' : `a dotnet check under the srt check profile skipped: ${skip}`, () => {
  async function run(files: Record<string, string>, command: string[], env: Record<string, string> = {}) {
    const e = await runnerEnv([checkDef('build', { command, timeout_seconds: 300, env })], { isolation: provider, files });
    envs.push(e);
    const [r] = await runChecks({ ...e.ctx, candidate: e.candidate, checkIds: ['build'] });
    return { r: r!, log: readFileSync(r!.logPath, 'utf8'), e };
  }
  const build = (files: Record<string, string>, args: string[] = []) => run(files, [dotnet!, 'build', ...args]);

  // Review round 4: what doctor's static rule now reads as MSBuild reads it, measured through the runner.
  it('builds on one node with DOTNET_PROCESSOR_COUNT=1 in the check\'s env and no switch, and with -m:1 after the -- of dotnet build', async () => {
    for (const [command, env] of [[[dotnet!, 'build', 'tests/Acme.Tests'], { DOTNET_PROCESSOR_COUNT: '1' }], [[dotnet!, 'build', 'tests/Acme.Tests', '--', '-m:1'], {}]] as const) {
      const { r, log } = await run(SOLUTION, [...command], env);
      expect(log, command.join(' ')).not.toMatch(/MSB1025|SocketException/);
      expect(r.status, command.join(' ')).toBe('PASSED');
    }
  }, 180_000);

  it('refuses dotnet test a worker node when its -m:1 comes after --, which the test runner gets', async () => {
    const started = Date.now();
    const { r } = await run(SOLUTION, [dotnet!, 'test', 'tests/Acme.Tests', '--', '-m:1']);
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(r.status).toBe('FAILED');
  }, 120_000);

  it('builds a test project whose restore walks two references at once, with the check\'s own -m:1, on one MSBuild node', async () => {
    const { r, log } = await build(SOLUTION, ['tests/Acme.Tests', '-m:1']);
    expect(log).not.toMatch(/MSB1025|SocketException/);
    expect(log).toMatch(/Build succeeded/);
    expect(r).toMatchObject({ status: 'PASSED', isolation: 'sandbox-runtime' });
  }, 120_000);

  // Orbit leaves the processor count alone, so a build without -m:1 starts worker nodes, which the sandbox refuses.
  it('ends a build without -m:1 within seconds, and on macOS names the pipe the sandbox denied and the check\'s fixed command', async () => {
    for (const args of [['tests/Acme.Tests'], ['tests/Acme.Tests', '-m:2']]) {
      const started = Date.now();
      const { r, log } = await build(SOLUTION, args);
      expect(Date.now() - started, args.join(' ')).toBeLessThan(60_000);
      expect(r.status, args.join(' ')).toBe('FAILED');
      // macOS: MSBuild waits 30 s per node start for the crashed node, so the runner finds its record and stops the check.
      // Linux: the sandbox refuses MSBuild's own socket too, and MSBuild fails within a second, usually before the
      // runner's next look at the temp directory, so the log may carry no note.
      if (process.platform === 'darwin') {
        expect(log).toMatch(/note=the check sandbox denied MSBuild node \(pid \d+\) its named pipe \/tmp\/MSBuild\d+ \(System\.Net\.Sockets\.SocketException \(\d+\): [^)]+\)/);
        expect(log).toContain(`Fix: checks.build.command: ${JSON.stringify([dotnet!, 'build', 'tests/Acme.Tests', '-m:1']).replace(/,/g, ', ')}`);
      }
    }
  }, 180_000);

  it('builds a minimal console project', async () => {
    const { r, log } = await build(PROJECT);
    expect(log).not.toMatch(/EPERM/);
    expect(log).toMatch(/Build succeeded/);
    expect(r).toMatchObject({ status: 'PASSED', isolation: 'sandbox-runtime' });
  }, 300_000);

  it('still reports a real compile error as the code failure it is, not as the environment', async () => {
    const { r, log, e } = await build({ ...PROJECT, 'Program.cs': 'System.Console.WriteLine("hello acme")\n' });
    expect(r.status).toBe('FAILED');
    expect(log).toMatch(/error CS1002/);
    expect(classifyCouldNotRun({ checkId: 'build', output: log, insideRoots: [e.checkoutDir, dirname(r.logPath)] })).toBeNull();
  }, 300_000);
});

describe.skipIf(skip !== null)(skip === null ? 'orbit doctor starts a dotnet check under srt' : `orbit doctor starts a dotnet check under srt skipped: ${skip}`, () => {
  it('runs "dotnet help", which goes through the SDK\'s first-run steps, in the check sandbox', async () => {
    const c = await doctorProbe([dotnet!, 'build', '-m:1']);
    expect(c.details).toEqual(['build: "dotnet help" ran in the sandbox']);
    expect(c.status).toBe('pass');
  }, 120_000);

  it('builds three generated projects in the check sandbox for the dotnet toolchain with the check\'s -m:1, as a real check builds', async () => {
    const c = await doctorProbe([dotnet!, 'build', '-m:1'], { orbitHome: temp('orbit-dotnet-home-') });
    expect(c.details[1]).toMatch(/^toolchain dotnet: "dotnet build Probe\.App\/Probe\.App\.csproj -m:1" ran in the sandbox \(three generated projects/);
    expect(c.status).toBe('pass');
  }, 180_000);

  it('passes a check that raises DOTNET_PROCESSOR_COUNT for its tests and pins MSBuild to one node with -maxcpucount:1, as a run does', async () => {
    const c = await doctorProbe([dotnet!, 'test', '-maxcpucount:1'], { orbitHome: temp('orbit-dotnet-home-'), env: { DOTNET_PROCESSOR_COUNT: '8' } });
    expect(c.details[1]).toMatch(/^toolchain dotnet: "dotnet build Probe\.App\/Probe\.App\.csproj -maxcpucount:1" ran in the sandbox \(three generated projects/);
    expect(c.status).toBe('pass');
  }, 180_000);

  // Review round 4: the alternative doctor's fix names, which doctor failed although the runner passes it.
  it('passes a check whose own env sets DOTNET_PROCESSOR_COUNT=1, building the probe without a switch on one node, as a run does', async () => {
    const c = await doctorProbe([dotnet!, 'test', 'tests/Acme.Tests'], { orbitHome: temp('orbit-dotnet-home-'), env: { DOTNET_PROCESSOR_COUNT: '1' } });
    expect(c.details[1]).toMatch(/^toolchain dotnet: "dotnet build Probe\.App\/Probe\.App\.csproj" ran in the sandbox \(three generated projects/);
    expect(c.status).toBe('pass');
  }, 180_000);

  it('fails dotnet test whose -m:1 comes after --, and its probe, which builds as MSBuild would run it, without the switch', async () => {
    const c = await doctorProbe([dotnet!, 'test', 'tests/Acme.Tests', '--', '-m:1'], { orbitHome: temp('orbit-dotnet-home-') });
    expect(c.status).toBe('fail');
    expect(c.details[0]).toBe('build: runs "dotnet test" without -m:1, so MSBuild starts a worker node per processor, and the check sandbox refuses every MSBuild worker node its named pipe under /tmp');
    expect(c.details[1]).toMatch(/^toolchain dotnet: "dotnet build Probe\.App\/Probe\.App\.csproj" was refused in the sandbox: /);
  }, 180_000);

  it('fails a check without -m:1 from its definition, and its probe within seconds, naming the denied pipe and the fixed command', async () => {
    const started = Date.now();
    const c = await doctorProbe([dotnet!, 'build'], { orbitHome: temp('orbit-dotnet-home-') });
    expect(Date.now() - started).toBeLessThan(90_000);
    expect(c.status).toBe('fail');
    expect(c.details[0]).toBe('build: runs "dotnet build" without -m:1, so MSBuild starts a worker node per processor, and the check sandbox refuses every MSBuild worker node its named pipe under /tmp');
    const recorded = /MSBuild node \(pid \d+\) could not bind its named pipe \/tmp\/MSBuild\d+ \(System\.Net\.Sockets\.SocketException/;
    // macOS: the parent waits for the crashed node, which always records the denial first. Linux: the sandbox refuses the
    // parent's socket as well, so MSBuild can fail before a node records anything, and the line names the missing -m:1.
    const unrecorded = /runs "dotnet build" without -m:1, so MSBuild starts a worker node per processor, and the build failed \(exited 1\) with no record of which node was refused/;
    const refused = (why: RegExp) => new RegExp(`^toolchain dotnet: "dotnet build Probe\\.App/Probe\\.App\\.csproj" was refused in the sandbox: (?:${why.source})`);
    expect(c.details[1]).toMatch(process.platform === 'darwin' ? refused(recorded) : refused(new RegExp(`${recorded.source}|${unrecorded.source}`)));
    expect(c.fix!.startsWith(`checks.build.command: ${JSON.stringify([dotnet!, 'build', '-m:1']).replace(/,/g, ', ')} `)).toBe(true);
    expect(c.fix).toMatch(MSBUILD_FIX);
  }, 180_000);
});

describe.skipIf(!probe.ok)(probe.ok ? 'orbit doctor reports a sandbox denial under srt' : `orbit doctor reports a sandbox denial under srt skipped: ${probe.detail}`, () => {
  it('reports an executable the sandbox refuses a write outside its checkout, before any run', async () => {
    const outside = temp('orbit-denied-');
    const bin = temp('orbit-tool-');
    const tool = join(bin, 'acme-tool');
    writeFileSync(tool, `#!/bin/sh\nmkdir ${JSON.stringify(join(outside, 'cache'))} || exit 1\n`, { mode: 0o755 });
    const c = await doctorProbe([tool]);
    expect(c.status).toBe('fail');
    expect(c.details[0]).toMatch(/^build: "acme-tool --version" was refused in the sandbox: the sandbox or the operating system refused a filesystem operation outside the check's checkout/);
    // Seatbelt refuses the write with EPERM; srt on Linux mounts everything outside the writable paths read-only (EROFS).
    expect(c.details[0]).toContain(process.platform === 'darwin' ? 'Operation not permitted' : 'Read-only file system');
    expect(existsSync(join(outside, 'cache'))).toBe(false);
  }, 120_000);
});
