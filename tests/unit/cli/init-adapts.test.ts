/** Nm4: `orbit init` adapts to the repository: its branch, and a layout that has no directories to scope to. */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { suggestAllowedPaths } from '../../../src/cli/layout.ts';
import { makeLab, type Lab } from './lab.ts';

const labs: Lab[] = [];
const lab = (o?: Parameters<typeof makeLab>[0]) => {
  const l = makeLab(o);
  labs.push(l);
  return l;
};
afterEach(() => labs.splice(0).forEach((l) => l.close()));

const GIT_ENV = { GIT_AUTHOR_NAME: 'acme', GIT_AUTHOR_EMAIL: 'dev@acme.test', GIT_COMMITTER_NAME: 'acme', GIT_COMMITTER_EMAIL: 'dev@acme.test', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();
const config = (l: Lab) => parse(readFileSync(join(l.repo, '.orbit', 'config.yaml'), 'utf8')) as { repository: { base_branch: string }; scope: { allowed_paths: string[] } };

function repoOn(l: Lab, branch: string, files: Record<string, string>): void {
  git(l.repo, 'checkout', '-q', '-B', branch);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(l.repo, name), text);
  git(l.repo, 'add', '-A');
  git(l.repo, 'commit', '-q', '--allow-empty', '-m', 'layout');
}

describe('Nm4: init derives base_branch from the repository', () => {
  it('writes the checked-out branch, not "main", in a master repository, and says so', async () => {
    const l = lab();
    repoOn(l, 'master', {});
    const r = await l.cli(['init']);
    expect(r.code, r.err).toBe(0);
    expect(config(l).repository.base_branch).toBe('master');
    expect(r.out).toMatch(/repository\.base_branch set to master from the checked-out branch/);
  });

  it('keeps main when the branch is main, and when HEAD is detached', async () => {
    const l = lab();
    await l.cli(['init']);
    expect(config(l).repository.base_branch).toBe('main');
    expect((await l.cli(['init'])).out).not.toMatch(/base_branch set/);
    const m = lab();
    git(m.repo, 'checkout', '-q', '--detach');
    await m.cli(['init']);
    expect(config(m).repository.base_branch).toBe('main');
  });
});

describe('Nm4: init adapts to a flat layout', () => {
  it('scopes to the source files at the top level when there are no source directories', async () => {
    const l = lab();
    repoOn(l, 'main', { 'index.js': 'export {};\n', 'util.js': 'export {};\n', 'package.json': '{}\n', 'LICENSE': 'x\n' });
    const r = await l.cli(['init']);
    expect(config(l).scope.allowed_paths).toEqual(['*.js']);
    expect(r.out).toMatch(/scope\.allowed_paths set to \*\.js from the repository layout/);
    expect(r.out).not.toMatch(/WARN/);
  });

  it('warns, with the fix, when nothing matches and nothing can be derived', async () => {
    const l = lab();
    const r = await l.cli(['init']);
    expect(r.out).toMatch(/WARN: scope\.allowed_paths \(apps\/\*\*, packages\/\*\*, tests\/\*\*, docs\/\*\*\) matches no tracked file/);
    expect(r.out).toMatch(/set scope\.allowed_paths/);
    const j = JSON.parse((await lab().cli(['init', '--json'])).out) as { warnings: string[] };
    expect(j.warnings[0]).toMatch(/matches no tracked file/);
  });

  it('suggestAllowedPaths: directories win over top-level files, and files give extension globs', () => {
    expect(suggestAllowedPaths(['src/a.ts', 'index.js'])).toEqual(['src/**']);
    expect(suggestAllowedPaths(['index.ts', 'main.py', 'main.test.py', 'README.md', 'package.json', 'Makefile'])).toEqual(['*.py', '*.ts']);
    expect(suggestAllowedPaths(['README.md', 'LICENSE'])).toEqual([]);
  });
});
