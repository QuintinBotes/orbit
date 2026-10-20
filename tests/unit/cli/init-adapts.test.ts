/** Nm4: `orbit init` adapts to the repository: its branch, and a layout that has no directories to scope to. */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { chooseBaseBranch } from '../../../src/cli/commands/init.ts';
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

/** A remote default branch without a network: what clone writes, refs/remotes/origin/<b> and origin/HEAD pointing at it. */
function remoteDefault(l: Lab, branch: string): void {
  git(l.repo, 'update-ref', `refs/remotes/origin/${branch}`, 'HEAD');
  git(l.repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${branch}`);
}

describe('#109: init takes base_branch from the remote default, not a checked-out feature branch', () => {
  it('writes origin/HEAD\'s branch when a feature branch is checked out, and warns naming both', async () => {
    const l = lab();
    repoOn(l, 'develop', {});
    remoteDefault(l, 'develop');
    git(l.repo, 'checkout', '-q', '-b', 'feature/x');
    const r = await l.cli(['init']);
    expect(r.code, r.err).toBe(0);
    expect(config(l).repository.base_branch).toBe('develop');
    expect(r.out).toMatch(/repository\.base_branch set to develop from origin's default branch \(refs\/remotes\/origin\/HEAD\)/);
    expect(r.out).toMatch(/WARN: repository\.base_branch is develop, origin's default branch, not the checked-out branch feature\/x/);
  });

  it('keeps main without a note or warning when origin/HEAD is main and main is checked out', async () => {
    const l = lab();
    remoteDefault(l, 'main');
    const r = await l.cli(['init']);
    expect(config(l).repository.base_branch).toBe('main');
    expect(r.out).not.toMatch(/base_branch/);
  });

  it('chooses by the rules: remote default first, the worktree\'s own branch in a linked worktree (#3), the checkout without a remote default (Nm4)', () => {
    const base = { remote: 'origin', linkedWorktree: false };
    expect(chooseBaseBranch({ ...base, checkedOut: 'feature/x', remoteDefault: 'develop' })).toMatchObject({ branch: 'develop', warning: expect.stringMatching(/not the checked-out branch feature\/x/) });
    expect(chooseBaseBranch({ ...base, checkedOut: 'master', remoteDefault: null })).toEqual({ branch: 'master', note: 'repository.base_branch set to master from the checked-out branch (the template says main); review it', warning: null });
    expect(chooseBaseBranch({ ...base, checkedOut: 'feature/x', remoteDefault: 'main' })).toMatchObject({ branch: null, note: null, warning: expect.stringMatching(/repository\.base_branch is main, origin's default branch, not the checked-out branch feature\/x/) });
    expect(chooseBaseBranch({ ...base, checkedOut: null, remoteDefault: 'develop' })).toMatchObject({ branch: 'develop', warning: null });
    const wt = chooseBaseBranch({ remote: 'origin', linkedWorktree: true, checkedOut: 'B', remoteDefault: 'develop' });
    expect(wt).toMatchObject({ branch: 'B', note: expect.stringMatching(/from the branch this linked worktree is on/) });
    expect(wt.warning).toMatch(/repository\.base_branch is B, but origin's default branch is develop \(refs\/remotes\/origin\/HEAD\): every run branches from B/);
    expect(chooseBaseBranch({ remote: 'upstream', linkedWorktree: false, checkedOut: 'x', remoteDefault: 'trunk' }).note).toMatch(/upstream's default branch \(refs\/remotes\/upstream\/HEAD\)/);
  });
});

describe('Nm4: init adapts to a flat layout', () => {
  it('scopes to the source files at the top level when there are no source directories', async () => {
    const l = lab();
    repoOn(l, 'main', { 'index.js': 'export {};\n', 'util.js': 'export {};\n', 'package.json': '{}\n', 'LICENSE': 'x\n' });
    const r = await l.cli(['init']);
    expect(config(l).scope.allowed_paths).toEqual(['*.js']);
    expect(r.out).toMatch(/scope\.allowed_paths set to \*\.js from the repository layout/);
    expect(r.out).not.toMatch(/WARN: .*scope/);
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
