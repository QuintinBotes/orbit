import { describe, expect, it } from 'vitest';
import { openDb, type OrbitDb } from '../../../src/storage/db.ts';
import { ManualClock } from '../../../src/core/clock.ts';
import { createRun } from '../../../src/controller/run-store.ts';
import { extractObservations } from '../../../src/knowledge/extract.ts';

const RUN_DIR = '/work/acme/.orbit/runs/r1';
let seq = 0;

function freshDb(): OrbitDb {
  const db = openDb(':memory:');
  createRun(db, { id: 'r1', repoRoot: '/work/acme', goal: 'g', mode: 'autonomous', policyHash: 'sha256:x', policyPath: '/p' }, new ManualClock());
  return db;
}

function candidate(db: OrbitDb, id: string, n: number, diff: string | null = null, scope: string | null = null): void {
  db.run(
    "INSERT INTO candidates (id, run_id, seq, attempt, commit_sha, tree_hash, parent_sha, status, diff_stat_json, scope_json, created_at) VALUES (?, 'r1', ?, ?, 'c', 't', 'b', 'verified', ?, ?, ?)",
    id,
    n,
    n,
    diff,
    scope,
    n,
  );
}

function check(db: OrbitDb, candidateId: string, checkId: string, status: string, fp: string | null = null, log: string | null = null): string {
  const id = `chk-${++seq}`;
  db.run(
    "INSERT INTO check_runs (id, run_id, candidate_id, check_id, kind, tree_hash, check_config_hash, policy_hash, command_json, cwd, isolation, status, log_path, fingerprint, started_at) VALUES (?, 'r1', ?, ?, 'command', 't', 'c', 'p', '[]', '.', 'none', ?, ?, ?, ?)",
    id,
    candidateId,
    checkId,
    status,
    log,
    fp,
    seq,
  );
  return id;
}

const repairs = (db: OrbitDb) => extractObservations(db, 'r1', RUN_DIR).filter((o) => o.source === 'failure-repair');

describe('repair extraction edge cases', () => {
  it('does not bridge a gap in candidate sequence numbers', () => {
    const db = freshDb();
    candidate(db, 'c1', 1);
    candidate(db, 'c3', 3);
    check(db, 'c1', 'unit', 'FAILED', 'fp-gap');
    check(db, 'c3', 'unit', 'PASSED');
    expect(repairs(db)).toEqual([]);
  });

  it('reports nothing when the next candidate ran no checks at all', () => {
    const db = freshDb();
    candidate(db, 'c1', 1);
    candidate(db, 'c2', 2);
    check(db, 'c1', 'unit', 'FAILED', 'fp-unrun');
    expect(repairs(db)).toEqual([]);
  });

  it('does not call it repaired when the same check failed again at the next candidate', () => {
    const db = freshDb();
    candidate(db, 'c1', 1);
    candidate(db, 'c2', 2);
    check(db, 'c1', 'unit', 'FAILED', 'fp-old');
    check(db, 'c2', 'unit', 'PASSED');
    check(db, 'c2', 'unit', 'FAILED', 'fp-new');
    expect(repairs(db)).toEqual([]);
  });

  it('ignores check runs and failures tied to a candidate outside the run', () => {
    const db = freshDb();
    candidate(db, 'c1', 1);
    candidate(db, 'c2', 2);
    check(db, 'ghost', 'unit', 'FAILED', 'fp-ghost');
    db.run("INSERT INTO failures (run_id, candidate_id, source, source_id, fingerprint, excerpt, created_at) VALUES ('r1', 'ghost', 'check', NULL, 'fp-ghost', NULL, 1)");
    check(db, 'c2', 'unit', 'PASSED');
    expect(repairs(db)).toEqual([]);
  });

  it('ties a failure row without a source_id to nothing, so no repair is claimed', () => {
    const db = freshDb();
    candidate(db, 'c1', 1);
    candidate(db, 'c2', 2);
    db.run("INSERT INTO failures (run_id, candidate_id, source, source_id, fingerprint, excerpt, created_at) VALUES ('r1', 'c1', 'check', NULL, 'fp-orphan', 'boom', 1)");
    check(db, 'c2', 'unit', 'PASSED');
    expect(repairs(db)).toEqual([]);
  });

  it('survives unparsable and shapeless diff stats', () => {
    const db = freshDb();
    candidate(db, 'c1', 1);
    candidate(db, 'c2', 2, 'not json at all');
    check(db, 'c1', 'unit', 'FAILED', 'fp-a');
    check(db, 'c2', 'unit', 'PASSED');
    const [obs] = repairs(db);
    expect(obs?.paths).toEqual([]);
    expect(obs?.detail.fix_diff_stat).toBeNull();
  });

  it('reads paths from a {paths: []} diff stat and ignores entries that are not paths', () => {
    const db = freshDb();
    candidate(db, 'c1', 1);
    candidate(db, 'c2', 2, JSON.stringify({ paths: ['src/a.ts', 42, { nope: true }, { path: 'src/b.ts' }] }));
    check(db, 'c1', 'unit', 'FAILED', 'fp-p');
    check(db, 'c2', 'unit', 'PASSED');
    expect(repairs(db)[0]?.paths).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('gives a diff stat with neither files nor paths no paths', () => {
    const db = freshDb();
    candidate(db, 'c1', 1);
    candidate(db, 'c2', 2, JSON.stringify({ insertions: 1 }));
    check(db, 'c1', 'unit', 'FAILED', 'fp-n');
    check(db, 'c2', 'unit', 'PASSED');
    expect(repairs(db)[0]?.paths).toEqual([]);
    expect(repairs(db)[0]?.detail.fix_diff_stat).toEqual({ insertions: 1 });
  });

  it('keeps only totals and a file count when the diff stat is too large to embed', () => {
    const db = freshDb();
    candidate(db, 'c1', 1);
    const files = Array.from({ length: 150 }, (_, i) => ({ path: `src/module-${i}/file-${i}.ts`, added: i, removed: 0 }));
    candidate(db, 'c2', 2, JSON.stringify({ files, insertions: 900, deletions: 4, label: 'x' }));
    check(db, 'c1', 'unit', 'FAILED', 'fp-big');
    check(db, 'c2', 'unit', 'PASSED');
    const [obs] = repairs(db);
    expect(obs?.detail.fix_diff_stat).toEqual({ insertions: 900, deletions: 4, files_listed: 20, truncated: true });
    expect(obs?.paths).toHaveLength(20);
  });

  it('collapses duplicate evidence when two failing checks share one log', () => {
    const db = freshDb();
    candidate(db, 'c1', 1);
    candidate(db, 'c2', 2);
    check(db, 'c1', 'unit', 'FAILED', 'fp-shared', 'evidence/1/shared.log');
    check(db, 'c1', 'unit', 'FAILED', 'fp-shared', 'evidence/1/shared.log');
    check(db, 'c2', 'unit', 'PASSED');
    const artifacts = repairs(db)[0]!.evidence.map((e) => e.artifact);
    expect(artifacts.filter((a) => a === 'evidence/1/shared.log')).toHaveLength(1);
  });
});

describe('finding, ci, decision and scope extraction edge cases', () => {
  function withReview(db: OrbitDb): void {
    db.run("INSERT INTO reviews (id, run_id, candidate_id, tree_hash, round, provider, verdict, packet_sha256, created_at) VALUES ('rv1', 'r1', 'c0', 't', 1, 'codex', 'REPAIR_REQUIRED', NULL, 1)");
  }
  function finding(db: OrbitDb, id: string, location: string | null, evidence: string | null = null): void {
    db.run(
      "INSERT INTO findings (id, run_id, review_id, severity, category, location, claim, evidence, suggested_validation, status, resolution, created_at, updated_at) VALUES (?, 'r1', 'rv1', 'low', NULL, ?, 'A claim to keep.', ?, NULL, 'resolved', NULL, 1, 1)",
      id,
      location,
      evidence,
    );
  }

  it('derives a path from a finding location only when it is a single token, and drops line suffixes', () => {
    const db = freshDb();
    withReview(db);
    finding(db, 'f1', null);
    finding(db, 'f2', 'around the export code');
    finding(db, 'f3', 'src/export.ts:42:7');
    finding(db, 'f4', '   ');
    const obs = extractObservations(db, 'r1', RUN_DIR).filter((o) => o.source === 'review-finding');
    expect(obs.map((o) => o.paths).sort()).toEqual([[], [], [], ['src/export.ts']]);
    // No packet hash on the review: the finding row is the only evidence.
    expect(obs.every((o) => o.evidence.length === 1)).toBe(true);
  });

  it('labels a CI failure with its fingerprint when no excerpt was kept', () => {
    const db = freshDb();
    db.run("INSERT INTO failures (run_id, candidate_id, source, source_id, fingerprint, excerpt, created_at) VALUES ('r1', NULL, 'ci', NULL, 'fp-silent', NULL, 1)");
    const [obs] = extractObservations(db, 'r1', RUN_DIR);
    expect(obs?.summary).toBe('CI failure fp-silent');
    expect(obs?.detail.ci_sources).toEqual([]);
  });

  it('keeps an evidence-bearing decision whatever shape the evidence takes, and drops the rest', () => {
    const db = freshDb();
    const decision = (id: string, data: string | null, n: number) =>
      db.run("INSERT INTO decisions (id, run_id, kind, summary, data_json, created_at) VALUES (?, 'r1', 'choice', ?, ?, ?)", id, `Decision ${id}`, data, n);
    decision('d1', JSON.stringify({ evidence: ['plain text', { measured: 3 }] }), 1);
    decision('d2', JSON.stringify({ evidence: [] }), 2);
    decision('d3', JSON.stringify({ evidence: 12 }), 3);
    decision('d4', JSON.stringify('just a string'), 4);
    decision('d5', '{not json', 5);
    decision('d6', JSON.stringify({ evidence: '  \n ' }), 6);
    const obs = extractObservations(db, 'r1', RUN_DIR).filter((o) => o.source === 'decision');
    expect(obs).toHaveLength(1);
    expect(obs[0]?.summary).toBe('Decision d1');
    expect(obs[0]?.detail.evidence).toBe('plain text; {"measured":3}');
  });

  it('records a policy denial with whatever fields it carried', () => {
    const db = freshDb();
    const denial = (id: string, kind: string, data: string | null, n: number) =>
      db.run("INSERT INTO decisions (id, run_id, kind, summary, data_json, created_at) VALUES (?, 'r1', ?, ?, ?, ?)", id, kind, `Denied ${id}`, data, n);
    denial('d1', 'policy.deny', null, 1);
    denial('d2', 'policy.deny.path', JSON.stringify({ rule: 7, reason: ['x'], paths: ['b.txt', 'a.txt', 'a.txt', 9], path: 'c.txt' }), 2);
    denial('d3', 'policy.deny', JSON.stringify({ rule: 'scope.protected', reason: 'no touching config' }), 3);
    const obs = extractObservations(db, 'r1', RUN_DIR).filter((o) => o.source === 'scope-denial');
    const byId = Object.fromEntries(obs.map((o) => [o.summary, o]));
    expect(byId['Denied d1']?.detail).toMatchObject({ rule: null, reason: null });
    expect(byId['Denied d1']?.paths).toEqual([]);
    expect(byId['Denied d2']?.detail).toMatchObject({ rule: null, reason: null });
    expect(byId['Denied d2']?.paths).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect(byId['Denied d3']?.detail).toMatchObject({ rule: 'scope.protected', reason: 'no touching config' });
  });

  it('skips candidates whose scope report is unusable and merges identical scope findings across candidates', () => {
    const db = freshDb();
    candidate(db, 'c1', 1, null, 'null');
    candidate(db, 'c2', 2, null, '{broken');
    candidate(db, 'c3', 3, null, JSON.stringify({ forbidden_paths_changed: ['b.yml', 7, 'a.yml'] }));
    candidate(db, 'c4', 4, null, JSON.stringify({ forbidden_paths_changed: ['a.yml', 'b.yml'], symlinks_escaping: [] }));
    const obs = extractObservations(db, 'r1', RUN_DIR).filter((o) => o.source === 'scope-denial');
    expect(obs).toHaveLength(1);
    expect(obs[0]?.paths).toEqual(['a.yml', 'b.yml']);
    expect(obs[0]?.detail.candidates).toEqual([3, 4]);
    expect(obs[0]?.evidence).toHaveLength(2);
  });
});
