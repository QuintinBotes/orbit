import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { renderUiFailureBrief, uiFailureBrief } from '../../../src/ui/brief.ts';
import { candidateAt, freePort, harness, makeUiRepo, resetTo, runUi, type UiRepo } from './helpers.ts';

// G32 (keyboard navigation) and G35 (accessibility.fail_on_new_serious_or_critical)
// against the fixture application with real Chromium.
let repo: UiRepo;

beforeAll(async () => {
  repo = await makeUiRepo();
}, 120_000);
afterAll(() => repo.cleanup());
beforeEach(() => resetTo(repo));

describe('keyboard navigation checks (G32)', () => {
  it('passes on the healthy app and records the tab order per viewport', async () => {
    const port = await freePort();
    const h = harness(repo, port, { filter: ['keyboard.spec.ts'] });
    const r = await runUi(repo, candidateAt(repo.dir, repo.baseSha), h, { name: 'kb-pass' });

    expect(r.reasons).toEqual([]);
    expect(r.verdict).toBe('PASS');
    expect(r.binding.keyboard).toEqual({ scans: 2, failed: 0 });
    for (const j of r.journeys) {
      const scan = j.keyboard[0]!;
      expect(scan.passed).toBe(true);
      expect(scan.entries.map((e) => [e.selector, e.reachedAtTab, e.focusVisible])).toEqual([
        ['#status', 1, true],
        ['#export', 2, true],
      ]);
      expect(j.artifacts.map((a) => a.kind)).toContain('keyboard');
    }
  }, 90_000);

  it('fails when a positive tabindex puts the export button ahead of the filter', async () => {
    const port = await freePort();
    const h = harness(repo, port, { filter: ['keyboard.spec.ts'] });
    const r = await runUi(repo, candidateAt(repo.dir, repo.baseSha), h, { name: 'kb-order', appEnv: { APP_DEFECT_TABORDER: '1' } });

    expect(r.verdict).toBe('FAIL');
    expect(r.binding.keyboard).toEqual({ scans: 2, failed: 2 });
    for (const j of r.journeys) {
      expect(j.status).toBe('FAILED');
      const scan = j.keyboard[0]!;
      expect(scan.passed).toBe(false);
      expect(scan.outOfOrder).toEqual(['#export']);
      expect(scan.unreachable).toEqual([]);
      expect(j.error?.message).toContain('focused before an element listed earlier: #export');
    }
    const md = renderUiFailureBrief(uiFailureBrief(r));
    expect(md).toContain('Keyboard navigation problems');
    expect(md).toContain('focused out of order: #export');
  }, 90_000);

  it('fails when the focus indicator is removed', async () => {
    const port = await freePort();
    const h = harness(repo, port, { filter: ['keyboard.spec.ts'] });
    const r = await runUi(repo, candidateAt(repo.dir, repo.baseSha), h, { name: 'kb-ring', appEnv: { APP_DEFECT_FOCUSRING: '1' } });

    expect(r.verdict).toBe('FAIL');
    const scan = r.journeys[0]!.keyboard[0]!;
    expect(scan.missingFocusRing).toEqual(['#status', '#export']);
    expect(scan.outOfOrder).toEqual([]);
  }, 90_000);
});

describe('accessibility.fail_on_new_serious_or_critical (G35)', () => {
  it('true: the new violation fails the journey', async () => {
    const port = await freePort();
    const h = harness(repo, port, { filter: ['a11y.spec.ts'], a11yFailOn: true });
    const r = await runUi(repo, candidateAt(repo.dir, repo.baseSha), h, { name: 'a11y-on', appEnv: { APP_DEFECT_A11Y: '1' } });

    expect(r.verdict).toBe('FAIL');
    expect(r.binding.accessibilityFailOn).toBe('serious,critical');
    expect(r.a11yAdvisory).toEqual([]);
    expect(r.journeys.every((j) => j.a11y[0]?.advisory === false)).toBe(true);
  }, 90_000);

  it('false: the same violation is recorded as advisory and does not fail', async () => {
    const port = await freePort();
    const h = harness(repo, port, { filter: ['a11y.spec.ts'], a11yFailOn: false });
    const r = await runUi(repo, candidateAt(repo.dir, repo.baseSha), h, { name: 'a11y-off', appEnv: { APP_DEFECT_A11Y: '1' } });

    expect(r.reasons).toEqual([]);
    expect(r.verdict).toBe('PASS');
    expect(r.binding.accessibilityFailOn).toBe('none');
    expect(r.journeys.every((j) => j.status === 'PASSED')).toBe(true);
    expect(r.journeys.every((j) => j.a11y[0]?.advisory === true)).toBe(true);
    expect(r.a11yAdvisory.map((v) => v.ruleId)).toEqual(['select-name', 'select-name']);
    // Stated, not implied: the pass carries a note that violations were let through.
    expect(r.unverified.join(' ')).toMatch(/advisory/);
    // An advisory scan is not part of a failure brief.
    expect(uiFailureBrief(r).failures).toEqual([]);
  }, 90_000);
});
