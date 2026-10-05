import { describe, expect, it } from 'vitest';
import { renderUiFailureBrief, uiFailureBrief } from '../../../src/ui/brief.ts';
import { parseA11y, parseKeyboard } from '../../../src/ui/report.ts';
import { a11yFailOn } from '../../../src/ui/runner.ts';
import { journeyResult, runResult } from './builders.ts';

const body = (o: unknown): Buffer => Buffer.from(JSON.stringify(o));

describe('parseKeyboard (the orbit-keyboard attachment)', () => {
  const good = { url: '/reports', viewport: '390x844', tabsPressed: 2, ordered: true, entries: [{ selector: '#a', reachedAtTab: 1, focusVisible: true }, { selector: '#b', reachedAtTab: null, focusVisible: null }], unreachable: ['#b'], outOfOrder: [], missingFocusRing: [], passed: false };

  it('reads entries and the problems found', () => {
    const scan = parseKeyboard(body(good))!;
    expect(scan.entries).toEqual(good.entries);
    expect(scan.unreachable).toEqual(['#b']);
    expect(scan.passed).toBe(false);
  });
  it('does not believe passed:true next to listed problems', () => {
    expect(parseKeyboard(body({ ...good, passed: true }))!.passed).toBe(false);
    expect(parseKeyboard(body({ ...good, passed: true, unreachable: [] }))!.passed).toBe(true);
  });
  it('rejects non-objects and drops malformed entries', () => {
    expect(parseKeyboard(Buffer.from('[]'))).toBeNull();
    expect(parseKeyboard(Buffer.from('not json'))).toBeNull();
    expect(parseKeyboard(body({ entries: [1, { selector: 5 }, { selector: '#ok' }] }))!.entries).toEqual([{ selector: '#ok', reachedAtTab: null, focusVisible: null }]);
  });
  it('redacts and bounds selectors', () => {
    const scan = parseKeyboard(body({ ...good, unreachable: ['x'.repeat(1_000)] }))!;
    expect(scan.unreachable[0]!.length).toBeLessThan(400);
  });
});

describe('accessibility advisory scans (G35)', () => {
  it('parseA11y carries the advisory flag and defaults to false', () => {
    expect(parseA11y(body({ url: '/r', advisory: true }))!.advisory).toBe(true);
    expect(parseA11y(body({ url: '/r' }))!.advisory).toBe(false);
  });
  it('a11yFailOn maps the config flag to the value the fixture reads', () => {
    expect(a11yFailOn({ accessibility: { enabled: true, fail_on_new_serious_or_critical: true } })).toBe('serious,critical');
    expect(a11yFailOn({ accessibility: { enabled: true, fail_on_new_serious_or_critical: false } })).toBe('none');
  });
  it('an advisory violation is not part of the failure brief', () => {
    const entry = { ruleId: 'select-name', impact: 'critical', target: '#s', url: '/r', viewport: '1x1', help: 'h', fingerprint: 'f' };
    const scan = { url: '/r', viewport: '1x1', baselinePath: null, baselineLoaded: false, seriousOrCritical: 1, newViolations: [entry], baselinedCount: 0, advisory: true };
    const failing = journeyResult({ status: 'FAILED', a11y: [scan] });
    expect(uiFailureBrief(runResult({ verdict: 'FAIL', passed: false, journeys: [failing] })).failures[0]?.newAccessibilityViolations).toEqual([]);
    const blocking = journeyResult({ status: 'FAILED', a11y: [{ ...scan, advisory: false }] });
    expect(uiFailureBrief(runResult({ verdict: 'FAIL', passed: false, journeys: [blocking] })).failures[0]?.newAccessibilityViolations).toHaveLength(1);
  });
});

describe('keyboard problems in the failure brief', () => {
  it('lists unreachable, out-of-order and unfocused elements', () => {
    const k = { url: '/reports', viewport: '1440x900', tabsPressed: 3, ordered: true, entries: [], unreachable: ['#gone'], outOfOrder: ['#export'], missingFocusRing: ['#status'], passed: false };
    const j = journeyResult({ status: 'FAILED', keyboard: [k, { ...k, passed: true, unreachable: [] }] });
    const brief = uiFailureBrief(runResult({ verdict: 'FAIL', passed: false, journeys: [j] }));
    expect(brief.failures[0]?.keyboardProblems).toHaveLength(1);
    const md = renderUiFailureBrief(brief);
    expect(md).toContain('not reachable: #gone');
    expect(md).toContain('focused out of order: #export');
    expect(md).toContain('no visible focus indicator: #status');
  });
});
