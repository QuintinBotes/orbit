import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyCouldNotRun } from '../../../src/evidence/environment-failure.ts';
import { checkEnv, DOTNET_CHECK_ENV, NUGET_MIGRATIONS_DIR, prepareCheckHome, runChecks } from '../../../src/evidence/runner.ts';
import { checkDef, nodeCheck } from './fixtures.ts';
import { runnerEnv, type RunnerEnv } from '../../integration/evidence/harness.ts';

// Issue #10: what a check gets so the .NET SDK's first run needs nothing outside the sandbox.

const envs: RunnerEnv[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('checkEnv: the .NET SDK variables', () => {
  const paths = { homeDir: '/h', tmpDir: '/t', artifactsDir: '/a' };

  it('turns off the optional first-run steps and keeps the SDK\'s state in the check\'s private home', () => {
    const env = checkEnv(checkDef('build'), paths, '/host');
    expect(env).toMatchObject({
      DOTNET_CLI_HOME: '/h',
      DOTNET_CLI_TELEMETRY_OPTOUT: '1',
      DOTNET_NOLOGO: '1',
      DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
      DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false',
      DOTNET_ADD_GLOBAL_TOOLS_TO_PATH: 'false',
      DOTNET_SKIP_WORKLOAD_INTEGRITY_CHECK: '1',
    });
    for (const [k, v] of Object.entries(DOTNET_CHECK_ENV)) expect(env[k], k).toBe(v);
  });

  it('turns off the build\'s git query, which reads the absent .gitmodules srt makes unopenable on Linux', () => {
    expect(checkEnv(checkDef('build'), paths, '/host').EnableSourceControlManagerQueries).toBe('false');
    expect(checkEnv(checkDef('build', { env: { EnableSourceControlManagerQueries: 'true' } }), paths, '/host').EnableSourceControlManagerQueries).toBe('true');
  });

  // Orbit never changes a check's processor count (ADR 0009, addendum): DOTNET_PROCESSOR_COUNT reaches the test host,
  // where xunit before 2.8 deadlocks a test that blocks on async code, and it changes how a repository's tests run. A
  // dotnet check pins one MSBuild node in its own command (-m:1) instead.
  it('leaves the processor count alone: DOTNET_PROCESSOR_COUNT is neither set nor changed, a check\'s own value passes through', () => {
    expect(Object.keys(DOTNET_CHECK_ENV)).not.toContain('DOTNET_PROCESSOR_COUNT');
    expect(checkEnv(checkDef('build'), paths, '/host')).not.toHaveProperty('DOTNET_PROCESSOR_COUNT');
    expect(checkEnv(checkDef('build', { env: { DOTNET_PROCESSOR_COUNT: '1' } }), paths, '/host').DOTNET_PROCESSOR_COUNT).toBe('1');
  });

  it('lets the check definition override any of them', () => {
    expect(checkEnv(checkDef('build', { env: { DOTNET_CLI_HOME: '/mine', DOTNET_NOLOGO: '0' } }), paths, '/host')).toMatchObject({ DOTNET_CLI_HOME: '/mine', DOTNET_NOLOGO: '0', HOME: '/h' });
  });
});

describe('prepareCheckHome', () => {
  it('marks the NuGet migrations done in an empty home, owner-only, and can run again', () => {
    const home = mkdtempSync(join(tmpdir(), 'orbit-home-'));
    dirs.push(home);
    prepareCheckHome(home);
    prepareCheckHome(home);
    const marker = join(home, NUGET_MIGRATIONS_DIR, '1');
    expect(readFileSync(marker, 'utf8')).toBe('');
    expect(statSync(marker).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, NUGET_MIGRATIONS_DIR)).mode & 0o077).toBe(0);
  });

  it('is done for every check before it starts: the check finds the marker in its HOME', async () => {
    const script = `const fs=require("fs"),path=require("path");const m=path.join(process.env.HOME,${JSON.stringify(NUGET_MIGRATIONS_DIR)},"1");console.log(fs.existsSync(m)?"marker present":"marker missing");process.exit(fs.existsSync(m)&&process.env.DOTNET_CLI_HOME===process.env.HOME?0:1)`;
    const e = await runnerEnv([nodeCheck('home', script)]);
    envs.push(e);
    const [r] = await runChecks({ ...e.ctx, candidate: e.candidate, checkIds: ['home'] });
    expect(readFileSync(r!.logPath, 'utf8')).toContain('marker present');
    expect(r!.status).toBe('PASSED');
    // The private home is removed with the check's other scratch directories.
    expect(existsSync(join(e.run.runDir, 'evidence', '1', 'home', 'home'))).toBe(false);
  });
});

describe('a check whose MSBuild node the sandbox refused its pipe', () => {
  const FAILURE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/environment', 'msbuild-node-pipe-denied.failure.txt'), 'utf8');
  /** A check that leaves MSBuild's crash report of a denied node where MSBuild writes it, then waits as MSBuild would. */
  const deniedNode = (after = 'setInterval(() => {}, 1000)') =>
    `const fs=require("fs"),path=require("path");fs.writeFileSync(path.join(process.env.ORBIT_ARTIFACTS_DIR,"pid"),String(process.pid));const d=path.join(process.env.TMPDIR,"MSBuildTempacme");fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,"MSBuild_pid-4242_9a2a6b744ce84a9a.failure.txt"),${JSON.stringify(FAILURE)});console.log("  Determining projects to restore...");${after}`;

  it('is stopped as soon as MSBuild records the denial, not after its ten 30 s node retries, and its record says why', async () => {
    const e = await runnerEnv([nodeCheck('build', deniedNode(), { timeout_seconds: 120 })]);
    envs.push(e);
    const started = Date.now();
    const [r] = await runChecks({ ...e.ctx, candidate: e.candidate, checkIds: ['build'] });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(r!.status).toBe('FAILED');
    const log = readFileSync(r!.logPath, 'utf8');
    expect(log).toContain('Determining projects to restore...');
    expect(log).not.toContain('[orbit: check cancelled]');
    expect(log).toMatch(/ note=the check sandbox denied MSBuild node \(pid 4242\) its named pipe \/tmp\/MSBuild4242 \(System\.Net\.Sockets\.SocketException \(13\): Permission denied\)/);
    // The fix for this check: -m:1 on its MSBuild calls (it is not a dotnet command, so it cannot be rewritten), and the alternative with its cost.
    expect(log).toMatch(/Fix: pass -m:1 to every dotnet build, test, publish, pack, restore, clean or msbuild that checks\.build\.command \(.+\) starts, and build before dotnet run --no-build \(MSBuild worker nodes cannot run in the check sandbox/);
    expect(log).toContain('DOTNET_PROCESSOR_COUNT=1 in checks.build.env also works, but the test host then gets one processor too, where xunit before 2.8 deadlocks a test that blocks on async code');
    expect(r!.excerpt).toContain('/tmp/MSBuild4242');
    // Nothing of the check is left running.
    const pid = Number(readFileSync(join(dirname(r!.logPath), 'build', 'artifacts', 'pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 60_000);

  it('is never recorded as passed, even when the stopped command exits 0 (srt does on SIGTERM)', async () => {
    const e = await runnerEnv([nodeCheck('build', deniedNode('process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000)'), { timeout_seconds: 120 })]);
    envs.push(e);
    const [r] = await runChecks({ ...e.ctx, candidate: e.candidate, checkIds: ['build'] });
    expect(r!.status).toBe('FAILED');
    expect(readFileSync(r!.logPath, 'utf8')).toMatch(/status=FAILED exit=0 note=the check sandbox denied MSBuild node \(pid 4242\)/);
  }, 60_000);

  // dotnet format restores by itself, and its restore cannot be given -m:1: the fix for it is the form that loads no
  // project (ADR 0009, addendum). Its record is read as the environment's, not as a pre-existing failure.
  it('names the dotnet format fix for a format check whose implicit restore was refused a node, and is read as an environment failure', async () => {
    const e = await runnerEnv([checkDef('format', { command: ['node deny.js && dotnet format tests/Acme.Tests/Acme.Tests.csproj --verify-no-changes'], shell: true, timeout_seconds: 120 })], { files: { 'deny.js': deniedNode() } });
    envs.push(e);
    const [r] = await runChecks({ ...e.ctx, candidate: e.candidate, checkIds: ['format'] });
    expect(r!.status).toBe('FAILED');
    const log = readFileSync(r!.logPath, 'utf8');
    expect(log).toMatch(/ note=the check sandbox denied MSBuild node \(pid 4242\) its named pipe \/tmp\/MSBuild4242 .+ Fix: checks\.format\.command: \["node deny\.js && dotnet format whitespace tests\/Acme\.Tests --folder --verify-no-changes"\] \(dotnet format loads the project through a build host/);
    expect(log).not.toContain('pass -m:1');
    expect(classifyCouldNotRun({ checkId: 'format', output: log, insideRoots: [e.checkoutDir, dirname(r!.logPath)] })?.signals).toEqual(['pipe-denied']);
  }, 60_000);

  // SDK 8, pinned by global.json, loads the project in dotnet format's own process: only the restore was refused, so
  // the fix restores with -m:1 first and keeps the format (measured under srt on macOS with SDK 8.0.303).
  it('names a pinned restore first for a format check of SDK 8 whose implicit restore was refused a node', async () => {
    const e = await runnerEnv([checkDef('format', { command: ['node deny.js && dotnet format tests/Acme.Tests/Acme.Tests.csproj --verify-no-changes'], shell: true, timeout_seconds: 120 })], {
      files: { 'deny.js': deniedNode(), 'global.json': '{"sdk":{"version":"8.0.303"}}\n' },
    });
    envs.push(e);
    const [r] = await runChecks({ ...e.ctx, candidate: e.candidate, checkIds: ['format'] });
    expect(r!.status).toBe('FAILED');
    const log = readFileSync(r!.logPath, 'utf8');
    expect(log).toContain(
      ' Fix: checks.format.command: ["node deny.js && dotnet restore tests/Acme.Tests/Acme.Tests.csproj -m:1 && dotnet format tests/Acme.Tests/Acme.Tests.csproj --verify-no-changes --no-restore"] (dotnet format passes no -m:1 to the restore it runs first',
    );
    expect(log).not.toContain('build host');
    expect(classifyCouldNotRun({ checkId: 'format', output: log, insideRoots: [e.checkoutDir, dirname(r!.logPath)] })?.signals).toEqual(['pipe-denied']);
  }, 60_000);

  // Review: on Linux MSBuild fails at once when its node is refused, so a check could exit before the runner's next scan
  // of its temp directory: then no note was written, and a dotnet format run through make or a script whose restore
  // was refused read as a code failure, a pre-existing failure on the base revision. The runner looks once more when a
  // check fails.
  it('reads a refused node MSBuild recorded even when the check failed before the next scan, and records it as the environment\'s', async () => {
    const e = await runnerEnv([checkDef('format', { command: ['node deny.js && dotnet format tests/Acme.Tests/Acme.Tests.csproj --verify-no-changes'], shell: true, timeout_seconds: 120 })], { files: { 'deny.js': deniedNode('process.exit(1)') } });
    envs.push(e);
    const [r] = await runChecks({ ...e.ctx, candidate: e.candidate, checkIds: ['format'] });
    expect(r!.status).toBe('FAILED');
    const log = readFileSync(r!.logPath, 'utf8');
    expect(log).toMatch(/status=FAILED exit=1 note=the check sandbox denied MSBuild node \(pid 4242\) its named pipe \/tmp\/MSBuild4242 .+ Fix: checks\.format\.command: \["node deny\.js && dotnet format whitespace tests\/Acme\.Tests --folder --verify-no-changes"\]/);
    expect(classifyCouldNotRun({ checkId: 'format', output: log, insideRoots: [e.checkoutDir, dirname(r!.logPath)] })?.signals).toEqual(['pipe-denied']);
  }, 60_000);

  it('leaves a check alone that MSBuild never reported a denied node for', async () => {
    const e = await runnerEnv([nodeCheck('build', 'setTimeout(() => process.exit(0), 1500)', { timeout_seconds: 60 })]);
    envs.push(e);
    const [r] = await runChecks({ ...e.ctx, candidate: e.candidate, checkIds: ['build'] });
    expect(r!.status).toBe('PASSED');
  }, 60_000);
});

// Orbit used to give every check one processor, and named the xunit deadlock that caused in the record of a .NET check
// that timed out. It no longer changes the processor count, so a timed-out .NET check is an ordinary timeout.
describe('a .NET check that times out', () => {
  it('is recorded as a timeout with no note about the processor count', async () => {
    const e = await runnerEnv([nodeCheck('test', 'console.log("Starting test execution, please wait...");setInterval(() => {}, 1000)', { timeout_seconds: 1 })], { files: { 'acme.sln': '' } });
    envs.push(e);
    const [r] = await runChecks({ ...e.ctx, candidate: e.candidate, checkIds: ['test'] });
    expect(r!.status).toBe('TIMEOUT');
    expect(readFileSync(r!.logPath, 'utf8')).not.toContain('DOTNET_PROCESSOR_COUNT');
  }, 60_000);
});
