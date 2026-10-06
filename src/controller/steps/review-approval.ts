/**
 * review.when_unavailable: ask (issue #6, docs/decisions/0007-reviewer-availability.md). When no independent
 * reviewer is usable, the run raises one material question, "no independent reviewer is usable: allow a
 * same-provider review for this run?", and blocks on it. Only a person's yes (inquisition/actors `isHumanActor`)
 * lets the same-provider review run; it is recorded as a decision naming who approved it, and every report says
 * the review was not independent. Any other answer, or an answer from a model or worker identity, keeps the run
 * blocked. One question per run: the answer covers the run's later candidates too.
 */
import { hashObject } from '../../core/hash.ts';
import { isHumanActor } from '../../inquisition/actors.ts';
import { findQuestion, insertQuestion, type QuestionRecord } from '../../inquisition/store.ts';
import { reviewerLabel, SAME_PROVIDER_APPROVED_KIND, type ReviewerSelected } from '../../review/select.ts';
import { getDecision } from '../../storage/decisions.ts';
import type { RunContext } from '../context.ts';
import { decide } from './common.ts';

export { SAME_PROVIDER_APPROVED_KIND };
export const ALLOW_SAME_PROVIDER = 'yes';
export const REFUSE_SAME_PROVIDER = 'no';

export type SameProviderApproval =
  | { state: 'approved'; questionId: string; by: string; decisionId: string }
  | { state: 'declined'; questionId: string; by: string | null }
  | { state: 'pending'; questionId: string };

export function sameProviderQuestionId(runId: string): string {
  return `q-review-fallback-${hashObject({ run: runId, ask: 'same-provider-review' }).slice(7, 19)}`;
}

export function sameProviderApprovalDecisionId(runId: string): string {
  return `dec-${runId}-review-same-provider-approved`;
}

function ask(ctx: RunContext, sel: ReviewerSelected): QuestionRecord {
  const id = sameProviderQuestionId(ctx.run.id);
  const why = sel.independentUnavailable ?? 'no independent reviewer was usable';
  return (
    findQuestion(ctx.db, id) ??
    insertQuestion(
      ctx.db,
      {
        id,
        runId: ctx.run.id,
        mode: 'decision-record',
        question: 'No independent reviewer is usable: allow a same-provider review for this run?',
        evidence: [why, `review.when_unavailable is ask, so the run asks before ${sel.provider}/${sel.model ?? 'default'} reviews the candidate in a separate session`],
        options: [
          {
            label: ALLOW_SAME_PROVIDER,
            description: `Let ${sel.provider}/${sel.model ?? 'default'} review this run's candidates in a separate reviewer session at the opus-class floor`,
            consequences: 'The run continues to review and delivery. The review is from the same provider as the implementer, so it is not independent, and every report says so and why.',
          },
          {
            label: REFUSE_SAME_PROVIDER,
            description: 'Do not review with the same provider; wait for an independent reviewer',
            consequences: 'The run stays blocked. Make the independent reviewer usable (orbit doctor shows why it is not) and start a new run, or cancel this one.',
          },
        ],
        changes: ['proof'],
        recommendation: { option: REFUSE_SAME_PROVIDER, reason: 'an independent reviewer is the stronger check; allow the same-provider review only when the change does not need one' },
        safeDefault: { exists: true, option: REFUSE_SAME_PROVIDER, reason: 'refusing keeps the run from delivering anything that only its own provider reviewed' },
        material: true,
        affected: ['review: same-provider review'],
        unblocked: [],
      },
      ctx.clock,
      'controller',
    )
  );
}

/** Where the person's answer stands; asks the question the first time. A yes is recorded once as a decision. */
export function sameProviderApproval(ctx: RunContext, sel: ReviewerSelected): SameProviderApproval {
  const q = ask(ctx, sel);
  if (q.status === 'open') return { state: 'pending', questionId: q.id };
  const by = q.answeredBy;
  if (q.status !== 'answered' || (q.answer ?? '').trim().toLowerCase() !== ALLOW_SAME_PROVIDER || !by || !isHumanActor(by)) return { state: 'declined', questionId: q.id, by };
  const decisionId = sameProviderApprovalDecisionId(ctx.run.id);
  if (!getDecision(ctx.db, decisionId)) {
    decide(ctx, {
      id: decisionId,
      kind: SAME_PROVIDER_APPROVED_KIND,
      summary: `${by} approved a same-provider review for this run (question ${q.id}): ${reviewerLabel(sel)}`,
      data: { question_id: q.id, approved_by: by, provider: sel.provider, model: sel.model, independent_unavailable: sel.independentUnavailable ?? null },
    });
  }
  return { state: 'approved', questionId: q.id, by, decisionId };
}
