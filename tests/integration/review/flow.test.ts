import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ManualClock } from '../../../src/core/clock.ts';
import { createRun } from '../../../src/controller/run-store.ts';
import { openDb, type OrbitDb } from '../../../src/storage/db.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import {
  assertReviewGate,
  buildReviewPacket,
  getFinding,
  ingestFindings,
  invalidateStaleReviews,
  listFindings,
  loadResolverState,
  persistResolution,
  recordReview,
  resolveFindings,
  reviewGate,
  selectReviewer,
  type ClaimEvidence,
} from '../../../src/review/index.ts';
import { cap, contract, cred, evidenceReport, snapshotOf, snapshotWithSecurity } from '../../unit/review/fixtures.ts';

const gitAvailable = spawnSync('git', ['--version']).status === 0;
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Acme Dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Acme Dev', GIT_COMMITTER_EMAIL: 'dev@example.com' };

let top: string;
let repo: string;
let base: string;
const cands: { commit: string; tree: string }[] = [];

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, env: GIT_ENV, encoding: 'utf8' }).trim();
}
function write(rel: string, content: string): void {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), content);
}
function commit(msg: string): { commit: string; tree: string } {
  git('add', '-A');
  git('commit', '-q', '-m', msg);
  return { commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') };
}

const HIGH = { id: 'SEC-1', severity: 'high', category: 'authorization', location: 'src/export.ts:3', claim: 'Export omits tenant scope.', evidence: 'The query has no tenant predicate.', suggested_validation: 'Add a cross-tenant negative test.' };

function evidenceFor(findingId: string, tree: string, over: Partial<ClaimEvidence>): ClaimEvidence {
  return { findingId, kind: 'new_test', treeHash: tree, verdict: 'refutes', status: 'PASSED', exercisesClaim: true, checkId: 'cross-tenant', ref: 'evidence/cross-tenant.log', ...over };
}

describe.skipIf(!gitAvailable)('review flow on a real repository and SQLite file (skipped when git is not installed)', () => {
  let db: OrbitDb;
  let dbPath: string;
  let runDir: string;
  const clock = new ManualClock();
  const snap = snapshotOf();

  beforeAll(() => {
    top = mkdtempSync(join(tmpdir(), 'orbit-review-flow-'));
    repo = join(top, 'repo');
    mkdirSync(repo);
    git('init', '-q', '-b', 'main');
    write('src/export.ts', 'export const rows = (tenant: string) => query({ tenant });\n');
    base = commit('base').commit;
    write('src/export.ts', 'export const rows = () => query({});\nexport const page = 1;\n');
    cands.push(commit('candidate 1'));
    write('src/export.ts', 'export const rows = (tenant: string) => query({ tenant });\nexport const page = 1;\n');
    write('tests/tenant.test.ts', "it('is tenant scoped', () => {});\n");
    cands.push(commit('candidate 2'));
    dbPath = join(top, '.orbit', 'state.sqlite');
    runDir = join(top, '.orbit', 'runs', 'run-1');
    mkdirSync(runDir, { recursive: true });
    db = openDb(dbPath);
    createRun(db, { id: 'run-1', repoRoot: repo, goal: 'g', mode: 'autonomous', policyHash: 'sha256:x', policyPath: '/p' }, clock);
    // recordReview refuses a candidate that was never recorded, so the real candidates are recorded first.
    cands.forEach((c, i) => {
      db.run(
        "INSERT INTO candidates (id, run_id, seq, attempt, commit_sha, tree_hash, parent_sha, status, created_at) VALUES (?, 'run-1', ?, ?, ?, ?, ?, 'CREATED', ?)",
        `cand-${i + 1}`,
        i + 1,
        i + 1,
        c.commit,
        c.tree,
        base,
        clock.now(),
      );
    });
  });

  afterAll(() => {
    db.close();
    rmSync(top, { recursive: true, force: true });
  });

  async function reviewOf(idx: number, id: string, provider: string, round: number, output: unknown, packetProvider = 'codex') {
    const c = cands[idx]!;
    const packet = await buildReviewPacket({
      contract: contract(),
      snapshot: snap,
      candidate: { commitSha: c.commit, treeHash: c.tree },
      baseRev: base,
      repoRoot: repo,
      evidenceReport: evidenceReport(c.tree),
      ledger: [],
      questions: ['Is the export tenant scoped?'],
      provider: packetProvider,
    });
    const ingested = ingestFindings({ output, candidate: { commitSha: c.commit, treeHash: c.tree } });
    return recordReview(
      db,
      { id, runId: 'run-1', candidateId: `cand-${idx + 1}`, treeHash: c.tree, round, provider, model: provider === 'codex' ? 'codex-alpha' : 'claude-opus-5-5', workerId: null, verdict: ingested.verdict, packetSha256: packet.sha256, findings: ingested.findings },
      clock,
    );
  }

  it('blocks when the mandatory independent reviewer has expired credentials, and records the block', () => {
    const sel = selectReviewer({ snapshot: snap, capabilities: { claude: cap('claude'), codex: cap('codex') }, credentials: { claude: cred('valid'), codex: cred('expired', 'login expired') }, implementer: { provider: 'claude', model: 'claude-sonnet-5-5' } });
    expect(sel).toMatchObject({ decision: 'BLOCK', code: 'AUTH_EXPIRED' });
  });

  it('scenario 16: a cross-provider disagreement becomes a testable claim and is settled by a reproduction', async () => {
    const c = cands[0]!;
    await reviewOf(0, 'rev-codex-1', 'codex', 1, { verdict: 'REPAIR_REQUIRED', candidate_revision: c.commit.slice(0, 12), findings: [HIGH] });
    await reviewOf(0, 'rev-claude-1', 'claude', 1, { verdict: 'APPROVE', candidate_revision: c.commit.slice(0, 12), findings: [] }, 'claude');

    let state = loadResolverState(db, 'run-1', c.tree);
    expect(state.reviews.map((r) => r.provider).sort()).toEqual(['claude', 'codex']);
    let res = resolveFindings({ ...state, snapshot: snap, treeHash: c.tree, evidence: [] });
    expect(res.claimsToTest).toHaveLength(1);
    expect(res.claimsToTest[0]).toMatchObject({ route: 'inquisition', reason: 'disagreement', blocking: true });
    expect(res.blocking).toHaveLength(1);
    persistResolution(db, runDir, 'run-1', res, clock);
    const f = listFindings(db, 'run-1')[0]!;
    expect(f.status).toBe('claim_pending');
    expect(reviewGate(db, { runId: 'run-1', treeHash: c.tree, snapshot: snap, implementerProvider: 'claude', now: clock.now() }).ok).toBe(false);

    // Inquisition writes a cross-tenant test; it fails on the candidate: the claim holds.
    state = loadResolverState(db, 'run-1', c.tree);
    res = resolveFindings({ ...state, snapshot: snap, treeHash: c.tree, evidence: [evidenceFor(f.id, c.tree, { verdict: 'confirms', status: 'FAILED' })] });
    persistResolution(db, runDir, 'run-1', res, clock);
    expect(getFinding(db, f.id)).toMatchObject({ status: 'accepted' });
    expect(res.repairBriefs).toHaveLength(1);
    expect(listDecisions(db, 'run-1', { kind: 'review.finding.accepted' })).toHaveLength(1);
    expect(() => assertReviewGate(db, { runId: 'run-1', treeHash: c.tree, snapshot: snap, implementerProvider: 'claude', now: clock.now() })).toThrow(/blocks delivery/);
  });

  it('a repair candidate invalidates the earlier reviews and the carried finding keeps blocking until proven fixed', async () => {
    const c1 = cands[0]!;
    const c2 = cands[1]!;
    const stale = invalidateStaleReviews(db, { runId: 'run-1', runDir, current: { treeHash: c2.tree }, cause: 'repair candidate 2' }, clock);
    expect(stale.map((r) => r.id).sort()).toEqual(['rev-claude-1', 'rev-codex-1']);

    await reviewOf(1, 'rev-codex-2', 'codex', 2, { verdict: 'APPROVE', candidate_revision: c2.commit.slice(0, 12), findings: [] });
    const gate = reviewGate(db, { runId: 'run-1', treeHash: c2.tree, snapshot: snap, implementerProvider: 'claude', now: clock.now() });
    expect(gate.ok).toBe(false);
    expect(gate.reasons.join(' ')).toContain('blocks delivery');

    // The old APPROVE and the old findings' tree both stay unable to authorize the new tree.
    expect(reviewGate(db, { runId: 'run-1', treeHash: c1.tree, snapshot: snap, implementerProvider: 'claude', now: clock.now() }).ok).toBe(false);

    const old = listFindings(db, 'run-1')[0]!;
    const state = loadResolverState(db, 'run-1', c2.tree);
    expect(state.previousFindings.map((p) => p.id)).toEqual([old.id]);
    const res = resolveFindings({ ...state, snapshot: snap, treeHash: c2.tree, evidence: [evidenceFor(old.id, c2.tree, {})] });
    expect(res.resolved).toHaveLength(1);
    persistResolution(db, runDir, 'run-1', res, clock);
    expect(getFinding(db, old.id)!.status).toBe('resolved');
    expect(reviewGate(db, { runId: 'run-1', treeHash: c2.tree, snapshot: snap, implementerProvider: 'claude', now: clock.now() })).toMatchObject({ ok: true });
  });

  it('survives a reopen of the SQLite file: statuses, reasons and the decision mirror persist', () => {
    db.close();
    db = openDb(dbPath);
    const f = listFindings(db, 'run-1')[0]!;
    expect(f.status).toBe('resolved');
    expect(f.resolution).toMatch(/confirmed earlier and no longer holds/);
    expect(f.resolutionJson).toMatchObject({ blocking: false, tree_hash: cands[1]!.tree });
    const lines = readFileSync(join(runDir, 'decisions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string });
    expect(lines.map((l) => l.kind)).toEqual(expect.arrayContaining(['review.finding.accepted', 'review.invalidated', 'review.finding.resolved']));
  });

  it('scenario 19: a security finding blocks until an exception listed in policy covers it', async () => {
    const c = cands[1]!;
    const sec = snapshotWithSecurity({ exceptions: [{ category: 'authorization', location: 'src/**', severities: ['high'], reason: 'tenant model is replaced next quarter' }] });
    await reviewOf(1, 'rev-codex-3', 'codex', 3, { verdict: 'REPAIR_REQUIRED', candidate_revision: c.commit.slice(0, 12), findings: [{ ...HIGH, id: 'SEC-9', claim: 'Rate limit is missing on export.', location: 'src/export.ts:1' }] });
    const state = loadResolverState(db, 'run-1', c.tree);
    const unlisted = resolveFindings({ ...state, snapshot: snap, treeHash: c.tree, evidence: [] });
    expect(unlisted.blocking.map((d) => d.externalId)).toContain('SEC-9');

    const listed = resolveFindings({ ...state, snapshot: sec, treeHash: c.tree, evidence: [] });
    expect(listed.blocking.map((d) => d.externalId)).not.toContain('SEC-9');
    expect(listed.excepted.map((d) => d.externalId)).toContain('SEC-9');
    persistResolution(db, runDir, 'run-1', listed, clock);
    const exc = listDecisions(db, 'run-1', { kind: 'review.finding.excepted' });
    expect(exc).toHaveLength(1);
    expect(exc[0]!.data).toMatchObject({ exception: { index: 0, category: 'authorization', reason: 'tenant model is replaced next quarter' } });
    // The policy snapshot used for the gate must be the same one that listed the exception.
    expect(reviewGate(db, { runId: 'run-1', treeHash: c.tree, snapshot: sec, implementerProvider: 'claude', now: clock.now() }).ok).toBe(true);
  });
});
