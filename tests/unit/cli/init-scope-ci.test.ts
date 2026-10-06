/** Issue 4: `orbit init` must not propose CI pipeline or build-system definitions as scope; it protects them and says to narrow the scope. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { classifyCiDefinitions, isPipelineYaml, suggestAllowedPaths } from '../../../src/cli/layout.ts';
import { makeLab, type Lab } from './lab.ts';

const labs: Lab[] = [];
afterEach(() => labs.splice(0).forEach((l) => l.close()));

const GIT_ENV = { GIT_AUTHOR_NAME: 'acme', GIT_AUTHOR_EMAIL: 'dev@acme.test', GIT_COMMITTER_NAME: 'acme', GIT_COMMITTER_EMAIL: 'dev@acme.test', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();

/** A synthetic large "acme" repository: source folders, a pipelines folder, a tools folder of build templates, and the usual CI and build files. */
const ACME: Record<string, string> = {
  'src/app/main.ts': 'export {};\n',
  'services/billing/index.ts': 'export {};\n',
  'libs/core/index.ts': 'export {};\n',
  'tests/billing.test.ts': 'export {};\n',
  'docs/guide.md': '# acme\n',
  'pipelines/azure-pipelines.yml': 'trigger:\n  - main\nstages:\n  - stage: build\n',
  'pipelines/templates/build.yml': 'jobs:\n  - job: build\n',
  'tools/build/release.yml': 'extends:\n  template: base.yml\n',
  'tools/build/pack.ps1': 'Write-Host acme\n',
  'tools/build/run.sh': 'echo acme\n',
  '.github/workflows/ci.yml': 'on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n',
  '.gitlab-ci.yml': 'stages: [build]\n',
  '.circleci/config.yml': 'version: 2.1\n',
  'Jenkinsfile': 'pipeline {}\n',
  'Directory.Build.props': '<Project/>\n',
  'Directory.Packages.props': '<Project/>\n',
  'global.json': '{}\n',
  'nuget.config': '<configuration/>\n',
  'Makefile': 'all:\n',
};

function acmeLab(files: Record<string, string> = ACME): Lab {
  const l = makeLab();
  labs.push(l);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(l.repo, name)), { recursive: true });
    writeFileSync(join(l.repo, name), text);
  }
  git(l.repo, 'add', '-A');
  git(l.repo, 'commit', '-q', '-m', 'acme layout');
  return l;
}

const config = (l: Lab) => parse(readFileSync(join(l.repo, '.orbit', 'config.yaml'), 'utf8')) as { scope: { allowed_paths: string[]; protected_paths: string[] } };

describe('Issue 4: init keeps CI and build definitions out of the proposed scope', () => {
  it('proposes only source folders and protects the pipeline folders', async () => {
    const l = acmeLab();
    const r = await l.cli(['init']);
    expect(r.code, r.err).toBe(0);
    const { scope } = config(l);
    expect(scope.allowed_paths).toEqual(['docs/**', 'libs/**', 'services/**', 'src/**', 'tests/**']);
    expect(scope.protected_paths).toEqual(expect.arrayContaining(['.github/**', 'infra/**', '.orbit/config.yaml', '**/.env*', 'pipelines/**', 'tools/**', '.gitlab-ci.yml', '.circleci/**', 'Jenkinsfile', 'Directory.Build.props', 'Directory.Packages.props', 'global.json', 'nuget.config', 'Makefile']));
    expect(r.out).toMatch(/left out of scope\.allowed_paths because they hold CI or build definitions: pipelines, tools/);
  });

  it('tells the person to narrow the scope to the goal, and reports the additions in --json', async () => {
    const l = acmeLab();
    const j = JSON.parse((await l.cli(['init', '--json'])).out) as { config: { allowed_paths: string[]; protected_paths_added: string[]; excluded_dirs: string[] } };
    expect(j.config.excluded_dirs).toEqual(['pipelines', 'tools']);
    expect(j.config.protected_paths_added).toContain('pipelines/**');
    const l2 = acmeLab();
    expect((await l2.cli(['init'])).out).toMatch(/Narrow scope\.allowed_paths to the folders your goal needs/);
  });

  it('writes no duplicate protections and no scope warning or scope problem', async () => {
    const l = acmeLab();
    const r = await l.cli(['init']);
    const { scope } = config(l);
    expect(new Set(scope.protected_paths).size).toBe(scope.protected_paths.length);
    expect(r.out).not.toMatch(/WARN/);
    expect(r.out).not.toMatch(/ {2}- .*scope/);
  });

  it('keeps a source folder that merely holds pipeline files in scope and protects just those', () => {
    const files = ['src/a.ts', 'src/azure-pipelines.yml', 'src/deep/ci/build.yml', 'src/deep/ci/main.ts'];
    const ci = classifyCiDefinitions(files, (f) => f.endsWith('.yml'));
    expect(ci.excludedDirs).toEqual([]);
    expect(ci.protectedPaths).toEqual(['src/azure-pipelines.yml', 'src/deep/ci/**']);
    expect(suggestAllowedPaths(files, ci.excludedDirs)).toEqual(['src/**']);
  });

  it('protects central build files wherever they sit, and Makefile only at the root', () => {
    const ci = classifyCiDefinitions(['Makefile', 'src/Makefile', 'src/Directory.Build.props', 'src/a.cs']);
    expect(ci.protectedPaths).toEqual(['Makefile', 'src/Directory.Build.props']);
    expect(ci.excludedDirs).toEqual([]);
  });

  it('recognises pipeline YAML by its top-level keys only', () => {
    expect(isPipelineYaml('trigger:\n- main\n')).toBe(true);
    expect(isPipelineYaml('stages:\n- build\n')).toBe(true);
    expect(isPipelineYaml('jobs:\n- job: a\n')).toBe(true);
    expect(isPipelineYaml('extends:\n  template: t.yml\n')).toBe(true);
    expect(isPipelineYaml('name: acme\nsettings:\n  jobs: 4\n  trigger: x\n')).toBe(false);
    expect(isPipelineYaml('extends: base\n')).toBe(false);
  });
});
