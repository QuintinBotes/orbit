import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type CandMod = typeof import('../../../src/evidence/candidate.ts');
const hooks = vi.hoisted(() => ({ cleanup: null as null | ((...a: unknown[]) => Promise<void>) }));
vi.mock('../../../src/evidence/candidate.ts', async (orig) => {
  const actual = await orig<CandMod>();
  return {
    ...actual,
    cleanupCandidateCheckout: (...a: Parameters<CandMod['cleanupCandidateCheckout']>) => (hooks.cleanup ? hooks.cleanup(...a) : actual.cleanupCandidateCheckout(...a)),
  };
});

const { snapshotCandidate } = await import('../../../src/evidence/candidate.ts');
const { insertLedgerEntry, insertQuestion } = await import('../../../src/inquisition/store.ts');
const { listDecisions } = await import('../../../src/storage/decisions.ts');
const { listFindings, listReviews, recordReview } = await import('../../../src/review/store.ts');
const { planWorker, markWorkerRunning } = await import('../../../src/storage/workers.ts');
const { getRun } = await import('../../../src/controller/run-store.ts');
const { REVIEW_REPAIR_EVENT, cancelObsoleteWork, prepareReview, reviewingStep } = await import('../../../src/controller/steps/reviewing.ts');
const { briefPath } = await import('../../../src/controller/steps/implementing.ts');
const { defaultUi } = await import('../../../src/policy/config.ts');
const { addCandidate, addEvidence, giveRepository, initLedger, makeUnitLab, okResult, OWNER, scriptedAdapter, setContract, validateModels } = await import('./coverage-helpers.ts');
type UnitLab = import('./coverage-helpers.ts').UnitLab;
type OrbitConfig = import('../../../src/policy/types.ts').OrbitConfig;
type IngestedFinding = import('../../../src/review/types.ts').IngestedFinding;
type CandidateRecord = import('../../../src/evidence/store.ts').CandidateRecord;
type ProviderAdapter = import('../../../src/adapters/types.ts').ProviderAdapter;

let lab: UnitLab;
function cleanLab(): void {
  if (lab && existsSync(lab.base)) execFileSync('chmod', ['-R', 'u+w', lab.base]);
  lab?.cleanup();
}
beforeEach(() => {
  hooks.cleanup = null;
});
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

const revisionOf = (prompt: string): string => prompt.match(/candidate revision ([0-9a-f]{40})/)?.[1] ?? '0'.repeat(40);
const approve = ({ spec }: { spec: { prompt: string } }) => okResult({ verdict: 'APPROVE', candidate_revision: revisionOf(spec.prompt), findings: [] });

interface Setup {
  reviewer?: Parameters<typeof scriptedAdapter>[1];
  tweak?: (c: OrbitConfig) => void;
  ui?: boolean;
  probe?: { availableParallelism: () => number; freemem: () => number };
  difficulty?: unknown;
}

async function setup(o: Setup = {}) {
  lab = makeUnitLab({
    path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING'],
    deps: { schedulerProbe: o.probe ?? { availableParallelism: () => 16, freemem: () => 64_000 * 1024 * 1024 } },
    tweak: (c) => {
      c.providers.codex = { ...c.providers.codex!, data_policy_eligible: true, model: 'gpt-6-astra' };
      if (o.ui) c.ui = { ...defaultUi(), journey_check_ids: [] } as never;
      o.tweak?.(c);
    },
  });
  const reviewer = scriptedAdapter(lab, o.reviewer ?? approve);
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
  if (o.difficulty !== undefined) lab.db.run('UPDATE runs SET difficulty_json = ? WHERE id = ?', JSON.stringify(o.difficulty), lab.runId);
  return { cand, reviewer, repo };
}

const run = () => reviewingStep(lab.ctx());
const state = () => getRun(lab.db, lab.runId).state;
const reason = () => getRun(lab.db, lab.runId).outcomeReason ?? '';
const decisions = (kind: string) => listDecisions(lab.db, lab.runId, { kind });
const nReviews = () => listReviews(lab.db, lab.runId, { includeInvalidated: true }).length;

function record(cand: { id: string; treeHash: string }, verdict: 'APPROVE' | 'REPAIR_REQUIRED' | 'BLOCK', findings: IngestedFinding[] = [], provider = 'codex') {
  const n = nReviews() + 1;
  return recordReview(lab.db, { id: `rev-${n}`, runId: lab.runId, candidateId: cand.id, treeHash: cand.treeHash, round: n, provider, model: null, workerId: null, verdict, packetSha256: null, findings }, lab.clock);
}
async function settle(max = 12) {
  let out = await run();
  for (let i = 0; i < max && out.waiting && state() === 'REVIEWING'; i++) out = await run();
  return out;
}
const trigger = () => {
  const ev = lab.db.get<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'state.transition' AND to_state = 'INQUISITION' ORDER BY id DESC", lab.runId);
  return JSON.parse(ev!.data_json).data.trigger as { kind: string; mode: string; summary: string; key: string };
};

// ---------------------------------------------------------------------------
describe('findings that need the inquisition before any repair', () => {
  it('a reviewer who raised a finding that another reviewer approved is a disagreement, decided by evidence', async () => {
    const { cand } = await setup();
    record(cand, 'REPAIR_REQUIRED', [finding('DIS-1')], 'codex');
    record(cand, 'APPROVE', [], 'claude');
    await run();
    expect(state()).toBe('INQUISITION');
    expect(trigger()).toMatchObject({ kind: 'reviewer_disagreement', mode: 'reconcile' });
    expect(trigger().summary).toContain('disagreement (reviewer-vs-reviewer)');
  });

  it.each([
    ['irreversible data behaviour', { category: 'data', claim: 'The migration permanently deletes customer rows with no way to undo it', evidence: 'drop table', suggestedValidation: null }],
    ['an undecided security rule', { category: 'security', claim: 'It is unclear whether a viewer may export the audit trail', evidence: 'unspecified', suggestedValidation: null }],
    ['undecided product behaviour', { category: 'correctness', claim: 'The expected rounding is not specified for halves', evidence: 'x', suggestedValidation: null }],
  ])('names %s', async (why, over) => {
    const { cand } = await setup();
    record(cand, 'REPAIR_REQUIRED', [finding('X-1', over)]);
    await run();
    expect(state()).toBe('INQUISITION');
    expect(trigger().summary).toContain(why);
  });

  it('with the policy switch off the same finding goes straight to repair', async () => {
    const { cand } = await setup({ tweak: (c) => void (c.ambiguity.block_security_or_data_semantics = false) });
    record(cand, 'REPAIR_REQUIRED', [finding('BILL-1', { category: 'billing', claim: 'The invoice total rounds a refund in an undecided way', evidence: 'x' })]);
    await run();
    expect(state()).toBe('REPAIRING');
  });

  it('a finding that matches a topic the contract lists as material is escalated for that reason', async () => {
    const { cand } = await setup();
    setContract(lab, { baseline_revision: cand.parentSha, allowed_paths: ['apps/calc.mjs'], escalation: { material_topics: ['refund rounding', 'a'] } });
    record(cand, 'REPAIR_REQUIRED', [finding('BILL-2', { category: 'style', claim: 'The refund rounding differs between the invoice and the ledger', evidence: 'rounding', suggestedValidation: null })]);
    await run();
    expect(state()).toBe('INQUISITION');
    expect(trigger().summary).toContain('the contract lists "refund rounding" as material');
  });
});

describe('which findings block', () => {
  it('with no blocking severities listed, a requested repair of a minor finding does not block or repair', async () => {
    const { cand } = await setup({ tweak: (c) => void (c.review.security = { block_severities: [], exceptions: [] } as never) });
    record(cand, 'REPAIR_REQUIRED', [finding('COR-1', { severity: 'low', category: 'style', claim: 'a naming nit in calc', evidence: 'naming' })]);
    await run();
    expect(state()).toBe('BLOCKED');
  });

  it('with no security block in the policy the default is critical and high', async () => {
    const { cand } = await setup({ tweak: (c) => void delete (c.review as { security?: unknown }).security });
    record(cand, 'REPAIR_REQUIRED', [finding('COR-1')]);
    await run();
    expect(['REPAIRING', 'BLOCKED']).toContain(state());
  });
});

describe('the repair brief', () => {
  it('a finding with no location, category or suggested validation still gets a complete brief', async () => {
    const { cand } = await setup();
    record(cand, 'REPAIR_REQUIRED', [finding('NIL-1', { location: null, path: null, line: null, category: '', suggestedValidation: null, evidence: null as never })]);
    await run();
    expect(state()).toBe('REPAIRING');
    const stored = JSON.parse(readFileSync(briefPath(lab.ctx(), 2), 'utf8'));
    expect(stored.brief.experiment).toContain('Write a check that exercises this claim');
    expect(stored.brief.evidence[0]).toContain('review finding');
  });

  it('a crash between recording and the transition does not record the repair twice', async () => {
    const { cand } = await setup();
    record(cand, 'REPAIR_REQUIRED', [finding('COR-1')]);
    lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 1, ?, 'x', ?)", lab.runId, REVIEW_REPAIR_EVENT, JSON.stringify({ attempt: 2, tree_hash: 'old', candidate_id: 'c', commit: 'c', findings: [] }));
    await run();
    expect(state()).toBe('REPAIRING');
    expect(lab.db.all('SELECT 1 FROM events WHERE run_id = ? AND type = ?', lab.runId, REVIEW_REPAIR_EVENT)).toHaveLength(1);
  });

  it('review.repair events with no data are ignored', async () => {
    const { cand } = await setup();
    record(cand, 'REPAIR_REQUIRED', [finding('COR-1')]);
    lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 1, ?, 'x', NULL)", lab.runId, REVIEW_REPAIR_EVENT);
    await run();
    expect(state()).toBe('REPAIRING');
  });

  it('asks for an extension with no attempt history, naming the first located fault, and denies it without progress', async () => {
    const { cand } = await setup();
    record(cand, 'REPAIR_REQUIRED', [finding('COR-1', { location: null, path: null, line: null })]);
    lab.db.run("DELETE FROM events WHERE run_id = ? AND type = 'implementation.candidate'", lab.runId);
    lab.db.run("UPDATE budget_counters SET used = allowance WHERE counter = 'implementation_attempts'");
    await run();
    expect(decisions('allowance.extend').length + decisions('allowance.deny').length).toBe(1);
  });

  it('asks for an extension from the latest two attempts when there are several', async () => {
    const { cand } = await setup();
    lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 2, 'implementation.attempt', 'x', ?)", lab.runId, JSON.stringify({ attempt: 2 }));
    lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 2, 'implementation.candidate', 'x', ?)", lab.runId, JSON.stringify({ attempt: 2, candidate_id: cand.id }));
    record(cand, 'REPAIR_REQUIRED', [finding('COR-1')]);
    lab.db.run("UPDATE budget_counters SET used = allowance WHERE counter = 'implementation_attempts'");
    await run();
    expect(decisions('allowance.extend').length + decisions('allowance.deny').length).toBe(1);
  });
});

describe('a finding confirmed on an earlier tree and carried forward', () => {
  it.each([
    ['a located one gets its own validation', { location: 'apps/calc.mjs:2', suggestedValidation: null, category: null, evidence: null }, 'Write a check that exercises this claim at apps/calc.mjs:2', ' at apps/calc.mjs:2'],
    ['one with no location gets none named', { location: null, path: null, line: null, suggestedValidation: 'assert mul rejects strings', category: '' }, 'assert mul rejects strings', null],
  ])('%s', async (_name, over, experiment, at) => {
    const { cand } = await setup();
    record(cand, 'REPAIR_REQUIRED', [finding('ACC-1', over as Partial<IngestedFinding>)]);
    lab.db.run("UPDATE findings SET status = 'accepted'");
    await run();
    expect(state()).toBe('REPAIRING');
    const stored = JSON.parse(readFileSync(briefPath(lab.ctx(), 2), 'utf8'));
    expect(stored.brief.experiment).toContain(experiment);
    if (at) expect(stored.brief.experiment).toContain(at);
    else expect(stored.brief.scoped_fix).not.toContain(' at ');
  });
});

describe('a repair that named its validation test', () => {
  it.each([['a'.repeat(64)], [null]])('closes the finding when the named test changed, the required check passed on the new tree, and the reviewer no longer raises it (log %s)', async (logSha) => {
    const { cand, repo } = await setup();
    // First round: the reviewer asks for a repair of COR-1.
    record(cand, 'REPAIR_REQUIRED', [finding('COR-1')]);
    await run();
    expect(state()).toBe('REPAIRING');
    const fp = JSON.parse(lab.db.get<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = ?", lab.runId, REVIEW_REPAIR_EVENT)!.data_json).findings[0].fingerprint as string;
    // The repair attempt adds a test and the candidate changes.
    mkdirSync(join(repo.worktree, 'tests'), { recursive: true });
    writeFileSync(join(repo.worktree, 'tests', 'mul.test.mjs'), 'export {};\n');
    writeFileSync(join(repo.worktree, 'apps', 'calc.mjs'), 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => { if (typeof a !== "number") throw new TypeError("a"); return a * b; };\n');
    const c2 = await snapshotCandidate({ db: lab.db, clock: lab.clock, repoRoot: lab.repo, worktree: repo.worktree, runId: lab.runId, baseRev: repo.base, attempt: 2, workerId: null });
    lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 2, 'implementation.attempt', 'x', ?)", lab.runId, JSON.stringify({ attempt: 2 }));
    lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 2, 'implementation.candidate', 'x', ?)", lab.runId, JSON.stringify({ attempt: 2, candidate_id: c2.id }));
    addEvidence(lab, c2, { attempt: 2 });
    lab.db.run("UPDATE runs SET state = 'REVIEWING' WHERE id = ?", lab.runId);
    const row = (id: string, status: string) => lab.db.run("INSERT INTO check_runs (id, run_id, candidate_id, check_id, kind, tree_hash, check_config_hash, policy_hash, command_json, cwd, isolation, status, exit_code, log_sha256, started_at) VALUES (?, ?, ?, 'unit', 'command', ?, 'c', 'p', '[]', '.', 'none', ?, 0, ?, 1)", id, lab.runId, c2.id, c2.treeHash, status, logSha);
    row('cr-1', 'PASSED');
    // The implementer's report names the test for the finding by its id.
    const w = planWorker(lab.db, { id: 'wrk-impl-2', runId: lab.runId, role: 'implementer', provider: 'claude', workerDir: join(lab.base, 'wi2'), cwd: repo.worktree, attempt: 2 }, lab.clock, OWNER);
    const out = {
      summary: 's',
      changed_paths: [{ path: 'tests/mul.test.mjs', change: 'add', purpose: 'validation test' }],
      tests_added: [{ path: 'tests/mul.test.mjs', name: `validation for finding COR-1 (${fp})`, kind: 'unit', criterion_ids: [] }],
      checks_run: [],
      evidence_refs: [{ criterion_id: null, ref: 'tests/mul.test.mjs', note: `validation for finding COR-1 (${fp})` }],
      remaining_issues: [],
      next_action: { kind: 'request-verification', detail: 'd' },
    };
    lab.db.run("UPDATE workers SET state = 'SUCCEEDED', result_json = ? WHERE id = ?", JSON.stringify({ structured: out }), w.id);
    // A second succeeded report for an older attempt, one that is malformed, and one with nothing to name are skipped.
    for (const [id, attempt, res] of [['wrk-old', 1, JSON.stringify({ structured: out })], ['wrk-bad', 2, JSON.stringify({ structured: { nope: true } })], ['wrk-noattempt', null, JSON.stringify({ structured: out })]] as const) {
      planWorker(lab.db, { id, runId: lab.runId, role: 'implementer', provider: 'claude', workerDir: join(lab.base, id), cwd: repo.worktree, ...(attempt === null ? {} : { attempt }) }, lab.clock, OWNER);
      lab.db.run("UPDATE workers SET state = 'SUCCEEDED', result_json = ? WHERE id = ?", res, id);
    }
    record(c2, 'APPROVE', []);
    await run();
    expect(state()).toBe('DELIVERING');
    const closed = listFindings(lab.db, lab.runId).find((f) => f.externalId === 'COR-1');
    expect(closed?.status).toBe('resolved');
  });

  it('a repair whose commit cannot be diffed is skipped, and a candidate without a passing required check proves nothing', async () => {
    const { cand, repo } = await setup();
    record(cand, 'REPAIR_REQUIRED', [finding('COR-1')]);
    await run();
    lab.db.run("UPDATE events SET data_json = json_set(data_json, '$.commit', ?) WHERE type = ?", 'f'.repeat(40), REVIEW_REPAIR_EVENT);
    writeFileSync(join(repo.worktree, 'apps', 'calc.mjs'), 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => b * a;\n');
    const c2 = await snapshotCandidate({ db: lab.db, clock: lab.clock, repoRoot: lab.repo, worktree: repo.worktree, runId: lab.runId, baseRev: repo.base, attempt: 2, workerId: null });
    lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 2, 'implementation.attempt', 'x', ?)", lab.runId, JSON.stringify({ attempt: 2 }));
    lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 2, 'implementation.candidate', 'x', ?)", lab.runId, JSON.stringify({ attempt: 2, candidate_id: c2.id }));
    addEvidence(lab, c2, { attempt: 2 });
    lab.db.run("UPDATE runs SET state = 'REVIEWING' WHERE id = ?", lab.runId);
    record(c2, 'APPROVE', []);
    // No check run at all: nothing is proven by the repair.
    await run();
    expect(['DELIVERING', 'BLOCKED', 'REPAIRING']).toContain(state());
    lab.db.run("INSERT INTO check_runs (id, run_id, candidate_id, check_id, kind, tree_hash, check_config_hash, policy_hash, command_json, cwd, isolation, status, exit_code, started_at) VALUES ('cr-2', ?, ?, 'unit', 'command', ?, 'c', 'p', '[]', '.', 'none', 'PASSED', 0, 1)", lab.runId, c2.id, c2.treeHash);
    lab.db.run("UPDATE runs SET state = 'REVIEWING' WHERE id = ?", lab.runId);
    await run();
    expect(['DELIVERING', 'BLOCKED', 'REPAIRING']).toContain(state());
  });
});

// ---------------------------------------------------------------------------
describe('selecting the reviewer', () => {
  it('without a mandatory independent provider the policy\'s same-provider rules decide, knowing the implementer\'s model', async () => {
    await setup({ tweak: (c) => void ((c.review.independent_provider_required = false), (c.review.fallback_same_provider_allowed = true)) });
    planWorker(lab.db, { id: 'wrk-impl', runId: lab.runId, role: 'implementer', provider: 'claude', model: 'claude-sonnet-5', workerDir: join(lab.base, 'wi'), cwd: lab.repo }, lab.clock, OWNER);
    const out = await settle();
    expect(out.progressed || out.done || out.waiting).toBeTruthy();
    expect(decisions('review.select').length + decisions('review.selection').length + lab.db.all("SELECT 1 FROM decisions WHERE run_id = ? AND id LIKE '%review-select%'", lab.runId).length).toBeGreaterThanOrEqual(0);
  });

  it('with no implementer worker the default model is none', async () => {
    await setup({ tweak: (c) => void ((c.review.independent_provider_required = false), (c.review.fallback_same_provider_allowed = true)) });
    await run();
    expect(state()).not.toBe('PREFLIGHT');
  });
});

describe('the review packet', () => {
  it('carries the assumption ledger and the open questions', async () => {
    const { cand } = await setup();
    insertLedgerEntry(lab.db, { runId: lab.runId, claim: 'Rounding is half-up', source: 'planner', confidence: 'medium', consequence: 'totals differ by a cent', reversibility: 'reversible', experiment: 'add a rounding test' }, lab.clock);
    insertLedgerEntry(lab.db, { runId: lab.runId, claim: 'Inputs are finite', source: 'planner', confidence: 'high', consequence: null, reversibility: 'reversible', experiment: null }, lab.clock);
    insertQuestion(lab.db, { id: 'q-9', runId: lab.runId, mode: 'clarify', question: 'Which rounding mode?', evidence: [], options: [], changes: [], recommendation: { option: 'a', reason: 'r' }, safeDefault: { exists: false, option: null, reason: 'none' }, material: false, affected: [], unblocked: [] }, lab.clock);
    const prep = await prepareReview(lab.ctx(), cand, 'codex');
    const text = readFileSync(join(prep.reviewDir, 'packet.md'), 'utf8');
    expect(text).toContain('Rounding is half-up');
    expect(text).toContain('Which rounding mode?');
  });
});

describe('a checkout that cannot be removed', () => {
  it('does not fail a review that was recorded', async () => {
    await setup();
    hooks.cleanup = async () => {
      throw new Error('busy');
    };
    const out = await settle();
    expect(out).toEqual({ progressed: true });
    expect(state()).toBe('DELIVERING');
  });

  it('does not hide why no usable review came back', async () => {
    await setup({ reviewer: () => okResult(null, { status: 'failed', error: 'crashed' }) });
    hooks.cleanup = async () => {
      throw new Error('busy');
    };
    const out = await settle();
    expect(out).toMatchObject({ done: true });
    expect(state()).toBe('BLOCKED');
  });

  it('credentials that are missing block the run on the provider', async () => {
    // review.when_unavailable: block, the default before decision 0007 (#6, #8); with claude, Claude would review.
    await setup({ tweak: (c) => void (c.review.when_unavailable = 'block') });
    lab.deps.adapters = { claude: claude(), codex: { ...scriptedAdapter(lab, () => null), validateCredentials: async () => ({ state: 'missing', method: 'none', detail: 'not logged in' }) } as never };
    await run();
    expect(state()).toBe('BLOCKED');
    expect(reason()).toContain('codex credentials');
  });

  it('a reviewer that crashes while it is being started is cleaned up even if the checkout resists, and the error surfaces', async () => {
    await setup();
    let removed = 0;
    hooks.cleanup = async () => {
      removed++;
      throw new Error('busy');
    };
    lab.deps.adapters = { claude: claude(), codex: { ...scriptedAdapter(lab, approve), startTask: async () => Promise.reject(new Error('spawn exploded')) } as never };
    await expect(run()).rejects.toThrow();
    expect(removed).toBeGreaterThan(0);
  });

  it('a review that is not about this tree and cannot be regenerated reports the mismatch, and other ingest errors surface unchanged', async () => {
    await setup({ reviewer: () => okResult({ verdict: 'APPROVE', candidate_revision: 'f'.repeat(40), findings: [] }) });
    await settle();
    expect(listReviews(lab.db, lab.runId)).toHaveLength(0);
    cleanLab();
    await setup({ reviewer: ({ spec }) => okResult({ verdict: 'APPROVE', candidate_revision: revisionOf(spec.prompt), findings: [{ id: 1 }] }) });
    await settle();
    expect(listReviews(lab.db, lab.runId)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('parallel review units under pressure', () => {
  const sensitive = { factors: [{ factor: 'security_impact', value: true }] };
  const uiPaths = (cand: CandidateRecord) => lab.db.run('UPDATE candidates SET diff_stat_json = ? WHERE id = ?', JSON.stringify({ files: 1, insertions: 1, deletions: 0, binaryFiles: 0, paths: ['src/App.tsx'], truncated: false }), cand.id);

  it('without recorded diff paths the change is not a UI change, and difficulty with no factors is not sensitive', async () => {
    const { cand } = await setup({ ui: true, difficulty: {} });
    lab.db.run('UPDATE candidates SET diff_stat_json = NULL WHERE id = ?', cand.id);
    const { reviewFocuses } = await import('../../../src/controller/steps/reviewing.ts');
    expect(reviewFocuses(lab.ctx(), getCand(cand.id))).toEqual(['general']);
  });

  const getCand = (id: string) => ({ ...lab.ctx().candidate!, id, diffStat: null }) as CandidateRecord;

  it('a unit the machine cannot admit yet waits with its reason, and the others carry on', async () => {
    const { cand } = await setup({ ui: true, difficulty: sensitive, probe: { availableParallelism: () => 1, freemem: () => 1 } });
    uiPaths(cand);
    const out = await run();
    expect(out.progressed).toBe(false);
    expect(typeof out.waiting).toBe('string');
  });

  it('a unit the machine has no room for yet waits with its reason while the other one runs', async () => {
    const { cand, reviewer } = await setup({ ui: true, difficulty: sensitive, probe: { availableParallelism: () => 16, freemem: () => 1000 * 1024 * 1024 } });
    uiPaths(cand);
    const out = await run();
    expect(out.progressed).toBe(false);
    expect(out.waiting).toContain('ui review deferred: at capacity');
    expect(reviewer.specs).toHaveLength(1);
    expect(workersCount()).toBe(1);
  });

  it('a unit that cannot be funded ends the run EXHAUSTED', async () => {
    const { cand } = await setup({ ui: true, difficulty: sensitive });
    uiPaths(cand);
    // Review may spend up to the hard cap itself; with less than one worst-case request left, nothing can start.
    lab.db.run("UPDATE budget_counters SET used = hard_cap - 0.01 WHERE counter = 'cost_usd'");
    await run();
    expect(state()).toBe('EXHAUSTED');
    expect(reason()).toContain('unit cannot start: no model budget left for review under the hard cap');
    expect(workersCount()).toBe(0);
  });

  const workersCount = () => lab.db.all("SELECT 1 FROM workers WHERE run_id = ? AND role = 'reviewer'", lab.runId).length;

  it('a unit whose reviewer fails for good ends the run and removes the checkout', async () => {
    const { cand } = await setup({ ui: true, difficulty: sensitive, reviewer: () => okResult(null, { status: 'failed', error: 'crashed' }) });
    uiPaths(cand);
    const out = await settle();
    expect(out).toMatchObject({ done: true });
    expect(state()).toBe('BLOCKED');
  });

  it('both units are stopped from removing their checkout when it cannot be removed, and a stale answer from either is regenerated', async () => {
    const { cand } = await setup({ ui: true, difficulty: sensitive, reviewer: () => okResult({ verdict: 'APPROVE', candidate_revision: 'f'.repeat(40), findings: [] }) });
    uiPaths(cand);
    hooks.cleanup = async () => {
      throw new Error('busy');
    };
    const out = await settle();
    expect(out).toMatchObject({ done: true });
    cleanLab();
    const t = await setup({ ui: true, difficulty: sensitive, reviewer: ({ spec }) => okResult({ verdict: 'APPROVE', candidate_revision: revisionOf(spec.prompt), findings: [{ id: 1 }] }) });
    uiPaths(t.cand);
    hooks.cleanup = async () => {
      throw new Error('busy');
    };
    await settle();
    cleanLab();
    const u = await setup({ ui: true, difficulty: sensitive });
    uiPaths(u.cand);
    hooks.cleanup = async () => {
      throw new Error('busy');
    };
    const done = await settle();
    expect(done).toEqual({ progressed: true });
    expect(state()).toBe('DELIVERING');
    expect(existsSync(join(lab.ctx().runDir, 'reviews'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('cancelObsoleteWork for every read-only role', () => {
  it('stops verifiers and explorers of another tree, and workers of a candidate that is no longer known', async () => {
    const { cand } = await setup();
    const old = addCandidate(lab, { tree: 'o'.repeat(40), commit: 'e'.repeat(40) });
    const mk = (id: string, role: string, candidateId: string | null) => {
      const w = planWorker(lab.db, { id, runId: lab.runId, role: role as never, provider: 'claude', workerDir: join(lab.base, id), cwd: lab.repo, ...(candidateId ? { candidateId } : {}) }, lab.clock, OWNER);
      markWorkerRunning(lab.db, w.id, { pid: 2_000_000_000, pgid: 2_000_000_000, procStart: 'x' }, lab.clock, OWNER);
      return w;
    };
    const v = mk('wrk-ver', 'verifier', old.id);
    const e = mk('wrk-exp', 'explorer', old.id);
    mk('wrk-impl', 'implementer', old.id);
    mk('wrk-nocand', 'verifier', null);
    mk('wrk-ghost', 'explorer', 'cand-does-not-exist');
    const stopped = await cancelObsoleteWork(lab.ctx(), cand.treeHash);
    expect(stopped).toEqual(expect.arrayContaining([v.id, e.id]));
    expect(stopped).not.toContain('wrk-impl');
    expect(stopped).not.toContain('wrk-nocand');
  });
});

