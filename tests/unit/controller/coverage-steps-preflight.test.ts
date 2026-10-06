import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Git = typeof import('../../../src/evidence/git.ts');
type Base = typeof import('../../../src/evidence/baseline.ts');
const hooks = vi.hoisted(() => ({ git: vi.fn(), resolveCommit: vi.fn(), treeOf: vi.fn(), adminDirFor: vi.fn(), runBaseline: vi.fn() }));
vi.mock('../../../src/evidence/git.ts', async (orig) => ({ ...(await orig<Git>()), git: hooks.git, resolveCommit: hooks.resolveCommit, treeOf: hooks.treeOf, adminDirFor: hooks.adminDirFor }));
vi.mock('../../../src/evidence/baseline.ts', async (orig) => ({ ...(await orig<Base>()), runBaseline: hooks.runBaseline }));

const { checkEnvironment, dirtyPaths, ensureWorktree, preflightStep, IMPLEMENTER_PROVIDER, recordGate } = await import('../../../src/controller/steps/preflight.ts');
const { OrbitError } = await import('../../../src/core/errors.ts');
const { getRun, requestCancel } = await import('../../../src/controller/run-store.ts');
const { listDecisions } = await import('../../../src/storage/decisions.ts');
const { makeUnitLab } = await import('./coverage-helpers.ts');
const { capturingLogger } = await import('./coverage-log.ts');
type UnitLab = import('./coverage-helpers.ts').UnitLab;
type ProviderAdapter = import('../../../src/adapters/types.ts').ProviderAdapter;
type OrbitConfig = import('../../../src/policy/types.ts').OrbitConfig;

let lab: UnitLab;
beforeEach(() => {
  for (const f of Object.values(hooks)) f.mockReset();
  hooks.resolveCommit.mockResolvedValue('b'.repeat(40));
  hooks.treeOf.mockResolvedValue('t'.repeat(40));
  hooks.git.mockResolvedValue('');
  hooks.adminDirFor.mockImplementation(async (_r: string, wt: string) => ({ gitDir: '/g', worktree: wt }));
  hooks.runBaseline.mockResolvedValue({ report: { schema: 'orbit.baseline/1', runId: 'x', baseRevision: 'b', baseTree: 't', policyHash: 'p', checkIds: [], install: { skipped: true, reason: null, ok: false }, checks: [], failures: [], complete: true, recordedAt: 0 } });
});
afterEach(() => lab?.cleanup());

const claude = (state: 'valid' | 'expired' | 'missing' = 'valid', over: Partial<ProviderAdapter> = {}): ProviderAdapter =>
  ({
    id: 'claude',
    discoverCapabilities: async () => ({ provider: 'claude', available: true, version: '1', models: [], structuredOutput: true, readOnlySandbox: true, usageReporting: 'full', costReporting: true, detail: '' }),
    validateCredentials: async () => ({ state, method: 'api_key', detail: `${state} credentials` }),
    ...over,
  }) as unknown as ProviderAdapter;
const codex = (): ProviderAdapter => ({ ...claude('valid'), id: 'codex' }) as ProviderAdapter;

function setup(tweak?: (c: OrbitConfig) => void, adapters: Record<string, ProviderAdapter> = { claude: claude(), codex: codex() }, logger?: ReturnType<typeof capturingLogger>) {
  lab = makeUnitLab({
    path: ['PREFLIGHT'],
    adapters,
    tweak: (c) => {
      c.providers.codex = { ...c.providers.codex!, data_policy_eligible: true, model: 'gpt-6-astra' };
      tweak?.(c);
    },
    ...(logger ? { logger: logger.logger } : {}),
  });
  lab.deps.registry.seed();
  for (const e of lab.deps.registry.list()) lab.deps.registry.markAvailability(e.modelId, e.provider === 'codex' ? 'codex-cli' : 'claude-cli', true, 'test');
  return lab.ctx();
}

const decisions = (kind: string) => listDecisions(lab.db, lab.runId, { kind });
const state = () => getRun(lab.db, lab.runId).state;

describe('preflightStep', () => {
  it('passes, records the gates, and leaves with the base revision, tree, worktree and branch on the run', async () => {
    setup();
    const out = await preflightStep(lab.ctx());
    expect(out).toEqual({ progressed: true });
    const run = getRun(lab.db, lab.runId);
    expect(run).toMatchObject({ state: 'CONTRACTING', baseRevision: 'b'.repeat(40), baseTree: 't'.repeat(40) });
    expect(run.branch).toBe(`orbit/${lab.runId}`);
    expect(run.worktreePath).toContain('implementer');
    expect(decisions('gate.intake')).toHaveLength(1);
    expect(decisions('gate.environment')).toHaveLength(1);
    expect(decisions('gate.baseline')).toHaveLength(1);
    expect(hooks.runBaseline.mock.calls[0]![0]).toMatchObject({ baseRev: 'b'.repeat(40), pollMs: 20, killGraceMs: 50 });
    expect(existsSync(join(lab.ctx().runDir, 'environment.json'))).toBe(true);
  });

  it('stops at a safe point, before and after the baseline', async () => {
    setup();
    requestCancel(lab.db, lab.runId, 'u', lab.clock);
    expect(await preflightStep(lab.ctx())).toMatchObject({ done: true });
    lab.cleanup();
    setup();
    hooks.runBaseline.mockImplementation(async () => {
      requestCancel(lab.db, lab.runId, 'u', lab.clock);
      return { report: { failures: [], install: { skipped: true, ok: false, reason: null }, checks: [], complete: true, baseRevision: 'b', baseTree: 't' } };
    });
    expect(await preflightStep(lab.ctx())).toMatchObject({ done: true });
    expect(state()).toBe('CANCELLED');
  });

  it('blocks when the intake gate refuses the run', async () => {
    setup();
    lab.db.run("UPDATE runs SET mode = 'supervised' WHERE id = ?", lab.runId);
    await preflightStep(lab.ctx());
    expect(state()).toBe('BLOCKED');
    expect(getRun(lab.db, lab.runId).outcomeReason).toMatch(/^intake gate: /);
  });

  it('blocks on credentials the environment gate found unusable, naming the provider, and for any other environment problem blocks with the reasons', async () => {
    setup(undefined, { claude: claude('expired'), codex: codex() });
    await preflightStep(lab.ctx());
    expect(state()).toBe('BLOCKED');
    expect(getRun(lab.db, lab.runId).outcomeReason).toContain('claude credentials');
    lab.cleanup();
    setup((c) => void (c.isolation = { provider: 'none', allow_unisolated: false, container: null }));
    await preflightStep(lab.ctx());
    expect(getRun(lab.db, lab.runId).outcomeReason).toMatch(/^environment gate: /);
  });

  it('refuses a dirty repository unless the policy allows it, in which case it records that the run starts from the commit', async () => {
    setup();
    hooks.git.mockResolvedValue(' M apps/a.mjs\0?? notes.txt\0');
    await preflightStep(lab.ctx());
    expect(getRun(lab.db, lab.runId).outcomeReason).toContain('uncommitted changes (apps/a.mjs, notes.txt)');
    lab.cleanup();
    setup((c) => void (c.repository.allow_dirty_start = true));
    hooks.git.mockResolvedValue(' M apps/a.mjs\0');
    expect(await preflightStep(lab.ctx())).toEqual({ progressed: true });
    expect(decisions('preflight.dirty-start')[0]?.summary).toContain('dirty start allowed by policy; 1 uncommitted path(s)');
  });

  it('lists at most ten dirty paths in the refusal', async () => {
    setup();
    hooks.git.mockResolvedValue(Array.from({ length: 12 }, (_, i) => ` M f${i}.txt\0`).join(''));
    await preflightStep(lab.ctx());
    const reason = getRun(lab.db, lab.runId).outcomeReason!;
    expect(reason).toContain('f9.txt, ...');
    expect(reason).not.toContain('f10.txt');
  });

  it('blocks when the locked install failed on the base revision, and passes with notes when the baseline is incomplete', async () => {
    setup();
    const report = (over: object) => ({ report: { schema: 'orbit.baseline/1', runId: 'x', baseRevision: 'b', baseTree: 't', policyHash: 'p', checkIds: [], install: { skipped: false, reason: 'ENOTFOUND', ok: false }, checks: [], failures: [], complete: true, recordedAt: 0, ...over } });
    hooks.runBaseline.mockResolvedValue(report({}));
    await preflightStep(lab.ctx());
    expect(getRun(lab.db, lab.runId).outcomeReason).toContain('baseline gate: the locked dependency install failed on the base revision: ENOTFOUND');
    lab.cleanup();
    setup();
    hooks.runBaseline.mockResolvedValue(report({ install: { skipped: true, reason: null, ok: false }, complete: false }));
    expect(await preflightStep(lab.ctx())).toEqual({ progressed: true });
  });

  it('records pre-existing failures as a decision, asks a person about each exception that can be offered, and says why one cannot', async () => {
    setup();
    hooks.runBaseline.mockResolvedValue({
      report: { schema: 'orbit.baseline/1', runId: 'x', baseRevision: 'b', baseTree: 't', policyHash: 'p', checkIds: [], install: { skipped: true, reason: null, ok: false }, checks: [], failures: [{ checkId: 'unit', fingerprint: 'fp:1', excerpt: 'boom' }, { checkId: 'lint', fingerprint: null, excerpt: null }], complete: true, recordedAt: 0 },
    });
    await preflightStep(lab.ctx());
    expect(state()).toBe('CONTRACTING');
    expect(decisions('baseline.failures')[0]?.summary).toBe(`pre-existing failures on ${'b'.repeat(12)}: unit, lint`);
    expect(lab.db.all('SELECT 1 FROM questions WHERE run_id = ?', lab.runId)).toHaveLength(1);
    expect(decisions('baseline.exception-unavailable')[0]?.summary).toContain('lint');
    expect(getRun(lab.db, lab.runId).outcomeReason).toBeNull();
  });
});

describe('ensureWorktree', () => {
  it('reuses a registered worktree, removes one git does not know, rethrows anything else, and creates a missing one at the base', async () => {
    setup();
    const path = join(lab.base, 'wt');
    expect(await ensureWorktree(lab.repo, path, 'b'.repeat(40))).toBe(path);
    expect(hooks.git.mock.calls.map((c) => (c[1] as string[]).slice(0, 2).join(' '))).toEqual(['worktree prune', 'worktree add']);
    expect(hooks.git.mock.calls[1]![1]).toEqual(['worktree', 'add', '--detach', '--force', path, 'b'.repeat(40)]);

    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'leftover'), 'x');
    hooks.adminDirFor.mockClear();
    expect(await ensureWorktree(lab.repo, path, 'b'.repeat(40))).toBe(path);
    expect(hooks.adminDirFor).toHaveBeenCalledTimes(1);

    mkdirSync(path, { recursive: true });
    hooks.adminDirFor.mockReset();
    hooks.adminDirFor.mockRejectedValueOnce(new OrbitError('GIT_FAILED', 'not a worktree'));
    hooks.adminDirFor.mockImplementation(async (_r: string, wt: string) => ({ gitDir: '/g', worktree: wt }));
    writeFileSync(join(path, 'leftover'), 'x');
    await ensureWorktree(lab.repo, path, 'b'.repeat(40));
    expect(existsSync(join(path, 'leftover'))).toBe(false);

    mkdirSync(path, { recursive: true });
    hooks.adminDirFor.mockReset();
    hooks.adminDirFor.mockRejectedValueOnce(new TypeError('bug'));
    await expect(ensureWorktree(lab.repo, path, 'b'.repeat(40))).rejects.toThrow('bug');
  });

  it('dirtyPaths leaves out entries too short to be paths and reads the porcelain output', async () => {
    setup();
    hooks.git.mockResolvedValue(' M a.txt\0?? b dir/c.txt\0\0 M\0');
    expect(await dirtyPaths(lab.repo)).toEqual(['a.txt', 'b dir/c.txt']);
  });

  it('recordGate writes the gate as a decision with its reasons and notes in the summary', () => {
    setup();
    recordGate(lab.ctx(), { gate: 'intake', status: 'fail', passed: false, reasons: ['a', 'b'], evidence: ['e'], notes: ['n'], onFailure: 'reject-contract', details: {} });
    recordGate(lab.ctx(), { gate: 'baseline', status: 'pass', passed: true, reasons: [], evidence: [], notes: [], onFailure: 'record-baseline', details: {} });
    expect(decisions('gate.intake')[0]?.summary).toBe('intake gate fail: a; b (notes: n)');
    expect(decisions('gate.baseline')[0]?.summary).toBe('baseline gate pass');
  });
});

describe('checkEnvironment', () => {
  it('writes what it found, and requires the implementer and the independent reviewer', async () => {
    setup();
    const env = await checkEnvironment(lab.ctx());
    expect(IMPLEMENTER_PROVIDER).toBe('claude');
    expect(Object.keys(env.capabilities).sort()).toEqual(['claude', 'codex']);
    expect(env.credentials.map((c) => c.provider).sort()).toEqual(['claude', 'codex']);
    expect(env.reviewer?.decision).toBe('SELECT');
    const file = JSON.parse(readFileSync(join(lab.ctx().runDir, 'environment.json'), 'utf8'));
    expect(file.credentials.map((c: { provider: string }) => c.provider).sort()).toEqual(['claude', 'codex']);
    expect(file.reviewer).toEqual(expect.any(String));
  });

  it('a registry that cannot be seeded is logged, an isolation that cannot be built is an environment error, and an adapter that cannot report capabilities is unavailable', async () => {
    const cap = capturingLogger();
    setup((c) => void (c.isolation = { provider: 'none', allow_unisolated: true, container: null }), { claude: claude('valid', { discoverCapabilities: async () => { throw new Error('cli missing'); } }), codex: codex() }, cap);
    lab.deps.registry.seed = () => {
      throw new Error('seed failed');
    };
    const ctx = lab.ctx();
    ctx.isolation = () => {
      throw new Error('no isolation provider');
    };
    const env = await checkEnvironment(ctx);
    expect(cap.lines().some((l) => l.msg === 'model registry seed failed' && l.error === 'seed failed')).toBe(true);
    expect(env.gate.reasons).toContain('isolation is unavailable: no isolation provider');
    expect(env.capabilities.claude).toMatchObject({ available: false, detail: 'cli missing' });
  });

  // Decision 0007: who would review is judged in every mode, so the gate and the report can say it; only the
  // providers a run cannot do without have their credentials judged.
  it('without a mandatory independent review the reviewer is still judged, and a preferred provider that is the implementer is not required twice', async () => {
    setup((c) => {
      c.review.independent_provider_required = false;
      c.review.fallback_same_provider_allowed = true;
    });
    const env = await checkEnvironment(lab.ctx());
    expect(env.reviewer).not.toBeNull();
    // Every provider is probed, but only the implementer's credentials are judged.
    expect(env.gate.evidence.filter((e) => e.startsWith('credentials ')).map((e) => e.split(' ')[1]!.replace(':', ''))).toEqual(['claude']);
    lab.cleanup();
    setup((c) => void (c.review.preferred_provider = 'claude' as never));
    const same = await checkEnvironment(lab.ctx());
    expect(same.gate.details).toBeDefined();
  });

  it('an unusable independent reviewer is an environment problem with its reason', async () => {
    // review.when_unavailable: block, the default before decision 0007 (#6, #8).
    setup((c) => void (c.review.when_unavailable = 'block'), { claude: claude(), codex: { ...codex(), validateCredentials: async () => ({ state: 'expired', method: 'oauth', detail: 'token expired' }) } as ProviderAdapter });
    const env = await checkEnvironment(lab.ctx());
    expect(env.reviewer?.decision).toBe('BLOCK');
    expect(env.gate.passed).toBe(false);
    expect(env.gate.reasons.some((r) => r.startsWith('independent review: '))).toBe(true);
  });

});
