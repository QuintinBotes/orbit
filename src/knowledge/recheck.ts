import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { KnowledgeStore } from './store.ts';
import type { Lesson } from './types.ts';

/**
 * Re-checking lessons against the repository (issue #173). A lesson about code that has changed is worse than none,
 * so before a lesson may enter a prompt its citation must still hold and it must have had support within the expiry
 * period. A lesson that fails is marked stale with the reason and skipped; one that passes again later is eligible
 * again. Deterministic: the file system and the configured checks only, no model.
 */

export const DEFAULT_LESSON_EXPIRY_DAYS = 28;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RecheckEnv {
  /** The repository the citations are checked against. */
  root: string;
  /** The checks the repository configures now. */
  checkIds: readonly string[];
  expiryDays: number;
}

/** Why a lesson's citation no longer holds in `env`, or null when it does. */
export function citationProblem(lesson: Lesson, env: Pick<RecheckEnv, 'root' | 'checkIds'>): string | null {
  const c = lesson.citation ?? null;
  if (!c || (c.path === null && c.check_id === null)) {
    // Seeds and ingested material come from outside a run and cite their source, not this repository.
    return lesson.provenance.source === 'run' ? 'it cites no file or check to re-check' : null;
  }
  if (c.check_id !== null && !env.checkIds.includes(c.check_id)) return `cited check ${c.check_id} is no longer configured`;
  if (c.path !== null) {
    const full = resolve(env.root, c.path);
    const rel = relative(env.root, full);
    if (isAbsolute(c.path) || rel.startsWith('..') || isAbsolute(rel)) return `cited path ${c.path} is outside the repository`;
    let isFile = false;
    try {
      isFile = statSync(full).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) return `cited path ${c.path} no longer exists`;
    if (c.line !== null && readFileSync(full, 'utf8').split('\n').length < c.line) return `cited line ${c.path}:${c.line} no longer exists`;
  }
  return null;
}

/**
 * Re-check `lessons`, record each verdict on the lesson, and return the ones still eligible. Expiry is measured from
 * the lesson's newest supporting evidence (its creation when it has none).
 */
export function recheckLessons(store: KnowledgeStore, lessons: readonly Lesson[], env: RecheckEnv): Lesson[] {
  const now = store.clock.now();
  const times = store.freshness(lessons.map((l) => l.id));
  const days = Number.isFinite(env.expiryDays) && env.expiryDays > 0 ? env.expiryDays : DEFAULT_LESSON_EXPIRY_DAYS;
  const eligible: Lesson[] = [];
  for (const lesson of lessons) {
    const t = times.get(lesson.id);
    if (!t) continue;
    const idle = now - t.last_support_at;
    const reason = idle > days * DAY_MS ? `expired: no support for ${Math.floor(idle / DAY_MS)} days (limit ${days})` : citationProblem(lesson, env);
    store.markChecked(lesson.id, reason);
    if (reason === null) eligible.push(lesson);
  }
  return eligible;
}
