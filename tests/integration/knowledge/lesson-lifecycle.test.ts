/**
 * Issue #173: lessons that are cited, re-checked, contradicted and expired, driven through the controller's own hooks
 * (advisoryBlockFor when a worker is prompted, learnAtTerminal when a run ends) over runs recorded in one state
 * database. Nothing is told to the knowledge layer except what the runs recorded.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadRunContext, type RunContext } from '../../../src/controller/context.ts';
import { acquireLease } from '../../../src/controller/run-store.ts';
import { startRun } from '../../../src/controller/start.ts';
import { advisoryBlockFor, repoKnowledgePath } from '../../../src/controller/knowledge-hooks.ts';
import { learnAtTerminal } from '../../../src/controller/report.ts';
import { finalizeCandidate, reserveCandidate } from '../../../src/evidence/store.ts';
import { KnowledgeStore } from '../../../src/knowledge/store.ts';
import { completeEvaluation, createCandidateOverlay, distillOverlay, startEvaluation } from '../../../src/knowledge/overlays.ts';
import { planWorker } from '../../../src/storage/workers.ts';
import type { ProviderAdapter, TaskHandle, TaskResult, TaskSpec } from '../../../src/adapters/types.ts';
import { ev, makeLesson } from '../../unit/knowledge/helpers.ts';
import { addEvidence, BASE_REV, initLedger, makeUnitLab, OWNER, type UnitLab } from '../../unit/controller/coverage-helpers.ts';

let lab: UnitLab;
afterEach(() => lab?.cleanup());

const CITED = 'apps/calc.mjs';
let checkSeq = 0;

function on(c: { knowledge: { enabled: boolean; lessons_in_prompts?: boolean } }): void {
  c.knowledge.enabled = true;
  c.knowledge.lessons_in_prompts = true;
}

function withStore<T>(fn: (store: KnowledgeStore) => T): T {
  const store = KnowledgeStore.open(repoKnowledgePath(lab.ctx()), { clock: lab.clock });
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

/** Another run of the same repository, in the same state database. */
function nextRun(id: string): RunContext {
  startRun({ db: lab.db, repoRoot: lab.repo, goal: `Goal of ${id}.`, config: lab.config, clock: lab.clock, runId: id });
  acquireLease(lab.db, id, OWNER, 3_600_000, lab.clock);
  return loadRunContext(lab.deps, id, new AbortController().signal);
}

/** The candidate an implementer worker produced, changing `paths`, with one run of the unit check. */
function attempt(ctx: RunContext, workerId: string, seq: number, unit: { status: 'PASSED' | 'FAILED'; fingerprint?: string }, paths = [CITED]): string {
  const c = reserveCandidate(lab.db, { runId: ctx.run.id, attempt: seq, workerId, treeHash: `${seq}`.repeat(40).slice(0, 40), parentSha: BASE_REV }, lab.clock);
  const cand = finalizeCandidate(lab.db, c.id, 'c'.repeat(40), { files: paths.length, insertions: 3, deletions: 1, binaryFiles: 0, paths, truncated: false }, lab.clock);
  lab.db.run(
    `INSERT INTO check_runs (id, run_id, candidate_id, check_id, kind, tree_hash, check_config_hash, policy_hash, command_json, cwd, isolation, status, fingerprint, started_at)
     VALUES (?, ?, ?, 'unit', 'command', 't', 'c', 'p', '[]', '.', 'none', ?, ?, ?)`,
    `chk-${++checkSeq}`,
    ctx.run.id,
    cand.id,
    unit.status,
    unit.fingerprint ?? null,
    checkSeq,
  );
  if (unit.status === 'PASSED') {
    addEvidence({ db: lab.db, clock: lab.clock, runId: ctx.run.id }, cand, { acceptance_evidence: [{ criterion_id: 'AC-1', status: 'supported', artifacts: [] }] as never });
  }
  return cand.id;
}

function end(ctx: RunContext, state: 'SUCCEEDED' | 'EXHAUSTED' | 'BLOCKED', failureClass: string | null = null, outcome: object | null = null): Promise<void> {
  lab.db.run('UPDATE runs SET state = ?, failure_class = ?, outcome_json = ? WHERE id = ?', state, failureClass, outcome ? JSON.stringify(outcome) : null, ctx.run.id);
  return learnAtTerminal(loadRunContext(lab.deps, ctx.run.id, new AbortController().signal));
}

const learning = (ctx: RunContext) => JSON.parse(readFileSync(join(ctx.runDir, 'learning.json'), 'utf8')) as Record<string, unknown>;

describe('SC-001: one lesson goes from candidate to validated to deprecated on run evidence alone', () => {
  const STATEMENT = 'Keep each calculator operation in its own exported function.';
  /** The curator's answer for the next run that is curated: a lesson resting on that run's repair. */
  let curated: object = { lessons: [], discarded: [] };
  const curator = {
    id: 'claude',
    async startTask(spec: TaskSpec): Promise<TaskHandle> {
      return { provider: 'claude', workerId: spec.workerId, workerDir: spec.workerDir, pid: 2_000_000_000, pgid: 2_000_000_000, procStart: 'x', logPath: '', exitPath: '' };
    },
    async collectResult(): Promise<TaskResult> {
      return { status: 'succeeded', structured: curated, text: null, error: null, exitCode: 0, durationMs: 4, usage: { provider: 'claude', model: 'claude-haiku-x', inputTokens: 10, outputTokens: 5, cacheReadTokens: null, cacheWriteTokens: null, costUsd: 0.01, costSource: 'reported' } };
    },
    async cancelTask(): Promise<void> {},
  } as unknown as ProviderAdapter;

  /** A run whose implementer repaired fp-unit by changing the cited file, curated into the lesson. */
  async function repairedRun(id: string): Promise<void> {
    const ctx = nextRun(id);
    planWorker(lab.db, { id: `wrk-${id}`, runId: id, role: 'implementer', provider: 'claude', workerDir: join(lab.base, id), cwd: lab.repo }, lab.clock, OWNER);
    attempt(ctx, `wrk-${id}`, 1, { status: 'FAILED', fingerprint: 'fp-unit' });
    const fixed = attempt(ctx, `wrk-${id}`, 2, { status: 'PASSED' });
    curated = {
      lessons: [{
        schema: 'orbit.lesson/1', kind: 'repair-recipe', statement: STATEMENT, rationale: 'The unit check failed while two operations shared one function.',
        applicability: { languages: [], frameworks: [], paths: [], check_ids: ['unit'], fingerprints: ['fp-unit'], roles: ['implementer'], keywords: ['calculator'] },
        verification: 'Each operation is exported on its own and has its own test.',
        evidence: [{ run_id: id, artifact: `candidate:${fixed}`, relation: 'supports' }],
        provenance: { source: 'run', uri: null, derived_from: [], generated_by: 'stub', generated_at: '2026-11-20T00:00:00.000Z' },
        confidence: 'low', code_free: true, supersedes: null,
      }],
      discarded: [],
    };
    await end(ctx, 'SUCCEEDED');
  }

  it('is learned with a citation, validated by a second run, then deprecated by two runs where its failure repeated', async () => {
    lab = makeUnitLab({ tweak: on, adapters: { claude: curator } });
    mkdirSync(join(lab.repo, 'apps'), { recursive: true });
    writeFileSync(join(lab.repo, CITED), 'export const add = (a, b) => a + b;\n');

    await repairedRun('orb-1');
    const [lesson] = withStore((s) => s.listLessons());
    const id = lesson!.id;
    expect(lesson).toMatchObject({ status: 'candidate', citation: { run_id: 'orb-1', path: CITED, line: null, check_id: 'unit', finding_id: null } });

    // A candidate is not shown to workers; the same repair curated from a second run validates it.
    await repairedRun('orb-2');
    expect(withStore((s) => s.getLesson(id)!.status)).toBe('validated');
    expect(withStore((s) => s.stats(id))).toMatchObject({ support: 2, contradict: 0 });

    // orb-3 shows it to a worker repairing fp-unit, whose candidate fails with fp-unit again: one contradiction.
    const r3 = nextRun('orb-3');
    expect(advisoryBlockFor(r3, { role: 'implementer', workerId: 'wrk-3', paths: ['apps/**'], checkIds: ['unit'], fingerprints: ['fp-unit'] })).toContain(id);
    attempt(r3, 'wrk-3', 1, { status: 'FAILED', fingerprint: 'fp-unit' });
    await end(r3, 'EXHAUSTED', 'budget');
    expect(learning(r3).settled).toMatchObject({ contradicted: [id] });
    expect(withStore((s) => s.stats(id))).toMatchObject({ support: 2, contradict: 1 });
    expect(withStore((s) => s.getLesson(id)!.status)).toBe('validated');

    // orb-4 does the same: the second contradiction from a distinct run deprecates it, and it is never retrieved again.
    const r4 = nextRun('orb-4');
    expect(advisoryBlockFor(r4, { role: 'implementer', workerId: 'wrk-4', paths: ['apps/**'], checkIds: ['unit'], fingerprints: ['fp-unit'] })).toContain(id);
    attempt(r4, 'wrk-4', 1, { status: 'FAILED', fingerprint: 'fp-unit' });
    await end(r4, 'EXHAUSTED', 'budget');
    expect(withStore((s) => s.getLesson(id)!.status)).toBe('deprecated');
    expect(withStore((s) => s.events(id).filter((e) => e.type === 'status').map((e) => e.data))).toMatchObject([
      { from: 'candidate', to: 'validated', reason: 'promote.supported-by-distinct-runs' },
      { from: 'validated', to: 'deprecated', reason: 'deprecate.contradicted-twice' },
    ]);
    const r5 = nextRun('orb-5');
    expect(advisoryBlockFor(r5, { role: 'implementer', workerId: 'wrk-5', paths: ['apps/**'], checkIds: ['unit'], fingerprints: ['fp-unit'] })).toBe('');
  });

  it('FR-005: a successful run that did not touch the cited area gives no support; one whose failure did not repeat gives no contradiction', async () => {
    lab = makeUnitLab({ tweak: on });
    mkdirSync(join(lab.repo, 'apps'), { recursive: true });
    writeFileSync(join(lab.repo, CITED), 'x\n');
    const id = withStore((s) =>
      s.upsertLesson(makeLesson({ status: 'validated', applicability: { roles: ['implementer'], check_ids: ['unit'] }, evidence: [ev('orb-0'), ev('orb-00')], citation: { run_id: 'orb-0', path: CITED, line: null, check_id: null, finding_id: null } })).lesson.id,
    );
    const r2 = nextRun('orb-2');
    expect(advisoryBlockFor(r2, { role: 'implementer', workerId: 'wrk-2', paths: [CITED], checkIds: ['unit'], fingerprints: ['fp-unit'] })).toContain(id);
    attempt(r2, 'wrk-2', 1, { status: 'PASSED' }, ['apps/other.mjs']);
    await end(r2, 'SUCCEEDED');
    expect(learning(r2).settled).toMatchObject({ supported: [], contradicted: [] });
    expect(withStore((s) => s.stats(id))).toMatchObject({ support: 2, contradict: 0 });
  });
});

describe('User Story 1: a lesson whose cited file is gone, or that had no support for the expiry period, is not retrieved', () => {
  it('the end-of-run sweep marks it stale even with lessons out of prompts, and it is eligible again once the file is back', async () => {
    lab = makeUnitLab({ tweak: (c) => void (c.knowledge.enabled = true) });
    const id = withStore((s) => s.upsertLesson(makeLesson({ status: 'validated', evidence: [ev('orb-0'), ev('orb-00')], citation: { run_id: 'orb-0', path: CITED, line: null, check_id: null, finding_id: null } })).lesson.id);
    const r2 = nextRun('orb-2');
    await end(r2, 'SUCCEEDED');
    expect(learning(r2).rechecked).toEqual({ lessons: 1, stale: 1 });
    expect(withStore((s) => s.freshness([id]).get(id)?.stale_reason)).toBe(`cited path ${CITED} no longer exists`);
    mkdirSync(join(lab.repo, 'apps'), { recursive: true });
    writeFileSync(join(lab.repo, CITED), 'x\n');
    await end(nextRun('orb-3'), 'SUCCEEDED');
    expect(withStore((s) => s.freshness([id]).get(id))).toMatchObject({ stale_reason: null, verified_at: lab.clock.now() });
    lab.clock.advance(29 * 24 * 3_600_000);
    await end(nextRun('orb-4'), 'SUCCEEDED');
    expect(withStore((s) => s.freshness([id]).get(id)?.stale_reason)).toBe('expired: no support for 29 days (limit 28)');
  });
});

describe('User Story 3 / FR-006: a run that ends in a failure class leaves an observation, with no model call', () => {
  it('an environment block stores the check and its signature even when the budget reserve cannot pay for curation', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'], tweak: (c) => void (c.knowledge.enabled = true) });
    initLedger(lab);
    lab.db.run("UPDATE budget_counters SET used = hard_cap WHERE counter = 'cost_usd'");
    const ctx = lab.ctx();
    await end(ctx, 'BLOCKED', 'environment', { environment_failures: [{ check_id: 'unit', fingerprint: null, signals: ['dns-failure', 'registry-unreachable'], cause: 'network' }] });
    const summary = learning(ctx);
    expect(summary.skipped).not.toBeNull();
    expect(summary.learn).toBeNull();
    const [obs] = withStore((s) => s.observations({ failureClass: 'environment' }));
    expect(obs).toMatchObject({ run_id: ctx.run.id, state: 'BLOCKED', failure_class: 'environment', checks: [{ check_id: 'unit', signature: 'dns-failure, registry-unreachable' }] });
    expect(summary.observed).toBe(obs!.id);
    // Settling the same run again stores nothing twice.
    await end(ctx, 'BLOCKED', 'environment', { environment_failures: [{ check_id: 'unit', signals: ['dns-failure'] }] });
    expect(withStore((s) => s.observations())).toHaveLength(1);
  });

  it.each([
    ['EXHAUSTED', 'budget'],
    ['BLOCKED', 'check-misconfigured'],
    ['BLOCKED', 'review-dispute'],
  ] as const)('a run that ends %s with class %s keeps its failing check and fingerprint', async (state, cls) => {
    lab = makeUnitLab({ tweak: (c) => void (c.knowledge.enabled = true) });
    const ctx = lab.ctx();
    attempt(ctx, 'wrk-1', 1, { status: 'FAILED', fingerprint: 'fp-unit' });
    await end(ctx, state, cls);
    expect(withStore((s) => s.observations({ failureClass: cls }))).toMatchObject([{ state, failure_class: cls, checks: [{ check_id: 'unit', signature: 'fp-unit' }] }]);
  });

  it('a run that succeeded leaves no run-end observation', async () => {
    lab = makeUnitLab({ tweak: (c) => void (c.knowledge.enabled = true) });
    await end(lab.ctx(), 'SUCCEEDED');
    expect(withStore((s) => s.observations())).toEqual([]);
  });
});

describe('overlays with lessons out of prompts', () => {
  it('an active overlay is not judged by live runs that never carried it', async () => {
    lab = makeUnitLab({ tweak: (c) => void (c.knowledge.enabled = true) });
    const overlay = withStore((s) => {
      const lesson = s.upsertLesson(makeLesson({ status: 'validated', evidence: [ev('r1'), ev('r2')], applicability: { roles: ['implementer'] } })).lesson;
      const o = startEvaluation(s, createCandidateOverlay(s, distillOverlay('implementer', [{ lesson, stats: s.stats(lesson.id) }]), 'repo').id);
      return completeEvaluation(s, o.id, { cases: 4, suite_id: 's', baseline: { verified_pass_rate: 0.5, mean_attempts: 1, mean_cost_usd: 1, false_pass_rate: 0 }, candidate: { verified_pass_rate: 1, mean_attempts: 1, mean_cost_usd: 1, false_pass_rate: 0 } }).overlay;
    });
    lab.clock.advance(1_000);
    // Five settled runs that all failed: with the overlay in prompts this would roll it back.
    for (let i = 0; i < 5; i++) await end(nextRun(`orb-f${i}`), 'EXHAUSTED', 'budget');
    const ctx = nextRun('orb-last');
    await end(ctx, 'EXHAUSTED', 'budget');
    expect(learning(ctx).overlays).toMatchObject({ live: [] });
    expect(withStore((s) => s.getOverlay(overlay.id)!.status)).toBe('active');
  });
});
