/**
 * Agent-driven UI exploration from the verifying step (spec section 13;
 * ui/explore.exploreUi). The controller supplies the two model calls the
 * explorer module needs, as ordinary supervised workers of the run (routed,
 * budgeted, charged, restart-safe by purpose):
 *
 *   explore     a read-only `explorer` worker that looks for user-visible
 *               defects and returns candidate findings (its role schema)
 *   authorSpec  a read-only `explorer` worker that writes one Playwright spec
 *               for one candidate, returned as structured output
 *               (SPEC_OUTPUT_SCHEMA); it never edits the repository
 *
 * Only findings whose spec fails on every run count. Each one becomes a
 * failure record for the candidate (source `check`, fingerprint
 * `ui-exploration:<id>`), so verification fails and the diagnosis and repair
 * loop gets the failing spec and its reproduction command. Exploration never
 * counts as acceptance evidence.
 */
import { join } from 'node:path';
import { atomicWrite } from '../core/fsx.ts';
import { renderWorkerPrompt } from '../adapters/prompt.ts';
import type { TaskResult } from '../adapters/types.ts';
import type { CandidateRecord } from '../evidence/store.ts';
import { recordFailure } from '../evidence/store.ts';
import { exploreUi, explorationConfigOf, explorationFollowUps, renderExplorationReport, type ExplorationResult, type ExplorerRun, type SpecResponse } from '../ui/explore.ts';
import type { UiConfig } from '../policy/types.ts';
import { homeOf, toolchainCacheRootFor, type RunContext } from './context.ts';
import { accountWorker, ensureWorker, routeFor, storedResult, type WorkerRequest } from './workers.ts';
import { stopWorker } from '../recovery/reconcile.ts';
import { assertContract, decide, policySummary } from './steps/common.ts';

/** Structured output of the spec-writing call. */
export const SPEC_OUTPUT_SCHEMA = {
  title: 'orbit.exploration-spec',
  type: 'object',
  additionalProperties: false,
  required: ['source', 'notes'],
  properties: {
    source: { type: 'string', description: 'TypeScript source of one Playwright spec that fails while the defect is present' },
    notes: { type: 'string', description: 'What the spec asserts and why it fails on this build' },
  },
} as const;

export function explorationEnabled(ui: UiConfig | null): boolean {
  return ui !== null && explorationConfigOf(ui).enabled;
}

/**
 * Explore the candidate's UI when ui.exploration is enabled. Returns null when it is not. Reproduced findings are
 * recorded as failures of the candidate; everything else is reported, never counted.
 */
export async function exploreCandidate(ctx: RunContext, cand: CandidateRecord, checkoutDir: string, outDir: string, opts: { exploreUi?: typeof exploreUi } = {}): Promise<ExplorationResult | null> {
  const ui = ctx.snapshot.config.ui;
  if (!ui || !explorationEnabled(ui)) return null;
  const contract = assertContract(ctx);
  const route = routeFor(ctx, `explore:${cand.id}`, 'screenshot', { difficulty: (ctx.run.difficulty ?? 'medium') as 'simple' | 'medium' | 'complex', attempt: 1, repeatedFingerprints: 0 });
  const result = await (opts.exploreUi ?? exploreUi)({
    checkoutDir,
    snapshot: ctx.snapshot,
    candidate: cand,
    uiConfig: ui,
    isolation: ctx.isolation(),
    outDir,
    goal: contract.objective,
    clock: ctx.clock,
    hostEnv: ctx.deps.hostEnv ?? process.env,
    homeDir: homeOf(ctx.deps),
    toolchainCacheRoot: toolchainCacheRootFor(ctx),
    abortSignal: ctx.signal,
    explore: async (task): Promise<ExplorerRun> => {
      const r = await runToEnd(ctx, {
        role: 'explorer',
        purpose: `explore:${cand.id}`,
        candidateId: cand.id,
        provider: route.provider,
        model: route.model,
        effort: route.effort,
        cwd: checkoutDir,
        readOnly: true,
        maxBudgetUsd: task.budgetUsd,
        prompt: () =>
          renderWorkerPrompt({
            role: 'explorer',
            task: task.workUnit,
            contract,
            policySummary: policySummary(ctx, { readOnly: true }),
            candidate: { revision: cand.commitSha, treeHash: cand.treeHash, base: ctx.run.baseRevision },
          }),
      }, task.timeoutMs, task.signal);
      if (!r) return { output: null, costUsd: null, status: task.signal.aborted ? 'cancelled' : 'timeout', error: 'the explorer did not finish in time' };
      return { output: r.structured, costUsd: r.usage.costUsd, status: r.status === 'succeeded' ? 'succeeded' : r.status === 'timeout' ? 'timeout' : r.status === 'cancelled' ? 'cancelled' : 'failed', error: r.error };
    },
    authorSpec: async (req): Promise<SpecResponse | null> => {
      const finding = req.finding;
      const text = [
        `Write one Playwright test file (${req.fileName}) in TypeScript that FAILS on this build while the defect below is present and passes once it is fixed.`,
        `Use the configured baseURL (${req.baseUrl}) through page.goto with relative paths; import only from @playwright/test; no other hosts, no waits on fixed timeouts.`,
        `Start from a fresh page load and follow the steps exactly. ${req.viewport ? `Viewport ${req.viewport.width}x${req.viewport.height}.` : ''}`,
        'Return the file source in "source" and one sentence in "notes". Do not edit anything.',
      ].join('\n');
      const r = await runToEnd(ctx, {
        role: 'explorer',
        purpose: `explore-spec:${cand.id}:${finding.id}`,
        candidateId: cand.id,
        provider: route.provider,
        model: route.model,
        effort: route.effort,
        cwd: checkoutDir,
        readOnly: true,
        maxBudgetUsd: req.budgetUsd,
        outputSchema: SPEC_OUTPUT_SCHEMA,
        prompt: () =>
          renderWorkerPrompt({
            role: 'explorer',
            task: text,
            contract,
            policySummary: policySummary(ctx, { readOnly: true }),
            candidate: { revision: cand.commitSha, treeHash: cand.treeHash, base: ctx.run.baseRevision },
            untrusted: [{ label: `candidate finding ${finding.id}`, content: JSON.stringify({ summary: finding.summary, steps: finding.steps, expected: finding.expected, observed: finding.observed, proposed_test: finding.proposed_test }, null, 1) }],
          }),
      }, 10 * 60_000, req.signal);
      if (!r || r.status !== 'succeeded') return null;
      const out = r.structured as { source?: unknown } | null;
      if (!out || typeof out.source !== 'string' || out.source.trim() === '') return null;
      return { source: out.source, costUsd: r.usage.costUsd };
    },
  });
  atomicWrite(join(outDir, 'exploration.md'), renderExplorationReport(result), 0o600);
  for (const f of explorationFollowUps(result)) {
    recordFailure(
      ctx.db,
      { runId: ctx.run.id, candidateId: cand.id, source: 'check', sourceId: `ui-exploration:${cand.id}:${f.id}`, fingerprint: `ui-exploration:${f.id}`, excerpt: `reproduced UI defect ${f.id} (${f.severity}): ${f.summary}; failing spec ${f.specPath}; reproduce with: ${f.reproduction}`.slice(0, 2000) },
      ctx.clock,
    );
  }
  decide(ctx, {
    kind: 'ui.exploration',
    summary: `UI exploration of candidate ${cand.seq}: ${result.outcome}; ${result.reproduced.length} reproduced, ${result.unreproduced.length} not counted`,
    data: { outcome: result.outcome, reproduced: result.reproduced.map((f) => f.id), unreproduced: result.unreproduced.map((f) => ({ id: f.id, status: f.status })), cost_usd: result.costUsd, reasons: result.reasons },
  });
  return result;
}

/** Start or reattach a worker and supervise it until it finishes, the deadline passes or the signal aborts (null). */
async function runToEnd(ctx: RunContext, req: WorkerRequest, timeoutMs: number, signal: AbortSignal): Promise<TaskResult | null> {
  const deadline = ctx.clock.now() + timeoutMs;
  for (;;) {
    if (signal.aborted || ctx.signal.aborted) return null;
    const st = await ensureWorker(ctx, req);
    if (st.status === 'finished') return st.result;
    if (ctx.clock.now() >= deadline) {
      // Out of time: the session is stopped (and charged), not left running beside the rest of the run.
      const stopped = await stopWorker({ db: ctx.db, clock: ctx.clock, ownerId: ctx.ownerId, adapters: ctx.deps.adapters, graceMs: ctx.timing.killGraceMs }, st.worker, `${req.purpose} exceeded its ${Math.round(timeoutMs / 1000)} s allowance`);
      accountWorker(ctx, stopped, storedResult(stopped));
      return null;
    }
    await new Promise((r) => setTimeout(r, Math.max(50, ctx.timing.checkPollMs)));
  }
}

export function explorationUnverified(result: ExplorationResult): string[] {
  const notes = [...result.unverified];
  if (result.outcome !== 'completed') notes.push(`UI exploration ${result.outcome}: ${result.reasons.join('; ') || 'no detail'}`);
  if (result.unreproduced.length > 0) notes.push(`${result.unreproduced.length} UI exploration candidate(s) did not reproduce as failing tests and do not count`);
  return notes;
}
