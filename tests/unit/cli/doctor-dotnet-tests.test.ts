// Issue #10 (reopened): Orbit never changes a check's processor count, but a check's own env may set
// DOTNET_PROCESSOR_COUNT=1 (the alternative to -m:1 the MSBuild fix names). Its test host then gets one processor, and
// xunit before 2.8 runs a test assembly's tests on a synchronization context with one thread per processor, so a test
// that blocks on async code (`.Result`, `.Wait()`) waits for a continuation that can never run, and the check times
// out. Measured: xunit 2.4.1, 2.6.1, 2.6.2 and 2.7.1 hang; 2.8.0 and 2.9.2 pass. `orbit doctor` names such a project.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dotnetTestsCheck } from '../../../src/cli/commands/doctor-dotnet.ts';
import { defaultCheck, defaultConfig } from '../../../src/policy/config.ts';
import type { CheckDefinition, OrbitConfig } from '../../../src/policy/types.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A repository holding `files`; returns it and the list of its files, as `git ls-files` would give them. */
function repoWith(files: Record<string, string>): { repo: string; files: string[] } {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-doctor-dotnet-')));
  dirs.push(repo);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), text);
  }
  return { repo, files: Object.keys(files).sort() };
}

function config(checks: Partial<CheckDefinition>[]): OrbitConfig {
  const c = defaultConfig('autonomous');
  c.checks = Object.fromEntries(checks.map((x) => [x.id!, { ...defaultCheck(x.id!), ...x } as CheckDefinition]));
  return c;
}

const testProject = (refs: string) => `<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>\n  <ItemGroup>\n${refs}\n  </ItemGroup>\n</Project>\n`;
const XUNIT_241 = testProject('    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />\n    <PackageReference Include="xunit" Version="2.4.1" />\n    <PackageReference Include="xunit.runner.visualstudio" Version="2.4.3" />');
const ONE = { DOTNET_PROCESSOR_COUNT: '1' };
const TEST_CHECK = { id: 'test', command: ['dotnet', 'test', '-m:1'], mandatory: true, env: ONE };

describe('dotnetTestsCheck', () => {
  it('warns when a .NET check that runs tests sets DOTNET_PROCESSOR_COUNT=1 in its env and a test project references xunit before 2.8', () => {
    const { repo, files } = repoWith({ 'acme.sln': '', 'src/Acme/Acme.csproj': testProject(''), 'tests/Acme.Tests/Acme.Tests.csproj': XUNIT_241 });
    const [c, ...rest] = dotnetTestsCheck({ config: config([TEST_CHECK, { id: 'lint', command: ['npm', 'run', 'lint'] }]), repo, files });
    expect(rest).toEqual([]);
    expect(c).toMatchObject({ id: 'checks.dotnet-tests', area: 'checks', status: 'warn' });
    expect(c!.summary).toBe('check test sets DOTNET_PROCESSOR_COUNT=1 in its env, which its test host gets too: xunit before 2.8 deadlocks a test that blocks on async code there, and the check times out');
    expect(c!.details).toEqual(['tests/Acme.Tests/Acme.Tests.csproj: xunit 2.4.1']);
    expect(c!.missing).toBe('a test host with its processors, or xunit 2.8 or later');
    expect(c!.fix).toBe('remove DOTNET_PROCESSOR_COUNT from checks.test.env and pass -m:1 to every dotnet build or test its command starts instead, which pins MSBuild to one node without touching the test host; or upgrade xunit to 2.8.0 or later (docs/troubleshooting.md, ".NET builds and MSBuild worker nodes")');
  });

  it('finds the version in central package management, a Version element, or a reference to xunit.core, in any case', () => {
    const { repo, files } = repoWith({
      'Directory.Packages.props': '<Project>\n  <ItemGroup>\n    <PackageVersion Include="xunit" Version="2.6.2" />\n  </ItemGroup>\n</Project>\n',
      'tests/A.Tests/A.Tests.csproj': testProject('    <PackageReference Include="xunit" />'),
      'tests/B.Tests/B.Tests.fsproj': testProject('    <PackageReference Include="XUnit.Core">\n      <Version>[2.7.1]</Version>\n    </PackageReference>'),
      'tests/C.Tests/C.Tests.csproj': testProject('    <PackageReference Include="xunit" VersionOverride="2.9.3" />'),
    });
    const [c] = dotnetTestsCheck({ config: config([TEST_CHECK]), repo, files });
    expect(c!.details.slice(0, 2)).toEqual(['tests/A.Tests/A.Tests.csproj: xunit 2.6.2', 'tests/B.Tests/B.Tests.fsproj: XUnit.Core 2.7.1']);
    expect(c!.details).toHaveLength(2);
  });

  it('says nothing for xunit 2.8 or later, or a version it cannot read (a property)', () => {
    for (const version of ['2.8.0', '2.9.3', '$(XunitVersion)']) {
      const { repo, files } = repoWith({ 'acme.sln': '', 'tests/Acme.Tests/Acme.Tests.csproj': XUNIT_241.replace('Version="2.4.1"', `Version="${version}"`) });
      expect(dotnetTestsCheck({ config: config([TEST_CHECK]), repo, files }), version).toEqual([]);
    }
  });

  it('says nothing for a project whose xunit.runner.json lifts the thread limit, which ends the deadlock', () => {
    const { repo, files } = repoWith({ 'acme.sln': '', 'tests/Acme.Tests/Acme.Tests.csproj': XUNIT_241, 'tests/Acme.Tests/xunit.runner.json': '{ "maxParallelThreads": -1 }\n' });
    expect(dotnetTestsCheck({ config: config([TEST_CHECK]), repo, files })).toEqual([]);
  });

  it('still warns for an xunit.runner.json that keeps one thread or cannot be read, and for xunit 1', () => {
    const { repo, files } = repoWith({
      'acme.sln': '',
      'tests/A.Tests/A.Tests.csproj': XUNIT_241,
      'tests/A.Tests/xunit.runner.json': '{ "maxParallelThreads": 1 }\n',
      'tests/B.Tests/B.Tests.csproj': XUNIT_241,
      'tests/B.Tests/xunit.runner.json': '{ "maxParallelThreads": -1, }\n',
      'tests/C.Tests/C.Tests.csproj': XUNIT_241.replace('Version="2.4.1"', 'Version="1.9.2"'),
      // Not counted: a root project whose xunit.runner.json lifts the limit, and an Update item, which references nothing.
      'Root.Tests.csproj': XUNIT_241,
      'xunit.runner.json': '{ "maxParallelThreads": 4 }\n',
      'tests/D.Tests/D.Tests.csproj': testProject('    <PackageReference Update="xunit" Version="2.4.1" />'),
    });
    // A tracked file that is gone from the working tree is skipped.
    const [c] = dotnetTestsCheck({ config: config([TEST_CHECK]), repo, files: [...files, 'tests/Gone/Gone.csproj'] });
    expect(c!.details).toEqual(['tests/A.Tests/A.Tests.csproj: xunit 2.4.1', 'tests/B.Tests/B.Tests.csproj: xunit 2.4.1', 'tests/C.Tests/C.Tests.csproj: xunit 1.9.2']);
  });

  // Orbit no longer gives every check one processor, so only a check's own env can.
  it('says nothing when the check\'s env leaves the processor count alone, or sets another', () => {
    const { repo, files } = repoWith({ 'acme.sln': '', 'tests/Acme.Tests/Acme.Tests.csproj': XUNIT_241 });
    expect(dotnetTestsCheck({ config: config([{ ...TEST_CHECK, env: {} }]), repo, files })).toEqual([]);
    expect(dotnetTestsCheck({ config: config([{ ...TEST_CHECK, env: { DOTNET_PROCESSOR_COUNT: '8' } }]), repo, files })).toEqual([]);
  });

  it('says nothing when no check runs .NET tests: a dotnet build, or no .NET at all', () => {
    const { repo, files } = repoWith({ 'acme.sln': '', 'tests/Acme.Tests/Acme.Tests.csproj': XUNIT_241 });
    for (const command of [['dotnet', 'build'], ['dotnet', 'build', 'tests/Acme.Tests']]) expect(dotnetTestsCheck({ config: config([{ id: 'build', command, env: ONE }]), repo, files }), command.join(' ')).toEqual([]);
    const plain = repoWith({ 'package.json': '{}', 'tools/Gen/Gen.csproj': XUNIT_241 });
    expect(dotnetTestsCheck({ config: config([{ id: 'test', command: ['npm', 'test'], env: ONE }]), repo: plain.repo, files: plain.files })).toEqual([]);
  });

  it('counts a check that runs .NET through a script or make when its command names tests, and no other', () => {
    const { repo, files } = repoWith({ 'acme.sln': '', 'tests/Acme.Tests/Acme.Tests.csproj': XUNIT_241 });
    const [c] = dotnetTestsCheck({ config: config([{ id: 'unit', command: ['make', 'test-all'], env: ONE }, { id: 'e2e', command: ['./scripts/run-tests.sh'], env: ONE }, { id: 'ci', command: ['make', 'ci'], env: ONE }]), repo, files });
    expect(c!.status).toBe('warn');
    expect(c!.summary).toMatch(/^checks unit, e2e set DOTNET_PROCESSOR_COUNT=1 in their env, which their test host gets too/);
    expect(c!.fix).toMatch(/^remove DOTNET_PROCESSOR_COUNT from checks\.unit\.env and checks\.e2e\.env and pass -m:1 to every dotnet build or test their commands start instead/);
  });
});
