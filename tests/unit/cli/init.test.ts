import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXCLUDE_RULES } from '../../../src/cli/commands/init.ts';
import { makeLab, type Lab } from './lab.ts';

const labs: Lab[] = [];
const lab = (o?: Parameters<typeof makeLab>[0]) => {
  const l = makeLab(o);
  labs.push(l);
  return l;
};
afterEach(() => labs.splice(0).forEach((l) => l.close()));

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();

describe('orbit init', () => {
  it('writes the starter config and the exclude rules', async () => {
    const l = lab();
    const r = await l.cli(['init']);
    expect(r.code, r.err).toBe(0);
    const cfg = readFileSync(join(l.repo, '.orbit', 'config.yaml'), 'utf8');
    expect(cfg).toContain('# Orbit configuration (.orbit/config.yaml)');
    const exclude = readFileSync(join(l.repo, '.git', 'info', 'exclude'), 'utf8');
    for (const rule of EXCLUDE_RULES) expect(exclude).toContain(rule);
    // config.yaml is reviewed like code and stays visible to git; runtime state does not.
    expect(exclude).not.toMatch(/config\.yaml/);
    expect(r.out).toMatch(/created .*config\.yaml/);
  });

  it('is idempotent: a second run changes nothing, and never overwrites an edited config', async () => {
    const l = lab();
    await l.cli(['init']);
    const path = join(l.repo, '.orbit', 'config.yaml');
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n# my edit\n`);
    const before = readFileSync(path, 'utf8');
    const excludeBefore = readFileSync(join(l.repo, '.git', 'info', 'exclude'), 'utf8');
    const r = await l.cli(['init', '--json']);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out) as { config: { status: string }; exclude: { added: string[] } };
    expect(j.config.status).toBe('exists');
    expect(j.exclude.added).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(readFileSync(join(l.repo, '.git', 'info', 'exclude'), 'utf8')).toBe(excludeBefore);
  });

  it('adds only the rules that are missing and keeps the user\'s own lines', async () => {
    const l = lab();
    const ex = join(l.repo, '.git', 'info', 'exclude');
    writeFileSync(ex, `${readFileSync(ex, 'utf8')}*.scratch\n/.orbit/runs/\n`);
    await l.cli(['init']);
    const text = readFileSync(ex, 'utf8');
    expect(text).toContain('*.scratch');
    expect(text.split('\n').filter((x) => x === '/.orbit/runs/')).toHaveLength(1);
    expect(text).toContain('/.orbit/state.sqlite*');
  });

  it('keeps runtime state out of git status while the config stays visible', async () => {
    const l = lab();
    await l.cli(['init']);
    git(l.repo, 'add', '.orbit/config.yaml');
    git(l.repo, '-c', 'user.name=acme', '-c', 'user.email=dev@acme.test', 'commit', '-q', '-m', 'orbit config');
    mkdirSync(join(l.repo, '.orbit', 'runs', 'r1'), { recursive: true });
    writeFileSync(join(l.repo, '.orbit', 'runs', 'r1', 'policy.json'), '{}');
    for (const f of ['state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm', 'knowledge.sqlite', 'knowledge.sqlite-wal']) writeFileSync(join(l.repo, '.orbit', f), '');
    expect(git(l.repo, 'status', '--porcelain')).toBe('');
    writeFileSync(join(l.repo, '.orbit', 'config.yaml'), 'version: 1\n');
    expect(git(l.repo, 'status', '--porcelain')).toContain('.orbit/config.yaml');
  });

  // Issue #3: a linked worktree used to resolve to the primary checkout, so init there reported the main tree's config
  // as "exists". The worktree is its own repository root now; only the exclude file is shared through the common dir.
  it('works from a subdirectory, and from a linked worktree writes the worktree\'s own config', async () => {
    const l = lab();
    mkdirSync(join(l.repo, 'sub'));
    const sub = await l.cli(['init'], { cwd: join(l.repo, 'sub') });
    expect(sub.code, sub.err).toBe(0);
    expect(existsSync(join(l.repo, '.orbit', 'config.yaml'))).toBe(true);
    const wt = join(l.base, 'wt');
    git(l.repo, 'worktree', 'add', '-q', '--detach', wt);
    const inWt = await l.cli(['init', '--json'], { cwd: wt });
    expect(inWt.code, inWt.err).toBe(0);
    const j = JSON.parse(inWt.out) as { config: { status: string; path: string }; exclude: { path: string; added: string[] } };
    expect(j.config).toMatchObject({ status: 'created', path: join(wt, '.orbit', 'config.yaml') });
    expect(existsSync(join(wt, '.orbit', 'config.yaml'))).toBe(true);
    // The exclude rules live in the shared .git/info/exclude, which the first init already filled.
    expect(j.exclude).toEqual({ path: join(l.repo, '.git', 'info', 'exclude'), added: [] });
  });

  // Issue #3 follow-up: git reads only the common git directory's info/exclude, so init in a linked worktree writes into
  // the main checkout's git directory. The maintainers keep that (one write covers every worktree, nothing is committed)
  // and init says so, so the write does not surprise a person who expects a worktree to change nothing outside it.
  describe('in a linked worktree the exclude file is shared, and init says so (#3)', () => {
    const SHARED = "that file is in the clone's common git directory, outside this worktree, and every worktree of this clone shares it";
    const excludeOf = (l: Lab) => join(l.repo, '.git', 'info', 'exclude');
    const linked = (l: Lab): string => {
      const wt = join(l.base, 'wt');
      git(l.repo, 'worktree', 'add', '-q', '--detach', wt);
      return wt;
    };
    const lineAbout = (out: string, path: string): string => out.split('\n').find((x) => x.includes(path)) ?? '';

    it('names the shared file and says every worktree shares it when it adds the rules', async () => {
      const l = lab();
      const wt = linked(l);
      const r = await l.cli(['init'], { cwd: wt });
      expect(r.code, r.err).toBe(0);
      const ex = excludeOf(l);
      expect(lineAbout(r.out, ex)).toBe(`added 3 rule(s) to ${ex} so runtime state stays out of git status; ${SHARED}, so one write covers them all`);
      expect(readFileSync(ex, 'utf8')).toContain('/.orbit/state.sqlite*');
    });

    it('says the same when the rules are already there', async () => {
      const l = lab();
      expect((await l.cli(['init'])).code).toBe(0);
      const wt = linked(l);
      const r = await l.cli(['init'], { cwd: wt });
      expect(r.code, r.err).toBe(0);
      const ex = excludeOf(l);
      expect(lineAbout(r.out, ex)).toBe(`${ex} already excludes Orbit runtime state; ${SHARED}`);
      // A second run in the same worktree is the same case: the rules exist and the note stays.
      expect(lineAbout((await l.cli(['init'], { cwd: wt })).out, ex)).toBe(`${ex} already excludes Orbit runtime state; ${SHARED}`);
    });

    it('reports the file and whether it is shared in --json, and keeps every existing field', async () => {
      const l = lab();
      const wt = linked(l);
      const first = JSON.parse((await l.cli(['init', '--json'], { cwd: wt })).out) as Record<string, unknown>;
      const ex = excludeOf(l);
      expect(first.exclude_file).toEqual({ path: ex, shared_across_worktrees: true });
      expect(first.exclude).toEqual({ path: ex, added: [...EXCLUDE_RULES] });
      for (const k of ['repo', 'review_policy', 'config', 'checks', 'config_problems', 'warnings', 'models']) expect(first, k).toHaveProperty(k);
      const again = JSON.parse((await l.cli(['init', '--json'], { cwd: wt })).out) as Record<string, unknown>;
      expect(again.exclude_file).toEqual({ path: ex, shared_across_worktrees: true });
      expect(again.exclude).toEqual({ path: ex, added: [] });
    });

    it('works from a subdirectory of the worktree', async () => {
      const l = lab();
      const wt = linked(l);
      mkdirSync(join(wt, 'sub'));
      const r = await l.cli(['init'], { cwd: join(wt, 'sub') });
      expect(r.code, r.err).toBe(0);
      expect(lineAbout(r.out, excludeOf(l))).toContain('every worktree of this clone shares it');
    });

    it('says nothing about worktrees in a normal checkout, even one that has linked worktrees, and flags it unshared in --json', async () => {
      const l = lab();
      linked(l);
      const ex = excludeOf(l);
      const r = await l.cli(['init'], { cwd: l.repo });
      expect(r.code, r.err).toBe(0);
      expect(lineAbout(r.out, ex)).toBe(`added 3 rule(s) to ${ex} so runtime state stays out of git status`);
      expect(r.out).not.toMatch(/worktree/i);
      const again = await l.cli(['init'], { cwd: l.repo });
      expect(lineAbout(again.out, ex)).toBe(`${ex} already excludes Orbit runtime state`);
      expect(again.out).not.toMatch(/worktree/i);
      const j = JSON.parse((await l.cli(['init', '--json'], { cwd: l.repo })).out) as { exclude: unknown; exclude_file: unknown };
      expect(j.exclude_file).toEqual({ path: ex, shared_across_worktrees: false });
      expect(j.exclude).toEqual({ path: ex, added: [] });
    });

    it('does not take a submodule for a linked worktree (its git directory is not the superproject\'s but is its own common one)', async () => {
      const l = lab();
      const sub = join(l.base, 'sub-origin');
      mkdirSync(sub);
      git(sub, 'init', '-q', '-b', 'main');
      writeFileSync(join(sub, 'lib.txt'), 'lib\n');
      git(sub, 'add', '-A');
      git(sub, '-c', 'user.name=acme', '-c', 'user.email=dev@acme.test', 'commit', '-q', '-m', 'lib');
      git(l.repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor/lib');
      const inSub = join(l.repo, 'vendor', 'lib');
      const r = await l.cli(['init', '--json'], { cwd: inSub });
      expect(r.code, r.err).toBe(0);
      const j = JSON.parse(r.out) as { repo: string; exclude: { path: string }; exclude_file: { path: string; shared_across_worktrees: boolean } };
      expect(j.repo).toBe(inSub);
      expect(j.exclude_file).toEqual({ path: j.exclude.path, shared_across_worktrees: false });
      expect((await l.cli(['init'], { cwd: inSub })).out).not.toMatch(/worktree/i);
    });
  });

  it('refuses outside a git repository', async () => {
    const l = lab({ git: false });
    const r = await l.cli(['init']);
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/not inside a git repository/);
  });

  it('reports what still needs attention in the starter instead of claiming it is ready', async () => {
    const l = lab();
    const r = await l.cli(['init', '--json']);
    const j = JSON.parse(r.out) as { config_problems: string[] };
    expect(Array.isArray(j.config_problems)).toBe(true);
  });

  // Decision 0007 (#6, #8): init writes the claude fallback and says how to choose ask or block.
  it('writes the review policy default and says how to choose ask or block', async () => {
    const l = lab();
    const r = await l.cli(['init']);
    expect(r.code, r.err).toBe(0);
    const cfg = readFileSync(join(l.repo, '.orbit', 'config.yaml'), 'utf8');
    expect(cfg).toMatch(/^ {2}providers: \[codex\]$/m);
    expect(cfg).toMatch(/^ {2}when_unavailable: claude$/m);
    expect(r.out).toMatch(/review: Codex reviews independently when it is usable.*Claude reviews in a separate session and every report says the review was not independent.*review\.when_unavailable: claude.*Set review\.when_unavailable to ask to be asked first, or to block to require an independent reviewer/);
    const again = JSON.parse((await l.cli(['init', '--json'])).out) as { review_policy: string | null };
    expect(again.review_policy).toBeNull();
  });
});
