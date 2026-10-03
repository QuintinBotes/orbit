import { describe, expect, it } from 'vitest';
import { applyPromotionRules, decideStatus, settleRun } from '../../../src/knowledge/feedback.ts';
import { loadSeeds, seedLessons } from '../../../src/knowledge/seed.ts';
import { ev, makeLesson, openStore } from './helpers.ts';

describe('decideStatus', () => {
  it.each([
    ['candidate', 0, 0, null],
    ['candidate', 1, 0, null],
    ['candidate', 2, 0, 'validated'],
    ['candidate', 5, 1, null],
    ['candidate', 0, 1, 'deprecated'],
    ['candidate', 2, 3, 'deprecated'],
    ['validated', 3, 3, null],
    ['validated', 3, 4, 'deprecated'],
    ['validated', 0, 1, 'deprecated'],
    ['deprecated', 10, 0, null],
    ['rejected', 10, 0, null],
  ] as const)('%s with support %i and contradictions %i -> %s', (status, support, contradict, expected) => {
    expect(decideStatus(status, { support, contradict })?.status ?? null).toBe(expected);
  });

  it('names the rule behind every change', () => {
    expect(decideStatus('candidate', { support: 2, contradict: 0 })?.rule).toBe('promote.supported-by-distinct-runs');
    expect(decideStatus('validated', { support: 0, contradict: 1 })?.rule).toBe('deprecate.contradictions-exceed-support');
  });
});

describe('settleRun', () => {
  function withRetrieved(runId: string, evidenceRuns: string[] = ['r1']) {
    const { store } = openStore();
    const lesson = makeLesson({ evidence: evidenceRuns.map((r) => ev(r)) });
    store.upsertLesson(lesson);
    store.recordRetrievals(runId, 'w1', [{ lessonId: lesson.id, score: 2 }]);
    return { store, lesson };
  }

  it('adds support from a successful verified run and promotes on the second distinct run', () => {
    const { store, lesson } = withRetrieved('r2');
    const report = settleRun(store, 'r2', { succeeded: true, attempts: 2, verifiedCriteria: ['AC-1'], contradictedLessonIds: [] });
    expect(report.retrievalsSettled).toBe(1);
    expect(report.supported).toEqual([lesson.id]);
    expect(report.changes).toEqual([{ lessonId: lesson.id, from: 'candidate', to: 'validated', rule: 'promote.supported-by-distinct-runs' }]);
    expect(store.getLesson(lesson.id)!.status).toBe('validated');
    expect(store.getLesson(lesson.id)!.evidence.at(-1)).toEqual({ run_id: 'r2', artifact: 'final.md', sha256: null, relation: 'supports' });
    expect(store.retrievalsForRun('r2')[0]).toMatchObject({ outcome: 'success', attempts: 2 });
    expect(store.stats(lesson.id)).toMatchObject({ support: 2, success_after_retrieval: 1 });
  });

  it('does not promote on support from the same run twice', () => {
    const { store, lesson } = withRetrieved('r1');
    settleRun(store, 'r1', { succeeded: true, attempts: 1, verifiedCriteria: ['AC-1'], contradictedLessonIds: [] });
    expect(store.getLesson(lesson.id)!.status).toBe('candidate');
    expect(store.stats(lesson.id).support).toBe(1);
  });

  it('is idempotent', () => {
    const { store, lesson } = withRetrieved('r2');
    settleRun(store, 'r2', { succeeded: true, attempts: 1, verifiedCriteria: ['AC-1'], contradictedLessonIds: [] });
    const again = settleRun(store, 'r2', { succeeded: true, attempts: 1, verifiedCriteria: ['AC-1'], contradictedLessonIds: [] });
    expect(again.supported).toEqual([]);
    expect(again.changes).toEqual([]);
    expect(store.stats(lesson.id).support).toBe(2);
  });

  it('adds no support from a failed run or one with nothing verified', () => {
    const failed = withRetrieved('r2');
    settleRun(failed.store, 'r2', { succeeded: false, attempts: 4, verifiedCriteria: [], contradictedLessonIds: [] });
    expect(failed.store.stats(failed.lesson.id)).toMatchObject({ support: 1, contradict: 0, failure_after_retrieval: 1 });
    expect(failed.store.getLesson(failed.lesson.id)!.status).toBe('candidate');

    const unverified = withRetrieved('r3');
    settleRun(unverified.store, 'r3', { succeeded: true, attempts: 1, verifiedCriteria: [], contradictedLessonIds: [] });
    expect(unverified.store.stats(unverified.lesson.id).support).toBe(1);
  });

  it('records contradictions, deprecates when they outnumber support, and reports unknown ids', () => {
    const { store, lesson } = withRetrieved('r2');
    const report = settleRun(store, 'r2', { succeeded: true, attempts: 3, verifiedCriteria: ['AC-1'], contradictedLessonIds: [lesson.id, 'les-ffffffffffff'] });
    // A contradicted lesson gets no support from the same run.
    expect(report.supported).toEqual([]);
    expect(report.contradicted).toEqual([lesson.id]);
    expect(report.unknown).toEqual(['les-ffffffffffff']);
    expect(store.stats(lesson.id)).toMatchObject({ support: 1, contradict: 1 });
    expect(store.getLesson(lesson.id)!.status).toBe('candidate');
    settleRun(store, 'r3', { succeeded: false, attempts: 3, verifiedCriteria: [], contradictedLessonIds: [lesson.id] });
    expect(store.getLesson(lesson.id)!.status).toBe('deprecated');
    expect(store.events(lesson.id).at(-1)).toMatchObject({ type: 'status', data: { to: 'deprecated', reason: 'deprecate.contradictions-exceed-support' } });
  });

  it('never validates a lesson with a contradiction, however much support it has', () => {
    const { store, lesson } = withRetrieved('r9', ['r1', 'r2', 'r3']);
    store.addEvidence(lesson.id, ev('r4', 'final.md', 'contradicts', null));
    expect(applyPromotionRules(store, [lesson.id])).toEqual([]);
    expect(store.getLesson(lesson.id)!.status).toBe('candidate');
  });

  it('lets run evidence deprecate a seed practice', () => {
    const { store } = openStore();
    loadSeeds(store);
    const seed = seedLessons()[0]!;
    settleRun(store, 'r1', { succeeded: false, attempts: 2, verifiedCriteria: [], contradictedLessonIds: [seed.id] });
    expect(store.getLesson(seed.id)!.status).toBe('deprecated');
  });

  it('records the given outcome artifact', () => {
    const { store, lesson } = withRetrieved('r2');
    settleRun(store, 'r2', { succeeded: true, attempts: 1, verifiedCriteria: ['AC-1'], contradictedLessonIds: [], artifact: { path: 'evidence/3/report.json', sha256: 'a'.repeat(64) } });
    expect(store.getLesson(lesson.id)!.evidence.at(-1)).toMatchObject({ artifact: 'evidence/3/report.json', sha256: 'a'.repeat(64) });
  });
});

describe('applyPromotionRules', () => {
  it('sweeps every lesson when no ids are given', () => {
    const { store } = openStore();
    const ready = makeLesson({ statement: 'Prefer table-driven tests for parsers.', evidence: [ev('r1'), ev('r2')] });
    const notReady = makeLesson({ statement: 'Name fixtures after the scenario they build.', evidence: [ev('r1')] });
    store.upsertLesson(ready);
    store.upsertLesson(notReady);
    expect(applyPromotionRules(store).map((c) => c.lessonId)).toEqual([ready.id]);
    expect(applyPromotionRules(store)).toEqual([]);
  });
});
