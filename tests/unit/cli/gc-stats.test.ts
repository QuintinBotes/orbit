import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { COMMANDS, main } from '../../../src/cli/cli.ts';
import { memoryIo } from '../../../src/cli/io.ts';
import { getRun } from '../../../src/controller/run-store.ts';
import { makeLab, type Lab } from './lab.ts';

const labs: Lab[] = [];
const lab = (): Lab => {
  const l = makeLab();
  labs.push(l);
  return l;
};
afterEach(() => labs.splice(0).forEach((l) => l.close()));

const DAY = 86_400_000;

/** A run that ended `days` days ago, with a run directory holding an artifact. */
function endedRun(l: Lab, goal: string, state: 'CANCELLED' | 'BLOCKED', days: number): { id: string; dir: string } {
  const run = l.newRun(goal);
  l.moveTo(run.id, state === 'BLOCKED' ? ['PREFLIGHT', 'BLOCKED'] : ['PREFLIGHT', 'CANCELLED']);
  const dir = dirname(getRun(l.db(), run.id).policyPath);
  writeFileSync(join(dir, 'evidence.txt'), 'artifact');
  l.db().run('UPDATE runs SET ended_at = ?, updated_at = ? WHERE id = ?', Date.now() - days * DAY, Date.now() - days * DAY, run.id);
  return { id: run.id, dir };
}

describe('orbit gc', () => {
  it('is registered next to stats, and stats answers with the metrics of an empty repository', async () => {
    expect(COMMANDS.map((c) => c.name)).toEqual(expect.arrayContaining(['gc', 'stats']));
    const l = lab();
    l.db();
    const r = await l.cli(['stats', '--json']);
    expect(r.code, r.err).toBe(0);
    expect(() => JSON.parse(r.out)).not.toThrow();
  });

  it('removes the artifacts of finished runs past the retention period, and keeps blocked, recent and in-flight runs', async () => {
    const l = lab();
    const old = endedRun(l, 'Old finished goal.', 'CANCELLED', 40);
    const recent = endedRun(l, 'Recent finished goal.', 'CANCELLED', 2);
    const blocked = endedRun(l, 'Old blocked goal.', 'BLOCKED', 90);
    expect(existsSync(join(old.dir, 'evidence.txt'))).toBe(true);

    const dry = await l.cli(['gc', '--keep-days', '30', '--dry-run']);
    expect(dry.code, dry.err).toBe(0);
    expect(dry.out).toMatch(new RegExp(`would prune ${old.id} \\(CANCELLED`));
    expect(existsSync(old.dir)).toBe(true);

    const r = await l.cli(['gc', '--keep-days', '30']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(new RegExp(`pruned ${old.id} \\(CANCELLED`));
    expect(r.out).not.toContain(recent.id);
    expect(existsSync(old.dir)).toBe(false);
    expect(existsSync(recent.dir)).toBe(true);
    expect(existsSync(blocked.dir)).toBe(true);
    // The run itself is still known, and a second pass finds nothing left.
    expect(getRun(l.db(), old.id).state).toBe('CANCELLED');
    expect((await l.cli(['gc', '--keep-days', '30'])).out).toMatch(/nothing to prune/);

    const j = JSON.parse((await l.cli(['gc', '--keep-days', '1', '--json'])).out) as { keep_days: number; pruned: { runId: string }[] };
    expect(j.keep_days).toBe(1);
    expect(j.pruned.map((p) => p.runId)).toEqual([recent.id]);
  });

  it('takes its default period from retention.keep_runs_days in the policy', async () => {
    const l = lab();
    mkdirSync(join(l.repo, '.orbit'), { recursive: true });
    writeFileSync(join(l.repo, '.orbit', 'config.yaml'), 'version: 1\nmode: supervised\nretention:\n  keep_runs_days: 10\n');
    const old = endedRun(l, 'Old finished goal.', 'CANCELLED', 15);
    const r = await l.cli(['gc', '--json']);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ keep_days: 10, pruned: [{ runId: old.id }] });
    expect(existsSync(old.dir)).toBe(false);
  });

  it('rejects a bad period and extra arguments', async () => {
    const l = lab();
    l.db();
    expect((await l.cli(['gc', '--keep-days', '0'])).code).toBe(2);
    expect((await l.cli(['gc', '--keep-days', 'soon'])).code).toBe(2);
    expect((await l.cli(['gc', 'now'])).code).toBe(2);
  });

  it('is refused inside a worker, while stats stays readable there', async () => {
    const l = lab();
    l.db();
    const io = memoryIo();
    const env = { ...process.env, ORBIT_WORKER: '1' };
    expect(await main(['gc', '--keep-days', '1'], { io, cwd: l.repo, env, orbitHome: l.orbitHome })).toBe(4);
    expect(await main(['stats', '--json'], { io: memoryIo(), cwd: l.repo, env, orbitHome: l.orbitHome })).toBe(0);
  });
});
