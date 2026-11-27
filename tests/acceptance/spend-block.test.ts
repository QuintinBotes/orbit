/**
 * Issue #254: a run whose charged cost reaches its model cost cap waits BLOCKED for a person instead of ending, with a
 * question that says what it spent, the cap, what it asks for and the command that approves it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { listActiveWorkers } from '../../src/storage/workers.ts';
import { listQuestions } from '../../src/inquisition/store.ts';
import { drive, runState } from './helpers/lab.ts';
import { blockedRun, cleanupSpend, cli, inState, sessions } from './helpers/spend.ts';

afterEach(cleanupSpend);

describe('acceptance: a run at its cost cap asks for more spend', () => {
  it('goes BLOCKED with a spend question, starts nothing more, and blocks again after a forced resume', async () => {
    const { lab, run, stateHome, question } = await blockedRun();

    expect(run.state, run.outcomeReason ?? '').toBe('BLOCKED');
    expect(listQuestions(lab.db(), run.id, { status: 'open' })).toHaveLength(1);
    const cost = lab.db().get<{ used: number }>("SELECT used FROM budget_counters WHERE run_id = ? AND counter = 'cost_usd'", run.id)!;
    expect(cost.used).toBeGreaterThanOrEqual(9.6);
    expect(question.material).toBe(true);
    expect(question.question).toContain(`$${cost.used.toFixed(2)} spent of the $12.00 cap`);
    expect(question.question).toContain('$12.00 more (a new cap of $24.00)');
    const command = new RegExp(`orbit decide ${run.id} ${question.id} approve --repo \\S+`).exec(question.question)?.[0];
    expect(command).toBeDefined();
    expect(run.outcomeReason).toContain(command!);
    const events = lab.db().all<{ type: string; to_state: string | null }>('SELECT type, to_state FROM events WHERE run_id = ? ORDER BY id', run.id);
    expect(events.filter((e) => e.type === 'budget.spend-requested')).toHaveLength(1);
    expect(events.some((e) => e.to_state === 'EXHAUSTED')).toBe(false);
    expect(run.failureClass).toBe('budget');
    expect(listActiveWorkers(lab.db(), run.id)).toEqual([]);
    const before = sessions(lab);
    expect(before).toBeGreaterThan(0);

    // A forced resume is not an approval.
    const resumed = await cli(lab, ['resume', run.id, '--force', '--detach']);
    expect(resumed.code, resumed.out).toBe(0);
    expect(runState(lab, run.id).state).not.toBe('BLOCKED');
    const again = await drive(lab, run.id, inState(stateHome));
    expect(again.state, again.outcomeReason ?? '').toBe('BLOCKED');
    expect(sessions(lab)).toBe(before);
    expect(listQuestions(lab.db(), run.id, { status: 'open' }).map((q) => q.id)).toEqual([question.id]);
  }, 180_000);
});
