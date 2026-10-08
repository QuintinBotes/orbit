import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { checkSandboxCheck } from '../../../src/cli/commands/doctor-sandbox.ts';
import { environmentFix } from '../../../src/controller/environment-block.ts';
import { classifyCouldNotRun } from '../../../src/evidence/environment-failure.ts';
import { runChecks } from '../../../src/evidence/runner.ts';
import { SandboxRuntimeIsolation } from '../../../src/isolation/sandbox-runtime.ts';
import { which } from '../../../src/isolation/util.ts';
import { defaultCheck, defaultConfig } from '../../../src/policy/config.ts';
import type { CheckDefinition } from '../../../src/policy/types.ts';
import { checkDef } from '../../unit/evidence/fixtures.ts';
import { runnerEnv, type RunnerEnv } from './harness.ts';

/**
 * dotnet format under Orbit's real srt check profile (issue #10; docs/decisions/0009-toolchain-profiles.md, addendum).
 * Every form but `dotnet format whitespace --folder` loads the project through MSBuildWorkspace's build host, whose named
 * pipe Roslyn binds at /tmp/<guid> whatever TMPDIR says, and the sandbox refuses it: measured on macOS with SDK 9.0.305
 * (Seatbelt denied file-write-create of /tmp/<guid>; the format waited out the build host's 60 s connect
 * timeout), and on Linux with SDK 10.0.401 (the socket refused at once; or, in 8 runs of 40, dotnet format said the
 * C# project was in no language it supports and exited 0, which the runner records as the same failure).
 * Before this, such a check failed its baseline after a minute, or after MSBuild's five minutes of node retries when
 * its implicit restore had two projects to walk, and became a pre-existing failure with a baseline exception question. Now doctor fails it before any probe, and the
 * runner's record of the failure reads as the environment's. SDK 8.0.303's dotnet format evaluates projects in its own
 * process and runs once its restore is pinned (a global.json pins it here). On a busy machine it can lose the output of
 * the `dotnet --version` it starts first and exit 4 having checked nothing, wherever its checkout is (once in seven CI
 * runs of the step in a run's layout); the runner starts such an attempt again (runner.test.ts). Skipped where srt or
 * dotnet is missing.
 */
const installDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const provider = new SandboxRuntimeIsolation({ orbitInstallDir: installDir });
const probe = await provider.available();
const dotnet = which('dotnet', process.env.PATH) ?? [join(homedir(), '.dotnet', 'dotnet')].find((p) => existsSync(p)) ?? null;
const skip = !probe.ok ? `srt unavailable: ${probe.detail}` : dotnet === null ? 'dotnet is not installed' : null;

const TFM = '<TargetFramework>net$(NETCoreAppMaximumVersion)</TargetFramework>';
const PROJECT = {
  'acme.csproj': `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType>${TFM}</PropertyGroup></Project>\n`,
  'Program.cs': 'System.Console.WriteLine("hello acme");\n',
};
/** A test project referencing two libraries: a restore of it walks both at once, which starts an MSBuild worker node. */
const SOLUTION = {
  'src/Acme/Acme.csproj': `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>${TFM}</PropertyGroup></Project>\n`,
  'src/Acme/Calc.cs': 'namespace Acme;\npublic static class Calc { public static int Add(int a, int b) => a + b; }\n',
  'src/Acme.Extra/Acme.Extra.csproj': `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>${TFM}</PropertyGroup></Project>\n`,
  'src/Acme.Extra/Twice.cs': 'namespace Acme.Extra;\npublic static class Twice { public static int Of(int a) => a * 2; }\n',
  'tests/Acme.Tests/Acme.Tests.csproj': `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType>${TFM}</PropertyGroup><ItemGroup><ProjectReference Include="../../src/Acme/Acme.csproj" /><ProjectReference Include="../../src/Acme.Extra/Acme.Extra.csproj" /></ItemGroup></Project>\n`,
  'tests/Acme.Tests/Program.cs': 'return Acme.Calc.Add(2, 3) == 5 && Acme.Extra.Twice.Of(3) == 6 ? 0 : 1;\n',
};

/** The major version of the SDK dotnet picks in a directory with no global.json: 8 runs dotnet format's workspace in its own process. */
function sdkMajor(): number {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-sdk-')));
  try {
    return Number(execFileSync(dotnet!, ['--version'], { cwd: dir, encoding: 'utf8', env: { ...process.env, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' } }).trim().split('.')[0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const envs: RunnerEnv[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close();
});

describe.skipIf(skip !== null)(skip === null ? 'dotnet format under the srt check profile' : `dotnet format under the srt check profile skipped: ${skip}`, () => {
  const major = skip === null ? sdkMajor() : 0;
  /** The SDK versions installed: SDK 8 is measured where 8.0.303 is one. */
  const sdks = skip === null ? execFileSync(dotnet!, ['--list-sdks'], { encoding: 'utf8' }).split('\n').map((l) => l.split(' ')[0]!) : [];

  async function run(files: Record<string, string>, check: Partial<CheckDefinition>, checkoutAt?: (root: string) => string) {
    const e = await runnerEnv([checkDef('format', { timeout_seconds: 300, ...check })], { isolation: provider, files, ...(checkoutAt ? { checkoutAt } : {}) });
    envs.push(e);
    const started = Date.now();
    const [r] = await runChecks({ ...e.ctx, candidate: e.candidate, checkIds: ['format'] });
    return { r: r!, ms: Date.now() - started, log: readFileSync(r!.logPath, 'utf8'), roots: [e.checkoutDir, dirname(r!.logPath)] };
  }

  it('runs dotnet format whitespace --folder, which loads no project', async () => {
    const { r, log } = await run(PROJECT, { command: [dotnet!, 'format', 'whitespace', '--folder', '--verify-no-changes'] });
    expect(r.status, log).toBe('PASSED');
  }, 120_000);

  it('records dotnet format that loads the project as the environment\'s failure, once its build host could not be reached (SDK 9 and later)', async () => {
    const { r, ms, log, roots } = await run(PROJECT, { command: [`"${dotnet}" restore -m:1 && "${dotnet}" format --verify-no-changes --no-restore`], shell: true });
    if (major < 9) {
      // SDK 8: the workspace is evaluated in dotnet format's own process; nothing binds a pipe.
      expect(r.status, log).toBe('PASSED');
      return;
    }
    expect(r.status, log).toBe('FAILED');
    // The build host's connect timeout on macOS (60 s), at once on Linux; never MSBuild's five minutes.
    expect(ms).toBeLessThan(120_000);
    // The build host's crash, or (Linux, SDK 10.0.401: 8 runs of 40, and once in CI of #26) dotnet format's report
    // that the C# project is in no language it supports, exit 0, which the runner records as this failure.
    if (!/BuildHostProcessManager/.test(log)) {
      expect(log).toMatch(/^Could not format '.+\/acme\.csproj'\. Format currently supports only C# and Visual Basic projects\.$/m);
      expect(log).toMatch(/ status=FAILED exit=0 note=the check sandbox denied dotnet format's build host its named pipe under \/tmp, so dotnet format loaded no project and checked nothing, .+ Fix: checks\.format\.command: /);
    }
    expect(classifyCouldNotRun({ checkId: 'format', output: log, insideRoots: roots })?.signals).toEqual(['pipe-denied']);
  }, 300_000);

  it('stops a dotnet format whose implicit restore is refused a worker node, names the form that loads no project, and records it as the environment\'s', async () => {
    const { r, ms, log, roots } = await run(SOLUTION, { command: [dotnet!, 'format', 'tests/Acme.Tests/Acme.Tests.csproj', '--verify-no-changes'] });
    expect(r.status).toBe('FAILED');
    expect(ms).toBeLessThan(60_000);
    if (process.platform === 'darwin') {
      // macOS: MSBuild waits for the crashed node, so the runner finds its record, stops the check and says why.
      expect(log).toMatch(/note=the check sandbox denied MSBuild node \(pid \d+\) its named pipe \/tmp\/MSBuild\d+ /);
      expect(log).toContain(`Fix: checks.format.command: ${JSON.stringify([dotnet!, 'format', 'whitespace', 'tests/Acme.Tests', '--folder', '--verify-no-changes']).replace(/,/g, ', ')} (dotnet format loads the project through a build host`);
      expect(classifyCouldNotRun({ checkId: 'format', output: log, insideRoots: roots })?.signals).toEqual(['pipe-denied']);
    }
  }, 180_000);

  /** The fix a runner's note names, as a check definition: its command, and whether a shell runs it. */
  function noted(log: string): Partial<CheckDefinition> {
    const m = / Fix: checks\.format\.command: (\[.+?\])( with checks\.format\.shell: true)? \(/.exec(log);
    expect(m, log).not.toBeNull();
    return { command: JSON.parse(m![1]!) as string[], shell: m![2] !== undefined };
  }

  // Review: following the runner's fix for a solution's format check: the folder form keeps the project's folder and
  // passes; with SDK 8 pinned by global.json, the pinned restore first and --no-restore pass.
  it('passes once the check is what the runner\'s fix names, for SDK 9 and later and for SDK 8 pinned by global.json', async () => {
    const plain = { command: [dotnet!, 'format', 'tests/Acme.Tests/Acme.Tests.csproj', '--verify-no-changes'] };
    const first = await run(SOLUTION, plain);
    expect(first.r.status).toBe('FAILED');
    if (process.platform !== 'darwin') return;
    const again = await run(SOLUTION, noted(first.log));
    expect(again.r.status, again.log).toBe('PASSED');
    if (!sdks.includes('8.0.303')) return;
    const sdk8 = { ...SOLUTION, 'global.json': '{"sdk":{"version":"8.0.303"}}\n' };
    const first8 = await run(sdk8, plain);
    expect(first8.r.status).toBe('FAILED');
    expect(first8.log).toContain(` Fix: checks.format.command: ["${dotnet!} restore tests/Acme.Tests/Acme.Tests.csproj -m:1 && ${dotnet!} format tests/Acme.Tests/Acme.Tests.csproj --verify-no-changes --no-restore"] with checks.format.shell: true (dotnet format passes no -m:1`);
    const again8 = await run(sdk8, noted(first8.log));
    expect(again8.r.status, again8.log).toBe('PASSED');
    // The plain form on one processor, which doctor accepts too.
    const one = await run(sdk8, { ...plain, env: { DOTNET_PROCESSOR_COUNT: '1' } });
    expect(one.r.status, one.log).toBe('PASSED');
  }, 600_000);

  // Review: the folder form passed in this file only because the harness's checkout had nothing read-denied above it. A
  // run's checkout sits in <orbit home>/worktrees/<key>/<run>/, and the check profile read-denies the Orbit home (~/.orbit)
  // but for the checkout: dotnet format whitespace --folder lists every folder above the checkout for .editorconfig files,
  // and in every real run on macOS it died at once, while doctor passed it and the runner and the block named it as the fix.
  it.skipIf(process.platform !== 'darwin')('on macOS, in a run\'s layout below the read-denied Orbit home: the folder form fails as the environment\'s, and the fixes name running dotnet format outside Orbit', async () => {
    const runLayout = (root: string): string => join(root, 'home', '.orbit', 'worktrees', 'abcdefabcdef', 'orb-1', 'check-1');
    const folder = [dotnet!, 'format', 'whitespace', '--folder', '--verify-no-changes'];
    const { r, log, roots } = await run(PROJECT, { command: folder }, runLayout);
    expect(r.status).toBe('FAILED');
    expect(log).toMatch(/System\.UnauthorizedAccessException: Access to the path '[^']*\/\.orbit\/worktrees\/abcdefabcdef\/orb-1' is denied/);
    const found = classifyCouldNotRun({ checkId: 'format', output: log, insideRoots: roots });
    expect(found?.signals).toEqual(['permission-denied']);
    const fix = environmentFix([{ ...found!, command: { argv: folder, shell: false }, folderForm: false }]);
    expect(fix).toMatch(/^dotnet format \(check format\) cannot run in this check sandbox: remove checks\.format from \.orbit\/config\.yaml and run dotnet format in CI \(on macOS no form/);
    // The runner's note for a format whose implicit restore was refused a worker node names the same, not the folder form.
    const restore = await run(SOLUTION, { command: [dotnet!, 'format', 'tests/Acme.Tests/Acme.Tests.csproj', '--verify-no-changes'] }, runLayout);
    expect(restore.r.status).toBe('FAILED');
    expect(restore.log).toMatch(/note=the check sandbox denied MSBuild node \(pid \d+\) its named pipe \/tmp\/MSBuild\d+ /);
    expect(restore.log).toContain(' Fix: remove checks.format from .orbit/config.yaml and run dotnet format in CI (on macOS no form');
    expect(restore.log).not.toContain('"--folder"');
    // With SDK 8 pinned, the pinned restore first and --no-restore, which the fix names as the other way, pass in this layout.
    if (!sdks.includes('8.0.303')) return;
    const sdk8 = { ...SOLUTION, 'global.json': '{"sdk":{"version":"8.0.303"}}\n' };
    const pinned = await run(sdk8, { command: [`"${dotnet}" restore tests/Acme.Tests/Acme.Tests.csproj -m:1 && "${dotnet}" format tests/Acme.Tests/Acme.Tests.csproj --verify-no-changes --no-restore`], shell: true }, runLayout);
    expect(pinned.r.status, pinned.log).toBe('PASSED');
  }, 600_000);

  it('with SDK 8 pinned by global.json, passes in doctor a format that restores first with -m:1, and refuses the plain one with that fix', async () => {
    if (!sdks.includes('8.0.303')) return;
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-dotnet-format-repo-')));
    try {
      writeFileSync(join(repo, 'global.json'), '{"sdk":{"version":"8.0.303"}}\n');
      const config = defaultConfig('autonomous');
      config.checks = { format: { ...defaultCheck('format'), command: [dotnet!, 'format', '--verify-no-changes'], mandatory: true } };
      const refused = await checkSandboxCheck({ config, repo, provider, available: true, env: process.env, homeDir: homedir() });
      expect(refused.status).toBe('fail');
      expect(refused.fix).toContain(`checks.format.command: ["${dotnet!} restore -m:1 && ${dotnet!} format --verify-no-changes --no-restore"] with checks.format.shell: true`);
      config.checks = { format: { ...defaultCheck('format'), command: [`${dotnet!} restore -m:1 && ${dotnet!} format --verify-no-changes --no-restore`], shell: true, mandatory: true } };
      const ok = await checkSandboxCheck({ config, repo, provider, available: true, env: process.env, homeDir: homedir() });
      expect(ok.status, ok.details.join('\n')).toBe('pass');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 120_000);

  it('fails a mandatory dotnet format check in orbit doctor before starting anything', async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-dotnet-format-repo-')));
    try {
      const config = defaultConfig('autonomous');
      config.checks = { format: { ...defaultCheck('format'), command: [dotnet!, 'format', '--verify-no-changes'], mandatory: true } };
      const started = Date.now();
      const c = await checkSandboxCheck({ config, repo, provider, available: true, env: process.env, homeDir: homedir() });
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(c.status).toBe('fail');
      // The default Orbit home, ~/.orbit, is read-denied: on macOS the folder form cannot list the folders above a run's
      // checkout there, so the fix is to run dotnet format outside Orbit; elsewhere it is the folder form.
      expect(c.fix).toContain(process.platform === 'darwin' ? 'remove checks.format from .orbit/config.yaml and run dotnet format in CI' : `checks.format.command: ${JSON.stringify([dotnet!, 'format', 'whitespace', '--folder', '--verify-no-changes']).replace(/,/g, ', ')}`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 60_000);
});
