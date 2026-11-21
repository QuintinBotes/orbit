import { describe, expect, it } from 'vitest';
import { renderIssueComment, type IssueCommentInput } from '../../../src/intake/comment.ts';
import { PAYLOAD_SCHEMA } from '../../../src/notify/payload.ts';

const scenarios = ['S1-1', 'S1-2', 'S2-1'].map((key) => ({ key, story: Number(key[1]), story_title: 't', statement: 's' }));

function comment(criteria: { id: string; status: string }[], kind: 'spec' | 'bug' = 'spec'): string {
  const input: IssueCommentInput = {
    payload: { schema: PAYLOAD_SCHEMA, kind: 'run.ended', run_id: 'orb-1', state: 'SUCCEEDED', reason: null, next_action: 'Nothing to do.', question_ids: [] },
    goal: { kind, number: 42, body_sha256: 'ab'.repeat(32), updated_at: '2026-11-01T10:00:00Z', scenarios: kind === 'bug' ? [] : scenarios },
    run: { state: 'SUCCEEDED', failureClass: null, failureSecondary: null },
    report: { criteria },
    now: null,
  };
  return renderIssueComment(input);
}

describe('the issue comment names each criterion by its scenario', () => {
  it('#195: after an approved remove_criterion the remaining criteria keep their own scenarios', () => {
    // AC-1 (S1-1) was removed by an amendment; the draft's ids are never renumbered.
    const body = comment([
      { id: 'AC-2', status: 'supported' },
      { id: 'AC-3', status: 'supported' },
      { id: 'AC-4', status: 'supported' },
    ]);
    expect(body).toContain('- AC-2 (S1-2): supported');
    expect(body).toContain('- AC-3 (S2-1): supported');
    // A criterion past the issue's scenarios (one the planner or an amendment added) names none.
    expect(body).toContain('- AC-4: supported');
  });

  it('names the reproduction only on AC-1 of a bug', () => {
    expect(comment([{ id: 'AC-1', status: 'supported' }, { id: 'AC-2', status: 'supported' }], 'bug')).toContain('- AC-1 (reproduction): supported\n- AC-2: supported');
    expect(comment([{ id: 'AC-2', status: 'supported' }], 'bug')).toContain('- AC-2: supported');
  });
});
