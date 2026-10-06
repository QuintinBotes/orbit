import { describe, expect, it } from 'vitest';
import type { RunRecord } from '../../../src/controller/run-store.ts';
import { buildPayload, COMMENT_MARKER, commentBody, payloadText, REASON_MAX, sanitizeReason, testPayload } from '../../../src/notify/payload.ts';

const RUN: Pick<RunRecord, 'id' | 'state' | 'outcomeReason' | 'branch' | 'mode'> = { id: 'orb-20261006-101500-a1b2c3', state: 'BLOCKED', outcomeReason: 'contract change needs a decision; open questions: q-1a2b3c', branch: 'orbit/orb-20261006-101500-a1b2c3', mode: 'autonomous-delivery' };
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

describe('notification payload (ADR 0008)', () => {
  it('carries the run id, state, reason, next action and question ids, and nothing else', () => {
    const p = buildPayload({ kind: 'run.ended', run: RUN, questionIds: ['q-1a2b3c'], pullRequest: 12, remote: null });
    expect(Object.keys(p).sort()).toEqual(['kind', 'next_action', 'question_ids', 'reason', 'run_id', 'schema', 'state']);
    expect(p).toMatchObject({ schema: 'orbit.notification/1', kind: 'run.ended', run_id: RUN.id, state: 'BLOCKED', question_ids: ['q-1a2b3c'] });
    expect(p.reason).toBe(RUN.outcomeReason);
    expect(p.next_action).toContain(`orbit decide ${RUN.id} q-1a2b3c`);
  });

  it('never carries code, a diff, a secret or a log excerpt from the outcome reason', () => {
    const reason = [`VERIFYING failed 3 time(s); last error INTERNAL: push refused with token ${TOKEN}`, 'diff --git a/apps/x.ts b/apps/x.ts', '+export const secret = 1;', '    at Object.<anonymous> (/repo/acme/apps/x.ts:3:9)'].join('\n');
    const p = buildPayload({ kind: 'run.ended', run: { ...RUN, state: 'BLOCKED', outcomeReason: reason }, questionIds: [], pullRequest: null, remote: null });
    const all = JSON.stringify(p) + payloadText(p) + commentBody(p);
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain('diff --git');
    expect(all).not.toContain('export const secret');
    expect(all).not.toContain('Object.<anonymous>');
    expect(p.reason!.length).toBeLessThanOrEqual(REASON_MAX);
    expect(p.reason).toMatch(/^VERIFYING failed 3 time\(s\)/);
  });

  it('cuts the reason before a code fence or a diff hunk on the first line', () => {
    expect(sanitizeReason('the check failed: ```const a = 1;``` and more')).toBe('the check failed');
    expect(sanitizeReason('patch rejected @@ -1,3 +1,4 @@ const a')).toBe('patch rejected');
    expect(sanitizeReason(null)).toBeNull();
    expect(sanitizeReason('   ')).toBeNull();
    expect(sanitizeReason('x'.repeat(500))).toHaveLength(REASON_MAX);
  });

  it('names a next action per state from a fixed template', () => {
    const at = (state: string, extra: Partial<typeof RUN> = {}, pr: number | null = null) =>
      buildPayload({ kind: 'run.ended', run: { ...RUN, ...extra, state: state as typeof RUN.state }, questionIds: [], pullRequest: pr, remote: null }).next_action;
    expect(at('SUCCEEDED', {}, 7)).toBe('Review pull request #7 and merge it if you accept it.');
    expect(at('SUCCEEDED', { mode: 'autonomous' })).toBe(`Inspect branch ${RUN.branch} and merge it yourself if you accept it.`);
    expect(at('SUCCEEDED', { mode: 'autonomous', branch: null })).toContain(`orbit/${RUN.id}`);
    expect(at('BLOCKED')).toBe(`Resolve the block, then run orbit resume ${RUN.id}.`);
    expect(at('EXHAUSTED')).toBe(`Read orbit report ${RUN.id}, then continue by hand or start a new run.`);
    expect(at('IMPOSSIBLE')).toBe(`Read orbit report ${RUN.id}; revise the goal or the authorization before trying again.`);
    expect(at('CANCELLED')).toBe('Nothing further: the run was cancelled.');
    expect(at('IMPLEMENTING')).toBe(`Follow it with orbit status ${RUN.id}.`);
  });

  it('a question notification names how to answer, remotely too when remote answers are on', () => {
    const p = buildPayload({ kind: 'question.open', run: { ...RUN, state: 'BLOCKED' }, questionIds: ['q-1', 'q-2'], pullRequest: 3, remote: { where: 'pull request #3' } });
    expect(p.kind).toBe('question.open');
    expect(p.next_action).toBe(`Answer with orbit decide ${RUN.id} q-1 <answer>, or comment "/orbit answer q-1 <choice>" on pull request #3.`);
  });

  it('the text form is one short message and the comment form carries the marker Orbit uses to skip its own comments', () => {
    const p = buildPayload({ kind: 'run.ended', run: RUN, questionIds: ['q-1a2b3c'], pullRequest: null, remote: null });
    expect(payloadText(p)).toBe(`Orbit run ${RUN.id} is BLOCKED: ${RUN.outcomeReason}. ${p.next_action} Open questions: q-1a2b3c.`);
    const body = commentBody(p);
    expect(body.startsWith(COMMENT_MARKER)).toBe(true);
    // Instructions never start a line with the command, so they are never read back as one.
    expect(body.split('\n').some((l) => /^\s*\/orbit answer/.test(l))).toBe(false);
  });

  it('a test payload has no run', () => {
    const p = testPayload();
    expect(p).toMatchObject({ kind: 'test', run_id: null, state: null, question_ids: [] });
    expect(payloadText(p)).toBe('Orbit test notification: notifications reach you here.');
  });
});
