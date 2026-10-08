// Test-file recognition on real git repositories (ADR 0011, issue #30): the layout read from the base and candidate
// trees through git, and the two uses that read it there besides the evidence report: the test-file-deleted weakening
// signal of the scope inspection, and the review packet's ranking (code first, then its tests, then docs).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { git as evidenceGit } from '../../../src/evidence/git.ts';
import { parseConfig } from '../../../src/policy/config.ts';
import { effectiveProtectedPaths } from '../../../src/policy/builtin.ts';
import { inspectScope } from '../../../src/policy/scope.ts';
import { gitTreeReader, isTestPath, loadTestLayout } from '../../../src/policy/test-files.ts';
import type { PolicySnapshot } from '../../../src/policy/types.ts';
import { buildReviewPacket } from '../../../src/review/packet.ts';
import { contract, evidenceReport, snapshotOf } from '../../unit/review/fixtures.ts';

const gitAvailable = spawnSync('git', ['--version']).status === 0;

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Acme Dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Acme Dev', GIT_COMMITTER_EMAIL: 'dev@example.com' };

const LIB = '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n  </PropertyGroup>\n</Project>\n';
const TESTS = '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n  </PropertyGroup>\n  <ItemGroup>\n    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />\n    <PackageReference Include="xunit" Version="2.9.2" />\n  </ItemGroup>\n</Project>\n';

let top: string;
let repo: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, env: GIT_ENV, encoding: 'utf8' }).trim();
}

function write(files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), content);
  }
}

function commit(message: string): string {
  git('add', '-A');
  git('commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD');
}

const reader = () => gitTreeReader(async (args) => git(...args));

function snapshot(): PolicySnapshot {
  const config = parseConfig('version: 1\nscope: {allowed_paths: ["**"]}\n');
  return { schema: 'orbit.policy/1', run_id: 'orb-s', created_at: '', repo_root: '/', config, effective_protected_paths: effectiveProtectedPaths(config), check_config_hashes: {} };
}

let base: string;

describe.skipIf(!gitAvailable)('test-file recognition on a real repository (skipped when git is not installed)', () => {
  beforeAll(() => {
    top = mkdtempSync(join(tmpdir(), 'orbit-test-files-'));
    repo = join(top, 'repo');
    mkdirSync(repo);
    git('init', '-q', '-b', 'main');
    write({
      'src/Acme/Acme.csproj': LIB,
      'src/Acme/Calculator.cs': 'namespace Acme;\npublic static class Calculator { public static int Add(int a, int b) => a + b; }\n',
      'src/Acme/Test.cs': 'namespace Acme;\npublic record Test(string Name, int Score);\n',
      'tests/Acme.Tests/Acme.Tests.csproj': TESTS,
      'tests/Acme.Tests/CalculatorTests.cs': 'using Xunit;\npublic class CalculatorTests { [Fact] public void Adds() => Assert.Equal(5, Acme.Calculator.Add(2, 3)); }\n',
      'Cargo.toml': '[workspace]\nmembers = ["crates/calc"]\nresolver = "2"\n',
      'crates/calc/Cargo.toml': '[package]\nname = "calc"\nversion = "0.1.0"\nedition = "2021"\n',
      'crates/calc/src/lib.rs': 'pub fn add(a: i32, b: i32) -> i32 { a + b }\n',
      'crates/calc/tests/add.rs': '#[test]\nfn adds() { assert_eq!(calc::add(2, 3), 5); }\n',
      'tests/root.rs': '#[test]\nfn never_built() {}\n',
    });
    base = commit('base');
  });

  afterAll(() => {
    rmSync(top, { recursive: true, force: true });
  });

  it('reads the project files of both trees through git: the xunit project and the crate are test layouts, the rest is not', async () => {
    const changed = ['src/Acme/Calculator.cs', 'src/Acme/Test.cs', 'tests/Acme.Tests/CalculatorTests.cs', 'crates/calc/tests/add.rs', 'tests/root.rs'];
    const layout = await loadTestLayout(reader(), base, base, changed);
    expect(Object.fromEntries(layout.dotnetProjects)).toEqual({ 'src/Acme': false, 'tests/Acme.Tests': true });
    expect(Object.fromEntries(layout.cargoManifests)).toEqual({ '': false, 'crates/calc': true });
    expect(changed.filter((p) => isTestPath(p, layout))).toEqual(['tests/Acme.Tests/CalculatorTests.cs', 'crates/calc/tests/add.rs']);
  });

  it('flags a deleted file of the xunit project as test-file-deleted, and not a production record named Test.cs', async () => {
    git('checkout', '-q', '-B', 'deleted', base);
    git('rm', '-q', 'tests/Acme.Tests/CalculatorTests.cs', 'src/Acme/Test.cs', 'crates/calc/tests/add.rs');
    const cand = commit('delete');
    const report = await inspectScope({ repoRoot: repo, baseRev: base, candidateRev: cand, snapshot: snapshot() });
    expect(report.weakening_signals.map((s) => `${s.path}:${s.signal}`).sort()).toEqual(['crates/calc/tests/add.rs:test-file-deleted', 'tests/Acme.Tests/CalculatorTests.cs:test-file-deleted']);
  });

  it('flags the tests a candidate deletes after turning their project into a library, or deleting its project file', async () => {
    for (const [branch, change] of [
      ['unflagged', () => write({ 'tests/Acme.Tests/Acme.Tests.csproj': LIB })],
      ['unprojected', () => git('rm', '-q', 'tests/Acme.Tests/Acme.Tests.csproj')],
    ] as const) {
      git('checkout', '-q', '-B', branch, base);
      change();
      git('rm', '-q', 'tests/Acme.Tests/CalculatorTests.cs');
      const cand = commit(branch);
      const report = await inspectScope({ repoRoot: repo, baseRev: base, candidateRev: cand, snapshot: snapshot() });
      expect(report.weakening_signals.map((s) => `${s.path}:${s.signal}`), branch).toEqual(['tests/Acme.Tests/CalculatorTests.cs:test-file-deleted']);
    }
  });

  it('does not let a candidate make its production files tests by declaring the production project a test project', async () => {
    git('checkout', '-q', '-B', 'flipped', base);
    write({ 'src/Acme/Acme.csproj': LIB.replace('</PropertyGroup>', '  <IsTestProject>true</IsTestProject>\n  </PropertyGroup>'), 'src/Acme/Calculator.cs': 'namespace Acme;\npublic static class Calculator { public static int Add(int a, int b) => a + b; public static int Mul(int a, int b) => a * b; }\n' });
    const cand = commit('flip');
    const layout = await loadTestLayout(reader(), base, cand, ['src/Acme/Acme.csproj', 'src/Acme/Calculator.cs']);
    expect(isTestPath('src/Acme/Calculator.cs', layout)).toBe(false);
  });

  it('ranks a changed source before its changed xunit test in the review packet, whatever their sizes', async () => {
    git('checkout', '-q', '-B', 'packet', base);
    // The test change is the smaller one, so ranking by size alone would put it first.
    write({
      'src/Acme/Calculator.cs': `namespace Acme;\npublic static class Calculator\n{\n${['Add', 'Sub', 'Mul', 'Div', 'Mod', 'Max', 'Min'].map((n) => `    public static int ${n}(int a, int b) => a + b;`).join('\n')}\n}\n`,
      'tests/Acme.Tests/CalculatorTests.cs': 'using Xunit;\npublic class CalculatorTests { [Fact] public void Adds() => Assert.Equal(6, Acme.Calculator.Add(3, 3)); }\n',
    });
    const cand = commit('packet');
    const tree = git('rev-parse', 'HEAD^{tree}');
    const p = await buildReviewPacket({ contract: contract(), snapshot: snapshotOf(), candidate: { commitSha: cand, treeHash: tree }, baseRev: base, repoRoot: repo, evidenceReport: evidenceReport(tree), ledger: [], questions: [], provider: 'codex', limits: { maxFiles: 1 } });
    expect(p.included.map((i) => i.path)).toEqual(['src/Acme/Calculator.cs']);
  });

  // Issue #30 review: the layout came from `ls-tree -r` of the whole tree through the evidence git, whose output stops
  // at 8 MiB without an error. On a repository of about 140,000 files the listing was cut before tests/, so the xunit
  // project was not seen and its tests did not count. Only the directories above the changed files are listed now.
  it('sees the test project on a repository whose full listing is larger than the evidence git keeps', async () => {
    const big = join(top, 'big');
    mkdirSync(big);
    const run = (args: string[], input?: string) => execFileSync('git', args, { cwd: big, env: GIT_ENV, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 }).trim();
    run(['init', '-q', '-b', 'main']);
    const blob = (content: string) => run(['hash-object', '-w', '--stdin'], content);
    const empty = blob('');
    const entries = [`100644 ${blob(LIB)}\tsrc/Acme/Acme.csproj`, `100644 ${empty}\tsrc/Acme/Calculator.cs`, `100644 ${blob(TESTS)}\ttests/Acme.Tests/Acme.Tests.csproj`, `100644 ${empty}\ttests/Acme.Tests/CalculatorTests.cs`];
    // Generated sources between src/Acme and tests/ in tree order: 140,000 paths of about 70 bytes, over 9 MB listed.
    for (let i = 0; i < 140_000; i++) entries.push(`100644 ${empty}\tsrc/Generated/module-${String(i % 1400).padStart(4, '0')}/generated-source-file-number-${String(i).padStart(6, '0')}.cs`);
    run(['update-index', '--add', '--index-info'], `${entries.join('\n')}\n`);
    const tree = run(['write-tree']);
    const rev = run(['commit-tree', tree, '-m', 'big']);
    expect(run(['ls-tree', '-r', '-z', '--name-only', rev]).length).toBeGreaterThan(8 * 1024 * 1024);

    const changed = ['src/Acme/Calculator.cs', 'tests/Acme.Tests/CalculatorTests.cs'];
    const layout = await loadTestLayout(gitTreeReader((args) => evidenceGit(big, args)), rev, rev, changed);
    expect(Object.fromEntries(layout.dotnetProjects)).toEqual({ 'src/Acme': false, 'tests/Acme.Tests': true });
    expect(changed.filter((p) => isTestPath(p, layout))).toEqual(['tests/Acme.Tests/CalculatorTests.cs']);
  }, 120_000);
});
