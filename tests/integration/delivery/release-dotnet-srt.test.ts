// A deploy command that runs .NET, under the real srt (issue #26). A release command ran with a fresh private HOME and
// nothing of the check's .NET profile, so its dotnet command was the SDK's first run, whose NuGet migrations take a named
// mutex under /tmp/.dotnet that the sandbox refuses ("The system cannot open the device or file specified. :
// 'NuGet-Migrations'", measured on macOS with SDK 9.0.305): every .NET deploy failed. Skipped where srt or dotnet is missing.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { deliver } from '../../../src/delivery/deliver.ts';
import { performRelease } from '../../../src/delivery/release.ts';
import { SandboxRuntimeIsolation } from '../../../src/isolation/sandbox-runtime.ts';
import { toolchainCacheRoot } from '../../../src/isolation/toolchains.ts';
import { which } from '../../../src/isolation/util.ts';
import { makeLab, type Lab } from './harness.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const provider = new SandboxRuntimeIsolation({ orbitInstallDir: ROOT });
const probe = await provider.available();
const dotnet = which('dotnet', process.env.PATH) ?? [join(homedir(), '.dotnet', 'dotnet')].find((p) => existsSync(p)) ?? null;
const skip = !probe.ok ? `srt unavailable: ${probe.detail}` : dotnet === null ? 'dotnet is not installed' : null;

let lab: Lab | null = null;
afterEach(() => {
  lab?.cleanup();
  lab = null;
});

describe.skipIf(skip !== null)(skip === null ? 'a .NET deploy command under srt' : `a .NET deploy command under srt skipped: ${skip}`, () => {
  it('builds with the check\'s .NET profile: past the SDK\'s first run, in a home of its own', async () => {
    const l = (lab = makeLab({
      mode: 'release',
      tweak: (cfg) => {
        cfg.delivery.pull_request = 'ready';
        cfg.actions.merge = true;
        cfg.actions.deploy_production = true;
        cfg.release = {
          merge: { method: 'squash', require_checks: [], delete_branch: false, mark_ready: true },
          environments: { preview: { deploy_command: [dotnet!, 'build', 'Acme.csproj', '-m:1'], allowed_branches: ['orbit/*'], require_ci_green: false, network_hosts: [], timeout_seconds: 240, verify_command: null } },
        };
      },
    }));
    const c = l.candidate('<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net$(NETCoreAppMaximumVersion)</TargetFramework></PropertyGroup></Project>\n', 'Acme.csproj');
    const ev = l.evidenceFor(c);
    const rv = l.reviewFor(c);
    const d = await deliver({ run: l.deliveryRun, candidate: c, evidence: ev, review: rv, snapshot: l.snapshot, ledger: l.ledger(), client: l.fake, clock: l.clock, report: { title: 't', summary: 's' } });
    const r = await performRelease({
      run: l.deliveryRun, candidate: c, evidence: ev, review: rv, snapshot: l.snapshot, ledger: l.ledger(), client: l.fake, clock: l.clock,
      commit: d.commit, pr: d.pr?.number ?? null, contractMerge: false, environment: 'preview', readiness: () => ({ ok: true, reasons: [] }),
      isolation: provider, workDir: join(l.dir, 'runs', l.runId), toolchainCacheRoot: toolchainCacheRoot(join(l.dir, 'orbit'), 'abcdefabcdef'),
    });
    expect(r.deploy?.output).not.toContain('NuGet-Migrations');
    expect(r.deploy).toMatchObject({ environment: 'preview', exitCode: 0, isolation: 'sandbox-runtime' });
    expect(r.deploy!.output).toContain('Build succeeded.');
  }, 300_000);
});
