// `orbit doctor`'s checks.dotnet-packages (issue #10; ADR 0009, addendum): on macOS srt keeps the system trust service
// out of reach, so .NET cannot verify nuget.org's certificate and a NuGet restore from nuget.org cannot complete inside
// the sandbox. Doctor says so before a run, with the one command that fills the repository's NuGet cache outside it.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dotnetPackagesCheck, type DotnetPackagesInput } from '../../../src/cli/commands/doctor-dotnet.ts';
import { toolchainCacheRoot } from '../../../src/isolation/toolchains.ts';
import { defaultCheck, defaultConfig } from '../../../src/policy/config.ts';
import type { CheckDefinition, OrbitConfig } from '../../../src/policy/types.ts';
import { repoKeyFor } from '../../../src/storage/retention.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

const PACKAGED = '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup>\n  <ItemGroup><PackageReference Include="Newtonsoft.Json" Version="13.0.3" /></ItemGroup>\n</Project>\n';
const PLAIN = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>\n';

function config(checks: Partial<CheckDefinition>[], install: string[] | null = null): OrbitConfig {
  const c = defaultConfig('autonomous');
  c.checks = Object.fromEntries(checks.map((x) => [x.id!, { ...defaultCheck(x.id!), ...x } as CheckDefinition]));
  c.dependencies = { ...c.dependencies, install_command: install };
  return c;
}

/** A repository holding `files` (tracked, relative), an Orbit home, and the input doctor builds for macOS under srt. */
function world(files: Record<string, string>, cfg: OrbitConfig, opts: { repoName?: string } = {}) {
  const parent = temp('orbit-doctor-packages-');
  const repo = join(parent, opts.repoName ?? 'acme');
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), text);
  }
  mkdirSync(repo, { recursive: true });
  const orbitHome = temp('orbit-doctor-home-');
  const cache = join(toolchainCacheRoot(orbitHome, repoKeyFor(repo)), 'nuget');
  const input: DotnetPackagesInput = { config: cfg, repo, files: Object.keys(files), provider: { kind: 'sandbox-runtime' }, available: true, platform: 'darwin', orbitHome };
  return { repo, cache, input };
}

const BUILD = { id: 'build', command: ['dotnet', 'build', '-m:1'], mandatory: true };
const REASON = "cannot be downloaded inside the sandbox on macOS (it keeps the system trust service out of reach, so .NET cannot verify nuget.org's certificate)";

describe('dotnetPackagesCheck', () => {
  it('warns for a repository whose project references a package, with the exact command that fills its cache outside the sandbox', () => {
    const { repo, cache, input } = world({ 'acme.csproj': PACKAGED, 'Program.cs': '' }, config([BUILD]));
    const [c] = dotnetPackagesCheck(input);
    expect(c).toMatchObject({ id: 'checks.dotnet-packages', area: 'checks', status: 'warn' });
    expect(c!.summary).toBe(`this repository's NuGet packages ${REASON}: fill its NuGet cache outside the sandbox`);
    expect(c!.details).toEqual(['acme.csproj: PackageReference Newtonsoft.Json', `NuGet cache ${cache}: not created yet`]);
    expect(c!.missing).toBe("NuGet packages in this repository's cache, restored outside the sandbox");
    expect(c!.fix).toBe(
      `run once in a terminal, outside the sandbox, and again whenever the packages change: (cd ${repo} && NUGET_PACKAGES=${cache} dotnet restore -m:1); the dependency install and the checks then restore offline from that cache (Orbit turns NuGet's vulnerability audit off in the sandbox, where it cannot reach nuget.org; docs/troubleshooting.md, ".NET HTTP clients and NuGet restore on macOS")`,
    );
    expect(`${c!.summary} ${c!.fix}`).not.toMatch(/[\u2013\u2014]/);
  });

  it('fails when the dependency install restores from nuget.org and the cache is empty, mirroring the install command with -m:1', () => {
    for (const [install, restore] of [
      [['dotnet', 'restore', '--locked-mode', '-m:1'], 'dotnet restore --locked-mode -m:1'],
      [['dotnet', 'restore', 'src/Acme.sln'], 'dotnet restore src/Acme.sln -m:1'],
      [['dotnet', 'build', '-m:4'], 'dotnet build -m:1'],
    ] as const) {
      const { repo, cache, input } = world({ 'src/Acme/Acme.csproj': PACKAGED, 'src/Acme.sln': '' }, config([BUILD], [...install]));
      for (const state of ['missing', 'empty'] as const) {
        if (state === 'empty') mkdirSync(cache, { recursive: true });
        const [c] = dotnetPackagesCheck(input);
        expect(c!.status, `${install.join(' ')} ${state}`).toBe('fail');
        expect(c!.summary).toBe(`dependencies.install_command restores NuGet packages, which ${REASON}, and this repository's NuGet cache is empty: the dependency install would fail`);
        expect(c!.details.at(-1)).toBe(`NuGet cache ${cache}: ${state === 'missing' ? 'not created yet' : 'empty'}`);
        expect(c!.fix).toContain(`(cd ${repo} && NUGET_PACKAGES=${cache} ${restore});`);
      }
    }
  });

  it('only warns once the cache holds packages, or when the install does not restore, or doctor cannot tell', () => {
    const filled = world({ 'acme.csproj': PACKAGED }, config([BUILD], ['dotnet', 'restore', '-m:1']));
    mkdirSync(join(filled.cache, 'newtonsoft.json', '13.0.3'), { recursive: true });
    const [c] = dotnetPackagesCheck(filled.input);
    expect(c!.status).toBe('warn');
    expect(c!.details.at(-1)).toBe(`NuGet cache ${filled.cache}: holds 1 package`);
    for (const install of [['dotnet', 'build', '--no-restore', '-m:1'], ['make', 'deps']]) {
      const w = world({ 'acme.csproj': PACKAGED }, config([BUILD], install));
      expect(dotnetPackagesCheck(w.input)[0]!.status, install.join(' ')).toBe('warn');
    }
    const off = world({ 'acme.csproj': PACKAGED }, config([BUILD], ['dotnet', 'restore', '-m:1']));
    off.input.config.dependencies.install_existing_lockfile = false;
    expect(dotnetPackagesCheck(off.input)[0]!.status).toBe('warn');
  });

  it('reads central package management and lock files as packages, and project references alone as none', () => {
    for (const [files, detail] of [
      [{ 'Directory.Packages.props': '<Project />', 'src/Acme/Acme.csproj': PLAIN }, 'Directory.Packages.props'],
      [{ 'src/Acme/packages.lock.json': '{}', 'src/Acme/Acme.csproj': PLAIN }, 'src/Acme/packages.lock.json'],
      [{ 'Directory.Build.props': '<Project><ItemGroup><PackageReference Include="Acme.Analyzers" /></ItemGroup></Project>', 'acme.csproj': PLAIN }, 'Directory.Build.props: PackageReference Acme.Analyzers'],
    ] as const) {
      const [c] = dotnetPackagesCheck(world(files, config([BUILD])).input);
      expect(c?.details[0], detail).toBe(detail);
    }
    expect(dotnetPackagesCheck(world({ 'acme.csproj': PLAIN, 'lib/lib.csproj': PLAIN }, config([BUILD])).input)).toEqual([]);
  });

  it('restores each solution, or each project, when the repository root holds no single one to restore', () => {
    const sln = world({ 'a/A.sln': '', 'b/B.slnx': '', 'a/A.csproj': PACKAGED }, config([BUILD]));
    expect(dotnetPackagesCheck(sln.input)[0]!.fix).toContain(`(cd ${sln.repo} && export NUGET_PACKAGES=${sln.cache} && dotnet restore a/A.sln -m:1 && dotnet restore b/B.slnx -m:1);`);
    const projects = world({ 'src/A/A.csproj': PACKAGED, 'tests/B/B.fsproj': PLAIN }, config([{ ...BUILD, cwd: 'src/A' }]));
    expect(dotnetPackagesCheck(projects.input)[0]!.fix).toContain(`(cd ${projects.repo} && export NUGET_PACKAGES=${projects.cache} && dotnet restore src/A/A.csproj -m:1 && dotnet restore tests/B/B.fsproj -m:1);`);
  });

  // Review: the fill command mirrored the install too literally: `dotnet tool restore` alone cached no package of the
  // projects, and an install through sh -c that also restored local tools got a project restore alone. Local tools go to
  // the same cache (NUGET_PACKAGES), and `dotnet tool restore` then restores from it with no network (measured).
  it('fills the cache with the projects\' packages and the local tools alike, whatever part of them the install restores', () => {
    const MANIFEST = '{ "version": 1, "isRoot": true, "tools": { "csharpier": { "version": "0.30.6", "commands": ["dotnet-csharpier"] } } }\n';
    for (const [install, steps] of [
      [['dotnet', 'tool', 'restore'], 'dotnet restore -m:1 && dotnet tool restore'],
      [['sh', '-c', 'dotnet restore && dotnet tool restore'], 'dotnet restore -m:1 && dotnet tool restore'],
      [['dotnet', 'restore', '--locked-mode'], 'dotnet restore --locked-mode -m:1 && dotnet tool restore'],
      [null, 'dotnet restore -m:1 && dotnet tool restore'],
    ] as const) {
      const w = world({ 'acme.csproj': PACKAGED, '.config/dotnet-tools.json': MANIFEST }, config([BUILD], install ? [...install] : null));
      const [c] = dotnetPackagesCheck(w.input);
      expect(c!.fix, JSON.stringify(install)).toContain(`(cd ${w.repo} && export NUGET_PACKAGES=${w.cache} && ${steps});`);
    }
    // An install that restores local tools fills from the projects too, though the manifest is not at the root.
    const nested = world({ 'acme.csproj': PACKAGED }, config([BUILD], ['sh', '-c', 'dotnet restore && dotnet tool restore']));
    expect(dotnetPackagesCheck(nested.input)[0]!.fix).toContain(`(cd ${nested.repo} && export NUGET_PACKAGES=${nested.cache} && dotnet restore -m:1 && dotnet tool restore);`);
    // A repository whose only packages are local tools: the manifest shows them, and the install that restores them fails on an empty cache.
    const tools = world({ 'acme.csproj': PLAIN, '.config/dotnet-tools.json': MANIFEST }, config([BUILD], ['dotnet', 'tool', 'restore']));
    const [t] = dotnetPackagesCheck(tools.input);
    expect(t!.status).toBe('fail');
    expect(t!.details[0]).toBe('.config/dotnet-tools.json');
    expect(t!.fix).toContain(`(cd ${tools.repo} && NUGET_PACKAGES=${tools.cache} dotnet tool restore);`);
  });

  // Review: an MSBuild SDK that NuGet resolves is a package too (measured: the fill command's restore caches
  // Microsoft.Build.NoTargets/3.7.56, and a build then resolves it from the cache with no network); a floating version
  // is looked up at nuget.org at every restore, cache or not (measured: NU1301 with the cache filled), unless a lock
  // file pins it (measured: restores offline).
  it('reads an MSBuild SDK that NuGet resolves as a package: in a project, an Sdk element, or global.json', () => {
    for (const [files, detail] of [
      [{ 'build/dirs.proj': '<Project Sdk="Microsoft.Build.Traversal/4.1.0"><ItemGroup><ProjectReference Include="../src/**/*.csproj" /></ItemGroup></Project>', 'acme.csproj': PLAIN }, 'build/dirs.proj: MSBuild SDK Microsoft.Build.Traversal/4.1.0'],
      [{ 'tests/T/T.csproj': '<Project Sdk="MSTest.Sdk/3.6.0"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>' }, 'tests/T/T.csproj: MSBuild SDK MSTest.Sdk/3.6.0'],
      [{ 'acme.csproj': '<Project><Sdk Name="Microsoft.Build.NoTargets" Version="3.7.56" /><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>' }, 'acme.csproj: MSBuild SDK Microsoft.Build.NoTargets/3.7.56'],
      [{ 'global.json': '{ "msbuild-sdks": { "Microsoft.Build.Traversal": "4.1.0" } }', 'acme.csproj': PLAIN }, 'global.json: MSBuild SDK Microsoft.Build.Traversal/4.1.0'],
    ] as const) {
      const [c] = dotnetPackagesCheck(world(files, config([BUILD])).input);
      expect(c?.details[0], detail).toBe(detail);
    }
    // The SDKs that come with .NET are no package.
    expect(dotnetPackagesCheck(world({ 'acme.csproj': PLAIN, 'web/web.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>' }, config([BUILD])).input)).toEqual([]);
  });

  it('fails while a package version floats and no lock file pins it: a restore looks it up at nuget.org, cache or not', () => {
    const FLOATING = PACKAGED.replace('Version="13.0.3"', 'Version="13.*"');
    const w = world({ 'acme.csproj': FLOATING }, config([BUILD], ['dotnet', 'restore', '-m:1']));
    mkdirSync(join(w.cache, 'newtonsoft.json', '13.0.3'), { recursive: true });
    const [c] = dotnetPackagesCheck(w.input);
    expect(c!.status).toBe('fail');
    expect(c!.summary).toBe(`dependencies.install_command restores NuGet packages, which ${REASON}, and a package version floats, which every restore looks up at nuget.org: the dependency install would fail`);
    expect(c!.details).toEqual(['acme.csproj: PackageReference Newtonsoft.Json', 'acme.csproj: Newtonsoft.Json 13.* floats, so every restore looks it up at nuget.org', `NuGet cache ${w.cache}: holds 1 package`]);
    expect(c!.fix).toMatch(/; the dependency install and the checks then restore offline from that cache once no package version floats: pin each one the details name, or restore with a lock file \(RestorePackagesWithLockFile\) \(docs\/troubleshooting\.md, "\.NET HTTP clients and NuGet restore on macOS"\)$/);
    // Without an install that restores, a warning that says the same; with a lock file, nothing floats.
    expect(dotnetPackagesCheck(world({ 'acme.csproj': FLOATING }, config([BUILD])).input)[0]!.status).toBe('warn');
    const locked = world({ 'acme.csproj': FLOATING, 'packages.lock.json': '{}' }, config([BUILD], ['dotnet', 'restore', '-m:1']));
    mkdirSync(join(locked.cache, 'newtonsoft.json', '13.0.3'), { recursive: true });
    const [l] = dotnetPackagesCheck(locked.input);
    expect(l!.status).toBe('warn');
    expect(l!.details.some((d) => d.includes('floats'))).toBe(false);
  });

  it('names at most twenty restore targets, and says how many it leaves out', () => {
    const files = Object.fromEntries(Array.from({ length: 22 }, (_, i) => [`src/P${String(i).padStart(2, '0')}/P.csproj`, PACKAGED]));
    const fix = dotnetPackagesCheck(world(files, config([{ ...BUILD, cwd: 'src/P00' }])).input)[0]!.fix!;
    expect(fix.match(/dotnet restore src\/P\d\d\/P\.csproj -m:1/g)).toHaveLength(20);
    expect(fix).toContain('dotnet restore src/P19/P.csproj -m:1) (the first 20 of 22 projects; restore the other 2 the same way); the dependency install');
  });

  it('quotes a path the shell would split', () => {
    const w = world({ 'acme.csproj': PACKAGED }, config([BUILD]), { repoName: 'acme repo' });
    expect(dotnetPackagesCheck(w.input)[0]!.fix).toContain(`(cd '${w.repo}' && NUGET_PACKAGES=`);
  });

  it('says nothing on Linux, outside srt, with isolation unavailable, or where no check or install uses .NET', () => {
    const w = world({ 'acme.csproj': PACKAGED }, config([BUILD]));
    expect(dotnetPackagesCheck({ ...w.input, platform: 'linux' })).toEqual([]);
    expect(dotnetPackagesCheck({ ...w.input, provider: { kind: 'container' } })).toEqual([]);
    expect(dotnetPackagesCheck({ ...w.input, provider: null })).toEqual([]);
    expect(dotnetPackagesCheck({ ...w.input, available: false })).toEqual([]);
    // A check gets .NET's toolchain from its command or from .NET files at the checkout root or in its directory.
    const lint = world({ 'svc/acme.csproj': PACKAGED, 'web/package.json': '{}' }, config([{ id: 'lint', command: ['npm', 'run', 'lint'], cwd: 'web' }]));
    expect(dotnetPackagesCheck(lint.input)).toEqual([]);
    // The install alone restoring a .NET repository is enough.
    const install = world({ 'svc/acme.csproj': PACKAGED, 'web/package.json': '{}' }, config([{ id: 'lint', command: ['npm', 'run', 'lint'], cwd: 'web' }], ['dotnet', 'restore', 'svc/acme.csproj', '-m:1']));
    expect(dotnetPackagesCheck(install.input)[0]!.status).toBe('fail');
  });
});
