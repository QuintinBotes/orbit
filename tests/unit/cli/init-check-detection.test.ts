/** `orbit init` proposes checks from what the repository declares, for the tools that are on PATH, and never touches an existing config. */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { detectChecks, renderChecksYaml } from '../../../src/cli/check-detect.ts';
import { makeLab, type Lab } from './lab.ts';

const labs: Lab[] = [];
const dirs: string[] = [];
afterEach(() => {
  labs.splice(0).forEach((l) => l.close());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const GIT_ENV = { GIT_AUTHOR_NAME: 'acme', GIT_AUTHOR_EMAIL: 'dev@acme.test', GIT_COMMITTER_NAME: 'acme', GIT_COMMITTER_EMAIL: 'dev@acme.test', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();

/** A repository holding exactly these files, committed. */
function repoWith(files: Record<string, string>): Lab {
  const l = makeLab();
  labs.push(l);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(l.repo, name)), { recursive: true });
    writeFileSync(join(l.repo, name), text);
  }
  git(l.repo, 'add', '-A');
  git(l.repo, 'commit', '-q', '-m', 'fixture');
  return l;
}

/** A PATH holding git and the named fake tools, each an executable that exits 0 (cargo exits 1 for `clippy` when asked). */
function pathWith(tools: string[], opts: { clippy?: boolean } = {}): string {
  const bin = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-detect-bin-')));
  dirs.push(bin);
  symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), join(bin, 'git'));
  for (const t of tools) {
    const script = t === 'cargo' ? `#!/bin/sh\nif [ "$1" = clippy ]; then exit ${opts.clippy === false ? 1 : 0}; fi\nexit 0\n` : '#!/bin/sh\nexit 0\n';
    writeFileSync(join(bin, t), script);
    chmodSync(join(bin, t), 0o755);
  }
  return bin;
}

interface InitJson {
  config: { status: string };
  checks: { proposed: { id: string; ecosystem: string; command: string[]; category: string; timeout_seconds: number; reason: string }[]; not_proposed: { ecosystem: string; reason: string }[] };
  config_problems: string[];
}

const envFor = (l: Lab, PATH?: string) => ({ ...process.env, ...GIT_ENV, HOME: l.home, ORBIT_HOME: l.orbitHome, ...(PATH !== undefined ? { PATH } : {}) });

async function init(l: Lab, tools: string[], opts: { clippy?: boolean } = {}) {
  const r = await l.cli(['init', '--json'], { env: envFor(l, pathWith(tools, opts)) });
  expect(r.code, r.err).toBe(0);
  const json = JSON.parse(r.out) as InitJson;
  const text = readFileSync(join(l.repo, '.orbit', 'config.yaml'), 'utf8');
  const checks = (parse(text) as { checks: Record<string, { command: string[]; category: string; timeout_seconds: number }> | null }).checks ?? {};
  return { json, text, checks, ids: json.checks.proposed.map((c) => c.id) };
}

const pkg = (o: Record<string, unknown>) => `${JSON.stringify({ name: 'acme-app', version: '1.0.0', ...o }, null, 2)}\n`;

describe('init proposes checks: Node', () => {
  const files = {
    'package.json': pkg({ scripts: { test: 'node --test', lint: 'eslint .', build: 'tsc -p .' }, devDependencies: { typescript: '^5.0.0' } }),
    'package-lock.json': '{}\n',
    'tsconfig.json': '{}\n',
    'src/index.ts': 'export const acme = 1;\n',
  };

  it('proposes lint, typecheck, tests and build with category, timeout and a review comment', async () => {
    const r = await init(repoWith(files), ['npm']);
    expect(r.ids).toEqual(['lint', 'typecheck', 'unit-tests', 'build']);
    expect(r.checks.lint).toMatchObject({ command: ['npm', 'run', 'lint'], category: 'lint', timeout_seconds: 300 });
    expect(r.checks.typecheck).toMatchObject({ command: ['npx', '--no-install', 'tsc', '--noEmit'], category: 'typecheck', timeout_seconds: 300 });
    expect(r.checks['unit-tests']).toMatchObject({ command: ['npm', 'test'], category: 'test', timeout_seconds: 900 });
    expect(r.checks.build).toMatchObject({ command: ['npm', 'run', 'build'], category: 'build', timeout_seconds: 600 });
    expect(r.text).toMatch(/# Proposed by "orbit init" \(package\.json declares a lint script.*\)\. Review it before the first run\.\n {2}lint:/);
    expect(r.json.config_problems).toEqual([]);
  });

  it('prefers a typecheck script to the tsconfig, and skips a typecheck without the typescript dependency', async () => {
    const withScript = await init(repoWith({ ...files, 'package.json': pkg({ scripts: { 'type-check': 'tsc --noEmit' } }) }), ['npm']);
    expect(withScript.checks.typecheck?.command).toEqual(['npm', 'run', 'type-check']);
    const noTs = await init(repoWith({ ...files, 'package.json': pkg({ scripts: { test: 'node --test' } }) }), ['npm']);
    expect(noTs.ids).toEqual(['unit-tests']);
  });

  it('chooses pnpm or yarn from the lockfile', async () => {
    const pnpm = await init(repoWith({ 'package.json': pkg({ scripts: { test: 'vitest run', lint: 'eslint .' } }), 'pnpm-lock.yaml': 'lockfileVersion: 9\n' }), ['pnpm']);
    expect(pnpm.checks['unit-tests']?.command).toEqual(['pnpm', 'test']);
    expect(pnpm.checks.lint?.command).toEqual(['pnpm', 'run', 'lint']);
    const yarn = await init(repoWith({ 'package.json': pkg({ scripts: { test: 'jest' }, devDependencies: { typescript: '^5' } }), 'yarn.lock': '', 'tsconfig.json': '{}' }), ['yarn']);
    expect(yarn.checks['unit-tests']?.command).toEqual(['yarn', 'test']);
    expect(yarn.checks.typecheck?.command).toEqual(['yarn', 'tsc', '--noEmit']);
  });

  it('proposes nothing and says why when the package manager is absent', async () => {
    const r = await init(repoWith({ 'package.json': pkg({ scripts: { test: 'jest' } }), 'pnpm-lock.yaml': '' }), ['npm']);
    expect(r.ids).toEqual([]);
    expect(r.json.checks.not_proposed).toEqual([{ ecosystem: 'node', reason: expect.stringContaining('pnpm (chosen from pnpm-lock.yaml) was not found on PATH') }]);
  });

  it('does not propose the npm placeholder test script', async () => {
    const r = await init(repoWith({ 'package.json': pkg({ scripts: { test: 'echo "Error: no test specified" && exit 1', build: 'tsc' } }) }), ['npm']);
    expect(r.ids).toEqual(['build']);
    expect(r.json.checks.not_proposed[0]?.reason).toMatch(/no test specified/);
  });

  it('a workspace monorepo gets root-level commands, not one check per package', async () => {
    const r = await init(
      repoWith({
        'package.json': pkg({ private: true, workspaces: ['packages/*'], scripts: { build: 'tsc -b' } }),
        'package-lock.json': '{}',
        'packages/a/package.json': pkg({ name: '@acme/a', scripts: { test: 'node --test', lint: 'eslint .' } }),
        'packages/b/package.json': pkg({ name: '@acme/b', scripts: { test: 'node --test' } }),
        'packages/c/package.json': pkg({ name: '@acme/c', scripts: { test: 'node --test' } }),
      }),
      ['npm'],
    );
    expect(r.ids).toEqual(['lint', 'unit-tests', 'build']);
    expect(r.checks['unit-tests']?.command).toEqual(['npm', 'run', 'test', '--workspaces', '--if-present']);
    expect(r.checks.build?.command).toEqual(['npm', 'run', 'build']);
    expect(r.json.checks.proposed.every((c) => c.command.every((w) => !w.startsWith('packages')))).toBe(true);
  });

  it('a pnpm workspace fans a script out from the root with one command', async () => {
    const r = await init(
      repoWith({ 'package.json': pkg({ private: true }), 'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n', 'pnpm-lock.yaml': '', 'packages/a/package.json': pkg({ name: 'a', scripts: { test: 'vitest run' } }) }),
      ['pnpm'],
    );
    expect(r.checks['unit-tests']?.command).toEqual(['pnpm', '-r', '--if-present', 'run', 'test']);
  });
});

describe('init proposes checks: .NET', () => {
  const sln = 'Microsoft Visual Studio Solution File, Format Version 12.00\n';
  const lib = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n';
  const tests = '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.0.0" /></ItemGroup></Project>\n';

  // MSBuild worker nodes cannot run in the check sandbox (ADR 0009, addendum), so every proposed dotnet command pins one
  // node itself, and the proposal says why in the comment above the check.
  it('builds and tests the solution on one MSBuild node, however many projects it holds, and says why', async () => {
    const r = await init(repoWith({ 'Acme.sln': sln, 'src/Acme.Core/Acme.Core.csproj': lib, 'src/Acme.Web/Acme.Web.csproj': lib, 'tests/Acme.Core.Tests/Acme.Core.Tests.csproj': tests }), ['dotnet']);
    expect(r.ids).toEqual(['build', 'unit-tests']);
    expect(r.checks.build).toMatchObject({ command: ['dotnet', 'build', 'Acme.sln', '-m:1'], category: 'build', timeout_seconds: 900 });
    expect(r.checks['unit-tests']).toMatchObject({ command: ['dotnet', 'test', 'Acme.sln', '-m:1'], category: 'test' });
    const why = '-m:1 keeps MSBuild on one node, since the check sandbox refuses worker nodes their named pipe';
    expect(r.json.checks.proposed.map((c) => c.reason)).toEqual([`solution file Acme.sln; ${why}`, `solution file Acme.sln with a test project (Microsoft.NET.Test.Sdk); ${why}`]);
    expect(r.json.config_problems).toEqual([]);
  });

  it('skips the test check when no project references the test SDK', async () => {
    const r = await init(repoWith({ 'Acme.slnx': '<Solution />\n', 'src/Acme.csproj': lib }), ['dotnet']);
    expect(r.ids).toEqual(['build']);
  });

  it('uses the projects when there is no solution, and a test check only for a test project', async () => {
    const r = await init(repoWith({ 'src/Acme.csproj': lib, 'tests/Acme.Tests.csproj': tests }), ['dotnet']);
    expect(r.json.checks.proposed.map((c) => c.command.join(' '))).toEqual(['dotnet build src/Acme.csproj -m:1', 'dotnet build tests/Acme.Tests.csproj -m:1', 'dotnet test tests/Acme.Tests.csproj -m:1']);
    expect(r.ids).toEqual(['build-acme', 'build-acme-tests', 'unit-tests-acme-tests']);
  });

  it('proposes nothing for many projects and no solution', async () => {
    const files = Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`src/P${n}/P${n}.csproj`, lib]));
    const r = await init(repoWith(files), ['dotnet']);
    expect(r.ids).toEqual([]);
    expect(r.json.checks.not_proposed[0]?.reason).toMatch(/5 project files and no single solution/);
  });

  it('proposes nothing and says why when dotnet is absent', async () => {
    const r = await init(repoWith({ 'Acme.sln': sln, 'src/Acme.csproj': lib }), []);
    expect(r.ids).toEqual([]);
    expect(r.json.checks.not_proposed).toEqual([{ ecosystem: 'dotnet', reason: expect.stringContaining('dotnet was not found on PATH') }]);
  });
});

describe('init proposes checks: Python', () => {
  const pyproject = '[project]\nname = "acme"\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n\n[tool.ruff]\nline-length = 100\n\n[tool.mypy]\nstrict = true\n';

  it('proposes pytest, ruff and mypy when pyproject configures them', async () => {
    const r = await init(repoWith({ 'pyproject.toml': pyproject, 'acme/__init__.py': '' }), ['pytest', 'ruff', 'mypy']);
    expect(r.ids).toEqual(['unit-tests', 'lint', 'typecheck']);
    expect(r.checks['unit-tests']).toMatchObject({ command: ['pytest'], category: 'test', timeout_seconds: 900 });
    expect(r.checks.lint).toMatchObject({ command: ['ruff', 'check', '.'], category: 'lint', timeout_seconds: 300 });
    expect(r.checks.typecheck).toMatchObject({ command: ['mypy', '.'], category: 'typecheck', timeout_seconds: 600 });
    expect(r.json.config_problems).toEqual([]);
  });

  it('reads setup.cfg and tox.ini, and falls back to flake8 when ruff is not declared', async () => {
    const r = await init(repoWith({ 'setup.cfg': '[tool:pytest]\ntestpaths = tests\n\n[flake8]\nmax-line-length = 100\n\n[mypy]\nignore_missing_imports = True\n' }), ['pytest', 'flake8', 'mypy']);
    expect(r.checks.lint?.command).toEqual(['flake8']);
    expect(r.ids).toEqual(['unit-tests', 'lint', 'typecheck']);
    const tox = await init(repoWith({ 'tox.ini': '[pytest]\naddopts = -q\n' }), ['pytest']);
    expect(tox.ids).toEqual(['unit-tests']);
  });

  it('uses flake8 when ruff is declared but not installed, and says nothing about tools the repository does not declare', async () => {
    const r = await init(repoWith({ 'pyproject.toml': '[tool.ruff]\n', '.flake8': '[flake8]\n' }), ['flake8', 'mypy', 'pytest']);
    expect(r.ids).toEqual(['lint']);
    expect(r.checks.lint?.command).toEqual(['flake8']);
    expect(r.json.checks.not_proposed).toEqual([]);
  });

  it('proposes nothing and says why for a declared tool that is absent', async () => {
    const r = await init(repoWith({ 'pyproject.toml': pyproject }), []);
    expect(r.ids).toEqual([]);
    expect(r.json.checks.not_proposed.map((n) => n.reason)).toEqual(expect.arrayContaining([expect.stringContaining('pytest is declared in pyproject.toml, but was not found on PATH'), expect.stringContaining('ruff is declared in pyproject.toml')]));
  });

  it('proposes nothing for a Python project that declares no tool', async () => {
    const r = await init(repoWith({ 'pyproject.toml': '[project]\nname = "acme"\n' }), ['pytest', 'ruff', 'mypy', 'flake8']);
    expect(r.ids).toEqual([]);
  });
});

describe('init proposes checks: Go', () => {
  it('proposes build, vet and test over the module', async () => {
    const r = await init(repoWith({ 'go.mod': 'module acme.test/app\n\ngo 1.22\n', 'main.go': 'package main\n\nfunc main() {}\n' }), ['go']);
    expect(r.ids).toEqual(['build', 'vet', 'unit-tests']);
    expect(r.checks.build).toMatchObject({ command: ['go', 'build', './...'], category: 'build' });
    expect(r.checks.vet).toMatchObject({ command: ['go', 'vet', './...'], category: 'lint' });
    expect(r.checks['unit-tests']).toMatchObject({ command: ['go', 'test', './...'], category: 'test' });
    expect(r.json.config_problems).toEqual([]);
  });

  it('a go.work monorepo gets one root command over its modules', async () => {
    const r = await init(repoWith({ 'go.work': 'go 1.22\n\nuse (\n\t./svc/a\n\t./svc/b // second\n)\nuse ./lib\n', 'svc/a/go.mod': 'module acme.test/a\n', 'svc/b/go.mod': 'module acme.test/b\n', 'lib/go.mod': 'module acme.test/lib\n' }), ['go']);
    expect(r.checks.build?.command).toEqual(['go', 'build', './svc/a/...', './svc/b/...', './lib/...']);
    expect(r.ids).toEqual(['build', 'vet', 'unit-tests']);
  });

  it('proposes nothing and says why when go is absent', async () => {
    const r = await init(repoWith({ 'go.mod': 'module acme.test/app\n' }), []);
    expect(r.ids).toEqual([]);
    expect(r.json.checks.not_proposed).toEqual([{ ecosystem: 'go', reason: expect.stringContaining('go was not found on PATH') }]);
  });
});

describe('init proposes checks: Rust', () => {
  const manifest = '[package]\nname = "acme"\nversion = "0.1.0"\nedition = "2021"\n';

  it('proposes build, test and clippy', async () => {
    const r = await init(repoWith({ 'Cargo.toml': manifest, 'src/main.rs': 'fn main() {}\n' }), ['cargo']);
    expect(r.ids).toEqual(['build', 'unit-tests', 'clippy']);
    expect(r.checks.build).toMatchObject({ command: ['cargo', 'build'], category: 'build', timeout_seconds: 1200 });
    expect(r.checks['unit-tests']).toMatchObject({ command: ['cargo', 'test'], category: 'test' });
    expect(r.checks.clippy).toMatchObject({ command: ['cargo', 'clippy', '--all-targets', '--', '-D', 'warnings'], category: 'lint' });
    expect(r.json.config_problems).toEqual([]);
  });

  it('a Cargo workspace gets one root command over its members', async () => {
    const r = await init(repoWith({ 'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n' }), ['cargo']);
    expect(r.checks.build?.command).toEqual(['cargo', 'build', '--workspace']);
    expect(r.checks.clippy?.command).toEqual(['cargo', 'clippy', '--workspace', '--all-targets', '--', '-D', 'warnings']);
  });

  it('leaves clippy out, and says so, when the component is not installed', async () => {
    const r = await init(repoWith({ 'Cargo.toml': manifest }), ['cargo'], { clippy: false });
    expect(r.ids).toEqual(['build', 'unit-tests']);
    expect(r.json.checks.not_proposed).toEqual([{ ecosystem: 'rust', reason: expect.stringContaining('cargo clippy is not installed') }]);
  });

  it('proposes nothing and says why when cargo is absent', async () => {
    const r = await init(repoWith({ 'Cargo.toml': manifest }), []);
    expect(r.ids).toEqual([]);
    expect(r.json.checks.not_proposed).toEqual([{ ecosystem: 'rust', reason: expect.stringContaining('cargo was not found on PATH') }]);
  });
});

describe('init proposes checks: several ecosystems, existing configs, output', () => {
  const mixed = {
    'package.json': pkg({ scripts: { test: 'node --test', build: 'tsc' } }),
    'package-lock.json': '{}',
    'go.mod': 'module acme.test/app\n',
    'Cargo.toml': '[package]\nname = "acme"\nversion = "0.1.0"\n',
    'pyproject.toml': '[tool.pytest.ini_options]\n',
  };

  it('proposes checks for each ecosystem, with ids that name it', async () => {
    const r = await init(repoWith(mixed), ['npm', 'go', 'cargo', 'pytest']);
    expect(r.ids).toEqual(['node-unit-tests', 'node-build', 'python-unit-tests', 'go-build', 'go-vet', 'go-unit-tests', 'rust-build', 'rust-unit-tests', 'rust-clippy']);
    expect(new Set(r.ids).size).toBe(r.ids.length);
    expect(r.json.config_problems).toEqual([]);
    expect(Object.keys(r.checks)).toEqual(r.ids);
  });

  it('a tool that is absent costs only its own ecosystem', async () => {
    const r = await init(repoWith(mixed), ['npm', 'go']);
    expect(r.ids).toEqual(['node-unit-tests', 'node-build', 'go-build', 'go-vet', 'go-unit-tests']);
    expect(r.json.checks.not_proposed.map((n) => n.ecosystem).sort()).toEqual(['python', 'rust']);
  });

  it('proposes nothing for a repository that declares nothing, leaving the starter checks block alone', async () => {
    const r = await init(repoWith({ 'notes.txt': 'acme\n' }), ['npm', 'go', 'cargo', 'dotnet', 'pytest']);
    expect(r.json.checks).toEqual({ proposed: [], not_proposed: [] });
    expect(r.checks).toEqual({});
    expect(r.text).toContain('checks:\n# example-checks:start');
  });

  it('never touches an existing config: no proposal, same bytes', async () => {
    const l = repoWith({ 'package.json': pkg({ scripts: { test: 'node --test' } }) });
    mkdirSync(join(l.repo, '.orbit'), { recursive: true });
    const mine = 'version: 1\nchecks:\n  my-check:\n    command: ["true"]\n';
    writeFileSync(join(l.repo, '.orbit', 'config.yaml'), mine);
    const r = await init(l, ['npm']);
    expect(r.json.config.status).toBe('exists');
    expect(r.json.checks).toEqual({ proposed: [], not_proposed: [] });
    expect(r.text).toBe(mine);
  });

  it('prints what it proposed and why, and points at reviewing it', async () => {
    const l = repoWith(mixed);
    const r = await l.cli(['init'], { env: envFor(l, pathWith(['npm', 'go'])) });
    expect(r.out).toContain('checks proposed from what the repository declares');
    expect(r.out).toContain('node-unit-tests: npm test (test, 900s): package.json declares a test script');
    expect(r.out).toContain('go-vet: go vet ./... (lint, 300s): go.mod');
    expect(r.out).toMatch(/no check proposed for rust: .*cargo was not found on PATH/);
    expect(r.out).toMatch(/Next: review the proposed checks in \.orbit\/config\.yaml/);
  });

  it('is deterministic for a repository, and the rendering is valid YAML with a comment per check', async () => {
    const files = Object.keys(mixed);
    const a = await detectChecks({ repo: repoWith(mixed).repo, files, pathEnv: pathWith(['npm', 'go']) });
    const b = await detectChecks({ repo: repoWith(mixed).repo, files, pathEnv: pathWith(['npm', 'go']) });
    expect(a).toEqual(b);
    const yaml = renderChecksYaml(a.proposed);
    expect(yaml.match(/# Proposed by "orbit init"/g)).toHaveLength(a.proposed.length);
    expect(Object.keys((parse(`checks:\n${yaml}`) as { checks: object }).checks)).toEqual(a.proposed.map((c) => c.id));
  });
});

// Real tools: init proposes on the real PATH, and each proposed command then runs green on a tiny acme project.
const hasTool = (name: string): boolean => {
  try {
    execFileSync(name, name === 'go' ? ['version'] : ['--version'], { stdio: 'ignore', timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
};

async function initReal(l: Lab) {
  const r = await l.cli(['init', '--json'], { env: envFor(l) });
  expect(r.code, r.err).toBe(0);
  return JSON.parse(r.out) as InitJson;
}

function runProposed(l: Lab, json: InitJson, ids: string[], env: NodeJS.ProcessEnv = {}): void {
  for (const id of ids) {
    const c = json.checks.proposed.find((p) => p.id === id);
    expect(c, `${id} proposed`).toBeDefined();
    execFileSync(c!.command[0]!, c!.command.slice(1), { cwd: l.repo, stdio: 'pipe', timeout: 240_000, env: { ...process.env, ...env } });
  }
}

describe('init proposes checks: with the real tools', () => {
  it.skipIf(!hasTool('go'))('go: the proposed build, vet and test run green', async () => {
    const l = repoWith({ 'go.mod': 'module acme.test/app\n\ngo 1.21\n', 'main.go': 'package main\n\nfunc main() {}\n', 'main_test.go': 'package main\n\nimport "testing"\n\nfunc TestAcme(t *testing.T) {}\n' });
    const json = await initReal(l);
    expect(json.checks.proposed.map((c) => c.id)).toEqual(['build', 'vet', 'unit-tests']);
    runProposed(l, json, ['build', 'vet', 'unit-tests'], { GOTOOLCHAIN: 'local' });
  }, 300_000);

  it.skipIf(!hasTool('cargo'))('rust: the proposed build and test run green', async () => {
    const l = repoWith({ 'Cargo.toml': '[package]\nname = "acme"\nversion = "0.1.0"\nedition = "2021"\n', 'src/main.rs': 'fn main() {}\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn acme() {}\n}\n' });
    const json = await initReal(l);
    expect(json.checks.proposed.map((c) => c.id)).toEqual(expect.arrayContaining(['build', 'unit-tests']));
    runProposed(l, json, ['build', 'unit-tests'], { CARGO_NET_OFFLINE: 'true' });
  }, 600_000);

  it.skipIf(!hasTool('pytest'))('python: the proposed pytest runs green', async () => {
    const l = repoWith({ 'pyproject.toml': '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n', 'tests/test_acme.py': 'def test_acme():\n    assert 1 + 1 == 2\n' });
    const json = await initReal(l);
    expect(json.checks.proposed.map((c) => c.id)).toEqual(['unit-tests']);
    runProposed(l, json, ['unit-tests']);
  }, 120_000);

  it.skipIf(!hasTool('npm'))('node: the proposed test script runs green', async () => {
    const l = repoWith({ 'package.json': pkg({ scripts: { test: 'node -e "process.exit(0)"' } }), 'package-lock.json': '{}' });
    const json = await initReal(l);
    expect(json.checks.proposed.map((c) => c.id)).toEqual(['unit-tests']);
    runProposed(l, json, ['unit-tests']);
  }, 120_000);

  it.skipIf(!hasTool('dotnet'))('dotnet: the proposal for a project names a build that the SDK accepts', async () => {
    const l = repoWith({ 'Acme.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n', 'Program.cs': 'System.Console.WriteLine("acme");\n' });
    const json = await initReal(l);
    expect(json.checks.proposed.map((c) => c.command.join(' '))).toEqual(['dotnet build Acme.csproj -m:1']);
    // The command is only started (its help), not built: a restore may need the network and a framework this SDK lacks.
    execFileSync('dotnet', ['build', '--help'], { cwd: l.repo, stdio: 'pipe', timeout: 120_000, env: { ...process.env, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' } });
  }, 180_000);
});
