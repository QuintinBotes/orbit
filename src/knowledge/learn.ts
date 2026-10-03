import type { OrbitDb } from '../storage/db.ts';
import type { Clock } from '../core/clock.ts';
import type { KnowledgeStore } from './store.ts';
import type { Lesson } from './types.ts';
import { extractObservations, type Observation } from './extract.ts';
import { acceptCuratorOutputDetailed, buildCuratorTask, CURATION_LIMITS, type CurationRejection, type CuratorTask } from './curate.ts';
import { applyPromotionRules, type StatusChange } from './feedback.ts';

/**
 * End-of-run learning, composed from the steps in this module: extract
 * observations, show the curator the most similar existing lessons, accept
 * its output, store the lessons and apply the promotion rules. Running the
 * curator worker is the caller's job (the controller owns workers, budgets and
 * schema validation of worker output), so it is injected.
 */

export interface LearnInput {
  store: KnowledgeStore;
  runDb: OrbitDb;
  runId: string;
  runDir: string;
  clock: Clock;
  /** Exact model id the curator runs on, for provenance. */
  curatorModel: string;
  /** Runs the curator worker on the task and returns its structured output. */
  runCurator: (task: CuratorTask) => Promise<unknown>;
}

export interface LearnReport {
  observations: number;
  /** Set when the curator was not called, with the reason. */
  skipped: string | null;
  created: string[];
  merged: string[];
  rejected: CurationRejection[];
  discarded: { source: string; reason: string }[];
  changes: StatusChange[];
}

function similarLessons(store: KnowledgeStore, observations: readonly Observation[]): Lesson[] {
  const seen = new Map<string, Lesson>();
  for (const o of observations) {
    const query = [o.summary, ...o.fingerprints, ...o.check_ids].join(' ');
    for (const hit of store.search(query, { statuses: ['candidate', 'validated'], kinds: [o.kind], limit: 5 })) {
      if (!seen.has(hit.lesson.id)) seen.set(hit.lesson.id, hit.lesson);
      if (seen.size >= CURATION_LIMITS.existingLessons) return [...seen.values()];
    }
  }
  return [...seen.values()];
}

export async function learnFromRun(input: LearnInput): Promise<LearnReport> {
  const { store, clock } = input;
  const observations = extractObservations(input.runDb, input.runId, input.runDir);
  const report: LearnReport = { observations: observations.length, skipped: null, created: [], merged: [], rejected: [], discarded: [], changes: [] };
  if (observations.length === 0) {
    // Nothing verified to learn from: do not spend a curator call.
    report.skipped = 'no observations';
    return report;
  }
  const task = buildCuratorTask(observations, similarLessons(store, observations), { curatorModel: input.curatorModel, clock });
  const output = await input.runCurator(task);
  const result = acceptCuratorOutputDetailed(output, observations, clock, { curatorModel: input.curatorModel });
  report.rejected = [...result.rejected];
  report.discarded = result.discarded;
  for (const lesson of result.accepted) {
    try {
      const res = store.upsertLesson(lesson);
      (res.created ? report.created : report.merged).push(res.lesson.id);
    } catch (err) {
      report.rejected.push({ index: -1, statement: lesson.statement.slice(0, 120), reason: err instanceof Error ? err.message : String(err) });
    }
  }
  const touched = [...new Set([...report.created, ...report.merged])];
  report.changes = touched.length > 0 ? applyPromotionRules(store, touched) : [];
  return report;
}
