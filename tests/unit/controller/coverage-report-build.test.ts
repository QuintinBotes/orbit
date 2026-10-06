import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { insertLedgerEntry, insertQuestion } from '../../../src/inquisition/store.ts';
import { recordDecision } from '../../../src/storage/decisions.ts';
import { recordUsage } from '../../../src/routing/usage.ts';
import type { GoalContract } from '../../../src/contract/types.ts';
import { buildFinalReport, finalizeRun, renderMarkdown, writeFinalReport, type FinalReport } from '../../../src/controller/report.ts';
import { getRun } from '../../../src/controller/run-store.ts';
import { verifySnapshot } from '../../../src/policy/snapshot.ts';
import { addCandidate, addEvidence, addReview, initLedger, makeUnitLab, type UnitLab } from './coverage-helpers.ts';
import { capturingLogger } from './coverage-log.ts';

let lab: UnitLab;
afterEach(() => lab?.cleanup());

const finding = (id: string, severity: 'critical' | 'high' | 'medium' | 'low' | 'info' = 'high') => ({ externalId: id, severity, category: 'security', location: 'apps/a.mjs:3', path: 'apps/a.mjs', line: 3, claim: `claim ${id} ${'x'.repeat(200)}`, evidence: 'ev', suggestedValidation: null });

function contractOf(over: Partial<GoalContract> = {}): GoalContract {
  return {
    version: '1.0',
    task_id: 'orb-unit',
    original_goal: 'Add mul.',
    objective: 'Add a mul function.',
    acceptance_criteria: [
      { id: 'AC-1', statement: 'mul multiplies', proof: ['a test'], mandatory: true, check_ids: ['unit'] },
      { id: 'AC-2', statement: 'nice to have', proof: ['a test'], mandatory: false, check_ids: ['unit'] },
    ],
    non_goals: [],
    allowed_paths: ['apps/**'],
    required_check_ids: ['unit'],
    assumptions: [{ id: 'AS-1', statement: 'ints only', status: 'unverified' } as never],
    practices: [{ practice: 'behavior-tests', applicable: true, justification: 'tested' } as never],
    delivery: { draft_pr: false, merge: false },
    policy_hash: 'sha256:x',
    baseline_revision: 'a'.repeat(40),
    escalation: { material_topics: [] },
    ...over,
  };
}

// Read straight from the frozen policy: the stored contract in these tests is a fixture, not a validated one.
const build = () => {
  const run = getRun(lab.db, lab.runId);
  return buildFinalReport(lab.db, run, { runDir: join(lab.repo, '.orbit', 'runs', lab.runId), clock: lab.clock, snapshot: verifySnapshot(run.policyPath, run.policyHash) });
};

describe('the final report of a run with everything recorded', () => {
  it('collects criteria, checks, evidence, reviews, decisions, assumptions, practices, repairs and the revision', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const ctx0 = { runDir: join(lab.repo, '.orbit', 'runs', lab.runId) };
    const cand = addCandidate(lab);
    lab.db.run('UPDATE runs SET contract_json = ?, base_revision = ?, branch = ? WHERE id = ?', JSON.stringify(contractOf()), 'b'.repeat(40), 'orbit/orb-unit', lab.runId);
    addEvidence(lab, cand, {
      checks: [{ id: 'unit', status: 'PASSED', exit_code: 0, flaky: true, log: 'evidence/1/unit.log' }],
      acceptance_evidence: [{ criterion_id: 'AC-1', status: 'supported', artifacts: ['unit.log'] }],
      unverified: ['SAST is unverified'],
    });
    addReview(lab, cand, { provider: 'codex', findings: [finding('F-1', 'low')], verdict: 'REPAIR_REQUIRED' });
    recordDecision(lab.db, ctx0.runDir, { runId: lab.runId, kind: 'route', summary: 'implement:1: sonnet' }, lab.clock);
    insertLedgerEntry(lab.db, { runId: lab.runId, claim: 'the parser is total', source: 'inquisitor', confidence: 'medium', consequence: null, reversibility: 'reversible', experiment: null }, lab.clock);
    mkdirSync(join(ctx0.runDir, 'briefs'), { recursive: true });
    writeFileSync(join(ctx0.runDir, 'briefs', 'attempt-2.json'), JSON.stringify({ attempt: 2, source: 'diagnosis', fingerprint: 'fp:1' }));
    writeFileSync(join(ctx0.runDir, 'briefs', 'attempt-1.json'), JSON.stringify({ attempt: 1, source: 'scope', fingerprint: null }));
    writeFileSync(join(ctx0.runDir, 'briefs', 'notes.txt'), 'ignored');
    writeFileSync(join(ctx0.runDir, 'environment.json'), JSON.stringify({ gate: { notes: ['no isolation'] } }));
    writeFileSync(join(ctx0.runDir, 'delivery.json'), JSON.stringify({ commit: 'd'.repeat(40), branch: 'orbit/delivered', pr: { number: 7, url: 'https://example.test/pr/7' } }));
    const r = build();
    expect(r.criteria).toEqual([
      { id: 'AC-1', statement: 'mul multiplies', mandatory: true, status: 'supported', artifacts: ['unit.log'] },
      { id: 'AC-2', statement: 'nice to have', mandatory: false, status: 'unverified', artifacts: [] },
    ]);
    expect(r.checks).toEqual([{ id: 'unit', status: 'PASSED', exit_code: 0, flaky: true, log: 'evidence/1/unit.log' }]);
    expect(r.evidence).toMatchObject({ verdict: 'PASS', tree_hash: cand.treeHash });
    expect(r.reviews).toEqual([expect.objectContaining({ provider: 'codex', verdict: 'REPAIR_REQUIRED', findings: 1 })]);
    expect(r.decisions.map((d) => d.kind)).toContain('route');
    expect(r.assumptions.map((a) => a.id)).toContain('AS-1');
    expect(r.assumptions.some((a) => a.statement === 'the parser is total')).toBe(true);
    expect(r.practices).toEqual([{ practice: 'behavior-tests', applicable: true, justification: 'tested' }]);
    expect(r.repairs).toEqual([
      { attempt: 1, source: 'scope', fingerprint: null },
      { attempt: 2, source: 'diagnosis', fingerprint: 'fp:1' },
    ]);
    expect(r.revision).toMatchObject({ base: 'b'.repeat(40), candidate: cand.commitSha, tree: cand.treeHash, branch: 'orbit/delivered', delivered_commit: 'd'.repeat(40), pull_request: { number: 7, url: 'https://example.test/pr/7' } });
    expect(r.unverified).toEqual(['SAST is unverified']);
    expect(r.residual_risks).toEqual(expect.arrayContaining(['no isolation', 'check unit passed only on a rerun (flaky)']));
    expect(r.residual_risks.some((x) => x.startsWith('review finding F-1 (low, open): claim F-1 '))).toBe(true);
    expect(r.residual_risks.find((x) => x.startsWith('review finding F-1'))!.length).toBeLessThan(260);
  });

  // P26: a local mode makes the candidate commit on a local branch; nothing is delivered, and the report must not say it was.
  it('in a local mode, names the candidate commit as local and not delivered, never as a delivered commit', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const cand = addCandidate(lab);
    lab.db.run("UPDATE runs SET contract_json = ?, base_revision = ?, branch = ?, state = 'SUCCEEDED', mode = 'autonomous', outcome_json = ? WHERE id = ?", JSON.stringify(contractOf()), 'b'.repeat(40), 'orbit/orb-unit', JSON.stringify({ branch: 'orbit/orb-unit', commit: cand.commitSha, delivery: 'local branch; no external action in this mode' }), lab.runId);
    const r = build();
    expect(r.revision.delivered_commit).toBeNull();
    expect(r.revision.candidate).toBe(cand.commitSha);
    const md = renderMarkdown(r);
    expect(md).not.toContain(`delivered commit: ${cand.commitSha}`);
    expect(md).toContain(`candidate commit (local, not delivered): ${cand.commitSha}`);
  });

  it('lists a mandatory criterion that is not supported among the things not verified', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    lab.db.run('UPDATE runs SET contract_json = ? WHERE id = ?', JSON.stringify(contractOf()), lab.runId);
    expect(build().unverified).toEqual(['AC-1 is unverified']);
  });

  it('states unmeasured model spend and reads budget counters and token totals when the budget was initialised', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    initLedger(lab);
    recordUsage(lab.db, { runId: lab.runId, workerId: null, provider: 'claude', model: 'm', usage: { provider: 'claude', model: 'm', inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5, costUsd: 0.5, costSource: 'reported' }, durationMs: 1 }, lab.clock);
    const r = build();
    expect(r.budget?.counters.length).toBeGreaterThan(0);
    expect(r.budget).toMatchObject({ cost_usd: 0.5, tokens: { input: 100, output: 50, cache_read: 10, cache_write: 5 } });
  });

  it('falls back to the usage note when the budget cannot be read against the snapshot', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    initLedger(lab);
    lab.db.run("UPDATE budget_counters SET hard_cap = hard_cap + 1 WHERE counter = 'cost_usd'");
    const r = build();
    expect(r.budget?.counters).toEqual([]);
    expect(r.budget?.cost_measurement).toBeTruthy();
  });

  it('without a snapshot the budget limits are omitted and the usage note stands', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    initLedger(lab);
    const r = buildFinalReport(lab.db, getRun(lab.db, lab.runId), { runDir: lab.ctx().runDir, clock: lab.clock, snapshot: null });
    expect(r.budget?.counters).toEqual([]);
  });

  it('keeps accepted, excepted and claim-pending findings and open questions visible as residual risks', () => {
    lab = makeUnitLab({
      path: ['PREFLIGHT'],
      tweak: (c) => {
        (c.review as unknown as { security: unknown }).security = { block_severities: ['critical', 'high'], exceptions: [{ category: 'security', reason: 'accepted for the demo', severities: ['high'], expires: '2027-01-01' }, { category: 'other', reason: 'r2', severities: ['low'] }] };
      },
    });
    const cand = addCandidate(lab);
    const review = addReview(lab, cand, { verdict: 'BLOCK', findings: [finding('F-1', 'high'), finding('F-2', 'critical'), finding('F-3', 'medium'), finding('F-4', 'low'), finding('F-5', 'info')] });
    const set = (ext: string, status: string, resolutionJson: unknown = null, resolution: string | null = null) => lab.db.run('UPDATE findings SET status = ?, resolution_json = ?, resolution = ? WHERE id = ?', status, resolutionJson === null ? null : JSON.stringify(resolutionJson), resolution, `${review.id}:${ext}`);
    set('F-1', 'excepted', { exception: { index: 0, reason: 'accepted for the demo' } });
    set('F-2', 'accepted');
    set('F-3', 'claim_pending');
    set('F-4', 'excepted', { exception: { index: 5 } }, 'waived by hand');
    set('F-5', 'excepted', null, null);
    insertQuestion(lab.db, { id: 'q-1', runId: lab.runId, mode: 'clarify', question: 'Which rounding mode?', evidence: [], options: [], changes: [], recommendation: { option: 'a', reason: 'r' }, safeDefault: { exists: false, option: null, reason: 'none' }, material: false, affected: [], unblocked: [] }, lab.clock);
    const risks = build().residual_risks;
    expect(risks.some((x) => x.includes('F-1 (high, excepted by policy)') && x.includes('exception reason: accepted for the demo') && x.includes('expires: 2027-01-01'))).toBe(true);
    expect(risks.some((x) => x.includes('F-2 (critical, accepted, unresolved, blocking)'))).toBe(true);
    expect(risks.some((x) => x.includes('F-3 (medium, claim_pending)'))).toBe(true);
    expect(risks.some((x) => x.includes('F-4 (low, excepted by policy)') && x.includes('exception reason: waived by hand') && x.includes('expires: never'))).toBe(true);
    expect(risks.some((x) => x.includes('F-5 (info, excepted by policy)') && x.includes('exception reason: no reason recorded'))).toBe(true);
    expect(risks).toContain('open question: Which rounding mode?');
  });

  it('an unreadable security policy only costs the expiry text', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'], tweak: (c) => void ((c.review as unknown as { security: unknown }).security = 'not an object') });
    const cand = addCandidate(lab);
    const review = addReview(lab, cand, { verdict: 'BLOCK', findings: [finding('F-1', 'high')] });
    lab.db.run("UPDATE findings SET status = 'excepted', resolution_json = ? WHERE id = ?", JSON.stringify({ exception: { index: 0, reason: 'r' } }), `${review.id}:F-1`);
    expect(build().residual_risks.some((x) => x.includes('expires: never'))).toBe(true);
  });

  it('is redacted everywhere: a secret in the goal never reaches the report', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const token = ['ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
    lab.db.run('UPDATE runs SET goal = ? WHERE id = ?', `Deploy with ${token}`, lab.runId);
    expect(JSON.stringify(build())).not.toContain(token);
  });
});

describe('what to do next', () => {
  const next = (state: string, mode = 'autonomous', outcomeReason: string | null = null, extra: object = {}) => {
    lab = makeUnitLab({ path: [] });
    lab.db.run('UPDATE runs SET state = ?, mode = ?, outcome_reason = ?, branch = ? WHERE id = ?', state, mode, outcomeReason, (extra as { branch?: string }).branch ?? null, lab.runId);
    const out = build().next_action;
    lab.cleanup();
    return out;
  };

  it('a delivered run says to review the pull request, the branch, or nothing specific, and a local mode points at the local branch', () => {
    const delivery = (pr: boolean) => {
      lab = makeUnitLab({ path: [] });
      lab.db.run("UPDATE runs SET state = 'SUCCEEDED', mode = 'autonomous-delivery', branch = NULL WHERE id = ?", lab.runId);
      if (pr) writeFileSync(join(lab.ctx().runDir, 'delivery.json'), JSON.stringify({ commit: 'c', branch: 'orbit/x', pr: { number: 12 } }));
      const out = build().next_action;
      lab.cleanup();
      return out;
    };
    expect(delivery(true)).toBe('Review pull request #12 and merge it if you accept it; Orbit does not merge.');
    expect(delivery(false)).toBe('Review branch orbit/<run> and merge it if you accept it; Orbit does not merge.');
    expect(next('SUCCEEDED', 'autonomous', null, { branch: 'orbit/local' })).toBe('Inspect the local branch orbit/local (the reviewed candidate) and merge it yourself if you accept it.');
    expect(next('SUCCEEDED')).toBe('Inspect the local branch orbit/orb-unit (the reviewed candidate) and merge it yourself if you accept it.');
  });

  it('each other outcome says what a person does', () => {
    expect(next('BLOCKED', 'autonomous', 'needs login')).toBe('needs login. Resolve that, then run `orbit resume orb-unit`.');
    expect(next('BLOCKED')).toBe('The run is blocked. Resolve that, then run `orbit resume orb-unit`.');
    expect(next('EXHAUSTED', 'autonomous', 'cost cap')).toContain('The authorized budget is spent (cost cap).');
    expect(next('EXHAUSTED')).toContain('(see decisions)');
    expect(next('IMPOSSIBLE', 'autonomous', 'no way')).toBe('no way Revise the goal or the authorization before trying again.');
    expect(next('IMPOSSIBLE')).toContain('No authorized way to meet the contract was found.');
    expect(next('CANCELLED')).toBe('Nothing further: the run was cancelled on request and its artifacts are preserved.');
    expect(next('IMPLEMENTING')).toBe('The run is IMPLEMENTING; this report is provisional.');
  });
});

describe('writeFinalReport', () => {
  it('writes final.json and final.md, the same twice', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const ctx = lab.ctx();
    const a = writeFinalReport(lab.db, lab.runId, { runDir: ctx.runDir, clock: lab.clock, snapshot: ctx.snapshot });
    const json = readFileSync(join(ctx.runDir, 'final.json'), 'utf8');
    const md = readFileSync(join(ctx.runDir, 'final.md'), 'utf8');
    writeFinalReport(lab.db, lab.runId, { runDir: ctx.runDir, clock: lab.clock, snapshot: ctx.snapshot });
    expect(readFileSync(join(ctx.runDir, 'final.json'), 'utf8')).toBe(json);
    expect(md).toContain(`# Orbit run ${lab.runId}: PREFLIGHT`);
    expect(a.run_id).toBe(lab.runId);
  });
});

describe('finalizeRun', () => {
  it('logs a report it cannot write and still returns, and does no learning without a verified policy', async () => {
    const cap = capturingLogger();
    lab = makeUnitLab({ path: ['PREFLIGHT'], logger: cap.logger });
    const ctx = lab.ctx();
    chmodSync(ctx.runDir, 0o500);
    try {
      await finalizeRun(ctx);
    } finally {
      chmodSync(ctx.runDir, 0o700);
    }
    if (process.getuid?.() !== 0) expect(cap.lines().some((l) => l.msg === 'final report failed')).toBe(true);
    const lenient = (await import('../../../src/controller/context.ts')).lenientContext(lab.deps, lab.runId, new AbortController().signal);
    await expect(finalizeRun(lenient)).resolves.toBeUndefined();
  });

  it('a failure of the learning hook is recorded as an event and never thrown', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'], tweak: (c) => void (c.knowledge.enabled = true) });
    const ctx = lab.ctx();
    // A directory where the knowledge database should be makes the store fail to open.
    mkdirSync(join(lab.repo, '.orbit', 'knowledge.sqlite'), { recursive: true });
    await expect(finalizeRun(ctx)).resolves.toBeUndefined();
    const ev = lab.db.get<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'learning.failed'", lab.runId);
    expect(JSON.parse(ev!.data_json).error).toEqual(expect.any(String));
  });
});

describe('renderMarkdown: every optional part', () => {
  const base = (over: Partial<FinalReport> = {}): FinalReport => ({
    schema: 'orbit.final/1',
    run_id: 'orb-1',
    outcome: 'BLOCKED',
    outcome_reason: null,
    mode: 'autonomous',
    original_goal: 'Add mul.',
    objective: null,
    criteria: [{ id: 'AC-2', statement: 'optional', mandatory: false, status: 'unverified', artifacts: [] }],
    checks: [{ id: 'lint', status: 'FAILED', exit_code: null, flaky: true, log: 'l.log' }],
    evidence: null,
    reviews: [{ id: 'r', provider: 'claude', model: null, verdict: 'REPAIR', tree_hash: 't', findings: 2 }],
    decisions: [],
    assumptions: [{ id: 'A-1', statement: 's', status: 'unverified' }],
    practices: [{ practice: 'p1', applicable: false, justification: 'not relevant' }, { practice: 'p2', applicable: true, justification: 'covered' }],
    repairs: [{ attempt: 1, source: 'scope', fingerprint: null }],
    revision: { base: null, candidate: null, tree: null, branch: null, delivered_commit: null, pull_request: { number: 3, url: null } },
    budget: null,
    unverified: [],
    residual_risks: [],
    next_action: 'wait',
    generated_at: 0,
    ...over,
  });

  it('omits what is absent and says none for empty lists', () => {
    const md = renderMarkdown(base());
    expect(md).not.toContain('## Delivered behaviour');
    expect(md).not.toContain('## Budget consumption');
    expect(md).not.toContain('Evidence report');
    expect(md).toContain('## Outcome\n\nBLOCKED\n');
    expect(md).toContain('AC-2 (optional) [unverified]: optional');
    expect(md).toContain('lint: FAILED, flaky, log l.log');
    expect(md).toContain('claude/default: REPAIR on tree t (2 finding(s))');
    expect(md).toContain('p1 [omitted]: not relevant');
    expect(md).toContain('p2 [selected]: covered');
    expect(md).toContain('attempt 1: scope brief\n');
    expect(md).toContain('pull request: #3\n');
    expect(md).toContain('base: none');
    expect(md).toContain('## Decisions\n\n- none');
    expect(md).toContain('## Not verified\n\n- none');
  });

  it('prints an exit code, evidence, a pull request url, no practices section when there are none, and a measured budget', () => {
    const md = renderMarkdown(
      base({
        outcome_reason: 'done',
        objective: 'Add a mul function.',
        practices: [],
        criteria: [{ id: 'AC-1', statement: 'mul', mandatory: true, status: 'supported', artifacts: ['a.log', 'b.log'] }],
        checks: [{ id: 'unit', status: 'PASSED', exit_code: 0, flaky: false, log: 'u.log' }],
        evidence: { report_id: 'evr-1', verdict: 'PASS', tree_hash: 't1', candidate_revision: 'c1' },
        revision: { base: 'b', candidate: 'c', tree: 't', branch: 'x', delivered_commit: 'd', pull_request: { number: 3, url: 'https://example.test/3' } },
        budget: { counters: [{ counter: 'cost_usd', used: 1.5, allowance: 10, hard_cap: 30, remaining: 8.5 } as never], cost_measurement: 'reported', cost_usd: 1.5, cost_complete: true, tokens: { input: 1, output: 2, cache_read: 3, cache_write: 4 } },
      }),
    );
    expect(md).toContain('BLOCKED: done');
    expect(md).toContain('## Delivered behaviour\n\nAdd a mul function.');
    expect(md).toContain('(evidence: a.log, b.log)');
    expect(md).toContain('unit: PASSED (exit 0), log u.log');
    expect(md).toContain('Evidence report evr-1: PASS on tree t1.');
    expect(md).not.toContain('## Engineering practices');
    expect(md).toContain('pull request: #3 https://example.test/3');
    expect(md).toContain('cost_usd: 1.50 used of 10 allowed (hard cap 30)');
    expect(md).toContain('model cost: $1.5000 (measured)');
  });
});
