import { afterEach, describe, expect, it } from 'vitest';
import { acquireLease } from '../../../src/controller/run-store.ts';
import { frozenPolicySetting, resumeAnsweredRun } from '../../../src/controller/resume.ts';
import { answerQuestion } from '../../../src/inquisition/questions.ts';
import { RUN, addQuestion, setState, setup, type NotifyEnv } from '../notify/helpers.ts';

const envs: NotifyEnv[] = [];
afterEach(() => envs.splice(0).forEach((e) => e.cleanup()));
function blocked(): NotifyEnv {
  const env = setup();
  envs.push(env);
  setState(env, 'BLOCKED', 'waiting for an answer', env.clock.now());
  return env;
}

describe('resuming a run after a remote answer (ADR 0008)', () => {
  it('resumes a BLOCKED run once no material question is open, and records who resumed it', () => {
    const env = blocked();
    const q = addQuestion(env);
    expect(resumeAnsweredRun(env.db, env.clock, RUN, 'svc-1', 'svc-1', 'resumed after a remote answer')).toBeNull();
    answerQuestion(env.db, env.runDir, q.id, 'A', 'acme', env.clock);
    expect(resumeAnsweredRun(env.db, env.clock, RUN, 'svc-1', 'svc-1', 'resumed after a remote answer')).toBe('PREFLIGHT');
    expect(env.run().state).toBe('PREFLIGHT');
    const ev = env.db.get<{ actor: string; data_json: string }>("SELECT actor, data_json FROM events WHERE run_id = ? AND type = 'run.resumed'", RUN)!;
    expect(ev.actor).toBe('svc-1');
    expect(JSON.parse(ev.data_json)).toEqual({ from: 'BLOCKED', to: 'PREFLIGHT', forced: false, by: 'remote-answer' });
    // The lease is given back for the controller that claims the run next.
    expect(env.db.get('SELECT 1 AS x FROM leases WHERE run_id = ?', RUN)).toBeUndefined();
  });

  it('a non-material open question does not hold the run', () => {
    const env = blocked();
    addQuestion(env, { material: false });
    expect(resumeAnsweredRun(env.db, env.clock, RUN, 'svc-1', 'svc-1', 'r')).toBe('PREFLIGHT');
  });

  it('never resumes a frozen-policy block, a run with a cancellation request, a run that is not BLOCKED, or one another owner holds', () => {
    const frozen = blocked();
    frozen.db.run('UPDATE runs SET outcome_json = ? WHERE id = ?', JSON.stringify({ frozen_policy: { setting: 'mode' } }), RUN);
    expect(frozenPolicySetting(frozen.run())).toBe('mode');
    expect(resumeAnsweredRun(frozen.db, frozen.clock, RUN, 'svc-1', 'svc-1', 'r')).toBeNull();

    const cancelled = blocked();
    cancelled.db.run('UPDATE runs SET cancel_requested = 1 WHERE id = ?', RUN);
    expect(resumeAnsweredRun(cancelled.db, cancelled.clock, RUN, 'svc-1', 'svc-1', 'r')).toBeNull();

    const running = blocked();
    setState(running, 'IMPLEMENTING');
    expect(resumeAnsweredRun(running.db, running.clock, RUN, 'svc-1', 'svc-1', 'r')).toBeNull();

    const held = blocked();
    acquireLease(held.db, RUN, 'someone-else', 60_000, held.clock);
    expect(resumeAnsweredRun(held.db, held.clock, RUN, 'svc-1', 'svc-1', 'r')).toBeNull();
    expect(held.run().state).toBe('BLOCKED');
  });

  it('reads a frozen-policy setting without a name, and an outcome that is not JSON, safely', () => {
    const env = blocked();
    env.db.run('UPDATE runs SET outcome_json = ? WHERE id = ?', JSON.stringify({ frozen_policy: {} }), RUN);
    expect(frozenPolicySetting(env.run())).toBe('a policy setting');
    env.db.run("UPDATE runs SET outcome_json = '{not json' WHERE id = ?", RUN);
    expect(frozenPolicySetting(env.run())).toBeNull();
  });
});
