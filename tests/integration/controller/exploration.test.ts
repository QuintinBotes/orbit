// UI exploration from the verifying step (spec section 13; ui/explore.exploreUi): the controller supplies the
// explorer and spec-writing calls as supervised, charged, read-only workers, and a reproduced finding becomes a
// failure of the candidate. The browser part of exploreUi is replaced here by a stand-in that calls both
// callbacks the way exploreUi does; ui/explore's own tests cover reproduction in Playwright.
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { defaultUi } from '../../../src/policy/config.ts';
import { loadRunContext } from '../../../src/controller/context.ts';
import { exploreCandidate, SPEC_OUTPUT_SCHEMA } from '../../../src/controller/exploration.ts';
import type { ExplorationFinding, ExplorationResult, exploreUi } from '../../../src/ui/explore.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { listWorkers } from '../../../src/storage/workers.ts';
import { listFailures } from '../../../src/evidence/store.ts';
import { readText, stepTo, tracker } from '../../fault-injection/helpers.ts';
import { baseScenario, calls, canStripTypes, implementMul, startLabRun, writeScenario } from '../../fault-injection/helpers.ts';

const t = tracker();
afterEach(() => t.cleanup());

const EXPLORER_OUTPUT = {
  observations: ['the calculator page renders'],
  candidate_findings: [{ id: 'F-1', summary: 'The product of 2 and 3 shows 5', steps: ['open /', 'enter 2 and 3', 'press multiply'], expected: '6', observed: '5', severity: 'high', proposed_test: 'multiplying 2 by 3 shows 6' }],
  coverage_notes: 'only the calculator page',
};
const SPEC = { source: "import { test, expect } from '@playwright/test';\ntest('F-1', async ({ page }) => { await page.goto('/'); await expect(page.getByTestId('result')).toHaveText('6'); });\n", notes: 'asserts the product' };

describe.skipIf(!canStripTypes)('controller: UI exploration', () => {
  it('runs the explorer and the spec writer as read-only workers and records a reproduced finding as a failure of the candidate', async () => {
    const l = t.lab({ tweak: (c) => void (c.ui = { ...defaultUi(), ui_paths: ['web/**'], required_when_ui_changes: false, exploration: { enabled: true, max_minutes: 5, budget_usd: 2 } }) });
    writeScenario(l, { ...baseScenario({ implementer: [implementMul('*')] }), roles: { ...(baseScenario({ implementer: [implementMul('*')] }) as { roles: object }).roles, '*': [{ structured: EXPLORER_OUTPUT }, { structured: SPEC }] } });
    const run = startLabRun(l);
    const deps = await stepTo(l, run.id, 'REVIEWING');
    const ctx = loadRunContext(deps, run.id, new AbortController().signal);
    expect(ctx.run.state, ctx.run.outcomeReason ?? '').toBe('REVIEWING');
    const cand = ctx.candidate!;

    let seenSource: string | null = null;
    const standIn: typeof exploreUi = async (o) => {
      const signal = new AbortController().signal;
      const r = await o.explore({ role: 'explorer', baseUrl: o.uiConfig.environment.base_url, viewports: [], browsers: ['chromium'], goal: o.goal ?? '', workUnit: 'Explore the calculator page and report candidate findings.', timeoutMs: 60_000, budgetUsd: 1, signal });
      expect(r.status).toBe('succeeded');
      const finding = (r.output as typeof EXPLORER_OUTPUT).candidate_findings[0]!;
      const spec = await o.authorSpec({ finding: finding as never, baseUrl: o.uiConfig.environment.base_url, viewport: null, fileName: 'F-1.spec.ts', budgetUsd: 1, signal });
      seenSource = spec?.source ?? null;
      const reproduced: ExplorationFinding = { id: 'F-1', summary: finding.summary, steps: finding.steps, expected: finding.expected, observed: finding.observed, severity: 'high', proposedTest: finding.proposed_test, status: 'reproduced', reason: 'the test failed on all 3 runs against the candidate', runs: [], spec: { path: join(o.outDir, 'specs', 'F-1', 'F-1.spec.ts'), sha256: 'x', source: spec!.source }, reproduction: 'npx --no-install playwright test F-1.spec.ts', artifacts: [], countsAsAcceptanceEvidence: false };
      const result: ExplorationResult = { outcome: 'completed', findings: [reproduced], reproduced: [reproduced], unreproduced: [], observations: [], coverageNotes: null, budgetUsd: 2, maxMinutes: 5, costUsd: 0.02, reasons: [], unverified: [], acceptanceEvidence: false, baseUrl: o.uiConfig.environment.base_url, outDir: o.outDir, startedAt: 0, endedAt: 1 };
      return result;
    };
    const outDir = join(ctx.runDir, 'evidence', String(cand.seq), 'ui-exploration');
    const result = await exploreCandidate(ctx, cand, ctx.run.worktreePath!, outDir, { exploreUi: standIn });

    expect(result?.reproduced.map((f) => f.id)).toEqual(['F-1']);
    expect(seenSource).toBe(SPEC.source);
    const explorers = listWorkers(l.db(), { runId: run.id, role: 'explorer' });
    expect(explorers.map((w) => [w.purpose, w.resultStatus])).toEqual([
      [`explore:${cand.id}`, 'succeeded'],
      [`explore-spec:${cand.id}:F-1`, 'succeeded'],
    ]);
    // Both are read-only sessions; the spec writer ran under its own output schema.
    const [explore, spec] = calls(l, '*');
    expect(explore!.argv).toEqual(expect.arrayContaining(['--permission-mode']));
    expect(spec!.argv.join(' ')).toContain(SPEC_OUTPUT_SCHEMA.title);
    // Charged like any worker.
    expect(l.db().all('SELECT worker_id FROM usage WHERE run_id = ? AND worker_id IN (?, ?)', run.id, explorers[0]!.id, explorers[1]!.id)).toHaveLength(2);
    const failure = listFailures(l.db(), run.id).find((f) => f.fingerprint === 'ui-exploration:F-1');
    expect(failure).toMatchObject({ candidateId: cand.id, source: 'check' });
    expect(failure!.excerpt).toContain('reproduce with: npx --no-install playwright test F-1.spec.ts');
    expect(listDecisions(l.db(), run.id, { kind: 'ui.exploration' })[0]?.data).toMatchObject({ outcome: 'completed', reproduced: ['F-1'] });
    expect(readText(join(outDir, 'exploration.md'))).toContain('F-1');

    // Restart-safe: a second pass reuses both finished workers instead of starting new ones.
    await exploreCandidate(loadRunContext(deps, run.id, new AbortController().signal), cand, ctx.run.worktreePath!, outDir, { exploreUi: standIn });
    expect(listWorkers(l.db(), { runId: run.id, role: 'explorer' })).toHaveLength(2);
    expect(calls(l, '*')).toHaveLength(2);
  }, 90_000);

  it('is off unless ui.exploration.enabled', async () => {
    const l = t.lab({ tweak: (c) => void (c.ui = { ...defaultUi(), ui_paths: ['web/**'], required_when_ui_changes: false, exploration: { enabled: false, max_minutes: 5, budget_usd: 2 } }) });
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const run = startLabRun(l);
    const deps = await stepTo(l, run.id, 'REVIEWING');
    const ctx = loadRunContext(deps, run.id, new AbortController().signal);
    const standIn: typeof exploreUi = async () => {
      throw new Error('exploration must not run');
    };
    expect(await exploreCandidate(ctx, ctx.candidate!, ctx.run.worktreePath!, join(ctx.runDir, 'x'), { exploreUi: standIn })).toBeNull();
  }, 90_000);
});
