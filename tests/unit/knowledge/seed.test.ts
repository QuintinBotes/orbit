import { describe, expect, it } from 'vitest';
import { loadSeeds, seedLessons } from '../../../src/knowledge/seed.ts';
import { authorityViolations, lessonText, verificationLooksExecutable } from '../../../src/knowledge/authority.ts';
import { codeFreeViolations, shareableText } from '../../../src/knowledge/codefree.ts';
import { lessonIdFor } from '../../../src/knowledge/text.ts';
import { lessonSchemaErrors } from '../../../src/knowledge/validate.ts';
import { openStore } from './helpers.ts';

describe('seed practices', () => {
  const seeds = seedLessons();

  it('are complete, schema-valid, global, validated, code-free seed lessons', () => {
    expect(seeds.length).toBeGreaterThanOrEqual(10);
    for (const l of seeds) {
      expect(lessonSchemaErrors(l)).toEqual([]);
      expect(l).toMatchObject({ status: 'validated', scope: 'global', code_free: true, kind: 'practice' });
      expect(l.provenance.source).toBe('seed');
      expect(l.id).toBe(lessonIdFor(l.kind, l.statement));
      expect(l.verification.length).toBeGreaterThan(40);
      expect(l.applicability.paths).toEqual([]);
    }
    expect(new Set(seeds.map((s) => s.id)).size).toBe(seeds.length);
  });

  it('pass the same filters every other lesson must pass', () => {
    for (const l of seeds) {
      expect(authorityViolations(lessonText(l)), l.statement).toEqual([]);
      expect(codeFreeViolations(shareableText(l)), l.statement).toEqual([]);
      expect(verificationLooksExecutable(l.verification), l.statement).toBeNull();
    }
  });

  it.each([
    ['positive, negative, boundary and error-path tests', /negative, boundary and error-path tests/],
    ['empty and loading states', /empty, loading and error states/],
    ['input validation', /Validate untrusted input/],
    ['authorization', /authorization/],
    ['sensitive data', /secrets and personal data/],
    ['compatibility', /public interfaces/],
    ['performance hotspots', /hotspot/],
    ['accessibility', /accessible name, keyboard access/],
    ['documentation for public behaviour', /Document public behaviour/],
    ['rollback and migration plans', /rollback or migration plan/],
  ])('cover %s', (_topic, pattern) => {
    expect(seeds.some((s) => pattern.test(s.statement))).toBe(true);
  });

  it('load idempotently', () => {
    const { store } = openStore();
    const first = loadSeeds(store);
    expect(first.inserted).toHaveLength(seeds.length);
    const second = loadSeeds(store);
    expect(second).toEqual({ inserted: [], merged: first.inserted });
    expect(store.count()).toBe(seeds.length);
    expect(store.search('keyboard focus accessibility')[0]!.lesson.statement).toMatch(/accessible name/);
  });
});
