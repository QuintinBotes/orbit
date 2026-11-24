// scripts/fragments.mjs and the workflows around it: changelog and traceability fragments, a bundle rebuilt after merge (#230).
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { checkFragments, directEdits, foldFragments } from '../../../scripts/fragments.mjs';
import { extractSection } from '../../../scripts/release-notes.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CHANGELOG = '# Changelog\n\n## Unreleased\n\n## 0.4.0 (2026-11-24)\n\n- Old.\n';
const TRACE = '# T\n\n## 1. One\n\n| ID | R | I | T | S |\n|---|---|---|---|---|\n| S1.1 | a | b | c | done |\n\n## 2. Two\n\n| ID | R | I | T | S |\n|---|---|---|---|---|\n| S2.1 | a | b | c | done |\n';
const ROW = (id: string) => `| ${id} | req | \`x.ts\` | U/x.test.ts | done |`;

function repo(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'orbit-frag-'));
  dirs.push(root);
  const all = { 'CHANGELOG.md': CHANGELOG, 'docs/traceability.md': TRACE, ...files };
  for (const [name, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}
const file = (root: string, name: string) => readFileSync(join(root, name), 'utf8');

describe('changelog and traceability fragments', () => {
  it('scenario 1 and 2: a PR that writes fragments touches no shared file, and editing one is refused with the fragment to write instead', () => {
    const root = repo({
      'changes/changelog/a.md': 'section: Changes\n- A.\n',
      'changes/changelog/b.md': 'section: Fixes\n- B.\n',
      'changes/traceability/a.md': `section: 1\n${ROW('S1.2')}\n`,
    });
    expect(checkFragments(root)).toEqual([]);
    expect(directEdits(['changes/changelog/a.md', 'src/x.ts'], false)).toEqual([]);
    const edits = directEdits(['CHANGELOG.md', 'plugin/CHANGELOG.md', 'docs/traceability.md', 'plugin/docs/traceability.md'], false);
    expect(edits).toHaveLength(4);
    for (const e of edits) expect(e).toMatch(/changes\/(changelog|traceability)\/<name>\.md/);
    expect(directEdits(['CHANGELOG.md'], true)).toEqual([]);
  });

  it('edge: an unknown section, a missing section line, an empty entry and a malformed row fail with the file named', () => {
    const root = repo({
      'changes/changelog/odd.md': 'section: Misc\n- X.\n',
      'changes/changelog/none.md': '- no section line\n',
      'changes/changelog/empty.md': 'section: Changes\n',
      'changes/traceability/short.md': 'section: 1\n| S1.2 | only | three |\n',
      'changes/traceability/nosec.md': `section: 9\n${ROW('S9.1')}\n`,
      'changes/traceability/status.md': 'section: 1\n| S1.3 | a | b | c | finished |\n',
    });
    const problems = checkFragments(root).join('\n');
    for (const name of ['odd', 'none', 'empty']) expect(problems).toContain(`changes/changelog/${name}.md`);
    for (const name of ['short', 'nosec', 'status']) expect(problems).toContain(`changes/traceability/${name}.md`);
  });

  it('scenario 4: a release folds the fragments in a stable order, keeps release-notes working, and deletes them', () => {
    const fragments = {
      'changes/changelog/b-fix.md': 'section: Fixes\n- **Fix.** Fixed.\n',
      'changes/changelog/a-one.md': 'section: Changes\n- **One.** First.\n',
      'changes/changelog/c-two.md': 'section: Changes\n- **Two.** Second.\n',
      'changes/traceability/b.md': `section: 2\n${ROW('S2.2')}\n`,
      'changes/traceability/a.md': `section: 1\n${ROW('S1.2')}\n${ROW('S1.3')}\n`,
    };
    const a = repo(fragments);
    // Same fragments created in the opposite order give the same result.
    const b = repo(Object.fromEntries(Object.entries(fragments).reverse()));
    for (const root of [a, b]) expect(foldFragments(root, '0.5.0', '2026-12-01')).toEqual({ changelog: 3, traceability: 2 });
    expect(file(a, 'CHANGELOG.md')).toBe(file(b, 'CHANGELOG.md'));
    expect(file(a, 'docs/traceability.md')).toBe(file(b, 'docs/traceability.md'));

    const changelog = file(a, 'CHANGELOG.md');
    expect(changelog).toContain('## Unreleased\n\n## 0.5.0 (2026-12-01)');
    expect(extractSection(changelog, '0.5.0')).toBe('### Changes\n\n- **One.** First.\n- **Two.** Second.\n\n### Fixes\n\n- **Fix.** Fixed.');
    expect(extractSection(changelog, '0.4.0')).toBe('- Old.');

    const lines = file(a, 'docs/traceability.md').split('\n');
    const idx = (id: string) => lines.findIndex((l) => l.startsWith(`| ${id} `));
    expect(idx('S1.1')).toBeLessThan(idx('S1.2'));
    expect(idx('S1.3')).toBeLessThan(lines.indexOf('## 2. Two'));
    expect(idx('S2.1')).toBeLessThan(idx('S2.2'));

    expect(existsSync(join(a, 'changes/changelog/a-one.md'))).toBe(false);
    expect(existsSync(join(a, 'changes/traceability/a.md'))).toBe(false);
    expect(checkFragments(a)).toEqual([]);
  });

  it('scenario 4: a release with a malformed fragment folds nothing', () => {
    const root = repo({ 'changes/changelog/bad.md': 'section: Misc\n- X.\n' });
    expect(() => foldFragments(root, '0.5.0', '2026-12-01')).toThrow(/bad\.md/);
    expect(file(root, 'CHANGELOG.md')).toBe(CHANGELOG);
    expect(existsSync(join(root, 'changes/changelog/bad.md'))).toBe(true);
  });

  it('a release fails with a clear error when the named section has no table, instead of using the next section\'s', () => {
    const trace = `${TRACE}\n## 3. Three\n\nProse only.\n\n## 4. Four\n\n| ID | R | I | T | S |\n|---|---|---|---|---|\n| S4.1 | a | b | c | done |\n`;
    const root = repo({ 'docs/traceability.md': trace, 'changes/traceability/x.md': `section: 3\n${ROW('S3.1')}\n` });
    expect(() => foldFragments(root, '0.5.0', '2026-12-01')).toThrow(/x\.md.*section "3".*no table/);
    expect(file(root, 'docs/traceability.md')).toBe(trace);
    expect(existsSync(join(root, 'changes/traceability/x.md'))).toBe(true);
  });

  it('the repository itself has only well formed fragments', () => {
    expect(checkFragments(ROOT)).toEqual([]);
  });
});

describe('fragments check --base against a real repository', () => {
  const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  };
  // The script finds its repository from its own location, so the copy under test runs against the temporary repo.
  function prRepo(edit: Record<string, string>): string {
    const root = repo({ 'package.json': '{"version":"0.4.0"}\n', 'plugin/CHANGELOG.md': '# C\n' });
    mkdirSync(join(root, 'scripts'));
    copyFileSync(join(ROOT, 'scripts/fragments.mjs'), join(root, 'scripts/fragments.mjs'));
    git(root, 'init', '-q', '-b', 'next');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'base');
    git(root, 'checkout', '-q', '-b', 'pr');
    for (const [name, text] of Object.entries(edit)) {
      mkdirSync(dirname(join(root, name)), { recursive: true });
      writeFileSync(join(root, name), text);
    }
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'pr');
    return root;
  }
  const check = (root: string, base: string) => spawnSync('node', ['scripts/fragments.mjs', 'check', '--base', base], { cwd: root, encoding: 'utf8' });

  it('scenario 1 and 2: passes a branch that only adds fragments, and fails one that edits a shared file, naming the fragment to write', () => {
    const ok = check(prRepo({ 'changes/changelog/a.md': 'section: Changes\n- A.\n' }), 'next');
    expect(ok.stderr).toBe('');
    expect(ok.status).toBe(0);
    const bad = check(prRepo({ 'CHANGELOG.md': `${CHANGELOG}\n- edited\n` }), 'next');
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('CHANGELOG.md is assembled at release');
  });

  it('fails when the base ref was never fetched, as in a shallow pull request checkout', () => {
    const r = check(prRepo({ 'changes/changelog/a.md': 'section: Changes\n- A.\n' }), 'origin/next');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('origin/next');
  });
});

describe('bundle rebuilt after merge', () => {
  interface Step { name?: string; run?: string; if?: string }
  const ci = parse(readFileSync(`${ROOT}.github/workflows/ci.yml`, 'utf8')) as { on: { push: { branches: string[] } }; jobs: Record<string, { steps: Step[] }> };
  const rebuild = parse(readFileSync(`${ROOT}.github/workflows/rebuild-dist.yml`, 'utf8')) as { on: { push: { branches: string[] } }; permissions: Record<string, string>; jobs: Record<string, { steps: Step[] }> };
  const ciSteps = Object.values(ci.jobs).flatMap((j) => j.steps);

  it('scenario 3: CI checks the bundle on pushes to next, not on pull requests, and checks fragments on pull requests', () => {
    expect(ci.on.push.branches).toContain('next');
    const dist = ciSteps.find((s) => s.run === 'npm run check:dist');
    expect(dist?.if).toContain("github.event_name != 'pull_request'");
    const frag = ciSteps.find((s) => s.run?.includes('scripts/fragments.mjs check'));
    expect(frag?.if).toContain("github.event_name == 'pull_request'");
    expect(frag?.run).toContain('--base');
    // `cond && 0 || 1` is always 1 (0 is falsy), so the pull request checkout stayed shallow and origin/next was missing.
    const checkout = ci.jobs.verify!.steps.find((s) => (s as { uses?: string }).uses?.startsWith('actions/checkout'));
    expect((checkout as { with: Record<string, string> }).with['fetch-depth']).toBe("${{ github.event_name == 'pull_request' && '0' || '1' }}");
  });

  it('scenario 3: the rebuild runs once per merge into next, commits only when the bundle changed, and opens a pull request', () => {
    expect(rebuild.on.push.branches).toEqual(['next']);
    const runs = Object.values(rebuild.jobs).flatMap((j) => j.steps.map((s) => s.run ?? '')).join('\n');
    expect(runs).toContain('npm run build');
    expect(runs).toContain('git diff --quiet');
    expect(runs).toContain('gh pr create');
    expect(runs).not.toContain('--no-verify');
    expect(rebuild.permissions).toEqual({});
  });
});
