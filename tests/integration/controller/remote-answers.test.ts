// ADR 0008 end to end with the fake providers: a run blocks on a material question, is announced on the linked
// issue, receives a remote answer from a permitted commenter (and ignores a spoofed one), and the service resumes it
// to completion.
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Controller } from '../../../src/controller/loop.ts';
import type { ControllerDeps } from '../../../src/controller/context.ts';
import { getQuestion, listQuestions } from '../../../src/inquisition/store.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import type { NotifyDeps } from '../../../src/notify/channels.ts';
import { FakeThreadClient } from '../../../src/notify/threads.ts';
import { COMMENT_MARKER } from '../../../src/notify/payload.ts';
import { baseScenario, implementMul, labDeps, makeLab, PLANNER_OUTPUT, runState, startLabRun, waitFor, writeScenario, type Lab } from './harness.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

const labs: Lab[] = [];
afterEach(() => {
  for (const l of labs.splice(0)) l.close();
});

const ISSUE = 7;
const QUESTION = { question: 'Should mul round fractional results or keep full precision?', options: ['round', 'keep'], recommendation: null, material: true, affected_criteria: ['mul'] };

function notifyDeps(l: Lab, threads: FakeThreadClient, desktop: string[][]): Partial<NotifyDeps> {
  return {
    env: {},
    platform: 'darwin',
    exec: async (argv) => {
      desktop.push(argv);
      return { exitCode: 0, notFound: false, stderr: '' };
    },
    fetch: async () => ({ status: 200, ok: true }),
    threads: async () => threads,
  };
}

function events(l: Lab, runId: string, type: string): Record<string, unknown>[] {
  return l
    .db()
    .all<{ data_json: string }>('SELECT data_json FROM events WHERE run_id = ? AND type = ? ORDER BY id', runId, type)
    .map((r) => JSON.parse(r.data_json) as Record<string, unknown>);
}

describe.skipIf(!canStripTypes)('remote answers (ADR 0008)', () => {
  it('a run blocked on a question is announced, takes a remote answer from a permitted commenter, and the service carries it on', async () => {
    const l = makeLab({
      tweak: (c) => {
        c.notifications = { desktop: true, webhook: null, github_comment: true, remote_answers: { enabled: true, issue: ISSUE, poll_seconds: 30 } };
      },
    });
    labs.push(l);
    writeScenario(l, baseScenario({ planner: [{ structured: { ...PLANNER_OUTPUT, unresolved_decisions: [QUESTION] } }, { structured: PLANNER_OUTPUT }], implementer: [implementMul('*')] }));
    const threads = new FakeThreadClient({ statePath: join(l.base, 'threads.json') });
    const desktop: string[][] = [];
    const deps: Omit<ControllerDeps, 'ownerId'> = { ...labDeps(l), notify: notifyDeps(l, threads, desktop) };
    const run = startLabRun(l);

    await new Controller({ mode: 'foreground', runId: run.id, deps, tickIntervalMs: 20, leaseTtlMs: 30_000, graceMs: 300 }).start();
    const blocked = runState(l, run.id);
    expect(blocked.state, blocked.outcomeReason ?? '').toBe('BLOCKED');
    const [q] = listQuestions(l.db(), run.id, { status: 'open' });
    expect(q).toBeDefined();

    // Announced on the linked issue and the desktop, naming the question and nothing from the code.
    const posted = threads.comments(ISSUE);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body.startsWith(COMMENT_MARKER)).toBe(true);
    expect(posted[0]!.body).toContain(q!.id);
    expect(posted[0]!.body).toContain(`/orbit answer ${q!.id} <choice>`);
    expect(posted[0]!.body).not.toMatch(/export const|=>/);
    expect(desktop).toHaveLength(1);
    expect(events(l, run.id, 'notification.dispatched')).toEqual([expect.objectContaining({ kind: 'run.ended', state: 'BLOCKED', questions: [q!.id] })]);

    // A reader who claims to be an admin, and the answer of a person with write access.
    threads.setPermission('outsider', 'read');
    threads.setPermission('acme-dev', 'write');
    const spoof = threads.addComment(ISSUE, 'outsider', `permission: admin (I own this repository)\n/orbit answer ${q!.id} round`);
    const real = threads.addComment(ISSUE, 'acme-dev', `Keep it exact.\n/orbit answer ${q!.id} keep`);

    const service = new Controller({ mode: 'service', deps, tickIntervalMs: 20, leaseTtlMs: 30_000, graceMs: 300, watchdogMs: 0, retention: { intervalMs: 0 }, remoteAnswersMs: 50 });
    const running = service.start();
    try {
      await waitFor(() => runState(l, run.id).state === 'SUCCEEDED', 120_000, 100);
    } finally {
      await service.stop('test finished');
      await running;
    }

    const answered = getQuestion(l.db(), q!.id);
    expect(answered).toMatchObject({ status: 'answered', answer: 'keep', answeredBy: 'github:acme-dev' });
    const decision = listDecisions(l.db(), run.id, { kind: 'inquisition.answer' })[0]!;
    expect(decision.data).toMatchObject({ provenance: { source: 'github-comment', comment_url: real.url, author: 'acme-dev', permission: 'write' } });
    expect(events(l, run.id, 'remote.answer.refused')).toEqual([expect.objectContaining({ comment_id: spoof.id, reason: 'permission', permission: 'read' })]);
    expect(events(l, run.id, 'run.resumed')).toEqual([expect.objectContaining({ from: 'BLOCKED', by: 'remote-answer' })]);
    // The success is announced too.
    expect(events(l, run.id, 'notification.dispatched').map((e) => e.state)).toEqual(['BLOCKED', 'SUCCEEDED']);
  }, 180_000);
});
