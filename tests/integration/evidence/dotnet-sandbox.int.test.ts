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

const PROJECT = {
  'acme.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>\n',
  'Program.cs': 'System.Console.WriteLine("hello acme");\n',
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
async function doctorProbe(command: string[]) {
  const repo = temp('orbit-dotnet-repo-');
  const config = defaultConfig('autonomous');
  config.checks = { build: { ...defaultCheck('build'), command, mandatory: true } };
  return checkSandboxCheck({ config, repo, provider, available: true, env: process.env, homeDir: homedir() });
}

describe.skipIf(skip !== null)(skip === null ? 'a dotnet check under the srt check profile' : `a dotnet check under the srt check profile skipped: ${skip}`, () => {
  async function build(files: Record<string, string>) {
    const e = await runnerEnv([checkDef('build', { command: [dotnet!, 'build'], timeout_seconds: 300 })], { isolation: provider, files });
    envs.push(e);
    const [r] = await runChecks({ ...e.ctx, candidate: e.candidate, checkIds: ['build'] });
    return { r: r!, log: readFileSync(r!.logPath, 'utf8'), e };
  }

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
    const c = await doctorProbe([dotnet!, 'build']);
    expect(c.details).toEqual(['build: "dotnet help" ran in the sandbox']);
    expect(c.status).toBe('pass');
  }, 120_000);
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
    expect(c.details[0]).toContain('Operation not permitted');
    expect(existsSync(join(outside, 'cache'))).toBe(false);
  }, 120_000);
});
