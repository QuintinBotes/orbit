import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../../../src/core/clock.ts';
import { createRun } from '../../../src/controller/run-store.ts';
import { openDb, type OrbitDb } from '../../../src/storage/db.ts';
import { ARTIFACTS_PRUNED_EVENT, PRUNABLE_STATES, pruneExpiredRuns, repoKeyFor } from '../../../src/storage/retention.ts';

const DAY = 86_400_000;
const gitAvailable = spawnSync('git', ['--version']).status === 0;
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Acme Dev',
  GIT_AUTHOR_EMAIL: 'dev@example.com',
  GIT_COMMITTER_NAME: 'Acme Dev',
  GIT_COMMITTER_EMAIL: 'dev@example.com',
};

let top: string;
let repo: string;
let home: string;
let db: OrbitDb;
let clock: ManualClock;
const savedEnv = { ORBIT_HOME: process.env.ORBIT_HOME, PATH: process.env.PATH };

function addRun(id: string, state: string, endedDaysAgo: number | null, updatedDaysAgo = endedDaysAgo ?? 0): { runDir: string; worktree: string } {
  const runDir = join(repo, '.orbit', 'runs', id);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'final.md'), `# ${id}\n`);
  const worktree = join(home, 'worktrees', repoKeyFor(repo), id);
  mkdirSync(join(worktree, 'implementer'), { recursive: true });
  createRun(db, { id, repoRoot: repo, goal: 'g', mode: 'autonomous', policyHash: 'sha256:x', policyPath: join(runDir, 'policy.json') }, clock);
  db.run('UPDATE runs SET state = ?, ended_at = ?, updated_at = ? WHERE id = ?', state, endedDaysAgo === null ? null : clock.now() - endedDaysAgo * DAY, clock.now() - updatedDaysAgo * DAY, id);
  return { runDir, worktree };
}

beforeEach(() => {
  top = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-retention-cov-')));
  repo = join(top, 'repo');
  home = join(top, 'home');
  mkdirSync(repo);
  db = openDb(':memory:');
  clock = new ManualClock(Date.UTC(2026, 9, 5));
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  db.close();
  rmSync(top, { recursive: true, force: true });
});

describe('pruneExpiredRuns edge cases', () => {
  it('only the four finished states are prunable', () => {
    expect([...PRUNABLE_STATES]).toEqual(['SUCCEEDED', 'EXHAUSTED', 'IMPOSSIBLE', 'CANCELLED']);
    expect(Object.isFrozen(PRUNABLE_STATES)).toBe(true);
  });

  it('skips a run whose id could not name a directory safely, and leaves everything on disk', async () => {
    const p = addRun('good-one', 'SUCCEEDED', 60);
    db.run('PRAGMA foreign_keys = OFF');
    db.run('UPDATE runs SET id = ? WHERE id = ?', 'bad id/../x', 'good-one');
    const r = await pruneExpiredRuns(db, { repoRoot: repo, keepDays: 30, clock, orbitHome: home });
    expect(r.pruned).toEqual([]);
    expect(r.skipped).toEqual([{ runId: 'bad id/../x', reason: 'the run id cannot name a directory safely' }]);
    expect(existsSync(p.runDir)).toBe(true);
  });

  it('dates a run without ended_at by its last update, and reports that date', async () => {
    addRun('orb-noend', 'CANCELLED', null, 50);
    const r = await pruneExpiredRuns(db, { repoRoot: repo, keepDays: 30, clock, orbitHome: home });
    expect(r.pruned.map((p) => [p.runId, p.endedAt])).toEqual([['orb-noend', clock.now() - 50 * DAY]]);
  });

  it('reports the cutoff it used', async () => {
    const r = await pruneExpiredRuns(db, { repoRoot: repo, keepDays: 3, clock, orbitHome: home });
    expect(r.cutoff).toBe(clock.now() - 3 * DAY);
    expect(r).toMatchObject({ pruned: [], skipped: [] });
  });

  it('takes worktrees from ORBIT_HOME when no home is passed', async () => {
    const p = addRun('orb-env', 'SUCCEEDED', 60);
    process.env.ORBIT_HOME = home;
    const r = await pruneExpiredRuns(db, { repoRoot: repo, keepDays: 30, clock });
    expect(r.pruned[0]!.removed).toEqual([p.runDir, p.worktree]);
    expect(existsSync(p.worktree)).toBe(false);
  });

  it('falls back to ~/.orbit without touching anything that is not there', async () => {
    delete process.env.ORBIT_HOME;
    const p = addRun('orb-default-home', 'SUCCEEDED', 60);
    const r = await pruneExpiredRuns(db, { repoRoot: repo, keepDays: 30, clock, dryRun: true });
    // the run directory exists in this repository; the worktree under the default home does not
    expect(r.pruned[0]!.removed).toEqual([p.runDir]);
    expect(existsSync(p.runDir)).toBe(true);
  });

  it('works for a repository path that does not exist: nothing to prune, no error', async () => {
    const missing = join(top, 'gone');
    const r = await pruneExpiredRuns(db, { repoRoot: missing, keepDays: 30, clock, orbitHome: home });
    expect(r.pruned).toEqual([]);
    expect(repoKeyFor(missing)).toMatch(/^[0-9a-f]{12}$/);
    expect(repoKeyFor(missing)).toBe(repoKeyFor(missing));
    expect(repoKeyFor(missing)).not.toBe(repoKeyFor(top));
  });

  it('rejects fractional, negative and non-numeric retention periods', async () => {
    // Zero is a period: "everything that has finished" (P19). It is not in this list any more.
    for (const bad of [0.5, -1, Number.NaN, Number.POSITIVE_INFINITY, '30' as unknown as number]) {
      await expect(pruneExpiredRuns(db, { repoRoot: repo, keepDays: bad, clock, orbitHome: home })).rejects.toThrow(/keepDays must be a non-negative integer/);
    }
  });

  it('a retention period of zero prunes every finished run, including one that ended this instant, and still never a BLOCKED one (P19)', async () => {
    const done = addRun('orb-just-ended', 'SUCCEEDED', 0);
    const blocked = addRun('orb-blocked-now', 'BLOCKED', 0);
    const r = await pruneExpiredRuns(db, { repoRoot: repo, keepDays: 0, clock, orbitHome: home });
    expect(r.pruned.map((p) => p.runId)).toEqual(['orb-just-ended']);
    expect(existsSync(done.runDir)).toBe(false);
    expect(existsSync(done.worktree)).toBe(false);
    expect(existsSync(blocked.runDir)).toBe(true);
  });
});

describe.skipIf(!gitAvailable)('git worktree administration after pruning', () => {
  function gitRepo(): void {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env: GIT_ENV });
    writeFileSync(join(repo, 'a.txt'), 'x');
    execFileSync('git', ['add', '-A'], { cwd: repo, env: GIT_ENV });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo, env: GIT_ENV });
  }

  it('drops the administrative entry of a worktree whose directory was removed', async () => {
    gitRepo();
    const runDir = join(repo, '.orbit', 'runs', 'orb-wt');
    mkdirSync(runDir, { recursive: true });
    const worktree = join(home, 'worktrees', repoKeyFor(repo), 'orb-wt');
    mkdirSync(join(worktree, '..'), { recursive: true });
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'orbit/orb-wt', worktree], { cwd: repo, env: GIT_ENV });
    createRun(db, { id: 'orb-wt', repoRoot: repo, goal: 'g', mode: 'autonomous', policyHash: 'sha256:x', policyPath: join(runDir, 'policy.json') }, clock);
    db.run('UPDATE runs SET state = ?, ended_at = ? WHERE id = ?', 'SUCCEEDED', clock.now() - 90 * DAY, 'orb-wt');
    expect(execFileSync('git', ['worktree', 'list'], { cwd: repo, env: GIT_ENV, encoding: 'utf8' })).toContain('orb-wt');

    const r = await pruneExpiredRuns(db, { repoRoot: repo, keepDays: 30, clock, orbitHome: home });
    expect(r.pruned[0]!.removed).toContain(worktree);
    expect(existsSync(worktree)).toBe(false);
    expect(execFileSync('git', ['worktree', 'list'], { cwd: repo, env: GIT_ENV, encoding: 'utf8' })).not.toContain('orb-wt');
  });

  it('a missing git executable does not fail the pruning', async () => {
    gitRepo();
    const p = addRun('orb-nogit', 'SUCCEEDED', 60);
    process.env.PATH = join(top, 'empty-path');
    const r = await pruneExpiredRuns(db, { repoRoot: repo, keepDays: 30, clock, orbitHome: home });
    expect(r.pruned.map((x) => x.runId)).toEqual(['orb-nogit']);
    expect(existsSync(p.runDir)).toBe(false);
    expect(db.get('SELECT 1 AS x FROM events WHERE run_id = ? AND type = ?', 'orb-nogit', ARTIFACTS_PRUNED_EVENT)).toBeDefined();
  });
});
