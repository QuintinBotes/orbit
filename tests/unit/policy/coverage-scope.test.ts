import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScopeReport } from '../../../src/evidence/types.ts';
import { effectiveProtectedPaths } from '../../../src/policy/builtin.ts';
import { parseConfig } from '../../../src/policy/config.ts';
import { inspectScope } from '../../../src/policy/scope.ts';
import type { PolicySnapshot } from '../../../src/policy/types.ts';

const gitAvailable = spawnSync('git', ['--version']).status === 0;

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Acme Dev',
  GIT_AUTHOR_EMAIL: 'dev@example.com',
  GIT_COMMITTER_NAME: 'Acme Dev',
  GIT_COMMITTER_EMAIL: 'dev@example.com',
};

function snapshotOf(yaml: string): PolicySnapshot {
  const config = parseConfig(`version: 1\n${yaml}`);
  return { schema: 'orbit.policy/1', run_id: 'orb-sc', created_at: '', repo_root: '/', config, effective_protected_paths: effectiveProtectedPaths(config), check_config_hashes: {} };
}

const SNAPSHOT = snapshotOf('scope: {allowed_paths: ["**"], protected_paths: [".github/**"]}\nscheduler: {hard_limits: {changed_files: 3, changed_lines: 10}}\n');

type Files = Record<string, string | Buffer | { link: string } | { gitlink: true }>;

interface Scenario {
  repo: string;
  base: string;
  cand: string;
  report: () => Promise<ScopeReport>;
}

let top: string;
let counter = 0;

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

function apply(repo: string, files: Files, remove: string[] = []): void {
  for (const rel of remove) unlinkSync(join(repo, rel));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(repo, rel);
    mkdirSync(dirname(abs), { recursive: true });
    if (typeof content === 'object' && !Buffer.isBuffer(content) && 'link' in content) {
      try {
        unlinkSync(abs);
      } catch {
        /* new link */
      }
      symlinkSync(content.link, abs);
    } else if (typeof content === 'object' && !Buffer.isBuffer(content) && 'gitlink' in content) {
      sh(repo, 'update-index', '--add', '--cacheinfo', `160000,${sh(repo, 'rev-parse', 'HEAD')},${rel}`);
    } else {
      writeFileSync(abs, content as string | Buffer);
    }
  }
}

function scenario(base: Files, cand: Files, remove: string[] = [], snapshot: PolicySnapshot = SNAPSHOT, extra: { contract?: string[]; baseline?: string[] } = {}): Scenario {
  const repo = join(top, `repo-${(counter += 1)}`);
  mkdirSync(repo, { recursive: true });
  sh(repo, 'init', '-q', '-b', 'main');
  apply(repo, { '.keep': '' });
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'init');
  apply(repo, base);
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '--allow-empty', '-m', 'base');
  const baseRev = sh(repo, 'rev-parse', 'HEAD');
  apply(repo, cand, remove);
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '--allow-empty', '-m', 'candidate');
  const candRev = sh(repo, 'rev-parse', 'HEAD');
  return {
    repo,
    base: baseRev,
    cand: candRev,
    report: () =>
      inspectScope({
        repoRoot: repo,
        baseRev,
        candidateRev: candRev,
        snapshot,
        ...(extra.contract ? { contractAllowedPaths: extra.contract } : {}),
        ...(extra.baseline ? { uiBaselineGlobs: extra.baseline } : {}),
      }),
  };
}

const manifests = async (base: Files, cand: Files, remove: string[] = []): Promise<string[]> => (await scenario(base, cand, remove).report()).dependency_manifest_changed;

beforeAll(() => {
  top = mkdtempSync(join(tmpdir(), 'orbit-scope-cov-'));
});
afterAll(() => rmSync(top, { recursive: true, force: true }));

describe.skipIf(!gitAvailable)('dependency manifests by kind', () => {
  it('TOML manifests compare only their dependency sections', async () => {
    const cargo = (version: string, dep: string) => `[package]\nname = "acme"\nversion = "${version}"\n\n[dependencies]\nserde = "${dep}"\n`;
    expect(await manifests({ 'Cargo.toml': cargo('1.0.0', '1') }, { 'Cargo.toml': cargo('1.1.0', '1') })).toEqual([]);
    expect(await manifests({ 'Cargo.toml': cargo('1.0.0', '1') }, { 'Cargo.toml': cargo('1.0.0', '2') })).toEqual(['Cargo.toml']);
    // comments and trailing comments are not changes
    const commented = '[dependencies]\nserde = "1" # pinned\n# a note\n\n';
    const plain = '[dependencies]\nserde = "1"\n';
    expect(await manifests({ 'Cargo.toml': commented }, { 'Cargo.toml': plain })).toEqual([]);
  });

  it('pyproject: PEP 621 dependency arrays, requires-python, poetry groups and uv tables', async () => {
    const py = (deps: string, python = '>=3.11') => `[project]\nname = "acme"\nversion = "0.1"\nrequires-python = "${python}"\ndependencies = [\n${deps}\n]\n\n[tool.other]\nx = 1\n`;
    expect(await manifests({ 'pyproject.toml': py('  "requests>=2",') }, { 'pyproject.toml': py('  "requests>=2",').replace('version = "0.1"', 'version = "0.2"') })).toEqual([]);
    expect(await manifests({ 'pyproject.toml': py('  "requests>=2",') }, { 'pyproject.toml': py('  "requests>=3",') })).toEqual(['pyproject.toml']);
    expect(await manifests({ 'pyproject.toml': py('  "requests>=2",') }, { 'pyproject.toml': py('  "requests>=2",', '>=3.12') })).toEqual(['pyproject.toml']);
    const oneLine = (d: string) => `[project]\nname = "a"\ndependencies = ["${d}"]\n`;
    expect(await manifests({ 'pyproject.toml': oneLine('a') }, { 'pyproject.toml': oneLine('b') })).toEqual(['pyproject.toml']);
    const poetry = (v: string) => `[tool.poetry.group.dev.dependencies]\npytest = "${v}"\n`;
    expect(await manifests({ 'pyproject.toml': poetry('7') }, { 'pyproject.toml': poetry('8') })).toEqual(['pyproject.toml']);
    const uv = (v: string) => `[tool.uv]\nindex-url = "${v}"\n`;
    expect(await manifests({ 'pyproject.toml': uv('https://a.example') }, { 'pyproject.toml': uv('https://b.example') })).toEqual(['pyproject.toml']);
    expect(await manifests({ Pipfile: '[packages]\nrequests = "*"\n' }, { Pipfile: '[packages]\nrequests = "==2.0"\n' })).toEqual(['Pipfile']);
  });

  it('package.json compares dependency sections structurally, including pnpm settings', async () => {
    const pkg = (o: object) => JSON.stringify(o, null, 2);
    expect(await manifests({ 'package.json': pkg({ name: 'a', dependencies: { x: '1' } }) }, { 'package.json': JSON.stringify({ dependencies: { x: '1' }, name: 'renamed' }) })).toEqual([]);
    expect(await manifests({ 'package.json': pkg({ pnpm: { overrides: { x: '1' } } }) }, { 'package.json': pkg({ pnpm: { overrides: { x: '2' } } }) })).toEqual(['package.json']);
    expect(await manifests({ 'package.json': pkg({ pnpm: { other: 1 } }) }, { 'package.json': pkg({ pnpm: { other: 2 } }) })).toEqual([]);
    expect(await manifests({ 'package.json': pkg({ scripts: { a: '1' } }) }, { 'package.json': pkg({ scripts: { a: '2' } }) })).toEqual([]);
    expect(await manifests({ 'package.json': pkg({ engines: { node: '20' } }) }, { 'package.json': pkg({ engines: { node: '22' } }) })).toEqual(['package.json']);
  });

  it('unparseable or non-object JSON compares by its raw text, so a broken manifest never reads as unchanged', async () => {
    expect(await manifests({ 'package.json': '{broken' }, { 'package.json': '{broken' })).toEqual([]);
    expect(await manifests({ 'package.json': '{broken' }, { 'package.json': '{broken!' })).toEqual(['package.json']);
    expect(await manifests({ 'package.json': '[1]' }, { 'package.json': '[2]' })).toEqual(['package.json']);
    expect(await manifests({ 'package.json': 'null' }, { 'package.json': '{"dependencies":{}}' })).toEqual(['package.json']);
  });

  it('composer and deno manifests: their own sections, with deno comments ignored', async () => {
    expect(await manifests({ 'composer.json': '{"require":{"a":"1"}}' }, { 'composer.json': '{"require":{"a":"2"}}' })).toEqual(['composer.json']);
    expect(await manifests({ 'composer.json': '{"name":"a"}' }, { 'composer.json': '{"name":"b"}' })).toEqual([]);
    const deno = (imp: string, extra = '') => `// header comment\n{\n  /* block */\n  "imports": { "x": "${imp}" }${extra}\n}\n`;
    expect(await manifests({ 'deno.json': deno('jsr:@a/x@1') }, { 'deno.json': deno('jsr:@a/x@1', ',\n  "name": "n"') })).toEqual([]);
    expect(await manifests({ 'deno.jsonc': deno('jsr:@a/x@1') }, { 'deno.jsonc': deno('jsr:@a/x@2') })).toEqual(['deno.jsonc']);
  });

  it('whole-file manifests ignore blank and comment lines but nothing else', async () => {
    expect(await manifests({ 'requirements.txt': 'requests==2\n' }, { 'requirements.txt': '# pinned\n\n  requests==2  \n// note\n' })).toEqual([]);
    expect(await manifests({ 'requirements-dev.in': 'pytest\n' }, { 'requirements-dev.in': 'pytest\nblack\n' })).toEqual(['requirements-dev.in']);
    expect(await manifests({ 'go.mod': 'module a\n' }, { 'go.mod': 'module a\nrequire x v1\n' })).toEqual(['go.mod']);
    expect(await manifests({ 'app/Api.csproj': '<Project/>' }, { 'app/Api.csproj': '<Project><ItemGroup/></Project>' })).toEqual(['app/Api.csproj']);
    expect(await manifests({ '.npmrc': 'a=1' }, { '.npmrc': 'a=2' })).toEqual([]);
  });

  it('an added or deleted manifest is a change, and an unreadable base blob counts as absent', async () => {
    expect(await manifests({}, { 'package.json': '{}' })).toEqual(['package.json']);
    expect(await manifests({ 'package.json': '{}' }, {}, ['package.json'])).toEqual(['package.json']);
    expect(await manifests({ 'package.json': { gitlink: true } }, { 'package.json': '{"dependencies":{}}' })).toEqual(['package.json']);
  });
});

describe.skipIf(!gitAvailable)('escaping symlinks', () => {
  const links = async (files: Files, remove: string[] = []) => (await scenario({ 'real/x.txt': 'x' }, files, remove).report()).symlinks_escaping;

  it('flags absolute, home-relative and Windows-drive targets and ones that climb out of the repository', async () => {
    expect(await links({ 'a/abs': { link: '/etc/passwd' } })).toEqual(['a/abs']);
    expect(await links({ 'a/home': { link: '~/secret' } })).toEqual(['a/home']);
    expect(await links({ 'a/win': { link: 'C:\\Windows\\x' } })).toEqual(['a/win']);
    expect(await links({ 'a/up': { link: '../../out' } })).toEqual(['a/up']);
    expect(await links({ 'top': { link: '../out' } })).toEqual(['top']);
  });

  it('follows links through links and judges the final location', async () => {
    expect(await links({ 'a/ok': { link: '../real/x.txt' } })).toEqual([]);
    expect(await links({ 'a/dots': { link: './../real//x.txt' } })).toEqual([]);
    expect(await links({ 'a/one': { link: 'two' }, 'a/two': { link: '../real/x.txt' } })).toEqual([]);
    expect(await links({ 'a/one': { link: 'two' }, 'a/two': { link: '/etc/hosts' } })).toEqual(['a/one', 'a/two']);
    expect(await links({ 'a/loop1': { link: 'loop2' }, 'a/loop2': { link: 'loop1' } })).toEqual(['a/loop1', 'a/loop2']);
  });

  it('flags a link that lands on a protected path, and ignores deleted links', async () => {
    expect(await links({ 'a/prot': { link: '../.github/workflows/ci.yml' } })).toEqual(['a/prot']);
    const s = scenario({ 'a/gone': { link: 'x' } }, {}, ['a/gone']);
    expect((await s.report()).symlinks_escaping).toEqual([]);
  });
});

describe.skipIf(!gitAvailable)('line counting and binary files', () => {
  it('counts lines of a file git calls binary only because of an attribute, using the text patch', async () => {
    const r = await scenario(
      { '.gitattributes': '*.png -diff\n', 'a/pic.png': 'one\ntwo\n' },
      { 'a/pic.png': 'one\nTWO\nthree\n' },
    ).report();
    expect(r.changed_files).toBe(1);
    expect(r.changed_lines).toBe(3);
  });

  it('counts a changed file with a text name even when it contains a NUL byte', async () => {
    const r = await scenario({ 'a/data.xyz': Buffer.from('a\0b\n') }, { 'a/data.xyz': Buffer.from('a\0c\nd\n') }).report();
    expect(r.changed_lines).toBe(3);
  });

  it('does not count a genuine binary asset, and reports no weakening for it', async () => {
    const r = await scenario({ 'a/pic.png': Buffer.from([0x89, 0x50, 0, 1]) }, { 'a/pic.png': Buffer.from([0x89, 0x50, 0, 2]) }).report();
    expect(r).toMatchObject({ changed_files: 1, changed_lines: 0, weakening_signals: [] });
  });

  it('a deleted binary asset with textual content is also read from the base', async () => {
    const r = await scenario({ '.gitattributes': '*.png -diff\n', 'a/pic.png': 'x\ny\n' }, {}, ['a/pic.png']).report();
    expect(r.changed_lines).toBe(2);
  });

  it('enforces the size limits on files and lines', async () => {
    const small = await scenario({ 'a.txt': 'x\n' }, { 'a.txt': 'y\n' }).report();
    expect(small.within_size_limits).toBe(true);
    const many = await scenario({}, { 'a.txt': '1', 'b.txt': '2', 'c.txt': '3', 'd.txt': '4' }).report();
    expect(many.within_size_limits).toBe(false);
    const long = await scenario({}, { 'a.txt': `${'x\n'.repeat(11)}` }).report();
    expect(long).toMatchObject({ changed_lines: 11, within_size_limits: false });
  });
});

describe.skipIf(!gitAvailable)('per-file patches for unusual names and large changes', () => {
  const NAMES = ['q"uote', 'back\\slash', 'tab\tname', 'new\nline', 'cr\rname', 'bell\x07name', 'back\bspace', 'form\ffeed', 'vtab\vname', 'esc\x1bname', 'del\x7fname', 'sp ace', 'ünï'];

  it('attributes weakening to files whose names git quotes in its patch headers', async () => {
    const base: Files = {};
    const cand: Files = {};
    for (const [i, n] of NAMES.entries()) {
      base[`tests/${i}-${n}.test.ts`] = "it('a', () => {\n  expect(a).toBe(1);\n});\n";
      cand[`tests/${i}-${n}.test.ts`] = "it.skip('a', () => {\n  expect(a).toBe(1);\n});\n";
    }
    const sc = scenario(base, cand, [], snapshotOf('scope: {allowed_paths: ["**"]}\nscheduler: {hard_limits: {changed_files: 100}}\n'));
    const r = await sc.report();
    const skipped = new Set(r.weakening_signals.filter((s) => s.signal === 'test-skipped').map((s) => s.path));
    for (const [i, n] of NAMES.entries()) expect(skipped.has(`tests/${i}-${n}.test.ts`), JSON.stringify(n)).toBe(true);
  });

  it('inspects more than 400 changed text files in chunks', async () => {
    const base: Files = {};
    const cand: Files = {};
    for (let i = 0; i < 405; i++) {
      base[`tests/t${i}.test.ts`] = "it('a', () => {\n  expect(a).toBe(1);\n});\n";
      cand[`tests/t${i}.test.ts`] = "it.skip('a', () => {\n  expect(a).toBe(1);\n});\n";
    }
    const r = await scenario(base, cand).report();
    expect(r.changed_files).toBe(405);
    expect(r.weakening_signals.filter((s) => s.signal === 'test-skipped')).toHaveLength(405);
  });
});

describe.skipIf(!gitAvailable)('scope decisions', () => {
  const NARROW = snapshotOf('scope: {allowed_paths: ["apps/**", "docs/**"], protected_paths: [".github/**"]}\nui: {visual: {baseline_globs: ["**/snap/**"]}}\n');

  it('a contract can only narrow the policy scope, and protected paths win over both', async () => {
    const r = await scenario({}, { 'apps/a.ts': 'x', 'docs/d.md': 'x', 'other/o.ts': 'x', '.github/ci.yml': 'x' }, [], NARROW, { contract: ['apps/**'] }).report();
    expect(r.forbidden_paths_changed).toEqual(['.github/ci.yml']);
    expect(r.out_of_scope_paths_changed.sort()).toEqual(['docs/d.md', 'other/o.ts']);
    expect(r.allowed_paths_pass).toBe(false);
  });

  it('visual baselines come from the snapshot unless the caller supplies globs', async () => {
    const files = { 'apps/snap/a.png': Buffer.from([0, 1]), 'apps/other/b.png': Buffer.from([0, 2]) };
    expect((await scenario({}, files, [], NARROW).report()).visual_baseline_changes).toEqual(['apps/snap/a.png']);
    expect((await scenario({}, files, [], NARROW, { baseline: ['apps/other/**'] }).report()).visual_baseline_changes).toEqual(['apps/other/b.png']);
    expect((await scenario({}, files, [], SNAPSHOT).report()).visual_baseline_changes).toEqual([]);
  });

  it('lockfiles are recognised by name anywhere in the tree', async () => {
    expect((await scenario({}, { 'sub/Cargo.lock': 'x' }).report()).lockfile_changed).toBe(true);
    expect((await scenario({}, { 'sub/other.lock': 'x' }).report()).lockfile_changed).toBe(false);
  });

  it('reports no changes for identical revisions', async () => {
    const sc = scenario({ 'a.txt': 'x' }, {});
    const r = await inspectScope({ repoRoot: sc.repo, baseRev: sc.base, candidateRev: sc.base, snapshot: SNAPSHOT });
    expect(r).toMatchObject({ changed_files: 0, changed_lines: 0, allowed_paths_pass: true, weakening_signals: [] });
  });
});

describe.skipIf(!gitAvailable)('revision and repository validation', () => {
  it('refuses revisions that could be read as options or are not a single commit name', async () => {
    const sc = scenario({ 'a.txt': 'x' }, { 'a.txt': 'y' });
    const run = (baseRev: string, candidateRev = sc.cand) => inspectScope({ repoRoot: sc.repo, baseRev, candidateRev, snapshot: SNAPSHOT });
    for (const bad of ['', '--output=x', '-n', 'a b', 'a\tb', 'a\0b', 'x'.repeat(257)]) {
      await expect(run(bad), JSON.stringify(bad.slice(0, 12))).rejects.toMatchObject({ code: 'GIT_FAILED', message: expect.stringContaining('invalid revision') });
    }
    await expect(run(undefined as unknown as string)).rejects.toMatchObject({ code: 'GIT_FAILED' });
    await expect(run('no-such-ref')).rejects.toMatchObject({ code: 'GIT_FAILED', message: expect.stringContaining('rev-parse failed') });
    await expect(run(sc.base, 'also-missing')).rejects.toMatchObject({ code: 'GIT_FAILED' });
  });

  it('reports git failures with the command name and keeps the cause', async () => {
    const notARepo = join(top, 'plain-dir');
    mkdirSync(notARepo);
    let caught: unknown;
    try {
      await inspectScope({ repoRoot: notARepo, baseRev: 'HEAD', candidateRev: 'HEAD', snapshot: SNAPSHOT });
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({ code: 'GIT_FAILED', details: { args: expect.arrayContaining(['rev-parse']) } });
    expect((caught as Error).cause).toBeDefined();
  });
});
