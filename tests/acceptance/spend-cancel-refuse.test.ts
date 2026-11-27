/** Issue #254: cancelling or refusing removes the spend file; a refused run ends as an exhausted one does. */
import { afterEach, describe, expect, it } from 'vitest';
import { listQuestions } from '../../src/inquisition/store.ts';
import { listWorkers } from '../../src/storage/workers.ts';
import { heldVerifiedCandidate } from '../../src/controller/verified-candidate.ts';
import { runState } from './helpers/lab.ts';
import { blockedRun, cleanupSpend, cli, inboxFiles, sessions } from './helpers/spend.ts';

afterEach(cleanupSpend);

describe('acceptance: cancelling or refusing a spend request', () => {
  it('orbit cancel of a cost-blocked run removes its spend file', async () => {
    const { lab, run, stateHome } = await blockedRun();
    expect(inboxFiles(stateHome)).toHaveLength(1);

    const r = await cli(lab, ['cancel', run.id]);
    expect(r.code, r.out).toBe(0);
    expect(runState(lab, run.id).state).toBe('CANCELLED');
    expect(inboxFiles(stateHome)).toEqual([]);
    expect(listQuestions(lab.db(), run.id, { status: 'open' })).toEqual([]);
  }, 180_000);

  it('refusing removes the file and ends the run EXHAUSTED without starting a session', async () => {
    const { lab, run, stateHome, question } = await blockedRun();
    expect(inboxFiles(stateHome)).toHaveLength(1);
    const before = sessions(lab);
    const workers = listWorkers(lab.db(), { runId: run.id }).length;

    // Free text neither approves nor refuses: nothing is recorded and nothing changes.
    const vague = await cli(lab, ['decide', run.id, question.id, 'maybe', 'later']);
    expect(vague.code).not.toBe(0);
    expect(inboxFiles(stateHome)).toHaveLength(1);
    expect(listQuestions(lab.db(), run.id, { status: 'open' })).toHaveLength(1);

    const r = await cli(lab, ['decide', run.id, question.id, 'refuse']);
    expect(r.code, r.out).toBe(0);
    const done = runState(lab, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('EXHAUSTED');
    expect(done.outcomeReason).toMatch(/model cost cap reached .* acme refused more spend/);
    expect(heldVerifiedCandidate(done)).toBeNull();
    expect(inboxFiles(stateHome)).toEqual([]);
    expect(sessions(lab)).toBe(before);
    expect(listWorkers(lab.db(), { runId: run.id })).toHaveLength(workers);
  }, 180_000);
});
