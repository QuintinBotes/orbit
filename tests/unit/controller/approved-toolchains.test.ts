// An approved operation's sandbox gets the toolchain profile a check gets (issue #26; ADR 0009 and its addendum): the
// repository's dependency caches, private build state, and for .NET the private home prepared as a check's, the NIS
// domain name rule and the runner's early stop for a refused MSBuild worker node. Before, the controller ran an approved
// command with a fresh private HOME and nothing else: every dotnet command died at its first-run step (measured under
// srt on macOS: "The system cannot open the device or file specified. : 'NuGet-Migrations'", the named mutex under
// /tmp/.dotnet), there was no NuGet cache and no NIS rule, and a build without -m:1 waited out the 300 s limit.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { operationKey, runApprovedOperation, type GuardedOperation } from '../../../src/controller/authorization.ts';
import { repoKey } from '../../../src/controller/context.ts';
import { NUGET_MIGRATIONS_DIR } from '../../../src/evidence/runner.ts';
import { NoIsolation } from '../../../src/isolation/none.ts';
import type { IsolationProvider, SandboxProfile, WrappedCommand } from '../../../src/isolation/types.ts';
import type { Operation } from '../../../src/policy/types.ts';
import { giveRepository, makeUnitLab, type UnitLab } from './coverage-helpers.ts';

let lab: UnitLab;
afterEach(() => lab?.cleanup());

const MSBUILD_FAILURE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/environment', 'msbuild-node-pipe-denied.failure.txt'), 'utf8');
const grant = { decisionId: 'dec-grant', approvedBy: 'acme-dev' };

function guarded(command: string, rule = 'actions.change_permissions'): GuardedOperation {
  const op: Operation = { kind: 'bash', command };
  return { op, key: operationKey(op), summary: `run \`${command}\``, denial: `${rule}: denied`, rule };
}

interface Wrap {
  argv: string[];
  profile: SandboxProfile & { readablePaths: string[] };
  env: Record<string, string>;
  homePrepared: boolean;
}

/**
 * A provider that records what it is asked to wrap and runs `stand_in` instead (by default a process that exits 0), so
 * no real toolchain runs here.
 */
function recording(standIn: (env: Record<string, string>) => string[] = () => [process.execPath, '-e', '0']): { provider: IsolationProvider; wraps: Wrap[] } {
  const wraps: Wrap[] = [];
  const inner = new NoIsolation();
  const provider = {
    kind: 'sandbox-runtime' as const,
    available: () => inner.available(),
    wrap(argv: string[], profile: SandboxProfile, opts: { cwd: string; env: Record<string, string> }): WrappedCommand {
      wraps.push({ argv, profile: profile as Wrap['profile'], env: opts.env, homePrepared: existsSync(join(opts.env.HOME!, NUGET_MIGRATIONS_DIR, '1')) });
      return inner.wrap(standIn(opts.env), profile, opts);
    },
  };
  return { provider: provider as IsolationProvider, wraps };
}

async function dotnetLab(provider: IsolationProvider, hosts: string[] = []): Promise<{ worktree: string; cache: string }> {
  lab = makeUnitLab({
    tweak: (c) => {
      c.mode = 'supervised';
      c.network.allowed_hosts.push(...hosts);
    },
    path: ['PREFLIGHT'],
    deps: { isolationFor: () => provider },
  });
  const { worktree } = await giveRepository(lab, { 'acme.sln': '', 'apps/Acme.csproj': '<Project Sdk="Microsoft.NET.Sdk" />\n', 'apps/Acme.cs': 'namespace Acme;\n' });
  return { worktree, cache: join(lab.home, 'toolchains', repoKey(lab.repo), 'nuget') };
}

describe('approved operations get the toolchain profile of a check (issue #26)', () => {
  it('runs an approved command in a .NET repository with the repository\'s NuGet cache read-only beneath its own, private build state, a prepared home and the NIS rule', async () => {
    const r = recording();
    const { cache } = await dotnetLab(r.provider);
    const out = await runApprovedOperation(lab.ctx(), 1, guarded('chmod +x apps/run.sh && dotnet build apps -m:1'), grant);
    expect(out).toMatchObject({ state: 'SUCCEEDED', exit_code: 0 });
    const [w] = r.wraps;
    expect(w!.argv).toEqual(['/bin/sh', '-c', 'chmod +x apps/run.sh && dotnet build apps -m:1']);
    // The repository's cache, read-only: this command installs nothing. It is NuGet's fallback folder beneath a global
    // packages folder of the command's own, so what the approved command fetches on its hosts it can write, as it could
    // with the private HOME it had before.
    expect(w!.env.NUGET_FALLBACK_PACKAGES).toBe(cache);
    expect(w!.profile.readablePaths).toContain(cache);
    expect(w!.profile.writablePaths).not.toContain(cache);
    expect(existsSync(cache)).toBe(true);
    expect(w!.env.NUGET_PACKAGES!.startsWith(join(lab.ctx().runDir, 'authorization', 'attempt-1'))).toBe(true);
    expect(w!.profile.writablePaths.some((p) => w!.env.NUGET_PACKAGES!.startsWith(p))).toBe(true);
    // Build state private to this approved command, beside its output.
    expect(w!.env.NUGET_HTTP_CACHE_PATH!.startsWith(join(lab.ctx().runDir, 'authorization', 'attempt-1'))).toBe(true);
    expect(w!.profile.writablePaths.some((p) => w!.env.NUGET_HTTP_CACHE_PATH!.startsWith(p))).toBe(true);
    // The private home a check gets: the SDK's first run has nothing to do there, and nothing reaches /tmp/.dotnet.
    expect(w!.env).toMatchObject({ DOTNET_CLI_HOME: w!.env.HOME, DOTNET_NOLOGO: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', EnableSourceControlManagerQueries: 'false' });
    expect(w!.homePrepared).toBe(true);
    // .NET's HTTP clients read the NIS domain name; NuGet's audit cannot reach a package source this sandbox does not allow.
    expect(w!.profile.nisDomainName).toBe(true);
    expect(w!.env.NuGetAudit).toBe('false');
    expect(readFileSync(join(lab.ctx().runDir, out.path!), 'utf8')).toContain("[toolchains dotnet: the repository's read-only, caches of the command's own writable]");
    // The scratch is gone afterwards, the command's own packages with it.
    expect(existsSync(w!.env.NUGET_HTTP_CACHE_PATH!)).toBe(false);
    expect(existsSync(w!.env.NUGET_PACKAGES!)).toBe(false);
  });

  it('lets an approved package install write the repository\'s cache, as the install step does, and passes the hosts its sandbox allows', async () => {
    const r = recording();
    const { cache } = await dotnetLab(r.provider, ['api.nuget.org']);
    await runApprovedOperation(lab.ctx(), 1, guarded('dotnet add apps package Newtonsoft.Json --version 13.0.3'), grant);
    const [w] = r.wraps;
    expect(w!.env.NUGET_PACKAGES).toBe(cache);
    expect(w!.profile.writablePaths).toContain(cache);
    expect(w!.profile.readablePaths).not.toContain(cache);
    expect(w!.profile.allowedHosts).toContain('api.nuget.org');
    // The audit runs as the repository configures it where the sandbox reaches the package source, off macOS.
    expect(w!.env.NuGetAudit).toBe(process.platform === 'darwin' ? 'false' : undefined);
  });

  // A review of #26 found that an approved install made every detected toolchain's cache writable, not just the one
  // whose executable installs: an approved `dotnet add package` in a repository that also has a go.mod could write the
  // repository's Go module cache for every later run.
  it('lets an approved package install write only the cache of the toolchain that installs; another toolchain fetches into its own', async () => {
    const r = recording();
    const { worktree, cache } = await dotnetLab(r.provider, ['api.nuget.org']);
    writeFileSync(join(worktree, 'go.mod'), 'module example.com/acme\n\ngo 1.21\n');
    const out = await runApprovedOperation(lab.ctx(), 1, guarded('dotnet add apps package Newtonsoft.Json --version 13.0.3'), grant);
    const [w] = r.wraps;
    expect(w!.env.NUGET_PACKAGES).toBe(cache);
    expect(w!.profile.writablePaths).toContain(cache);
    const gomod = join(dirname(cache), 'gomod');
    expect(w!.profile.writablePaths).not.toContain(gomod);
    expect(w!.profile.readablePaths).toContain(gomod);
    expect(w!.env.GOMODCACHE).not.toBe(gomod);
    expect(w!.env.GOPROXY!.startsWith(`file://${gomod}/cache/download,`)).toBe(true);
    // Its output says which cache it could write.
    expect(readFileSync(join(lab.ctx().runDir, out.path!), 'utf8')).toContain("[toolchains dotnet, go: the repository's dependency cache of dotnet writable, since the command installs its packages; for the others the repository's read-only, caches of the command's own writable]");
  });

  // srt exits 0 when it is stopped (measured), and the controller stops an approved command when the run is cancelled.
  // A review of #26 found that the receipt then said exit 0, as if the command had succeeded.
  it('records no exit code for an approved command the run\'s cancellation stopped', async () => {
    const standIn = `process.on('SIGTERM', () => process.exit(0)); console.log('started'); setTimeout(() => {}, 120000);`;
    const r = recording(() => [process.execPath, '-e', standIn]);
    await dotnetLab(r.provider);
    const cancel = new AbortController();
    setTimeout(() => cancel.abort(), 1_000);
    const out = await runApprovedOperation(lab.ctx(cancel.signal), 1, guarded('chmod +x apps/run.sh && dotnet build apps -m:1'), grant);
    expect(out.exit_code).toBeNull();
    expect(readFileSync(join(lab.ctx().runDir, out.path!), 'utf8')).toContain('[stopped: the run was cancelled]');
  }, 30_000);

  it('gives an approved command in a repository without a detected toolchain nothing of a toolchain', async () => {
    const r = recording();
    lab = makeUnitLab({ tweak: (c) => void (c.mode = 'supervised'), path: ['PREFLIGHT'], deps: { isolationFor: () => r.provider } });
    await giveRepository(lab);
    await runApprovedOperation(lab.ctx(), 1, guarded('chmod +x apps/calc.mjs'), grant);
    const [w] = r.wraps;
    expect(w!.profile.nisDomainName).toBeFalsy();
    expect(w!.env.NUGET_PACKAGES).toBeUndefined();
    expect(w!.profile.readablePaths.some((p) => p.includes(join(lab.home, 'toolchains')))).toBe(false);
  });

  it('stops an approved command as soon as MSBuild records a refused worker node, with the note and the command pinned to one node', async () => {
    // Stands in for `dotnet build` under srt: MSBuild records the refused node in its temp directory, then waits; srt
    // exits 0 on SIGTERM, so a command Orbit stopped must not read as one that succeeded (measured under srt).
    const standIn = `const fs = require('node:fs'); const dir = process.env.TMPDIR + '/MSBuildTempacme'; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(dir + '/MSBuild_pid-4242_01234567.failure.txt', ${JSON.stringify(MSBUILD_FAILURE)}); process.on('SIGTERM', () => process.exit(0)); setTimeout(() => {}, 120000);`;
    const r = recording(() => [process.execPath, '-e', standIn]);
    await dotnetLab(r.provider);
    const started = Date.now();
    const out = await runApprovedOperation(lab.ctx(), 1, guarded('chmod +x apps/run.sh && dotnet build apps'), grant);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(out.state).toBe('SUCCEEDED');
    expect(out.exit_code).not.toBe(0);
    const text = readFileSync(join(lab.ctx().runDir, out.path!), 'utf8');
    expect(text).toContain('the sandbox of the approved command denied MSBuild node (pid 4242) its named pipe /tmp/MSBuild4242 (System.Net.Sockets.SocketException (13): Permission denied); MSBuild waits 30 s for each of ten node starts before it fails, so Orbit stopped the approved command.');
    expect(text).toContain('Fix: the command to approve: ["/bin/sh", "-c", "chmod +x apps/run.sh && dotnet build apps -m:1"]');
    expect(out.excerpt).toContain('so Orbit stopped the approved command');
  }, 60_000);
});
