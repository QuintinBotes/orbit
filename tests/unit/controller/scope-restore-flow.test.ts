/**
 * Issue #280: scope inspection, DIAGNOSING and the next snapshot over a real worktree. A scope denial runs no check and
 * no worker, so the whole loop from a denied candidate to the next one runs here.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { snapshotCandidate } from '../../../src/evidence/candidate.ts';
import { getRun, transition } from '../../../src/controller/run-store.ts';
import { diagnosingStep } from '../../../src/controller/steps/diagnosing.ts';
import { verifyingStep } from '../../../src/controller/steps/verifying.ts';
import type { RunState } from '../../../src/controller/states.ts';
import { gitIn, giveRepository, initLedger, makeUnitLab, OWNER, setContract, type UnitLab } from './coverage-helpers.ts';

let lab: UnitLab;
afterEach(() => lab?.cleanup());

const walk = (...path: RunState[]) => path.forEach((to) => transition(lab.db, { runId: lab.runId, to, ownerId: OWNER, reason: 'test' }, lab.clock));

async function setup() {
  lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
  const repo = await giveRepository(lab, { 'apps/calc.mjs': 'export const add = (a, b) => a + b;\n', 'docs/guide.md': 'guide\n' });
  setContract(lab, { baseline_revision: repo.base });
  initLedger(lab);
  const write = (rel: string, text: string): void => {
    mkdirSync(join(repo.worktree, rel, '..'), { recursive: true });
    writeFileSync(join(repo.worktree, rel), text);
  };
  /** What attempt n leaves: its snapshot and its events, then VERIFYING and DIAGNOSING. */
  const attempt = async (n: number) => {
    lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, ?, 'implementation.attempt', 'x', ?)", lab.runId, lab.clock.now(), JSON.stringify({ attempt: n }));
    const cand = await snapshotCandidate({ db: lab.db, clock: lab.clock, repoRoot: lab.repo, worktree: repo.worktree, runId: lab.runId, baseRev: repo.base, attempt: n, workerId: null });
    lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, ?, 'implementation.candidate', 'x', ?)", lab.runId, lab.clock.now(), JSON.stringify({ attempt: n, candidate_id: cand.id }));
    walk('VERIFYING');
    await verifyingStep(lab.ctx());
    expect(getRun(lab.db, lab.runId).state).toBe('DIAGNOSING');
    await diagnosingStep(lab.ctx());
    return { cand, run: getRun(lab.db, lab.runId), changed: gitIn(lab.repo, 'diff', '--name-only', repo.base, cand.commitSha).split('\n') };
  };
  return { ...repo, write, attempt };
}

describe('the loop after a scope denial', () => {
  it('a repair that changes nothing is snapshotted without the out-of-scope paths', async () => {
    const r = await setup();
    r.write('apps/calc.mjs', 'export const mul = (a, b) => a * b;\n');
    r.write('build/out.txt', 'generated\n');
    r.write('docs/guide.md', 'rewritten\n');
    const first = await r.attempt(1);
    expect(first.changed).toEqual(['apps/calc.mjs', 'build/out.txt', 'docs/guide.md']);
    expect(first.run.state).toBe('REPAIRING');
    const next = await snapshotCandidate({ db: lab.db, clock: lab.clock, repoRoot: lab.repo, worktree: r.worktree, runId: lab.runId, baseRev: r.base, attempt: 2, workerId: null });
    expect(gitIn(lab.repo, 'diff', '--name-only', r.base, next.commitSha).split('\n')).toEqual(['apps/calc.mjs']);
  });

  it('a repair that writes the path again blocks on the same tree, naming it', async () => {
    const r = await setup();
    r.write('apps/calc.mjs', 'export const mul = (a, b) => a * b;\n');
    r.write('build/out.txt', 'generated\n');
    const first = await r.attempt(1);
    r.write('build/out.txt', 'generated\n');
    const second = await r.attempt(2);
    expect(second.cand.treeHash).toBe(first.cand.treeHash);
    expect(second.run.state).toBe('BLOCKED');
    expect(second.run.outcomeReason).toContain('changes paths outside the authorized scope again: build/out.txt.');
    expect(second.run.outcomeReason).toContain('Attempt 2 ended on tree');
    expect(JSON.parse(second.run.outcomeJson!)).toMatchObject({ scope: { out_of_scope_paths: ['build/out.txt'] } });
  });
});
