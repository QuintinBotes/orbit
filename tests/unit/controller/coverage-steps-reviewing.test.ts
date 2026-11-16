import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderAdapter } from '../../../src/adapters/types.ts';
import { snapshotCandidate } from '../../../src/evidence/candidate.ts';
import { insertLedgerEntry, insertQuestion } from '../../../src/inquisition/store.ts';
import { listDecisions, recordDecision } from '../../../src/storage/decisions.ts';
import { listFindings, listReviews, recordReview } from '../../../src/review/store.ts';
import type { IngestedFinding } from '../../../src/review/types.ts';
import { finishWorker, getWorker, listWorkers, markWorkerRunning, planWorker } from '../../../src/storage/workers.ts';
import { getRun, requestCancel } from '../../../src/controller/run-store.ts';
import { newRunNeeded } from '../../../src/controller/resume.ts';
import { REVIEW_REPAIR_EVENT, cancelObsoleteWork, implementerProvider, prepareReview, reviewFocuses, reviewingStep } from '../../../src/controller/steps/reviewing.ts';
import { briefPath } from '../../../src/controller/steps/implementing.ts';
import { implementRouteDecisionId } from '../../../src/controller/route-outcome.ts';
import { defaultUi } from '../../../src/policy/config.ts';
import { addEvidence, giveRepository, initLedger, makeUnitLab, okResult, OWNER, scriptedAdapter, setContract, validateModels, type ScriptedAdapter, type UnitLab } from './coverage-helpers.ts';

let lab: UnitLab;
// Review checkouts are read-only; make them removable before the lab deletes its directory.
function cleanLab(): void {
  if (lab) execFileSync('chmod', ['-R', 'u+w', lab.base]);
  lab?.cleanup();
}
afterEach(cleanLab);

const claude = (): ProviderAdapter =>
  ({
    id: 'claude',
    discoverCapabilities: async () => ({ provider: 'claude', available: true, version: '1', models: [], structuredOutput: true, readOnlySandbox: true, usageReporting: 'full', costReporting: true, detail: '' }),
    validateCredentials: async () => ({ state: 'valid', method: 'api_key', detail: 'ok' }),
  }) as unknown as ProviderAdapter;

const finding = (id: string, over: Partial<IngestedFinding> = {}): IngestedFinding => ({
  externalId: id,
  severity: 'high',
  category: 'correctness',
  location: 'apps/calc.mjs:2',
  path: 'apps/calc.mjs',
  line: 2,
  claim: `mul accepts non-numeric arguments (${id}) and returns NaN instead of throwing`,
  evidence: 'mul("a", 2) is NaN',
  suggestedValidation: 'Add a test asserting mul("a", 2) throws',
  ...over,
});

interface Setup {
  reviewer?: Parameters<typeof scriptedAdapter>[1];
  tweak?: Parameters<typeof makeUnitLab>[0] extends infer O ? (O extends { tweak?: infer T } ? T : never) : never;
  edit?: boolean;
  onReviewerStart?: Parameters<typeof scriptedAdapter>[2];
}

async function setup(o: Setup = {}) {
  lab = makeUnitLab({
    path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING'],
    deps: { schedulerProbe: { availableParallelism: () => 16, freemem: () => 64_000 * 1024 * 1024 } },
    tweak: (c) => {
      c.providers.codex = { ...c.providers.codex!, data_policy_eligible: true, model: 'gpt-6-astra' };
      o.tweak?.(c);
    },
  });
  const reviewer = scriptedAdapter(lab, o.reviewer ?? (({ spec }) => okResult({ verdict: 'APPROVE', candidate_revision: spec.prompt.match(/candidate revision ([0-9a-f]{40})/)?.[1] ?? '0'.repeat(40), findings: [] })), o.onReviewerStart);
  lab.deps.adapters = { claude: claude(), codex: reviewer };
  validateModels(lab);
  for (const e of lab.deps.registry.list()) if (e.provider === 'codex') lab.deps.registry.markAvailability(e.modelId, 'codex-cli', true, 'test');
  const repo = await giveRepository(lab);
  setContract(lab, { baseline_revision: repo.base, allowed_paths: ['apps/calc.mjs'] });
  initLedger(lab);
  writeFileSync(join(repo.worktree, 'apps', 'calc.mjs'), 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n');
  const cand = await snapshotCandidate({ db: lab.db, clock: lab.clock, repoRoot: lab.repo, worktree: repo.worktree, runId: lab.runId, baseRev: repo.base, attempt: 1, workerId: null });
  lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 1, 'implementation.attempt', 'x', ?)", lab.runId, JSON.stringify({ attempt: 1 }));
  lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 1, 'implementation.candidate', 'x', ?)", lab.runId, JSON.stringify({ attempt: 1, candidate_id: cand.id }));
  addEvidence(lab, cand);
  return { cand, reviewer, repo };
}

/** The route attempt n was given, as routeFor records it (issue #168). */
function routed(n: number): void {
  recordDecision(lab.db, lab.ctx().runDir, { id: implementRouteDecisionId(lab.runId, n), runId: lab.runId, kind: 'route', summary: `implement:${n}`, data: { purpose: `implement:${n}`, provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', work_kind: 'routine-code' } }, lab.clock);
}
const routeOutcomes = () => lab.db.all<{ attempt_key: string; outcome: string; evidence_ref: string }>('SELECT attempt_key, outcome, evidence_ref FROM route_outcomes WHERE run_id = ? ORDER BY id', lab.runId);

const run = () => reviewingStep(lab.ctx());
const state = () => getRun(lab.db, lab.runId).state;
const decisions = (kind: string) => listDecisions(lab.db, lab.runId, { kind });
async function settle(max = 12) {
  let out = await run();
  // As the controller does, the step runs again while a worker runs, or after it made progress without leaving REVIEWING (a reviewer switch, #116).
  for (let i = 0; i < max && !out.done && state() === 'REVIEWING' && ((out.progressed && !out.waiting) || (out.waiting !== undefined && /is running$|running in|review running/.test(out.waiting))); i++) out = await run();
  return out;
}

/**
 * A reviewer that approves, except in a finding's one re-review (ADR 0015, amendment of 2026-11-16), where it answers by
 * the finding's id: `gone` (APPROVE with an info finding giving its evidence), `other` (REPAIR_REQUIRED naming only another
 * finding) or, by default, still present (the finding raised again). A full review raises `full`, and approves without any.
 */
function answers(how: Record<string, 'gone' | 'other'> = {}, full: IngestedFinding[] = []): NonNullable<Setup['reviewer']> {
  return ({ spec }) => {
    const candidate_revision = spec.prompt.match(/candidate revision ([0-9a-f]{40})/)?.[1] ?? '0'.repeat(40);
    const id = /This is a re-review of one finding, ([A-Z][A-Z0-9]*-[0-9]+) /.exec(spec.prompt)?.[1];
    if (!id && full.length > 0) return okResult({ verdict: 'REPAIR_REQUIRED', candidate_revision, findings: full.map((x) => ({ id: x.externalId, severity: x.severity, category: x.category, location: x.location, claim: x.claim, evidence: x.evidence, suggested_validation: x.suggestedValidation })) });
    if (!id) return okResult({ verdict: 'APPROVE', candidate_revision, findings: [] });
    const f = (fid: string, severity: string, claim: string) => ({ id: fid, severity, category: 'correctness', location: 'apps/calc.mjs:2', claim, evidence: `tests/mul.test.mjs:3 covers ${fid}`, suggested_validation: null });
    if (how[id] === 'gone') return okResult({ verdict: 'APPROVE', candidate_revision, findings: [f(id, 'info', `${id} no longer holds`)] });
    if (how[id] === 'other') return okResult({ verdict: 'REPAIR_REQUIRED', candidate_revision, findings: [f('OTHER-1', 'high', 'add has no test either')] });
    return okResult({ verdict: 'REPAIR_REQUIRED', candidate_revision, findings: [f(id, 'high', `${id} still holds`)] });
  };
}

const USAGE = { provider: 'claude', model: null, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null, costSource: 'unavailable' };
const TURN_CAPPED = { state: 'FAILED', resultStatus: 'max_turns', error: 'reached the maximum number of turns' } as const;

/** Attempt n's candidate, from an implementer that ended with `outcome`, and a REPAIR_REQUIRED review of it raising `findings`. */
async function repairAttempt(base: string, repo: { worktree: string }, n: number, outcome: Parameters<typeof finishWorker>[2], findings: IngestedFinding[] = []) {
  writeFileSync(join(repo.worktree, 'apps', 'calc.mjs'), `export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b; // ${n}\n`);
  const c = await snapshotCandidate({ db: lab.db, clock: lab.clock, repoRoot: lab.repo, worktree: repo.worktree, runId: lab.runId, baseRev: base, attempt: n, workerId: null });
  lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 1, 'implementation.attempt', 'x', ?)", lab.runId, JSON.stringify({ attempt: n }));
  lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 1, 'implementation.candidate', 'x', ?)", lab.runId, JSON.stringify({ attempt: n, candidate_id: c.id }));
  addEvidence(lab, c);
  const w = planWorker(lab.db, { id: `wrk-impl-${n}`, runId: lab.runId, role: 'implementer', provider: 'claude', attempt: n, workerDir: join(lab.base, `wi${n}`), cwd: lab.repo }, lab.clock, OWNER);
  markWorkerRunning(lab.db, w.id, { pid: 2_000_000_000, pgid: 2_000_000_000, procStart: 'x' }, lab.clock, OWNER);
  finishWorker(lab.db, w.id, outcome, lab.clock, OWNER);
  record(c, 'REPAIR_REQUIRED', findings);
  lab.db.run("UPDATE runs SET state = 'REVIEWING' WHERE id = ?", lab.runId);
  return c;
}

function record(cand: { id: string; treeHash: string }, verdict: 'APPROVE' | 'REPAIR_REQUIRED' | 'BLOCK', findings: IngestedFinding[] = [], provider = 'codex', id = `rev-${listReviews(lab.db, lab.runId, { includeInvalidated: true }).length + 1}`) {
  return recordReview(lab.db, { id, runId: lab.runId, candidateId: cand.id, treeHash: cand.treeHash, round: listReviews(lab.db, lab.runId, { includeInvalidated: true }).length + 1, provider, model: null, workerId: null, verdict, packetSha256: null, findings }, lab.clock);
}

describe('preconditions', () => {
  it('stops at a safe point, needs a candidate and a budget, and refuses a candidate without fresh PASS evidence', async () => {
    const { cand } = await setup();
    requestCancel(lab.db, lab.runId, 'u', lab.clock);
    expect(await run()).toMatchObject({ done: true });
    cleanLab();
    await setup();
    lab.db.run('DELETE FROM budget_counters WHERE run_id = ?', lab.runId);
    await expect(run()).rejects.toMatchObject({ code: 'INTERNAL', message: expect.stringContaining('without a candidate or budget') });
    cleanLab();
    const t = await setup();
    lab.db.run('DELETE FROM evidence_reports WHERE run_id = ?', lab.runId);
    await expect(run()).rejects.toMatchObject({ code: 'STALE_EVIDENCE' });
    cleanLab();
    const u = await setup();
    lab.db.run("UPDATE evidence_reports SET verdict = 'FAIL' WHERE run_id = ?", lab.runId);
    await expect(run()).rejects.toMatchObject({ code: 'STALE_EVIDENCE' });
  });
});

describe('a review that is already recorded', () => {
  it('an independent approval clears the tree and moves on to delivery', async () => {
    const { cand } = await setup();
    record(cand, 'APPROVE');
    expect(await run()).toEqual({ progressed: true });
    expect(state()).toBe('DELIVERING');
    expect(decisions('gate.independent_review')[0]?.summary).toContain('pass');
  });

  it('a same-provider approval is never recorded as an independent review that cleared the tree', async () => {
    const { cand } = await setup();
    record(cand, 'APPROVE', [], 'claude');
    expect(await run()).toEqual({ progressed: true });
    expect(state()).toBe('DELIVERING');
    const gate = decisions('gate.independent_review')[0]!;
    expect(gate.summary).toMatch(/not independent/i);
    expect(gate.summary).not.toMatch(/gate pass/);
    expect(gate.data).toMatchObject({ independent: false });
    const moved = lab.db.get<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'state.transition' ORDER BY id DESC LIMIT 1", lab.runId)!;
    expect(moved.data_json).toMatch(/not independent/i);
    expect(moved.data_json).not.toMatch(/independent review cleared/);
  });

  it('a same-provider review that cleared the tree without approving it is not recorded as an approval, and its advisory finding goes to repair (#130)', async () => {
    const { cand } = await setup();
    // REPAIR_REQUIRED whose only finding is advisory: the gate clears the tree, but nobody approved it.
    record(cand, 'REPAIR_REQUIRED', [finding('STY-1', { severity: 'low' })], 'claude');
    expect(await run()).toEqual({ progressed: true });
    const gate = decisions('gate.independent_review')[0]!;
    expect(gate.data).toMatchObject({ status: 'pass', independent: false, approved: false });
    expect(gate.summary).not.toMatch(/approved/);
    expect(gate.summary).toMatch(/without an approval/);
    expect(gate.summary).toMatch(/not independent/);
    expect(state()).toBe('REPAIRING');
    expect(decisions('repair.brief')[0]?.summary).toContain('STY-1 (review 1) (low)');
  });

  it('an independent REPAIR_REQUIRED review whose only open finding is advisory sends it to repair instead of blocking (#130)', async () => {
    const { cand } = await setup();
    record(cand, 'REPAIR_REQUIRED', [finding('STY-1', { severity: 'low' }), finding('STY-2', { severity: 'info', claim: 'a different nit in the parser' })], 'codex');
    expect(await run()).toEqual({ progressed: true });
    // The gate clears the tree without an approval: delivery stays out of reach until a review of the repaired tree approves.
    expect(decisions('gate.independent_review')[0]!.data).toMatchObject({ status: 'pass' });
    expect(state()).toBe('REPAIRING');
    const repairs = lab.db.all<{ data_json: string }>('SELECT data_json FROM events WHERE run_id = ? AND type = ?', lab.runId, REVIEW_REPAIR_EVENT);
    expect(JSON.parse(repairs[0]!.data_json).findings.map((f: { external_id: string }) => f.external_id).sort()).toEqual(['STY-1', 'STY-2']);
  });

  it('an advisory finding of a REPAIR_REQUIRED review stops the run when no review round is left for the repaired tree (BLOCKED, offering the verified candidate: #169)', async () => {
    const { cand } = await setup();
    record(cand, 'REPAIR_REQUIRED', [finding('STY-1', { severity: 'low' })], 'codex');
    lab.db.run("UPDATE budget_counters SET used = allowance WHERE counter = 'review_rounds'");
    await run();
    expect(state()).toBe('BLOCKED');
    expect(getRun(lab.db, lab.runId).outcomeReason).toMatch(/^review_rounds hard cap reached \(\d+ of \d+\) with 1 open finding\(s\): STY-1 \(review 1\) \(low\)/);
  });

  it('a same-provider BLOCK review with an advisory finding does not call the block an independent review', async () => {
    const { cand } = await setup();
    record(cand, 'BLOCK', [finding('STY-1', { severity: 'low' })], 'claude');
    await run();
    expect(state()).toBe('BLOCKED');
    expect(getRun(lab.db, lab.runId).outcomeReason).not.toMatch(/independent review does not clear/);
    expect(getRun(lab.db, lab.runId).outcomeReason).toMatch(/^review does not clear tree/);
  });

  it('an independent (Codex) BLOCK review is still recorded as an independent review that does not clear the tree', async () => {
    const { cand } = await setup();
    record(cand, 'BLOCK', [finding('STY-1', { severity: 'low' })], 'codex');
    await run();
    expect(state()).toBe('BLOCKED');
    expect(getRun(lab.db, lab.runId).outcomeReason).toMatch(/^independent review does not clear tree/);
  });

  it('an approval with a material question still open blocks the run before delivery', async () => {
    const { cand } = await setup();
    record(cand, 'APPROVE');
    insertQuestion(lab.db, { id: 'q-1', runId: lab.runId, mode: 'clarify', question: 'Which rounding?', evidence: [], options: [], changes: [], recommendation: { option: 'a', reason: 'r' }, safeDefault: { exists: false, option: null, reason: 'none' }, material: true, affected: ['AC-1'], unblocked: [] }, lab.clock);
    await run();
    expect(state()).toBe('BLOCKED');
    expect(getRun(lab.db, lab.runId).outcomeReason).toContain('AC-1 waits for a decision before delivery');
  });

  it('a blocking finding of a review that asked for repair becomes a repair brief for the next attempt, once', async () => {
    const { cand } = await setup();
    record(cand, 'REPAIR_REQUIRED', [finding('COR-1')]);
    expect(await run()).toEqual({ progressed: true });
    expect(state()).toBe('REPAIRING');
    const stored = JSON.parse(readFileSync(briefPath(lab.ctx(), 2), 'utf8'));
    expect(stored).toMatchObject({ attempt: 2, source: 'review' });
    expect(stored.brief.experiment).toContain('Add a test asserting mul("a", 2) throws');
    expect(stored.brief.preserved_constraints.some((c: string) => c.includes('validation for finding COR-1'))).toBe(true);
    const repairs = lab.db.all<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = ?", lab.runId, REVIEW_REPAIR_EVENT);
    expect(repairs).toHaveLength(1);
    expect(JSON.parse(repairs[0]!.data_json)).toMatchObject({ attempt: 2, tree_hash: cand.treeHash, findings: [{ external_id: 'COR-1' }] });
    expect(decisions('repair.brief')[0]?.summary).toContain('COR-1 (review 1) (high)');
  });

  it('one-line finding text in the gate and the repair brief is cut at a word boundary with an ellipsis, never mid-word', async () => {
    const { cand } = await setup();
    const claim = 'The fail-before evidence for AC-1, AC-2 and AC-3 shows only a load failure. It does not show that any assertion about the criteria failed. The new tests depend on the missing method and nothing else, so a stub that compiles would make them fail differently.';
    record(cand, 'REPAIR_REQUIRED', [finding('TEST-1', { claim })]);
    await run();
    const lines = [decisions('gate.independent_review')[0]!.summary, decisions('repair.brief')[0]!.summary];
    for (const line of lines) {
      expect(line).toContain('TEST-1');
      expect(line).not.toMatch(/about th(\.\.\.)?($|[ ;)])/);
      const quoted = /(The fail-before[^;]*)/.exec(line)![1]!;
      expect(quoted.endsWith('...')).toBe(true);
      const kept = quoted.slice(0, -3);
      expect(claim.startsWith(kept)).toBe(true);
      expect(/[\s,;:]/.test(claim[kept.length]!)).toBe(true);
    }
  });

  it('several findings share one brief, a reused brief file is kept, and a finding without a suggested validation gets one built from the claim', async () => {
    const { cand } = await setup();
    record(cand, 'REPAIR_REQUIRED', [finding('COR-1'), finding('COR-2', { claim: 'a different defect entirely, in the parser', suggestedValidation: null, location: null, path: null, line: null, category: '' })]);
    mkdirSync(join(lab.ctx().runDir, 'briefs'), { recursive: true });
    writeFileSync(briefPath(lab.ctx(), 2), JSON.stringify({ attempt: 2, source: 'review', fingerprint: 'kept', brief: { kept: true } }));
    await run();
    expect(state()).toBe('REPAIRING');
    expect(JSON.parse(readFileSync(briefPath(lab.ctx(), 2), 'utf8')).fingerprint).toBe('kept');
    expect(decisions('repair.brief')[0]?.summary).toContain('COR-2');
  });

  it('a review with no findings to repair and no approval blocks the run with the gate\'s reasons', async () => {
    const { cand } = await setup();
    record(cand, 'BLOCK', [finding('SEC-1', { severity: 'low' })]);
    await run();
    expect(state()).toBe('BLOCKED');
    expect(getRun(lab.db, lab.runId).outcomeReason).toContain(`independent review does not clear tree ${cand.treeHash}`);
    expect(JSON.parse(getRun(lab.db, lab.runId).outcomeJson!).open_findings).toBeDefined();
  });

  it('a review with no verdict that clears and nothing open says there is no approving review', async () => {
    const { cand } = await setup();
    record(cand, 'BLOCK', []);
    await run();
    expect(state()).toBe('BLOCKED');
    expect(getRun(lab.db, lab.runId).outcomeReason).toContain('independent review does not clear tree');
  });

  it('stops when no review round is left for the repaired tree, naming the open findings, BLOCKED with the verified candidate offered (#169)', async () => {
    const { cand } = await setup();
    record(cand, 'REPAIR_REQUIRED', [finding('COR-1')]);
    lab.db.run("UPDATE budget_counters SET used = allowance WHERE counter = 'review_rounds'");
    await run();
    expect(state()).toBe('BLOCKED');
    expect(getRun(lab.db, lab.runId).outcomeReason).toMatch(/^review_rounds hard cap reached \(\d+ of \d+\) with 1 open finding\(s\): COR-1 \(review 1\) \(high\)/);
    // The candidate passed verification: the run that ran out offers it instead of ending EXHAUSTED.
    expect(JSON.parse(getRun(lab.db, lab.runId).outcomeJson!)).toMatchObject({ decided: 'EXHAUSTED', verified_candidate: { candidate_id: cand.id, commit: cand.commitSha } });
    expect(getRun(lab.db, lab.runId).failureClass).toBe('review-dispute');
  });

  it('stops when no implementation attempt is left under the hard cap (BLOCKED, offering the verified candidate: #169)', async () => {
    const { cand } = await setup();
    record(cand, 'REPAIR_REQUIRED', [finding('COR-1')]);
    lab.db.run("UPDATE budget_counters SET used = hard_cap WHERE counter = 'implementation_attempts'");
    await run();
    expect(state()).toBe('BLOCKED');
    expect(getRun(lab.db, lab.runId).outcomeReason).toContain('implementation attempts hard cap reached');
  });

  it('asks for an extension when the allowance is spent, and records the decision either way', async () => {
    const { cand } = await setup();
    record(cand, 'REPAIR_REQUIRED', [finding('COR-1')]);
    lab.db.run("UPDATE budget_counters SET used = allowance WHERE counter = 'implementation_attempts'");
    await run();
    expect(decisions('allowance.extend').length + decisions('allowance.deny').length).toBe(1);
    if (state() === 'EXHAUSTED') expect(getRun(lab.db, lab.runId).outcomeReason).toContain('implementation attempt allowance spent');
    else expect(state()).toBe('REPAIRING');
  });

  it('a finding about financial semantics goes to the inquisition first, once, and is then repaired', async () => {
    const { cand } = await setup();
    record(cand, 'REPAIR_REQUIRED', [finding('BILL-1', { severity: 'high', category: 'billing', claim: 'The invoice total rounds a refund in an undecided way; the product decision on partial refunds is not specified', evidence: 'refund amount is ambiguous' })]);
    await run();
    expect(state()).toBe('INQUISITION');
    const ev = lab.db.get<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'state.transition' AND to_state = 'INQUISITION'", lab.runId);
    const trigger = JSON.parse(ev!.data_json).data.trigger;
    expect(['hidden_decision', 'reviewer_disagreement']).toContain(trigger.kind);
    expect(trigger.summary).toContain('BILL-1 (');
    // The inquiry settled; the same condition does not fire again, and the finding is repaired.
    lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 1, 'inquisition.completed', 'x', ?)", lab.runId, JSON.stringify({ key: trigger.key }));
    lab.db.run("UPDATE runs SET state = 'REVIEWING' WHERE id = ?", lab.runId);
    await run();
    expect(state()).toBe('REPAIRING');
  });

  // 0.3.0 retest: the required run's last Inquisition ($0.04) ran after review_rounds 4 of 4, and the run then ended
  // EXHAUSTED anyway. With no round left nothing the inquiry decides can be reviewed, so no model session starts.
  it('at the review_rounds hard cap a finding bound for the inquisition ends the run there: no inquisitor starts', async () => {
    const { cand } = await setup();
    record(cand, 'REPAIR_REQUIRED', [finding('BILL-1', { severity: 'high', category: 'billing', claim: 'The invoice total rounds a refund in an undecided way; the product decision on partial refunds is not specified', evidence: 'refund amount is ambiguous' })]);
    lab.db.run("UPDATE budget_counters SET used = hard_cap WHERE counter = 'review_rounds'");
    expect(await run()).toMatchObject({ done: true });
    expect(state()).toBe('BLOCKED');
    expect(getRun(lab.db, lab.runId).outcomeReason).toMatch(/^review_rounds hard cap reached \((\d+) of \1\) with 1 open finding\(s\): BILL-1 \(review \d+\) \(high\)/);
    expect(lab.db.all("SELECT 1 FROM events WHERE run_id = ? AND type = 'state.transition' AND to_state = 'INQUISITION'", lab.runId)).toEqual([]);
  });

  it('at the review_rounds hard cap a claim that needs a discriminating test ends the run too, instead of an inquiry', async () => {
    const { cand } = await setup();
    record(cand, 'BLOCK', [finding('CLM-1', { severity: 'medium', category: 'correctness', claim: 'calc may overflow for very large operands in some environments', evidence: 'maybe' })]);
    lab.db.run("UPDATE budget_counters SET used = hard_cap WHERE counter = 'review_rounds'");
    await run();
    expect(state()).toBe('BLOCKED');
    expect(getRun(lab.db, lab.runId).outcomeReason).toMatch(/^review_rounds hard cap reached \((\d+) of \1\) with 1 review claim\(s\) still needing a discriminating test: CLM-1 \(review \d+\) \(/);
    expect(lab.db.all("SELECT 1 FROM events WHERE run_id = ? AND type = 'state.transition' AND to_state = 'INQUISITION'", lab.runId)).toEqual([]);
  });

  it('at the cap a claim inquiry still runs where its verdict alone can clear the tree: an approving review is there, and refuting the claim needs no further round', async () => {
    const { cand } = await setup();
    record(cand, 'APPROVE', []);
    record(cand, 'BLOCK', [finding('CLM-2', { severity: 'medium', category: 'correctness', claim: 'calc drops the sign of a negative zero', evidence: 'maybe' })], 'claude');
    lab.db.run("UPDATE budget_counters SET used = hard_cap WHERE counter = 'review_rounds'");
    await run();
    expect(state()).toBe('INQUISITION');
    const ev = lab.db.get<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'state.transition' AND to_state = 'INQUISITION'", lab.runId);
    const trigger = JSON.parse(ev!.data_json).data.trigger;
    insertLedgerEntry(lab.db, { runId: lab.runId, claim: 'CLM-2 does not hold: calc keeps -0', source: 'inquisition', confidence: 'high', consequence: null, reversibility: 'reversible', experiment: null, status: 'rejected', evidence: [{ kind: 'inspection', ref: 'apps/calc.mjs:2', at: 1 }] }, lab.ctx().clock);
    lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 1, 'inquisition.completed', 'x', ?)", lab.runId, JSON.stringify({ key: trigger.key }));
    lab.db.run("UPDATE runs SET state = 'REVIEWING' WHERE id = ?", lab.runId);
    await run();
    expect(state()).toBe('DELIVERING');
  });

  it('with the policy switch off the material-semantics check is not consulted', async () => {
    const { cand } = await setup({ tweak: (c) => void (c.ambiguity.block_security_or_data_semantics = false) });
    record(cand, 'REPAIR_REQUIRED', [finding('BILL-1', { severity: 'medium', category: 'billing', claim: 'refund rounding is undecided' })]);
    await run();
    expect(['REPAIRING', 'INQUISITION']).toContain(state());
  });

  it('a finding that matches a topic the contract lists as material is escalated for that reason', async () => {
    const { cand } = await setup();
    setContract(lab, { baseline_revision: cand.parentSha, allowed_paths: ['apps/calc.mjs'], escalation: { material_topics: ['refund rounding'] } });
    record(cand, 'REPAIR_REQUIRED', [finding('BILL-2', { severity: 'high', category: 'billing', claim: 'The refund rounding differs between the invoice and the ledger', evidence: 'rounding' })]);
    await run();
    expect(state()).toBe('INQUISITION');
    const ev = lab.db.get<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'state.transition' AND to_state = 'INQUISITION'", lab.runId);
    expect(JSON.parse(ev!.data_json).data.trigger.summary).toContain('the contract lists "refund rounding" as material');
  });

  it('a claim that needs a discriminating test goes to the inquisition once, and then to a repair attempt instead of a dead-end block', async () => {
    const { cand } = await setup();
    record(cand, 'BLOCK', [finding('CLM-1', { severity: 'medium', category: 'correctness', claim: 'calc may overflow for very large operands in some environments', evidence: 'maybe' })]);
    await run();
    expect(state()).toBe('INQUISITION');
    const ev = lab.db.get<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'state.transition' AND to_state = 'INQUISITION'", lab.runId);
    const trigger = JSON.parse(ev!.data_json).data.trigger;
    expect(trigger).toMatchObject({ kind: 'reviewer_disagreement', mode: 'reconcile' });
    expect(trigger.summary).toBe('1 review claim(s) need a discriminating test before they can be accepted or rejected');
    lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 1, 'inquisition.completed', 'x', ?)", lab.runId, JSON.stringify({ key: trigger.key }));
    lab.db.run("UPDATE runs SET state = 'REVIEWING' WHERE id = ?", lab.runId);
    await run();
    // The inquiry is settled and neither supported nor refuted the claim: it goes to a repair attempt that runs its
    // discriminating test, never left pending into BLOCKED (P4), and nobody's say-so accepts it.
    expect(state()).toBe('REPAIRING');
    expect(listFindings(lab.db, lab.runId)[0]!.status).toBe('claim_pending');
    expect(decisions('review.finding.accepted')).toEqual([]);
  });

  /** A claim sent to the Inquisition, whose inquiry then settles with the given ledger entry. */
  async function inquiredClaim(ledger: { claim: string; status: 'supported' | 'rejected' }): Promise<void> {
    const { cand } = await setup();
    record(cand, 'BLOCK', [finding('CLM-2', { severity: 'medium', category: 'correctness', claim: 'calc drops the sign of a negative zero', evidence: 'maybe' })]);
    await run();
    expect(state()).toBe('INQUISITION');
    const ev = lab.db.get<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'state.transition' AND to_state = 'INQUISITION'", lab.runId);
    const trigger = JSON.parse(ev!.data_json).data.trigger;
    insertLedgerEntry(lab.db, { runId: lab.runId, claim: ledger.claim, source: 'inquisition', confidence: 'high', consequence: null, reversibility: 'reversible', experiment: null, status: ledger.status, evidence: [{ kind: 'inspection', ref: 'apps/calc.mjs:2', at: 1 }] }, lab.ctx().clock);
    lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 1, 'inquisition.completed', 'x', ?)", lab.runId, JSON.stringify({ key: trigger.key }));
    lab.db.run("UPDATE runs SET state = 'REVIEWING' WHERE id = ?", lab.runId);
    await run();
  }

  it('a claim the inquiry supports in its ledger is accepted on that record and repaired', async () => {
    await inquiredClaim({ claim: 'CLM-2 holds: calc returns 0 for -0', status: 'supported' });
    expect(state()).toBe('REPAIRING');
    expect(listFindings(lab.db, lab.runId)[0]!.status).toBe('accepted');
    expect(decisions('review.finding.accepted').map((d) => d.summary).join(' ')).toMatch(/accepted by the Inquisition .*ledger entry \S+ supports it/);
  });

  it('a claim the inquiry rejects in its ledger on evidence is rejected and not repaired', async () => {
    await inquiredClaim({ claim: 'CLM-2 does not hold: calc keeps -0', status: 'rejected' });
    expect(state()).not.toBe('REPAIRING');
    expect(listFindings(lab.db, lab.runId)[0]!.status).toBe('rejected');
  });

  it('a REPAIR_REQUIRED review whose findings are below the blocking severity does not force a repair', async () => {
    const { cand } = await setup();
    record(cand, 'REPAIR_REQUIRED', [finding('NIT-1', { severity: 'low', category: 'style', claim: 'a naming nit in calc', evidence: 'naming' })]);
    await run();
    expect(['BLOCKED', 'REPAIRING', 'INQUISITION']).toContain(state());
  });

  it('issue #168: review clearing the tree settles the attempt as verified', async () => {
    const { cand } = await setup();
    routed(1);
    record(cand, 'APPROVE');
    await run();
    expect(state()).toBe('DELIVERING');
    expect(routeOutcomes()).toEqual([{ attempt_key: 'attempt:1', outcome: 'verified', evidence_ref: `review-gate:${cand.treeHash}` }]);
  });

  it('issue #168: review sending the verified candidate to repair settles the attempt as rejected', async () => {
    const { cand } = await setup();
    routed(1);
    record(cand, 'REPAIR_REQUIRED', [finding('COR-1')]);
    await run();
    expect(state()).toBe('REPAIRING');
    expect(routeOutcomes()).toEqual([{ attempt_key: 'attempt:1', outcome: 'rejected', evidence_ref: `review-gate:${cand.treeHash}` }]);
  });

  // #156: three repairs of one carried test finding ran out of turns with no report; only the same tree stopped them.
  it('a carried finding going to repair again after a repair whose implementer named no test for it ends as non-progress, not with another brief (BLOCKED, offering the verified candidate: #169)', async () => {
    // Its one re-review (ADR 0015, amendment of 2026-11-16) finds it still present, as it was raised.
    const { cand, repo } = await setup({ reviewer: answers() });
    const { IMPLEMENTER_OUTPUT } = await import('../../integration/controller/harness.ts');
    routed(1);
    record(cand, 'REPAIR_REQUIRED', [finding('TEST-1')]);
    await run();
    expect(state()).toBe('REPAIRING');
    /** Attempt n's tree, from an implementer that ended with `outcome`, then a review that raises nothing new. */
    const attempt = async (n: number, outcome: Parameters<typeof finishWorker>[2]) => {
      writeFileSync(join(repo.worktree, 'apps', 'calc.mjs'), `export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b; // ${n}\n`);
      const c = await snapshotCandidate({ db: lab.db, clock: lab.clock, repoRoot: lab.repo, worktree: repo.worktree, runId: lab.runId, baseRev: cand.parentSha, attempt: n, workerId: null });
      lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 1, 'implementation.attempt', 'x', ?)", lab.runId, JSON.stringify({ attempt: n }));
      lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 1, 'implementation.candidate', 'x', ?)", lab.runId, JSON.stringify({ attempt: n, candidate_id: c.id }));
      routed(n);
      addEvidence(lab, c);
      const w = planWorker(lab.db, { id: `wrk-impl-${n}`, runId: lab.runId, role: 'implementer', provider: 'claude', attempt: n, workerDir: join(lab.base, `wi${n}`), cwd: lab.repo }, lab.clock, OWNER);
      markWorkerRunning(lab.db, w.id, { pid: 2_000_000_000, pgid: 2_000_000_000, procStart: 'x' }, lab.clock, OWNER);
      finishWorker(lab.db, w.id, outcome, lab.clock, OWNER);
      record(c, 'REPAIR_REQUIRED', []);
      lab.db.run("UPDATE runs SET state = 'REVIEWING' WHERE id = ?", lab.runId);
    };
    const usage = { provider: 'claude', model: null, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null, costSource: 'unavailable' };
    const named = { ...IMPLEMENTER_OUTPUT, evidence_refs: [{ criterion_id: null, ref: 'tests/test-1.test.mjs', note: 'validation for finding TEST-1' }] };
    // The first repair names a test for TEST-1, so sending it again is not yet non-progress. Carried, and settled by no
    // test, TEST-1 first gets its one re-review, which finds it still present: the repair goes on.
    await attempt(2, { state: 'SUCCEEDED', resultStatus: 'succeeded', result: { status: 'succeeded', structured: named, text: null, error: null, exitCode: 0, usage, durationMs: 1 } });
    await settle();
    expect(state()).toBe('REPAIRING');
    expect(decisions('review.finding-rereview')).toHaveLength(1);
    expect(existsSync(briefPath(lab.ctx(), 3))).toBe(true);
    // The second ends at its turn cap without a report: it named no test, and TEST-1 would go to repair unchanged. It had
    // its one re-review, so none is asked.
    await attempt(3, { state: 'FAILED', resultStatus: 'max_turns', error: 'reached the maximum number of turns' });
    expect(await run()).toMatchObject({ done: true });
    expect(state()).toBe('BLOCKED');
    expect(decisions('review.finding-rereview')).toHaveLength(1);
    expect(existsSync(briefPath(lab.ctx(), 4))).toBe(false);
    expect(lab.db.all('SELECT 1 FROM events WHERE run_id = ? AND type = ?', lab.runId, REVIEW_REPAIR_EVENT)).toHaveLength(2);
    expect(decisions('repair.non-progress')).toHaveLength(1);
    const reason = getRun(lab.db, lab.runId).outcomeReason!;
    expect(reason).toMatch(/^non-progress: the review repair brief of attempt 3 was sent TEST-1, and no implementer report since names a test for it \(the implementer of attempt 3 ended FAILED \(max_turns\) without a report\)/);
    expect(reason).toMatch(/open findings: TEST-1 \(review \d+\) \(high\)/);
    expect(JSON.parse(getRun(lab.db, lab.runId).outcomeJson!).open_findings.map((f: { external_id: string }) => f.external_id)).toEqual(['TEST-1']);
    // Issue #168: every attempt review refused is settled as rejected, the last one on the non-progress path too.
    expect(routeOutcomes().map((r) => [r.attempt_key, r.outcome])).toEqual([
      ['attempt:1', 'rejected'],
      ['attempt:2', 'rejected'],
      ['attempt:3', 'rejected'],
    ]);
  });

  it('an external id two briefed findings share does not count as naming either of them (#156)', async () => {
    const { cand, repo } = await setup({ reviewer: answers() });
    const { IMPLEMENTER_OUTPUT } = await import('../../integration/controller/harness.ts');
    record(cand, 'REPAIR_REQUIRED', [finding('TEST-1')]);
    record(cand, 'REPAIR_REQUIRED', [finding('TEST-1', { claim: 'a second, different claim about mul', location: 'apps/calc.mjs:1', line: 1 })]);
    await run();
    expect(state()).toBe('REPAIRING');
    const ambiguous = { ...IMPLEMENTER_OUTPUT, evidence_refs: [{ criterion_id: null, ref: 'tests/test-1.test.mjs', note: 'validation for finding TEST-1' }] };
    const reported = { state: 'SUCCEEDED', resultStatus: 'succeeded', result: { status: 'succeeded', structured: ambiguous, text: null, error: null, exitCode: 0, usage: USAGE, durationMs: 1 } } as Parameters<typeof finishWorker>[2];
    // Both findings are carried and no test settles them: each gets its one re-review (ADR 0015, amended), which finds
    // it still present, and the repair goes on.
    await repairAttempt(cand.parentSha, repo, 2, reported);
    await settle();
    expect(state()).toBe('REPAIRING');
    expect(decisions('review.finding-rereview')).toHaveLength(2);
    // Carried again, with no re-review left: a report that names only the id both share names neither, so the run stops.
    await repairAttempt(cand.parentSha, repo, 3, reported);
    expect(await run()).toMatchObject({ done: true });
    expect(state()).toBe('BLOCKED');
    expect(decisions('repair.non-progress')).toHaveLength(1);
    expect(decisions('review.finding-rereview')).toHaveLength(2);
  });
});

describe("a carried finding's one re-review (ADR 0015, amendment of 2026-11-16)", () => {
  /** Review 1 raises `first`; attempt 2 ends at its turn cap without a report; review 2 raises `second` on its tree. */
  async function carried(first: IngestedFinding[], second: IngestedFinding[], o: Setup = {}) {
    const { cand, repo } = await setup(o);
    record(cand, 'REPAIR_REQUIRED', first);
    await run();
    expect(state()).toBe('REPAIRING');
    return repairAttempt(cand.parentSha, repo, 2, TURN_CAPPED, second);
  }
  const TEST_2 = finding('TEST-2', { claim: 'a second, different claim about mul', location: 'apps/calc.mjs:1', line: 1 });
  const evidenceRefs = (f: { resolutionJson: unknown }): unknown => (f.resolutionJson as { evidence_refs?: unknown } | null)?.evidence_refs;

  it('two carried findings: the first is dropped, a pass after that keeps its record, and the second, still present, ends the run at the review round cap', async () => {
    await carried([finding('TEST-1'), TEST_2], [finding('TEST-1'), TEST_2], { reviewer: answers({ 'TEST-1': 'gone' }), tweak: (c) => void (c.scheduler.hard_limits.review_rounds = 2) });
    await settle();
    expect(state()).toBe('BLOCKED');
    expect(getRun(lab.db, lab.runId).outcomeReason).toMatch(/^review_rounds hard cap reached \(2 of 2\) with 1 open finding\(s\): TEST-2/);
    expect(decisions('review.finding-rereview')).toHaveLength(2);
    const all = listFindings(lab.db, lab.runId);
    for (const f of all.filter((x) => x.externalId === 'TEST-1')) {
      expect(f.status).toBe('rejected');
      expect(f.resolution).toMatch(/^dropped: its one re-review \S+ by codex of tree \w+, told it by id with the candidate's diff and evidence, found the defect gone: tests\/mul\.test\.mjs:3 covers TEST-1/);
      expect(evidenceRefs(f)).toEqual([expect.stringMatching(/^rereview:/)]);
    }
    for (const f of all.filter((x) => x.externalId === 'TEST-2')) expect(f.status).toBe('claim_pending');
  });

  it('never approves the tree: once the finding is dropped, the low finding of the same review still goes to repair', async () => {
    const low = finding('LOW-2', { severity: 'low', claim: 'mul has no doc comment' });
    await carried([finding('TEST-1')], [finding('TEST-1'), low], { reviewer: answers({ 'TEST-1': 'gone' }) });
    await settle();
    expect(state()).toBe('REPAIRING');
    expect(listReviews(lab.db, lab.runId).map((r) => r.verdict)).toEqual(['REPAIR_REQUIRED', 'REPAIR_REQUIRED']);
    const all = listFindings(lab.db, lab.runId);
    expect(all.filter((f) => f.externalId === 'TEST-1').map((f) => f.status)).toEqual(['rejected', 'rejected']);
    const brief = JSON.parse(readFileSync(briefPath(lab.ctx(), 3), 'utf8')) as { refs: string[] };
    expect(brief.refs).toEqual(all.filter((f) => f.externalId === 'LOW-2').map((f) => f.id));
  });

  it('a re-reviewer that fails is replaced by another that did not raise the finding, not by the one that raised it', async () => {
    const reviewer = { command: 'codex', data_policy_eligible: true, model: 'gpt-6-astra', reasoning_effort: null, extra_args: [] };
    await carried([finding('TEST-1')], [finding('TEST-1')], {
      reviewer: answers({ 'TEST-1': 'gone' }),
      tweak: (c) => {
        c.providers['codex-b'] = reviewer;
        c.providers['codex-c'] = reviewer;
        c.review = { ...c.review, providers: ['codex', 'codex-b', 'codex-c'], when_unavailable: 'block' };
      },
    });
    lab.deps.adapters = { ...lab.deps.adapters, 'codex-b': scriptedAdapter(lab, () => okResult(null, { status: 'failed', error: 'crashed' })), 'codex-c': scriptedAdapter(lab, answers({ 'TEST-1': 'gone' })) };
    await settle(30);
    const sessions = listWorkers(lab.db, { runId: lab.runId, role: 'reviewer' }).filter((w) => w.purpose?.startsWith('review-finding:'));
    expect(sessions.map((w) => w.provider)).toEqual(['codex-b', 'codex-b', 'codex-c']);
    expect(decisions('review.finding-rereview.select').map((d) => d.summary)).toEqual([
      expect.stringMatching(/^re-reviewer of finding TEST-1: codex-b\/gpt-6-astra \(independent\), not codex, which raised it$/),
      expect.stringMatching(/^re-reviewer of finding TEST-1: codex-c\/gpt-6-astra \(independent\), not codex, which raised it$/),
    ]);
    expect(listFindings(lab.db, lab.runId).filter((f) => f.externalId === 'TEST-1').map((f) => f.status)).toEqual(['rejected', 'rejected']);
  });

  it("dropping the tree's only finding asks one full fresh review of the tree, and its APPROVE delivers", async () => {
    const { cand, repo, reviewer } = await setup({ reviewer: answers({ 'TEST-1': 'gone' }) });
    record(cand, 'REPAIR_REQUIRED', [finding('TEST-1')]);
    await run();
    await repairAttempt(cand.parentSha, repo, 2, TURN_CAPPED, [finding('TEST-1')]);
    await settle(20);
    expect(state()).toBe('DELIVERING');
    expect(decisions('review.fresh').map((d) => (d.data as { reason: string }).reason)).toEqual(['rereview']);
    expect(listReviews(lab.db, lab.runId).map((r) => r.verdict)).toEqual(['REPAIR_REQUIRED', 'REPAIR_REQUIRED', 'APPROVE']);
    // The fresh review is the normal review of the tree: told no finding, no note, nothing to follow.
    const fresh = reviewer.specs.at(-1)!.prompt;
    expect(fresh).not.toContain('This is a re-review');
    expect(fresh).not.toContain('This is a fresh review');
  });

  it('a dropped finding the fresh review of the tree raises again is a new claim: it takes the normal paths, to repair', async () => {
    const { IMPLEMENTER_OUTPUT } = await import('../../integration/controller/harness.ts');
    // Attempt 2 names a test for TEST-1, so sending it to repair again is no non-progress (#156).
    const named = { state: 'SUCCEEDED', resultStatus: 'succeeded', result: { status: 'succeeded', structured: { ...IMPLEMENTER_OUTPUT, evidence_refs: [{ criterion_id: null, ref: 'tests/test-1.test.mjs', note: 'validation for finding TEST-1' }] }, text: null, error: null, exitCode: 0, usage: USAGE, durationMs: 1 } } as Parameters<typeof finishWorker>[2];
    const { cand, repo } = await setup({ reviewer: answers({ 'TEST-1': 'gone' }, [finding('TEST-1')]) });
    record(cand, 'REPAIR_REQUIRED', [finding('TEST-1')]);
    await run();
    await repairAttempt(cand.parentSha, repo, 2, named, [finding('TEST-1')]);
    await settle(20);
    expect(decisions('review.fresh')).toHaveLength(1);
    expect(state()).toBe('REPAIRING');
    const test1 = listFindings(lab.db, lab.runId).filter((f) => f.externalId === 'TEST-1');
    // Dropped as the re-review answered; raised again by the fresh review, the new finding is open and goes to repair.
    expect(test1.map((f) => f.status)).toEqual(['rejected', 'rejected', 'claim_pending']);
    const brief = JSON.parse(readFileSync(briefPath(lab.ctx(), 3), 'utf8')) as { refs: string[] };
    expect(brief.refs).toContain(test1[2]!.id);
  });

  it("dropping the tree's only finding with no review round left ends BLOCKED offering the verified candidate", async () => {
    await carried([finding('TEST-1')], [finding('TEST-1')], { reviewer: answers({ 'TEST-1': 'gone' }), tweak: (c) => void (c.scheduler.hard_limits.review_rounds = 1) });
    await settle();
    expect(state()).toBe('BLOCKED');
    expect(decisions('review.fresh')).toEqual([]);
    const run = getRun(lab.db, lab.runId);
    expect(run.outcomeReason).toMatch(/no fresh review of the tree was started: review_rounds hard cap reached \(1 of 1\)/);
    expect(run.outcomeReason).toMatch(/The run holds a verified candidate: candidate 2 \(commit \w+, ref refs\/orbit\/\S+\/candidates\/2\)/);
    const outcome = JSON.parse(run.outcomeJson!) as { decided?: string; verified_candidate?: { seq: number } };
    expect(outcome).toMatchObject({ decided: 'BLOCKED', verified_candidate: { seq: 2 } });
  });

  it('an answer that asks for repair without naming the finding keeps it: it is not read as gone', async () => {
    await carried([finding('TEST-1')], [finding('TEST-1')], { reviewer: answers({ 'TEST-1': 'other' }) });
    await settle();
    expect(listFindings(lab.db, lab.runId).filter((f) => f.externalId === 'TEST-1').map((f) => f.status)).toEqual(['claim_pending', 'claim_pending']);
    expect(listFindings(lab.db, lab.runId).some((f) => f.externalId === 'OTHER-1')).toBe(false);
    expect(state()).toBe('REPAIRING');
  });
});

describe('a review that has to be run', () => {
  it('selects the independent reviewer once, builds the packet and a read-only checkout, runs the reviewer and approves', async () => {
    const { cand, reviewer } = await setup();
    const first = await run();
    expect(first.waiting).toMatch(/is running$/);
    const spec = reviewer.specs[0]!;
    expect(spec).toMatchObject({ role: 'reviewer', readOnly: true });
    expect(existsSync(join(lab.ctx().runDir, 'reviews', String(cand.seq), 'packet.md'))).toBe(true);
    expect(decisions('review.select').length + decisions('route.review').length + lab.db.all("SELECT 1 FROM decisions WHERE id LIKE 'dec-%-review-select-%'").length).toBeGreaterThan(0);
    const out = await settle();
    expect(out).toEqual({ progressed: true });
    expect(state()).toBe('DELIVERING');
    expect(listReviews(lab.db, lab.runId)).toHaveLength(1);
    expect(listReviews(lab.db, lab.runId)[0]).toMatchObject({ provider: 'codex', verdict: 'APPROVE' });
    expect(implementerProvider(lab.ctx())).toBe('claude');
    expect(lab.ctx().ledger!.state('review_rounds').used).toBe(1);
  });

  // The second 0.3.1 retest: the role prompt told every reviewer "You have no shell; use Read, Grep and Glob", tools only
  // the Claude CLI has, so a Codex reviewer found no way to open a file and judged from the packet alone.
  it('tells a Codex reviewer to inspect the checkout with read-only shell commands, never that it has no shell', async () => {
    const { reviewer } = await setup();
    await run();
    const said = `${reviewer.specs[0]!.systemPrompt}\n${reviewer.specs[0]!.prompt}`;
    expect(said).toMatch(/read-only shell commands/);
    expect(said).not.toMatch(/You have no shell/);
    expect(said).not.toMatch(/use Read, Grep and Glob/);
  });

  it('runs the Codex reviewer at the configured review effort, medium unless told otherwise', async () => {
    const { reviewer } = await setup();
    await run();
    expect(reviewer.specs[0]).toMatchObject({ effort: 'medium' });
    cleanLab();
    const high = await setup({ tweak: (c) => { c.providers.codex!.review_reasoning_effort = 'high'; } });
    await run();
    expect(high.reviewer.specs[0]).toMatchObject({ effort: 'high' });
  });

  it('records how deep the review session went, from its transcript, when it records the review', async () => {
    const answerOnly = [{ type: 'item.completed', item: { type: 'agent_message', text: '{}' } }, { type: 'turn.completed', usage: { output_tokens: 69, reasoning_output_tokens: 17 } }];
    await setup({ onReviewerStart: (spec) => writeFileSync(join(spec.workerDir, 'log.jsonl'), `${answerOnly.map((e) => JSON.stringify(e)).join('\n')}\n`) });
    await settle();
    const [review] = listReviews(lab.db, lab.runId, { includeInvalidated: true });
    const depth = decisions('review.depth');
    expect(depth.length).toBeGreaterThanOrEqual(1);
    expect(depth[0]!.data).toMatchObject({ review_id: review!.id, provider: 'codex', tool_calls: 0, reasoning_tokens: 17 });
    expect(depth[0]!.summary).toContain('NO TOOL CALLS');
  });

  it('a review of another revision is asked for again, and after the limit the run ends without a review', async () => {
    await setup({ tweak: (c) => void (c.review = { ...c.review, when_unavailable: 'block' }), reviewer: () => okResult({ verdict: 'APPROVE', candidate_revision: 'f'.repeat(40), findings: [] }) });
    const out = await settle();
    expect(out).toMatchObject({ done: true });
    expect(['BLOCKED', 'EXHAUSTED']).toContain(state());
    expect(listReviews(lab.db, lab.runId)).toHaveLength(0);
  });

  it('records a REPAIR_REQUIRED review with its findings and goes on to repair', async () => {
    await setup({
      reviewer: ({ spec }) => okResult({ verdict: 'REPAIR_REQUIRED', candidate_revision: spec.prompt.match(/candidate revision ([0-9a-f]{40})/)?.[1], findings: [{ id: 'COR-1', severity: 'high', category: 'correctness', location: 'apps/calc.mjs:2', claim: 'mul accepts non-numeric arguments and returns NaN', evidence: 'mul("a", 2) is NaN', suggested_validation: 'assert it throws' }] }),
    });
    await settle();
    expect(state()).toBe('REPAIRING');
    expect(listFindings(lab.db, lab.runId)).toHaveLength(1);
  });

  it('an independent reviewer that is not usable blocks the run; credentials that cannot be used block it on the provider', async () => {
    // review.when_unavailable: block, the default before decision 0007 (#6, #8); with claude, Claude would review.
    const blocking = (c: import('../../../src/policy/types.ts').OrbitConfig) => void (c.review.when_unavailable = 'block');
    await setup({ tweak: blocking });
    lab.deps.adapters = { claude: claude(), codex: { ...scriptedAdapter(lab, () => null), validateCredentials: async () => ({ state: 'expired', method: 'oauth', detail: 'token expired' }), discoverCapabilities: async () => ({ provider: 'codex', available: true, version: '1', models: [], structuredOutput: true, readOnlySandbox: true, usageReporting: 'full', costReporting: true, detail: '' }) } as never };
    await run();
    expect(state()).toBe('BLOCKED');
    expect(getRun(lab.db, lab.runId).outcomeReason).toContain('codex credentials');
    cleanLab();
    await setup({ tweak: blocking });
    lab.deps.adapters = { claude: claude() };
    await run();
    expect(state()).toBe('BLOCKED');
    expect(getRun(lab.db, lab.runId).outcomeReason).toMatch(/independent review unavailable|credentials/);
  });

  it('a reviewer worker that ends badly is retried and then blocks the run, leaving no checkout', async () => {
    await setup({ tweak: (c) => void (c.review = { ...c.review, when_unavailable: 'block' }), reviewer: () => okResult(null, { status: 'failed', error: 'crashed' }) });
    const out = await settle();
    expect(out).toMatchObject({ done: true });
    expect(state()).toBe('BLOCKED');
    expect(existsSync(join(lab.home, 'worktrees', `review-${lab.ctx().candidate!.seq}`))).toBe(false);
  });
});

// ADR 0016, item 3: on the 0.3.1 retest every Codex review approved from the packet alone (no tool call). An APPROVE
// that inspected nothing does not clear the tree: one fresh review at high effort must open the files.
describe('a review that inspected nothing does not clear the tree', () => {
  const answerOnly = [{ type: 'item.completed', item: { type: 'agent_message', text: '{}' } }, { type: 'turn.completed', usage: { output_tokens: 69, reasoning_output_tokens: 17 } }];
  const inspected = [{ type: 'item.completed', item: { type: 'command_execution', command: 'cat apps/calc.mjs', exit_code: 0 } }, ...answerOnly];
  /** Each reviewer session writes the next transcript (the last one repeats). */
  const transcripts = (...ts: Record<string, unknown>[][]) => {
    let n = 0;
    return (spec: { workerDir: string }) => writeFileSync(join(spec.workerDir, 'log.jsonl'), `${ts[Math.min(n++, ts.length - 1)]!.map((e) => JSON.stringify(e)).join('\n')}\n`);
  };

  it('asks one fresh review at high effort that must open the files, and one that does clears the tree', async () => {
    const { reviewer } = await setup({ onReviewerStart: transcripts(answerOnly, inspected) });
    await settle();
    expect(state()).toBe('DELIVERING');
    expect(reviewer.specs).toHaveLength(2);
    expect(reviewer.specs[0]).toMatchObject({ effort: 'medium' });
    expect(reviewer.specs[1]).toMatchObject({ effort: 'high' });
    expect(reviewer.specs[1]!.prompt).toMatch(/approved from the review packet alone/);
    expect(decisions('review.fresh').map((d) => (d.data as { reason?: string }).reason)).toEqual(['shallow']);
    const [first, second] = listReviews(lab.db, lab.runId, { includeInvalidated: true });
    expect(first!.invalidatedAt).not.toBeNull();
    expect(second!.invalidatedAt).toBeNull();
  });

  it('blocks when the fresh review inspects nothing either, and a resume would only block again', async () => {
    const { reviewer } = await setup({ onReviewerStart: transcripts(answerOnly) });
    await settle();
    expect(state()).toBe('BLOCKED');
    expect(reviewer.specs).toHaveLength(2);
    const run = getRun(lab.db, lab.runId);
    expect(run.outcomeReason).toMatch(/inspected nothing/);
    expect(newRunNeeded(lab.db, run)).toMatch(/one fresh review/);
  });

  it('is unaffected when the review depth is not known', async () => {
    const { reviewer } = await setup();
    await settle();
    expect(state()).toBe('DELIVERING');
    expect(reviewer.specs).toHaveLength(1);
    expect(decisions('review.fresh')).toEqual([]);
  });

  /** A recorded review depth, as a review session's transcript would have given it. */
  const depth = (reviewId: string, toolCalls: number) =>
    recordDecision(lab.db, lab.base, { id: `dec-${lab.runId}-review-depth-${reviewId}`, runId: lab.runId, kind: 'review.depth', summary: 'depth', data: { review_id: reviewId, worker_id: 'w', provider: 'codex', model: null, tool_calls: toolCalls, reasoning_tokens: 10 } }, lab.clock);

  // Review of the first version: with two reviews of one tree, a fresh review that inspected nothing and asked for repair
  // only through a note let the other approval clear the tree.
  it('blocks when the fresh review inspected nothing, whatever its verdict, though another approval stands', async () => {
    const note = { externalId: 'NOTE-1', severity: 'medium' as const, category: 'evidence-classification', location: 'apps/calc.mjs:2', path: 'apps/calc.mjs', line: 2, claim: 'the fail-before evidence is only a load failure', evidence: 'probe log', suggestedValidation: null };
    const { cand } = await setup({
      onReviewerStart: transcripts(answerOnly),
      reviewer: ({ spec }) => okResult({ verdict: 'REPAIR_REQUIRED', candidate_revision: spec.prompt.match(/candidate revision ([0-9a-f]{40})/)?.[1], findings: [{ id: 'NOTE-1', severity: 'medium', category: 'evidence-classification', location: 'apps/calc.mjs:2', claim: note.claim, evidence: note.evidence, suggested_validation: null }] }),
    });
    record(cand, 'APPROVE');
    depth('rev-1', 0);
    record(cand, 'APPROVE');
    depth('rev-2', 3);
    await settle();
    expect(state()).toBe('BLOCKED');
    expect(getRun(lab.db, lab.runId).outcomeReason).toMatch(/inspected nothing/);
  });

  it('leaves a tree that changes nothing to the approval as before', async () => {
    const { cand, reviewer } = await setup({ onReviewerStart: transcripts(answerOnly), tweak: (c) => void (c.scheduler.hard_limits.review_rounds = 1) });
    lab.db.run('UPDATE runs SET base_tree = ? WHERE id = ?', cand.treeHash, lab.runId);
    await settle();
    expect(reviewer.specs).toHaveLength(1);
    expect(decisions('review.fresh')).toEqual([]);
    expect(state()).not.toBe('BLOCKED');
  });

  it('blocks rather than start the fresh review when review_rounds is spent', async () => {
    const { reviewer } = await setup({ onReviewerStart: transcripts(answerOnly), tweak: (c) => void (c.scheduler.hard_limits.review_rounds = 1) });
    await settle();
    expect(state()).toBe('BLOCKED');
    expect(reviewer.specs).toHaveLength(1);
    expect(getRun(lab.db, lab.runId).outcomeReason).toMatch(/inspected nothing[\s\S]*review_rounds hard cap reached/);
  });
});

describe('parallel review units', () => {
  const uiLab = (extra?: (c: import('../../../src/policy/types.ts').OrbitConfig) => void) =>
    setup({
      tweak: (c) => {
        c.ui = { ...defaultUi(), journey_check_ids: [] } as never;
        extra?.(c);
      },
    });

  it('a security-sensitive change that touches the UI is reviewed as a security unit and a UI unit at once, and resolved when both are in', async () => {
    const { cand, reviewer } = await uiLab();
    lab.db.run('UPDATE runs SET difficulty_json = ? WHERE id = ?', JSON.stringify({ factors: [{ factor: 'security_impact', value: true }] }), lab.runId);
    lab.db.run('UPDATE candidates SET diff_stat_json = ? WHERE id = ?', JSON.stringify({ files: 1, insertions: 1, deletions: 0, binaryFiles: 0, paths: ['src/App.tsx'], truncated: false }), cand.id);
    expect(reviewFocuses(lab.ctx(), lab.ctx().candidate!)).toEqual(['security', 'ui']);
    const out = await settle();
    expect(out).toEqual({ progressed: true });
    expect(state()).toBe('DELIVERING');
    expect(reviewer.specs.map((s) => /Focus: (\w+)/.exec(s.prompt)?.[1]).sort()).toEqual(['security', 'the']);
    expect(listReviews(lab.db, lab.runId)).toHaveLength(2);
    expect(lab.ctx().ledger!.state('review_rounds').used).toBe(2);
  });

  it('one general review otherwise, and none of the focus when the UI is untouched or the change is not security-sensitive', async () => {
    const { cand } = await uiLab();
    expect(reviewFocuses(lab.ctx(), lab.ctx().candidate!)).toEqual(['general']);
    lab.db.run('UPDATE runs SET difficulty_json = ? WHERE id = ?', JSON.stringify({ factors: [{ factor: 'security_impact', value: true }] }), lab.runId);
    expect(reviewFocuses(lab.ctx(), lab.ctx().candidate!)).toEqual(['general']);
    lab.db.run('UPDATE runs SET difficulty_json = ? WHERE id = ?', '{bad', lab.runId);
    expect(reviewFocuses(lab.ctx(), lab.ctx().candidate!)).toEqual(['general']);
    lab.db.run('UPDATE runs SET difficulty_json = NULL WHERE id = ?', lab.runId);
  });

  it('waits while one unit still runs, and a unit that cannot be funded ends the run EXHAUSTED', async () => {
    const { cand } = await uiLab();
    lab.db.run('UPDATE runs SET difficulty_json = ? WHERE id = ?', JSON.stringify({ factors: [{ factor: 'security_impact', value: true }] }), lab.runId);
    lab.db.run('UPDATE candidates SET diff_stat_json = ? WHERE id = ?', JSON.stringify({ files: 1, insertions: 1, deletions: 0, binaryFiles: 0, paths: ['src/App.tsx'], truncated: false }), cand.id);
    const first = await run();
    expect(first.progressed).toBe(false);
    expect(first.waiting).toMatch(/running/);
    cleanLab();
    const t = await uiLab();
    lab.db.run('UPDATE runs SET difficulty_json = ? WHERE id = ?', JSON.stringify({ factors: [{ factor: 'security_impact', value: true }] }), lab.runId);
    lab.db.run('UPDATE candidates SET diff_stat_json = ? WHERE id = ?', JSON.stringify({ files: 1, insertions: 1, deletions: 0, binaryFiles: 0, paths: ['src/App.tsx'], truncated: false }), t.cand.id);
    const reserve = lab.ctx().ledger!.reserve().cost_usd;
    lab.db.run("UPDATE budget_counters SET used = hard_cap - ? WHERE counter = 'cost_usd'", reserve * 0.5);
    const out = await run();
    expect(out.progressed === false || out.done === true).toBe(true);
  });
});

describe('stopping reviews of an older revision, and preparing one', () => {
  it('cancels read-only work bound to another tree and leaves work on the current one', async () => {
    const { cand } = await setup();
    const other = { tree: 'o'.repeat(40), commit: 'e'.repeat(40) };
    const { addCandidate } = await import('./coverage-helpers.ts');
    const old = addCandidate(lab, other);
    const mk = (id: string, candidateId: string) => {
      const w = planWorker(lab.db, { id, runId: lab.runId, role: 'reviewer', provider: 'codex', workerDir: join(lab.base, id), cwd: lab.repo, candidateId }, lab.clock, OWNER);
      markWorkerRunning(lab.db, w.id, { pid: 2_000_000_000, pgid: 2_000_000_000, procStart: 'x' }, lab.clock, OWNER);
      return w;
    };
    const stale = mk('wrk-old', old.id);
    const live = mk('wrk-live', cand.id);
    const stopped = await cancelObsoleteWork(lab.ctx(), cand.treeHash);
    expect(stopped).toEqual([stale.id]);
    expect(getWorker(lab.db, stale.id).state).toBe('CANCELLED');
    expect(getWorker(lab.db, live.id).state).toBe('RUNNING');
    expect(lab.db.all("SELECT 1 FROM events WHERE run_id = ? AND type = 'workers.obsolete-cancelled'", lab.runId)).toHaveLength(1);
    expect(await cancelObsoleteWork(lab.ctx(), cand.treeHash)).toEqual([]);
  });

  it('builds the packet and the checkout once and reuses both', async () => {
    const { cand } = await setup();
    const a = await prepareReview(lab.ctx(), cand, 'codex');
    expect(existsSync(join(a.reviewDir, 'packet.md'))).toBe(true);
    expect(existsSync(join(a.reviewDir, 'packet.json'))).toBe(true);
    const sha = JSON.parse(readFileSync(join(a.reviewDir, 'packet.json'), 'utf8')).sha256;
    const b = await prepareReview(lab.ctx(), cand, 'codex');
    expect(b).toEqual(a);
    expect(JSON.parse(readFileSync(join(a.reviewDir, 'packet.json'), 'utf8')).sha256).toBe(sha);
    expect(existsSync(join(a.checkout, 'apps', 'calc.mjs'))).toBe(true);
  });

  it('refuses to send a packet to a provider the policy does not allow it for', async () => {
    const { cand } = await setup({ tweak: (c) => void (c.providers.codex = { ...c.providers.codex!, data_policy_eligible: false }) });
    await expect(prepareReview(lab.ctx(), cand, 'codex')).rejects.toMatchObject({ code: expect.stringMatching(/POLICY_DENIED|CONFIG_INVALID/) });
  });

  it('implementerProvider is the provider of the newest implementer, else claude', async () => {
    await setup();
    expect(implementerProvider(lab.ctx())).toBe('claude');
    planWorker(lab.db, { id: 'wrk-impl', runId: lab.runId, role: 'implementer', provider: 'codex', workerDir: join(lab.base, 'wi'), cwd: lab.repo }, lab.clock, OWNER);
    expect(implementerProvider(lab.ctx())).toBe('codex');
    expect(listWorkers(lab.db, { runId: lab.runId, role: 'implementer' })).toHaveLength(1);
  });
});

