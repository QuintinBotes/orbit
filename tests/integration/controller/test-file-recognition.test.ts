// Issue #30, end to end through the controller: a candidate that adds tests in a language other than JavaScript,
// TypeScript, Python or Go. Test files were recognised only for .js/.ts/.py/.go/.vue/.svelte, so such a candidate
// "adds or changes no test", every criterion whose check already passed on the base revision (the normal case) was
// unverified with "no new evidence", and the run never passed. Recognition now follows each language's test runner
// (ADR 0011).
//
// The check passes on the base revision and on the candidate: a stand-in for the toolchain on the check's PATH prints
// what the real one printed for these repositories and exits 0, so only the test file recognition decides the verdict.
//
// C#: a library project and an xunit test project, as `dotnet new classlib` and `dotnet new xunit` lay them out
// (output of `dotnet test` with SDK 9.0.305 and xunit 2.9.2). A file of the test project is a test file; a test-named
// file of the production project is not, because `dotnet test` never runs it.
// Rust: a crate whose unit tests live in its source file, as `cargo new --lib` lays it out (output of `cargo test`).
// A change that adds a #[test] function to src/lib.rs adds a test; one that adds only code does not, and neither does
// a #[test] function cargo never builds: in a src/ file no `mod` declares, or in a tests/ directory beside a virtual
// workspace manifest (measured with cargo 1.98: neither ran).
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Controller } from '../../../src/controller/loop.ts';
import { listEvidenceReports } from '../../../src/evidence/store.ts';
import { defaultCheck } from '../../../src/policy/config.ts';
import { APPROVE, labDeps, makeLab, plannerPractices, runState, startLabRun, writeScenario, type Lab } from './harness.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

const labs: Lab[] = [];
const bins: string[] = [];
afterEach(() => {
  for (const l of labs.splice(0)) l.close();
  for (const b of bins.splice(0)) rmSync(b, { recursive: true, force: true });
});

const NO_NEW_EVIDENCE = 'no new evidence: unit-tests already passed on the base revision and the candidate adds or changes no test';

// ---------------------------------------------------------------------------
// C#

const CSPROJ_LIBRARY = ['<Project Sdk="Microsoft.NET.Sdk">', '  <PropertyGroup>', '    <TargetFramework>net8.0</TargetFramework>', '    <Nullable>enable</Nullable>', '  </PropertyGroup>', '</Project>', ''].join('\n');
const CSPROJ_TESTS = [
  '<Project Sdk="Microsoft.NET.Sdk">',
  '  <PropertyGroup>',
  '    <TargetFramework>net8.0</TargetFramework>',
  '    <Nullable>enable</Nullable>',
  '    <IsPackable>false</IsPackable>',
  '  </PropertyGroup>',
  '  <ItemGroup>',
  '    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />',
  '    <PackageReference Include="xunit" Version="2.9.2" />',
  '    <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" />',
  '  </ItemGroup>',
  '  <ItemGroup>',
  '    <ProjectReference Include="../../src/Acme/Acme.csproj" />',
  '  </ItemGroup>',
  '</Project>',
  '',
].join('\n');

const calculator = (mul: boolean): string =>
  ['namespace Acme;', '', 'public static class Calculator', '{', '    public static int Add(int a, int b) => a + b;', ...(mul ? ['    public static int Mul(int a, int b) => a * b;'] : []), '}', ''].join('\n');

const calculatorTests = (mul: boolean): string =>
  [
    'using Acme;',
    'using Xunit;',
    '',
    'namespace Acme.Tests;',
    '',
    'public class CalculatorTests',
    '{',
    '    [Fact]',
    '    public void Add_ReturnsTheSum() => Assert.Equal(5, Calculator.Add(2, 3));',
    ...(mul ? ['', '    [Fact]', '    public void Mul_ReturnsTheProduct() => Assert.Equal(6, Calculator.Mul(2, 3));'] : []),
    '}',
    '',
  ].join('\n');

const CSHARP_REPO: Record<string, string> = {
  '.gitignore': '.orbit/\nbin/\nobj/\n',
  'src/Acme/Acme.csproj': CSPROJ_LIBRARY,
  'src/Acme/Calculator.cs': calculator(false),
  'tests/Acme.Tests/Acme.Tests.csproj': CSPROJ_TESTS,
  'tests/Acme.Tests/CalculatorTests.cs': calculatorTests(false),
};

// What `dotnet test tests/Acme.Tests/Acme.Tests.csproj -m:1` printed for this repository (paths neutralised).
const DOTNET_TEST_PASSED = [
  '  Determining projects to restore...',
  '  All projects are up-to-date for restore.',
  '  Acme -> /home/acme/checkout/src/Acme/bin/Debug/net8.0/Acme.dll',
  '  Acme.Tests -> /home/acme/checkout/tests/Acme.Tests/bin/Debug/net8.0/Acme.Tests.dll',
  'Test run for /home/acme/checkout/tests/Acme.Tests/bin/Debug/net8.0/Acme.Tests.dll (.NETCoreApp,Version=v8.0)',
  'VSTest version 17.14.1 (arm64)',
  '',
  'Starting test execution, please wait...',
  'A total of 1 test files matched the specified pattern.',
  '',
  'Passed!  - Failed:     0, Passed:     2, Skipped:     0, Total:     2, Duration: 6 ms - Acme.Tests.dll (net8.0)',
  '',
].join('\n');

const CSHARP = {
  repo: CSHARP_REPO,
  tool: 'dotnet',
  output: DOTNET_TEST_PASSED,
  command: ['dotnet', 'test', 'tests/Acme.Tests/Acme.Tests.csproj', '-m:1'],
  source: 'src/Acme/Calculator.cs',
  allowed: ['src/**', 'tests/**'],
};

// ---------------------------------------------------------------------------
// Rust

const lib = (mul: boolean, test: boolean): string =>
  [
    'pub fn add(a: i32, b: i32) -> i32 {',
    '    a + b',
    '}',
    ...(mul ? ['', 'pub fn mul(a: i32, b: i32) -> i32 {', '    a * b', '}'] : []),
    '',
    '#[cfg(test)]',
    'mod tests {',
    '    use super::*;',
    '',
    '    #[test]',
    '    fn add_works() {',
    '        assert_eq!(add(2, 3), 5);',
    '    }',
    ...(test ? ['', '    #[test]', '    fn mul_works() {', '        assert_eq!(mul(2, 3), 6);', '    }'] : []),
    '}',
    '',
  ].join('\n');

const RUST_REPO: Record<string, string> = {
  '.gitignore': '.orbit/\n/target\n',
  'Cargo.toml': '[package]\nname = "calc"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n',
  'src/lib.rs': lib(false, false),
};

// What `cargo test` printed for this crate (paths neutralised).
const CARGO_TEST_PASSED = [
  '   Compiling calc v0.1.0 (/home/acme/checkout)',
  '    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.40s',
  '     Running unittests src/lib.rs (target/debug/deps/calc-0000000000000000)',
  '',
  'running 2 tests',
  'test tests::add_works ... ok',
  'test tests::mul_works ... ok',
  '',
  'test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s',
  '',
  '   Doc-tests calc',
  '',
  'running 0 tests',
  '',
  'test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s',
  '',
].join('\n');

const RUST = { repo: RUST_REPO, tool: 'cargo', output: CARGO_TEST_PASSED, command: ['cargo', 'test'], source: 'src/lib.rs', allowed: ['src/**', 'tests/**'] };

// A virtual workspace: the root Cargo.toml has only a [workspace] table and builds no tests of its own.
const RUST_WORKSPACE = {
  ...RUST,
  repo: {
    '.gitignore': '.orbit/\n/target\n',
    'Cargo.toml': '[workspace]\nmembers = ["crates/calc"]\nresolver = "2"\n',
    'crates/calc/Cargo.toml': '[package]\nname = "calc"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n',
    'crates/calc/src/lib.rs': lib(false, false),
  },
  source: 'crates/calc/src/lib.rs',
  allowed: ['crates/**', 'tests/**'],
};

const MUL_TEST = ['#[test]', 'fn mul_works() {', '    assert_eq!(calc::mul(2, 3), 6);', '}', ''].join('\n');
const MUL_UNIT_TEST = ['use super::*;', '', '#[test]', 'fn mul_works() {', '    assert_eq!(mul(2, 3), 6);', '}', ''].join('\n');

// ---------------------------------------------------------------------------

type Language = typeof CSHARP;

/** A directory for the check's PATH holding a stand-in `tool` that prints the passing test run and exits 0. */
function standIn(tool: string, output: string): string {
  const bin = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-bin-')));
  bins.push(bin);
  const path = join(bin, tool);
  writeFileSync(path, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(output)});\nprocess.exit(0);\n`);
  chmodSync(path, 0o755);
  return bin;
}

function planner(lang: Language, expectedTest: string): object {
  return {
    objective: 'Add multiplication to the calculator library.',
    current_behavior: [{ statement: `${lang.source} has add only`, evidence: [`${lang.source}:1`] }],
    criteria: [
      {
        key: 'mul',
        statement: 'mul(a, b) returns the product of a and b.',
        mandatory: true,
        ui: false,
        proof: ['a unit test asserts mul(2, 3) == 6'],
        check_ids: ['unit-tests'],
        changes: [{ path: lang.source, summary: 'add mul' }],
      },
    ],
    expected_changed_files: [
      { path: lang.source, change: 'modify', reason: 'add mul' },
      { path: expectedTest, change: 'modify', reason: 'behaviour test' },
    ],
    allowed_paths: lang.allowed,
    required_check_ids: ['unit-tests'],
    non_goals: ['Change add'],
    risks: [],
    assumptions: [],
    unresolved_decisions: [],
    material_topics: [],
    practices: plannerPractices(),
  };
}

function implementation(files: Record<string, string>, test: string): object {
  return {
    edits: Object.entries(files).map(([path, content]) => ({ op: 'write', path, content })),
    structured: {
      summary: 'added mul and a unit test',
      changed_paths: Object.keys(files).map((path) => ({ path, change: 'modify', purpose: path === test ? 'behaviour test' : 'add mul' })),
      tests_added: [{ path: test, name: 'mul works', kind: 'unit', criterion_ids: ['AC-1'] }],
      checks_run: [],
      evidence_refs: [],
      remaining_issues: [],
      next_action: { kind: 'request-verification', detail: 'run the trusted checks' },
    },
  };
}

function lab(lang: Language, files: Record<string, string>, test: string, expectedTest = test): Lab {
  const bin = standIn(lang.tool, lang.output);
  const l = makeLab({
    repoFiles: lang.repo,
    tweak: (c) => {
      c.scope.allowed_paths = lang.allowed;
      c.checks = { 'unit-tests': { ...defaultCheck('unit-tests'), command: lang.command, timeout_seconds: 120, env: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}` } } };
    },
  });
  labs.push(l);
  const impl = implementation(files, test);
  writeScenario(l, { auth: { loggedIn: true, authMethod: 'api_key', method: 'api_key', valid: true }, roles: { planner: [{ structured: planner(lang, expectedTest) }], implementer: [impl, impl], reviewer: [APPROVE] } });
  return l;
}

async function drive(l: Lab): Promise<{ state: string; reason: string; first: ReturnType<typeof listEvidenceReports>[number] | undefined }> {
  const run = startLabRun(l, 'Add multiplication to the calculator library.');
  await new Controller({ mode: 'foreground', runId: run.id, deps: labDeps(l), tickIntervalMs: 20, leaseTtlMs: 30_000, graceMs: 300 }).start();
  const done = runState(l, run.id);
  return { state: done.state, reason: done.outcomeReason ?? '', first: listEvidenceReports(l.db(), run.id)[0] };
}

describe.skipIf(!canStripTypes)('issue #30: a C# candidate that adds xunit tests', () => {
  it('verifies its criterion: the change to a file of the xunit test project is a test change, and the run succeeds', async () => {
    const test = 'tests/Acme.Tests/CalculatorTests.cs';
    const { state, reason, first } = await drive(lab(CSHARP, { 'src/Acme/Calculator.cs': calculator(true), [test]: calculatorTests(true) }, test));
    expect(first?.report.acceptance_evidence, reason).toEqual([{ criterion_id: 'AC-1', status: 'supported', artifacts: expect.any(Array) }]);
    expect(first?.report.checks.map((c) => `${c.id}:${c.status}`)).toEqual(['unit-tests:PASSED']);
    expect(first?.report.verdict).toBe('PASS');
    expect(first?.report.unverified.join('\n')).not.toContain('no new evidence');
    expect(first?.report.scope.weakening_signals).toEqual([]);
    expect(state, reason).toBe('SUCCEEDED');
  }, 120_000);

  it('does not count a test-named file of the production project: dotnet test never runs it, so the criterion stays unverified', async () => {
    const misplaced = 'src/Acme/CalculatorTests.cs';
    const { state, reason, first } = await drive(lab(CSHARP, { 'src/Acme/Calculator.cs': calculator(true), [misplaced]: calculatorTests(true).replace('namespace Acme.Tests;', 'namespace Acme;') }, misplaced, 'tests/Acme.Tests/CalculatorTests.cs'));
    expect(first?.report.checks.map((c) => `${c.id}:${c.status}`)).toEqual(['unit-tests:PASSED']);
    expect(first?.report.verdict).toBe('INCOMPLETE');
    expect(first?.report.acceptance_evidence).toEqual([{ criterion_id: 'AC-1', status: 'unverified', artifacts: expect.any(Array), note: NO_NEW_EVIDENCE }]);
    expect(state, reason).not.toBe('SUCCEEDED');
  }, 120_000);
});

describe.skipIf(!canStripTypes)('issue #30: a Rust candidate whose unit test lives in the source file', () => {
  it('verifies its criterion when the change adds a #[test] function to src/lib.rs, which cargo test runs', async () => {
    const { state, reason, first } = await drive(lab(RUST, { 'src/lib.rs': lib(true, true) }, 'src/lib.rs'));
    expect(first?.report.acceptance_evidence, reason).toEqual([{ criterion_id: 'AC-1', status: 'supported', artifacts: expect.any(Array) }]);
    expect(first?.report.verdict).toBe('PASS');
    expect(state, reason).toBe('SUCCEEDED');
  }, 120_000);

  it('leaves the criterion unverified when the change to src/lib.rs adds code and no test', async () => {
    const { state, reason, first } = await drive(lab(RUST, { 'src/lib.rs': lib(true, false) }, 'src/lib.rs'));
    expect(first?.report.verdict).toBe('INCOMPLETE');
    expect(first?.report.acceptance_evidence).toEqual([{ criterion_id: 'AC-1', status: 'unverified', artifacts: expect.any(Array), note: NO_NEW_EVIDENCE }]);
    expect(state, reason).not.toBe('SUCCEEDED');
  }, 120_000);
});

// Issue #30 review: the #[test] rule counted any .rs file whose diff added a test attribute, wherever it was, so a test
// cargo never builds passed the criterion on a green check that never ran it.
describe.skipIf(!canStripTypes)('issue #30: a Rust #[test] that cargo test never runs is not new evidence', () => {
  it('leaves the criterion unverified when the test is in tests/ beside a virtual workspace manifest', async () => {
    const test = 'tests/mul.rs';
    const { state, reason, first } = await drive(lab(RUST_WORKSPACE, { 'crates/calc/src/lib.rs': lib(true, false), [test]: MUL_TEST }, test));
    expect(first?.report.checks.map((c) => `${c.id}:${c.status}`)).toEqual(['unit-tests:PASSED']);
    expect(first?.report.verdict).toBe('INCOMPLETE');
    expect(first?.report.acceptance_evidence).toEqual([{ criterion_id: 'AC-1', status: 'unverified', artifacts: expect.any(Array), note: NO_NEW_EVIDENCE }]);
    expect(state, reason).not.toBe('SUCCEEDED');
  }, 120_000);

  it('leaves the criterion unverified when the test is in a src/ file that no mod declaration reaches', async () => {
    const test = 'src/mul_tests.rs';
    const { state, reason, first } = await drive(lab(RUST, { 'src/lib.rs': lib(true, false), [test]: MUL_UNIT_TEST }, test));
    expect(first?.report.verdict).toBe('INCOMPLETE');
    expect(first?.report.acceptance_evidence).toEqual([{ criterion_id: 'AC-1', status: 'unverified', artifacts: expect.any(Array), note: NO_NEW_EVIDENCE }]);
    expect(state, reason).not.toBe('SUCCEEDED');
  }, 120_000);

  it('verifies the criterion when the same test module is declared from the crate root, so cargo test runs it', async () => {
    const test = 'src/mul_tests.rs';
    const { state, reason, first } = await drive(lab(RUST, { 'src/lib.rs': `${lib(true, false)}\n#[cfg(test)]\nmod mul_tests;\n`, [test]: MUL_UNIT_TEST }, test));
    expect(first?.report.acceptance_evidence, reason).toEqual([{ criterion_id: 'AC-1', status: 'supported', artifacts: expect.any(Array) }]);
    expect(first?.report.verdict).toBe('PASS');
    expect(state, reason).toBe('SUCCEEDED');
  }, 120_000);
});

// Final review of #30 to #33: the evidence diff of a Rust source had no context lines, so a group's unchanged #[ignore]
// was out of sight, and a change to the test attribute alone of an ignored test (made async, or given another rstest or
// test_case row) counted as a test cargo runs. mul stays wrong; cargo test still skips the test, as it did on the base.
const ignoredMulLib = (attrs: string[]): string =>
  [
    'pub fn add(a: i32, b: i32) -> i32 {',
    '    a + b',
    '}',
    '',
    'pub fn mul(a: i32, b: i32) -> i32 {',
    '    a + b',
    '}',
    '',
    '#[cfg(test)]',
    'mod tests {',
    '    use super::*;',
    '',
    ...attrs.map((a) => `    ${a}`),
    '    fn mul_works() {',
    '        assert_eq!(mul(2, 3), 6);',
    '    }',
    '}',
    '',
  ].join('\n');

describe.skipIf(!canStripTypes)('final review: a Rust change to the test attribute of an ignored test is not new evidence', () => {
  for (const [name, base, candidate] of [
    ['#[test] made #[tokio::test] above an unchanged #[ignore]', ['#[test]', '#[ignore]'], ['#[tokio::test]', '#[ignore]']],
    ['#[test] made #[test_log::test] above an unchanged #[ignore]', ['#[test]', '#[ignore]'], ['#[test_log::test]', '#[ignore]']],
    ['a #[test_case] row added to a group with an unchanged #[ignore = "slow"]', ['#[test_case(1)]', '#[ignore = "slow"]'], ['#[test_case(2)]', '#[test_case(1)]', '#[ignore = "slow"]']],
  ] as const) {
    it(`leaves the criterion unverified: ${name}`, async () => {
      const repo = { ...RUST_REPO, 'src/lib.rs': ignoredMulLib([...base]) };
      const { state, reason, first } = await drive(lab({ ...RUST, repo }, { 'src/lib.rs': ignoredMulLib([...candidate]) }, 'src/lib.rs'));
      expect(first?.report.checks.map((c) => `${c.id}:${c.status}`)).toEqual(['unit-tests:PASSED']);
      expect(first?.report.verdict).toBe('INCOMPLETE');
      expect(first?.report.acceptance_evidence).toEqual([{ criterion_id: 'AC-1', status: 'unverified', artifacts: expect.any(Array), note: NO_NEW_EVIDENCE }]);
      expect(state, reason).not.toBe('SUCCEEDED');
    }, 120_000);
  }
});
