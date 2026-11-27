/**
 * Issue #280: DIAGNOSING after a scope denial, over a real worktree. A denied path a criterion needs blocks the run and
 * stays as it is; one nothing needs is restored before the brief; a policy violation restores nothing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJson } from '../../../src/core/fsx.ts';
import { recordFailure, setCandidateScope } from '../../../src/evidence/store.ts';
import { getRun } from '../../../src/controller/run-store.ts';
import { diagnosingStep } from '../../../src/controller/steps/diagnosing.ts';
import { briefPath } from '../../../src/controller/steps/implementing.ts';
import { PLANNER_FILE } from '../../../src/controller/steps/contracting.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { planner } from '../../acceptance/helpers/scenarios.ts';
import { addCandidate, cleanScope, giveRepository, initLedger, makeUnitLab, setContract, type UnitLab } from './coverage-helpers.ts';
import type { AcceptanceCriterion } from '../../../src/contract/types.ts';
import type { ScopeReport } from '../../../src/evidence/types.ts';

let lab: UnitLab;
afterEach(() => lab?.cleanup());

const CRITERION: AcceptanceCriterion = { id: 'AC-1', statement: 'mul(a, b) returns the product', proof: ['a test'], mandatory: true, check_ids: ['unit'] };

async function denied(o: { criterion?: Partial<AcceptanceCriterion>; planned?: string; scope?: Partial<ScopeReport> } = {}) {
  lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'VERIFYING', 'DIAGNOSING'] });
  const repo = await giveRepository(lab, { 'apps/calc.mjs': 'export {};\n', 'docs/guide.md': 'guide\n' });
  setContract(lab, { baseline_revision: repo.base, acceptance_criteria: [{ ...CRITERION, ...o.criterion }] });
  initLedger(lab);
  if (o.planned) {
    const out = (planner({ criteria: [{ key: 'mul', statement: CRITERION.statement, changes: [[o.planned, 'describe mul']] }] }) as { structured: unknown }).structured;
    mkdirSync(lab.ctx().runDir, { recursive: true });
    atomicWriteJson(join(lab.ctx().runDir, PLANNER_FILE), { worker_id: 'w', output: out });
  }
  const cand = addCandidate(lab);
  lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 1, 'implementation.attempt', 'x', ?)", lab.runId, JSON.stringify({ attempt: 1 }));
  lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 1, 'implementation.candidate', 'x', ?)", lab.runId, JSON.stringify({ attempt: 1, candidate_id: cand.id }));
  setCandidateScope(lab.db, cand.id, cleanScope({ allowed_paths_pass: false, out_of_scope_paths_changed: ['docs/guide.md', 'docs/new.md'], ...o.scope }));
  recordFailure(lab.db, { runId: lab.runId, candidateId: cand.id, source: 'worker', sourceId: `scope:${cand.id}`, fingerprint: 'scope:abc', excerpt: 'paths outside the authorized scope changed: docs/guide.md, docs/new.md' }, lab.clock);
  writeFileSync(join(repo.worktree, 'docs/guide.md'), 'rewritten\n');
  writeFileSync(join(repo.worktree, 'docs/new.md'), 'added\n');
  await diagnosingStep(lab.ctx());
  return { ...repo, run: getRun(lab.db, lab.runId), guide: () => readFileSync(join(repo.worktree, 'docs/guide.md'), 'utf8'), added: () => existsSync(join(repo.worktree, 'docs/new.md')) };
}

describe('a denied out-of-scope path a criterion needs', () => {
  it.each([
    ['a mapped test', { criterion: { tests: ['docs/new.md'] } }, 'docs/new.md (needed by AC-1)'],
    ['a planned change', { planned: 'docs/guide.md' }, 'docs/guide.md (needed by AC-1)'],
  ])('as %s blocks the run naming it, restores nothing and writes no brief', async (_what, options, named) => {
    const r = await denied(options);
    expect(r.run.state).toBe('BLOCKED');
    expect(r.run.outcomeReason).toContain(named);
    expect(r.run.outcomeReason).toContain(`orbit cancel ${lab.runId}`);
    expect(JSON.parse(r.run.outcomeJson!)).toMatchObject({ scope: { out_of_scope_paths: ['docs/guide.md', 'docs/new.md'] } });
    expect(r.guide()).toBe('rewritten\n');
    expect(r.added()).toBe(true);
    expect(existsSync(briefPath(lab.ctx(), 2))).toBe(false);
    expect(lab.ctx().ledger!.state('implementation_attempts').used).toBe(0);
  });
});

describe('a denied out-of-scope path nothing needs', () => {
  it('is restored before the repair, and the brief names it', async () => {
    const r = await denied();
    expect(r.run.state).toBe('REPAIRING');
    expect(r.guide()).toBe('guide\n');
    expect(r.added()).toBe(false);
    const { brief } = JSON.parse(readFileSync(briefPath(lab.ctx(), 2), 'utf8')) as { brief: { evidence: string[]; scoped_fix: string } };
    expect(brief.evidence).toContain('restored to the base revision by Orbit (a file the base does not have is removed): docs/guide.md, docs/new.md');
    expect(brief.scoped_fix).toContain('Orbit has already restored docs/guide.md, docs/new.md to the base revision');
    expect(listDecisions(lab.db, lab.runId, { kind: 'repair.scope-restore' }).map((d) => (d.data as { paths: string[] }).paths)).toEqual([['docs/guide.md', 'docs/new.md']]);
  });

  it('is left alone when the denial is a policy violation', async () => {
    const r = await denied({ scope: { forbidden_paths_changed: ['.github/ci.yml'] } });
    expect(r.guide()).toBe('rewritten\n');
    expect(r.added()).toBe(true);
    expect(listDecisions(lab.db, lab.runId, { kind: 'repair.scope-restore' })).toEqual([]);
  });
});
