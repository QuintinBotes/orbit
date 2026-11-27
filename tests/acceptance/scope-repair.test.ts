/**
 * Issue #280: a candidate denied only for paths outside the authorized scope. Orbit restores them in the implementer's
 * worktree before the next attempt, so a repair that does not revert them still reaches verification.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listCandidates } from '../../src/evidence/store.ts';
import { listDecisions } from '../../src/storage/decisions.ts';
import { listWorkers } from '../../src/storage/workers.ts';
import { drive, git, makeLab, startLabRun, writeScenario, type Lab } from './helpers/lab.ts';
import { GOAL, implementer, scenario, SRC_TEXT, TEST_TEXT } from './helpers/scenarios.ts';
import { assertRunInvariants } from './helpers/invariants.ts';

const labs: Lab[] = [];
afterEach(() => labs.splice(0).forEach((l) => l.close()));

describe('acceptance: out-of-scope paths are restored before the repair (issue #280)', () => {
  it('the repair changes nothing, and the in-scope change is verified and succeeds', async () => {
    const l = makeLab({ files: { 'docs/guide.md': 'guide\n' } });
    labs.push(l);
    const added = { op: 'write' as const, path: 'build/output.txt', content: 'generated\n' };
    const edited = { op: 'write' as const, path: 'docs/guide.md', content: 'rewritten\n' };
    writeScenario(l, scenario({ implementer: [implementer([SRC_TEXT, TEST_TEXT, added, edited]), implementer(
      // The fake applies this inside the worktree when attempt 2 starts: the replace throws (and the run does not
      // succeed) unless docs/guide.md already holds its base text then, not only once candidate 2 is committed.
      // Likewise the write below throws (mkdir under an existing file) unless build/output.txt is already gone when
      // attempt 2 starts; the delete then leaves the worktree as it was (the base has no build/).
      [{ op: 'replace', path: 'docs/guide.md', find: 'guide\n', replace: 'guide\n' },
        { op: 'write', path: 'build/output.txt/probe.txt', content: 'x\n' }, { op: 'delete', path: 'build' }], { changed: [] })] }));
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);
    const db = l.db();

    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(listDecisions(db, run.id).find((d) => d.kind === 'policy.deny')?.summary).toContain('paths outside the authorized scope changed: build/output.txt, docs/guide.md');
    const { source, brief } = JSON.parse(readFileSync(join(l.runDir(run.id), 'briefs', 'attempt-2.json'), 'utf8')) as { source: string; brief: { scoped_fix: string } };
    expect(source).toBe('scope');
    expect(brief.scoped_fix).toContain('Orbit has already restored build/output.txt, docs/guide.md to the base revision');
    const [first, second] = listCandidates(db, run.id);
    const changed = (commit: string): string[] => git(l.repo, 'diff', '--name-only', done.baseRevision!, commit).split('\n');
    expect(changed(first!.commitSha)).toEqual(['build/output.txt', 'docs/guide.md', 'src/server.ts', 'tests/unit/server.test.ts']);
    expect(changed(second!.commitSha)).toEqual(['src/server.ts', 'tests/unit/server.test.ts']);
    expect(listWorkers(db, { runId: run.id, role: 'implementer' })).toHaveLength(2);
    expect(readFileSync(join(l.repo, 'docs/guide.md'), 'utf8')).toBe('guide\n');
    assertRunInvariants(l, run.id);
  }, 240_000);
});
