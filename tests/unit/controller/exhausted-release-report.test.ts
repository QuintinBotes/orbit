/**
 * An EXHAUSTED run releases its worktree, and the release saves an unsaved implementer edit as a candidate. The final
 * report is written after that, so its next action and candidate_ref name the ref the work is in.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runWorktreeRoot } from '../../../src/controller/context.ts';
import { finishRun } from '../../../src/controller/steps/common.ts';
import { materializeCandidate } from '../../../src/evidence/candidate.ts';
import { makeUnitLab, type UnitLab } from './coverage-helpers.ts';

let lab: UnitLab | undefined;
afterEach(() => {
  lab?.cleanup();
  lab = undefined;
});

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

it('an EXHAUSTED run whose only work is an unsaved edit names the candidate ref the release saved it in', async () => {
  lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
  mkdirSync(join(lab.repo, 'apps'), { recursive: true });
  writeFileSync(join(lab.repo, 'apps', 'calc.mjs'), 'export const add = (a, b) => a + b;\n');
  writeFileSync(join(lab.repo, '.gitignore'), '.orbit/\n');
  git(lab.repo, 'init', '-q', '-b', 'main');
  git(lab.repo, 'add', '-A');
  git(lab.repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'base');
  const base = git(lab.repo, 'rev-parse', 'HEAD');
  const tree = git(lab.repo, 'rev-parse', 'HEAD^{tree}');
  const worktree = join(runWorktreeRoot(lab.ctx()), 'implementer');
  await materializeCandidate(lab.repo, base, worktree, { readOnly: false });
  lab.db.run('UPDATE runs SET base_revision = ?, base_tree = ?, worktree_path = ? WHERE id = ?', base, tree, worktree, lab.runId);
  // The implementer edited a file, then the provider kept failing: no candidate was snapshotted before the run ended.
  writeFileSync(join(worktree, 'apps', 'calc.mjs'), 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n');
  await finishRun(lab.ctx(), 'EXHAUSTED', 'implementer: the provider kept failing transiently and the infrastructure retries are spent (last: 529)');

  const ref = `refs/orbit/${lab.runId}/candidates/1`;
  expect(git(lab.repo, 'for-each-ref', '--format=%(refname)', ref)).toBe(ref);
  const final = JSON.parse(readFileSync(join(lab.ctx().runDir, 'final.json'), 'utf8')) as { next_action: string; revision: { candidate_ref: string | null } };
  expect(final.next_action).not.toMatch(/no candidate was recorded/);
  expect(final.next_action).toContain(ref);
  expect(final.revision.candidate_ref).toBe(ref);
  expect(readFileSync(join(lab.ctx().runDir, 'final.md'), 'utf8')).toContain(ref);
});
