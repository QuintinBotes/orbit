import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { makeLab, type Lab } from './lab.ts';

const labs: Lab[] = [];
afterEach(() => labs.splice(0).forEach((l) => l.close()));

function repoWith(files: Record<string, string> = {}): Lab {
  const l = makeLab();
  labs.push(l);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(l.repo, name)), { recursive: true });
    writeFileSync(join(l.repo, name), text);
  }
  execFileSync('git', ['add', '-A'], { cwd: l.repo });
  return l;
}

function gitIn(l: Lab, ...args: string[]): string {
  return execFileSync('git', args, { cwd: l.repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'acme', GIT_AUTHOR_EMAIL: 'dev@acme.test', GIT_COMMITTER_NAME: 'acme', GIT_COMMITTER_EMAIL: 'dev@acme.test', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
}

interface InitJson {
  config: { path: string; status: string; allowed_paths?: string[]; commit_advice?: string };
  checks: { proposed: unknown[]; not_proposed: unknown[] };
  warnings: string[];
}

const COMMIT_ADVICE = '.orbit/config.yaml is reviewed like code: commit it to share the policy. It shows as untracked until committed; runtime state stays excluded and is never committed.';
const IGNORED_ADVICE = '.orbit/config.yaml is ignored by git, so the policy is not shared or reviewed like code: remove the rule that ignores it (git check-ignore -v .orbit/config.yaml names it), then commit the file. Runtime state stays excluded and is never committed.';
const markers = ['package.json', 'tsconfig.json', '*.sln', '*.slnx', '*.csproj', '*.fsproj', '*.vbproj', 'pyproject.toml', 'setup.cfg', 'tox.ini', 'pytest.ini', 'mypy.ini', '.mypy.ini', 'ruff.toml', '.ruff.toml', '.flake8', 'requirements*.txt', 'requirements*.in', 'go.mod', 'go.work', 'Cargo.toml'];

describe('init explains missing derivations and config ownership', () => {
  const nineFolders = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`source${i}/index.ts`, 'export {};\n']));

  for (const [name, files, reason] of [
    ['nine source folders', nineFolders, 'there are 9 visible top-level source folders, more than the 8 init derives a scope from'],
    ['no source folder or flat source file', {}, 'no visible top-level source folder or recognised top-level source file was found'],
  ] as const) {
    for (const json of [false, true]) {
      it(`explains the retained example scope for ${name} in ${json ? 'JSON' : 'text'}`, async () => {
        const l = repoWith(files);
        const r = await l.cli(['init', ...(json ? ['--json'] : [])]);
        expect(r.code, r.err).toBe(0);
        const cfg = parse(readFileSync(join(l.repo, '.orbit', 'config.yaml'), 'utf8')) as { scope: { allowed_paths: string[] } };
        expect(cfg.scope.allowed_paths).toEqual(['apps/**', 'packages/**', 'tests/**', 'docs/**']);
        const output = json ? (JSON.parse(r.out) as InitJson).warnings.join('\n') : r.out;
        expect(output).toContain('no scope was derived');
        expect(output).toContain(reason);
        expect(output).toContain("the template's example paths (apps/**, packages/**, tests/**, docs/**) remain in scope.allowed_paths and must be edited");
        if (json) expect((JSON.parse(r.out) as InitJson).config.allowed_paths).toBeUndefined();
      });
    }
  }

  for (const json of [false, true]) {
    it(`names what check detection looked for when there are no recognised markers in ${json ? 'JSON' : 'text'}`, async () => {
      const l = repoWith({ 'src/index.ts': 'export {};\n' });
      const r = await l.cli(['init', ...(json ? ['--json'] : [])]);
      expect(r.code, r.err).toBe(0);
      const output = json ? (JSON.parse(r.out) as InitJson).warnings.join('\n') : r.out;
      expect(output).toContain('no checks were derived');
      expect(output).toContain('looked for');
      for (const marker of markers) expect(output).toContain(marker);
      if (json) expect((JSON.parse(r.out) as InitJson).checks).toEqual({ proposed: [], not_proposed: [] });
    });

    // Issue #63: a Python repository that declares pytest only in requirements-dev.txt. Init adds no new marker (Orbit
    // stays language-agnostic), but says that file alone is not enough, so the notice is not read as "it was found".
    it(`says a requirements file alone is not a check marker in ${json ? 'JSON' : 'text'}`, async () => {
      const l = repoWith({ 'requirements-dev.txt': 'pytest>=8\n', 'tests/test_a.py': 'def test_a():\n    assert True\n' });
      const r = await l.cli(['init', ...(json ? ['--json'] : [])]);
      expect(r.code, r.err).toBe(0);
      const output = json ? (JSON.parse(r.out) as InitJson).warnings.join('\n') : r.out;
      expect(output).toContain('no checks were derived');
      expect(output).toContain('read with the requirements*.txt, requirements*.in, .mypy.ini or .ruff.toml beside it (those alone are not enough)');
    });

    it(`gives commit advice for a newly created config in ${json ? 'JSON' : 'text'}`, async () => {
      const l = repoWith();
      const r = await l.cli(['init', ...(json ? ['--json'] : [])]);
      expect(r.code, r.err).toBe(0);
      if (json) expect((JSON.parse(r.out) as InitJson).config.commit_advice).toBe(COMMIT_ADVICE);
      else expect(r.out.split('\n')).toContain(COMMIT_ADVICE);
      expect(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: l.repo, encoding: 'utf8' })).toContain('?? .orbit/config.yaml');
    });
  }

  it('does not report derivation or creation advice when a committed config already exists', async () => {
    const l = repoWith();
    await l.cli(['init']);
    gitIn(l, 'add', '.orbit/config.yaml');
    gitIn(l, 'commit', '-q', '-m', 'policy');
    const text = await l.cli(['init']);
    expect(text.out).not.toMatch(/no scope was derived|no checks were derived|commit it to share the policy/);
    const j = JSON.parse((await l.cli(['init', '--json'])).out) as InitJson;
    expect(j.config.commit_advice).toBeUndefined();
    expect(j.warnings.join('\n')).not.toMatch(/no scope was derived|no checks were derived/);
  });

  // Issue #96: the advice follows git, so it repeats until git tracks the file.
  for (const json of [false, true]) {
    it(`repeats the commit advice for an existing config git does not track in ${json ? 'JSON' : 'text'}`, async () => {
      const l = repoWith();
      await l.cli(['init']);
      const r = await l.cli(['init', ...(json ? ['--json'] : [])]);
      expect(r.code, r.err).toBe(0);
      if (json) {
        const j = JSON.parse(r.out) as InitJson;
        expect(j.config.status).toBe('exists');
        expect(j.config.commit_advice).toBe(COMMIT_ADVICE);
      } else expect(r.out.split('\n')).toContain(COMMIT_ADVICE);
    });

    it(`says git ignores the config, not to commit it, in ${json ? 'JSON' : 'text'}`, async () => {
      const l = repoWith({ '.gitignore': '.orbit/\n' });
      const r = await l.cli(['init', ...(json ? ['--json'] : [])]);
      expect(r.code, r.err).toBe(0);
      if (json) expect((JSON.parse(r.out) as InitJson).config.commit_advice).toBe(IGNORED_ADVICE);
      else {
        expect(r.out.split('\n')).toContain(IGNORED_ADVICE);
        expect(r.out).not.toContain(COMMIT_ADVICE);
      }
    });
  }

  it('leaves only the config untracked after init, runtime state stays excluded', async () => {
    const l = repoWith();
    await l.cli(['init']);
    expect(gitIn(l, 'status', '--porcelain', '--untracked-files=all', '--', '.orbit')).toBe('?? .orbit/config.yaml\n');
  });

  it('reports empty check derivation even when a marker declares no checks', async () => {
    const l = repoWith({ 'src/index.ts': 'export {};\n', 'package.json': '{}\n' });
    const j = JSON.parse((await l.cli(['init', '--json'])).out) as InitJson;
    expect(j.checks).toEqual({ proposed: [], not_proposed: [] });
    expect(j.warnings.join('\n')).toContain('no checks were derived');
    expect(j.warnings.join('\n')).not.toContain('no marker files were found');
  });

  it('explains the scope limit even when the retained examples match tracked files', async () => {
    const l = repoWith({ ...nineFolders, 'docs/readme.md': 'docs\n' });
    const j = JSON.parse((await l.cli(['init', '--json'])).out) as InitJson;
    expect(j.warnings.join('\n')).toContain('no scope was derived');
    expect(j.warnings.join('\n')).not.toContain('matches no tracked file');
  });
});
