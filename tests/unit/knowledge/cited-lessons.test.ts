/** Issue #173: lessons that are cited, re-checked, contradicted and expired. */
import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { openDb, type OrbitDb } from '../../../src/storage/db.ts';
import { ManualClock } from '../../../src/core/clock.ts';
import { isOrbitError } from '../../../src/core/errors.ts';
import { createRun } from '../../../src/controller/run-store.ts';
import { KnowledgeStore } from '../../../src/knowledge/store.ts';
import { KNOWLEDGE_MIGRATIONS } from '../../../src/knowledge/schema.ts';
import { citationProblem, recheckLessons } from '../../../src/knowledge/recheck.ts';
import { retrieve } from '../../../src/knowledge/retrieve.ts';
import { settleRun, touchesLesson } from '../../../src/knowledge/feedback.ts';
import { contradictedLessons, runEndObservation, touchedArea, type Observation } from '../../../src/knowledge/extract.ts';
import { citationFor } from '../../../src/knowledge/curate.ts';
import { decideAdoption } from '../../../src/knowledge/overlays.ts';
import type { Citation, RetrievalContext } from '../../../src/knowledge/types.ts';
import { ev, makeLesson, openStore } from './helpers.ts';

const DAY = 24 * 3_600_000;
const cite = (over: Partial<Citation> = {}): Citation => ({ run_id: 'r1', path: 'src/calc.ts', line: null, check_id: null, finding_id: null, ...over });

function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-cited-')));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'calc.ts'), 'one\ntwo\nthree\n');
  return root;
}

describe('citationProblem (FR-002)', () => {
  const root = repo();
  const env = { root, checkIds: ['unit'] };
  it.each([
    ['a file that exists', cite(), null],
    ['a line inside the file', cite({ line: 3 }), null],
    ['a configured check', cite({ path: null, check_id: 'unit' }), null],
    ['a file that is gone', cite({ path: 'src/gone.ts' }), 'cited path src/gone.ts no longer exists'],
    ['a directory, not a file', cite({ path: 'src' }), 'cited path src no longer exists'],
    ['a line past the end of the file', cite({ line: 9 }), 'cited line src/calc.ts:9 no longer exists'],
    ['the line after the final newline', cite({ line: 4 }), 'cited line src/calc.ts:4 no longer exists'],
    ['a check no longer configured', cite({ path: null, check_id: 'lint' }), 'cited check lint is no longer configured'],
    ['a path outside the repository', cite({ path: '../elsewhere.ts' }), 'cited path ../elsewhere.ts is outside the repository'],
    ['a citation with only a finding', cite({ path: null, finding_id: 'F-1' }), 'it cites no file or check to re-check'],
  ] as const)('%s', (_name, citation, problem) => {
    expect(citationProblem(makeLesson({ citation }), env)).toBe(problem);
  });

  it.skipIf(process.getuid?.() === 0)('a cited file that cannot be read makes that lesson stale, not the whole re-check fail', () => {
    const root = repo();
    writeFileSync(join(root, 'src', 'locked.ts'), 'one\n');
    chmodSync(join(root, 'src', 'locked.ts'), 0o000);
    const { store } = openStore();
    const locked = store.upsertLesson(makeLesson({ statement: 'Name each calculator test after its operation.', citation: cite({ path: 'src/locked.ts', line: 1 }) })).lesson;
    const kept = store.upsertLesson(makeLesson({ citation: cite({ line: 1 }) })).lesson;
    expect(recheckLessons(store, [locked, kept], { root, checkIds: [], expiryDays: 28 }).map((l) => l.id)).toEqual([kept.id]);
    expect(store.freshness([locked.id]).get(locked.id)?.stale_reason).toBe('cited path src/locked.ts cannot be read');
  });

  it('a run lesson without a citation cannot be re-checked; a seed or ingested lesson cites its source, not the repository', () => {
    expect(citationProblem(makeLesson(), env)).toBe('it cites no file or check to re-check');
    expect(citationProblem(makeLesson({ provenance: { source: 'seed', uri: null, derived_from: [], generated_by: 'orbit', generated_at: '2026-10-03T00:00:00.000Z' } }), env)).toBeNull();
  });
});

describe('retrieval re-checks each lesson first (User Story 1)', () => {
  const ctx = (root: string): RetrievalContext => ({ runId: 'run-x', workerId: 'w', role: 'implementer', goal: 'fix the calculator', paths: [], checkIds: ['unit'], fingerprints: [], languages: [], maxTokens: 800, recheck: { root, checkIds: ['unit'], expiryDays: 28 } });
  const validated = (citation: Citation | null, statement = 'Keep each calculator operation in its own function.') => makeLesson({ statement, status: 'validated', evidence: [ev('r1'), ev('r2')], applicability: { check_ids: ['unit'] }, citation });

  it('scenario 1: a lesson citing a path that no longer exists is skipped and marked stale', () => {
    const root = repo();
    const { store } = openStore();
    const kept = store.upsertLesson(validated(cite())).lesson;
    const gone = store.upsertLesson(validated(cite({ path: 'src/gone.ts' }), 'Name each calculator test after its operation.')).lesson;
    expect(retrieve(store, ctx(root)).map((r) => r.lesson.id)).toEqual([kept.id]);
    expect(store.freshness([gone.id]).get(gone.id)).toMatchObject({ stale_reason: 'cited path src/gone.ts no longer exists', verified_at: null });
    expect(store.freshness([kept.id]).get(kept.id)).toMatchObject({ stale_reason: null, verified_at: store.clock.now() });
    expect(store.events(gone.id).at(-1)).toMatchObject({ type: 'stale', data: { reason: 'cited path src/gone.ts no longer exists' } });
    // Without the re-check (no `recheck` in the context) retrieval ranks as before.
    expect(retrieve(store, { ...ctx(root), recheck: undefined }).map((r) => r.lesson.id).sort()).toEqual([kept.id, gone.id].sort());
  });

  it('scenario 2: a lesson with no support for the expiry period is not eligible, and new support makes it eligible again', () => {
    const root = repo();
    const { store, clock } = openStore();
    const lesson = store.upsertLesson(validated(cite())).lesson;
    clock.advance(28 * DAY);
    expect(retrieve(store, ctx(root))).toHaveLength(1);
    clock.advance(DAY);
    expect(retrieve(store, ctx(root))).toEqual([]);
    expect(store.freshness([lesson.id]).get(lesson.id)?.stale_reason).toBe('expired: no support for 29 days (limit 28)');
    store.addEvidence(lesson.id, ev('r3', 'final.md'));
    expect(retrieve(store, ctx(root)).map((r) => r.lesson.id)).toEqual([lesson.id]);
    expect(store.events(lesson.id).map((e) => e.type).slice(-2)).toEqual(['evidence', 'fresh']);
  });

  it('a verdict that does not change writes no new event: the store is changed item by item, never rewritten', () => {
    const root = repo();
    const { store } = openStore();
    const lesson = store.upsertLesson(validated(cite({ path: 'src/gone.ts' }))).lesson;
    const json = () => store.db.get<{ lesson_json: string }>('SELECT lesson_json FROM nodes WHERE id = ?', lesson.id)!.lesson_json;
    const before = json();
    for (let i = 0; i < 3; i++) recheckLessons(store, [lesson], { root, checkIds: [], expiryDays: 28 });
    expect(store.events(lesson.id).filter((e) => e.type === 'stale')).toHaveLength(1);
    expect(json()).toBe(before);
  });
});

describe('the store refuses a lesson that names a secret or a person at write time', () => {
  const address = ['someone', 'example.test'].join('@');
  it.each([
    ['a token', `Rotate the token ghp_${'A1b2C3d4E5'.repeat(4)} after each release.`],
    ['an email address', `Ask ${address} before changing the release scripts.`],
    ['text curation already masked', 'Rotate the token [REDACTED:github-token] after each release.'],
  ])('%s', (_name, statement) => {
    const { store } = openStore();
    try {
      store.upsertLesson(makeLesson({ statement }));
      expect.unreachable();
    } catch (err) {
      expect(isOrbitError(err, 'POLICY_DENIED')).toBe(true);
      expect((err as Error).message).toMatch(/names a secret or a person/);
    }
    expect(store.count()).toBe(0);
  });
});

describe('knowledge migration 2', () => {
  it('upgrades a version 1 graph in place and keeps its lessons', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-kmig-')));
    const path = join(dir, 'knowledge.sqlite');
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const raw = new DatabaseSync(path);
    raw.exec(KNOWLEDGE_MIGRATIONS[0]!);
    const lesson = makeLesson();
    raw.prepare("INSERT INTO nodes (id, norm_key, kind, status, scope, confidence, code_free, source, statement, lesson_json, created_at, updated_at) VALUES (?, 'k', 'practice', 'candidate', 'repo', 'medium', 1, 'run', ?, ?, 5, 5)").run(lesson.id, lesson.statement, JSON.stringify(lesson));
    raw.exec('PRAGMA user_version = 1');
    raw.close();
    const store = KnowledgeStore.open(path, { clock: new ManualClock() });
    expect(store.getLesson(lesson.id)).toEqual(lesson);
    expect(store.freshness([lesson.id]).get(lesson.id)).toEqual({ created_at: 5, last_support_at: 5, verified_at: null, stale_reason: null });
    expect(store.observations()).toEqual([]);
    store.close();
  });
});

function runDb(): OrbitDb {
  const db = openDb(':memory:');
  createRun(db, { id: 'r1', repoRoot: '/repo', goal: 'g', mode: 'autonomous', policyHash: 'sha256:x', policyPath: '/p' }, new ManualClock());
  return db;
}
let seq = 0;
function candidate(db: OrbitDb, id: string, n: number, workerId: string | null, paths: string[] = []): void {
  db.run("INSERT INTO candidates (id, run_id, seq, attempt, worker_id, commit_sha, tree_hash, parent_sha, status, diff_stat_json, created_at) VALUES (?, 'r1', ?, ?, ?, 'c', ?, 'b', 'verified', ?, 1)", id, n, n, workerId, `t${n}`, JSON.stringify({ files: paths.length, paths }));
}
function check(db: OrbitDb, candidateId: string | null, checkId: string, status: string, fp: string | null): void {
  db.run("INSERT INTO check_runs (id, run_id, candidate_id, check_id, kind, tree_hash, check_config_hash, policy_hash, command_json, cwd, isolation, status, fingerprint, started_at) VALUES (?, 'r1', ?, ?, 'command', 't', 'c', 'p', '[]', '.', 'none', ?, ?, ?)", `chk-${++seq}`, candidateId, checkId, status, fp, seq);
}
const row = (lesson_id: string, worker_id: string | null, fingerprints: string[]) => ({ run_id: 'r1', worker_id, lesson_id, ts: 1, score: 1, outcome: null, attempts: null, fingerprints });

describe('contradictions from run evidence (FR-004, User Story 2)', () => {
  it('scenario 1: a lesson shown to a worker repairing a fingerprint is contradicted when that worker\'s candidate fails with it again', () => {
    const db = runDb();
    candidate(db, 'c1', 1, 'w1');
    candidate(db, 'c2', 2, 'w2');
    candidate(db, 'c3', 3, 'w3');
    check(db, 'c1', 'unit', 'FAILED', 'fp-a');
    check(db, 'c2', 'unit', 'FAILED', 'fp-a');
    check(db, 'c3', 'unit', 'TIMEOUT', 'fp-b');
    db.run("INSERT INTO failures (run_id, candidate_id, source, source_id, fingerprint, excerpt, created_at) VALUES ('r1', 'c3', 'ci', 'job', 'fp-c', 'x', 1)");
    const out = contradictedLessons(db, 'r1', [
      row('les-repeated', 'w2', ['fp-a']), // w2 repaired fp-a and its candidate failed with fp-a again
      row('les-other-fp', 'w3', ['fp-a']), // w3 failed, but with another fingerprint
      row('les-ci-only', 'w3', ['fp-c']), // a CI failure is not the candidate's check failing again
      row('les-no-repair', 'w2', []), // shown to a first attempt, not a repair
      row('les-no-candidate', 'w9', ['fp-a']),
    ]);
    expect(out).toEqual(['les-repeated']);
  });

  it('scenario 2: two contradictions from distinct runs deprecate a lesson, which retrieval then never returns', () => {
    const { store } = openStore();
    const lesson = store.upsertLesson(makeLesson({ status: 'validated', evidence: [ev('r1'), ev('r2'), ev('r3')] })).lesson;
    settleRun(store, 'r4', { succeeded: false, attempts: 2, verifiedCriteria: [], contradictedLessonIds: [lesson.id] });
    expect(store.getLesson(lesson.id)!.status).toBe('validated');
    const second = settleRun(store, 'r5', { succeeded: false, attempts: 2, verifiedCriteria: [], contradictedLessonIds: [lesson.id] });
    expect(second.changes).toEqual([{ lessonId: lesson.id, from: 'validated', to: 'deprecated', rule: 'deprecate.contradicted-twice' }]);
    expect(retrieve(store, { runId: 'r6', workerId: 'w', role: 'implementer', goal: lesson.statement, paths: [], checkIds: [], fingerprints: [], languages: [], maxTokens: 800 })).toEqual([]);
  });
});

describe('support only where the attempt touched the cited area (FR-005)', () => {
  it('touchedArea is the changed files of every candidate and the checks that failed on one', () => {
    const db = runDb();
    candidate(db, 'c1', 1, 'w1', ['src/a.ts']);
    candidate(db, 'c2', 2, 'w2', ['src/a.ts', 'src/b.ts']);
    check(db, 'c1', 'unit', 'FAILED', 'fp');
    check(db, 'c1', 'lint', 'PASSED', null);
    check(db, null, 'e2e', 'FAILED', 'fp-base');
    expect(touchedArea(db, 'r1')).toEqual({ paths: ['src/a.ts', 'src/b.ts'], checkIds: ['unit'] });
  });

  it.each([
    ['the cited file', { citation: cite({ path: 'src/a.ts' }) }, true],
    ['a path glob', { applicability: { paths: ['src/**'] } }, true],
    ['the cited check', { citation: cite({ path: null, check_id: 'unit' }) }, true],
    ['a check in its applicability', { applicability: { check_ids: ['unit'] } }, true],
    ['another file', { citation: cite({ path: 'src/z.ts' }) }, false],
    ['a check that did not fail', { applicability: { check_ids: ['lint'] } }, false],
    ['nothing at all', {}, false],
  ] as const)('a lesson citing %s: %s', (_name, over, touched) => {
    expect(touchesLesson(makeLesson(over as never), { paths: ['src/a.ts'], checkIds: ['unit'] })).toBe(touched);
  });

  it('settleRun credits only the retrieved lessons whose area the run touched', () => {
    const { store } = openStore();
    const touched = store.upsertLesson(makeLesson({ citation: cite({ path: 'src/a.ts' }) })).lesson;
    const elsewhere = store.upsertLesson(makeLesson({ statement: 'Name each calculator test after its operation.', citation: cite({ path: 'src/z.ts' }) })).lesson;
    store.recordRetrievals('r2', 'w1', [{ lessonId: touched.id, score: 1 }, { lessonId: elsewhere.id, score: 1 }]);
    const report = settleRun(store, 'r2', { succeeded: true, attempts: 1, verifiedCriteria: ['AC-1'], contradictedLessonIds: [], touched: { paths: ['src/a.ts'], checkIds: [] } });
    expect(report.supported).toEqual([touched.id]);
  });
});

describe('runEndObservation (FR-006, User Story 3)', () => {
  it('names each check and signature of a baseline block, with no candidate', () => {
    const db = runDb();
    db.run("UPDATE runs SET state = 'BLOCKED', failure_class = 'check-misconfigured', failure_secondary = 'environment', outcome_json = ? WHERE id = 'r1'", JSON.stringify({
      environment_failures: [{ check_id: 'unit', signals: ['dns-failure'], cause: 'network' }],
      incomplete_checks: [{ check_id: 'e2e', cause: 'no browser' }],
      misconfigured_checks: [{ check_id: 'lint', signature: 'unknown option --fix-all' }, 'not a record'],
    }));
    expect(runEndObservation(db, 'r1')).toMatchObject({
      run_id: 'r1',
      state: 'BLOCKED',
      failure_class: 'check-misconfigured',
      failure_secondary: 'environment',
      checks: [
        { check_id: 'e2e', signature: 'no browser' },
        { check_id: 'lint', signature: 'unknown option --fix-all' },
        { check_id: 'unit', signature: 'dns-failure' },
      ],
    });
  });

  it('reads the checks that did not pass on the last candidate; none for a run that succeeded or has not ended', () => {
    const db = runDb();
    expect(runEndObservation(db, 'r1')).toBeNull();
    candidate(db, 'c1', 1, 'w1');
    candidate(db, 'c2', 2, 'w2');
    check(db, 'c1', 'unit', 'FAILED', 'fp-old');
    check(db, 'c2', 'unit', 'ERROR', null);
    check(db, 'c2', 'lint', 'PASSED', null);
    db.run("UPDATE runs SET state = 'EXHAUSTED', failure_class = 'budget' WHERE id = 'r1'");
    const obs = runEndObservation(db, 'r1');
    expect(obs?.checks).toEqual([{ check_id: 'unit', signature: 'ERROR' }]);
    expect(runEndObservation(db, 'r1')?.id).toBe(obs?.id);
    db.run("UPDATE runs SET state = 'SUCCEEDED', failure_class = NULL WHERE id = 'r1'");
    expect(runEndObservation(db, 'r1')).toBeNull();
  });

  it('keeps each ending of a run resumed from BLOCKED', () => {
    const db = runDb();
    const { store } = openStore();
    db.run("UPDATE runs SET state = 'BLOCKED', failure_class = 'environment', ended_at = 1 WHERE id = 'r1'");
    expect(store.recordObservation(runEndObservation(db, 'r1')!)).toBe(true);
    db.run("UPDATE runs SET state = 'EXHAUSTED', failure_class = 'budget', ended_at = 2 WHERE id = 'r1'");
    expect(store.recordObservation(runEndObservation(db, 'r1')!)).toBe(true);
    expect(store.observations().map((o) => o.failure_class).sort()).toEqual(['budget', 'environment']);
  });
});

describe('citationFor (FR-001)', () => {
  const obs = (over: Partial<Observation>): Observation => ({ id: 'obs-1', run_id: 'r1', source: 'decision', kind: 'convention', summary: 's', detail: {}, fingerprints: [], check_ids: [], paths: [], evidence: [], ...over });
  it('cites the file and line and the finding of a review finding', () => {
    expect(citationFor([obs({ source: 'review-finding', paths: ['src/calc.ts'], detail: { location: 'src/calc.ts:12:4' }, evidence: [{ run_id: 'r1', artifact: 'finding:F-7', sha256: null, relation: 'supports' }] })])).toEqual({ run_id: 'r1', path: 'src/calc.ts', line: 12, check_id: null, finding_id: 'F-7' });
  });
  it('cites the check and the changed file of a repair, preferring an observation that names one', () => {
    expect(citationFor([obs({ run_id: 'r0' }), obs({ source: 'failure-repair', check_ids: ['unit'], paths: ['src/calc.ts'] })])).toEqual({ run_id: 'r1', path: 'src/calc.ts', line: null, check_id: 'unit', finding_id: null });
  });
  it('cites the run alone when nothing names a file or a check, and nothing without observations', () => {
    expect(citationFor([obs({ run_id: 'r0' })])).toEqual({ run_id: 'r0', path: null, line: null, check_id: null, finding_id: null });
    expect(citationFor([])).toBeNull();
  });
});

describe('decideAdoption with the held-out scenarios (FR-007)', () => {
  const m = { verified_pass_rate: 0.5, mean_attempts: 1, mean_cost_usd: 1, false_pass_rate: 0 };
  const better = { ...m, verified_pass_rate: 0.9 };
  it('refuses a lower held-out pass rate however the replay went, and an invalid held-out result', () => {
    expect(decideAdoption({ cases: 5, baseline: m, candidate: better, held_out: { suite_id: 's', scenarios: 10, baseline_pass_rate: 0.6, candidate_pass_rate: 0.5 } })).toMatchObject({ adopt: false, reason: expect.stringMatching(/held-out scenarios regressed/) });
    expect(decideAdoption({ cases: 5, baseline: m, candidate: better, held_out: { suite_id: 's', scenarios: 0, baseline_pass_rate: 0.6, candidate_pass_rate: 0.7 } })).toMatchObject({ adopt: false, reason: 'the held-out benchmark result is invalid' });
    expect(decideAdoption({ cases: 5, baseline: m, candidate: better, held_out: { suite_id: 's', scenarios: 10, baseline_pass_rate: Number.NaN, candidate_pass_rate: 0.7 } }).adopt).toBe(false);
    expect(decideAdoption({ cases: 5, baseline: m, candidate: better, held_out: { suite_id: 's', scenarios: 10, baseline_pass_rate: 0.6, candidate_pass_rate: 0.6 } }).adopt).toBe(true);
  });
});
