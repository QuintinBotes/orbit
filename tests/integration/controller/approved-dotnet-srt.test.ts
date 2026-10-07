// An approved operation that runs .NET, under the real srt (issue #26). The controller ran an approved command with a
// fresh private HOME and nothing of the check's .NET profile, so every dotnet command was the SDK's first run, whose
// NuGet migrations take a named mutex under /tmp/.dotnet that the sandbox refuses: measured on macOS (SDK 9.0.305),
// "The system cannot open the device or file specified. : 'NuGet-Migrations'", exit 1. A build without -m:1 of a
// project with two references would then have waited out MSBuild's node retries, the whole 300 s limit. Skipped where
// srt or dotnet is missing.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { operationKey, runApprovedOperation, type GuardedOperation } from '../../../src/controller/authorization.ts';
import { SandboxRuntimeIsolation } from '../../../src/isolation/sandbox-runtime.ts';
import { which } from '../../../src/isolation/util.ts';
import { giveRepository, makeUnitLab, type UnitLab } from '../../unit/controller/coverage-helpers.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const provider = new SandboxRuntimeIsolation({ orbitInstallDir: ROOT });
const probe = await provider.available();
const dotnet = which('dotnet', process.env.PATH) ?? [join(homedir(), '.dotnet', 'dotnet')].find((p) => existsSync(p)) ?? null;
const skip = !probe.ok ? `srt unavailable: ${probe.detail}` : dotnet === null ? 'dotnet is not installed' : null;

const TFM = '<TargetFramework>net$(NETCoreAppMaximumVersion)</TargetFramework>';
/** A library referencing two others, so a build without -m:1 starts MSBuild worker nodes. No packages. */
const PROJECTS: Record<string, string> = {
  'Directory.Build.props': '<Project />\n',
  'Directory.Build.targets': '<Project />\n',
  '.gitignore': 'bin/\nobj/\n',
  'apps/Left/Left.csproj': `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>${TFM}</PropertyGroup></Project>\n`,
  'apps/Left/Left.cs': 'namespace Acme; public static class Left { public static int One => 1; }\n',
  'apps/Right/Right.csproj': `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>${TFM}</PropertyGroup></Project>\n`,
  'apps/Right/Right.cs': 'namespace Acme; public static class Right { public static int Two => 2; }\n',
  'apps/App/App.csproj': `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>${TFM}</PropertyGroup><ItemGroup><ProjectReference Include="../Left/Left.csproj" /><ProjectReference Include="../Right/Right.csproj" /></ItemGroup></Project>\n`,
  'apps/App/App.cs': 'namespace Acme; public static class App { public static int Three => Left.One + Right.Two; }\n',
  'apps/build.sh': '#!/bin/sh\nexit 0\n',
};

let lab: UnitLab;
afterEach(() => lab?.cleanup());

function guarded(command: string): GuardedOperation {
  const op = { kind: 'bash' as const, command };
  return { op, key: operationKey(op), summary: `run \`${command}\``, denial: 'actions.change_permissions: denied', rule: 'actions.change_permissions' };
}

async function approve(command: string) {
  lab = makeUnitLab({ tweak: (c) => void (c.mode = 'supervised'), path: ['PREFLIGHT'], deps: { isolationFor: () => provider, hostEnv: { PATH: process.env.PATH } } });
  await giveRepository(lab, PROJECTS);
  const out = await runApprovedOperation(lab.ctx(), 1, guarded(command), { decisionId: 'dec-grant', approvedBy: 'acme-dev' });
  return { out, text: out.path ? readFileSync(join(lab.ctx().runDir, out.path), 'utf8') : '' };
}

describe.skipIf(skip !== null)(skip === null ? 'an approved .NET command under srt' : `an approved .NET command under srt skipped: ${skip}`, () => {
  it('builds with the check\'s .NET profile: past the SDK\'s first run, in a home of its own', async () => {
    const { out, text } = await approve(`chmod +x apps/build.sh && ${dotnet} build apps/App -m:1`);
    expect(text).not.toContain('NuGet-Migrations');
    expect(out.exit_code, text).toBe(0);
    expect(text).toContain('Build succeeded.');
  }, 240_000);

  it('stops a build without -m:1 within seconds once MSBuild records the refused worker node, with the command pinned', async () => {
    const started = Date.now();
    const { out, text } = await approve(`chmod +x apps/build.sh && ${dotnet} build apps/App`);
    expect(Date.now() - started).toBeLessThan(120_000);
    expect(out.exit_code, text).not.toBe(0);
    expect(text).toMatch(/the sandbox of the approved command denied MSBuild node \(pid \d+\) its named pipe \/tmp\/MSBuild\d+ /);
    expect(text).toContain(`Fix: the command to approve: ["/bin/sh", "-c", "chmod +x apps/build.sh && ${dotnet} build apps/App -m:1"]`);
  }, 240_000);
});
