/** Issue #254: a person approves with the command the request names, and the run goes on to its normal end. */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { listQuestions } from '../../src/inquisition/store.ts';
import { acquireLease, releaseLease, transition } from '../../src/controller/run-store.ts';
import { systemClock } from '../../src/core/clock.ts';
import { drive, runState } from './helpers/lab.ts';
import { blockedRun, cleanupSpend, cli, commandWords, inboxFiles, inState, readInbox } from './helpers/spend.ts';

afterEach(cleanupSpend);

describe('acceptance: approving more spend', () => {
  it('raises this run\'s cap by its original cap, removes the file and carries the run to SUCCEEDED', async () => {
    const { lab, run, stateHome, question } = await blockedRun();
    expect(run.state, run.outcomeReason ?? '').toBe('BLOCKED');
    const [file] = inboxFiles(stateHome);
    const command = String(readInbox(stateHome, file!).command);
    const policy = readFileSync(run.policyPath, 'utf8');
    const contract = run.contractJson;

    const approved = await cli(lab, commandWords(command));
    expect(approved.code, approved.out).toBe(0);
    expect(approved.out).toContain('$24.00 (was $12.00)');
    expect(inboxFiles(stateHome)).toEqual([]);
    expect(runState(lab, run.id).state).not.toBe('BLOCKED');
    expect(listQuestions(lab.db(), run.id, { status: 'open' })).toEqual([]);

    const done = await drive(lab, run.id, inState(stateHome));
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(inboxFiles(stateHome)).toEqual([]);
    expect(readFileSync(done.policyPath, 'utf8')).toBe(policy);
    expect(done.contractJson).toBe(contract);
    // The stored counter keeps the policy's cap; the approval is added to it.
    expect(lab.db().get<{ hard_cap: number }>("SELECT hard_cap FROM budget_counters WHERE run_id = ? AND counter = 'cost_usd'", run.id)!.hard_cap).toBe(12);
    const decision = lab.db().get<{ data_json: string }>("SELECT data_json FROM decisions WHERE run_id = ? AND kind = 'budget.spend-approved'", run.id)!;
    expect(JSON.parse(decision.data_json)).toMatchObject({ question_id: question.id, increment_usd: 12, total_usd: 24, approved_by: 'acme' });

    const status = await cli(lab, ['status', run.id]);
    expect(status.out).toMatch(/cost_usd .* \$24\.00 allowed \(hard cap \$24\.00, including \$12\.00 of extra spend a person approved\)/);
  }, 240_000);

  it('an approve repeated after the run went on does not release a later block with another cause', async () => {
    const { lab, run, stateHome } = await blockedRun();
    const command = commandWords(String(readInbox(stateHome, inboxFiles(stateHome)[0]!).command));
    expect((await cli(lab, command)).code).toBe(0);
    const going = runState(lab, run.id);
    expect(going.state).not.toBe('BLOCKED');

    // Later the run blocks for something that is not money (here: a person must look at the environment).
    expect(acquireLease(lab.db(), run.id, 'test', 60_000, systemClock)).not.toBeNull();
    transition(lab.db(), { runId: run.id, to: 'BLOCKED', ownerId: 'test', reason: 'the environment needs a person', actor: 'test', expectedFrom: going.state, patch: { outcomeReason: 'the environment needs a person' } }, systemClock);
    releaseLease(lab.db(), run.id, 'test');

    // The old approve line, run again from shell history, records nothing new and leaves the block alone.
    const again = await cli(lab, command);
    expect(again.code, again.out).toBe(0);
    expect(again.out).toContain('changes nothing');
    expect(again.out).not.toContain('is now $24.00');
    expect(runState(lab, run.id).state).toBe('BLOCKED');
    expect(runState(lab, run.id).outcomeReason).toContain('the environment needs a person');
  }, 240_000);
});
