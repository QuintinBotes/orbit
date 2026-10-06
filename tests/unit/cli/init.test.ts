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
