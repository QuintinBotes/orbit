import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hooks = vi.hoisted(() => ({ behaviour: null as null | ((self: never) => Promise<void>), constructed: [] as unknown[] }));

vi.mock('../../../src/controller/loop.ts', () => {
  class Controller {
    readonly ownerId = 'ctl-fake';
    readonly deps: unknown;
    readonly opts: unknown;
    stopped: string | null = null;
    private release: (() => void) | null = null;
    constructor(opts: { deps: unknown }) {
      this.opts = opts;
      this.deps = opts.deps;
      hooks.constructed.push(this);
    }
    async start(): Promise<void> {
      await hooks.behaviour?.(this as never);
    }
    wait(): Promise<void> {
      return new Promise((r) => (this.release = r));
    }
    stop(reason: string): Promise<void> {
      this.stopped = reason;
      this.release?.();
      return Promise.resolve();
    }
  }
  return { Controller };
});

const { ManualClock } = await import('../../../src/core/clock.ts');
const { openDb } = await import('../../../src/storage/db.ts');
const { defaultCheck, defaultConfig } = await import('../../../src/policy/config.ts');
const { ModelRegistry } = await import('../../../src/routing/registry.ts');
const { KnowledgeStore } = await import('../../../src/knowledge/store.ts');
const { completeEvaluation, createCandidateOverlay, distillOverlay, startEvaluation } = await import('../../../src/knowledge/overlays.ts');
const { buildReplaySuite } = await import('../../../src/knowledge/evals.ts');
const { finalizeCandidate, insertEvidenceReport, reserveCandidate } = await import('../../../src/evidence/store.ts');
const { planWorker, markWorkerRunning, getWorker } = await import('../../../src/storage/workers.ts');
const { recordReview } = await import('../../../src/review/store.ts');
const { ReplayEvalRunner, autoEvaluateOverlays, evaluateAndDecide, liveWindow, measureRun, replayConfig } = await import('../../../src/controller/eval-runner.ts');
const { createRun } = await import('../../../src/controller/run-store.ts');
const { recordUsage } = await import('../../../src/routing/usage.ts');
const { addEvidence, makeUnitLab } = await import('./coverage-helpers.ts');
const { ev, makeLesson } = await import('../knowledge/helpers.ts');
type UnitLab = import('./coverage-helpers.ts').UnitLab;
type PromptOverlay = import('../../../src/knowledge/types.ts').PromptOverlay;
type OrbitConfig = import('../../../src/policy/types.ts').OrbitConfig;

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'acme', GIT_AUTHOR_EMAIL: 'dev@acme.test', GIT_COMMITTER_NAME: 'acme', GIT_COMMITTER_EMAIL: 'dev@acme.test', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const dirs: string[] = [];
let lab: UnitLab | undefined;
beforeEach(() => {
  hooks.behaviour = null;
  hooks.constructed.length = 0;
});
afterEach(() => {
  lab?.cleanup();
  lab = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-evr-')));
  dirs.push(d);
  return d;
}

function sourceRepo(): { repo: string; rev: string; home: string } {
  const base = tmp();
  const repo = join(base, 'repo');
  mkdirSync(join(repo, 'apps'), { recursive: true });
  writeFileSync(join(repo, 'apps', 'a.mjs'), 'export const a = 1;\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  return { repo, rev: git(repo, 'rev-parse', 'HEAD'), home: join(base, 'home') };
}

function config(): OrbitConfig {
  const c = defaultConfig('autonomous-delivery');
  c.isolation = { provider: 'none', allow_unisolated: true, container: null };
  c.scope.allowed_paths = ['apps/**'];
  c.checks = { unit: { ...defaultCheck('unit'), command: ['node', '-e', '0'] } };
  return c;
}

const replayCase = (rev: string, over: object = {}) => ({ id: 'case-1', run_id: 'orb-old', goal: 'Add mul', contract: {} as never, contract_hash: null, base_revision: rev, check_ids: ['unit'], ...over });
const suiteOf = (cases: object[]) => ({ id: 'suite-1', role: 'implementer', created_at: '2026-10-05T00:00:00.000Z', cases: cases as never });

function runner(src: ReturnType<typeof sourceRepo>, over: Partial<ConstructorParameters<typeof ReplayEvalRunner>[0]> = {}) {
  const clock = new ManualClock();
  return new ReplayEvalRunner({
    repoRoot: src.repo,
    config: config(),
    clock,
    orbitHome: src.home,
    budgetUsd: 2,
    deps: (input) => ({ db: input.db!, clock, adapters: {}, registry: new ModelRegistry(input.db!, clock), orbitHome: src.home, orbitInstallDir: process.cwd() }),
    ...over,
  });
}

/** Make the fake controller leave the replayed run in a state, with the records measureRun reads. */
function finishAs(state: 'SUCCEEDED' | 'EXHAUSTED', opts: { outcomeReason?: string; evidence?: 'PASS' | 'none'; contractChecks?: string[] } = {}) {
  return async (self: { deps: { db: import('../../../src/storage/db.ts').OrbitDb } }) => {
    const db = self.deps.db;
    const run = db.get<{ id: string }>('SELECT id FROM runs LIMIT 1')!;
    db.run('UPDATE runs SET state = ?, outcome_reason = ?, contract_json = ? WHERE id = ?', state, opts.outcomeReason ?? null, JSON.stringify({ required_check_ids: opts.contractChecks ?? ['unit'] }), run.id);
    if (opts.evidence === 'PASS') {
      const cand = reserveCandidate(db, { runId: run.id, attempt: 1, workerId: null, treeHash: 't'.repeat(40), parentSha: 'p'.repeat(40) }, new ManualClock());
      finalizeCandidate(db, cand.id, 'c'.repeat(40), { files: 1, insertions: 1, deletions: 0, binaryFiles: 0, paths: [], truncated: false }, new ManualClock());
      insertEvidenceReport(
        db,
        {
          candidateId: cand.id,
          report: { task_id: run.id, run_id: run.id, attempt: 1, candidate_revision: 'c'.repeat(40), tree_hash: 't'.repeat(40), check_config_hash: 'h', policy_hash: 'p', scope: {} as never, checks: [{ id: 'unit', status: 'PASSED', exit_code: 0, flaky: false, log: 'l' }], ui: [], acceptance_evidence: [], verdict: 'PASS', unverified: [] },
          reportPath: null,
        },
        new ManualClock(),
      );
    }
  };
}

describe('replayConfig', () => {
  it('turns a delivery mode into autonomous, switches every delivery action off and learning down to the overlay read, and bounds the model spend', () => {
    const c = config();
    c.actions.push_task_branch = true;
    c.actions.open_pull_request = true;
    c.knowledge = { ...c.knowledge, share_globally: true, curator_budget_usd: 3, eval_budget_usd: 5, auto_adopt_overlays: true };
    const r = replayConfig(c, 0.5);
    expect(r.mode).toBe('autonomous');
    expect(r.actions.push_task_branch).toBe(false);
    expect(r.actions.open_pull_request).toBe(false);
    expect(r.knowledge).toMatchObject({ enabled: true, share_globally: false, curator_budget_usd: 0, eval_budget_usd: 0, auto_adopt_overlays: false });
    expect(r.scheduler.hard_limits.model_cost_usd).toBe(0.5);
    expect(c.mode).toBe('autonomous-delivery');
    expect(c.actions.push_task_branch).toBe(true);
    expect(replayConfig(c, 0).scheduler.hard_limits.model_cost_usd).toBe(0.01);
    expect(replayConfig(c, 10_000).scheduler.hard_limits.model_cost_usd).toBe(c.scheduler.hard_limits.model_cost_usd);
    const local = replayConfig({ ...config(), mode: 'supervised' } as OrbitConfig, 1);
    expect(local.mode).toBe('supervised');
  });
});

describe('measureRun and liveWindow', () => {
  it('a run with a contract it cannot read, or none, requires no checks', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    lab.db.run("UPDATE runs SET contract_json = '{bad' WHERE id = ?", lab.runId);
    expect(measureRun(lab.db, lab.runId)).toMatchObject({ state: 'PREFLIGHT', verified: false, attempts: 0, costUsd: 0 });
    lab.db.run('UPDATE runs SET contract_json = NULL WHERE id = ?', lab.runId);
    expect(measureRun(lab.db, lab.runId).verified).toBe(false);
  });

  it('is verified only for a succeeded run with a fresh PASS report of the candidate tree and every required check passing', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    lab.db.run("UPDATE runs SET state = 'SUCCEEDED', contract_json = ? WHERE id = ?", JSON.stringify({ required_check_ids: ['unit'] }), lab.runId);
    expect(measureRun(lab.db, lab.runId).verified).toBe(false);
    const cand = reserveCandidate(lab.db, { runId: lab.runId, attempt: 1, workerId: null, treeHash: 't'.repeat(40), parentSha: 'p'.repeat(40) }, lab.clock);
    finalizeCandidate(lab.db, cand.id, 'c'.repeat(40), { files: 1, insertions: 1, deletions: 0, binaryFiles: 0, paths: [], truncated: false }, lab.clock);
    addEvidence(lab, cand, { checks: [{ id: 'unit', status: 'PASSED', exit_code: 0, flaky: false, log: 'l' }] });
    expect(measureRun(lab.db, lab.runId).verified).toBe(true);
    expect(measureRun(lab.db, lab.runId, ['unit', 'lint']).verified).toBe(false);
    expect(measureRun(lab.db, lab.runId, []).verified).toBe(true);
  });

  it('counts a candidate that passed verification and was then refused by review as a false pass', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const cand = reserveCandidate(lab.db, { runId: lab.runId, attempt: 1, workerId: null, treeHash: 't'.repeat(40), parentSha: 'p'.repeat(40) }, lab.clock);
    finalizeCandidate(lab.db, cand.id, 'c'.repeat(40), { files: 1, insertions: 1, deletions: 0, binaryFiles: 0, paths: [], truncated: false }, lab.clock);
    addEvidence(lab, cand);
    recordReview(lab.db, { runId: lab.runId, candidateId: cand.id, treeHash: cand.treeHash, round: 1, provider: 'codex', model: null, workerId: null, verdict: 'BLOCK', packetSha256: null, findings: [] }, lab.clock);
    expect(measureRun(lab.db, lab.runId).falsePass).toBe(true);
  });

  it('a run whose spend was never measured has no cost, and a window containing it has no mean cost', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    lab.db.run("UPDATE runs SET state = 'SUCCEEDED', contract_json = ? WHERE id = ?", JSON.stringify({ required_check_ids: [] }), lab.runId);
    const cand = reserveCandidate(lab.db, { runId: lab.runId, attempt: 1, workerId: null, treeHash: 't'.repeat(40), parentSha: 'p'.repeat(40) }, lab.clock);
    finalizeCandidate(lab.db, cand.id, 'c'.repeat(40), { files: 1, insertions: 1, deletions: 0, binaryFiles: 0, paths: [], truncated: false }, lab.clock);
    addEvidence(lab, cand);
    recordUsage(lab.db, { runId: lab.runId, workerId: null, provider: 'claude', model: null, usage: { provider: 'claude', model: null, inputTokens: 5, outputTokens: 5, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null, costSource: 'unavailable' }, durationMs: 1 }, lab.clock);
    const m = measureRun(lab.db, lab.runId);
    expect(m).toMatchObject({ verified: true, costUsd: null });
    expect(liveWindow(lab.db, 0)).toMatchObject({ verified_pass_rate: 1, mean_cost_usd: null });
  });

  it('a window with no settled run is null, and one with runs reports the metrics of those runs', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    expect(liveWindow(lab.db, 0)).toBeNull();
    lab.db.run("UPDATE runs SET state = 'EXHAUSTED' WHERE id = ?", lab.runId);
    createRun(lab.db, { id: 'orb-2', repoRoot: lab.repo, goal: 'g', mode: 'autonomous', policyHash: 'sha256:x', policyPath: '/p' }, lab.clock);
    lab.db.run("UPDATE runs SET state = 'SUCCEEDED' WHERE id = 'orb-2'");
    const w = liveWindow(lab.db, 0)!;
    expect(w.tasks).toBe(2);
    expect(w).toMatchObject({ verified_pass_rate: 0, false_pass_rate: 0 });
    expect(liveWindow(lab.db, lab.clock.now() + 1_000_000)).toBeNull();
  });
});

describe('ReplayEvalRunner.runCase', () => {
  it('replays the case in a throwaway clone with no remote and measures the run it left behind', async () => {
    const src = sourceRepo();
    hooks.behaviour = finishAs('SUCCEEDED', { evidence: 'PASS' });
    const r = runner(src);
    const out = await r.runCase(suiteOf([replayCase(src.rev)]), replayCase(src.rev), null);
    expect(out).toEqual({ case_id: 'case-1', verified: true, attempts: 0, cost_usd: 0, false_pass: false });
    expect(r.spentUsd).toBe(0);
    // The clone is gone: the eval directory has nothing left.
    expect(readdirSync(join(src.home, 'eval', readdirSync(join(src.home, 'eval'))[0]!))).toEqual([]);
    const opts = (hooks.constructed[0] as { opts: { mode: string; runId: string; handleSignals: boolean } }).opts;
    expect(opts).toMatchObject({ mode: 'foreground', handleSignals: false });
  });

  it('keeps the clone when asked, with the overlay under test active for its role and no remote', async () => {
    const src = sourceRepo();
    const clock = new ManualClock();
    const store = KnowledgeStore.open(':memory:', { clock });
    const lesson = store.upsertLesson(makeLesson({ status: 'validated', evidence: [ev('r1'), ev('r2')], applicability: { roles: ['implementer'] } })).lesson;
    const overlay = createCandidateOverlay(store, distillOverlay('implementer', [{ lesson, stats: store.stats(lesson.id) }]), 'repo');
    hooks.behaviour = finishAs('EXHAUSTED');
    const r = runner(src, { keepClones: true, clock });
    const out = await r.runCase(suiteOf([replayCase(src.rev)]), replayCase(src.rev), overlay);
    expect(out.verified).toBe(false);
    const evalRoot = join(src.home, 'eval');
    const dir = join(evalRoot, readdirSync(evalRoot)[0]!, readdirSync(join(evalRoot, readdirSync(evalRoot)[0]!))[0]!);
    expect(git(join(dir, 'repo'), 'remote')).toBe('');
    const clone = KnowledgeStore.open(join(dir, 'repo', '.orbit', 'knowledge.sqlite'), { clock });
    expect(clone.activeOverlay('implementer', 'repo')?.content).toBe(overlay.content);
    clone.close();
    store.close();
  });

  it('copies the live model registry into the clone so a replay routes to the same models', async () => {
    const src = sourceRepo();
    const live = openDb(':memory:');
    const reg = new ModelRegistry(live, new ManualClock());
    reg.seed();
    let copied = 0;
    hooks.behaviour = async (self: { deps: { db: import('../../../src/storage/db.ts').OrbitDb } }) => {
      copied = self.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM model_registry')!.n;
    };
    await runner(src, { registryDb: live }).runCase(suiteOf([replayCase(src.rev)]), replayCase(src.rev), null);
    expect(copied).toBe(live.get<{ n: number }>('SELECT COUNT(*) AS n FROM model_registry')!.n);
    expect(copied).toBeGreaterThan(0);
  });

  it('refuses to start once stopped, and once the budget is spent', async () => {
    const src = sourceRepo();
    const ac = new AbortController();
    ac.abort();
    await expect(runner(src, { signal: ac.signal }).runCase(suiteOf([]), replayCase(src.rev), null)).rejects.toMatchObject({ code: 'CANCELLED' });
    const r = runner(src, { budgetUsd: 0 });
    await expect(r.runCase(suiteOf([]), replayCase(src.rev), null)).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED', message: expect.stringContaining('$0.00 is spent after $0.00') });
  });

  it('reports a budget too small to admit one attempt as an error, not as two identical failures', async () => {
    const src = sourceRepo();
    hooks.behaviour = finishAs('EXHAUSTED', { outcomeReason: 'implementation attempt 1 was not admitted by the budget' });
    await expect(runner(src).runCase(suiteOf([]), replayCase(src.rev), null)).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED', message: expect.stringContaining('too small to run one replayed task') });
  });

  it('a revision that is not in the repository cannot be replayed, and the clone is removed all the same', async () => {
    const src = sourceRepo();
    await expect(runner(src).runCase(suiteOf([]), replayCase('0'.repeat(40)), null)).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('cannot replay at ' + '0'.repeat(40)) });
    const evalRoot = join(src.home, 'eval');
    expect(readdirSync(join(evalRoot, readdirSync(evalRoot)[0]!))).toEqual([]);
  });

  it('a source that is not a repository cannot be cloned', async () => {
    const src = sourceRepo();
    const bare = tmp();
    await expect(runner({ ...src, repo: bare }).runCase(suiteOf([]), replayCase(src.rev), null)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a case that outlives its limit is stopped, and the workers it left running are stopped with the reason', async () => {
    const src = sourceRepo();
    let worker = '';
    hooks.behaviour = async (self) => {
      const s = self as unknown as { deps: { db: import('../../../src/storage/db.ts').OrbitDb }; wait(): Promise<void> };
      const db = s.deps.db;
      const run = db.get<{ id: string }>('SELECT id FROM runs LIMIT 1')!;
      const w = planWorker(db, { id: 'wrk-late', runId: run.id, role: 'implementer', provider: 'claude', workerDir: join(src.home, 'wd'), cwd: src.repo }, new ManualClock());
      markWorkerRunning(db, w.id, { pid: 2_000_000_000, pgid: 2_000_000_000, procStart: 'x' }, new ManualClock());
      worker = w.id;
      await s.wait();
    };
    const r = runner(src, { caseTimeoutMs: 20 });
    const out = await r.runCase(suiteOf([]), replayCase(src.rev), null);
    expect(out.verified).toBe(false);
    expect((hooks.constructed[0] as { stopped: string }).stopped).toBe('replay case timed out');
    expect(worker).toBe('wrk-late');
  });

  it('stopping the evaluation stops the running case, and a worker that cannot be stopped does not fail the case', async () => {
    const src = sourceRepo();
    const ac = new AbortController();
    hooks.behaviour = async (self) => {
      const s = self as unknown as { deps: { db: import('../../../src/storage/db.ts').OrbitDb }; wait(): Promise<void> };
      const db = s.deps.db;
      const run = db.get<{ id: string }>('SELECT id FROM runs LIMIT 1')!;
      const w = planWorker(db, { id: 'wrk-stuck', runId: run.id, role: 'implementer', provider: 'claude', workerDir: join(src.home, 'wd2'), cwd: src.repo }, new ManualClock());
      markWorkerRunning(db, w.id, { pid: process.pid, pgid: process.pid, procStart: null }, new ManualClock());
      setTimeout(() => ac.abort(), 10);
      await s.wait();
      expect(getWorker(db, w.id).state).toBe('RUNNING');
    };
    const r = runner(src, { signal: ac.signal });
    await expect(r.runCase(suiteOf([]), replayCase(src.rev), null)).resolves.toMatchObject({ verified: false });
    expect((hooks.constructed[0] as { stopped: string }).stopped).toBe('evaluation stopped');
  });

  it('accumulates what each case spent', async () => {
    const src = sourceRepo();
    hooks.behaviour = async (self: { deps: { db: import('../../../src/storage/db.ts').OrbitDb } }) => {
      const db = self.deps.db;
      const run = db.get<{ id: string }>('SELECT id FROM runs LIMIT 1')!;
      db.run("INSERT INTO budget_counters (run_id, counter, used, allowance, hard_cap) VALUES (?, 'cost_usd', 0.75, 1, 1)", run.id);
    };
    const r = runner(src);
    await r.runCase(suiteOf([]), replayCase(src.rev), null);
    await r.runCase(suiteOf([]), replayCase(src.rev), null);
    expect(r.spentUsd).toBeCloseTo(1.5, 6);
    await expect(r.runCase(suiteOf([]), replayCase(src.rev), null)).resolves.toBeDefined();
    await expect(r.runCase(suiteOf([]), replayCase(src.rev), null)).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' });
  });

  it('the default dependency wiring builds the clone\'s controller from the repository itself', async () => {
    const src = sourceRepo();
    hooks.behaviour = async () => undefined;
    const clock = new ManualClock();
    const r = new ReplayEvalRunner({ repoRoot: src.repo, config: config(), clock, orbitHome: src.home, budgetUsd: 1, env: { PATH: process.env.PATH, ORBIT_HOME: src.home } });
    await expect(r.runCase(suiteOf([]), replayCase(src.rev), null)).resolves.toMatchObject({ verified: false });
    expect((hooks.constructed[0] as { deps: { orbitHome: string } }).deps.orbitHome).toBe(src.home);
  });
});

const openStore = () => KnowledgeStore.open(':memory:', { clock: new ManualClock() });

describe('evaluateAndDecide', () => {
  function candidateOverlay(store: Awaited<ReturnType<typeof openStore>>): PromptOverlay {
    const lesson = store.upsertLesson(makeLesson({ status: 'validated', evidence: [ev('r1'), ev('r2')], applicability: { roles: ['implementer'] } })).lesson;
    return createCandidateOverlay(store, distillOverlay('implementer', [{ lesson, stats: store.stats(lesson.id) }]), 'repo');
  }
  const suite = suiteOf([replayCase('r'.repeat(40))]);
  const good = { case_id: 'case-1', verified: true, attempts: 1, cost_usd: 0.1, false_pass: false };
  const bad = { ...good, verified: false };

  it('adopts a candidate that beats the base prompt, starting the evaluation itself', async () => {
    const store = KnowledgeStore.open(':memory:', { clock: new ManualClock() });
    const overlay = candidateOverlay(store);
    const out = await evaluateAndDecide({ store, overlay, suite, runner: { runCase: async (_s, _c, o) => (o ? good : bad) } });
    expect(out).toMatchObject({ adopted: true, cases: 1 });
    expect(out.overlay.status).toBe('active');
    store.close();
  });

  it('rejects a candidate that does not improve, and accepts an overlay already under evaluation', async () => {
    const store = KnowledgeStore.open(':memory:', { clock: new ManualClock() });
    const overlay = startEvaluation(store, candidateOverlay(store).id);
    const out = await evaluateAndDecide({ store, overlay, suite, runner: { runCase: async () => good } });
    expect(out.adopted).toBe(false);
    expect(out.overlay.status).toBe('rejected');
    store.close();
  });

  it('evaluates again when the active overlay changed under it, and gives up after the last attempt', async () => {
    const clock = new ManualClock();
    const store = KnowledgeStore.open(':memory:', { clock });
    const overlay = candidateOverlay(store);
    let calls = 0;
    const retries: [number, number][] = [];
    const out = await evaluateAndDecide({
      store,
      overlay,
      suite,
      maxAttempts: 3,
      onRetry: (a, m) => retries.push([a, m]),
      runner: {
        runCase: async (_s, _c, o) => {
          calls++;
          if (calls === 2 && o) {
            // Another controller adopts a different overlay while this replay runs.
            const rival = candidateOverlay(store);
            startEvaluation(store, rival.id);
            completeEvaluation(store, rival.id, { cases: 1, suite_id: 's', baseline: { verified_pass_rate: 0, mean_attempts: 1, mean_cost_usd: null, false_pass_rate: 0 }, candidate: { verified_pass_rate: 1, mean_attempts: 1, mean_cost_usd: 0.1, false_pass_rate: 0 }, baseline_overlay_id: null });
          }
          return o ? good : bad;
        },
      },
    });
    expect(retries).toEqual([[1, 3]]);
    expect(out.cases).toBe(1);
    store.close();

    const store2 = KnowledgeStore.open(':memory:', { clock });
    const o2 = candidateOverlay(store2);
    let n = 0;
    await expect(
      evaluateAndDecide({
        store: store2,
        overlay: o2,
        suite,
        maxAttempts: 2,
        runner: {
          runCase: async (_s, _c, o) => {
            if (o && n++ < 5) {
              const rival = candidateOverlay(store2);
              startEvaluation(store2, rival.id);
              completeEvaluation(store2, rival.id, { cases: 1, suite_id: 's', baseline: { verified_pass_rate: 0, mean_attempts: 1, mean_cost_usd: null, false_pass_rate: 0 }, candidate: { verified_pass_rate: 1, mean_attempts: 1, mean_cost_usd: 0.1, false_pass_rate: 0 }, baseline_overlay_id: store2.activeOverlay('implementer', 'repo')?.id ?? null });
            }
            return o ? good : bad;
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'CONCURRENT_UPDATE' });
    store2.close();
  });

  it('with no attempts allowed there is nothing to decide and it says the overlay kept changing', async () => {
    const store = KnowledgeStore.open(':memory:', { clock: new ManualClock() });
    await expect(evaluateAndDecide({ store, overlay: candidateOverlay(store), suite, maxAttempts: 0, runner: { runCase: async () => good } })).rejects.toThrow('the active overlay kept changing');
    store.close();
  });
});

describe('autoEvaluateOverlays', () => {
  const store = () => KnowledgeStore.open(':memory:', { clock: new ManualClock() });
  const withKnowledge = (over: Record<string, unknown>) => (c: OrbitConfig) => void (c.knowledge = { ...c.knowledge, enabled: true, ...over });

  it('does nothing unless automatic adoption is on and the evaluation budget is positive', async () => {
    lab = makeUnitLab({ tweak: withKnowledge({ auto_adopt_overlays: false }) });
    const s = store();
    expect(await autoEvaluateOverlays(lab.ctx(), s)).toEqual({ skipped: 'knowledge.auto_adopt_overlays is off' });
    lab.cleanup();
    lab = makeUnitLab({ tweak: withKnowledge({ auto_adopt_overlays: true, eval_budget_usd: 0 }) });
    expect(await autoEvaluateOverlays(lab.ctx(), s)).toEqual({ skipped: 'knowledge.eval_budget_usd is 0' });
    s.close();
  });

  it('an overlay interrupted mid-evaluation waits like a candidate, and a controller without a host environment still replays', async () => {
    lab = makeUnitLab({ tweak: withKnowledge({ auto_adopt_overlays: true, eval_budget_usd: 1 }), deps: { hostEnv: undefined } });
    const s = store();
    const lesson = s.upsertLesson(makeLesson({ status: 'validated', evidence: [ev('r1'), ev('r2')], applicability: { roles: ['implementer'] } })).lesson;
    const overlay = startEvaluation(s, createCandidateOverlay(s, distillOverlay('implementer', [{ lesson, stats: s.stats(lesson.id) }]), 'repo').id);
    expect(overlay.status).toBe('evaluating');
    expect(await autoEvaluateOverlays(lab.ctx(), s)).toEqual({ skipped: 'no successful runs to replay', overlay: overlay.id });
    s.close();
  });

  it('an evaluation that fails with plain text reports that text', async () => {
    lab = makeUnitLab({ tweak: withKnowledge({ auto_adopt_overlays: true, eval_budget_usd: 1 }) });
    const s = store();
    const lesson = s.upsertLesson(makeLesson({ status: 'validated', evidence: [ev('r1'), ev('r2')], applicability: { roles: ['implementer'] } })).lesson;
    const overlay = createCandidateOverlay(s, distillOverlay('implementer', [{ lesson, stats: s.stats(lesson.id) }]), 'repo');
    const ctx = lab.ctx();
    ctx.db = { ...lab.db, all: () => { throw 'replay suite exploded'; } } as never;
    expect(await autoEvaluateOverlays(ctx, s)).toEqual({ skipped: null, overlay: overlay.id, error: 'replay suite exploded' });
    s.close();
  });

  it('has nothing to do without a waiting candidate, and without past runs to replay', async () => {
    lab = makeUnitLab({ tweak: withKnowledge({ auto_adopt_overlays: true, eval_budget_usd: 1 }) });
    const s = store();
    expect(await autoEvaluateOverlays(lab.ctx(), s)).toEqual({ skipped: 'no candidate overlay' });
    const lesson = s.upsertLesson(makeLesson({ status: 'validated', evidence: [ev('r1'), ev('r2')], applicability: { roles: ['implementer'] } })).lesson;
    const overlay = createCandidateOverlay(s, distillOverlay('implementer', [{ lesson, stats: s.stats(lesson.id) }]), 'repo');
    expect(await autoEvaluateOverlays(lab.ctx(), s)).toEqual({ skipped: 'no successful runs to replay', overlay: overlay.id });
    s.close();
  });

  it('replays a past run against the waiting candidate with the controller\'s own collaborators and reports the decision', async () => {
    lab = makeUnitLab({ tweak: withKnowledge({ auto_adopt_overlays: true, eval_budget_usd: 1 }) });
    const s = store();
    const lesson = s.upsertLesson(makeLesson({ status: 'validated', evidence: [ev('r1'), ev('r2')], applicability: { roles: ['implementer'] } })).lesson;
    const overlay = createCandidateOverlay(s, distillOverlay('implementer', [{ lesson, stats: s.stats(lesson.id) }]), 'repo');
    writeFileSync(join(lab.repo, 'a.txt'), 'a\n');
    git(lab.repo, 'init', '-q', '-b', 'main');
    git(lab.repo, 'add', '-A');
    git(lab.repo, 'commit', '-q', '-m', 'base');
    const rev = git(lab.repo, 'rev-parse', 'HEAD');
    const ctx = lab.ctx();
    lab.db.run("UPDATE runs SET state = 'SUCCEEDED', contract_json = ?, base_revision = ? WHERE id = ?", JSON.stringify({ required_check_ids: ['unit'] }), rev, lab.runId);
    hooks.behaviour = async () => undefined;
    const out = await autoEvaluateOverlays(ctx, s);
    expect(out).toMatchObject({ skipped: null, overlay: overlay.id, adopted: false, spent_usd: 0 });
    expect(out.reason).toMatch(/no improvement|regression/);
    expect(s.getOverlay(overlay.id)?.status).toBe('rejected');
    s.close();
  });

  it('reports an evaluation that fails as an error, redacted, without throwing', async () => {
    lab = makeUnitLab({ tweak: withKnowledge({ auto_adopt_overlays: true, eval_budget_usd: 1 }) });
    const s = store();
    const lesson = s.upsertLesson(makeLesson({ status: 'validated', evidence: [ev('r1'), ev('r2')], applicability: { roles: ['implementer'] } })).lesson;
    const overlay = createCandidateOverlay(s, distillOverlay('implementer', [{ lesson, stats: s.stats(lesson.id) }]), 'repo');
    // One past successful run, at a revision the repository does not have.
    const ctx = lab.ctx();
    lab.db.run("UPDATE runs SET state = 'SUCCEEDED', contract_json = ?, base_revision = ? WHERE id = ?", JSON.stringify({ required_check_ids: ['unit'] }), '9'.repeat(40), lab.runId);
    expect(buildReplaySuite(lab.db, {}, lab.clock).cases).toHaveLength(1);
    const out = await autoEvaluateOverlays(ctx, s);
    expect(out).toMatchObject({ skipped: null, overlay: overlay.id });
    expect(out.error).toEqual(expect.any(String));
    expect(existsSync(join(lab.home, 'eval'))).toBe(true);
    s.close();
  });
});
