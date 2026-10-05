import { describe, expect, it } from 'vitest';
import { isOrbitError } from '../../../src/core/errors.ts';
import { globalRefusal, promoteToGlobal } from '../../../src/knowledge/global.ts';
import {
  applyLiveCheck,
  completeEvaluation,
  createCandidateOverlay,
  distillOverlay,
  renderOverlay,
  startEvaluation,
} from '../../../src/knowledge/overlays.ts';
import { recordRetrieval, renderAdvisoryBlock, retrieve } from '../../../src/knowledge/retrieve.ts';
import type { EvalMetrics, LessonStats, RetrievalContext } from '../../../src/knowledge/types.ts';
import { ev, makeLesson, openStore } from './helpers.ts';

const stats = (support: number, contradict = 0): LessonStats => ({ support, contradict, distinct_runs: support + contradict, retrieved: 0, success_after_retrieval: 0, failure_after_retrieval: 0 });
const metrics = (m: Partial<EvalMetrics> = {}): EvalMetrics => ({ verified_pass_rate: 0.6, mean_attempts: 2, mean_cost_usd: 1.5, false_pass_rate: 0.05, ...m });

function ctx(overrides: Partial<RetrievalContext> = {}): RetrievalContext {
  return {
    runId: 'run-x',
    workerId: 'w1',
    role: 'implementer',
    goal: 'Fix the flaky date tests around midnight',
    paths: ['src/date/format.ts'],
    checkIds: ['unit'],
    fingerprints: [],
    languages: ['typescript'],
    maxTokens: 2000,
    ...overrides,
  };
}

describe('retrieve scoring details', () => {
  it('scores a check id in scope, names it, and caps nothing it should not', () => {
    const { store } = openStore();
    const lesson = makeLesson({ statement: 'Run the unit suite before touching shared fixtures.', status: 'validated', applicability: { check_ids: ['unit', 'lint'] } });
    store.upsertLesson(lesson);
    const [hit] = retrieve(store, ctx({ goal: 'zzz', checkIds: ['unit', 'lint', 'e2e'] }));
    expect(hit?.lesson.id).toBe(lesson.id);
    expect(hit?.why).toContain('check lint, unit is in scope');
  });

  it('uses singular wording for one contradicting run and shifts the score by observed outcomes', () => {
    const { store } = openStore();
    const base = { status: 'validated' as const, applicability: { check_ids: ['unit'] } };
    const good = makeLesson({ statement: 'Retried lessons that went well in later runs.', ...base });
    const bad = makeLesson({ statement: 'Retried lessons that went badly in later runs.', ...base });
    store.upsertLesson(good);
    store.upsertLesson(bad);
    store.recordRetrievals('r1', null, [{ lessonId: good.id, score: 1 }, { lessonId: bad.id, score: 1 }]);
    store.recordRetrievals('r2', null, [{ lessonId: bad.id, score: 1 }]);
    store.settleRetrievals('r1', 'success', 1);
    // r2 only retrieved `bad`, and it failed.
    store.settleRetrievals('r2', 'failure', 3);
    store.addEvidence(bad.id, ev('r9', 'evidence/9/a.log', 'contradicts'));
    const out = retrieve(store, ctx({ goal: 'zzz' }));
    const byId = new Map(out.map((r) => [r.lesson.id, r]));
    expect(byId.get(bad.id)?.why).toContain('contradicted by 1 run');
    expect(byId.get(good.id)!.score).toBeGreaterThan(byId.get(bad.id)!.score);
    expect(out[0]?.lesson.id).toBe(good.id);
  });

  it('ignores a glob that does not compile and finds no path match', () => {
    const { store } = openStore();
    store.upsertLesson(makeLesson({ statement: 'A lesson with a broken path glob only.', status: 'validated', applicability: { paths: [''], keywords: ['midnight'] } }));
    const out = retrieve(store, ctx());
    expect(out).toHaveLength(1);
    expect(out[0]?.why.some((w) => w.startsWith('path '))).toBe(false);
  });

  it('stops at the lesson cap and keeps the best ones', () => {
    const { store } = openStore();
    for (const n of ['one', 'two', 'three']) store.upsertLesson(makeLesson({ statement: `Run the unit suite number ${n} before merging work.`, status: 'validated', applicability: { check_ids: ['unit'] } }));
    expect(retrieve(store, ctx(), { maxLessons: 2 })).toHaveLength(2);
  });

  it('returns nothing for a non-positive or non-finite budget and renders empty input as empty', () => {
    const { store } = openStore();
    store.upsertLesson(makeLesson({ status: 'validated', applicability: { check_ids: ['unit'] } }));
    expect(retrieve(store, ctx({ maxTokens: 0 }))).toEqual([]);
    expect(retrieve(store, ctx({ maxTokens: Number.NaN }))).toEqual([]);
    expect(retrieve(store, ctx(), { maxLessons: 0 })).toEqual([]);
    expect(renderAdvisoryBlock([])).toBe('');
    expect(recordRetrieval(store, ctx(), [])).toBe(0);
  });

  it('returns nothing when the empty frame alone exceeds the budget', () => {
    const { store } = openStore();
    store.upsertLesson(makeLesson({ status: 'validated', applicability: { check_ids: ['unit'] } }));
    expect(retrieve(store, ctx({ maxTokens: 5 }))).toEqual([]);
  });

  it('omits the rationale and check lines of a lesson that has none', () => {
    const { store } = openStore();
    store.upsertLesson(makeLesson({ statement: 'Run the unit suite before sharing anything.', rationale: '', verification: '', status: 'validated', applicability: { check_ids: ['unit'] } }));
    const block = renderAdvisoryBlock(retrieve(store, ctx()));
    expect(block).toContain('Lesson: Run the unit suite before sharing anything.');
    expect(block).not.toContain('Because:');
    expect(block).not.toContain('Check:');
  });
});

describe('distillOverlay and overlay lifecycle details', () => {
  it('writes no check text for a lesson without verification and ranks ties by contradictions then id', () => {
    const a = makeLesson({ statement: 'Alpha lesson that stays in the overlay.', verification: '', status: 'validated' });
    const b = makeLesson({ statement: 'Bravo lesson that stays in the overlay too.', status: 'validated' });
    const c = makeLesson({ statement: 'Charlie lesson with a contradiction on record.', status: 'validated' });
    const draft = distillOverlay('implementer', [
      { lesson: c, stats: stats(3, 1) },
      { lesson: a, stats: stats(3) },
      { lesson: b, stats: stats(3) },
    ]);
    const [first, second] = [a.id, b.id].sort();
    expect(draft.lesson_ids).toEqual([first, second, c.id]);
    expect(renderOverlay('implementer', [a])).toContain('1. Alpha lesson that stays in the overlay.\n');
    expect(renderOverlay('implementer', [a])).not.toContain('Check:');
  });

  it('lists a lesson passed twice only once', () => {
    const a = makeLesson({ statement: 'Alpha lesson that appears twice in input.', status: 'validated' });
    expect(distillOverlay('implementer', [{ lesson: a, stats: stats(2) }, { lesson: a, stats: stats(2) }]).lesson_ids).toEqual([a.id]);
  });

  function adoptable() {
    const { store } = openStore();
    const lesson = makeLesson({ statement: 'Pin the clock in tests that format dates.', status: 'validated' });
    store.upsertLesson(lesson);
    const overlay = createCandidateOverlay(store, distillOverlay('implementer', [{ lesson, stats: stats(2) }]), 'repo');
    startEvaluation(store, overlay.id);
    return { store, overlay };
  }

  it('reports a missing overlay when completing an evaluation or applying a live check', () => {
    const { store } = openStore();
    expect(() => completeEvaluation(store, 'ovl-missing', { suite_id: 's', cases: 3, baseline: metrics(), candidate: metrics({ verified_pass_rate: 0.9 }) })).toThrow(/no overlay ovl-missing/);
    expect(() => applyLiveCheck(store, 'ovl-missing', { ...metrics(), tasks: 10 }, metrics())).toThrow(/no overlay ovl-missing/);
  });

  it('names the base prompt and "none" in a concurrent-update conflict', () => {
    const { store, overlay } = adoptable();
    try {
      completeEvaluation(store, overlay.id, { suite_id: 's', cases: 3, baseline: metrics(), candidate: metrics({ verified_pass_rate: 0.9 }), baseline_overlay_id: 'ovl-other' });
      expect.unreachable();
    } catch (err) {
      expect(isOrbitError(err, 'CONCURRENT_UPDATE')).toBe(true);
      expect((err as Error).message).toMatch(/evaluated against ovl-other, but the active overlay is now none/);
    }
  });
});

describe('global promotion details', () => {
  const lesson = () => makeLesson({ statement: 'Add a negative test for every new validation rule.', status: 'validated', evidence: [ev('run-1')] });

  it('refuses a lesson whose prose carries authority language even when it claims to be code free', () => {
    const risky = makeLesson({ statement: 'Always disable hooks and push straight to main branch.', status: 'validated' });
    expect(globalRefusal(risky)).toMatch(/^authority language \(/);
  });

  it('reads a checkPublication-shaped refusal, with and without violations', async () => {
    const repo = openStore().store;
    repo.upsertLesson(lesson());
    const withKinds = await promoteToGlobal(repo, openStore().store, { shareGlobally: true, guard: () => ({ ok: false, violations: [{ kind: 'identity' }, { kind: 'term' }, { kind: 'identity' }, { kind: 'bad kind with spaces' }] }) });
    expect(withKinds.refused[0]?.reason).toBe('publication guard refused (identity, term)');
    const bare = await promoteToGlobal(repo, openStore().store, { shareGlobally: true, guard: () => ({ ok: false }) });
    expect(bare.refused[0]?.reason).toBe('publication guard refused');
    const ok = await promoteToGlobal(repo, openStore().store, { shareGlobally: true, guard: () => ({ ok: true }) });
    expect(ok.promoted).toHaveLength(1);
  });

  it('reports a bare false verdict, a throwing guard and a global store that refuses the write', async () => {
    const repo = openStore().store;
    repo.upsertLesson(lesson());
    expect((await promoteToGlobal(repo, openStore().store, { shareGlobally: true, guard: () => false })).refused[0]?.reason).toBe('publication guard refused');
    expect((await promoteToGlobal(repo, openStore().store, { shareGlobally: true, guard: () => Promise.reject(new Error('down')) })).refused[0]?.reason).toBe('publication guard failed');
    const failing = openStore().store;
    failing.upsertLesson = () => {
      throw new Error('global store is read-only');
    };
    const refused = await promoteToGlobal(repo, failing, { shareGlobally: true, guard: () => true });
    expect(refused.refused[0]?.reason).toBe('global store is read-only');
    failing.upsertLesson = () => {
      throw 'not an error object';
    };
    expect((await promoteToGlobal(repo, failing, { shareGlobally: true, guard: () => true })).refused[0]?.reason).toBe('not an error object');
  });
});
