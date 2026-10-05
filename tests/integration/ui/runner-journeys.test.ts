import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fingerprintOf, renderUiFailureBrief, uiFailureBrief } from '../../../src/ui/brief.ts';
import { toEvidenceUi } from '../../../src/ui/runner.ts';
import { candidateAt, commitAll, freePort, harness, makeUiRepo, runUi, writeFile, type UiRepo } from './helpers.ts';

// Real fixture app, real Chromium, real git. Scenario 17: a UI defect is
// reproduced, repaired and reverified.
let repo: UiRepo;

beforeAll(async () => {
  repo = await makeUiRepo();
}, 120_000);
afterAll(() => repo.cleanup());

describe('journeys against the fixture application', () => {
  it('passes on a healthy candidate and binds the evidence to it', async () => {
    const port = await freePort();
    const h = harness(repo, port);
    const cand = candidateAt(repo.dir, repo.baseSha);
    const r = await runUi(repo, cand, h, { name: 'pass' });

    expect(r.reasons).toEqual([]);
    expect(r.verdict).toBe('PASS');
    expect(r.passed).toBe(true);
    expect(r.stats).toMatchObject({ passed: 8, failed: 0, skipped: 0 });
    expect(r.journeys.map((j) => j.project).sort()).toEqual(['desktop', 'desktop', 'desktop', 'desktop', 'mobile', 'mobile', 'mobile', 'mobile']);
    // Evidence is bound to the candidate, the browser actually used, both viewports and the configuration.
    expect(r.binding).toMatchObject({ candidateId: cand.id, treeHash: cand.treeHash, commitSha: cand.commitSha, baseUrl: h.baseUrl, playwrightVersion: '1.63.0' });
    expect(r.binding.checkConfigHash).toMatch(/^sha256:/);
    expect(r.binding.policyHash).toMatch(/^sha256:/);
    expect(r.binding.browsers[0]).toMatchObject({ name: 'chromium' });
    expect(r.binding.browsers[0]?.version).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(r.binding.viewports).toEqual(expect.arrayContaining([{ width: 1440, height: 900 }, { width: 390, height: 844 }]));
    expect(r.coverage.missingViewports).toEqual([]);
    expect(r.coverage.missingBrowsers).toEqual([]);
    expect(r.unverified).toEqual([]);
    expect(r.limitations.join(' ')).toMatch(/accessibility/i);
    expect(r.visualBaselineChanges).toEqual([]);
    const a11y = r.journeys.filter((j) => j.title === 'reports-accessibility');
    // The pre-existing low contrast is recorded in the baseline, so it is counted but does not fail.
    expect(a11y.map((j) => j.a11y[0]?.baselinedCount)).toEqual([1, 1]);
    expect(toEvidenceUi(r).every((e) => e.status === 'PASSED')).toBe(true);
    expect(existsSync(join(r.outDir, 'ui-result.json'))).toBe(true);
    // The application was stopped: the port answers nothing.
    await expect(fetch(h.baseUrl)).rejects.toThrow();
  }, 90_000);

  it('reproduces the injected export defect with a full failure brief, then verifies the repair', async () => {
    const port = await freePort();
    const h = harness(repo, port, { filter: ['reports.spec.ts'] });
    const cand = candidateAt(repo.dir, repo.baseSha);
    const bad = await runUi(repo, cand, h, { name: 'export-defect', appEnv: { APP_DEFECT_EXPORT: '1' } });

    expect(bad.verdict).toBe('FAIL');
    expect(bad.passed).toBe(false);
    const failed = bad.journeys.filter((j) => j.status === 'FAILED');
    expect(failed.map((j) => j.title)).toEqual(['reports-export', 'reports-export']);
    // The filter journey in the same file still passes: the failure is localized.
    expect(bad.journeys.filter((j) => j.title === 'reports-filter').every((j) => j.status === 'PASSED')).toBe(true);

    const f = failed.find((j) => j.project === 'desktop')!;
    expect(f.failedStep).toBe('Assert downloaded contents');
    expect(f.error?.diff).toContain('R-101');
    expect(f.error?.location?.file).toBe('journeys/reports.spec.ts');
    const kinds = f.artifacts.map((a) => a.kind);
    expect(kinds).toEqual(expect.arrayContaining(['screenshot', 'trace', 'error-context', 'diagnostics']));
    for (const a of f.artifacts) {
      expect(existsSync(a.path)).toBe(true);
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(f.errorContext?.pageSnapshot).toContain('Export CSV');
    expect(f.viewport).toEqual({ width: 1440, height: 900 });
    expect(bad.journeys.find((j) => j.project === 'mobile' && j.status === 'FAILED')?.viewport).toEqual({ width: 390, height: 844 });

    const brief = uiFailureBrief(bad);
    expect(brief.failures).toHaveLength(2);
    const fb = brief.failures.find((b) => b.project === 'desktop')!;
    expect(fb.screenshots.length).toBeGreaterThan(0);
    expect(fb.traces).toHaveLength(1);
    expect(fb.hypotheses).toEqual([]);
    expect(fb.proposedRepair).toBeNull();
    expect(fb.evidence.domSnapshot).toContain('heading "Reports"');
    // Same underlying failure on both viewports: one fingerprint.
    expect(new Set(brief.failures.map((b) => b.fingerprint)).size).toBe(1);
    const md = renderUiFailureBrief(brief);
    expect(md).toContain('Failed step: Assert downloaded contents');
    expect(md).toContain(fb.traces[0]!);
    expect(md).toContain('show-trace');
    expect(md).toContain('--project=desktop');
    expect(md).toMatch(/limited|only part/i);

    // Reproduction: the recorded command, run as written, fails the same way.
    const again = await runUi(repo, cand, harness(repo, port, { filter: ['reports.spec.ts'] }), { name: 'export-defect-2', appEnv: { APP_DEFECT_EXPORT: '1' } });
    expect(again.journeys.filter((j) => j.status === 'FAILED').map(fingerprintOf)).toEqual(failed.map(fingerprintOf));

    // Repair and reverify: a new candidate, the defect gone, the same checks rerun.
    writeFile(repo.dir, 'NOTES.md', 'repaired export filter\n');
    const repaired = commitAll(repo.dir, 'fix export');
    const good = await runUi(repo, repaired, harness(repo, port, { filter: ['reports.spec.ts'] }), { name: 'export-fixed' });
    expect(good.verdict).toBe('PASS');
    expect(good.binding.candidateId).not.toBe(bad.binding.candidateId);
    // Same configuration, so the two runs are comparable.
    expect(good.binding.checkConfigHash).toBe(bad.binding.checkConfigHash);
    expect(readFileSync(join(good.outDir, 'ui-result.json'), 'utf8')).toContain('"verdict": "PASS"');
  }, 150_000);
});
