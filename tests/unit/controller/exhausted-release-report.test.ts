/**
 * An implementer edit that never became a candidate is never lost when a run ends. A CANCELLED run releases its
 * worktree, and the release saves the edit as a candidate first, so the final report names the ref the work is in. An
 * EXHAUSTED run keeps its worktree (as 0.3.0 did), so the edit stays there and the report says the worktree is preserved.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/** A lab whose run has an implementer worktree with an edit no candidate holds yet. */
async function withUnsavedEdit(): Promise<{ worktree: string }> {
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
  writeFileSync(join(worktree, 'apps', 'calc.mjs'), 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n');
  return { worktree };
}

it('a CANCELLED run whose only work is an unsaved edit names the candidate ref the release saved it in', async () => {
  await withUnsavedEdit();
  await finishRun(lab!.ctx(), 'CANCELLED', 'cancelled by request');

  const ref = `refs/orbit/${lab!.runId}/candidates/1`;
  expect(git(lab!.repo, 'for-each-ref', '--format=%(refname)', ref)).toBe(ref);
  expect(git(lab!.repo, 'show', `${ref}:apps/calc.mjs`)).toContain('mul');
  const final = JSON.parse(readFileSync(join(lab!.ctx().runDir, 'final.json'), 'utf8')) as { revision: { candidate_ref: string | null } };
  expect(final.revision.candidate_ref).toBe(ref);
});

it('an EXHAUSTED run keeps the worktree with its unsaved edit and says it is preserved', async () => {
  const { worktree } = await withUnsavedEdit();
  await finishRun(lab!.ctx(), 'EXHAUSTED', 'implementer: the provider kept failing transiently and the infrastructure retries are spent (last: 529)');

  expect(readFileSync(join(worktree, 'apps', 'calc.mjs'), 'utf8')).toContain('mul');
  expect(existsSync(worktree)).toBe(true);
  const final = JSON.parse(readFileSync(join(lab!.ctx().runDir, 'final.json'), 'utf8')) as { next_action: string };
  expect(final.next_action).toMatch(/worktree and evidence are preserved, and orbit gc removes them after retention/);
});
