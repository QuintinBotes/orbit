import type { KnowledgeStore } from './store.ts';
import type { EvidenceRef, Lesson, LessonStats, LessonStatus } from './types.ts';

/**
 * Feedback: when a run settles, the lessons it was shown gain support or a
 * contradiction, and the promotion rules below decide status changes.
 *
 * The rules are explicit and ordered so every status change can be explained
 * by one rule id, which is recorded with the change.
 */

export const PROMOTION_RULES = {
  /** Distinct runs whose evidence supports a candidate before it is validated. */
  minSupportingRuns: 2,
  /** Contradictions a candidate may have and still be validated. */
  maxContradictionsToValidate: 0,
} as const;

export type StatusRule = 'deprecate.contradictions-exceed-support' | 'promote.supported-by-distinct-runs';

export interface StatusDecision {
  status: LessonStatus;
  rule: StatusRule;
}

/**
 * The status a lesson should move to given its stats, or null to stay.
 *
 *   1. rejected and deprecated are final here; reviving one takes a new lesson
 *      that supersedes it.
 *   2. contradictions (distinct runs) > support (distinct runs): deprecated,
 *      from candidate or validated.
 *   3. candidate with support from >= 2 distinct runs and no contradiction:
 *      validated.
 *   4. otherwise unchanged. A validated lesson with some contradictions that
 *      do not outnumber its support stays validated and is ranked down by
 *      retrieval.
 *
 * Counts are per distinct run (see KnowledgeStore.stats), and only run
 * evidence counts: ingested and seeded material has none until runs add it.
 */
export function decideStatus(status: LessonStatus, stats: Pick<LessonStats, 'support' | 'contradict'>): StatusDecision | null {
  if (status === 'rejected' || status === 'deprecated') return null;
  if (stats.contradict > stats.support) return { status: 'deprecated', rule: 'deprecate.contradictions-exceed-support' };
  if (status === 'candidate' && stats.support >= PROMOTION_RULES.minSupportingRuns && stats.contradict <= PROMOTION_RULES.maxContradictionsToValidate) {
    return { status: 'validated', rule: 'promote.supported-by-distinct-runs' };
  }
  return null;
}

export interface StatusChange {
  lessonId: string;
  from: LessonStatus;
  to: LessonStatus;
  rule: StatusRule;
}

/** Apply decideStatus to the given lessons (all lessons when omitted) and persist any change. */
export function applyPromotionRules(store: KnowledgeStore, lessonIds?: readonly string[]): StatusChange[] {
  return store.tx(() => {
    const lessons: Lesson[] = lessonIds ? lessonIds.map((id) => store.getLesson(id)).filter((l): l is Lesson => l !== null) : store.listLessons();
    const stats = store.statsMany(lessons.map((l) => l.id));
    const changes: StatusChange[] = [];
    for (const lesson of [...lessons].sort((a, b) => a.id.localeCompare(b.id))) {
      const s = stats.get(lesson.id)!;
      const decision = decideStatus(lesson.status, s);
      if (!decision) continue;
      store.setStatus(lesson.id, decision.status, decision.rule, { support: s.support, contradict: s.contradict });
      changes.push({ lessonId: lesson.id, from: lesson.status, to: decision.status, rule: decision.rule });
    }
    return changes;
  });
}

export interface RunOutcome {
  /** The run reached SUCCEEDED. */
  succeeded: boolean;
  /** Implementation attempts the run used. */
  attempts: number;
  /** Acceptance criteria with supporting evidence at the end of the run. */
  verifiedCriteria: readonly string[];
  /** Lessons the controller found to be wrong in this run (for example, the repair they suggested made things worse). */
  contradictedLessonIds: readonly string[];
  /** The artifact the outcome evidence points at; defaults to the run's final report. */
  artifact?: { path: string; sha256: string | null };
}

export interface SettleReport {
  runId: string;
  retrievalsSettled: number;
  /** Lessons that gained supporting evidence from this run (not already recorded). */
  supported: string[];
  /** Lessons that gained contradicting evidence from this run (not already recorded). */
  contradicted: string[];
  /** Contradicted ids that are not in this graph. */
  unknown: string[];
  changes: StatusChange[];
}

/**
 * Settle a run against the lessons it was shown:
 *
 *   - every retrieval row of the run records success or failure and attempts;
 *   - each lesson in contradictedLessonIds gains contradicting evidence from
 *     this run, whether or not it was retrieved;
 *   - when the run succeeded with at least one verified criterion, each
 *     retrieved lesson that was not contradicted gains supporting evidence
 *     from this run. A failed run adds no support and, by itself, no
 *     contradiction: failure is rarely the fault of advice;
 *   - the promotion rules then run on every lesson touched.
 *
 * Evidence is unique per (relation, run, artifact), so settling the same run
 * twice changes nothing the second time.
 */
export function settleRun(store: KnowledgeStore, runId: string, outcome: RunOutcome): SettleReport {
  const artifact = outcome.artifact ?? { path: 'final.md', sha256: null };
  return store.tx(() => {
    const retrievalsSettled = store.settleRetrievals(runId, outcome.succeeded ? 'success' : 'failure', outcome.attempts);
    const retrieved = [...new Set(store.retrievalsForRun(runId).map((r) => r.lesson_id))].sort();
    const contradictedSet = new Set(outcome.contradictedLessonIds);
    const report: SettleReport = { runId, retrievalsSettled, supported: [], contradicted: [], unknown: [], changes: [] };

    for (const id of [...contradictedSet].sort()) {
      if (!store.getLesson(id)) {
        report.unknown.push(id);
        continue;
      }
      const ref: EvidenceRef = { run_id: runId, artifact: artifact.path, sha256: artifact.sha256, relation: 'contradicts' };
      if (store.addEvidence(id, ref)) report.contradicted.push(id);
    }

    if (outcome.succeeded && outcome.verifiedCriteria.length > 0) {
      for (const id of retrieved) {
        if (contradictedSet.has(id)) continue;
        const ref: EvidenceRef = { run_id: runId, artifact: artifact.path, sha256: artifact.sha256, relation: 'supports' };
        if (store.addEvidence(id, ref)) report.supported.push(id);
      }
    }

    const touched = [...new Set([...report.supported, ...report.contradicted])];
    report.changes = touched.length > 0 ? applyPromotionRules(store, touched) : [];
    return report;
  });
}
