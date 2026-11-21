/**
 * Issue #177: spend follows the task. The real controller drives examples/demo-app with the fake providers.
 *
 * AC-1: a new session's turn cap is the 75th percentile of the turns earlier successful sessions of its role and task
 * class took, within the configured bounds. AC-3: a session that reaches its turn reminder and states what remains gets
 * one extension, and its unfinished tree is neither verified nor diagnosed. AC-4: a failure the environment classifier
 * resolves starts no diagnosis session. AC-5: the JSON report lists input, cached input, output and cost per role and
 * warns for a role whose cache hit ratio is under the threshold. (AC-2, the reminder itself, is the guard hook's, which
 * the fake CLI does not run: tests/unit/policy/guard-hook.test.ts "runGuardHook turn reminder".)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { systemClock } from '../../src/core/clock.ts';
import { createRun } from '../../src/controller/run-store.ts';
import type { FinalReport } from '../../src/controller/report.ts';
import { listDecisions } from '../../src/storage/decisions.ts';
import { listWorkers } from '../../src/storage/workers.ts';
import { drive, makeLab, READY, startLabRun, writeScenario, type Lab } from './helpers/lab.ts';
import { GOAL, GOOD_IMPLEMENTATION, implementer, scenario, SRC_TEXT, TEST_TEXT } from './helpers/scenarios.ts';

const labs: Lab[] = [];
afterEach(() => labs.splice(0).forEach((l) => l.close()));
function lab(opts: Parameters<typeof makeLab>[0] = {}): Lab {
  const l = makeLab(opts);
  labs.push(l);
  return l;
}

interface ArgvCall {
  tool: string;
  role: string;
  argv: string[];
  envKeys: string[];
}
const calls = (l: Lab): ArgvCall[] =>
  readFileSync(l.argvLog, 'utf8')
    .split('\n')
    .filter((x) => x.trim())
    .map((x) => JSON.parse(x) as ArgvCall);
const maxTurns = (c: ArgvCall): number => Number(c.argv[c.argv.indexOf('--max-turns') + 1]);
const states = (l: Lab, runId: string): string[] => l.db().all<{ to_state: string }>('SELECT to_state FROM events WHERE run_id = ? AND to_state IS NOT NULL ORDER BY id', runId).map((r) => r.to_state);

/** Sessions of an earlier run in this repository, as its controller would have recorded them. */
function seedHistory(l: Lab, difficulty: string, role: string, turns: number[]): void {
  const db = l.db();
  createRun(db, { id: 'orb-earlier', repoRoot: l.repo, goal: 'earlier work', mode: 'autonomous', policyHash: 'sha256:x', policyPath: '/p' }, systemClock);
  db.run('UPDATE runs SET difficulty = ? WHERE id = ?', difficulty, 'orb-earlier');
  for (const [i, n] of turns.entries()) {
    db.run(
      "INSERT INTO workers (id, run_id, role, provider, state, worker_dir, cwd, result_status, result_json, created_at) VALUES (?, 'orb-earlier', ?, 'claude', 'SUCCEEDED', '/w', '/c', 'succeeded', ?, 1)",
      `wrk-earlier-${i}`,
      role,
      JSON.stringify({ status: 'succeeded', modelRequests: n }),
    );
  }
}

describe.skipIf(!READY)('acceptance: spend follows the task (issue #177)', () => {
  it('AC-1 and AC-5: the implementer starts under the 75th percentile of its task class, and the JSON report gives usage, cache hit ratio and cost per role', async () => {
    const l = lab();
    // The demo goal is a simple task; successful implementer sessions of simple tasks took 10, 12, 16 and 18 turns.
    seedHistory(l, 'simple', 'implementer', [10, 12, 16, 18]);
    const cached = { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 9_000, cacheCreationInputTokens: 100, costUSD: 0.02 };
    writeScenario(l, scenario({ implementer: [implementer([SRC_TEXT, TEST_TEXT], { extra: { usage: cached } })] }));
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(done.difficulty).toBe('simple');

    // AC-1: 16 is the 75th percentile, within the default floor (10) and ceiling (the hard cap, 30).
    const claude = calls(l).filter((c) => c.tool === 'claude');
    const impl = claude.filter((c) => c.role === 'implementer');
    expect(impl.map(maxTurns)).toEqual([16]);
    // The planner has no history: the default, the hard cap, applies.
    expect(claude.filter((c) => c.role === 'planner').map(maxTurns)).toEqual([30]);
    // The guard hook gets the cap and the turn its reminder starts at (80% of 16).
    expect(impl[0]!.envKeys).toEqual(expect.arrayContaining(['ORBIT_TURN_CAP', 'ORBIT_TURN_REMIND_AT']));
    const [w] = listWorkers(l.db(), { runId: run.id }).filter((x) => x.role === 'implementer');
    const event = l.db().get<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'worker.turn-cap' AND json_extract(data_json, '$.worker_id') = ?", run.id, w!.id);
    expect(JSON.parse(event!.data_json)).toMatchObject({ role: 'implementer', cap: 16, remind_at: 13 });

    // AC-5: the JSON report lists each role with input, cached input, output, cost and hit ratio, and warns for the
    // planner (the fake's default usage: 800 cached of 2,100 prompt tokens) but not for the well-cached implementer.
    const report = JSON.parse(readFileSync(join(l.runDir(run.id), 'final.json'), 'utf8')) as FinalReport;
    const byRole = report.budget!.usage_by_role!;
    const implementerUsage = byRole.roles.find((r) => r.role === 'implementer')!;
    expect(implementerUsage).toMatchObject({ sessions: 1, input_tokens: 100, cached_input_tokens: 9_000, output_tokens: 50, cost_usd: 0.02, cache_hit_ratio: 0.9783 });
    expect(byRole.roles.find((r) => r.role === 'planner')).toMatchObject({ input_tokens: 1200, cached_input_tokens: 800, output_tokens: 340, cost_usd: 0.0123, cache_hit_ratio: 0.381 });
    expect(byRole.cache_hit_threshold).toBe(0.5);
    expect(byRole.warnings.some((x) => x.startsWith('planner: cache hit ratio 0.381 is under 0.5'))).toBe(true);
    expect(byRole.warnings.some((x) => x.startsWith('implementer:'))).toBe(false);
    // One accepted task: its cost is the run's measured model cost.
    expect(byRole.cost_per_accepted_task).toBe(report.budget!.cost_usd);
    const md = readFileSync(join(l.runDir(run.id), 'final.md'), 'utf8');
    expect(md).toContain('role implementer: 100 in, 9000 cached in, 50 out, $0.0200, cache hit ratio 0.9783');
    expect(md).toMatch(/warning: planner: cache hit ratio 0\.381 is under 0\.5/);
    expect(md).toContain(`cost per accepted task: $${report.budget!.cost_usd.toFixed(4)}`);
  }, 240_000);

  it('AC-3: a session that reached its turn reminder and said what remains gets one extension, and its unfinished tree is not verified or diagnosed', async () => {
    // A hard cap of 4 turns: the reminder starts at turn 3, which the fake's first session (an edit, a read and its
    // structured output) reaches.
    const l = lab({ tweak: (c) => void (c.scheduler.hard_limits.worker_turns_per_session = 4) });
    const asks = implementer([SRC_TEXT]) as { structured: Record<string, unknown> };
    asks.structured.next_action = { kind: 'continue-implementation', detail: 'Assert the new not-found text in tests/unit/server.test.ts.' };
    // A second ask from the extension session is not granted again; its work is verified as usual.
    const asksAgain = implementer([TEST_TEXT]) as { structured: Record<string, unknown> };
    asksAgain.structured.next_action = { kind: 'continue-implementation', detail: 'Nothing else; one more look at the docs.' };
    writeScenario(l, scenario({ implementer: [asks, asksAgain, GOOD_IMPLEMENTATION()] }));
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');

    const implementers = listWorkers(l.db(), { runId: run.id }).filter((w) => w.role === 'implementer');
    // Two sessions of the one attempt: the one that asked and its extension; no third.
    expect(implementers.map((w) => [w.attempt, w.purpose])).toEqual([
      [1, 'implement:1#1'],
      [1, 'implement:1#2'],
    ]);
    const used = l.db().get<{ used: number }>("SELECT used FROM budget_counters WHERE run_id = ? AND counter = 'implementation_attempts'", run.id)!.used;
    expect(used).toBe(1);
    const [ext, ...more] = listDecisions(l.db(), run.id, { kind: 'budget.turn-extension' });
    expect(more).toEqual([]);
    expect(ext!.data).toMatchObject({ attempt: 1, worker_id: implementers[0]!.id, turns: 3, cap: 4, remainder: 'Assert the new not-found text in tests/unit/server.test.ts.' });
    // The extension session is told what remains; the stop is not a defect: no candidate of the first session, no
    // verification of it and no diagnosis.
    const prompt = readFileSync(join(implementers[1]!.workerDir, 'prompt.md'), 'utf8');
    expect(prompt).toContain("reached its turn cap (3 of 4 turns) and asked to continue");
    expect(prompt).toContain('Assert the new not-found text in tests/unit/server.test.ts.');
    expect(states(l, run.id)).not.toContain('DIAGNOSING');
    expect(l.db().all('SELECT id FROM candidates WHERE run_id = ?', run.id)).toHaveLength(1);
    expect(listWorkers(l.db(), { runId: run.id }).filter((w) => w.role === 'verifier')).toEqual([]);
  }, 240_000);

  it('AC-4: a failure the environment classifier resolves starts no diagnosis session', async () => {
    const DENIED = "console.error('Error: listen EPERM: operation not permitted 127.0.0.1');\nprocess.exit(1);\n";
    const l = lab({
      files: { 'tools/unit-denied.mjs': DENIED },
      tweak: (c) => {
        c.checks.unit = { ...c.checks.unit!, command: [process.execPath, 'tools/unit-denied.mjs'] };
      },
    });
    writeScenario(l, scenario({ implementer: [GOOD_IMPLEMENTATION()] }));
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    expect(listDecisions(l.db(), run.id, { kind: 'verification.environment-failure' })).toHaveLength(1);
    // Counted sessions: the planner and one implementer; no verifier (diagnosis) session, no repair.
    const roles = listWorkers(l.db(), { runId: run.id }).map((w) => w.role);
    expect(roles.filter((r) => r === 'verifier')).toEqual([]);
    expect(roles.filter((r) => r === 'implementer')).toHaveLength(1);
    expect(states(l, run.id)).not.toContain('DIAGNOSING');
  }, 240_000);
});
