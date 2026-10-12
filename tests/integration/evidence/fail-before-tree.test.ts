// The fail-before probe tree (ADR 0014 section 2), on a real repository: the base tree with every test-owned path set to
// its candidate state, deletions applied, production code and manifests left as the base has them. It is written in a
// private index and committed deterministically, and a path git would take only by replacing a base entry (a file where
// the base keeps a directory or a file above it, a gitlink) refuses the whole probe rather than build part of it.
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildProbeTree, changesBetween, commitProbeTree, type ProbeChange } from '../../../src/evidence/fail-before.ts';
import { isTestOwnedPath } from '../../../src/policy/test-files.ts';
import { makeRepo, sh, tempRoot, write } from '../../unit/evidence/fixtures.ts';

const roots: { remove: () => void }[] = [];
afterEach(() => roots.splice(0).forEach((r) => r.remove()));

const BASE = {
  'package.json': '{"name":"acme","scripts":{"test":"node tests/run.mjs"}}\n',
  'apps/calc.mjs': 'export const add = (a, b) => a + b;\n',
  'apps/helpers': 'a production file\n',
  'tests/run.mjs': 'console.log("ran");\n',
  'tests/add.test.mjs': 'add test v1\n',
  'tests/old.test.mjs': 'old test\n',
};

/** A repository whose second commit is the candidate: `edit` changes the work tree before it is committed. */
function candidateRepo(edit: (repo: string) => void): { repo: string; base: string; commit: string } {
  const t = tempRoot('orbit-fail-before-');
  roots.push(t);
  const r = makeRepo(t.root, BASE);
  edit(r.repo);
  sh(r.repo, 'add', '-A');
  sh(r.repo, 'commit', '-qm', 'candidate');
  return { repo: r.repo, base: r.base, commit: sh(r.repo, 'rev-parse', 'HEAD').trim() };
}

const show = (repo: string, rev: string, path: string): string | null => {
  try {
    return sh(repo, 'show', `${rev}:${path}`);
  } catch {
    return null;
  }
};

const testOwned = (changes: readonly ProbeChange[]): ProbeChange[] => changes.filter((c) => isTestOwnedPath(c.path));

describe('the probe tree', () => {
  it('takes the candidate\'s test-owned paths only, with deletions applied, and keeps production code and manifests the base\'s', async () => {
    const c = candidateRepo((repo) => {
      write(join(repo, 'apps/calc.mjs'), 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n');
      write(join(repo, 'package.json'), '{"name":"acme","scripts":{"test":"node tests/run.mjs"},"devDependencies":{"left-pad":"1.0.0"}}\n');
      write(join(repo, 'tests/mul.test.mjs'), 'mul test\n');
      write(join(repo, 'tests/add.test.mjs'), 'add test v2\n');
      write(join(repo, 'tests/fixtures/rows.json'), '[1,2]\n');
      sh(repo, 'rm', '-q', 'tests/old.test.mjs');
    });
    const changes = await changesBetween(c.repo, c.base, c.commit);
    expect(changes.map((x) => `${x.status} ${x.path}`).sort()).toEqual(['A tests/fixtures/rows.json', 'A tests/mul.test.mjs', 'D tests/old.test.mjs', 'M apps/calc.mjs', 'M package.json', 'M tests/add.test.mjs']);
    const built = await buildProbeTree(c.repo, c.base, testOwned(changes));
    expect('tree' in built, JSON.stringify(built)).toBe(true);
    const tree = (built as { tree: string }).tree;
    const commit = await commitProbeTree(c.repo, { base: c.base, tree, ref: 'refs/orbit/orb-1/fail-before/2', message: 'orbit fail-before probe orb-1/2' });
    expect(show(c.repo, commit, 'apps/calc.mjs')).toBe(BASE['apps/calc.mjs']);
    expect(show(c.repo, commit, 'package.json')).toBe(BASE['package.json']);
    expect(show(c.repo, commit, 'tests/mul.test.mjs')).toBe('mul test\n');
    expect(show(c.repo, commit, 'tests/add.test.mjs')).toBe('add test v2\n');
    expect(show(c.repo, commit, 'tests/fixtures/rows.json')).toBe('[1,2]\n');
    expect(show(c.repo, commit, 'tests/old.test.mjs')).toBeNull();
    expect(show(c.repo, commit, 'tests/run.mjs')).toBe(BASE['tests/run.mjs']);
    expect(sh(c.repo, 'rev-parse', 'refs/orbit/orb-1/fail-before/2').trim()).toBe(commit);
    expect(sh(c.repo, 'rev-parse', `${commit}^`).trim()).toBe(c.base);
    expect(sh(c.repo, 'log', '-1', '--format=%an <%ae>', commit).trim()).toBe('Orbit <orbit@orbit.invalid>');
  });

  it('is deterministic: the same base and paths give the same tree and the same commit', async () => {
    const c = candidateRepo((repo) => write(join(repo, 'tests/mul.test.mjs'), 'mul test\n'));
    const changes = testOwned(await changesBetween(c.repo, c.base, c.commit));
    const one = (await buildProbeTree(c.repo, c.base, changes)) as { tree: string };
    const two = (await buildProbeTree(c.repo, c.base, [...changes].reverse())) as { tree: string };
    expect(one.tree).toBe(two.tree);
    const a = await commitProbeTree(c.repo, { base: c.base, tree: one.tree, ref: 'refs/orbit/orb-1/fail-before/1', message: 'm' });
    const b = await commitProbeTree(c.repo, { base: c.base, tree: two.tree, ref: 'refs/orbit/orb-1/fail-before/1', message: 'm' });
    expect(a).toBe(b);
    // The tree differs from the base by the new test only.
    expect(sh(c.repo, 'diff', '--name-only', c.base, a).trim()).toBe('tests/mul.test.mjs');
  });

  it('refuses a test file where the base keeps a production file above it, rather than drop that file', async () => {
    const c = candidateRepo((repo) => {
      sh(repo, 'rm', '-q', 'apps/helpers');
      write(join(repo, 'apps/helpers/math.test.mjs'), 'helper test\n');
    });
    const changes = await changesBetween(c.repo, c.base, c.commit);
    const owned = testOwned(changes);
    expect(owned.map((x) => x.path)).toEqual(['apps/helpers/math.test.mjs']);
    const built = await buildProbeTree(c.repo, c.base, owned);
    expect(built).toEqual({ refused: expect.stringMatching(/apps\/helpers\/math\.test\.mjs.*apps\/helpers is a file on the base revision/) });
  });

  it('refuses a test file where the base keeps a directory it would replace', async () => {
    const c = candidateRepo((repo) => {
      write(join(repo, 'apps/widgets/index.mjs'), 'export {};\n');
    });
    // On a base that has the directory apps/widgets/, a test-owned file named apps/widgets would replace it.
    const change: ProbeChange = { path: 'apps/widgets', status: 'A', srcMode: '000000', dstMode: '100644', srcSha: '0'.repeat(40), dstSha: sh(c.repo, 'rev-parse', `${c.commit}:apps/calc.mjs`).trim() };
    const built = await buildProbeTree(c.repo, c.commit, [change]);
    expect(built).toEqual({ refused: expect.stringMatching(/apps\/widgets is a directory on the base revision/) });
  });

  it('refuses a gitlink', async () => {
    const c = candidateRepo((repo) => write(join(repo, 'tests/mul.test.mjs'), 'mul test\n'));
    const change: ProbeChange = { path: 'tests/vendor/lib', status: 'A', srcMode: '000000', dstMode: '160000', srcSha: '0'.repeat(40), dstSha: c.commit };
    expect(await buildProbeTree(c.repo, c.base, [change])).toEqual({ refused: expect.stringMatching(/tests\/vendor\/lib is a gitlink/) });
  });
});
