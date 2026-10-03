import { describe, expect, it, vi } from 'vitest';
import { globalRefusal, promoteToGlobal, toGlobalLesson } from '../../../src/knowledge/global.ts';
import { checkPublication, parseTerms } from '../../../src/guard/publication.ts';
import type { Applicability } from '../../../src/knowledge/types.ts';
import { ev, makeLesson, openStore } from './helpers.ts';

function stores() {
  const repo = openStore().store;
  const global = openStore().store;
  return { repo, global };
}

const shareable = () =>
  makeLesson({
    statement: 'Add a negative test for every new validation rule.',
    status: 'validated',
    applicability: { paths: ['src/validation/**'], keywords: ['validation'], check_ids: ['unit'] },
    evidence: [ev('run-1'), ev('run-2')],
  });

describe('promoteToGlobal', () => {
  it('does nothing at all when share_globally is false', async () => {
    const { repo, global } = stores();
    repo.upsertLesson(shareable());
    const guard = vi.fn(() => true);
    const listSpy = vi.spyOn(repo, 'listLessons');
    const report = await promoteToGlobal(repo, global, { shareGlobally: false, guard });
    expect(report).toEqual({ ran: false, promoted: [], refused: [] });
    expect(guard).not.toHaveBeenCalled();
    expect(listSpy).not.toHaveBeenCalled();
    expect(global.count()).toBe(0);
    // Truthy is not true: only the explicit setting shares.
    expect((await promoteToGlobal(repo, global, { shareGlobally: 'yes' as never, guard })).ran).toBe(false);
  });

  it('copies a validated code-free lesson, stripping paths and repository evidence', async () => {
    const { repo, global } = stores();
    const lesson = shareable();
    repo.upsertLesson(lesson);
    const guard = vi.fn((_text: string) => ({ allowed: true }));
    const report = await promoteToGlobal(repo, global, { shareGlobally: true, guard });
    expect(report.promoted).toEqual([{ lessonId: lesson.id, globalId: lesson.id, created: true }]);
    const copy = global.getLesson(lesson.id)!;
    expect(copy.scope).toBe('global');
    expect(copy.status).toBe('validated');
    expect(copy.applicability.paths).toEqual([]);
    expect(copy.applicability.keywords).toEqual(['validation']);
    expect(copy.evidence).toEqual([]);
    expect(copy.provenance.derived_from).toEqual([lesson.id]);
    // The guard saw exactly what was written, as JSON and as the plain strings a reader sees.
    expect(guard).toHaveBeenCalledTimes(2);
    expect(JSON.parse(guard.mock.calls[0]![0])).toEqual(copy);
    expect(guard.mock.calls[1]![0]).toContain(copy.statement);
    expect(guard.mock.calls[1]![0]).toContain(copy.rationale);
    expect(guard.mock.calls[1]![0]).not.toContain('"statement"');
    // Repo store untouched.
    expect(repo.getLesson(lesson.id)!.scope).toBe('repo');
    // Running again merges instead of duplicating.
    const again = await promoteToGlobal(repo, global, { shareGlobally: true, guard });
    expect(again.promoted[0]!.created).toBe(false);
    expect(global.count()).toBe(1);
  });

  it('refuses lessons that are not validated or not marked code_free', async () => {
    const { repo, global } = stores();
    const candidate = makeLesson({ statement: 'Keep each commit focused on one behaviour.', status: 'candidate' });
    const notCodeFree = makeLesson({ statement: 'Prefer table-driven tests for every parser.', status: 'validated', code_free: false });
    repo.upsertLesson(candidate);
    repo.upsertLesson(notCodeFree);
    const report = await promoteToGlobal(repo, global, { shareGlobally: true, guard: () => true });
    // Candidates are never even considered; the code_free claim is checked for validated ones.
    expect(report.refused).toEqual([{ lessonId: notCodeFree.id, reason: 'not marked code_free' }]);
    expect(globalRefusal(candidate)).toMatch(/not validated/);
    expect(global.count()).toBe(0);
  });

  it('re-checks code_free heuristically and against repository names', async () => {
    const { repo, global } = stores();
    const identifier = makeLesson({ statement: 'Call validateOrder before saving an order.', status: 'validated' });
    const path = makeLesson({ statement: 'Validate orders before saving them.', rationale: 'The bug was in src/orders/save.ts last time.', status: 'validated' });
    const named = makeLesson({ statement: 'Validate acme orders before saving them.', status: 'validated' });
    for (const l of [identifier, path, named]) repo.upsertLesson(l);
    const guard = vi.fn(() => true);
    const report = await promoteToGlobal(repo, global, { shareGlobally: true, guard, repoTerms: ['acme'] });
    const reasons = Object.fromEntries(report.refused.map((r) => [r.lessonId, r.reason]));
    expect(reasons[identifier.id]).toMatch(/camelCase/);
    expect(reasons[path.id]).toMatch(/path-like|file name/);
    expect(reasons[named.id]).toMatch(/repository identifier/);
    expect(guard).not.toHaveBeenCalled();
    expect(global.count()).toBe(0);
  });

  it('refuses when the publication guard refuses, fails or throws, without echoing its findings', async () => {
    const { repo, global } = stores();
    repo.upsertLesson(shareable());
    const refused = await promoteToGlobal(repo, global, { shareGlobally: true, guard: () => ({ allowed: false, rule: 'private-term' }) });
    expect(refused.refused[0]!.reason).toBe('publication guard refused (private-term)');
    const sneaky = await promoteToGlobal(repo, global, { shareGlobally: true, guard: () => ({ allowed: false, rule: 'matched acme internal name' }) });
    expect(sneaky.refused[0]!.reason).toBe('publication guard refused');
    const guardShape = await promoteToGlobal(repo, global, {
      shareGlobally: true,
      guard: () => ({ ok: false, violations: [{ kind: 'term', excerpt: 'x' }, { kind: 'email', excerpt: 'y' }, { kind: 'term', excerpt: 'z' }] }),
    });
    expect(guardShape.refused[0]!.reason).toBe('publication guard refused (email, term)');
    const guardOk = await promoteToGlobal(repo, openStore().store, { shareGlobally: true, guard: () => ({ ok: true, violations: [] }) });
    expect(guardOk.promoted).toHaveLength(1);
    const asyncNo = await promoteToGlobal(repo, global, { shareGlobally: true, guard: async () => false });
    expect(asyncNo.refused[0]!.reason).toBe('publication guard refused');
    const broken = await promoteToGlobal(repo, global, {
      shareGlobally: true,
      guard: () => {
        throw new Error('terms file unreadable');
      },
    });
    expect(broken.refused[0]!.reason).toBe('publication guard failed');
    expect(global.count()).toBe(0);
  });

  it('only promotes the eligible lessons out of a mixed graph', async () => {
    const { repo, global } = stores();
    const good = shareable();
    const bad = makeLesson({ statement: 'Call validateOrder before saving an order.', status: 'validated' });
    repo.upsertLesson(good);
    repo.upsertLesson(bad);
    const report = await promoteToGlobal(repo, global, { shareGlobally: true, guard: () => true });
    expect(report.promoted.map((p) => p.lessonId)).toEqual([good.id]);
    expect(report.refused.map((r) => r.lessonId)).toEqual([bad.id]);
  });
});

describe('toGlobalLesson', () => {
  it('drops supersedes, which points into the source graph', () => {
    const g = toGlobalLesson(makeLesson({ supersedes: 'les-0123456789ab', provenance: { source: 'ingest', uri: 'https://example.test/x', derived_from: ['a'], generated_by: 'm', generated_at: '2026-10-03T00:00:00.000Z' } }));
    expect(g.supersedes).toBeNull();
    expect(g.provenance.uri).toBeNull();
  });
});

describe('promoteToGlobal against the real publication guard (verifier)', () => {
  // Two-word private term written as a test fixture; "acme" is the house example name.
  const terms = parseTerms('acme corp\n').terms;
  const guard = (text: string) => checkPublication(text, { terms });

  it('refuses a private term split across a line break, which JSON escaping would hide', async () => {
    const { repo, global } = stores();
    const lesson = makeLesson({
      statement: 'Bound retries with backoff during an outage.',
      rationale: 'The outage at Acme\nCorp showed that unbounded retries amplify load.',
      status: 'validated',
    });
    repo.upsertLesson(lesson);
    const report = await promoteToGlobal(repo, global, { shareGlobally: true, guard });
    expect(report.promoted).toEqual([]);
    expect(report.refused).toEqual([{ lessonId: lesson.id, reason: 'publication guard refused (term)' }]);
    expect(global.count()).toBe(0);
  });

  it('still promotes clean text through the same guard', async () => {
    const { repo, global } = stores();
    repo.upsertLesson(shareable());
    const report = await promoteToGlobal(repo, global, { shareGlobally: true, guard });
    expect(report.promoted).toHaveLength(1);
  });
});

describe('globalRefusal covers every field that travels (verifier)', () => {
  it.each<[string, Partial<Applicability>]>([
    ['check_ids', { check_ids: ['acme-billing-unit'] }],
    ['frameworks', { frameworks: ['acme-ui-kit'] }],
    ['languages', { languages: ['acme-dsl'] }],
    ['fingerprints', { fingerprints: ['acme-ledger-timeout'] }],
  ])('refuses a repository name in %s', (_field, applicability) => {
    const lesson = makeLesson({ statement: 'Bound retries with backoff during an outage.', status: 'validated', applicability });
    expect(globalRefusal(lesson, ['acme'])).toMatch(/repository identifier/);
  });

  it('refuses a repository name hidden by a zero-width character', () => {
    const lesson = makeLesson({ statement: 'Bound retries in the ac\u200Bme billing flow.', status: 'validated' });
    expect(globalRefusal(lesson, ['acme'])).toMatch(/repository identifier/);
  });
});
