// `orbit doctor`'s checks.dotnet-audit (issue #10; ADR 0009, addendum). NuGet's vulnerability audit cannot reach
// nuget.org from the sandbox on macOS, so it adds warning NU1900 to every restore there, which a repository that treats
// warnings as errors turns into a failed restore: the install step and every restoring check failed after the cache
// was filled. Orbit sets NuGetAudit=false for every .NET process in the sandbox, which MSBuild reads from the
// environment, but a project that sets NuGetAudit itself overrides the environment. Doctor names such a project when
// warnings are errors, with the change that lets Orbit's setting through.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dotnetAuditCheck, dotnetPackagesCheck, type DotnetPackagesInput } from '../../../src/cli/commands/doctor-dotnet.ts';
import { defaultCheck, defaultConfig } from '../../../src/policy/config.ts';
import type { CheckDefinition, OrbitConfig } from '../../../src/policy/types.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

const project = (props = '') => `<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup><TargetFramework>net9.0</TargetFramework>${props}</PropertyGroup>\n  <ItemGroup><PackageReference Include="Newtonsoft.Json" Version="13.0.3" /></ItemGroup>\n</Project>\n`;
const props = (body: string) => `<Project>\n  ${body}\n</Project>\n`;
const STRICT = project('<TreatWarningsAsErrors>true</TreatWarningsAsErrors>');
const AUDIT_ON = props('<PropertyGroup><NuGetAudit>true</NuGetAudit></PropertyGroup>');

function config(checks: Partial<CheckDefinition>[], install: string[] | null = null): OrbitConfig {
  const c = defaultConfig('autonomous');
  c.checks = Object.fromEntries(checks.map((x) => [x.id!, { ...defaultCheck(x.id!), ...x } as CheckDefinition]));
  c.dependencies = { ...c.dependencies, install_command: install };
  return c;
}

/** A repository holding `files` (tracked, relative) and the input doctor builds for macOS under srt. */
function input(files: Record<string, string>, cfg: OrbitConfig): DotnetPackagesInput {
  const repo = temp('orbit-doctor-audit-');
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), text);
  }
  return { config: cfg, repo, files: Object.keys(files), provider: { kind: 'sandbox-runtime' }, available: true, platform: 'darwin', orbitHome: temp('orbit-doctor-home-') };
}

const BUILD = { id: 'build', command: ['dotnet', 'build', '-m:1'], mandatory: true };
const RESTORE = ['dotnet', 'restore', '-m:1'];
const CONDITIONAL = `<NuGetAudit Condition="'$(NuGetAudit)' == ''">true</NuGetAudit>`;
const DOCS = '(docs/troubleshooting.md, ".NET HTTP clients and NuGet restore on macOS")';

describe('dotnetAuditCheck', () => {
  it('says nothing for a repository that treats warnings as errors but leaves NuGetAudit to Orbit, which turns the audit off in the sandbox', () => {
    expect(dotnetAuditCheck(input({ 'acme.csproj': STRICT }, config([BUILD], RESTORE)))).toEqual([]);
  });

  it('fails when a project turns the audit on over Orbit\'s NuGetAudit=false while warnings are errors: the install and the checks would fail on NU1900', () => {
    const i = input({ 'Directory.Build.props': AUDIT_ON, 'src/Acme/Acme.csproj': STRICT, 'tests/Acme.Tests/Acme.Tests.csproj': project() }, config([BUILD, { id: 'test', command: ['dotnet', 'test', '-m:1'], mandatory: false }], RESTORE));
    const [c, ...rest] = dotnetAuditCheck(i);
    expect(rest).toEqual([]);
    expect(c).toMatchObject({ id: 'checks.dotnet-audit', area: 'checks', status: 'fail' });
    expect(c!.summary).toBe(
      "NuGet's vulnerability audit cannot reach nuget.org from the sandbox on macOS, and Directory.Build.props turns it on where Orbit turns it off: with warnings as errors, its warning NU1900 fails dependencies.install_command and checks build, test",
    );
    expect(c!.details).toEqual(['Directory.Build.props: NuGetAudit true', 'src/Acme/Acme.csproj: TreatWarningsAsErrors true']);
    expect(c!.missing).toBe('a restore in the sandbox without the vulnerability audit, or NU1900 kept a warning');
    expect(c!.fix).toBe(`in Directory.Build.props, set NuGetAudit only where nothing has set it yet: ${CONDITIONAL}, so Orbit's NuGetAudit=false reaches the restore in the sandbox and the audit stays on everywhere else ${DOCS}`);
    expect(`${c!.summary} ${c!.fix}`).not.toMatch(/[\u2013\u2014]/);
  });

  it('reads warnings as errors from MSBuild properties, a check\'s command and a check\'s env', () => {
    for (const [files, check, detail] of [
      [{ 'Directory.Build.targets': props('<PropertyGroup><MSBuildTreatWarningsAsErrors>True</MSBuildTreatWarningsAsErrors></PropertyGroup>') }, BUILD, 'Directory.Build.targets: MSBuildTreatWarningsAsErrors True'],
      [{ 'build/strict.props': props('<PropertyGroup><WarningsAsErrors>$(WarningsAsErrors);NU1900;NU1903</WarningsAsErrors></PropertyGroup>') }, BUILD, 'build/strict.props: WarningsAsErrors $(WarningsAsErrors);NU1900;NU1903'],
      [{}, { ...BUILD, command: ['dotnet', 'build', '-m:1', '-warnaserror'] }, 'check build: -warnaserror'],
      [{}, { ...BUILD, command: ['dotnet', 'build', '-m:1', '/warnaserror:NU1900,CS0618'] }, 'check build: /warnaserror:NU1900,CS0618'],
      [{}, { ...BUILD, command: ['dotnet build -c Release -p:TreatWarningsAsErrors=true -m:1'], shell: true }, 'check build: -p:TreatWarningsAsErrors=true'],
      [{}, { ...BUILD, env: { TreatWarningsAsErrors: 'true' } }, 'check build: env TreatWarningsAsErrors=true'],
    ] as const) {
      const [c] = dotnetAuditCheck(input({ 'acme.csproj': project(), 'Directory.Packages.props': AUDIT_ON, ...files }, config([{ ...check, command: [...check.command] }])));
      expect(c?.status, detail).toBe('fail');
      expect(c!.details, detail).toEqual(['Directory.Packages.props: NuGetAudit true', detail]);
    }
    // -warnaserror with codes that leave NU1900 out, and WarningsAsErrors without it, keep NU1900 a warning.
    for (const [files, command] of [
      [{}, ['dotnet', 'build', '-m:1', '-warnaserror:CS0618']],
      [{ 'Directory.Build.props': props('<PropertyGroup><WarningsAsErrors>NU1903</WarningsAsErrors></PropertyGroup>') }, ['dotnet', 'build', '-m:1']],
    ] as const) {
      expect(dotnetAuditCheck(input({ 'acme.csproj': project(), 'Directory.Packages.props': AUDIT_ON, ...files }, config([{ ...BUILD, command: [...command] }]))), command.join(' ')).toEqual([]);
    }
  });

  it('says nothing once NuGetAudit defers to what is set already, or NU1900 is kept a warning, or the audit is off', () => {
    const deferring: Record<string, string>[] = [
      { 'Directory.Build.props': props(`<PropertyGroup>${CONDITIONAL}</PropertyGroup>`) },
      { 'Directory.Build.props': props(`<PropertyGroup Condition=" '$(NuGetAudit)' == '' "><NuGetAudit>true</NuGetAudit></PropertyGroup>`) },
      { 'Directory.Build.props': AUDIT_ON, 'Directory.Build.targets': props('<PropertyGroup><NoWarn>$(NoWarn);NU1900</NoWarn></PropertyGroup>') },
      { 'Directory.Build.props': AUDIT_ON, 'Directory.Build.targets': props('<PropertyGroup><WarningsNotAsErrors>$(WarningsNotAsErrors);NU1900</WarningsNotAsErrors></PropertyGroup>') },
      { 'Directory.Build.props': props('<PropertyGroup><NuGetAudit>false</NuGetAudit></PropertyGroup>') },
      { 'Directory.Build.props': props('<!-- <PropertyGroup><NuGetAudit>true</NuGetAudit></PropertyGroup> -->') },
      // NoWarn as a package's metadata is about that package; NuGetAudit true there is no property either.
      { 'Directory.Build.props': AUDIT_ON.replace('</Project>', '<ItemGroup><PackageReference Update="Acme.Tools"><WarningsAsErrors>NU1900</WarningsAsErrors></PackageReference></ItemGroup></Project>'), 'acme.csproj': project() },
    ];
    for (const files of deferring) {
      expect(dotnetAuditCheck(input({ 'acme.csproj': STRICT, ...files }, config([BUILD], RESTORE))), JSON.stringify(files)).toEqual([]);
    }
    // NuGetAudit=false on a dotnet command is a global property, which a project cannot override.
    expect(dotnetAuditCheck(input({ 'acme.csproj': STRICT, 'Directory.Build.props': AUDIT_ON }, config([{ ...BUILD, command: ['dotnet', 'build', '-m:1', '-p:NuGetAudit=false'] }])))).toEqual([]);
  });

  it('says nothing when nothing restores in the sandbox: checks with --no-restore or --no-build, and no install', () => {
    const files = { 'acme.csproj': STRICT, 'Directory.Build.props': AUDIT_ON };
    const checks = [
      { ...BUILD, command: ['dotnet', 'build', '--no-restore', '-m:1'] },
      { id: 'test', command: ['dotnet', 'test', '--no-build', '-m:1'] },
      { id: 'format', command: ['dotnet', 'format', 'whitespace', '--folder', '--verify-no-changes'] },
    ];
    expect(dotnetAuditCheck(input(files, config(checks)))).toEqual([]);
    expect(dotnetAuditCheck(input(files, config(checks, ['dotnet', 'build', '--no-restore', '-m:1'])))).toEqual([]);
  });

  it('only warns when every failing restore is optional, may happen through make or a script, or rests on a condition', () => {
    const files = { 'acme.csproj': STRICT, 'Directory.Build.props': AUDIT_ON };
    const optional = dotnetAuditCheck(input(files, config([{ ...BUILD, mandatory: false }])))[0]!;
    expect(optional.status).toBe('warn');
    expect(optional.summary).toMatch(/its warning NU1900 fails check build$/);
    const make = dotnetAuditCheck(input(files, config([{ id: 'ci', command: ['make', 'ci'] }])))[0]!;
    expect(make.status).toBe('warn');
    expect(make.summary).toMatch(/its warning NU1900 may fail check ci$/);
    const release = { 'acme.csproj': project(`<TreatWarningsAsErrors Condition="'$(Configuration)' == 'Release'">true</TreatWarningsAsErrors>`), 'Directory.Build.props': AUDIT_ON };
    const conditional = dotnetAuditCheck(input(release, config([BUILD], RESTORE)))[0]!;
    expect(conditional.status).toBe('warn');
    expect(conditional.details).toEqual(['Directory.Build.props: NuGetAudit true', 'acme.csproj: TreatWarningsAsErrors true (under a condition)']);
    expect(conditional.summary).toMatch(/its warning NU1900 may fail dependencies\.install_command and check build$/);
  });

  it('names a check whose own env or command turns the audit back on', () => {
    const [env] = dotnetAuditCheck(input({ 'acme.csproj': STRICT }, config([{ ...BUILD, env: { NuGetAudit: 'true' } }])));
    expect(env!.status).toBe('fail');
    expect(env!.details).toEqual(['check build: env NuGetAudit=true', 'acme.csproj: TreatWarningsAsErrors true']);
    expect(env!.fix).toBe(`remove NuGetAudit from checks.build.env, so Orbit's NuGetAudit=false reaches the restore in the sandbox ${DOCS}`);
    const [cmd] = dotnetAuditCheck(input({ 'acme.csproj': STRICT }, config([{ ...BUILD, command: ['dotnet', 'build', '-m:1', '-p:NuGetAudit=true'] }])));
    expect(cmd!.details).toEqual(['check build: -p:NuGetAudit=true', 'acme.csproj: TreatWarningsAsErrors true']);
    expect(cmd!.fix).toBe(`remove -p:NuGetAudit=true from checks.build.command, so Orbit's NuGetAudit=false reaches the restore in the sandbox ${DOCS}`);
    // The dependency install has a command and no env of its own.
    const [install] = dotnetAuditCheck(input({ 'acme.csproj': STRICT }, config([{ ...BUILD, command: ['dotnet', 'build', '--no-restore', '-m:1'] }], ['dotnet', 'restore', '-m:1', '-p:NuGetAudit=true'])));
    expect(install!.details).toEqual(['dependencies.install_command: -p:NuGetAudit=true', 'acme.csproj: TreatWarningsAsErrors true']);
    expect(install!.fix).toBe(`remove -p:NuGetAudit=true from dependencies.install_command, so Orbit's NuGetAudit=false reaches the restore in the sandbox ${DOCS}`);
    // Both a check's env and a project: each has to let Orbit's setting through.
    const [both] = dotnetAuditCheck(input({ 'acme.csproj': STRICT, 'Directory.Build.props': AUDIT_ON }, config([{ ...BUILD, env: { NuGetAudit: 'true' } }])));
    expect(both!.summary).toMatch(/, and checks\.build\.env and Directory\.Build\.props turn it on where Orbit turns it off: /);
    expect(both!.fix).toBe(`in Directory.Build.props, set NuGetAudit only where nothing has set it yet: ${CONDITIONAL}; remove NuGetAudit from checks.build.env, so Orbit's NuGetAudit=false reaches the restore in the sandbox and the audit stays on everywhere else ${DOCS}`);
  });

  it('says nothing on Linux, outside srt, with isolation unavailable, or for a repository without packages', () => {
    const i = input({ 'acme.csproj': STRICT, 'Directory.Build.props': AUDIT_ON }, config([BUILD], RESTORE));
    expect(dotnetAuditCheck(i)).toHaveLength(1);
    expect(dotnetAuditCheck({ ...i, platform: 'linux' })).toEqual([]);
    expect(dotnetAuditCheck({ ...i, provider: { kind: 'container' } })).toEqual([]);
    expect(dotnetAuditCheck({ ...i, available: false })).toEqual([]);
    const plain = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net9.0</TargetFramework><TreatWarningsAsErrors>true</TreatWarningsAsErrors></PropertyGroup></Project>\n';
    expect(dotnetAuditCheck(input({ 'acme.csproj': plain, 'Directory.Build.props': AUDIT_ON }, config([BUILD], RESTORE)))).toEqual([]);
  });
});

describe('dotnetPackagesCheck, of the vulnerability audit', () => {
  it('says the audit is off in the sandbox, and does not promise a restore that checks.dotnet-audit says fails', () => {
    const [ok] = dotnetPackagesCheck(input({ 'acme.csproj': STRICT }, config([BUILD])));
    expect(ok!.fix).toMatch(/; the dependency install and the checks then restore offline from that cache \(Orbit turns NuGet's vulnerability audit off in the sandbox, where it cannot reach nuget\.org; docs\/troubleshooting\.md, "\.NET HTTP clients and NuGet restore on macOS"\)$/);
    expect(ok!.fix).not.toMatch(/NU1900/);
    const [blocked] = dotnetPackagesCheck(input({ 'acme.csproj': STRICT, 'Directory.Build.props': AUDIT_ON }, config([BUILD])));
    expect(blocked!.fix).toMatch(/; the dependency install and the checks then restore offline from that cache once the vulnerability audit no longer fails them, as checks\.dotnet-audit says \(docs\/troubleshooting\.md, "\.NET HTTP clients and NuGet restore on macOS"\)$/);
  });
});
