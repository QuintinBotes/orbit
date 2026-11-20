import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { liveBudget, localExecutor, OWNER_REPOSITORIES, parseLiveCatalog, plannedSessions, RUNS_PER_GOAL, runLiveTier, type LiveExecutor, type LiveGoal, type LiveTrial } from '../../../src/bench/live.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'bench', 'live-goals-20.json');
/** The fixture catalog of twenty goals over the owner's repositories, cut to its first `n` (the shipped catalog has three seeds). */
const fixtureCatalog = (n = 20): { schema_version: number; goals: Record<string, unknown>[] } => {
  const c = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { schema_version: number; goals: Record<string, unknown>[] };
  return { ...c, goals: c.goals.slice(0, n) };
};

const trial = (over: Partial<LiveTrial> = {}): LiveTrial => ({ end_state: 'SUCCEEDED', failure_class: null, attempts: 1, spend_usd: 0.5, wall_ms: 1000, delivered: true, accepted: true, problems: [], ...over });

/** An executor that calls no model: it records what it was asked and answers from a table. */
function fakeExecutor(answer: (kind: 'orbit' | 'plain', g: LiveGoal, n: number) => LiveTrial, invalid: Record<string, string[]> = {}): LiveExecutor & { calls: { kind: string; id: string; cap: number }[] } {
  const calls: { kind: string; id: string; cap: number }[] = [];
  const count = (kind: string, id: string): number => calls.filter((c) => c.kind === kind && c.id === id).length;
  return {
    calls,
    validate: async (g) => {
      calls.push({ kind: 'validate', id: g.id, cap: 0 });
      return invalid[g.id] ?? [];
    },
    orbit: async (g, cap) => {
      calls.push({ kind: 'orbit', id: g.id, cap });
      return answer('orbit', g, count('orbit', g.id));
    },
    plain: async (g, cap) => {
      calls.push({ kind: 'plain', id: g.id, cap });
      return answer('plain', g, count('plain', g.id));
    },
  };
}

describe('live catalog (#172 FR-003)', () => {
  it('the shipped catalog validates: three seed goals, each pinned to a commit of one of the owner repositories with a held-out check from the accepted fix', () => {
    const goals = parseLiveCatalog(readFileSync(join(ROOT, 'data', 'bench', 'live-goals.json'), 'utf8'));
    expect(goals).toHaveLength(3);
    for (const g of goals) {
      expect(OWNER_REPOSITORIES).toContain(g.repository);
      expect(g.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(g.reference).toMatch(/^[0-9a-f]{40}$/);
      expect(g.issue.startsWith(`https://github.com/${g.repository}/issues/`)).toBe(true);
      // The worker is given the goal only: the held-out files are never named in it.
      for (const p of g.acceptance.paths) expect(g.goal).not.toContain(p);
    }
  });

  it('a fixture catalog of twenty goals validates', () => {
    expect(parseLiveCatalog(JSON.stringify(fixtureCatalog(20))).map((g) => g.id)).toHaveLength(20);
  });

  it('reports every problem at once: third-party repository, unpinned commit, held-out path outside the repository, duplicate id', () => {
    const c = fixtureCatalog(4);
    c.goals[0]!.repository = 'someone-else/project';
    c.goals[0]!.issue = 'https://github.com/someone-else/project/issues/1';
    c.goals[1]!.commit = 'main';
    c.goals[2]!.acceptance = { paths: ['../outside.test.ts'], command: ['npm', 'test'] };
    c.goals[3]!.id = 'goal-1';
    let message = '';
    try {
      parseLiveCatalog(JSON.stringify(c));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/4 problem\(s\)/);
    expect(message).toMatch(/goal 1 \(goal-1\): repository must be one of QuintinBotes\/orbit/);
    expect(message).toMatch(/goal 2 \(goal-2\): commit must be a full 40-character commit id/);
    expect(message).toMatch(/goal 3 \(goal-3\): acceptance.paths must list the held-out files/);
    expect(message).toMatch(/goal 4 \(goal-1\): id is used by an earlier goal/);
    expect(() => parseLiveCatalog('{"schema_version": 2, "goals": []}')).toThrow(/schema_version 1/);
  });
});

describe('live tier (#172 User Story 2)', () => {
  it('edge case: refuses to start without an explicit budget; there is no default', () => {
    expect(() => liveBudget(undefined)).toThrow(/needs an explicit budget: --budget <usd>/);
    for (const bad of ['0', '-5', 'ten', '', '1e3']) expect(() => liveBudget(bad)).toThrow(/positive amount/);
    expect(liveBudget('12.5')).toBe(12.5);
  });

  it('US2.1, edge case: twenty goals run three times each, every result is kept, and each session is capped at its share of the budget', async () => {
    const goals = parseLiveCatalog(JSON.stringify(fixtureCatalog(20)));
    const ex = fakeExecutor((_k, g, n) => trial({ accepted: !(g.id === 'goal-1' && n === 2), spend_usd: 0.25 }));
    const out = await runLiveTier({ goals, budgetUsd: 30, baseline: false, executor: ex });
    expect(out.baseline).toBeNull();
    expect(out.rows).toHaveLength(20 * RUNS_PER_GOAL);
    expect(out.rows.slice(0, 3).map((r) => [r.id, r.result])).toEqual([
      ['goal-1#1', 'pass'],
      ['goal-1#2', 'fail'],
      ['goal-1#3', 'pass'],
    ]);
    expect(new Set(ex.calls.filter((c) => c.kind === 'orbit').map((c) => c.cap))).toEqual(new Set([30 / plannedSessions(20, false)]));
  });

  it('US2.2: with the baseline every goal is also attempted three times by the plain session, within the same budget', async () => {
    const goals = parseLiveCatalog(JSON.stringify(fixtureCatalog(3)));
    const ex = fakeExecutor((kind) => trial({ accepted: kind === 'orbit' }));
    const out = await runLiveTier({ goals, budgetUsd: 18, baseline: true, executor: ex });
    expect(out.rows.map((r) => r.result)).toEqual(Array(9).fill('pass'));
    expect(out.baseline!.map((r) => r.result)).toEqual(Array(9).fill('fail'));
    expect(ex.calls.filter((c) => c.kind === 'plain')).toHaveLength(9);
    expect(ex.calls.every((c) => c.kind === 'validate' || c.cap === 1)).toBe(true);
  });

  it('edge case: a goal whose acceptance check is itself wrong is marked invalid and excluded, and no session is spent on it', async () => {
    const goals = parseLiveCatalog(JSON.stringify(fixtureCatalog(2)));
    const ex = fakeExecutor(() => trial(), { 'goal-2': ['the held-out check already passes on the commit'] });
    const out = await runLiveTier({ goals, budgetUsd: 6, baseline: false, executor: ex });
    expect(out.rows.map((r) => [r.id, r.result])).toEqual([
      ['goal-1#1', 'pass'],
      ['goal-1#2', 'pass'],
      ['goal-1#3', 'pass'],
      ['goal-2', 'invalid'],
    ]);
    expect(out.rows[3]!.problems).toEqual(['the held-out check already passes on the commit']);
    expect(ex.calls.filter((c) => c.id === 'goal-2').map((c) => c.kind)).toEqual(['validate']);
  });

  it('a session or a goal check that throws is kept as a row, and the tier goes on, so the sessions already paid for reach the scorecard', async () => {
    const goals = parseLiveCatalog(JSON.stringify(fixtureCatalog(2)));
    const ex = fakeExecutor((_k, g, n) => {
      if (g.id === 'goal-1' && n === 1) throw new Error('git fetch failed');
      return trial();
    });
    ex.validate = async (g) => {
      if (g.id === 'goal-2') throw new Error('no such commit');
      return [];
    };
    const out = await runLiveTier({ goals, budgetUsd: 6, baseline: false, executor: ex });
    expect(out.rows.map((r) => [r.id, r.result])).toEqual([
      ['goal-1#1', 'fail'],
      ['goal-1#2', 'pass'],
      ['goal-1#3', 'pass'],
      ['goal-2', 'invalid'],
    ]);
    expect(out.rows[0]!.problems).toEqual(['the session failed, and its spend is unknown: git fetch failed']);
    expect(out.rows[3]!.problems).toEqual(['could not check the goal: no such commit']);
  });

  it('stops starting sessions once what is left of the budget is less than one session cap', async () => {
    const goals = parseLiveCatalog(JSON.stringify(fixtureCatalog(1)));
    const ex = fakeExecutor(() => trial({ spend_usd: 2.5 }));
    const out = await runLiveTier({ goals, budgetUsd: 3, baseline: false, executor: ex });
    expect(out.rows.map((r) => r.result)).toEqual(['pass', 'invalid', 'invalid']);
    expect(out.rows[1]!.problems[0]).toMatch(/^not run: \$0\.5000 of the budget is left/);
    expect(ex.calls.filter((c) => c.kind === 'orbit')).toHaveLength(1);
  });
});

describe('live executor: the held-out check judges a goal only when it fails before the fix and passes with it', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
  const GIT = { ...process.env, GIT_AUTHOR_NAME: 'acme', GIT_AUTHOR_EMAIL: 'dev@acme.test', GIT_COMMITTER_NAME: 'acme', GIT_COMMITTER_EMAIL: 'dev@acme.test', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, env: GIT, encoding: 'utf8' }).trim();

  /** A repository whose first commit has the failure and whose second is the accepted fix with its test. */
  function pinned(): { url: string; commit: string; reference: string } {
    const base = mkdtempSync(join(tmpdir(), 'orbit-live-exec-'));
    dirs.push(base);
    const repo = join(base, 'src-repo');
    mkdirSync(join(repo, 'test'), { recursive: true });
    writeFileSync(join(repo, 'value.mjs'), 'export const value = 1;\n');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'the failure');
    const commit = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'value.mjs'), 'export const value = 2;\n');
    writeFileSync(join(repo, 'test', 'held-out.test.mjs'), "import assert from 'node:assert';\nimport { value } from '../value.mjs';\nassert.equal(value, 2);\n");
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'the fix');
    return { url: repo, commit, reference: git(repo, 'rev-parse', 'HEAD') };
  }

  const goal = (p: { commit: string; reference: string }, command: string[] = ['node', 'test/held-out.test.mjs']): LiveGoal => ({ id: 'g', repository: 'QuintinBotes/orbit', commit: p.commit, reference: p.reference, issue: 'https://github.com/QuintinBotes/orbit/issues/1', goal: 'Make value 2.', acceptance: { paths: ['test/held-out.test.mjs'], command }, setup: null });

  it('is valid when the check fails on the commit and passes on the fix; invalid when it passes on both or fails on both', async () => {
    const p = pinned();
    const ex = localExecutor({ remote: () => p.url, orbitCommand: ['false'] });
    expect(await ex.validate(goal(p))).toEqual([]);
    expect((await ex.validate(goal(p, ['true'])))[0]).toMatch(/already passes on/);
    expect((await ex.validate(goal(p, ['false'])))[0]).toMatch(/does not pass on the accepted fix/);
  });

  it('is invalid when the setup fails on the commit: a check that never ran there cannot tell a fix from none', async () => {
    const p = pinned();
    const ex = localExecutor({ remote: () => p.url, orbitCommand: ['false'] });
    const g = { ...goal(p, ['true']), setup: ['node', '-e', "process.exit(require('fs').readFileSync('value.mjs', 'utf8').includes('1') ? 1 : 0)"] };
    expect((await ex.validate(g))[0]).toMatch(/^the setup fails on /);
  });

  /** A script that fails when the accepted fix is in the session's clone: the held-out check is one the worker never sees. */
  const blind = (reference: string): string => `git cat-file -e ${reference} 2>/dev/null`;

  it("grades the commit an Orbit run delivered, after the run released its worktree, and the run's clone never held the accepted fix", async () => {
    const p = pinned();
    const fake = join(dirs[0]!, 'fake-orbit.mjs');
    const src = (f: string): string => JSON.stringify(new URL(`../../../src/${f}`, import.meta.url).href);
    // `orbit init` writes a policy; `orbit run` delivers the fix on a branch, puts the clone's checkout back at the failure,
    // and records a SUCCEEDED run whose worktree is gone, as finishRun leaves it.
    writeFileSync(
      fake,
      `import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from ${src('storage/db.ts')};
import { stateDbPath } from ${src('controller/start.ts')};
import { createRun } from ${src('controller/run-store.ts')};
const git = (a) => execSync('git -c user.name=w -c user.email=w@w.test ' + a, { encoding: 'utf8' }).trim();
if (process.argv[2] === 'init') {
  mkdirSync('.orbit', { recursive: true });
  writeFileSync('.orbit/config.yaml', 'scheduler:\\n  hard_limits:\\n    model_cost_usd: 5\\n');
  process.exit(0);
}
let seen = true;
try { execSync(${JSON.stringify(blind(p.reference))}); } catch { seen = false; }
git('checkout -q -b orbit/run-1');
writeFileSync('value.mjs', 'export const value = 2;\\n');
git('commit -q -am fix');
const commit = git('rev-parse HEAD');
git('checkout -q orbit-bench');
const db = openDb(stateDbPath(process.cwd()));
createRun(db, { id: 'run-1', repoRoot: process.cwd(), goal: 'g', mode: 'autonomous', policyHash: 'h', policyPath: '.orbit/config.yaml' }, { now: () => 1 });
db.run('UPDATE runs SET state = ?, worktree_path = ?, outcome_json = ? WHERE id = ?', seen ? 'BLOCKED' : 'SUCCEEDED', join(process.cwd(), 'released'), JSON.stringify({ commit }), 'run-1');
db.close();
`,
    );
    const ex = localExecutor({ remote: () => p.url, orbitCommand: [process.execPath, fake] });
    const t = await ex.orbit(goal(p), 1);
    expect([t.end_state, t.delivered, t.accepted, t.problems]).toEqual(['SUCCEEDED', true, true, []]);
  });

  it('runs the plain session in a clone without the accepted fix, grades its tree, and reads its spend from stdout alone', async () => {
    const p = pinned();
    const bin = join(dirs[0]!, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\n${blind(p.reference)} && exit 7\necho 'export const value = 2;' > value.mjs\necho '{"type":"result","total_cost_usd":0.42}'\necho 'a warning on stderr' >&2\n`, { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path ?? ''}`;
    try {
      const t = await localExecutor({ remote: () => p.url }).plain(goal(p), 1);
      expect([t.end_state, t.accepted, t.spend_usd, t.problems]).toEqual(['DONE', true, 0.42, []]);
      // A session that reports no cost is charged its cap, never counted as free.
      writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho "not json"\n', { mode: 0o755 });
      const silent = await localExecutor({ remote: () => p.url }).plain(goal(p), 1.5);
      expect([silent.spend_usd, silent.problems[0]]).toEqual([1.5, 'the session reported no cost; it is charged its cap of $1.5000']);
    } finally {
      process.env.PATH = path;
    }
  });
});
