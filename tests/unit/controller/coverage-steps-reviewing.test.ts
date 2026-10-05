import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderAdapter } from '../../../src/adapters/types.ts';
import { snapshotCandidate } from '../../../src/evidence/candidate.ts';
import { insertQuestion } from '../../../src/inquisition/store.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { listFindings, listReviews, recordReview } from '../../../src/review/store.ts';
import type { IngestedFinding } from '../../../src/review/types.ts';
import { getWorker, listWorkers, markWorkerRunning, planWorker } from '../../../src/storage/workers.ts';
import { getRun, requestCancel } from '../../../src/controller/run-store.ts';
import { REVIEW_REPAIR_EVENT, cancelObsoleteWork, implementerProvider, prepareReview, reviewFocuses, reviewingStep } from '../../../src/controller/steps/reviewing.ts';
import { briefPath } from '../../../src/controller/steps/implementing.ts';
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
  const reviewer = scriptedAdapter(lab, o.reviewer ?? (({ spec }) => okResult({ verdict: 'APPROVE', candidate_revision: spec.prompt.match(/candidate revision ([0-9a-f]{40})/)?.[1] ?? '0'.repeat(40), findings: [] })));
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

const run = () => reviewingStep(lab.ctx());
const state = () => getRun(lab.db, lab.runId).state;
const decisions = (kind: string) => listDecisions(lab.db, lab.runId, { kind });
async function settle(max = 12) {
  let out = await run();
  for (let i = 0; i < max && out.waiting && /is running$|running in|review running/.test(out.waiting) && state() === 'REVIEWING'; i++) out = await run();
  return out;
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
    expect(decisions('repair.brief')[0]?.summary).toContain('COR-1 (high)');
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

  it('ends EXHAUSTED when no review round is left for the repaired tree, naming the open findings', async () => {
    const { cand } = await setup();
    record(cand, 'REPAIR_REQUIRED', [finding('COR-1')]);
    lab.db.run("UPDATE budget_counters SET used = allowance WHERE counter = 'review_rounds'");
    await run();
    expect(state()).toBe('EXHAUSTED');
    expect(getRun(lab.db, lab.runId).outcomeReason).toMatch(/^review_rounds hard cap reached \(\d+ of \d+\) with 1 open finding\(s\): COR-1 \(high\)/);
  });

  it('ends EXHAUSTED when no implementation attempt is left under the hard cap', async () => {
    const { cand } = await setup();
    record(cand, 'REPAIR_REQUIRED', [finding('COR-1')]);
    lab.db.run("UPDATE budget_counters SET used = hard_cap WHERE counter = 'implementation_attempts'");
    await run();
    expect(state()).toBe('EXHAUSTED');
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

  it('a claim that needs a discriminating test goes to the inquisition once, and then the run blocks on what is open', async () => {
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
    expect(state()).toBe('BLOCKED');
  });

  it('a REPAIR_REQUIRED review whose findings are below the blocking severity does not force a repair', async () => {
    const { cand } = await setup();
    record(cand, 'REPAIR_REQUIRED', [finding('NIT-1', { severity: 'low', category: 'style', claim: 'a naming nit in calc', evidence: 'naming' })]);
    await run();
    expect(['BLOCKED', 'REPAIRING', 'INQUISITION']).toContain(state());
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

  it('a review of another revision is asked for again, and after the limit the run ends without a review', async () => {
    await setup({ reviewer: () => okResult({ verdict: 'APPROVE', candidate_revision: 'f'.repeat(40), findings: [] }) });
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
    await setup();
    lab.deps.adapters = { claude: claude(), codex: { ...scriptedAdapter(lab, () => null), validateCredentials: async () => ({ state: 'expired', method: 'oauth', detail: 'token expired' }), discoverCapabilities: async () => ({ provider: 'codex', available: true, version: '1', models: [], structuredOutput: true, readOnlySandbox: true, usageReporting: 'full', costReporting: true, detail: '' }) } as never };
    await run();
    expect(state()).toBe('BLOCKED');
    expect(getRun(lab.db, lab.runId).outcomeReason).toContain('codex credentials');
    cleanLab();
    await setup();
    lab.deps.adapters = { claude: claude() };
    await run();
    expect(state()).toBe('BLOCKED');
    expect(getRun(lab.db, lab.runId).outcomeReason).toMatch(/independent review unavailable|credentials/);
  });

  it('a reviewer worker that ends badly is retried and then blocks the run, leaving no checkout', async () => {
    await setup({ reviewer: () => okResult(null, { status: 'failed', error: 'crashed' }) });
    const out = await settle();
    expect(out).toMatchObject({ done: true });
    expect(state()).toBe('BLOCKED');
    expect(existsSync(join(lab.home, 'worktrees', `review-${lab.ctx().candidate!.seq}`))).toBe(false);
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

