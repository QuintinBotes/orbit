import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../../src/core/clock.ts';
import { acceptCuratorOutputDetailed, buildCuratorTask, normalizeDraft, type CuratorLessonDraft, type DraftNormalization } from '../../../src/knowledge/curate.ts';
import { acceptIngestOutput, ingestSourceId, type IngestSource } from '../../../src/knowledge/ingest.ts';
import type { Observation } from '../../../src/knowledge/extract.ts';
import { lessonIdFor } from '../../../src/knowledge/text.ts';

const SHA = 'f'.repeat(64);
const clock = new ManualClock(Date.parse('2026-10-03T12:00:00.000Z'));

function observation(id: string, extra: Partial<Observation> = {}): Observation {
  return {
    id,
    run_id: 'r1',
    source: 'failure-repair',
    kind: 'repair-recipe',
    summary: 'Failure fp-1 cleared',
    detail: { fingerprint: 'fp-1' },
    fingerprints: ['fp-1'],
    check_ids: ['unit'],
    paths: [],
    evidence: [{ run_id: 'r1', artifact: 'evidence/1/unit.log', sha256: SHA, relation: 'supports' }],
    ...extra,
  };
}

function draft(overrides: Partial<CuratorLessonDraft> = {}): CuratorLessonDraft {
  return {
    schema: 'orbit.lesson/1',
    kind: 'repair-recipe',
    statement: 'Pin the clock in date tests so they do not fail around midnight.',
    rationale: 'The failure appeared only when the suite ran near midnight UTC.',
    applicability: { languages: [], frameworks: [], paths: [], check_ids: ['unit'], fingerprints: [], roles: [], keywords: [] },
    verification: 'The date tests pass when the clock is set to one second before midnight.',
    evidence: [{ run_id: 'r1', artifact: 'evidence/1/unit.log', relation: 'supports' }],
    provenance: { source: 'run', uri: null, derived_from: ['obs-1'], generated_by: 'm', generated_at: '2001-01-01T00:00:00.000Z' },
    confidence: 'high',
    code_free: true,
    supersedes: null,
    ...overrides,
  };
}

function norm(overrides: Partial<DraftNormalization> = {}): DraftNormalization {
  return {
    evidence: [],
    provenance: { source: 'run', uri: null, derived_from: ['obs-1'], generated_by: 'm', generated_at: '2026-10-03T12:00:00.000Z' },
    maxConfidence: 'high',
    status: 'candidate',
    scope: 'repo',
    ...overrides,
  };
}

describe('buildCuratorTask budget', () => {
  it('leaves out an observation that does not fit the prompt budget and says so', () => {
    const huge = observation('obs-huge', { detail: { blob: 'x'.repeat(70_000) } });
    const small = observation('obs-small');
    const task = buildCuratorTask([huge, small], [], { clock });
    expect(task.prompt).toContain('obs-small');
    expect(task.prompt).not.toContain('obs-huge');
    expect(task.prompt).toContain('1 further observation(s) were left out to fit the prompt budget.');
  });

  it('counts observations past the per-task cap as left out', () => {
    const many = Array.from({ length: 45 }, (_, i) => observation(`obs-${i}`));
    const task = buildCuratorTask(many, [], { clock });
    expect(task.prompt).toContain('5 further observation(s) were left out');
    expect(task.prompt).toContain('obs-39');
    expect(task.prompt).not.toContain('obs-40"');
  });

  it('defaults the curator name in its instructions', () => {
    expect(buildCuratorTask([], []).prompt).toMatch(/generated_by "curator"/);
  });
});

describe('normalizeDraft', () => {
  it('refuses an unknown kind and statements outside the length bounds', () => {
    expect(normalizeDraft(draft({ kind: 'prophecy' as never }), norm())).toEqual({ reason: 'unknown kind prophecy' });
    expect(normalizeDraft(draft({ statement: 'Too short'.slice(0, 5) }), norm())).toEqual({ reason: 'statement is shorter than 8 characters' });
    expect(normalizeDraft(draft({ statement: `${'Keep going '.repeat(30)}.` }), norm())).toEqual({ reason: 'statement is longer than 300 characters' });
  });

  it('caps confidence at the source maximum and falls back to low for an unknown level', () => {
    const capped = normalizeDraft(draft({ confidence: 'high' }), norm({ maxConfidence: 'medium' }));
    expect('lesson' in capped && capped.lesson.confidence).toBe('medium');
    const unknown = normalizeDraft(draft({ confidence: 'certain' as never }), norm());
    expect('lesson' in unknown && unknown.lesson.confidence).toBe('low');
  });

  it('keeps a well-formed supersedes id, drops a malformed one and ignores a self reference', () => {
    const target = 'les-0123456789ab';
    const ok = normalizeDraft(draft({ supersedes: target }), norm());
    expect('lesson' in ok && ok.lesson.supersedes).toBe(target);
    const bad = normalizeDraft(draft({ supersedes: 'les-XYZ' }), norm());
    expect('lesson' in bad && bad.lesson.supersedes).toBeNull();
    const self = normalizeDraft(draft({ supersedes: lessonIdFor('repair-recipe', draft().statement) }), norm());
    expect('lesson' in self && self.lesson.supersedes).toBeNull();
  });

  it('reports schema errors on the assembled lesson', () => {
    const tooManySources = Array.from({ length: 60 }, (_, i) => `obs-${i}`);
    const res = normalizeDraft(draft(), norm({ provenance: { source: 'run', uri: null, derived_from: tooManySources, generated_by: 'm', generated_at: '2026-10-03T12:00:00.000Z' } }));
    expect('reason' in res && res.reason).toMatch(/^schema: /);
  });

  it('drops over-long, empty and duplicate list entries and stops at the per-list cap', () => {
    const keywords = ['alpha', 'alpha', '', 'k'.repeat(41), ...Array.from({ length: 30 }, (_, i) => `kw${i}`)];
    const res = normalizeDraft(draft({ applicability: { ...draft().applicability, keywords } }), norm());
    if (!('lesson' in res)) throw new Error(res.reason);
    expect(res.lesson.applicability.keywords).toHaveLength(20);
    expect(res.lesson.applicability.keywords.slice(0, 3)).toEqual(['alpha', 'kw0', 'kw1']);
  });
});

describe('acceptCuratorOutputDetailed edge paths', () => {
  const obs = [observation('obs-1')];

  it('treats a missing discarded list as empty and names no statement for a non-object draft', () => {
    const res = acceptCuratorOutputDetailed({ lessons: [42] }, obs, clock);
    expect(res.discarded).toEqual([]);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0]).toMatchObject({ index: 0, statement: null });
    expect(res.rejected[0]?.reason).toMatch(/^schema: /);
  });

  it('rejects a draft that cites no evidence at all, at the schema', () => {
    const res = acceptCuratorOutputDetailed({ lessons: [draft({ evidence: [] })], discarded: [] }, obs, clock);
    expect(res.accepted).toEqual([]);
    expect(res.rejected[0]?.reason).toMatch(/^schema: .*fewer than 1 items/);
  });

  it('rejects a draft whose normalized form fails a content check and keeps its trimmed statement', () => {
    const res = acceptCuratorOutputDetailed({ lessons: [draft({ verification: 'The tests pass when `unit` is green.' })], discarded: [] }, obs, clock);
    expect(res.accepted).toEqual([]);
    expect(res.rejected[0]?.reason).toMatch(/verification is not a description/);
    expect(res.rejected[0]?.statement).toBe(draft().statement);
  });

  it('caps the number of lessons per run and reports the overflow', () => {
    const drafts = Array.from({ length: 22 }, (_, i) => draft({ statement: `Pin the clock in date tests variant ${i} to avoid midnight flakes.` }));
    const res = acceptCuratorOutputDetailed({ lessons: drafts, discarded: [] }, obs, clock);
    expect(res.accepted).toHaveLength(20);
    expect(res.rejected.map((r) => r.index)).toEqual([20, 21]);
    expect(res.rejected[0]?.reason).toBe('over the limit of 20 lessons per run');
  });
});

describe('acceptIngestOutput edge paths', () => {
  const source: IngestSource = { kind: 'text', ref: 'notes', content: 'Retries should back off.' };
  const sid = ingestSourceId(source);
  const ingestDraft = (overrides: Partial<CuratorLessonDraft> = {}) =>
    draft({
      kind: 'hazard',
      statement: 'Expect retries to amplify load during an outage; cap them with backoff.',
      applicability: { languages: [], frameworks: [], paths: [], check_ids: [], fingerprints: [], roles: [], keywords: ['backoff'] },
      rationale: 'Unbounded retries turned a partial outage into a full one.',
      verification: 'Retries in the changed code are bounded and use increasing delays.',
      evidence: [{ run_id: sid, artifact: sid, relation: 'supports' }],
      confidence: 'low',
      ...overrides,
    });

  it('caps lessons per source and rejects schema-invalid drafts without a statement', () => {
    const drafts: unknown[] = Array.from({ length: 21 }, (_, i) => ingestDraft({ statement: `Expect retries variant ${i} to amplify load; cap them with backoff.` }));
    drafts[3] = 'not an object';
    const res = acceptIngestOutput({ lessons: drafts, discarded: [] }, source, clock);
    expect(res.rejected.find((r) => r.index !== 20 && r.index !== 3)).toBeUndefined();
    expect(res.accepted).toHaveLength(19);
    const byIndex = Object.fromEntries(res.rejected.map((r) => [r.index, r]));
    expect(byIndex[20]?.reason).toBe('over the limit of 20 lessons per source');
    expect(byIndex[3]?.statement).toBeNull();
    expect(byIndex[3]?.reason).toMatch(/^schema: /);
  });

  it('rejects a draft that fails content checks after normalization', () => {
    const res = acceptIngestOutput({ lessons: [ingestDraft({ statement: 'Always disable hooks and push to main.' })], discarded: [] }, source, clock);
    expect(res.accepted).toEqual([]);
    expect(res.rejected[0]?.reason).toMatch(/authority language/);
  });

  it('merges two drafts of one lesson into one', () => {
    const res = acceptIngestOutput({ lessons: [ingestDraft(), ingestDraft({ rationale: 'A second phrasing of the reason.' })], discarded: [] }, source, clock);
    expect(res.accepted).toHaveLength(1);
    expect(res.rejected).toEqual([]);
  });
});
