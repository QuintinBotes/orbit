import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../../../src/core/clock.ts';
import { openDb, type OrbitDb } from '../../../src/storage/db.ts';
import { createRun } from '../../../src/controller/run-store.ts';
import { ARTIFACTS_PRUNED_EVENT, pruneExpiredRuns, repoKeyFor } from '../../../src/storage/retention.ts';

const DAY = 86_400_000;

let top: string;
let repo: string;
let home: string;
let db: OrbitDb;
let clock: ManualClock;

/** A run in `state` that ended `daysAgo` days before now, with a run directory and a worktree directory on disk. */
function run(id: string, state: string, daysAgo: number, opts: { runDir?: string } = {}): { runDir: string; worktree: string } {
  const runDir = opts.runDir ?? join(repo, '.orbit', 'runs', id);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'final.md'), `# ${id}\n`);
  const worktree = join(home, 'worktrees', repoKeyFor(repo), id);
  mkdirSync(join(worktree, 'implementer'), { recursive: true });
  createRun(db, { id, repoRoot: repo, goal: 'g', mode: 'autonomous', policyHash: 'sha256:x', policyPath: join(runDir, 'policy.json') }, clock);
  db.run('UPDATE runs SET state = ?, ended_at = ? WHERE id = ?', state, clock.now() - daysAgo * DAY, id);
  return { runDir, worktree };
}

const prunedEvents = (id: string) => db.all<{ actor: string; data_json: string }>('SELECT actor, data_json FROM events WHERE run_id = ? AND type = ?', id, ARTIFACTS_PRUNED_EVENT);

beforeEach(() => {
  top = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-retention-')));
  repo = join(top, 'repo');
  home = join(top, 'home');
  mkdirSync(repo);
  db = openDb(':memory:');
  clock = new ManualClock(Date.UTC(2026, 9, 5));
});

afterEach(() => {
  db.close();
  rmSync(top, { recursive: true, force: true });
});

describe('pruneExpiredRuns (retention.keep_runs_days)', () => {
  it('removes the run directory and worktrees of finished runs older than the retention period, keeping the rows', async () => {
    const old = run('orb-old', 'SUCCEEDED', 31);
    const cancelled = run('orb-cancelled', 'CANCELLED', 40);
    const recent = run('orb-recent', 'SUCCEEDED', 29);
    const r = await pruneExpiredRuns(db, { repoRoot: repo, keepDays: 30, clock, orbitHome: home });

    expect(r.pruned.map((p) => p.runId)).toEqual(['orb-cancelled', 'orb-old']);
    for (const p of [old, cancelled]) {
      expect(existsSync(p.runDir)).toBe(false);
      expect(existsSync(p.worktree)).toBe(false);
    }
    expect(existsSync(recent.runDir)).toBe(true);
    expect(existsSync(recent.worktree)).toBe(true);
    // Rows stay, marked.
    expect(db.get<{ state: string }>('SELECT state FROM runs WHERE id = ?', 'orb-old')?.state).toBe('SUCCEEDED');
    const ev = prunedEvents('orb-old');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.actor).toBe('gc');
    expect(JSON.parse(ev[0]!.data_json)).toEqual({ keep_runs_days: 30, removed: [old.runDir, old.worktree] });
    expect(prunedEvents('orb-recent')).toHaveLength(0);
  });

  it('prunes a run once the clock passes its retention period, and only once', async () => {
    const p = run('orb-a', 'EXHAUSTED', 5);
    expect((await pruneExpiredRuns(db, { repoRoot: repo, keepDays: 7, clock, orbitHome: home })).pruned).toEqual([]);
    clock.advance(2 * DAY + 1);
    expect((await pruneExpiredRuns(db, { repoRoot: repo, keepDays: 7, clock, orbitHome: home })).pruned.map((x) => x.runId)).toEqual(['orb-a']);
    expect(existsSync(p.runDir)).toBe(false);
    clock.advance(DAY);
    expect((await pruneExpiredRuns(db, { repoRoot: repo, keepDays: 7, clock, orbitHome: home })).pruned).toEqual([]);
    expect(prunedEvents('orb-a')).toHaveLength(1);
  });

  it('never touches BLOCKED or still-active runs, whatever their age', async () => {
    const blocked = run('orb-blocked', 'BLOCKED', 400);
    const active = run('orb-active', 'IMPLEMENTING', 400);
    const r = await pruneExpiredRuns(db, { repoRoot: repo, keepDays: 1, clock, orbitHome: home });
    expect(r.pruned).toEqual([]);
    for (const p of [blocked, active]) {
      expect(existsSync(p.runDir)).toBe(true);
      expect(existsSync(p.worktree)).toBe(true);
    }
  });

  it('waits while a controller still holds the run lease', async () => {
    const p = run('orb-leased', 'SUCCEEDED', 60);
    db.run('INSERT INTO leases (run_id, owner_id, acquired_at, heartbeat_at, expires_at) VALUES (?, ?, ?, ?, ?)', 'orb-leased', 'owner', clock.now(), clock.now(), clock.now() + 30_000);
    const r = await pruneExpiredRuns(db, { repoRoot: repo, keepDays: 30, clock, orbitHome: home });
    expect(r.pruned).toEqual([]);
    expect(r.skipped).toEqual([{ runId: 'orb-leased', reason: 'a controller still holds its lease' }]);
    expect(existsSync(p.runDir)).toBe(true);
    clock.advance(30_001);
    expect((await pruneExpiredRuns(db, { repoRoot: repo, keepDays: 30, clock, orbitHome: home })).pruned.map((x) => x.runId)).toEqual(['orb-leased']);
  });

  it('refuses to delete a run directory recorded outside the repository, and never follows a symlinked worktree', async () => {
    const elsewhere = join(top, 'elsewhere', 'orb-out');
    const out = run('orb-out', 'SUCCEEDED', 90, { runDir: elsewhere });
    const r1 = await pruneExpiredRuns(db, { repoRoot: repo, keepDays: 30, clock, orbitHome: home });
    expect(r1.pruned).toEqual([]);
    expect(r1.skipped[0]?.reason).toMatch(/is not .*\.orbit\/runs\/orb-out/);
    expect(existsSync(out.runDir)).toBe(true);

    const precious = join(top, 'precious');
    mkdirSync(precious);
    writeFileSync(join(precious, 'keep.txt'), 'keep');
    const linked = run('orb-link', 'SUCCEEDED', 90);
    rmSync(linked.worktree, { recursive: true });
    symlinkSync(precious, linked.worktree);
    const r2 = await pruneExpiredRuns(db, { repoRoot: repo, keepDays: 30, clock, orbitHome: home });
    expect(r2.pruned.map((p) => p.runId)).toEqual(['orb-link']);
    expect(r2.pruned[0]!.removed).toEqual([linked.runDir]);
    expect(existsSync(join(precious, 'keep.txt'))).toBe(true);
  });

  it('reports without removing anything in a dry run, and rejects a non-positive retention period', async () => {
    const p = run('orb-dry', 'IMPOSSIBLE', 45);
    const r = await pruneExpiredRuns(db, { repoRoot: repo, keepDays: 30, clock, orbitHome: home, dryRun: true });
    expect(r.pruned).toEqual([{ runId: 'orb-dry', state: 'IMPOSSIBLE', endedAt: clock.now() - 45 * DAY, removed: [p.runDir, p.worktree] }]);
    expect(existsSync(p.runDir)).toBe(true);
    expect(prunedEvents('orb-dry')).toHaveLength(0);
    await expect(pruneExpiredRuns(db, { repoRoot: repo, keepDays: 0, clock, orbitHome: home })).rejects.toThrow(/keepDays/);
  });
});
