import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { systemClock } from '../../../src/core/clock.ts';
import { OrbitError } from '../../../src/core/errors.ts';
import { acquireLease, getLease, getRun, releaseLease, transition } from '../../../src/controller/run-store.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { makeLab, type Lab } from './lab.ts';

const labs: Lab[] = [];
const lab = (o?: Parameters<typeof makeLab>[0]) => {
  const l = makeLab(o);
  labs.push(l);
  return l;
};
afterEach(() => labs.splice(0).forEach((l) => l.close()));

function events(l: Lab, runId: string): string[] {
  return l.db().all<{ type: string }>('SELECT type FROM events WHERE run_id = ? ORDER BY id', runId).map((e) => e.type);
}

describe('orbit pause and resume', () => {
  it('pauses and unpauses durably', async () => {
    const l = lab();
    const run = l.newRun();
    l.moveTo(run.id, ['PREFLIGHT']);
    const p = await l.cli(['pause', run.id]);
    expect(p.code, p.err).toBe(0);
    expect(p.out).toMatch(/paused at PREFLIGHT/);
    expect(getRun(l.db(), run.id).paused).toBe(true);
    const r = await l.cli(['resume', run.id]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/unpaused/);
    expect(r.out).toMatch(/No controller is running/);
    expect(getRun(l.db(), run.id).paused).toBe(false);
    expect(events(l, run.id)).toEqual(expect.arrayContaining(['run.paused', 'run.unpaused']));
  });

  it('will not pause or resume a finished run', async () => {
    const l = lab();
    const run = l.newRun();
    l.moveTo(run.id, ['CANCELLED']);
    expect((await l.cli(['pause', run.id])).code).toBe(5);
    const r = await l.cli(['resume', run.id]);
    expect(r.code).toBe(5);
    expect(r.err).toMatch(/CANCELLED; nothing to resume/);
  });

  it('resumes a BLOCKED run at the stage it stopped in, under a short CLI lease', async () => {
    const l = lab();
    const run = l.newRun();
    l.moveTo(run.id, ['PREFLIGHT', 'CONTRACTING', 'BLOCKED']);
    expect(getRun(l.db(), run.id)).toMatchObject({ state: 'BLOCKED', resumeState: 'CONTRACTING' });
    const r = await l.cli(['resume', run.id, '--json']);
    expect(r.code, r.err).toBe(0);
    const after = getRun(l.db(), run.id);
    expect(after.state).toBe('CONTRACTING');
    expect(after.endedAt).toBeNull();
    expect(after.resumeState).toBeNull();
    expect(getLease(l.db(), run.id)).toBeNull();
    expect(events(l, run.id)).toContain('run.resumed');
    expect((JSON.parse(r.out) as { actions: string[] }).actions[0]).toMatch(/resumed BLOCKED run at CONTRACTING/);
  });

  it('refuses to resume a BLOCKED run while a material question is unanswered, unless forced', async () => {
    const l = lab();
    const run = l.newRun();
    l.moveTo(run.id, ['PREFLIGHT', 'BLOCKED']);
    const q = l.ask(run.id);
    const refused = await l.cli(['resume', run.id]);
    expect(refused.code).toBe(5);
    expect(refused.err).toContain(q.id);
    expect(refused.err).toMatch(/orbit decide/);
    expect(getRun(l.db(), run.id).state).toBe('BLOCKED');
    const forced = await l.cli(['resume', run.id, '--force']);
    expect(forced.code, forced.err).toBe(0);
    expect(getRun(l.db(), run.id).state).toBe('PREFLIGHT');
  });

  it('does not take a run from a live controller', async () => {
    const l = lab();
    const run = l.newRun();
    l.moveTo(run.id, ['PREFLIGHT', 'BLOCKED']);
    acquireLease(l.db(), run.id, 'ctl-live', 60_000, systemClock);
    const r = await l.cli(['resume', run.id]);
    expect(r.code).toBe(5);
    expect(r.err).toMatch(/owned by a live controller \(ctl-live\)/);
    expect(getRun(l.db(), run.id).state).toBe('BLOCKED');
    releaseLease(l.db(), run.id, 'ctl-live');
  });

  it('will not resume a run that has a durable cancellation request', async () => {
    const l = lab();
    const run = l.newRun();
    l.moveTo(run.id, ['PREFLIGHT', 'BLOCKED']);
    l.db().run('UPDATE runs SET cancel_requested = 1 WHERE id = ?', run.id);
    const r = await l.cli(['resume', run.id]);
    expect(r.code).toBe(5);
    expect(r.err).toMatch(/durable cancellation request/);
  });
});

describe('orbit cancel', () => {
  it('cancels an unowned BLOCKED run by taking a short lease, and writes its report', async () => {
    const l = lab();
    const run = l.newRun();
    l.moveTo(run.id, ['PREFLIGHT', 'BLOCKED']);
    const r = await l.cli(['cancel', run.id]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/cancelled \(the run was blocked and unowned\)/);
    const done = getRun(l.db(), run.id);
    expect(done.state).toBe('CANCELLED');
    expect(done.cancelRequested).toBe(true);
    expect(getLease(l.db(), run.id)).toBeNull();
    const md = join(dirname(run.policyPath), 'final.md');
    expect(existsSync(md)).toBe(true);
    expect(readFileSync(md, 'utf8')).toContain('CANCELLED');
    expect(events(l, run.id)).toEqual(expect.arrayContaining(['run.cancel-requested']));
  });

  it('is idempotent and leaves a finished run alone', async () => {
    const l = lab();
    const run = l.newRun();
    l.moveTo(run.id, ['CANCELLED']);
    const r = await l.cli(['cancel', run.id]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/already CANCELLED; nothing to cancel/);
  });

  it('records the request durably and leaves a live owner to end the run', async () => {
    const l = lab();
    const run = l.newRun();
    l.moveTo(run.id, ['PREFLIGHT']);
    acquireLease(l.db(), run.id, 'ctl-live', 60_000, systemClock);
    const r = await l.cli(['cancel', run.id], { seams: { pollMs: 10 } });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/cancellation recorded; the controller that owns the run ends it at its next safe point/);
    const after = getRun(l.db(), run.id);
    expect(after).toMatchObject({ state: 'PREFLIGHT', cancelRequested: true });
    expect(getLease(l.db(), run.id)?.ownerId).toBe('ctl-live');
    // From here no controller can steer the run anywhere but CANCELLED.
    expect(() => transition(l.db(), { runId: run.id, to: 'CONTRACTING', ownerId: 'ctl-live', reason: 'x' }, systemClock)).toThrow(OrbitError);
    try {
      transition(l.db(), { runId: run.id, to: 'CONTRACTING', ownerId: 'ctl-live', reason: 'x' }, systemClock);
    } catch (err) {
      expect((err as OrbitError).code).toBe('CANCELLED');
    }
    const waited = await l.cli(['cancel', run.id, '--wait', '1'], { seams: { pollMs: 10 } });
    expect(waited.out).toMatch(/cancellation recorded/);
    releaseLease(l.db(), run.id, 'ctl-live');
  });

  it('ends a working run whose controller is gone, even with no usable configuration', async () => {
    const l = lab();
    const run = l.newRun();
    l.moveTo(run.id, ['PREFLIGHT', 'CONTRACTING']);
    const r = await l.cli(['cancel', run.id, '--json']);
    expect(r.code, r.err).toBe(0);
    expect(getRun(l.db(), run.id).state).toBe('CANCELLED');
    expect(JSON.parse(r.out)).toMatchObject({ state: 'CANCELLED', cancel_requested: true });
  });
});

describe('orbit decide and questions', () => {
  it('records a person\'s answer as a decision and releases what it blocks', async () => {
    const l = lab();
    const run = l.newRun();
    l.moveTo(run.id, ['PREFLIGHT', 'BLOCKED']);
    const q = l.ask(run.id);
    const list = await l.cli(['questions', run.id]);
    expect(list.out).toContain(q.id);
    expect(list.out).toMatch(/A\) return the exact product/);
    expect(list.out).toMatch(/recommended: A/);
    expect(list.out).toMatch(/blocks: AC-1/);
    const r = await l.cli(['decide', run.id, q.id, 'b', '--json']);
    expect(r.code, r.err).toBe(0);
    const j = JSON.parse(r.out) as { chosen_option: string; decision_id: string; unblocks: string[]; open_questions: string[]; run_state: string };
    expect(j).toMatchObject({ chosen_option: 'B', unblocks: ['AC-1'], open_questions: [], run_state: 'BLOCKED' });
    const decisions = listDecisions(l.db(), run.id, { kind: 'inquisition.answer' });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.data).toMatchObject({ answered_by: 'alice', chosen_option: 'B' });
    // The decisions.jsonl mirror carries it too.
    expect(readFileSync(join(dirname(run.policyPath), 'decisions.jsonl'), 'utf8')).toContain('inquisition.answer');
    expect((await l.cli(['questions', run.id])).out).toMatch(/no open questions/);
    expect((await l.cli(['questions', run.id, '--all'])).out).toMatch(/answered by alice/);
  });

  it('accepts free text, a question id prefix, an answer from stdin, and a repeat of the same answer', async () => {
    const l = lab();
    const run = l.newRun();
    const q = l.ask(run.id, { id: 'q-abcdef123456' });
    const free = await l.cli(['decide', run.id, 'q-abcd', 'keep', 'the', 'exact', 'product', 'and', 'document', 'it']);
    expect(free.code, free.err).toBe(0);
    expect(free.out).toMatch(/free-text answer by alice/);
    const again = await l.cli(['decide', run.id, q.id, 'keep', 'the', 'exact', 'product', 'and', 'document', 'it']);
    expect(again.code, again.err).toBe(0);
    const other = await l.cli(['decide', run.id, q.id, 'something', 'else']);
    expect(other.code).toBe(5);
    const q2 = l.ask(run.id, { id: 'q-second' });
    const viaStdin = await l.cli(['decide', run.id, q2.id, '-'], {}, 'round to cents\n');
    expect(viaStdin.code, viaStdin.err).toBe(0);
    expect(l.db().get<{ answer: string }>('SELECT answer FROM questions WHERE id = ?', q2.id)?.answer).toBe('round to cents');
  });

  it('refuses answers from a model, a worker or a subsystem', async () => {
    const l = lab();
    const run = l.newRun();
    const q = l.ask(run.id);
    for (const by of ['claude', 'implementer', 'controller', 'orbit']) {
      const r = await l.cli(['decide', run.id, q.id, 'A', '--by', by]);
      expect(r.code, by).toBe(4);
      expect(r.err).toMatch(/cannot answer a question/);
    }
    expect(l.db().get<{ status: string }>('SELECT status FROM questions WHERE id = ?', q.id)?.status).toBe('open');
  });

  it('says what exists when the question is not the run\'s', async () => {
    const l = lab();
    const a = l.newRun('one');
    const b = l.newRun('two');
    const q = l.ask(a.id);
    const r = await l.cli(['decide', b.id, q.id, 'A']);
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/has no question/);
    const miss = await l.cli(['decide', a.id, 'q-none', 'A']);
    expect(miss.err).toContain(q.id);
    const usage = await l.cli(['decide', a.id]);
    expect(usage.code).toBe(2);
  });

  it('does not take answers for a run that already finished', async () => {
    const l = lab();
    const run = l.newRun();
    const q = l.ask(run.id);
    l.moveTo(run.id, ['CANCELLED']);
    const r = await l.cli(['decide', run.id, q.id, 'A']);
    expect(r.code).toBe(5);
  });
});
