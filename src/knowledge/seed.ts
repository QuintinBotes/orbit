import seedDocument from '../../data/seed-practices.json' with { type: 'json' };
import { OrbitError } from '../core/errors.ts';
import type { KnowledgeStore } from './store.ts';
import type { Lesson } from './types.ts';
import { assertLesson } from './validate.ts';
import { lessonIdFor } from './text.ts';

/**
 * Seed lessons: the engineering best practices of spec section 5, shipped as
 * data (data/seed-practices.json) so a new graph starts with sound general
 * advice instead of nothing. They are global, code-free and validated by
 * definition; their source is 'seed', so run evidence can still contradict
 * and deprecate any of them through the ordinary feedback rules.
 */

/** The shipped seeds, each checked against the lesson schema and the seed invariants. */
export function seedLessons(): Lesson[] {
  const doc = seedDocument as { lessons?: unknown };
  if (!Array.isArray(doc.lessons)) throw new OrbitError('INTERNAL', 'data/seed-practices.json has no lessons array');
  return doc.lessons.map((raw) => {
    assertLesson(raw);
    const lesson = structuredClone(raw);
    const problems: string[] = [];
    if (lesson.provenance.source !== 'seed') problems.push('source is not seed');
    if (lesson.status !== 'validated') problems.push('status is not validated');
    if (lesson.scope !== 'global') problems.push('scope is not global');
    if (!lesson.code_free) problems.push('not code_free');
    if (lesson.applicability.paths.length > 0) problems.push('has repository paths');
    if (lesson.id !== lessonIdFor(lesson.kind, lesson.statement)) problems.push('id does not match its statement');
    if (problems.length > 0) throw new OrbitError('INTERNAL', `seed lesson ${lesson.id} is invalid: ${problems.join(', ')}`);
    return lesson;
  });
}

export interface SeedReport {
  inserted: string[];
  /** Seeds whose statement already had a node; evidence and lists merged, status untouched. */
  merged: string[];
}

/** Load the seeds into a graph. Idempotent: a second call merges into the same nodes. */
export function loadSeeds(store: KnowledgeStore): SeedReport {
  const report: SeedReport = { inserted: [], merged: [] };
  store.tx(() => {
    for (const lesson of seedLessons()) {
      const res = store.upsertLesson(lesson);
      (res.created ? report.inserted : report.merged).push(res.lesson.id);
    }
  });
  return report;
}
