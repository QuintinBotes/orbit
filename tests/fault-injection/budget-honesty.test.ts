// Cost accounting under faults (e2e retest NB2 and NB3/P15). A reviewer outage whose sessions never reached a model
// must not spend the cost cap, so resume after the fix can still review; and a small cost cap must still fund a
// real implementer session instead of stopping before any work.
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../../src/cli/cli.ts';
import { memoryIo } from '../../src/cli/io.ts';
import { listWorkers } from '../../src/storage/workers.ts';
import { APPROVE, baseScenario, calls, canStripTypes, drive, events, implementMul, runState, startLabRun, tracker, writeScenario, type Lab } from './helpers.ts';

const t = tracker();
afterEach(() => t.cleanup());

async function resume(l: Lab, runId: string): Promise<{ code: number; out: string; err: string }> {
  const io = memoryIo('');
  // --detach: only change the run; the test drives it (a bare resume with no controller now refuses, NM5).
  const code = await main(['resume', runId, '--detach'], { io, cwd: l.repo, homeDir: l.base, orbitHome: l.orbitHome, env: { ...process.env, ORBIT_HOME: l.orbitHome }, user: 'acme' });
  return { code, out: io.stdout, err: io.stderr };
}

const costUsed = (l: Lab, runId: string): number => l.db().get<{ used: number }>("SELECT used FROM budget_counters WHERE run_id = ? AND counter = 'cost_usd'", runId)!.used;

describe.skipIf(!canStripTypes)('fault: cost accounting stays honest', () => {
  it('NB2: on a $10 cap, two reviewer sessions that die before any model output cost nothing, and resume reaches review attempt 3', async () => {
    const l = t.lab({ tweak: (c) => void (c.scheduler.hard_limits.model_cost_usd = 10) });
    writeScenario(l, baseScenario({ implementer: [implementMul('*')], reviewer: [{ exitBeforeOutput: true }, { exitBeforeOutput: true }, APPROVE] }));
    const run = startLabRun(l);
    await drive(l, run.id);
    const blocked = runState(l, run.id);
    expect(blocked.state, blocked.outcomeReason ?? '').toBe('BLOCKED');
    // Only the planner, implementer and verifier sessions spent anything (a few cents each from the fake).
    expect(costUsed(l, run.id)).toBeLessThan(1);
    expect(events(l, run.id, 'budget.cost-zero-no-model')).toHaveLength(2);

    const r = await resume(l, run.id);
    expect(r.code, r.err + r.out).toBe(0);
    await drive(l, run.id);
    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const purposes = listWorkers(l.db(), { runId: run.id, role: 'reviewer' }).map((w) => w.purpose);
    expect(purposes.some((p) => /^review:.+#3$/.test(p ?? ''))).toBe(true);
    expect(calls(l, 'reviewer')).toHaveLength(3);
  }, 120_000);

  it('NB3: a $5 cap runs a Sonnet implementer to a verified result', async () => {
    const l = t.lab({
      tweak: (c) => {
        c.scheduler.hard_limits.model_cost_usd = 5;
        c.providers.claude = { ...c.providers.claude!, model: 'claude-sonnet-5-5' };
      },
    });
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const run = startLabRun(l);
    await drive(l, run.id);
    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(calls(l, 'implementer')).toHaveLength(1);
    const cap = events(l, run.id, 'worker.spend-cap').map((e) => JSON.parse(e.data_json!) as { purpose: string; cap_usd: number; worst_case_usd: number }).find((d) => d.purpose === 'implement:1#1');
    expect(cap?.cap_usd).toBeGreaterThan(0.5);
    expect(cap!.cap_usd + cap!.worst_case_usd).toBeLessThanOrEqual(4);
  }, 120_000);

  it('NB3: a cap too small for one Sonnet session stops before any implementer and says so in dollars', async () => {
    // $1.35 less the 20% reserve is $1.08: past admission (a $1 minimum session ceiling), short of the $1.12 a Sonnet
    // session with no budget of its own can still spend on one request (200000 prompt tokens and 32000 output).
    const l = t.lab({ tweak: (c) => void (c.scheduler.hard_limits.model_cost_usd = 1.35) });
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const run = startLabRun(l);
    await drive(l, run.id);
    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('EXHAUSTED');
    expect(done.outcomeReason).toBe("attempt 1 not started: cap $1.35 is below one session's worst case $1.12 plus the $0.27 closing reserve");
    expect(calls(l, 'implementer')).toHaveLength(0);
  }, 120_000);
});
