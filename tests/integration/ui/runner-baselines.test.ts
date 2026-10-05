import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { renderUiFailureBrief, uiFailureBrief } from '../../../src/ui/brief.ts';
import { toEvidenceUi } from '../../../src/ui/runner.ts';
import { candidateAt, commitAll, freePort, harness, makeUiRepo, resetTo, runUi, updateBaselines, type UiRepo } from './helpers.ts';

// Scenarios 17 and 18: accessibility fails only on NEW serious violations, and
// a candidate that edits a stored baseline cannot pass on that edit.
let repo: UiRepo;

beforeAll(async () => {
  repo = await makeUiRepo();
}, 120_000);
afterAll(() => repo.cleanup());
beforeEach(() => resetTo(repo));

describe('accessibility baseline', () => {
  it('fails only on the new serious violation; the recorded one stays quiet', async () => {
    const port = await freePort();
    const h = harness(repo, port, { filter: ['a11y.spec.ts'] });
    const r = await runUi(repo, candidateAt(repo.dir, repo.baseSha), h, { name: 'a11y-defect', appEnv: { APP_DEFECT_A11Y: '1' } });

    expect(r.verdict).toBe('FAIL');
    const failed = r.journeys.filter((j) => j.status === 'FAILED');
    expect(failed).toHaveLength(2);
    for (const j of failed) {
      const scan = j.a11y[0]!;
      expect(scan.newViolations.map((v) => v.ruleId)).toEqual(['select-name']);
      expect(scan.newViolations[0]?.impact).toBe('critical');
      // The footer's low contrast is in the baseline: counted, not reported as new.
      expect(scan.baselinedCount).toBe(1);
      expect(scan.baselineLoaded).toBe(true);
      expect(j.error?.message).toContain('select-name');
    }
    const brief = uiFailureBrief(r);
    expect(brief.failures[0]?.newAccessibilityViolations.map((v) => v.ruleId)).toEqual(['select-name']);
    expect(renderUiFailureBrief(brief)).toContain('select-name');
    expect(r.limitations.join(' ')).toMatch(/only part/);
  }, 90_000);

  it('a candidate that records the new violation in the baseline is blocked, not passed', async () => {
    const port = await freePort();
    const h = harness(repo, port, { filter: ['a11y.spec.ts'] });
    const bad = await runUi(repo, candidateAt(repo.dir, repo.baseSha), h, { name: 'a11y-before', appEnv: { APP_DEFECT_A11Y: '1' } });
    const entries = bad.journeys.flatMap((j) => j.a11y.flatMap((s) => s.newViolations));
    expect(entries.length).toBe(2);

    const path = join(repo.dir, 'journeys/a11y-baseline.json');
    const baseline = JSON.parse(readFileSync(path, 'utf8')) as { entries: unknown[] };
    baseline.entries.push(...entries.map((e) => ({ ...e })));
    writeFileSync(path, JSON.stringify(baseline, null, 2));
    const cand = commitAll(repo.dir, 'accept accessibility regression');

    const r = await runUi(repo, cand, h, { name: 'a11y-hidden', appEnv: { APP_DEFECT_A11Y: '1' } });
    // The journeys now pass; the verdict still cannot.
    expect(r.stats.failed).toBe(0);
    expect(r.a11yBaselineChanges).toEqual(['journeys/a11y-baseline.json']);
    expect(r.verdict).toBe('BLOCKED');
    expect(r.passed).toBe(false);
    expect(r.reasons.join(' ')).toContain('a11y-baseline.json');
  }, 120_000);
});

describe('visual baselines (scenario 18)', () => {
  it('a real visual regression fails and the brief carries expected, actual and diff images', async () => {
    const port = await freePort();
    const h = harness(repo, port, { filter: ['visual.spec.ts'] });
    const r = await runUi(repo, candidateAt(repo.dir, repo.baseSha), h, { name: 'visual-regress', appEnv: { APP_DEFECT_VISUAL: '1' } });
    expect(r.verdict).toBe('FAIL');
    expect(r.visualBaselineChanges).toEqual([]);
    const brief = uiFailureBrief(r);
    expect(brief.failures).toHaveLength(2);
    const v = brief.failures[0]!.visual!;
    expect(v.expected).toMatch(/reports\.png$|reports-expected\.png$/);
    expect(v.actual).toMatch(/reports-actual\.png$/);
    expect(v.diff).toMatch(/reports-diff\.png$/);
    // Playwright's own baseline path is copied into evidence, so the comparison survives the checkout.
    expect(v.expected).toContain(r.outDir);
  }, 90_000);

  it('a candidate that re-records the baselines to match the regression is flagged and cannot pass', async () => {
    await updateBaselines(repo.dir, { APP_DEFECT_VISUAL: '1' });
    const cand = commitAll(repo.dir, 'update screenshots');
    const port = await freePort();
    const h = harness(repo, port, { filter: ['visual.spec.ts'] });
    const r = await runUi(repo, cand, h, { name: 'visual-accepted', appEnv: { APP_DEFECT_VISUAL: '1' } });

    // Against the edited baseline the journeys are green: that is exactly the hiding the gate must refuse.
    expect(r.stats.failed).toBe(0);
    expect(r.visualBaselineChanges.sort()).toEqual([`journeys/__screenshots__/desktop/${process.platform}/visual.spec.ts/reports.png`, `journeys/__screenshots__/mobile/${process.platform}/visual.spec.ts/reports.png`]);
    expect(r.verdict).toBe('BLOCKED');
    expect(r.passed).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/baselines changed.*human review/);
    expect(uiFailureBrief(r).baselineChanges.visual).toHaveLength(2);
    expect(renderUiFailureBrief(uiFailureBrief(r))).toContain('cannot make a run pass');
    // EvidenceReport.ui has no BLOCKED value, so the run adds a failing row naming the changed baselines.
    const entries = toEvidenceUi(r);
    expect(entries.some((e) => e.status === 'FAILED' && e.artifacts.some((a) => a.endsWith('visual.spec.ts/reports.png')))).toBe(true);
  }, 120_000);
});
