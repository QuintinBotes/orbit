import { afterEach, describe, expect, it } from 'vitest';
import { systemClock } from '../../../src/core/clock.ts';
import { verifySnapshot } from '../../../src/policy/snapshot.ts';
import { BudgetLedger } from '../../../src/scheduling/budget.ts';
import { planWorker } from '../../../src/storage/workers.ts';
import { registerController } from '../../../src/storage/controllers.ts';
import { markProgress, acquireLease, releaseLease } from '../../../src/controller/run-store.ts';
import { makeLab, type Lab } from './lab.ts';

const labs: Lab[] = [];
const lab = (o?: Parameters<typeof makeLab>[0]) => {
  const l = makeLab(o);
  labs.push(l);
  return l;
};
afterEach(() => labs.splice(0).forEach((l) => l.close()));

describe('orbit status', () => {
  it('has no state to read in a repository that never ran Orbit', async () => {
    const l = lab();
    const r = await l.cli(['status']);
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/no Orbit state/);
  });

  it('lists recent runs newest first, with the controllers that could pick them up', async () => {
    const l = lab();
    const a = l.newRun('First goal');
    await new Promise((r) => setTimeout(r, 5));
    const b = l.newRun('Second goal');
    const r = await l.cli(['status']);
    expect(r.code).toBe(0);
    expect(r.out.indexOf(b.id)).toBeLessThan(r.out.indexOf(a.id));
    expect(r.out).toContain('CREATED');
    expect(r.out).toContain('controllers: none running');
    const j = JSON.parse((await l.cli(['status', '--json'])).out) as { runs: { id: string }[]; controllers: unknown[] };
    expect(j.runs.map((x) => x.id)).toEqual([b.id, a.id]);
    expect(j.controllers).toEqual([]);
  });

  it('finds a run by a unique prefix and says so when the prefix is ambiguous or unknown', async () => {
    const l = lab();
    l.newRun('one', 'orb-20260101-000000-aaaaaa');
    l.newRun('two', 'orb-20260101-000000-aabbbb');
    expect((JSON.parse((await l.cli(['status', 'orb-20260101-000000-aaa', '--json'])).out) as { id: string }).id).toBe('orb-20260101-000000-aaaaaa');
    const ok = await l.cli(['status', 'orb-20260101-000000-aab', '--json']);
    expect(ok.code, ok.err).toBe(0);
    expect((JSON.parse(ok.out) as { id: string }).id).toBe('orb-20260101-000000-aabbbb');
    const none = await l.cli(['status', 'orb-nonexistent']);
    expect(none.code).toBe(3);
    expect(none.err).toMatch(/no run orb-nonexistent; recent runs:/);
    const amb = await l.cli(['status', 'orb-20260101-000000-aa']);
    expect(amb.code).toBe(3);
    expect(amb.err).toMatch(/matches more than one run/);
  });

  it('reports state, stage, ownership, heartbeat, workers and open questions for one run', async () => {
    const l = lab();
    const run = l.newRun('Add a mul function to the calculator.');
    l.moveTo(run.id, ['PREFLIGHT', 'CONTRACTING']);
    const db = l.db();
    registerController(db, { id: 'ctl-1', pid: process.pid, host: 'h', procStart: null, mode: 'service' }, systemClock);
    acquireLease(db, run.id, 'ctl-1', 60_000, systemClock);
    markProgress(db, run.id, 'contract.drafted', {}, systemClock);
    planWorker(db, { id: `${run.id}-w1`, runId: run.id, role: 'planner', provider: 'claude', model: 'claude-sonnet-5-5', workerDir: '/w', cwd: '/c' }, systemClock);
    const q = l.ask(run.id);

    const j = JSON.parse((await l.cli(['status', run.id, '--json'])).out) as {
      state: string;
      stage: string;
      owner: { owner_id: string } | null;
      heartbeat: { controller_id: string; mode: string } | null;
      workers: { active: { id: string; role: string }[]; counts: Record<string, number> };
      questions: { open: { id: string; material: boolean }[] };
      last_progress_at: number | null;
      paused: boolean;
      budgets: unknown;
    };
    expect(j.state).toBe('CONTRACTING');
    expect(j.owner?.owner_id).toBe('ctl-1');
    expect(j.heartbeat).toMatchObject({ controller_id: 'ctl-1', mode: 'service' });
    expect(j.workers.active.map((w) => [w.id, w.role])).toEqual([[`${run.id}-w1`, 'planner']]);
    expect(j.workers.counts).toEqual({ PLANNED: 1 });
    expect(j.questions.open).toEqual([expect.objectContaining({ id: q.id, material: true })]);
    expect(j.last_progress_at).not.toBeNull();
    expect(j.paused).toBe(false);
    expect(j.budgets).toBeNull();

    const text = (await l.cli(['status', run.id])).out;
    expect(text).toContain(`run ${run.id}  CONTRACTING`);
    expect(text).toContain('owner:     ctl-1');
    expect(text).toMatch(/heartbeat: service controller ctl-1 .* \(live\)/);
    expect(text).toContain('not initialized yet');
    expect(text).toContain(`orbit decide ${run.id} <question-id> <answer>`);
    releaseLease(db, run.id, 'ctl-1');
  });

  it('shows attempts against allowances and the cost caps once budgets exist', async () => {
    const l = lab();
    const run = l.newRun();
    const db = l.db();
    const ledger = new BudgetLedger(db, systemClock).init(run.id, verifySnapshot(run.policyPath, run.policyHash), 'medium');
    ledger.consume('implementation_attempts', 1);
    const j = JSON.parse((await l.cli(['status', run.id, '--json'])).out) as { budgets: { verified_policy: boolean; counters: { counter: string; used: number; allowance: number; hard_cap: number }[]; cost_measurement: { state: string } } };
    expect(j.budgets.verified_policy).toBe(true);
    const attempts = j.budgets.counters.find((c) => c.counter === 'implementation_attempts')!;
    expect(attempts.used).toBe(1);
    expect(attempts.allowance).toBe(4);
    expect(attempts.hard_cap).toBe(12);
    expect(j.budgets.counters.map((c) => c.counter)).toEqual(expect.arrayContaining(['cost_usd', 'wall_ms']));
    expect(j.budgets.cost_measurement.state).toBe('no_usage');
    const text = (await l.cli(['status', run.id])).out;
    expect(text).toMatch(/implementation_attempts\s+1 used \/ 4 allowed \(hard cap 12\)/);
    expect(text).toContain('final reserve');
  });

  it('shows stored counters, marked unverified, when the policy snapshot no longer verifies', async () => {
    const l = lab();
    const run = l.newRun();
    new BudgetLedger(l.db(), systemClock).init(run.id, verifySnapshot(run.policyPath, run.policyHash), 'simple');
    const { rmSync, writeFileSync } = await import('node:fs');
    rmSync(run.policyPath, { force: true });
    writeFileSync(run.policyPath, '{}');
    const j = JSON.parse((await l.cli(['status', run.id, '--json'])).out) as { budgets: { verified_policy: boolean; counters: unknown[] } };
    expect(j.budgets.verified_policy).toBe(false);
    expect(j.budgets.counters.length).toBeGreaterThan(3);
    expect((await l.cli(['status', run.id])).out).toContain('policy snapshot did not verify');
  });

  it('flags a stale heartbeat instead of presenting it as alive', async () => {
    const l = lab();
    l.newRun();
    const db = l.db();
    registerController(db, { id: 'ctl-old', pid: 2_000_000_000, host: 'elsewhere', procStart: null, mode: 'service' }, { now: () => Date.now() - 10 * 60_000, sleep: async () => {} });
    const j = JSON.parse((await l.cli(['status', '--json'])).out) as { controllers: { id: string; live: boolean }[] };
    expect(j.controllers).toEqual([expect.objectContaining({ id: 'ctl-old', live: false })]);
    expect((await l.cli(['status'])).out).toContain('controllers: none running');
  });
});
