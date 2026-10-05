import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../../../src/storage/db.ts';
import { ManualClock } from '../../../src/core/clock.ts';
import { createRun } from '../../../src/controller/run-store.ts';
import { codeFreeViolations, mentionsRepoTerm } from '../../../src/knowledge/codefree.ts';
import { openKnowledgeDb } from '../../../src/knowledge/db.ts';
import { KNOWLEDGE_MIGRATIONS } from '../../../src/knowledge/schema.ts';
import { learnFromRun } from '../../../src/knowledge/learn.ts';
import type { CuratorTask } from '../../../src/knowledge/curate.ts';
import { asSha256, truncate, unionCapped } from '../../../src/knowledge/text.ts';
import { makeLesson, openStore } from './helpers.ts';

describe('codeFreeViolations edge cases', () => {
  it('accepts single-letter dotted pairs and lowercase.Capital sentence joins as prose', () => {
    expect(codeFreeViolations('Prefer small steps, x.y being a pair of letters in maths notes')).not.toContain('dotted identifier');
    expect(codeFreeViolations('Finish the work.Then run the suite again before you hand back')).not.toContain('dotted identifier');
  });

  it('still flags a real dotted identifier and a short lowercase prefix before a capital', () => {
    expect(codeFreeViolations('Call user.profile before saving')).toContain('dotted identifier');
    expect(codeFreeViolations('See end.Then and also api.Client here')).toContain('dotted identifier');
  });

  it('ignores repo terms shorter than three characters and escapes regex characters', () => {
    expect(mentionsRepoTerm('the ab module', ['ab'])).toBe(false);
    expect(mentionsRepoTerm('uses a+b+ in prose', ['a+b+'])).toBe(true);
    expect(mentionsRepoTerm('nothing here', ['  '])).toBe(false);
  });
});

describe('text helpers boundaries', () => {
  it('truncate handles tiny limits and cuts mid-word when the last space is too early', () => {
    expect(truncate('abcdef', 1)).toBe('a');
    expect(truncate('abcdef', 0)).toBe('');
    expect(truncate('ab cdefghijklmnop', 10)).toBe('ab cdefgh…');
    expect(truncate('abcdefg hij klm', 14)).toBe('abcdefg hij…');
  });

  it('unionCapped stops at the cap and asSha256 accepts only bare or prefixed digests', () => {
    expect(unionCapped(['a', 'b'], ['b', 'c', 'd'], 3)).toEqual(['a', 'b', 'c']);
    expect(asSha256(null)).toBeNull();
    expect(asSha256('sha256:' + 'a'.repeat(64))).toBe('a'.repeat(64));
    expect(asSha256('sha256:short')).toBeNull();
  });
});

describe('openKnowledgeDb', () => {
  it('refuses an async transaction callback and leaves nothing half-committed', () => {
    const db = openKnowledgeDb(':memory:');
    expect(() => db.tx((async () => 1) as unknown as () => number)).toThrow(/must be synchronous/);
    expect(db.tx(() => 7)).toBe(7);
    db.close();
  });

  it('rolls back and rethrows when a migration fails', () => {
    const migrations = KNOWLEDGE_MIGRATIONS as string[];
    migrations.push('THIS IS NOT SQL');
    try {
      expect(() => openKnowledgeDb(':memory:')).toThrow();
    } finally {
      migrations.pop();
    }
  });

  it('tolerates a ROLLBACK that SQLite already performed', () => {
    const db = openKnowledgeDb(':memory:');
    expect(() =>
      db.tx(() => {
        db.raw.exec('ROLLBACK');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.tx(() => 1)).toBe(1);
    db.close();
  });
});

describe('seedLessons invariants', () => {
  afterEach(() => {
    vi.doUnmock('../../../data/seed-practices.json');
    vi.resetModules();
  });

  async function seedsWith(mutate: (doc: { lessons: Record<string, any>[] }) => unknown) {
    const real = (await import('../../../data/seed-practices.json', { with: { type: 'json' } })).default as { lessons: Record<string, any>[] };
    const doc = structuredClone(real);
    const replacement = mutate(doc) ?? doc;
    vi.resetModules();
    vi.doMock('../../../data/seed-practices.json', () => ({ default: replacement }));
    return import('../../../src/knowledge/seed.ts');
  }

  it('rejects a document without a lessons array', async () => {
    const mod = await seedsWith(() => ({ notes: [] }));
    expect(() => mod.seedLessons()).toThrow(/no lessons array/);
  });

  it.each([
    ['source is not seed', (l: Record<string, any>) => (l.provenance.source = 'run')],
    ['status is not validated', (l: Record<string, any>) => (l.status = 'candidate')],
    ['scope is not global', (l: Record<string, any>) => (l.scope = 'repo')],
    ['not code_free', (l: Record<string, any>) => (l.code_free = false)],
    ['has repository paths', (l: Record<string, any>) => (l.applicability.paths = ['src/**'])],
    ['id does not match its statement', (l: Record<string, any>) => (l.id = 'les-000000000000')],
  ])('rejects a seed whose invariant breaks: %s', async (problem, mutate) => {
    const mod = await seedsWith((doc) => {
      mutate(doc.lessons[0]!);
    });
    expect(() => mod.seedLessons()).toThrow(new RegExp(`is invalid: .*${problem}`));
  });
});

function runWithRepair(db: ReturnType<typeof openDb>, runId: string): void {
  createRun(db, { id: runId, repoRoot: '/work/acme', goal: 'g', mode: 'autonomous', policyHash: 'sha256:x', policyPath: '/p' }, new ManualClock());
  for (const seq of [1, 2]) {
    db.run(
      "INSERT INTO candidates (id, run_id, seq, attempt, commit_sha, tree_hash, parent_sha, status, created_at) VALUES (?, ?, ?, ?, 'c', 't', 'b', 'verified', ?)",
      `${runId}-c${seq}`,
      runId,
      seq,
      seq,
      seq,
    );
    db.run(
      "INSERT INTO check_runs (id, run_id, candidate_id, check_id, kind, tree_hash, check_config_hash, policy_hash, command_json, cwd, isolation, status, log_path, fingerprint, started_at) VALUES (?, ?, ?, 'unit', 'command', 't', 'c', 'p', '[]', '.', 'none', ?, ?, ?, ?)",
      `${runId}-k${seq}`,
      runId,
      `${runId}-c${seq}`,
      seq === 1 ? 'FAILED' : 'PASSED',
      `evidence/${seq}/unit.log`,
      seq === 1 ? 'fp-midnight' : null,
      seq,
    );
  }
}

function goodDraft(runId: string) {
  return {
    schema: 'orbit.lesson/1',
    kind: 'repair-recipe',
    statement: 'Pin the clock in tests that format dates near midnight.',
    rationale: 'The unit failure appeared only near midnight.',
    applicability: { languages: [], frameworks: [], paths: [], check_ids: ['unit'], fingerprints: ['fp-midnight'], roles: [], keywords: ['dates'] },
    verification: 'The date tests pass with the clock set just before midnight.',
    evidence: [{ run_id: runId, artifact: 'evidence/1/unit.log', relation: 'supports' }],
    provenance: { source: 'run', uri: null, derived_from: [], generated_by: 'x', generated_at: '2026-10-03T00:00:00.000Z' },
    confidence: 'low',
    code_free: true,
    supersedes: null,
  };
}

describe('learnFromRun edge paths', () => {
  it('shows the curator at most the capped number of similar lessons', async () => {
    const db = openDb(':memory:');
    runWithRepair(db, 'r1');
    const { store, clock } = openStore();
    const many = Array.from({ length: 45 }, (_, i) => makeLesson({ kind: 'repair-recipe', statement: `Existing repair advice number ${i} for midnight date failures.` }));
    store.search = () => many.map((lesson) => ({ lesson, bm25: -1 }));
    let seen = '';
    await learnFromRun({
      store,
      runDb: db,
      runId: 'r1',
      runDir: '/x/r1',
      clock,
      curatorModel: 'm',
      runCurator: async (task: CuratorTask) => {
        seen = task.prompt;
        return { lessons: [], discarded: [] };
      },
    });
    const listed = (seen.match(/"id": "les-[0-9a-f]{12}"/g) ?? []).length;
    expect(listed).toBe(30);
  });

  it('reports a lesson the store refuses as rejected and applies no promotion rules', async () => {
    const db = openDb(':memory:');
    runWithRepair(db, 'r1');
    const { store, clock } = openStore();
    store.upsertLesson = () => {
      throw new Error('disk full');
    };
    const report = await learnFromRun({ store, runDb: db, runId: 'r1', runDir: '/x/r1', clock, curatorModel: 'm', runCurator: async () => ({ lessons: [goodDraft('r1')], discarded: [] }) });
    expect(report.created).toEqual([]);
    expect(report.merged).toEqual([]);
    expect(report.changes).toEqual([]);
    expect(report.rejected).toEqual([{ index: -1, statement: 'Pin the clock in tests that format dates near midnight.', reason: 'disk full' }]);
  });

  it('stringifies a non-Error thrown by the store', async () => {
    const db = openDb(':memory:');
    runWithRepair(db, 'r1');
    const { store, clock } = openStore();
    store.upsertLesson = () => {
      throw 'plain string';
    };
    const report = await learnFromRun({ store, runDb: db, runId: 'r1', runDir: '/x/r1', clock, curatorModel: 'm', runCurator: async () => ({ lessons: [goodDraft('r1')], discarded: [] }) });
    expect(report.rejected[0]?.reason).toBe('plain string');
  });
});
