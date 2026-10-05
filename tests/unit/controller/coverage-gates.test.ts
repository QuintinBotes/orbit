import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultCheck, defaultConfig, defaultUi } from '../../../src/policy/config.ts';
import { snapshotHash } from '../../../src/policy/snapshot.ts';
import type { OrbitConfig, PolicySnapshot } from '../../../src/policy/types.ts';
import type { GoalContract } from '../../../src/contract/types.ts';
import type { CredentialCheck } from '../../../src/recovery/credentials.ts';
import type { BaselineReport } from '../../../src/evidence/baseline.ts';
import type { Evaluation } from '../../../src/evidence/report.ts';
import type { EvidenceReport } from '../../../src/evidence/types.ts';
import { insertQuestion } from '../../../src/inquisition/store.ts';
import {
  baselineGate,
  behaviourGate,
  blockingQuestions,
  completionGate,
  deliveryGate,
  environmentGate,
  implementationScopeGate,
  independentReviewGate,
  intakeGate,
  staticSecurityGate,
  uiGate,
} from '../../../src/controller/gates.ts';
import type { SecretScanResult } from '../../../src/controller/security.ts';
import { addCandidate, addEvidence, addReview, cleanScope, makeUnitLab, type UnitLab } from './coverage-helpers.ts';

const roots: string[] = [];
let lab: UnitLab | undefined;
afterEach(() => {
  lab?.cleanup();
  lab = undefined;
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

function snap(tweak?: (c: OrbitConfig) => void): PolicySnapshot {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-gates2-')));
  roots.push(repo);
  const c = defaultConfig('autonomous');
  c.checks = { unit: { ...defaultCheck('unit'), command: ['node', 't.mjs'] } };
  tweak?.(c);
  return { schema: 'orbit.policy/1', run_id: 'orb-1', created_at: '2026-10-05T00:00:00.000Z', repo_root: repo, config: c, effective_protected_paths: ['.github/**'], check_config_hashes: {} };
}
const runOf = (s: PolicySnapshot) => ({ id: 'orb-1', repoRoot: s.repo_root, mode: s.config.mode, policyHash: snapshotHash(s) });
function contractOf(s: PolicySnapshot, over: Partial<GoalContract> = {}): GoalContract {
  return {
    version: '1.0',
    task_id: 'orb-1',
    original_goal: 'Add mul.',
    objective: 'Add mul.',
    acceptance_criteria: [{ id: 'AC-1', statement: 'mul multiplies', proof: ['a test'], mandatory: true, check_ids: ['unit'] }],
    non_goals: [],
    allowed_paths: ['apps/**'],
    required_check_ids: ['unit'],
    assumptions: [],
    delivery: { draft_pr: false, merge: false },
    policy_hash: snapshotHash(s),
    baseline_revision: 'a'.repeat(40),
    escalation: { material_topics: [] },
    ...over,
  };
}

describe('intakeGate: every way to be refused', () => {
  it('names a repository that does not exist', () => {
    const s = snap();
    const g = intakeGate({ run: { ...runOf(s), repoRoot: join(s.repo_root, 'missing') }, snapshot: s });
    expect(g.status).toBe('fail');
    expect(g.reasons[0]).toBe(`repository ${join(s.repo_root, 'missing')} does not exist`);
  });

  it('refuses a mode that differs from the frozen policy and a snapshot that no longer matches its hash', () => {
    const s = snap();
    const g = intakeGate({ run: { ...runOf(s), mode: 'supervised', policyHash: `sha256:${'0'.repeat(64)}` }, snapshot: s });
    expect(g.reasons).toEqual(expect.arrayContaining([`the run's mode supervised differs from the frozen policy mode autonomous`, 'the policy snapshot does not match the hash recorded for the run']));
  });

  it('refuses non-positive hard limits and a policy that allows no paths', () => {
    const s = snap((c) => {
      c.scheduler.hard_limits.recovery_attempts = 0;
      c.scope.allowed_paths = [];
    });
    const g = intakeGate({ run: runOf(s), snapshot: s });
    expect(g.reasons).toEqual(expect.arrayContaining(['hard limit recovery_attempts must be positive', 'the policy allows no paths, so no implementation is authorized']));
  });

  it('refuses a contract with no mandatory criterion or no proof through the contract validation, and one that cites no check as not measurable', () => {
    const s = snap();
    const optional = intakeGate({ run: runOf(s), snapshot: s, contract: contractOf(s, { acceptance_criteria: [{ id: 'AC-1', statement: 'nice to have', proof: ['a test'], mandatory: false, check_ids: ['unit'] }] }) });
    expect(optional.reasons).toEqual(['contract: at least one acceptance criterion must be mandatory']);
    const noProof = intakeGate({ run: runOf(s), snapshot: s, contract: contractOf(s, { acceptance_criteria: [{ id: 'AC-1', statement: 'x', proof: [], mandatory: true, check_ids: ['unit'] }] }) });
    expect(noProof.reasons).toEqual(['contract: schema: /acceptance_criteria/0/proof: must NOT have fewer than 1 items']);
    const unmeasured = intakeGate({ run: runOf(s), snapshot: s, contract: contractOf(s, { acceptance_criteria: [{ id: 'AC-1', statement: 'x', proof: ['p'], mandatory: true, check_ids: [] }] }) });
    expect(unmeasured.reasons).toEqual(['AC-1 is not measurable: it cites no trusted check']);
  });

  it('a UI criterion needs browser evidence the policy can produce: the contract check refuses it without ui configuration, and the gate when no journey is defined', () => {
    const ui = { id: 'AC-1', statement: 'renders', proof: ['a journey'], mandatory: true, check_ids: [], ui: true };
    const without = snap();
    const a = intakeGate({ run: runOf(without), snapshot: without, contract: contractOf(without, { acceptance_criteria: [ui] }) });
    expect(a.reasons).toEqual(['contract: mandatory criterion AC-1 needs browser evidence, but the policy has no ui configuration']);
    const empty = snap((c) => {
      c.ui = defaultUi();
    });
    const b = intakeGate({ run: runOf(empty), snapshot: empty, contract: contractOf(empty, { acceptance_criteria: [ui] }) });
    expect(b.reasons.some((r) => r.includes('AC-1'))).toBe(true);
  });
});

describe('environmentGate: remaining branches', () => {
  const ok = { kind: 'container' as const, available: true, detail: 'docker' };
  const cred = (provider: string, verdict: CredentialCheck['verdict'], over: Partial<CredentialCheck> = {}): CredentialCheck => ({ provider, verdict, status: { state: 'valid', method: 'api_key', detail: '' }, live: false, error: null, ...over });

  it('an isolation provider that could not even be constructed is unavailable', () => {
    const g = environmentGate({ snapshot: snap(), mode: 'autonomous', isolation: { error: 'srt is not installed' }, credentials: [], reviewer: null });
    expect(g.reasons).toEqual(['isolation is unavailable: srt is not installed']);
    expect(g.details.code).toBe('ISOLATION_UNAVAILABLE');
  });

  it('says what sandbox-runtime does not limit, when it is available', () => {
    const g = environmentGate({ snapshot: snap(), mode: 'autonomous', isolation: { kind: 'sandbox-runtime', available: true, detail: 'srt 1' }, credentials: [], reviewer: null });
    expect(g.passed).toBe(true);
    expect(g.notes.join(' ')).toContain('not CPU, memory or process count');
  });

  it('describes credentials with and without a status or detail, and the first blocker names the provider', () => {
    const g = environmentGate({
      snapshot: snap(),
      mode: 'autonomous',
      isolation: ok,
      credentials: [
        cred('a', 'blocked', { status: { state: 'missing', method: null as never, detail: 'no key' } }),
        cred('b', 'blocked', { status: null }),
        cred('c', 'error', { error: null }),
        cred('d', 'error', { error: 'cli timed out' }),
        cred('e', 'valid', { status: null }),
      ],
      reviewer: null,
    });
    expect(g.details).toEqual({ blockedProvider: 'a', code: 'AUTH_MISSING' });
    expect(g.reasons).toEqual(['a credentials are missing: no key', 'b credentials are not usable', 'c could not be checked: unknown error', 'd could not be checked: cli timed out']);
    expect(g.evidence).toContain('credentials e: valid');
    expect(g.evidence).toContain('credentials a: blocked (missing)');
  });

  it('an error alone is PROVIDER_UNAVAILABLE and a blocked later one does not replace an earlier code', () => {
    const g = environmentGate({ snapshot: snap(), mode: 'autonomous', isolation: ok, credentials: [cred('a', 'error', { error: 'x' }), cred('b', 'blocked', { status: { state: 'expired', method: 'oauth', detail: '' } })], reviewer: null });
    expect(g.details.code).toBe('PROVIDER_UNAVAILABLE');
    expect(g.details.blockedProvider).toBe('b');
    expect(g.evidence).toContain('credentials b: blocked (expired, oauth)');
  });

  it('records the selected reviewer, independent or not, with its model or the default', () => {
    const base = { snapshot: snap(), mode: 'autonomous' as const, isolation: ok, credentials: [] };
    const same = environmentGate({ ...base, reviewer: { decision: 'USE', provider: 'claude', model: null, independent: false } as never });
    expect(same.evidence).toContain('reviewer claude/default (same provider)');
    const other = environmentGate({ ...base, reviewer: { decision: 'USE', provider: 'codex', model: 'gpt-x', independent: true } as never });
    expect(other.evidence).toContain('reviewer codex/gpt-x (independent)');
    const blocked = environmentGate({ ...base, reviewer: { decision: 'BLOCK', code: 'PROVIDER_UNAVAILABLE', reason: 'none', alternatives: [] } as never, credentials: [cred('x', 'error', { error: 'e' })] });
    expect(blocked.details.code).toBe('PROVIDER_UNAVAILABLE');
  });
});

describe('baselineGate: remaining branches', () => {
  const report = (over: Partial<BaselineReport> = {}): BaselineReport => ({ schema: 'orbit.baseline/1', runId: 'orb-1', baseRevision: 'b', baseTree: 't', policyHash: 'h', checkIds: ['unit'], install: { skipped: true, reason: null, ok: false }, checks: [], failures: [], complete: true, recordedAt: 0, ...over });

  it('blocks on a failed locked install, with or without a reason', () => {
    const a = baselineGate(report({ install: { skipped: false, ok: false, reason: 'ENOTFOUND registry' } }));
    expect(a.reasons).toEqual(['the locked dependency install failed on the base revision: ENOTFOUND registry']);
    expect(baselineGate(report({ install: { skipped: false, ok: false, reason: null } })).reasons).toEqual(['the locked dependency install failed on the base revision']);
    expect(baselineGate(report({ install: { skipped: false, ok: true, reason: null } })).passed).toBe(true);
  });

  it('notes each pre-existing failure with or without a fingerprint, the audit notes, and an incomplete baseline as unverified', () => {
    const g = baselineGate(report({ failures: [{ checkId: 'unit', fingerprint: 'fp:1', excerpt: null }, { checkId: 'lint', fingerprint: null, excerpt: null }], auditNotes: ['pre-existing vulnerability: left-pad'], complete: false }));
    expect(g.status).toBe('unverified');
    expect(g.notes).toEqual(['pre-existing failure on the base revision: unit (fp:1)', 'pre-existing failure on the base revision: lint', 'pre-existing vulnerability: left-pad', 'the baseline is incomplete: some checks could not produce a decisive result on the base revision']);
  });

  it('an incomplete baseline whose install failed is a failure, not merely unverified', () => {
    expect(baselineGate(report({ install: { skipped: false, ok: false, reason: 'x' }, complete: false })).status).toBe('fail');
  });
});

describe('implementationScopeGate', () => {
  it('a protected path or escaping symlink is a policy violation and not repairable', () => {
    const s = snap();
    const g = implementationScopeGate(cleanScope({ forbidden_paths_changed: ['.github/ci.yml'], symlinks_escaping: ['link'] }), s);
    expect(g.details).toEqual({ policyViolation: true, repairable: [] });
    expect(g.reasons).toEqual(['protected paths changed: .github/ci.yml', 'symlinks escape the worktree: link']);
  });

  it('out-of-scope paths, size, lockfile and manifests are repairable, and weakening signals are only notes', () => {
    const s = snap();
    const g = implementationScopeGate(
      cleanScope({
        out_of_scope_paths_changed: ['docs/x.md'],
        within_size_limits: false,
        changed_files: 99,
        changed_lines: 9999,
        lockfile_changed: true,
        dependency_manifest_changed: ['package.json'],
        weakening_signals: [{ path: 'tests/a.test.ts', signal: 'skip', detail: 'it.skip added' }] as never,
      }),
      s,
    );
    expect(g.details.policyViolation).toBe(false);
    expect(g.details.repairable).toHaveLength(4);
    expect(g.reasons).toContain('the change is over the size limits (99 files, 9999 lines)');
    expect(g.reasons).toContain('a lockfile changed, which the policy does not allow');
    expect(g.notes).toEqual(['possible oracle weakening in tests/a.test.ts: skip (it.skip added)']);
  });

  it('lets a lockfile and manifest change through when the policy allows them', () => {
    const s = snap((c) => {
      c.dependencies.change_lockfile = true;
      c.dependencies.add_packages = true;
    });
    expect(implementationScopeGate(cleanScope({ lockfile_changed: true, dependency_manifest_changed: ['package.json'] }), s).passed).toBe(true);
  });
});

describe('staticSecurityGate', () => {
  const scan = (over: Partial<SecretScanResult> = {}): SecretScanResult => ({ scanner: 'gitleaks', completed: true, findings: [], files: 3, note: 'gitleaks', reportPath: '/r/secret-scan.json', ...over });

  it('is unverified without any SAST check, and says the built-in scanner is weaker', () => {
    const g = staticSecurityGate({ scan: scan({ scanner: 'builtin', note: 'built-in patterns' }), sast: [] });
    expect(g.status).toBe('unverified');
    expect(g.notes).toEqual(['secret scan used built-in patterns only: built-in patterns', 'static analysis (SAST) is unverified: the policy defines no SAST check']);
  });

  it('fails on a secret finding, listing at most ten with their lines when known', () => {
    const findings = Array.from({ length: 12 }, (_, i) => ({ file: `f${i}.ts`, line: i === 0 ? null : i, rule: 'github-pat' }));
    const g = staticSecurityGate({ scan: scan({ findings }), sast: [{ checkId: 'sast', status: 'PASSED' }] });
    expect(g.status).toBe('fail');
    expect(g.reasons[0]).toContain('found 12 potential secret(s): f0.ts (github-pat), f1.ts:1 (github-pat)');
    expect(g.reasons[0]).not.toContain('f10.ts');
  });

  it('judges each SAST check: failed fails, passed is clean, anything else is unverified and says what', () => {
    const g = staticSecurityGate({ scan: scan(), sast: [{ checkId: 'a', status: 'FAILED' }, { checkId: 'b', status: 'PASSED' }, { checkId: 'c', status: null }, { checkId: 'd', status: 'TIMEOUT' }] });
    expect(g.reasons).toEqual(['SAST check a failed']);
    expect(g.notes).toEqual(['SAST check c is unverified (not run)', 'SAST check d is unverified (TIMEOUT)']);
    expect(g.evidence).toEqual(expect.arrayContaining(['SAST c: not run', 'SAST b: PASSED']));
    expect(g.details).toEqual({ secrets: 0, sastDefined: true });
  });

  it('an incomplete scan is stated and keeps an otherwise clean result from passing', () => {
    const g = staticSecurityGate({ scan: scan({ completed: false }), sast: [{ checkId: 'a', status: 'PASSED' }] });
    expect(g.status).toBe('unverified');
    expect(g.notes).toEqual(['the secret scan did not complete']);
    expect(staticSecurityGate({ scan: scan(), sast: [{ checkId: 'a', status: 'PASSED' }] }).status).toBe('pass');
  });
});

describe('behaviourGate', () => {
  const evaluation = (over: Omit<Partial<Evaluation>, 'report'> & { report?: Partial<EvidenceReport> } = {}): Evaluation => {
    const { report: r, ...rest } = over;
    return {
      report: { task_id: 't', run_id: 'r', attempt: 1, candidate_revision: 'c', tree_hash: 't', check_config_hash: 'h', policy_hash: 'p', scope: cleanScope(), checks: [{ id: 'unit', status: 'PASSED', exit_code: 0, flaky: true, log: 'l' }], ui: [], acceptance_evidence: [{ criterion_id: 'AC-1', status: 'supported', artifacts: [] } as never], verdict: 'PASS', unverified: [], ...r },
      failReasons: [],
      incompleteReasons: [],
      ...rest,
    } as Evaluation;
  };

  it('a failed verdict carries the reasons, or a generic one when there are none', () => {
    expect(behaviourGate(evaluation({ report: { verdict: 'FAIL' }, failReasons: ['unit failed'] })).reasons).toEqual(['unit failed']);
    expect(behaviourGate(evaluation({ report: { verdict: 'FAIL' } })).reasons).toEqual(['the evidence verdict is FAIL']);
  });

  it('a pass is pass, an incomplete verdict is unverified with its reasons and disclosures, and flaky checks are marked', () => {
    const pass = behaviourGate(evaluation());
    expect(pass.status).toBe('pass');
    expect(pass.evidence).toEqual(['unit: PASSED (flaky) (l)', 'AC-1: supported']);
    const inc = behaviourGate(evaluation({ report: { verdict: 'INCOMPLETE', unverified: ['no UI proof'] }, incompleteReasons: ['unit not run'] }));
    expect(inc.status).toBe('unverified');
    expect(inc.notes).toEqual(['unit not run', 'no UI proof']);
  });
});

describe('uiGate', () => {
  const journeys = [{ id: 'home', status: 'PASSED' }] as never;
  const result = (verdict: string, over: object = {}) => ({ verdict, reasons: [], unverified: [], journeys, ...over }) as never;

  it('is a pass when no UI evidence is needed, a failure when it is needed but unconfigured, unverified when it did not run', () => {
    expect(uiGate({ required: false, configured: false, result: null }).status).toBe('pass');
    expect(uiGate({ required: true, configured: false, result: null }).reasons).toEqual(['UI evidence is required but the policy configures no UI journeys']);
    const g = uiGate({ required: true, configured: true, result: null });
    expect(g.status).toBe('unverified');
    expect(g.notes).toEqual(['UI checks did not run']);
  });

  it('passes with its disclosures, and fails or blocks with the runner\'s reasons or a generic one', () => {
    expect(uiGate({ required: true, configured: true, result: result('PASS', { unverified: ['no dark mode'] }) })).toMatchObject({ status: 'pass', notes: ['no dark mode'], evidence: ['home: PASSED'] });
    expect(uiGate({ required: true, configured: true, result: result('FAIL', { reasons: ['journey home failed'] }) }).reasons).toEqual(['journey home failed']);
    expect(uiGate({ required: true, configured: true, result: result('BLOCKED') }).reasons).toEqual(['UI verdict BLOCKED']);
  });

  it('any other verdict is unverified with the reasons and disclosures as notes', () => {
    const g = uiGate({ required: true, configured: true, result: result('INCOMPLETE', { reasons: ['no browser'], unverified: ['no baseline'] }) });
    expect(g.status).toBe('unverified');
    expect(g.notes).toEqual(['no browser', 'no baseline']);
  });
});

describe('deliveryGate and completionGate with real records', () => {
  it('delivery is refused with the freshness error and its code, and passes for fresh evidence of the reviewed tree', () => {
    lab = makeUnitLab();
    const ctx = lab.ctx();
    const cand = addCandidate(lab);
    const ev = addEvidence(lab, cand);
    const ok = deliveryGate({ snapshot: ctx.snapshot, candidate: cand, evidence: ev, review: { treeHash: cand.treeHash, verdict: 'APPROVE' }, deliveryCommitTree: cand.treeHash });
    expect(ok).toMatchObject({ status: 'pass', details: { code: null } });
    const stale = deliveryGate({ snapshot: ctx.snapshot, candidate: cand, evidence: ev, review: { treeHash: cand.treeHash, verdict: 'APPROVE' }, deliveryCommitTree: 'x'.repeat(40) });
    expect(stale.status).toBe('fail');
    expect(stale.details.code).toBeTruthy();
    const noReview = deliveryGate({ snapshot: ctx.snapshot, candidate: cand, evidence: ev, review: null, deliveryCommitTree: cand.treeHash });
    expect(noReview.status).toBe('fail');
  });

  it('a defect in the freshness check itself is not turned into a refusal', () => {
    lab = makeUnitLab();
    const ctx = lab.ctx();
    const cand = addCandidate(lab);
    const ev = addEvidence(lab, cand);
    const broken = { ...ev, report: null } as never;
    expect(() => deliveryGate({ snapshot: ctx.snapshot, candidate: cand, evidence: broken, review: null, deliveryCommitTree: 'x' })).toThrow(TypeError);
  });

  it('completion has nothing to judge without a candidate', () => {
    lab = makeUnitLab();
    const g = completionGate(lab.db, { run: { id: lab.runId }, snapshot: lab.ctx().snapshot, candidate: null, implementerProvider: 'claude', deliveredTree: null, now: lab.clock.now() });
    expect(g.reasons).toEqual(['there is no candidate']);
  });

  it('completion needs a live PASS report, an APPROVE of the tree and the delivered tree to match', () => {
    lab = makeUnitLab();
    const ctx = lab.ctx();
    const cand = addCandidate(lab);
    const input = { run: { id: lab.runId }, snapshot: ctx.snapshot, candidate: cand, implementerProvider: 'claude', now: lab.clock.now() };
    const bare = completionGate(lab.db, { ...input, deliveredTree: null });
    expect(bare.reasons).toEqual(expect.arrayContaining([`no live evidence report for candidate ${cand.id}`, `no APPROVE review of tree ${cand.treeHash}`, 'no delivered commit to compare with the reviewed tree']));

    addEvidence(lab, cand, { verdict: 'FAIL' });
    const failed = completionGate(lab.db, { ...input, deliveredTree: 'other' });
    expect(failed.reasons).toContain('the evidence verdict is FAIL, not PASS');
    expect(failed.reasons).toContain(`the delivered tree other is not the reviewed tree ${cand.treeHash}`);

    const cand2 = addCandidate(lab, { tree: 'u'.repeat(40), commit: 'd'.repeat(40) });
    const ev2 = addEvidence(lab, cand2, { policy_hash: 'sha256:stale' });
    const stale = completionGate(lab.db, { ...input, candidate: cand2, deliveredTree: cand2.treeHash });
    expect(stale.reasons.some((r) => r.startsWith('the evidence is stale: policy snapshot changed'))).toBe(true);
    expect(ev2.id).toBeTruthy();
  });

  it('completion passes with fresh evidence, an independent approval and the same tree delivered; an open material question still blocks it', () => {
    lab = makeUnitLab();
    const ctx = lab.ctx();
    const cand = addCandidate(lab);
    addEvidence(lab, cand);
    addReview(lab, cand, { provider: 'codex' });
    const input = { run: { id: lab.runId }, snapshot: ctx.snapshot, candidate: cand, implementerProvider: 'claude', deliveredTree: cand.treeHash, now: lab.clock.now() };
    const g = completionGate(lab.db, input);
    expect(g.reasons).toEqual([]);
    expect(g.evidence).toContain(`delivered tree ${cand.treeHash}`);
    insertQuestion(
      lab.db,
      { id: 'q-1', runId: lab.runId, mode: 'clarify', question: 'Which rounding?', evidence: [], options: [], changes: [], recommendation: { option: 'a', reason: 'r' }, safeDefault: { exists: false, option: null, reason: 'none' }, material: true, affected: ['AC-1'], unblocked: [] },
      lab.clock,
    );
    expect(blockingQuestions(lab.db, lab.runId)).toMatchObject({ criteria: ['AC-1'] });
    const blocked = completionGate(lab.db, input);
    expect(blocked.reasons).toEqual(['AC-1 is blocked by open question(s) q-1 waiting for a person']);
    expect(blocked.details.blockedCriteria).toEqual(['AC-1']);
  });

  it('independentReviewGate approves only with an APPROVE and lists what cleared', () => {
    lab = makeUnitLab();
    const ctx = lab.ctx();
    const cand = addCandidate(lab);
    const none = independentReviewGate(lab.db, { runId: lab.runId, treeHash: cand.treeHash, snapshot: ctx.snapshot, implementerProvider: 'claude', now: lab.clock.now() });
    expect(none.status).toBe('fail');
    expect(none.details.approved).toBe(false);
    const review = addReview(lab, cand, { provider: 'codex' });
    const ok = independentReviewGate(lab.db, { runId: lab.runId, treeHash: cand.treeHash, snapshot: ctx.snapshot, implementerProvider: 'claude', now: lab.clock.now() });
    expect(ok.status).toBe('pass');
    expect(ok.details.approved).toBe(true);
    expect(ok.evidence).toEqual([`review ${review.id} by codex: APPROVE on tree ${cand.treeHash}`]);
  });
});
