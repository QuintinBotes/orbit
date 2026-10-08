// Test-file recognition (ADR 0011, issue #30). One predicate decides what is a test for the new-evidence rule of the
// evidence report, the test-file-deleted weakening signal, the unexplained-architecture filter and the review packet.
// A file wrongly counted as a test lets a criterion pass on a green check that says nothing about the change, so every
// rule here is tied to what the language's test runner runs, and each positive case has a negative one beside it.
import { describe, expect, it, vi } from 'vitest';
import { declaresCargoPackage, gitTreeReader, isDotnetTestProject, isTestPath, isTestPathOnEitherRevision, loadTestLayout, NO_LAYOUT, type TestLayout, type TreeReader } from '../../../src/policy/test-files.ts';

const yes = (paths: string[], layout?: TestLayout) => {
  for (const p of paths) expect(isTestPath(p, layout), p).toBe(true);
};
const no = (paths: string[], layout?: TestLayout) => {
  for (const p of paths) expect(isTestPath(p, layout), p).toBe(false);
};

function layout(dotnet: Record<string, boolean>, cargo: Record<string, boolean> = {}): TestLayout {
  return { dotnetProjects: new Map(Object.entries(dotnet)), cargoManifests: new Map(Object.entries(cargo)) };
}

/**
 * The diff the evidence comparison reads for a Rust source: every line of the candidate file, as git prints it with
 * full context (one hunk from line 1). Each line is marked '+', '-' or ' '.
 */
function wholeDiff(lines: string[]): string {
  const old = lines.filter((l) => !l.startsWith('+')).length;
  const cand = lines.filter((l) => !l.startsWith('-')).length;
  return ['diff --git a/src/lib.rs b/src/lib.rs', '--- a/src/lib.rs', '+++ b/src/lib.rs', `@@ -${old ? 1 : 0},${old} +${cand ? 1 : 0},${cand} @@`, ...lines].join('\n');
}

/** A whole-file diff whose candidate is `context` followed by `added`, and whose base is `context` followed by `removed`. */
function diff(added: string[], removed: string[] = [], context: string[] = []): string {
  return wholeDiff([...context.map((l) => ` ${l}`), ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)]);
}

describe('path conventions', () => {
  it('keeps the JavaScript/TypeScript, Python and Go conventions as they were', () => {
    yes(['src/a.test.ts', 'web/b.spec.jsx', '__tests__/c.js', 'tests/unit/d.ts', 'pkg/test_e.py', 'pkg/f_test.py', 'tests/conftest.py', 'cmd/g_test.go', 'e2e/login.spec.ts', 'testing/h.go', 'specs/i.vue']);
    no(['src/a.ts', 'testing.md', 'tests/fixtures/data.json', 'contest.py', 'cmd/main.go', 'tests/README.md']);
  });

  it('Java, Kotlin, Scala and Groovy: the test source sets Maven, Gradle, sbt and Android compile tests from, and Bazel javatests', () => {
    yes([
      'src/test/java/com/acme/CalculatorTest.java',
      'src/test/java/com/acme/CalculatorTests.java',
      'core/src/test/java/com/acme/StoreIT.java',
      'src/test/java/com/acme/support/Builders.java',
      'src/test/kotlin/com/acme/CalculatorTest.kt',
      'modules/calc/src/test/scala/acme/CalculatorSpec.scala',
      'src/it/scala/acme/StoreSpec.scala',
      'src/integrationTest/java/com/acme/StoreIT.java',
      'app/src/androidTest/java/com/acme/MainActivityTest.kt',
      'app/src/testDebug/java/com/acme/DebugTest.java',
      'app/src/testRelease/java/com/acme/ReleaseTest.java',
      'shared/src/commonTest/kotlin/acme/CalculatorTest.kt',
      'src/test/groovy/acme/CalculatorSpec.groovy',
      'javatests/com/acme/CalculatorTest.java',
    ]);
    // The build never runs a test-named class of the main source set, and a package called test is still production.
    no([
      'src/main/java/com/acme/LoadTest.java',
      'src/main/java/com/acme/CalculatorTests.java',
      'src/main/java/org/acme/test/TestContext.java',
      'src/main/kotlin/acme/CalculatorTest.kt',
      'src/main/scala/acme/CalculatorSpec.scala',
      'src/testFixtures/java/com/acme/Builders.java',
      // Helper source sets hold builders and fakes, not tests, like testFixtures.
      'src/testUtils/java/com/acme/Builders.java',
      'src/testSupport/kotlin/acme/Fakes.kt',
      'lib/src/testHelpers/java/com/acme/Clock.java',
      'CalculatorTest.java',
      'app/CalculatorIT.java',
      'build.gradle.kts',
      'src/test/resources/expected.json',
      // Final review: resources are copied, never compiled, whatever their extension.
      'src/test/resources/Foo.java',
      'src/integrationTest/resources/fixtures/Sample.kt',
      'app/src/androidTest/resources/Fixture.groovy',
    ]);
  });

  it('Ruby: RSpec specs under spec/ and Minitest tests under test/', () => {
    yes(['spec/models/user_spec.rb', 'spec/user_spec.rb', 'engines/billing/spec/invoice_spec.rb', 'test/models/user_test.rb', 'test/user_test.rb']);
    no(['spec/spec_helper.rb', 'spec/support/factories.rb', 'test/test_helper.rb', 'lib/user_spec.rb', 'app/models/user_test.rb', 'app/models/test_result.rb']);
  });

  it('PHP: PHPUnit and Pest test classes under tests/', () => {
    yes(['tests/Unit/CalculatorTest.php', 'tests/Feature/Http/LoginTest.php', 'src/Symfony/Component/Console/Tests/ApplicationTest.php', 'test/CalculatorTest.php']);
    no(['src/CalculatorTest.php', 'app/Services/AbTest.php', 'tests/TestCase.php', 'tests/bootstrap.php', 'tests/Pest.php']);
  });

  it('Swift: Swift package test targets under Tests/ and Xcode test target folders', () => {
    yes(['Tests/AcmeTests/CalculatorTests.swift', 'Tests/AcmeTests/Support/Builders.swift', 'AcmeAppTests/CalculatorTests.swift', 'AcmeAppUITests/LaunchTests.swift', 'ios/AcmeAppTests/CalculatorTests.swift']);
    no(['Sources/Acme/Calculator.swift', 'Sources/Acme/CalculatorTests.swift', 'Package.swift', 'Tests/AcmeTests/Resources/data.json']);
    // Swift Package Manager compiles everything under Sources/ into the module: a folder there named like a test target is production.
    no(['Sources/AcmeTests/Calculator.swift', 'Sources/Acme/LoadTests/Runner.swift', 'Sources/Acme/Tests/Fixture.swift']);
  });

  it('C and C++: sources under test/ or tests/, and the GoogleTest _test and _unittest suffixes', () => {
    yes(['tests/test_parser.c', 'test/parser_test.cpp', 'tests/helpers.h', 'src/parser_test.cc', 'absl/strings/str_cat_test.cc', 'src/parser_unittest.cc', 'lib/parser_tests.cpp', 'Tests/parser.hpp']);
    // A C file is not a test by name alone: test_and_set.c and self_test.c are production names in C.
    no(['src/test_and_set.c', 'src/self_test.c', 'src/test_parser.c', 'src/parser.cc', 'include/acme/testing.h', 'src/contest.cpp']);
    // Nor a C++ file named for a production feature that ends in test: a built-in self test, an A/B test.
    no(['src/self_test.cc', 'firmware/power_on_self_test.cpp', 'src/ab_test.cc', 'experiments/a_b_test.cpp']);
  });

  it('Elixir: ExUnit tests under test/', () => {
    yes(['test/acme/calculator_test.exs', 'apps/billing/test/invoice_test.exs']);
    no(['test/test_helper.exs', 'test/support/fixtures.ex', 'lib/acme/calculator_test.exs', 'lib/acme/calculator.ex']);
  });

  it('Dart and Flutter: _test.dart files under test/ and integration_test/', () => {
    yes(['test/calculator_test.dart', 'packages/core/test/src/parser_test.dart', 'integration_test/app_test.dart']);
    no(['lib/calculator_test.dart', 'test/helpers.dart', 'lib/src/test_utils.dart']);
  });

  it('counts no language it has no rule for, so a missing test is never hidden', () => {
    no(['tests/CalculatorSpec.hs', 'spec/calculator_spec.lua', 'test/calculator_test.clj', 'tests/test_calc.zig']);
  });
});

describe('.NET: a source file is a test when the project that owns it is a test project', () => {
  const repo = layout({ 'src/Acme': false, 'tests/Acme.Tests': true, 'tests/Acme.Tests/Samples/App': false, 'tests/Acme.FsTests': true, 'tests/Acme.VbTests': true });

  it('counts every source of a test project, helpers and nested folders included, in C#, F#, Visual Basic and Razor', () => {
    yes(['tests/Acme.Tests/CalculatorTests.cs', 'tests/Acme.Tests/CalculatorTest.cs', 'tests/Acme.Tests/Support/Builders.cs', 'tests/Acme.FsTests/Tests.fs', 'tests/Acme.VbTests/CalculatorTests.vb', 'tests/Acme.Tests/Pages/CounterTests.razor'], repo);
  });

  it('does not count a test-named file of a production project: dotnet test never runs it', () => {
    no(['src/Acme/Test.cs', 'src/Acme/CalculatorTests.cs', 'src/Acme/CalculatorTest.cs', 'src/Acme/Tests/CalculatorTests.cs'], repo);
  });

  it('takes the nearest project file: a production project inside a test project folder is production', () => {
    no(['tests/Acme.Tests/Samples/App/Program.cs'], repo);
  });

  it('does not count the project file, configuration or data of a test project, or a source no project owns', () => {
    no(['tests/Acme.Tests/Acme.Tests.csproj', 'tests/Acme.Tests/xunit.runner.json', 'tests/Acme.Tests/appsettings.json', 'scripts/build.cs', 'CalculatorTests.cs'], repo);
  });

  it('counts nothing of .NET without the layout: a path alone cannot say whether its project is a test project', () => {
    no(['tests/Acme.Tests/CalculatorTests.cs', 'test/Acme.Tests/CalculatorTests.cs']);
    no(['tests/Acme.Tests/CalculatorTests.cs'], NO_LAYOUT);
  });
});

describe('isDotnetTestProject: what makes a project file a test project', () => {
  const project = (body: string, sdk = 'Microsoft.NET.Sdk') => `<Project Sdk="${sdk}">\n  <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>\n${body}\n</Project>\n`;
  const ref = (id: string) => project(`  <ItemGroup>\n    <PackageReference Include="${id}" Version="1.0.0" />\n  </ItemGroup>`);

  it('a reference to the test SDK or a package that makes a test project, IsTestProject, or the MSTest project SDK', () => {
    for (const id of ['Microsoft.NET.Test.Sdk', 'xunit', 'xunit.v3', 'MSTest', 'TUnit', 'microsoft.net.test.sdk']) expect(isDotnetTestProject(ref(id)), id).toBe(true);
    expect(isDotnetTestProject(project('  <ItemGroup>\n    <PackageReference Include="NUnit" Version="3.14.0" />\n    <PackageReference Include="NUnit3TestAdapter" Version="4.5.0" />\n    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />\n  </ItemGroup>'))).toBe(true);
    expect(isDotnetTestProject(project('  <ItemGroup><PackageReference Version="2.9.2" Include=\'xunit\' /></ItemGroup>'))).toBe(true);
    expect(isDotnetTestProject(project('  <PropertyGroup>\n    <IsTestProject>true</IsTestProject>\n  </PropertyGroup>'))).toBe(true);
    expect(isDotnetTestProject(project('', 'MSTest.Sdk/3.6.4'))).toBe(true);
    expect(isDotnetTestProject('<Project>\n  <Sdk Name="MSTest.Sdk" Version="3.6.4" />\n</Project>\n')).toBe(true);
  });

  // Final review: a shared library of NUnit or MSTest base classes references the framework without the test SDK, and
  // dotnet test does not run it. Measured with SDK 9.0.305 on one solution: dotnet test ran the project referencing
  // NUnit with NUnit3TestAdapter and Microsoft.NET.Test.Sdk, and neither one referencing only NUnit 3.14.0 nor one
  // referencing only MSTest.TestFramework 3.6.4 (their failing tests never ran). It did run one referencing only xunit
  // 2.9.2, whose xunit.core sets IsTestProject; xunit.v3 refuses to build a library, and TUnit's engine and the MSTest
  // metapackage (which brings the test SDK) make a test project too.
  it('not a library that references only a test framework dotnet test does not run without the test SDK: NUnit, MSTest.TestFramework', () => {
    for (const id of ['NUnit', 'nunit', 'MSTest.TestFramework']) expect(isDotnetTestProject(ref(id)), id).toBe(false);
  });

  it('not a library, a reference to an assertion or analyzer package alone, a commented-out reference or a central version entry', () => {
    expect(isDotnetTestProject(project(''))).toBe(false);
    for (const id of ['xunit.assert', 'xunit.abstractions', 'xunit.extensibility.core', 'NUnit.Analyzers', 'FluentAssertions', 'Moq', 'MSTest.Analyzers', 'Microsoft.NET.Test.Sdk.Extensions']) expect(isDotnetTestProject(ref(id)), id).toBe(false);
    expect(isDotnetTestProject(project('  <!-- <ItemGroup><PackageReference Include="xunit" Version="2.9.2" /></ItemGroup> -->'))).toBe(false);
    expect(isDotnetTestProject(project('  <ItemGroup><PackageVersion Include="xunit" Version="2.9.2" /></ItemGroup>'))).toBe(false);
  });

  it('not a project that says IsTestProject false, whatever it references, nor one that says true only under a condition', () => {
    expect(isDotnetTestProject(`${ref('Microsoft.NET.Test.Sdk')}`.replace('</Project>', '  <PropertyGroup><IsTestProject>false</IsTestProject></PropertyGroup>\n</Project>'))).toBe(false);
    expect(isDotnetTestProject(project('  <PropertyGroup>\n    <IsTestProject Condition="\'$(Configuration)\' == \'Debug\'">true</IsTestProject>\n  </PropertyGroup>'))).toBe(false);
  });

  it('ignores whatever sits under a condition: a conditional property group, item group or reference, and Choose', () => {
    const conditional = [
      `  <PropertyGroup Condition="'$(Configuration)' == 'Debug'">\n    <IsTestProject>true</IsTestProject>\n  </PropertyGroup>`,
      `  <ItemGroup Condition="'$(TargetFramework)' == 'net8.0'">\n    <PackageReference Include="xunit" Version="2.9.2" />\n  </ItemGroup>`,
      `  <ItemGroup>\n    <PackageReference Condition="'$(CI)' != ''" Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />\n  </ItemGroup>`,
      `  <ItemGroup>\n    <PackageReference Include="NUnit" Condition="'$(CI)' != ''">\n      <Version>4.2.2</Version>\n    </PackageReference>\n  </ItemGroup>`,
      `  <Choose>\n    <When Condition="'$(X)' == '1'">\n      <ItemGroup><PackageReference Include="xunit" /></ItemGroup>\n    </When>\n    <Otherwise>\n      <PropertyGroup><IsTestProject>true</IsTestProject></PropertyGroup>\n    </Otherwise>\n  </Choose>`,
      // A condition holding '>' or '/>' does not end its element early.
      `  <ItemGroup Condition="'$(LangVersion)' > '9' and '$(Path)' != 'a/>b'">\n    <PackageReference Include="xunit" />\n  </ItemGroup>`,
    ];
    for (const body of conditional) expect(isDotnetTestProject(project(body)), body).toBe(false);
    // An unconditional declaration beside a conditional group still counts.
    expect(isDotnetTestProject(project(`  <ItemGroup Condition="'$(X)' == '1'"><PackageReference Include="Moq" /></ItemGroup>\n  <ItemGroup><PackageReference Include="xunit" /></ItemGroup>`))).toBe(true);
    // IsTestProject false wins even under a condition: in doubt, a project is not a test project.
    expect(isDotnetTestProject(ref('xunit').replace('</Project>', `  <PropertyGroup Condition="'$(X)' == '1'"><IsTestProject>false</IsTestProject></PropertyGroup>\n</Project>`))).toBe(false);
  });

  it('a legacy .NET Framework test project: a Reference to a test framework assembly, or the test project type', () => {
    const legacy = (body: string) => `<?xml version="1.0" encoding="utf-8"?>\n<Project ToolsVersion="15.0" DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">\n  <PropertyGroup>\n    <OutputType>Library</OutputType>\n    <TargetFrameworkVersion>v4.8</TargetFrameworkVersion>\n  </PropertyGroup>\n${body}\n  <Import Project="$(MSBuildToolsPath)\\Microsoft.CSharp.targets" />\n</Project>\n`;
    const reference = (include: string) => legacy(`  <ItemGroup>\n    <Reference Include="System" />\n    <Reference Include="${include}">\n      <HintPath>..\\packages\\x\\lib\\net45\\x.dll</HintPath>\n    </Reference>\n  </ItemGroup>`);
    for (const include of ['nunit.framework, Version=3.13.3.0, Culture=neutral, PublicKeyToken=2638cd05610744eb', 'xunit.core, Version=2.4.2.0, Culture=neutral, PublicKeyToken=8d05b1bb7a6fdb6c', 'Microsoft.VisualStudio.QualityTools.UnitTestFramework, Version=10.1.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a, processorArchitecture=MSIL', 'Microsoft.VisualStudio.TestPlatform.TestFramework', 'NUnit.Framework']) {
      expect(isDotnetTestProject(reference(include)), include).toBe(true);
    }
    expect(isDotnetTestProject(legacy('  <PropertyGroup>\n    <ProjectTypeGuids>{3AC096D0-A1C2-E12C-1390-A8335801FDAB};{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}</ProjectTypeGuids>\n  </PropertyGroup>'))).toBe(true);
    for (const include of ['System.Data', 'xunit.assert, Version=2.4.2.0', 'xunit.abstractions', 'Moq, Version=4.18.0.0', 'nunit.framework.extensions']) expect(isDotnetTestProject(reference(include)), include).toBe(false);
    expect(isDotnetTestProject(legacy('  <PropertyGroup>\n    <ProjectTypeGuids>{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}</ProjectTypeGuids>\n  </PropertyGroup>'))).toBe(false);
  });
});

describe('Rust: a crate\'s tests/ directory, and #[test] functions the change adds to a source file', () => {
  const crates = layout({}, { '': true, 'crates/calc': true, 'crates/calc/fuzz': false });
  const workspace = layout({}, { '': false, 'crates/calc': true });

  it('counts the integration tests cargo builds from a crate\'s tests/ directory, and their modules', () => {
    yes(['tests/calc.rs', 'tests/common/mod.rs', 'crates/calc/tests/mul.rs'], crates);
    no(['src/lib.rs', 'src/tests.rs', 'benches/mul.rs', 'examples/demo.rs', 'build.rs', 'crates/calc/src/lib.rs'], crates);
  });

  it('does not count tests/ beside a virtual workspace manifest: cargo builds no tests there', () => {
    no(['tests/root.rs'], workspace);
    yes(['crates/calc/tests/mul.rs'], workspace);
    no(['crates/calc/fuzz/tests/x.rs'], crates);
  });

  it('counts nothing by path without the layout, since a crate root is a property of the tree', () => {
    no(['tests/calc.rs', 'crates/calc/tests/mul.rs']);
  });

  it('counts a crate root under src/ whose change adds a #[test] function: cargo test runs the library\'s and every binary\'s', () => {
    for (const attr of ['#[test]', '    #[test]', '#[tokio::test]', '#[tokio::test(flavor = "multi_thread")]', '#[async_std::test]', '#[rstest]', '#[test_case(2, 3 => 6)]', '#[test] fn inline() {}']) {
      expect(isTestPath('src/lib.rs', crates, diff([attr, 'fn mul_works() { assert_eq!(mul(2, 3), 6); }'])), attr).toBe(true);
    }
    for (const p of ['src/main.rs', 'src/bin/tool.rs', 'src/bin/tool/main.rs', 'crates/calc/src/lib.rs']) expect(isTestPath(p, crates, diff(['#[test]', 'fn t() {}'])), p).toBe(true);
  });

  it('counts a module of src/ only when the crate compiles it, as loadTestLayout finds from the mod declarations', () => {
    const d = diff(['#[test]', 'fn mul_works() {}']);
    expect(isTestPath('src/calc/ops.rs', crates, d)).toBe(false);
    expect(isTestPath('src/calc/ops.rs', { ...crates, compiledRust: new Set(['src/calc/ops.rs']) }, d)).toBe(true);
    expect(isTestPath('src/bin/tool/args.rs', { ...crates, compiledRust: new Set(['src/bin/tool/args.rs']) }, d)).toBe(true);
  });

  // Measured with cargo 1.98: cargo test ran the #[test] functions of src/lib.rs, src/bin/tool.rs and tests/t.rs, and
  // none in benches/, examples/, build.rs, a src/ file no mod declares, or a tests/ directory beside a virtual
  // workspace manifest.
  it('does not count a #[test] cargo test never runs: outside a crate, beside a virtual workspace manifest, in benches/, examples/ or build.rs', () => {
    const d = diff(['#[test]', 'fn mul_works() { assert_eq!(calc::mul(2, 3), 6); }']);
    expect(isTestPath('tests/mul.rs', workspace, d)).toBe(false);
    expect(isTestPath('scripts/tool.rs', NO_LAYOUT, d)).toBe(false);
    expect(isTestPath('src/lib.rs', NO_LAYOUT, d)).toBe(false);
    for (const p of ['benches/mul.rs', 'examples/demo.rs', 'build.rs', 'crates/calc/fuzz/src/lib.rs', 'crates/calc/benches/mul.rs']) expect(isTestPath(p, crates, d), p).toBe(false);
  });

  it('does not count an added test function cargo test ignores', () => {
    for (const attrs of [['#[test]', '#[ignore]'], ['#[ignore = "slow"]', '#[test]'], ['#[test]', '// needs a database', '#[ignore]'], ['#[tokio::test]', '#[cfg_attr(miri, ignore)]'], ['#[test] #[ignore] fn inline() {}']]) {
      expect(isTestPath('src/lib.rs', crates, diff([...attrs, 'fn slow() {}'])), attrs.join(' ')).toBe(false);
    }
    // One ignored test does not hide another the change adds.
    expect(isTestPath('src/lib.rs', crates, diff(['#[test]', '#[ignore]', 'fn slow() {}', '', '#[test]', 'fn fast() {}']))).toBe(true);
  });

  it('does not count a change that adds no test function: a cfg(test) module alone, a comment, a removed or unchanged test, another attribute', () => {
    const notATest: string[] = [
      diff(['#[cfg(test)]', 'mod tests {', '    use super::*;', '}']),
      diff(['// #[test]', '/// #[test] in a doc comment']),
      diff(['pub fn mul(a: i32, b: i32) -> i32 { a * b }'], ['#[test]', 'fn mul_works() {}']),
      diff(['    assert_eq!(mul(2, 3), 6);'], ['    assert_eq!(mul(2, 3), 5);'], ['#[test]']),
      diff(['#[testing]', '#[derive(Debug)]', '#[should_panic]', '#[cfg_attr(test, derive(Default))]']),
      ['diff --git a/src/lib.rs b/src/lib.rs', '--- a/src/lib.rs', '+++ b/src/lib.rs'].join('\n'),
    ];
    for (const d of notATest) expect(isTestPath('src/lib.rs', crates, d), d).toBe(false);
    expect(isTestPath('src/lib.rs', crates)).toBe(false);
  });

  // Final review of #30 to #33: the diff had no context lines, so a group's unchanged #[ignore] was out of sight, and a
  // change to the test attribute alone of an ignored test (made async, given another row) counted as a test cargo runs.
  it('judges an added test attribute by its whole attribute group in the candidate, unchanged lines included', () => {
    const asyncIgnored = wholeDiff([' #[cfg(test)]', ' mod tests {', '-    #[test]', '+    #[tokio::test]', '     #[ignore]', '     async fn mul_works() {}', ' }']);
    expect(isTestPath('src/lib.rs', crates, asyncIgnored)).toBe(false);
    const rowOfIgnored = wholeDiff(['+#[test_case(2)]', ' #[test_case(1)]', ' #[ignore = "slow"]', ' fn mul_works(n: i32) {}']);
    expect(isTestPath('src/lib.rs', crates, rowOfIgnored)).toBe(false);
    expect(isTestPath('src/lib.rs', crates, wholeDiff([' #[ignore]', ' // why', '+#[test]', ' fn slow() {}']))).toBe(false);
    // The unchanged #[ignore] of another test does not hide the one the change adds.
    expect(isTestPath('src/lib.rs', crates, wholeDiff([' #[test]', ' #[ignore]', ' fn slow() {}', ' ', '+#[test]', '+fn fast() {}']))).toBe(true);
    // An attribute that spans lines is one attribute, added when any line of it is.
    expect(isTestPath('src/lib.rs', crates, wholeDiff([' #[test_case(', '+    2,', '     1', ' )]', ' fn t(n: i32) {}']))).toBe(true);
    expect(isTestPath('src/lib.rs', crates, wholeDiff([' #[test_case(', '+    2,', '     1', ' )]', ' #[ignore]', ' fn t(n: i32) {}']))).toBe(false);
  });

  it('judges only a diff that shows the whole candidate file: one without context, or one cut short, adds no test', () => {
    const head = ['diff --git a/src/lib.rs b/src/lib.rs', '--- a/src/lib.rs', '+++ b/src/lib.rs'];
    expect(isTestPath('src/lib.rs', crates, [...head, '@@ -14 +14 @@', '-    #[test]', '+    #[tokio::test]'].join('\n'))).toBe(false);
    expect(isTestPath('src/lib.rs', crates, [...head, '@@ -20,0 +21,2 @@', '+#[test]', '+fn t() {}'].join('\n'))).toBe(false);
    expect(isTestPath('src/lib.rs', crates, [...head, '@@ -1,0 +1,2 @@', '+#[test]', '+fn t() {}', '@@ -9,0 +11,1 @@', '+// more'].join('\n'))).toBe(false);
    // Cut short by the output limit: the header promises more lines than arrived (here the #[ignore] after the #[test]).
    const whole = wholeDiff(['+#[test]', '+#[ignore]', '+fn slow() {}']).split('\n');
    expect(isTestPath('src/lib.rs', crates, [...whole.slice(0, -2), '[orbit: output truncated: 20 bytes dropped after the first 8388608]', ''].join('\n'))).toBe(false);
    expect(isTestPath('src/lib.rs', crates, `${whole.join('\n')}\n`)).toBe(false);
    expect(isTestPath('src/lib.rs', crates, `${wholeDiff(['+#[test]', '+fn t() {}'])}\n\\ No newline at end of file\n`)).toBe(true);
  });

  it('does not count a test cargo never compiles: in a block comment, in a string, under a cfg other than cfg(test), or inside a function', () => {
    const off: string[][] = [
      ['/*', '#[test]', 'fn disabled() {}', '*/'],
      ['/* outer /* nested */', '#[test]', 'fn disabled() {}', '*/'],
      ['const DOC: &str = r#"', '#[test]', 'fn in_a_string() {}', '"#;'],
      ['const DOC: &str = "', '#[test]', 'fn in_a_string() {}', '";'],
      ['#[cfg(feature = "slow")]', '#[test]', 'fn gated() {}'],
      ['#[test]', '#[cfg(any())]', 'fn never() {}'],
      ['#[cfg(not(test))]', '#[test]', 'fn never() {}'],
      ['#[test] #[cfg(windows)] fn inline() {}'],
      ['#[test_case(', '    1', ')]', '#[ignore]', 'fn slow(n: i32) {}'],
      ['#[cfg(feature = "slow")]', 'mod slow {', '    #[test]', '    fn a() {}', '    #[test]', '    fn b() {}', '}'],
      ['#[cfg(all(test, feature = "x"))] mod tests', '{', '    #[test]', '    fn a() {}', '}'],
      ['#[cfg(test)]', 'mod tests {', '    #![cfg(feature = "slow")]', '    #[test]', '    fn a() {}', '}'],
      ['#![cfg(feature = "slow")]', '#[test]', 'fn a() {}'],
      ['fn outer() {', '    #[test]', '    fn inner() {}', '}'],
      ['macro_rules! cases {', '    () => {', '        #[test]', '        fn a() {}', '    };', '}'],
    ];
    for (const lines of off) expect(isTestPath('src/lib.rs', crates, diff(lines)), lines.join(' | ')).toBe(false);
    // An unchanged cfg on the module still leaves out the test the change adds inside it.
    expect(isTestPath('src/lib.rs', crates, wholeDiff([' #[cfg(feature = "slow")]', ' mod slow {', '+    #[test]', '+    fn a() {}', ' }']))).toBe(false);
    const on: string[][] = [
      ['/* a comment */', '#[test]', 'fn runs() {}'],
      ['// a /* in a line comment', '#[test]', 'fn runs() {}'],
      ['const S: &str = "/* not a comment";', '#[test]', 'fn runs() {}'],
      ["const Q: char = '\"';", "fn f<'a>(x: &'a str) -> &'a str { x }", '#[test]', 'fn runs() {}'],
      ['#[cfg(test)]', '#[test]', 'fn runs() {}'],
      ['#![cfg_attr(docsrs, feature(doc_cfg))]', '#[test]', 'fn runs() {}'],
      ['#[cfg(feature = "slow")]', 'mod slow {', '    #[test]', '    fn a() {}', '}', '', '#[test]', 'fn after() {}'],
      ['#[cfg(test)]', 'pub(crate) mod tests {', '    mod inner {', '        #[test]', '        fn a() {}', '    }', '}'],
      ['#[test_case(', '    1', ')]', 'fn runs(n: i32) {}'],
    ];
    for (const lines of on) expect(isTestPath('src/lib.rs', crates, diff(lines)), lines.join(' | ')).toBe(true);
  });

  it('reads diff content for Rust only', () => {
    expect(isTestPath('src/Calculator.cs', NO_LAYOUT, diff(['#[test]']))).toBe(false);
    expect(isTestPath('src/calc.py', NO_LAYOUT, diff(['#[test]']))).toBe(false);
  });
});

describe('declaresCargoPackage', () => {
  it('is a crate when the manifest has a [package] table, not when it is only a workspace', () => {
    expect(declaresCargoPackage('[package]\nname = "calc"\nversion = "0.1.0"\n')).toBe(true);
    expect(declaresCargoPackage('[workspace]\nmembers = ["calc"]\n\n[package] # the root crate\nname = "root"\n')).toBe(true);
    expect(declaresCargoPackage('[workspace]\nmembers = ["calc"]\nresolver = "2"\n')).toBe(false);
    expect(declaresCargoPackage('[workspace.package]\nversion = "0.1.0"\n')).toBe(false);
    expect(declaresCargoPackage('# [package]\n')).toBe(false);
  });
});

describe('loadTestLayout: the project files of the base and candidate trees that own the changed files', () => {
  const LIB = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n';
  const TESTS = '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" /><PackageReference Include="xunit" Version="2.9.2" /></ItemGroup></Project>\n';
  const FLIPPED = LIB.replace('</PropertyGroup>', '<IsTestProject>true</IsTestProject></PropertyGroup>');

  const parent = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

  /** A TreeReader over flat trees: `list` gives the entries directly in the asked directories, as git ls-tree does. */
  function reader(trees: Record<string, Record<string, string | null>>): TreeReader & { reads: string[]; listed: [string, string[]][] } {
    const reads: string[] = [];
    const listed: [string, string[]][] = [];
    return {
      reads,
      listed,
      list: vi.fn(async (rev: string, dirs: readonly string[]) => {
        listed.push([rev, [...dirs]]);
        return Object.keys(trees[rev] ?? {}).filter((p) => dirs.includes(parent(p)));
      }),
      text: vi.fn(async (rev: string, path: string) => {
        reads.push(`${rev}:${path}`);
        return trees[rev]?.[path] ?? null;
      }),
    };
  }

  it('marks the test project that owns a changed file, reading only the owners\' project files', async () => {
    const tree = { 'src/Acme/Acme.csproj': LIB, 'src/Acme/Calculator.cs': '', 'tests/Acme.Tests/Acme.Tests.csproj': TESTS, 'tests/Acme.Tests/CalculatorTests.cs': '', 'tools/Gen/Gen.csproj': TESTS };
    const r = reader({ base: tree, cand: tree });
    const l = await loadTestLayout(r, 'base', 'cand', ['src/Acme/Calculator.cs', 'tests/Acme.Tests/CalculatorTests.cs']);
    expect(Object.fromEntries(l.dotnetProjects)).toEqual({ 'src/Acme': false, 'tests/Acme.Tests': true });
    // A project is judged on each revision that has a file it owns, and nothing else is read.
    expect(r.reads.sort()).toEqual(['base:src/Acme/Acme.csproj', 'base:tests/Acme.Tests/Acme.Tests.csproj', 'cand:src/Acme/Acme.csproj', 'cand:tests/Acme.Tests/Acme.Tests.csproj']);
    expect(isTestPath('tests/Acme.Tests/CalculatorTests.cs', l)).toBe(true);
    expect(isTestPath('src/Acme/Calculator.cs', l)).toBe(false);
  });

  // Issue #30 review: the whole tree was listed with ls-tree -r through a git whose output stops at 8 MiB, so on a
  // large repository the test project's file was cut off and its tests did not count. Only the directories above the
  // changed files can own them, so only those are listed.
  it('lists only the directories above the changed .NET and Rust files, on both revisions', async () => {
    const tree = { 'src/Acme/Acme.csproj': LIB, 'src/Acme/Calculator.cs': '', 'tests/Acme.Tests/Acme.Tests.csproj': TESTS, 'tests/Acme.Tests/CalculatorTests.cs': '' };
    const r = reader({ base: tree, cand: tree });
    await loadTestLayout(r, 'base', 'cand', ['src/Acme/Calculator.cs', 'tests/Acme.Tests/CalculatorTests.cs', 'docs/README.md']);
    const dirs = ['', 'src', 'src/Acme', 'tests', 'tests/Acme.Tests'];
    expect(r.listed).toEqual([['base', dirs], ['cand', dirs]]);
  });

  it('does not let a candidate turn a production project into a test project: both revisions must say so', async () => {
    const base = { 'src/Acme/Acme.csproj': LIB, 'src/Acme/Calculator.cs': '' };
    const r = reader({ base, cand: { ...base, 'src/Acme/Acme.csproj': FLIPPED } });
    const l = await loadTestLayout(r, 'base', 'cand', ['src/Acme/Calculator.cs', 'src/Acme/Acme.csproj']);
    expect(isTestPath('src/Acme/Calculator.cs', l)).toBe(false);
  });

  it('counts a test project the candidate adds, and the files of a test project it deletes', async () => {
    const base = { 'src/Acme/Acme.csproj': LIB, 'tests/Old.Tests/Old.Tests.csproj': TESTS, 'tests/Old.Tests/OldTests.cs': '' };
    const cand = { 'src/Acme/Acme.csproj': LIB, 'tests/Acme.Tests/Acme.Tests.csproj': TESTS, 'tests/Acme.Tests/CalculatorTests.cs': '' };
    const l = await loadTestLayout(reader({ base, cand }), 'base', 'cand', ['tests/Acme.Tests/CalculatorTests.cs', 'tests/Old.Tests/OldTests.cs']);
    expect(isTestPath('tests/Acme.Tests/CalculatorTests.cs', l)).toBe(true);
    expect(isTestPath('tests/Old.Tests/OldTests.cs', l)).toBe(true);
  });

  // A file is judged by the project that owns it on every revision that has it.
  it('does not make a production file a test by adding a test project around it: the base owns it in the production project', async () => {
    const base = { 'src/Acme/Acme.csproj': LIB, 'src/Acme/Calc/Calculator.cs': '' };
    const cand = { ...base, 'src/Acme/Calc/Calc.csproj': TESTS, 'src/Acme/Calc/CalcTests.cs': '' };
    const l = await loadTestLayout(reader({ base, cand }), 'base', 'cand', ['src/Acme/Calc/Calculator.cs', 'src/Acme/Calc/Calc.csproj', 'src/Acme/Calc/CalcTests.cs']);
    expect(isTestPath('src/Acme/Calc/Calculator.cs', l)).toBe(false);
    expect(isTestPath('src/Acme/Calc/CalcTests.cs', l)).toBe(true);
  });

  it('does not count a changed file whose test project the candidate deletes: no test project builds it any more', async () => {
    const base = { 'tests/Acme.Tests/Acme.Tests.csproj': TESTS, 'tests/Acme.Tests/CalculatorTests.cs': '' };
    const cand = { 'tests/Acme.Tests/CalculatorTests.cs': 'changed' };
    const l = await loadTestLayout(reader({ base, cand }), 'base', 'cand', ['tests/Acme.Tests/Acme.Tests.csproj', 'tests/Acme.Tests/CalculatorTests.cs']);
    expect(isTestPath('tests/Acme.Tests/CalculatorTests.cs', l)).toBe(false);
  });

  // The weakening signals ask whether a file was or is a test, so a candidate cannot hide the tests it deletes or edits
  // by also turning their project into a library or deleting its project file; a criterion's evidence asks whether the
  // file is a test on every revision that has it.
  it('still knows the tests a candidate deletes or edits after changing or deleting their project file, for the weakening signals', async () => {
    const base = { 'tests/Acme.Tests/Acme.Tests.csproj': TESTS, 'tests/Acme.Tests/CalculatorTests.cs': '', 'tests/Acme.Tests/MoreTests.cs': '', 'src/Acme/Acme.csproj': LIB, 'src/Acme/Calculator.cs': '' };
    const changed = ['tests/Acme.Tests/Acme.Tests.csproj', 'tests/Acme.Tests/CalculatorTests.cs', 'tests/Acme.Tests/MoreTests.cs', 'src/Acme/Calculator.cs'];
    for (const cand of [{ ...base, 'tests/Acme.Tests/Acme.Tests.csproj': LIB }, { 'src/Acme/Acme.csproj': LIB, 'src/Acme/Calculator.cs': 'edited' }]) {
      const tree: Record<string, string> = { ...cand, 'tests/Acme.Tests/MoreTests.cs': 'edited' };
      delete tree['tests/Acme.Tests/CalculatorTests.cs'];
      const l = await loadTestLayout(reader({ base, cand: tree }), 'base', 'cand', changed);
      expect(isTestPathOnEitherRevision('tests/Acme.Tests/CalculatorTests.cs', l)).toBe(true);
      expect(isTestPathOnEitherRevision('tests/Acme.Tests/MoreTests.cs', l)).toBe(true);
      expect(isTestPath('tests/Acme.Tests/MoreTests.cs', l)).toBe(false);
      expect(isTestPathOnEitherRevision('src/Acme/Calculator.cs', l)).toBe(false);
    }
    const crate = { 'Cargo.toml': '[package]\nname = "calc"\n', 'tests/mul.rs': '' };
    const l = await loadTestLayout(reader({ base: crate, cand: { 'Cargo.toml': '[workspace]\nmembers = []\n', 'tests/mul.rs': 'edited' } }), 'base', 'cand', ['Cargo.toml', 'tests/mul.rs']);
    expect(isTestPathOnEitherRevision('tests/mul.rs', l)).toBe(true);
    expect(isTestPath('tests/mul.rs', l)).toBe(false);
    // A layout built by hand has no revisions: the two questions are one.
    expect(isTestPathOnEitherRevision('tests/Acme.Tests/CalculatorTests.cs', layout({ 'tests/Acme.Tests': true }))).toBe(true);
    expect(isTestPathOnEitherRevision('src/test/java/AcmeTest.java')).toBe(true);
  });

  it('is not a test project when another project file shares its folder and is not one, or its project file cannot be read', async () => {
    const tree = { 'tests/Acme.Tests/Acme.Tests.csproj': TESTS, 'tests/Acme.Tests/Acme.Tool.csproj': LIB, 'tests/Acme.Tests/CalculatorTests.cs': '', 'tests/B.Tests/B.Tests.fsproj': null, 'tests/B.Tests/Tests.fs': '' };
    const l = await loadTestLayout(reader({ base: tree, cand: tree }), 'base', 'cand', ['tests/Acme.Tests/CalculatorTests.cs', 'tests/B.Tests/Tests.fs']);
    expect(isTestPath('tests/Acme.Tests/CalculatorTests.cs', l)).toBe(false);
    expect(isTestPath('tests/B.Tests/Tests.fs', l)).toBe(false);
  });

  it('marks crates from Cargo.toml files with a [package] table', async () => {
    const tree = { 'Cargo.toml': '[workspace]\nmembers = ["crates/calc"]\n', 'tests/root.rs': '', 'crates/calc/Cargo.toml': '[package]\nname = "calc"\n', 'crates/calc/tests/mul.rs': '', 'crates/other/Cargo.toml': '[package]\nname = "other"\n' };
    const r = reader({ base: tree, cand: tree });
    const l = await loadTestLayout(r, 'base', 'cand', ['tests/root.rs', 'crates/calc/tests/mul.rs']);
    expect(Object.fromEntries(l.cargoManifests)).toEqual({ '': false, 'crates/calc': true });
    expect(isTestPath('crates/calc/tests/mul.rs', l)).toBe(true);
    expect(isTestPath('tests/root.rs', l)).toBe(false);
    expect(r.reads.some((x) => x.includes('crates/other'))).toBe(false);
  });

  it('does not count a #[test] beside a manifest the candidate turns into a crate: both revisions must say crate', async () => {
    const base = { 'Cargo.toml': '[workspace]\nmembers = ["crates/calc"]\n', 'crates/calc/Cargo.toml': '[package]\nname = "calc"\n', 'crates/calc/src/lib.rs': '' };
    const cand = { ...base, 'Cargo.toml': '[workspace]\nmembers = ["crates/calc"]\n\n[package]\nname = "root"\n', 'tests/mul.rs': '' };
    const l = await loadTestLayout(reader({ base, cand }), 'base', 'cand', ['Cargo.toml', 'tests/mul.rs']);
    expect(isTestPath('tests/mul.rs', l, diff(['#[test]', 'fn mul_works() {}']))).toBe(false);
  });

  it('finds the changed Rust modules the crate compiles: reached from a crate root by mod declarations in the candidate', async () => {
    const cand = {
      'Cargo.toml': '[package]\nname = "calc"\n',
      'src/lib.rs': 'pub mod calc;\nmod ops;\n#[cfg(test)]\nmod tests;\n// mod commented;\n',
      'src/calc/mod.rs': 'pub(crate) mod parse;\n',
      'src/calc/parse.rs': '',
      'src/ops.rs': '    pub mod  r#impl ;\n',
      'src/ops/impl.rs': '',
      'src/tests.rs': '',
      'src/orphan.rs': '#[test]\nfn never_built() {}\n',
      'src/commented.rs': '',
      'src/calc/stray.rs': '',
      'src/bin/tool.rs': 'mod args;\n',
      'src/bin/args.rs': '',
      'src/bin/cli/main.rs': 'mod opts;\n',
      'src/bin/cli/opts.rs': '',
      'crates/calc/Cargo.toml': '[package]\nname = "inner"\n',
      'crates/calc/src/main.rs': 'mod run;\n',
      'crates/calc/src/run.rs': '',
    };
    const changed = Object.keys(cand).filter((p) => p.endsWith('.rs'));
    const l = await loadTestLayout(reader({ base: cand, cand }), 'base', 'cand', changed, { rustModules: true });
    expect([...(l.compiledRust ?? [])].sort()).toEqual(['crates/calc/src/run.rs', 'src/bin/cli/opts.rs', 'src/calc/mod.rs', 'src/calc/parse.rs', 'src/ops.rs', 'src/ops/impl.rs', 'src/tests.rs']);
    expect(isTestPath('src/orphan.rs', l, diff(['#[test]', 'fn never_built() {}']))).toBe(false);
    expect(isTestPath('src/tests.rs', l, diff(['#[test]', 'fn mul_works() {}']))).toBe(true);
    // Without the option no module is looked for, and only the crate roots count.
    expect((await loadTestLayout(reader({ base: cand, cand }), 'base', 'cand', changed)).compiledRust).toBeUndefined();
  });

  // Final review: a mod declaration in a block comment, under a cfg other than cfg(test), with a #[path], or inside an
  // inline module does not make cargo compile src/<name>.rs.
  it('counts a module only for a declaration cargo compiles: not in a comment or string, under a cfg, moved by #[path] or nested', async () => {
    const cand = {
      'Cargo.toml': '[package]\nname = "calc"\n',
      'src/lib.rs': [
        '/*',
        'mod in_comment;',
        '*/',
        'const S: &str = "',
        'mod in_string;',
        '";',
        '#[cfg(feature = "slow")]',
        'mod gated;',
        '#[cfg(feature = "x")] mod gated_inline;',
        '#[path = "elsewhere.rs"]',
        'mod moved;',
        'mod outer {',
        '    mod nested;',
        '}',
        '#[cfg(test)]',
        '#[allow(dead_code)]',
        'mod tests;',
        'pub mod plain;',
        '#[cfg(feature = "slow")]',
        'mod slow {',
        '}',
        'mod after;',
      ].join('\n'),
      'src/gate.rs': '#![cfg(feature = "slow")]\nmod behind_gate;\n',
    };
    const files = ['in_comment', 'in_string', 'gated', 'gated_inline', 'moved', 'nested', 'tests', 'plain', 'after', 'behind_gate'].map((n) => `src/${n}.rs`);
    const tree: Record<string, string> = { ...cand, ...Object.fromEntries(files.map((f) => [f, ''])) };
    tree['src/lib.rs'] += '\nmod gate;\n';
    const l = await loadTestLayout(reader({ base: tree, cand: tree }), 'base', 'cand', files, { rustModules: true });
    expect([...(l.compiledRust ?? [])].sort()).toEqual(['src/after.rs', 'src/plain.rs', 'src/tests.rs']);
  });

  it('reads no tree at all when no .NET or Rust file changed', async () => {
    const r = reader({});
    expect(await loadTestLayout(r, 'base', 'cand', ['src/a.ts', 'tests/a.test.ts', 'README.md'])).toBe(NO_LAYOUT);
    expect(r.list).not.toHaveBeenCalled();
  });
});

describe('gitTreeReader', () => {
  it('lists the entries directly in the given directories with one non-recursive ls-tree, and reads a blob, null when it is not there', async () => {
    const calls: string[][] = [];
    const run = vi.fn(async (args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === 'ls-tree') return 'a b/c.csproj\0src/x.cs\0';
      if (args[2] === 'rev:missing') throw new Error('fatal: path does not exist');
      return '<Project />';
    });
    const r = gitTreeReader(run);
    expect(await r.list('rev', ['', 'a b', ':x', 'src'])).toEqual(['a b/c.csproj', 'src/x.cs']);
    // './' keeps a directory starting with ':' from being read as pathspec magic, with or without GIT_LITERAL_PATHSPECS.
    expect(calls[0]).toEqual(['ls-tree', '-z', '--name-only', '--full-tree', 'rev', '--', '.', './a b/', './:x/', './src/']);
    expect(await r.text('rev', 'a b/c.csproj')).toBe('<Project />');
    expect(calls[1]).toEqual(['cat-file', 'blob', 'rev:a b/c.csproj']);
    expect(await r.text('rev', 'missing')).toBeNull();
    expect(await r.list('rev', [])).toEqual([]);
    expect(calls).toHaveLength(3);
  });

  it('lists many directories in batches', async () => {
    const run = vi.fn(async (args: readonly string[]) => `${args.slice(args.indexOf('--') + 1).map((d) => `${d.slice(2)}f.cs`).join('\0')}\0`);
    const dirs = Array.from({ length: 450 }, (_, i) => `d${i}`);
    const listed = await gitTreeReader(run).list('rev', dirs);
    expect(listed).toHaveLength(450);
    expect(run.mock.calls.map((c) => c[0].length - 6)).toEqual([200, 200, 50]);
  });

  it('refuses a listing that was cut short rather than judge test files on part of a directory', async () => {
    const run = vi.fn(async () => 'src/Acme/Acme.csproj\0src/Acme/Calc\n[orbit: output truncated: 1048576 bytes dropped after the first 8388608]\n');
    await expect(gitTreeReader(run).list('rev', ['src/Acme'])).rejects.toThrow(/cut short/);
  });
});
