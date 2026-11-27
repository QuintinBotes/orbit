/**
 * Issue #280: the restore of out-of-scope paths is a git operation on the implementer's worktree alone, with content
 * from the base revision.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { neededPaths, restoreToBase } from '../../../src/controller/repair.ts';
import { recordFailure, setCandidateScope } from '../../../src/evidence/store.ts';
import { implementationScopeGate } from '../../../src/controller/gates.ts';
import { diagnosingStep } from '../../../src/controller/steps/diagnosing.ts';
import { briefPath } from '../../../src/controller/steps/implementing.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { addCandidate, cleanScope, gitIn, giveRepository, initLedger, makeUnitLab, setContract, validContract, type UnitLab } from './coverage-helpers.ts';
import type { PlannerOutput } from '../../../src/contract/model-outputs.ts';

let lab: UnitLab;
afterEach(() => lab?.cleanup());

const BASE_FILES = {
  'apps/calc.mjs': 'export const add = (a, b) => a + b;\n',
  'docs/guide.md': 'guide\n',
  'docs/old.md': 'old\n',
  'plugin/dist/tool.mjs': 'bundle\n',
  '.github/workflows/ci.yml': 'name: ci\n',
  'a[b].txt': 'bracket\n',
  'ab.txt': 'ab\n',
  'tree/inner.txt': 'inner\n',
};

const put = (root: string, rel: string, text: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const read = (root: string, rel: string): string => readFileSync(join(root, rel), 'utf8');

async function repository() {
  lab = makeUnitLab();
  const repo = await giveRepository(lab, BASE_FILES);
  return { ...repo, restore: (paths: string[], worktree = repo.worktree) => restoreToBase({ repoRoot: lab.repo, worktree, base: repo.base, paths }) };
}

describe('restoreToBase', () => {
  it('puts modified, added, deleted and protected-looking paths back to the base, and nothing else', async () => {
    const { worktree, base, restore } = await repository();
    put(worktree, 'docs/guide.md', 'rewritten\n');
    put(worktree, 'plugin/dist/tool.mjs', 'rebuilt\n');
    put(worktree, '.github/workflows/ci.yml', 'name: changed\n');
    put(worktree, 'new/deep/file.md', 'added\n');
    put(worktree, '.orbit/ignored.txt', 'ignored by .gitignore\n');
    rmSync(join(worktree, 'docs/old.md'));
    chmodSync(join(worktree, 'ab.txt'), 0o755);
    // Not named: an in-scope edit and a new file.
    put(worktree, 'apps/calc.mjs', 'export const mul = (a, b) => a * b;\n');
    put(worktree, 'apps/new.mjs', 'export {};\n');
    // The worktree's own index is the worker's: it stays as it was.
    gitIn(worktree, 'add', 'docs/guide.md');
    const index = gitIn(worktree, 'ls-files', '-s');
    const paths = ['docs/guide.md', 'plugin/dist/tool.mjs', '.github/workflows/ci.yml', 'new/deep/file.md', 'docs/old.md', 'ab.txt', '.orbit/ignored.txt', 'never/was.md'];

    for (let pass = 1; pass <= 2; pass++) {
      await restore(paths);
      expect(read(worktree, 'docs/guide.md'), `pass ${pass}`).toBe('guide\n');
      expect(read(worktree, 'plugin/dist/tool.mjs')).toBe('bundle\n');
      expect(read(worktree, '.github/workflows/ci.yml')).toBe('name: ci\n');
      expect(read(worktree, 'docs/old.md')).toBe('old\n');
      expect(statSync(join(worktree, 'ab.txt')).mode & 0o111).toBe(0);
      expect(existsSync(join(worktree, 'new/deep/file.md'))).toBe(false);
      expect(existsSync(join(worktree, '.orbit/ignored.txt'))).toBe(false);
      expect(read(worktree, 'apps/calc.mjs')).toBe('export const mul = (a, b) => a * b;\n');
      expect(read(worktree, 'apps/new.mjs')).toBe('export {};\n');
    }
    expect(gitIn(worktree, 'ls-files', '-s')).toBe(index);
    expect(gitIn(worktree, 'rev-parse', 'HEAD')).toBe(base);
    // The repository's own checkout was never written.
    expect(gitIn(lab.repo, 'status', '--porcelain')).toBe('');
  });

  it('takes content from the base revision, not from the checkout\'s HEAD or working files', async () => {
    const { worktree, base, restore } = await repository();
    // The checkout moves past base (a commit and a dirty file) and now holds a file the base lacks.
    put(lab.repo, 'docs/guide.md', 'newer commit\n');
    put(lab.repo, 'later.md', 'later\n');
    gitIn(lab.repo, 'add', '-A');
    gitIn(lab.repo, 'commit', '-q', '-m', 'later');
    put(lab.repo, 'docs/old.md', 'dirty in the checkout\n');
    expect(gitIn(lab.repo, 'rev-parse', 'HEAD')).not.toBe(base);
    put(worktree, 'docs/guide.md', 'rewritten\n');
    put(worktree, 'docs/old.md', 'rewritten\n');
    put(worktree, 'later.md', 'worker copy\n');
    await restore(['docs/guide.md', 'docs/old.md', 'later.md']);
    expect(read(worktree, 'docs/guide.md')).toBe('guide\n');
    expect(read(worktree, 'docs/old.md')).toBe('old\n');
    expect(existsSync(join(worktree, 'later.md'))).toBe(false);
    expect(read(lab.repo, 'docs/old.md')).toBe('dirty in the checkout\n');
    expect(read(lab.repo, 'docs/guide.md')).toBe('newer commit\n');
  });

  it('takes a path literally, never as a pattern', async () => {
    const { worktree, restore } = await repository();
    put(worktree, 'a[b].txt', 'changed\n');
    put(worktree, 'ab.txt', 'kept edit\n');
    await restore(['a[b].txt']);
    expect(read(worktree, 'a[b].txt')).toBe('bracket\n');
    expect(read(worktree, 'ab.txt')).toBe('kept edit\n');
  });

  it('brings back a directory the change replaced with a file, and does not write through a symlink', async () => {
    const { worktree, restore } = await repository();
    rmSync(join(worktree, 'tree'), { recursive: true });
    put(worktree, 'tree', 'now a file\n');
    // A symlink out of the worktree where the base has a directory: the repository's checkout must not be written.
    put(lab.repo, 'outside/guide.md', 'untouched\n');
    rmSync(join(worktree, 'docs'), { recursive: true });
    symlinkSync(join(lab.repo, 'outside'), join(worktree, 'docs'));
    await restore(['tree', 'tree/inner.txt', 'docs', 'docs/guide.md', 'docs/old.md']);
    expect(read(worktree, 'tree/inner.txt')).toBe('inner\n');
    expect(read(worktree, 'docs/guide.md')).toBe('guide\n');
    expect(read(lab.repo, 'outside/guide.md')).toBe('untouched\n');
  });

  it('with no paths does nothing, and refuses the repository\'s own checkout', async () => {
    const { worktree, restore } = await repository();
    put(worktree, 'new.md', 'added\n');
    await restore([]);
    expect(read(worktree, 'new.md')).toBe('added\n');
    put(lab.repo, 'docs/guide.md', 'a person\'s edit\n');
    await expect(restore(['docs/guide.md'], lab.repo)).rejects.toMatchObject({ code: 'GIT_FAILED' });
    expect(read(lab.repo, 'docs/guide.md')).toBe('a person\'s edit\n');
  });
});

describe('a protected-path denial', () => {
  it('is a policy violation that diagnosing leaves alone: no restore, no repair brief', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'VERIFYING', 'DIAGNOSING'] });
    const repo = await giveRepository(lab, BASE_FILES);
    setContract(lab, { baseline_revision: repo.base });
    initLedger(lab);
    const cand = addCandidate(lab);
    lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 1, 'implementation.attempt', 'x', ?)", lab.runId, JSON.stringify({ attempt: 1 }));
    lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 1, 'implementation.candidate', 'x', ?)", lab.runId, JSON.stringify({ attempt: 1, candidate_id: cand.id }));
    const scope = cleanScope({ allowed_paths_pass: false, forbidden_paths_changed: ['.github/workflows/ci.yml'], out_of_scope_paths_changed: ['docs/guide.md', '.github/workflows/ci.yml'] });
    setCandidateScope(lab.db, cand.id, scope);
    recordFailure(lab.db, { runId: lab.runId, candidateId: cand.id, source: 'worker', sourceId: `scope:${cand.id}`, fingerprint: 'scope:abc', excerpt: 'protected paths changed: .github/workflows/ci.yml' }, lab.clock);
    put(repo.worktree, 'docs/guide.md', 'rewritten\n');
    put(repo.worktree, '.github/workflows/ci.yml', 'name: changed\n');

    const gate = implementationScopeGate(scope, lab.ctx().snapshot);
    expect(gate.passed).toBe(false);
    expect(gate.details.policyViolation).toBe(true);
    expect(gate.reasons.join(' ')).toContain('protected paths changed: .github/workflows/ci.yml');

    await diagnosingStep(lab.ctx());
    expect(read(repo.worktree, 'docs/guide.md')).toBe('rewritten\n');
    expect(read(repo.worktree, '.github/workflows/ci.yml')).toBe('name: changed\n');
    expect(listDecisions(lab.db, lab.runId, { kind: 'repair.scope-restore' })).toEqual([]);
    if (existsSync(briefPath(lab.ctx(), 2))) expect(readFileSync(briefPath(lab.ctx(), 2), 'utf8')).not.toContain('Orbit has already restored');
  });
});

describe('neededPaths', () => {
  const plan = (...changes: string[][]) => ({ criteria: changes.map((paths) => ({ changes: paths.map((path) => ({ path, summary: 's' })) })) }) as unknown as PlannerOutput;

  it('names a denied path a criterion maps a test or a planned change to, but not a kept test the base has', () => {
    lab = makeUnitLab();
    const contract = validContract(lab, {
      acceptance_criteria: [
        { id: 'AC-1', statement: 's', proof: ['p'], mandatory: true, tests: ['./spec/new.test.mjs'] },
        { id: 'AC-2', statement: 's', proof: ['p'], mandatory: true, kind: 'keep', tests: ['spec/old.test.mjs', 'spec/absent.test.mjs'] },
      ],
    });
    const denied = ['spec/new.test.mjs', 'spec/old.test.mjs', 'spec/absent.test.mjs', 'docs/guide.md', 'other.md'];
    expect(neededPaths(denied, contract, plan([], ['./docs/guide.md']), new Set(['spec/old.test.mjs']))).toEqual([
      { path: 'spec/new.test.mjs', criteria: ['AC-1'] },
      { path: 'spec/absent.test.mjs', criteria: ['AC-2'] },
      { path: 'docs/guide.md', criteria: ['AC-2'] },
    ]);
    expect(neededPaths(['docs/guide.md'], contract, null, new Set())).toEqual([]);
  });
});
