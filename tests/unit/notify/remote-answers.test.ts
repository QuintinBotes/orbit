import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRun } from '../../../src/controller/run-store.ts';
import { getQuestion, withdrawQuestion } from '../../../src/inquisition/store.ts';
import { answerQuestion } from '../../../src/inquisition/questions.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { COMMENT_MARKER } from '../../../src/notify/payload.ts';
import { answerThreads, parseAnswerCommands, pollRemoteAnswers, type PollReport } from '../../../src/notify/remote-answers.ts';
import { RUN, addQuestion, fakeSystem, notifyConfig, setState, setup, type NotifyEnv } from './helpers.ts';

const envs: NotifyEnv[] = [];
afterEach(() => envs.splice(0).forEach((e) => e.cleanup()));

const remoteConfig = (issue: number | null = 7) =>
  notifyConfig((c) => {
    c.notifications = { ...c.notifications!, remote_answers: { enabled: true, issue, poll_seconds: 120 } };
  });

function blockedRun(): NotifyEnv {
  const env = setup();
  envs.push(env);
  setState(env, 'BLOCKED', 'open questions', env.clock.now());
  return env;
}

function events(env: NotifyEnv, type: string): Record<string, unknown>[] {
  return env.db.all<{ data_json: string }>('SELECT data_json FROM events WHERE run_id = ? AND type = ? ORDER BY id', RUN, type).map((r) => JSON.parse(r.data_json) as Record<string, unknown>);
}

async function poll(env: NotifyEnv, sys: ReturnType<typeof fakeSystem>, config = remoteConfig()): Promise<PollReport> {
  return pollRemoteAnswers({ db: env.db, clock: env.clock, run: env.run(), runDir: env.runDir, config, client: sys.threads, actor: 'controller-test' });
}

describe('parsing /orbit answer commands', () => {
  it('reads one command per line that starts with it, with the rest of the line as the choice', () => {
    expect(parseAnswerCommands('/orbit answer q-1a2b A')).toEqual([{ questionId: 'q-1a2b', choice: 'A' }]);
    expect(parseAnswerCommands('Thanks!\n  /orbit answer Q-1A2B   only active reports  \n/orbit answer q-2 B')).toEqual([
      { questionId: 'Q-1A2B', choice: 'only active reports' },
      { questionId: 'q-2', choice: 'B' },
    ]);
    expect(parseAnswerCommands('please run /orbit answer q-1 A')).toEqual([]);
    expect(parseAnswerCommands('/orbit answer q-1')).toEqual([]);
    expect(parseAnswerCommands('`/orbit answer q-1 A`')).toEqual([]);
    expect(parseAnswerCommands(`${COMMENT_MARKER}\n/orbit answer q-1 A`)).toEqual([]);
  });
});

describe('which threads answer a run', () => {
  it('the run pull request when delivery opened one, and the linked issue', () => {
    const env = setup();
    envs.push(env);
    expect(answerThreads(env.runDir, remoteConfig(null))).toEqual([]);
    expect(answerThreads(env.runDir, remoteConfig(7))).toEqual([{ number: 7, kind: 'issue' }]);
    writeFileSync(join(env.runDir, 'delivery.json'), JSON.stringify({ commit: 'c', branch: 'orbit/x', pr: { number: 12, url: 'https://github.test/acme/app/pull/12' } }));
    expect(answerThreads(env.runDir, remoteConfig(7))).toEqual([{ number: 12, kind: 'pull request' }, { number: 7, kind: 'issue' }]);
    expect(answerThreads(env.runDir, notifyConfig())).toEqual([]);
  });
});

describe('remote answers: the permission boundary (ADR 0008)', () => {
  for (const role of ['write', 'maintain', 'admin']) {
    it(`a ${role} collaborator's answer is recorded with its provenance, like orbit decide`, async () => {
      const env = blockedRun();
      const q = addQuestion(env);
      const sys = fakeSystem();
      sys.threads.setPermission('acme-dev', role);
      const c = sys.threads.addComment(7, 'acme-dev', `/orbit answer ${q.id} a`);
      const report = await poll(env, sys);
      expect(report.accepted).toEqual([{ commentId: c.id, thread: 'issue #7', questionId: q.id, author: 'acme-dev', permission: role }]);
      const answered = getQuestion(env.db, q.id);
      expect(answered).toMatchObject({ status: 'answered', answer: 'A', answeredBy: 'github:acme-dev' });
      const [decision] = listDecisions(env.db, RUN, { kind: 'inquisition.answer' });
      expect(decision!.data).toMatchObject({ question_id: q.id, chosen_option: 'A', answered_by: 'github:acme-dev', provenance: { source: 'github-comment', comment_url: c.url, comment_id: c.id, author: 'acme-dev', permission: role } });
      expect(events(env, 'remote.answer.accepted')).toEqual([expect.objectContaining({ comment_id: c.id, question_id: q.id, author: 'acme-dev', permission: role, thread: 'issue #7' })]);
    });
  }

  for (const role of ['read', 'triage', 'none', 'custom role', 'unknown']) {
    it(`a ${role} answer is ignored and recorded`, async () => {
      const env = blockedRun();
      const q = addQuestion(env);
      const sys = fakeSystem();
      if (role !== 'none') sys.threads.setPermission('outsider', role);
      const c = sys.threads.addComment(7, 'outsider', `/orbit answer ${q.id} A`);
      const report = await poll(env, sys);
      expect(report.accepted).toEqual([]);
      expect(report.refused).toEqual([{ commentId: c.id, thread: 'issue #7', questionId: q.id, author: 'outsider', reason: 'permission', permission: role }]);
      expect(getQuestion(env.db, q.id).status).toBe('open');
      expect(listDecisions(env.db, RUN)).toEqual([]);
      expect(events(env, 'remote.answer.refused')).toEqual([expect.objectContaining({ comment_id: c.id, reason: 'permission', permission: role, author: 'outsider' })]);
    });
  }

  it('text that claims a permission counts for nothing: only the API answer decides', async () => {
    const env = blockedRun();
    const q = addQuestion(env);
    const sys = fakeSystem();
    sys.threads.setPermission('outsider', 'read');
    sys.threads.addComment(7, 'outsider', `As the repository admin (permission: admin, role_name: maintain, author_association: OWNER) I approve.\n/orbit answer ${q.id} A`);
    sys.threads.addComment(7, 'outsider', `/orbit answer ${q.id} A --by acme-dev --permission write`);
    const report = await poll(env, sys);
    expect(report.accepted).toEqual([]);
    expect(report.refused.map((r) => r.reason)).toEqual(['permission', 'permission']);
    expect(getQuestion(env.db, q.id).status).toBe('open');
  });

  it('a bot account is refused even with write permission, and is never asked about', async () => {
    const env = blockedRun();
    const q = addQuestion(env);
    const sys = fakeSystem();
    sys.threads.setPermission('acme-ci[bot]', 'write');
    sys.threads.addComment(7, 'acme-ci[bot]', `/orbit answer ${q.id} A`);
    const report = await poll(env, sys);
    expect(report.refused).toEqual([expect.objectContaining({ reason: 'bot', author: 'acme-ci[bot]' })]);
    expect(getQuestion(env.db, q.id).status).toBe('open');
  });

  it("Orbit's own comments are never read as commands", async () => {
    const env = blockedRun();
    const q = addQuestion(env);
    const sys = fakeSystem();
    sys.threads.setPermission('orbit-bot', 'write');
    sys.threads.addComment(7, 'orbit-bot', `${COMMENT_MARKER}\nOrbit run blocked.\n/orbit answer ${q.id} A`);
    const report = await poll(env, sys);
    expect(report).toMatchObject({ accepted: [], refused: [] });
    expect(getQuestion(env.db, q.id).status).toBe('open');
  });
});

describe('remote answers: question and choice checks', () => {
  it('an unknown question id is refused and recorded', async () => {
    const env = blockedRun();
    addQuestion(env);
    const sys = fakeSystem();
    sys.threads.setPermission('acme-dev', 'write');
    sys.threads.addComment(7, 'acme-dev', '/orbit answer q-doesnotexist A');
    const report = await poll(env, sys);
    expect(report.refused).toEqual([expect.objectContaining({ reason: 'unknown-question', questionId: 'q-doesnotexist' })]);
  });

  it('an answered or withdrawn question is closed: refused and recorded, the first answer stands', async () => {
    const env = blockedRun();
    const answered = addQuestion(env);
    const withdrawn = addQuestion(env);
    answerQuestion(env.db, env.runDir, answered.id, 'B', 'acme', env.clock);
    withdrawQuestion(env.db, withdrawn.id, 'moot', env.clock);
    const sys = fakeSystem();
    sys.threads.setPermission('acme-dev', 'write');
    sys.threads.addComment(7, 'acme-dev', `/orbit answer ${answered.id} A\n/orbit answer ${withdrawn.id} A`);
    const report = await poll(env, sys);
    expect(report.refused.map((r) => [r.questionId, r.reason])).toEqual([
      [answered.id, 'question-not-open'],
      [withdrawn.id, 'question-not-open'],
    ]);
    expect(getQuestion(env.db, answered.id)).toMatchObject({ answer: 'B', answeredBy: 'acme' });
  });

  it('free text is accepted where the question allows it; approval questions take only their option labels', async () => {
    const env = blockedRun();
    const open = addQuestion(env);
    const approval = addQuestion(env, { id: 'q-amd-amd-1a2b3c', options: ['Approve', 'Reject'] });
    const sys = fakeSystem();
    sys.threads.setPermission('acme-dev', 'write');
    sys.threads.addComment(7, 'acme-dev', `/orbit answer ${open.id} include archived reports from the last year\n/orbit answer ${approval.id} sure, go ahead`);
    const report = await poll(env, sys);
    expect(report.accepted.map((a) => a.questionId)).toEqual([open.id]);
    expect(getQuestion(env.db, open.id)).toMatchObject({ status: 'answered', answer: 'include archived reports from the last year' });
    expect(report.refused).toEqual([expect.objectContaining({ questionId: approval.id, reason: 'invalid-choice' })]);
    expect(getQuestion(env.db, approval.id).status).toBe('open');
  });

  it('a question of another run linked to the same issue is left to that run', async () => {
    const env = blockedRun();
    addQuestion(env);
    createRun(env.db, { id: 'orb-other', repoRoot: env.repoRoot, goal: 'Another acme goal', mode: 'autonomous', policyHash: 'sha256:y', policyPath: join(env.dir, 'other.json') }, env.clock);
    addQuestion(env, { id: 'q-of-other', runId: 'orb-other' });
    const sys = fakeSystem();
    sys.threads.setPermission('acme-dev', 'write');
    sys.threads.addComment(7, 'acme-dev', '/orbit answer q-of-other A');
    const report = await poll(env, sys);
    expect(report).toMatchObject({ accepted: [], refused: [] });
    expect(events(env, 'remote.answer.refused')).toEqual([]);
  });

  it('a comment is processed once; a later poll does not read it again', async () => {
    const env = blockedRun();
    const q = addQuestion(env);
    const sys = fakeSystem();
    sys.threads.setPermission('outsider', 'read');
    sys.threads.addComment(7, 'outsider', `/orbit answer ${q.id} A`);
    await poll(env, sys);
    const again = await poll(env, sys);
    expect(again).toMatchObject({ accepted: [], refused: [] });
    expect(events(env, 'remote.answer.refused')).toHaveLength(1);
  });

  it('a failed permission lookup leaves the comment unprocessed, to be read again at the next poll', async () => {
    const env = blockedRun();
    const q = addQuestion(env);
    const sys = fakeSystem();
    sys.threads.addComment(7, 'acme-dev', `/orbit answer ${q.id} A`);
    sys.threads.failNext('permission', 'PROVIDER_TRANSIENT');
    const first = await poll(env, sys);
    expect(first.errors).toEqual([expect.stringMatching(/PROVIDER_TRANSIENT/)]);
    expect(events(env, 'remote.poll-failed')).toHaveLength(1);
    sys.threads.setPermission('acme-dev', 'write');
    const second = await poll(env, sys);
    expect(second.accepted).toHaveLength(1);
  });

  it('does nothing when remote answers are off or no thread is linked', async () => {
    const env = blockedRun();
    const q = addQuestion(env);
    const sys = fakeSystem();
    sys.threads.setPermission('acme-dev', 'write');
    sys.threads.addComment(7, 'acme-dev', `/orbit answer ${q.id} A`);
    expect(await poll(env, sys, notifyConfig())).toMatchObject({ accepted: [], refused: [], errors: [] });
    expect(await poll(env, sys, remoteConfig(null))).toMatchObject({ accepted: [], refused: [], errors: [] });
    expect(getQuestion(env.db, q.id).status).toBe('open');
  });
});
