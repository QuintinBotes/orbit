import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Baseline = typeof import('../../../src/evidence/baseline.ts');
type Runner = typeof import('../../../src/evidence/runner.ts');
type UiRunner = typeof import('../../../src/ui/runner.ts');
type Expl = typeof import('../../../src/controller/exploration.ts');
type Sec = typeof import('../../../src/controller/security.ts');
type Git = typeof import('../../../src/evidence/git.ts');

const hooks = vi.hoisted(() => ({
  installDependencies: vi.fn(),
  runChecks: vi.fn(),
  runUiChecks: vi.fn(),
  toEvidenceUi: vi.fn(),
  exploreCandidate: vi.fn(),
  scanCandidateSecrets: vi.fn(),
  git: vi.fn(),
}));
vi.mock('../../../src/evidence/baseline.ts', async (orig) => ({ ...(await orig<Baseline>()), installDependencies: hooks.installDependencies }));
vi.mock('../../../src/evidence/runner.ts', async (orig) => ({ ...(await orig<Runner>()), runChecks: hooks.runChecks }));
vi.mock('../../../src/ui/runner.ts', async (orig) => ({ ...(await orig<UiRunner>()), runUiChecks: hooks.runUiChecks, toEvidenceUi: hooks.toEvidenceUi }));
vi.mock('../../../src/controller/exploration.ts', async (orig) => ({ ...(await orig<Expl>()), exploreCandidate: hooks.exploreCandidate }));
vi.mock('../../../src/controller/security.ts', async (orig) => ({ ...(await orig<Sec>()), scanCandidateSecrets: hooks.scanCandidateSecrets }));
vi.mock('../../../src/evidence/git.ts', async (orig) => ({ ...(await orig<Git>()), git: hooks.git }));

const { EXPLORATION_NOT_RUN, collectVerificationEvidence } = await import('../../../src/controller/verification.ts');
const { defaultCheck, defaultUi } = await import('../../../src/policy/config.ts');
const { addCandidate, cleanScope, makeUnitLab, setContract } = await import('./coverage-helpers.ts');
const { repoKey } = await import('../../../src/controller/context.ts');
type UnitLab = import('./coverage-helpers.ts').UnitLab;
type CheckResult = import('../../../src/evidence/types.ts').CheckResult;
type OrbitConfig = import('../../../src/policy/types.ts').OrbitConfig;

let lab: UnitLab;
beforeEach(() => {
  for (const f of Object.values(hooks)) f.mockReset();
  hooks.installDependencies.mockResolvedValue({ skipped: true, reason: 'no lockfile', ok: false, results: [], audit: null });
  hooks.runChecks.mockImplementation(async (c: { candidate: { id: string; treeHash: string }; checkIds: string[]; snapshot: { check_config_hashes: Record<string, string> }; run: { policyHash: string } }) => c.checkIds.map((id) => checkResult(c, id, 'PASSED')));
  hooks.git.mockResolvedValue('');
  hooks.scanCandidateSecrets.mockResolvedValue({ scanner: 'builtin', completed: true, findings: [], files: 1, note: 'built-in', reportPath: '/r' });
  hooks.toEvidenceUi.mockReturnValue([]);
});
afterEach(() => lab?.cleanup());

function checkResult(c: { candidate: { id: string; treeHash: string }; snapshot: { check_config_hashes: Record<string, string> }; run: { policyHash: string } }, id: string, status: CheckResult['status']): CheckResult {
  return {
    id: `chk-${id}`,
    checkId: id,
    kind: 'command',
    binding: { candidateId: c.candidate.id, treeHash: c.candidate.treeHash, checkConfigHash: c.snapshot.check_config_hashes[id]!, policyHash: c.run.policyHash },
    command: ['node'],
    cwd: '/x',
    isolation: 'none',
    isolationLimitations: [],
    startedAt: 1,
    endedAt: 2,
    exitCode: status === 'PASSED' ? 0 : 1,
    status,
    timedOut: false,
    cancelled: false,
    flaky: false,
    logPath: 'evidence/1/unit.log',
    logSha256: 'a'.repeat(64),
    fingerprint: status === 'PASSED' ? null : 'fp:1',
    excerpt: null,
    artifacts: [],
  };
}

function setup(opts: { ui?: boolean; exploration?: boolean; sast?: boolean; contract?: boolean; tweak?: (c: OrbitConfig) => void } = {}) {
  lab = makeUnitLab({
    path: ['PREFLIGHT'],
    tweak: (c) => {
      if (opts.sast) c.checks = { ...c.checks, semgrep: { ...defaultCheck('semgrep'), command: ['node', '-e', '0'], category: 'sast' } };
      if (opts.ui) {
        c.checks = { ...c.checks, e2e: { ...defaultCheck('e2e'), command: ['npx', 'playwright', 'test'], kind: 'playwright', category: 'ui', mandatory: false } };
        c.ui = { ...defaultUi(), journey_check_ids: ['e2e'], ...(opts.exploration ? { exploration: { enabled: true, max_minutes: 1, budget_usd: 1 } } : {}) } as never;
      }
      opts.tweak?.(c);
    },
  });
  if (opts.contract !== false) setContract(lab, { allowed_paths: ['apps/calc.mjs'], ...(opts.sast ? { required_check_ids: ['unit', 'semgrep'], acceptance_criteria: [{ id: 'AC-1', statement: 's', proof: ['p'], mandatory: true, check_ids: ['unit', 'semgrep'] }] } : {}) });
  const cand = addCandidate(lab);
  const ctx = lab.ctx();
  return { ctx, cand, checkoutDir: join(lab.base, 'checkout') };
}

const run = (s: ReturnType<typeof setup>, over: Record<string, unknown> = {}) => collectVerificationEvidence(s.ctx, s.cand, { checkoutDir: s.checkoutDir, scope: cleanScope(), exploration: true, ...over } as never);

describe('preconditions', () => {
  it('has nothing to verify before a contract exists or before preflight recorded the base revision', async () => {
    const s = setup({ contract: false });
    await expect(run(s)).rejects.toMatchObject({ code: 'TRANSITION_INVALID', message: expect.stringContaining('has no contract yet') });
    lab.cleanup();
    const t = setup();
    lab.db.run('UPDATE runs SET base_revision = NULL WHERE id = ?', lab.runId);
    t.ctx.run = lab.ctx().run;
    await expect(run(t)).rejects.toMatchObject({ code: 'TRANSITION_INVALID', message: expect.stringContaining('has no base revision') });
  });
});

describe('collecting evidence', () => {
  it('runs the required command checks in the candidate checkout and judges the evidence, gates in order', async () => {
    const s = setup();
    // The candidate adds a test (P2: a green check counts only when the change could have turned it green).
    hooks.git.mockImplementation(async (_cwd: string, args: string[]) => (args.includes('--diff-filter=ACMT') ? 'apps/calc.mjs\0tests/calc.test.mjs\0' : ''));
    const gates: string[] = [];
    const out = await run(s, { onGate: (g: { gate: string }) => gates.push(g.gate), notes: ['one-shot authorization used'] });
    expect('evidence' in out).toBe(true);
    if (!('evidence' in out)) return;
    const e = out.evidence;
    expect(gates).toEqual(['ui', 'static_security']);
    expect(e.report.verdict).toBe('PASS');
    expect(e.failReasons).toEqual([]);
    expect(e.uiRequired).toBe(false);
    expect(e.exploration).toBeNull();
    expect(e.report.unverified).toContain('one-shot authorization used');
    const runnerCtx = hooks.runChecks.mock.calls[0]![0] as { checkIds: string[]; checkoutDir: string; pollMs: number; killGraceMs: number };
    expect(runnerCtx).toMatchObject({ checkIds: ['unit'], checkoutDir: s.checkoutDir, pollMs: 20, killGraceMs: 50 });
    expect(hooks.scanCandidateSecrets.mock.calls[0]![0]).toMatchObject({ baseRev: s.ctx.run.baseRevision, commit: s.cand.commitSha, now: lab.clock.now() });
  });

  // P2: the base revision is the comparison. The tree, the recorded baseline and the paths the candidate adds or modifies.
  it('does not support a criterion whose check already passed on the base revision when the candidate adds no test', async () => {
    const s = setup();
    const baseTree = 'b'.repeat(40);
    writeFileSync(join(s.ctx.runDir, 'baseline.json'), JSON.stringify({ schema: 'orbit.baseline/1', baseTree, policyHash: s.ctx.run.policyHash, checks: [{ checkId: 'unit', status: 'PASSED' }] }));
    hooks.git.mockImplementation(async (_cwd: string, args: string[]) => (args[0] === 'rev-parse' ? `${baseTree}\n` : args.includes('--diff-filter=ACMT') ? 'apps/calc.mjs\0' : ''));
    const out = await run(s);
    if (!('evidence' in out)) throw new Error('stopped');
    expect(out.evidence.report.verdict).toBe('INCOMPLETE');
    expect(out.evidence.report.acceptance_evidence[0]).toMatchObject({ status: 'unverified', note: expect.stringContaining('already passed on the base revision') });
    const diff = hooks.git.mock.calls.find((c) => (c[1] as string[]).includes('--diff-filter=ACMT'))![1] as string[];
    expect(diff).toEqual(expect.arrayContaining([s.ctx.run.baseRevision, s.cand.commitSha]));
  });

  it('is INCOMPLETE for a candidate whose tree is the base tree', async () => {
    const s = setup();
    hooks.git.mockImplementation(async (_cwd: string, args: string[]) => (args[0] === 'rev-parse' ? `${s.cand.treeHash}\n` : ''));
    const out = await run(s);
    if (!('evidence' in out)) throw new Error('stopped');
    expect(out.evidence.report.verdict).toBe('INCOMPLETE');
    expect(out.evidence.incompleteReasons.join('\n')).toContain('the candidate makes no change');
  });

  it('ignores a baseline recorded under another policy: its failing result is not taken as the base revision\'s', async () => {
    const s = setup();
    const baseTree = 'b'.repeat(40);
    writeFileSync(join(s.ctx.runDir, 'baseline.json'), JSON.stringify({ schema: 'orbit.baseline/1', baseTree, policyHash: 'sha256:other', checks: [{ checkId: 'unit', status: 'FAILED' }] }));
    hooks.git.mockImplementation(async (_cwd: string, args: string[]) => (args[0] === 'rev-parse' ? `${baseTree}\n` : args.includes('--diff-filter=ACMT') ? 'apps/calc.mjs\0' : ''));
    const out = await run(s);
    if (!('evidence' in out)) throw new Error('stopped');
    expect(out.evidence.report.acceptance_evidence[0]).toMatchObject({ status: 'unverified', note: expect.stringContaining('no failing result recorded on the base revision') });
  });

  it('does not run the checks when the dependency install failed, and says nothing passed without them', async () => {
    const s = setup();
    hooks.installDependencies.mockResolvedValue({ skipped: false, reason: 'ENOTFOUND', ok: false, results: [], audit: null });
    const out = await run(s);
    expect(hooks.runChecks).not.toHaveBeenCalled();
    expect('evidence' in out && out.evidence.report.verdict).not.toBe('PASS');
  });

  it('runs the checks after an install that succeeded and keeps its results', async () => {
    const s = setup();
    hooks.installDependencies.mockImplementation(async (c: Parameters<typeof checkResult>[0]) => ({ skipped: false, reason: null, ok: true, results: [checkResult(c, 'unit', 'PASSED')], audit: null }));
    await run(s);
    expect(hooks.runChecks).toHaveBeenCalledTimes(1);
  });

  it('discloses a dependency audit that could not run, but not one that blocked (the install already failed)', async () => {
    const s = setup();
    hooks.installDependencies.mockResolvedValue({ skipped: true, reason: 'x', ok: false, results: [], audit: { blocking: [], summary: 'dependency audit could not run: offline' } });
    const out = await run(s);
    expect('evidence' in out && out.evidence.report.unverified).toContain('dependency audit could not run: offline');
    const t = setup();
    hooks.installDependencies.mockResolvedValue({ skipped: false, reason: 'blocked', ok: false, results: [], audit: { blocking: [{}], summary: 'blocking advisory' } });
    const blocked = await run(t);
    expect('evidence' in blocked && blocked.evidence.report.unverified).not.toContain('blocking advisory');
    const u = setup();
    hooks.installDependencies.mockResolvedValue({ skipped: true, reason: 'x', ok: false, results: [], audit: { blocking: [], summary: '' } });
    expect((await run(u)) && true).toBe(true);
  });

  it('hands back what a checkpoint returns instead of going on, after the checks, the UI run and the exploration', async () => {
    const s = setup({ ui: true, exploration: true });
    hooks.git.mockResolvedValue('src/App.tsx\0');
    hooks.runUiChecks.mockResolvedValue({ verdict: 'PASS', reasons: [], unverified: [], journeys: [] });
    hooks.exploreCandidate.mockResolvedValue(null);
    let n = 0;
    const stopAt = (k: number) => async () => (++n === k ? 'stop' : null);
    expect(await run(s, { checkpoint: stopAt(1) })).toEqual({ stopped: 'stop' });
    expect(hooks.runUiChecks).not.toHaveBeenCalled();
    n = 0;
    expect(await run(s, { checkpoint: stopAt(2) })).toEqual({ stopped: 'stop' });
    expect(hooks.runUiChecks).toHaveBeenCalledTimes(1);
    // The application under test reads the repository's dependency caches, as the checks do (issue #26).
    expect((hooks.runUiChecks.mock.calls[0]![0] as { toolchainCacheRoot?: string }).toolchainCacheRoot).toBe(join(lab.home, 'toolchains', repoKey(lab.repo)));
    expect(hooks.exploreCandidate).not.toHaveBeenCalled();
    n = 0;
    expect(await run(s, { checkpoint: stopAt(3) })).toEqual({ stopped: 'stop' });
    expect(hooks.exploreCandidate).toHaveBeenCalledTimes(1);
    expect(hooks.scanCandidateSecrets).not.toHaveBeenCalled();
  });

  it('a step interrupted during the checks is cancelled, not judged', async () => {
    const s = setup();
    const ac = new AbortController();
    hooks.runChecks.mockImplementation(async () => {
      ac.abort();
      return [];
    });
    s.ctx.signal = ac.signal as never;
    Object.defineProperty(s.ctx, 'signal', { value: ac.signal });
    await expect(run(s)).rejects.toMatchObject({ code: 'CANCELLED', message: 'the step was interrupted during checks' });
  });
});

describe('UI evidence', () => {
  it('runs the journeys when a UI path changed and takes their verdict into the report', async () => {
    const s = setup({ ui: true });
    hooks.git.mockResolvedValue('src/App.tsx\0apps/calc.mjs\0');
    hooks.runUiChecks.mockResolvedValue({ verdict: 'FAIL', reasons: ['journey home failed'], unverified: ['no dark mode'], journeys: [{ id: 'home', status: 'FAILED' }] });
    hooks.toEvidenceUi.mockReturnValue([{ journey: 'home', checkId: 'e2e', status: 'FAILED', artifacts: [] }]);
    const gates: { gate: string; status: string }[] = [];
    const out = await run(s, { onGate: (g: { gate: string; status: string }) => gates.push(g) });
    expect('evidence' in out).toBe(true);
    if (!('evidence' in out)) return;
    expect(out.evidence.uiRequired).toBe(true);
    expect(hooks.runUiChecks.mock.calls[0]![0]).toMatchObject({ journeyCheckIds: ['e2e'], checkoutDir: s.checkoutDir });
    expect(gates[0]).toMatchObject({ gate: 'ui', status: 'fail' });
    expect(out.evidence.report.verdict).toBe('FAIL');
    expect(out.evidence.failReasons).toContain('journey home: failed');
    expect(out.evidence.report.unverified).toContain('no dark mode');
  });

  it('does not run journeys when no UI path changed and no criterion needs one', async () => {
    const s = setup({ ui: true });
    hooks.git.mockResolvedValue('apps/calc.mjs\0');
    const out = await run(s);
    expect(hooks.runUiChecks).not.toHaveBeenCalled();
    expect('evidence' in out && out.evidence.uiRequired).toBe(false);
  });

  it('a UI failure does not overturn a verdict that already failed for another reason', async () => {
    const s = setup({ ui: true });
    hooks.git.mockResolvedValue('src/App.tsx\0');
    hooks.runUiChecks.mockResolvedValue({ verdict: 'FAIL', reasons: ['ui failed'], unverified: [], journeys: [] });
    hooks.runChecks.mockImplementation(async (c: Parameters<typeof checkResult>[0] & { checkIds: string[] }) => c.checkIds.map((id) => checkResult(c, id, 'FAILED')));
    const out = await run(s);
    expect('evidence' in out && out.evidence.failReasons).not.toContain('ui failed');
  });
});

describe('UI exploration', () => {
  const explored = (over: object = {}) => ({ outcome: 'completed', findings: [], reproduced: [], unreproduced: [], unverified: ['explorer saw one viewport'], reasons: [], ...over });

  it('fails the verdict on reproduced defects and discloses the exploration\'s own gaps', async () => {
    const s = setup({ ui: true, exploration: true });
    hooks.git.mockResolvedValue('src/App.tsx\0');
    hooks.runUiChecks.mockResolvedValue({ verdict: 'PASS', reasons: [], unverified: [], journeys: [] });
    hooks.exploreCandidate.mockResolvedValue(explored({ reproduced: [{ id: 'UX-1', severity: 'high' }, { id: 'UX-2', severity: 'low' }], unreproduced: [{ id: 'UX-3' }] }));
    const out = await run(s);
    if (!('evidence' in out)) throw new Error('stopped');
    const why = 'UI exploration reproduced 2 defect(s) as failing tests: UX-1 (high), UX-2 (low)';
    expect(out.evidence.report.verdict).toBe('FAIL');
    expect(out.evidence.failReasons).toContain(why);
    expect(out.evidence.report.unverified).toEqual(expect.arrayContaining([why, 'explorer saw one viewport', '1 UI exploration candidate(s) did not reproduce as failing tests and do not count']));
    expect(out.evidence.exploration).not.toBeNull();
  });

  it('an exploration with nothing reproduced only discloses', async () => {
    const s = setup({ ui: true, exploration: true });
    hooks.git.mockResolvedValue('src/App.tsx\0');
    hooks.runUiChecks.mockResolvedValue({ verdict: 'PASS', reasons: [], unverified: [], journeys: [] });
    hooks.exploreCandidate.mockResolvedValue(explored());
    const out = await run(s);
    if (!('evidence' in out)) throw new Error('stopped');
    expect(out.evidence.report.verdict).not.toBe('FAIL');
    expect(out.evidence.report.unverified).toContain('explorer saw one viewport');
    expect(out.evidence.failReasons.some((r) => r.includes('UI exploration reproduced'))).toBe(false);
  });

  it('says so when exploration would have run but this verification is not the controller\'s', async () => {
    const s = setup({ ui: true, exploration: true });
    hooks.git.mockResolvedValue('src/App.tsx\0');
    hooks.runUiChecks.mockResolvedValue({ verdict: 'PASS', reasons: [], unverified: [], journeys: [] });
    const out = await run(s, { exploration: false });
    expect(hooks.exploreCandidate).not.toHaveBeenCalled();
    expect('evidence' in out && out.evidence.report.unverified).toContain(EXPLORATION_NOT_RUN);
  });

  it('exploration that is off is not mentioned at all', async () => {
    const s = setup({ ui: true });
    hooks.git.mockResolvedValue('src/App.tsx\0');
    hooks.runUiChecks.mockResolvedValue({ verdict: 'PASS', reasons: [], unverified: [], journeys: [] });
    const out = await run(s, { exploration: false });
    expect('evidence' in out && out.evidence.report.unverified).not.toContain(EXPLORATION_NOT_RUN);
  });
});

describe('static security', () => {
  it('fails the verdict on a secret finding and lists it among the reasons', async () => {
    const s = setup();
    hooks.scanCandidateSecrets.mockResolvedValue({ scanner: 'gitleaks', completed: true, findings: [{ file: 'apps/a.mjs', line: 3, rule: 'github-pat', severity: 'critical' }], files: 1, note: 'gitleaks', reportPath: '/r' });
    const out = await run(s);
    if (!('evidence' in out)) throw new Error('stopped');
    expect(out.evidence.report.verdict).toBe('FAIL');
    expect(out.evidence.failReasons.some((r) => r.includes('potential secret(s)'))).toBe(true);
    expect(out.evidence.security.status).toBe('fail');
  });

  it('judges each SAST check from the result it left, discloses a waived or unreadable verdict and passes the gitleaks path through', async () => {
    const s = setup({ sast: true });
    s.ctx.deps.gitleaksPath = null;
    hooks.runChecks.mockImplementation(async (c: Parameters<typeof checkResult>[0] & { checkIds: string[] }) => c.checkIds.map((id) => checkResult(c, id, 'PASSED')));
    const out = await run(s);
    if (!('evidence' in out)) throw new Error('stopped');
    expect(out.evidence.sast.map((v) => v.checkId)).toEqual(['semgrep']);
    // The check passed and wrote no SARIF: its own status stands.
    expect(out.evidence.sast[0]).toMatchObject({ sarif: false, status: 'PASSED', classification: null });
    expect(hooks.scanCandidateSecrets.mock.calls[0]![0]).toHaveProperty('gitleaksPath', null);
    expect(out.evidence.security.status).toBe('pass');
  });

  it('reads a SAST check\'s SARIF: a blocking finding fails the gate, an advisory one is disclosed with the evidence', async () => {
    const { writeFileSync } = await import('node:fs');
    const sarif = (level: string) => JSON.stringify({ runs: [{ results: [{ ruleId: 'js/x', level, message: { text: 'm' } }] }] });
    for (const [level, status, disclosed] of [['error', 'fail', false], ['warning', 'pass', true]] as const) {
      const s = setup({ sast: true });
      const path = join(lab.base, `out-${level}.sarif`);
      writeFileSync(path, sarif(level));
      hooks.runChecks.mockImplementation(async (c: Parameters<typeof checkResult>[0] & { checkIds: string[] }) =>
        c.checkIds.map((id) => ({ ...checkResult(c, id, 'PASSED'), artifacts: id === 'semgrep' ? [{ path, sha256: 'b'.repeat(64), kind: 'sarif' }] : [] })),
      );
      const out = await run(s);
      if (!('evidence' in out)) throw new Error('stopped');
      expect(out.evidence.security.status, level).toBe(status);
      expect(out.evidence.sast[0]?.sarif).toBe(true);
      expect(out.evidence.report.unverified.some((u) => u.startsWith('SAST check semgrep:')), level).toBe(disclosed);
      lab.cleanup();
    }
  });
});
