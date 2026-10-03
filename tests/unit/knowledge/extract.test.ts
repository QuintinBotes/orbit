import { describe, expect, it } from 'vitest';
import { openDb, type OrbitDb } from '../../../src/storage/db.ts';
import { ManualClock } from '../../../src/core/clock.ts';
import { canonicalJson, sha256 } from '../../../src/core/hash.ts';
import { createRun } from '../../../src/controller/run-store.ts';
import { extractObservations } from '../../../src/knowledge/extract.ts';

const RUN_DIR = '/work/acme/.orbit/runs/r1';
const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
// Built at runtime so no address-shaped literal sits in the repository.
const EMAIL = ['dev', 'acme.example'].join('@');
let checkSeq = 0;

function candidate(db: OrbitDb, runId: string, id: string, seq: number, extra: { diff?: unknown; scope?: unknown } = {}) {
  db.run(
    `INSERT INTO candidates (id, run_id, seq, attempt, commit_sha, tree_hash, parent_sha, status, diff_stat_json, scope_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'verified', ?, ?, ?)`,
    id,
    runId,
    seq,
    seq,
    `commit${seq}`,
    `tree${seq}`,
    'base',
    extra.diff === undefined ? null : JSON.stringify(extra.diff),
    extra.scope === undefined ? null : JSON.stringify(extra.scope),
    seq,
  );
}

function check(db: OrbitDb, runId: string, candidateId: string, checkId: string, status: string, fp: string | null = null, opts: { log?: string; sha?: string | null; excerpt?: string } = {}) {
  const id = `chk-${++checkSeq}`;
  db.run(
    `INSERT INTO check_runs (id, run_id, candidate_id, check_id, kind, tree_hash, check_config_hash, policy_hash, command_json, cwd, isolation, status, log_path, log_sha256, fingerprint, excerpt, started_at)
     VALUES (?, ?, ?, ?, 'command', 't', 'c', 'p', '[]', '.', 'none', ?, ?, ?, ?, ?, ?)`,
    id,
    runId,
    candidateId,
    checkId,
    status,
    opts.log ?? null,
    opts.sha === undefined ? null : opts.sha,
    fp,
    opts.excerpt ?? null,
    checkSeq,
  );
  return id;
}

function setup() {
  const db = openDb(':memory:');
  const clock = new ManualClock();
  for (const id of ['r1', 'r2']) createRun(db, { id, repoRoot: '/work/acme', goal: 'g', mode: 'autonomous', policyHash: 'sha256:x', policyPath: '/p' }, clock);

  candidate(db, 'r1', 'c1', 1);
  candidate(db, 'r1', 'c2', 2, { diff: { files: [{ path: 'src/date.ts', added: 3, removed: 1 }], insertions: 3, deletions: 1 } });
  candidate(db, 'r1', 'c3', 3, { scope: { forbidden_paths_changed: ['.github/workflows/ci.yml'], out_of_scope_paths_changed: [], symlinks_escaping: [] } });
  candidate(db, 'r1', 'c4', 4, { diff: { files: ['src/lint-fix.ts'] }, scope: { forbidden_paths_changed: ['.github/workflows/ci.yml'], out_of_scope_paths_changed: ['docs/x.md'] } });

  check(db, 'r1', 'c1', 'unit', 'FAILED', 'fp-unit', { log: `${RUN_DIR}/evidence/1/unit.log`, sha: `sha256:${'c'.repeat(64)}`, excerpt: `expected 2 got 3 with token=${TOKEN} for ${EMAIL}` });
  check(db, 'r1', 'c1', 'lint', 'PASSED');
  check(db, 'r1', 'c2', 'unit', 'PASSED', null, { log: 'evidence/2/unit.log', sha: 'd'.repeat(64) });
  check(db, 'r1', 'c2', 'lint', 'FAILED', 'fp-lint');
  check(db, 'r1', 'c2', 'e2e', 'FAILED', 'fp-e2e');
  check(db, 'r1', 'c3', 'unit', 'PASSED');
  check(db, 'r1', 'c3', 'lint', 'FAILED', 'fp-lint', { log: '/elsewhere/lint.log' });
  check(db, 'r1', 'c4', 'unit', 'PASSED');
  check(db, 'r1', 'c4', 'lint', 'PASSED');

  const failure = (runId: string, candidateId: string | null, source: string, fp: string, excerpt: string) =>
    db.run('INSERT INTO failures (run_id, candidate_id, source, source_id, fingerprint, excerpt, created_at) VALUES (?, ?, ?, ?, ?, ?, 1)', runId, candidateId, source, 'job-1', fp, excerpt);
  failure('r1', 'c1', 'check', 'fp-unit', 'unit failure');
  failure('r1', 'c4', 'ci', 'fp-ci', 'CI: module not found');
  failure('r1', 'c4', 'ci', 'fp-ci', 'CI: module not found again');
  failure('r2', null, 'ci', 'fp-other-run', 'other run');

  db.run("INSERT INTO reviews (id, run_id, candidate_id, tree_hash, round, provider, verdict, packet_sha256, created_at) VALUES ('rv1', 'r1', 'c2', 'tree2', 1, 'codex', 'REPAIR_REQUIRED', ?, 1)", 'e'.repeat(64));
  const finding = (id: string, status: string, claim: string) =>
    db.run(
      "INSERT INTO findings (id, run_id, review_id, severity, category, location, claim, evidence, suggested_validation, status, resolution, created_at, updated_at) VALUES (?, 'r1', 'rv1', 'high', 'authorization', 'src/export.ts:42', ?, 'no tenant predicate', 'add a cross-tenant test', ?, 'added predicate', 1, 1)",
      id,
      claim,
      status,
    );
  finding('f1', 'resolved', 'Export omits tenant scope.');
  finding('f2', 'open', 'Naming is inconsistent.');

  db.run("INSERT INTO decisions (id, run_id, kind, summary, data_json, created_at) VALUES ('d1', 'r1', 'assumption', 'Use UTC for stored timestamps', ?, 1)", JSON.stringify({ evidence: ['existing rows are UTC'] }));
  db.run("INSERT INTO decisions (id, run_id, kind, summary, data_json, created_at) VALUES ('d2', 'r1', 'choice', 'Pick option A', ?, 2)", JSON.stringify({ evidence: '' }));
  db.run("INSERT INTO decisions (id, run_id, kind, summary, data_json, created_at) VALUES ('d3', 'r1', 'choice', 'Pick option B', NULL, 3)");
  db.run(
    "INSERT INTO decisions (id, run_id, kind, summary, data_json, created_at) VALUES ('d4', 'r1', 'policy.deny', 'Edit to a protected path refused', ?, 4)",
    JSON.stringify({ rule: 'scope.protected', path: '.orbit/config.yaml', evidence: 'guard hook' }),
  );
  return db;
}

describe('extractObservations', () => {
  it('finds each kind of observation from verified run records only', () => {
    const db = setup();
    const obs = extractObservations(db, 'r1', RUN_DIR);
    expect(obs.map((o) => `${o.source}:${o.kind}`)).toEqual([
      'failure-repair:repair-recipe',
      'failure-repair:repair-recipe',
      'review-finding:hazard',
      'ci-failure:failure-pattern',
      'decision:convention',
      'scope-denial:hazard',
      'scope-denial:hazard',
      'scope-denial:hazard',
    ]);
    expect(obs.every((o) => o.run_id === 'r1')).toBe(true);
  });

  it('reports a fingerprint cleared at the next candidate with that candidate diff stat', () => {
    const obs = extractObservations(setup(), 'r1', RUN_DIR).filter((o) => o.source === 'failure-repair');
    const unit = obs.find((o) => o.fingerprints[0] === 'fp-unit')!;
    expect(unit.check_ids).toEqual(['unit']);
    expect(unit.detail).toMatchObject({ first_seen_candidate: 1, failing_candidate: 1, fixed_candidate: 2, persisted_candidates: 1 });
    expect(unit.detail.fix_diff_stat).toEqual({ files: [{ path: 'src/date.ts', added: 3, removed: 1 }], insertions: 3, deletions: 1 });
    expect(unit.paths).toEqual(['src/date.ts']);
    // Failing log (absolute, inside the run dir, made relative; prefix stripped), passing log, failure row, candidate row.
    expect(unit.evidence.map((e) => e.artifact)).toEqual(['evidence/1/unit.log', 'evidence/2/unit.log', 'failure:1', 'candidate:c2']);
    expect(unit.evidence[0]!.sha256).toBe('c'.repeat(64));
    expect(unit.evidence[1]!.sha256).toBe('d'.repeat(64));
    expect(unit.evidence.every((e) => e.run_id === 'r1' && e.relation === 'supports')).toBe(true);
  });

  it('handles a failure that persisted before it was fixed, and ignores checks that never ran again', () => {
    const obs = extractObservations(setup(), 'r1', RUN_DIR).filter((o) => o.source === 'failure-repair');
    const lint = obs.find((o) => o.fingerprints[0] === 'fp-lint')!;
    expect(lint.detail).toMatchObject({ first_seen_candidate: 2, failing_candidate: 3, fixed_candidate: 4, persisted_candidates: 2 });
    // A log outside the run directory is referenced by its check run id instead.
    expect(lint.evidence[0]!.artifact).toMatch(/^check_run:chk-/);
    // e2e failed at c2 and never ran again: absence proves nothing.
    expect(obs.some((o) => o.fingerprints.includes('fp-e2e'))).toBe(false);
  });

  it('redacts secrets and emails from excerpts before they reach an observation', () => {
    const obs = extractObservations(setup(), 'r1', RUN_DIR);
    const text = JSON.stringify(obs);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(EMAIL);
    expect(text).toContain('REDACTED');
  });

  it('turns only resolved findings into hazards, with the review packet as evidence', () => {
    const obs = extractObservations(setup(), 'r1', RUN_DIR).filter((o) => o.source === 'review-finding');
    expect(obs).toHaveLength(1);
    expect(obs[0]!.summary).toBe('Export omits tenant scope.');
    expect(obs[0]!.paths).toEqual(['src/export.ts']);
    expect(obs[0]!.evidence.map((e) => e.artifact)).toEqual(['finding:f1', 'review:rv1']);
    expect(obs[0]!.evidence[1]!.sha256).toBe('e'.repeat(64));
  });

  it('groups CI failures by fingerprint and hashes the database rows it cites', () => {
    const db = setup();
    const obs = extractObservations(db, 'r1', RUN_DIR).filter((o) => o.source === 'ci-failure');
    expect(obs).toHaveLength(1);
    expect(obs[0]!.detail).toMatchObject({ fingerprint: 'fp-ci', occurrences: 2 });
    const row = db.get('SELECT id, candidate_id, source, source_id, fingerprint, excerpt, created_at FROM failures WHERE id = 2');
    expect(obs[0]!.evidence[0]).toEqual({ run_id: 'r1', artifact: 'failure:2', sha256: sha256(canonicalJson(row)), relation: 'supports' });
  });

  it('keeps decisions only when they cite evidence, and treats policy denials as hazards', () => {
    const obs = extractObservations(setup(), 'r1', RUN_DIR).filter((o) => o.source === 'decision');
    expect(obs.map((o) => o.summary)).toEqual(['Use UTC for stored timestamps']);
  });

  it('reports scope denials once per category and path set', () => {
    const obs = extractObservations(setup(), 'r1', RUN_DIR).filter((o) => o.source === 'scope-denial');
    const denial = obs.find((o) => o.detail.category === 'policy-denial')!;
    expect(denial).toMatchObject({ summary: 'Edit to a protected path refused', paths: ['.orbit/config.yaml'] });
    expect(denial.detail).toMatchObject({ decision_kind: 'policy.deny', rule: 'scope.protected' });
    expect(denial.evidence[0]!.artifact).toBe('decision:d4');
    const forbidden = obs.find((o) => o.detail.category === 'forbidden')!;
    expect(forbidden.paths).toEqual(['.github/workflows/ci.yml']);
    expect(forbidden.detail.candidates).toEqual([3, 4]);
    expect(forbidden.evidence).toHaveLength(2);
    expect(obs.find((o) => o.detail.category === 'out-of-scope')!.paths).toEqual(['docs/x.md']);
  });

  it('is deterministic and scoped to the requested run', () => {
    const db = setup();
    expect(extractObservations(db, 'r1', RUN_DIR)).toEqual(extractObservations(db, 'r1', RUN_DIR));
    expect(new Set(extractObservations(db, 'r1', RUN_DIR).map((o) => o.id)).size).toBe(8);
    const other = extractObservations(db, 'r2', '/work/acme/.orbit/runs/r2');
    expect(other.map((o) => o.fingerprints)).toEqual([['fp-other-run']]);
    expect(extractObservations(db, 'missing', '/x')).toEqual([]);
  });
});

describe('repair detection needs a verified, clean rerun (verifier)', () => {
  function twoCandidates() {
    const db = openDb(':memory:');
    createRun(db, { id: 'r1', repoRoot: '/work/acme', goal: 'g', mode: 'autonomous', policyHash: 'sha256:x', policyPath: '/p' }, new ManualClock());
    candidate(db, 'r1', 'c1', 1);
    candidate(db, 'r1', 'c2', 2, { diff: { files: ['src/a.ts'] } });
    return db;
  }
  const failureRow = (db: OrbitDb, candidateId: string, source: string, sourceId: string | null, fp: string) =>
    db.run('INSERT INTO failures (run_id, candidate_id, source, source_id, fingerprint, excerpt, created_at) VALUES (?, ?, ?, ?, ?, NULL, 1)', 'r1', candidateId, source, sourceId, fp);
  const flaky = (db: OrbitDb, checkRunId: string) => db.run('UPDATE check_runs SET flaky = 1 WHERE id = ?', checkRunId);
  const repairs = (db: OrbitDb) => extractObservations(db, 'r1', RUN_DIR).filter((o) => o.source === 'failure-repair');

  it('does not call a fingerprint repaired when no check that produced it ran again', () => {
    const db = twoCandidates();
    // Recorded by some other source (a UI journey, a diagnosis) with no check behind it.
    failureRow(db, 'c1', 'ui', 'journey-1', 'fp-ui-only');
    check(db, 'r1', 'c1', 'unit', 'PASSED');
    check(db, 'r1', 'c2', 'unit', 'PASSED');
    expect(repairs(db)).toEqual([]);
  });

  it('follows a failure row to the check run it came from', () => {
    const db = twoCandidates();
    const failing = check(db, 'r1', 'c1', 'unit', 'FAILED');
    failureRow(db, 'c1', 'check', failing, 'fp-from-row');
    check(db, 'r1', 'c2', 'unit', 'PASSED');
    const [repair] = repairs(db);
    expect(repair).toMatchObject({ fingerprints: ['fp-from-row'], check_ids: ['unit'] });
  });

  it('does not count a pass that needed a rerun (flaky) as the repair', () => {
    const db = twoCandidates();
    check(db, 'r1', 'c1', 'unit', 'FAILED', 'fp-f');
    flaky(db, check(db, 'r1', 'c2', 'unit', 'PASSED'));
    expect(repairs(db)).toEqual([]);
  });

  it('does not count a failure that also passed at the same candidate (instability) as repaired', () => {
    const db = twoCandidates();
    check(db, 'r1', 'c1', 'unit', 'FAILED', 'fp-g');
    flaky(db, check(db, 'r1', 'c1', 'unit', 'PASSED'));
    check(db, 'r1', 'c2', 'unit', 'PASSED');
    expect(repairs(db)).toEqual([]);
  });

  it.each(['CANCELLED', 'ERROR'])('does not treat a %s check as a failure the next candidate repaired', (status) => {
    const db = twoCandidates();
    check(db, 'r1', 'c1', 'unit', status, 'fp-infra');
    check(db, 'r1', 'c2', 'unit', 'PASSED');
    expect(repairs(db)).toEqual([]);
  });

  it('still reports a timeout cleared by the next candidate', () => {
    const db = twoCandidates();
    check(db, 'r1', 'c1', 'unit', 'TIMEOUT', 'fp-slow');
    check(db, 'r1', 'c2', 'unit', 'PASSED');
    expect(repairs(db).map((o) => o.fingerprints)).toEqual([['fp-slow']]);
  });
});
