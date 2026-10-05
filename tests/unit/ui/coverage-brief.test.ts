import { describe, expect, it } from 'vitest';
import { journeyBrief, renderUiFailureBrief, uiFailureBrief } from '../../../src/ui/brief.ts';
import type { UiJourneyResult } from '../../../src/ui/types.ts';
import { journeyResult, runResult } from './builders.ts';

const failing = (over: Partial<UiJourneyResult> = {}) => journeyResult({ status: 'FAILED', error: { message: 'boom', location: null, snippet: null, expected: null, observed: null, diff: null }, ...over });
const art = (kind: string, path: string) => ({ name: path.split('/').pop()!, kind: kind as never, contentType: 'x', path, sha256: 'h', bytes: 1 });

describe('journeyBrief on sparse results', () => {
  it('has no viewport, browser, source or message when the journey carries none', () => {
    const b = journeyBrief(journeyResult({ status: 'FAILED', viewport: null, browser: null, error: null }));
    expect(b).toMatchObject({ viewport: null, browser: null, source: null, expected: null, observed: null, diff: null, message: null, visual: null });
    expect(b.evidence).toEqual({ domSnapshot: null, errorDetails: null, consoleErrors: [], pageErrors: [], failedRequests: [], badResponses: [] });
  });

  it('formats every kind of diagnostic and caps each list at ten', () => {
    const diagnostics = {
      consoleErrors: Array.from({ length: 12 }, (_, i) => ({ type: 'error', text: `e${i}`, url: 'http://x', line: i })),
      pageErrors: [{ name: 'TypeError', message: 'x is undefined' }],
      failedRequests: [{ url: 'http://x/api', method: 'GET', failure: 'net::ERR_FAILED' }],
      badResponses: [{ url: 'http://x/api', method: 'POST', status: 503 }],
      finalUrl: null,
      dropped: 0,
    };
    const b = journeyBrief(failing({ diagnostics }));
    expect(b.evidence.consoleErrors).toHaveLength(10);
    expect(b.evidence.consoleErrors[0]).toBe('e0 (http://x:0)');
    expect(b.evidence.pageErrors).toEqual(['TypeError: x is undefined']);
    expect(b.evidence.failedRequests).toEqual(['GET http://x/api: net::ERR_FAILED']);
    expect(b.evidence.badResponses).toEqual(['POST http://x/api -> HTTP 503']);
  });

  it('shows a partial visual comparison and quotes a trace path that needs it', () => {
    const b = journeyBrief(failing({ artifacts: [art('visual-actual', '/out/actual.png'), art('trace', "/out/it's here/trace.zip"), art('trace', '/out/plain/trace.zip')] }));
    expect(b.visual).toEqual({ expected: null, actual: '/out/actual.png', diff: null });
    expect(b.traceViewer).toEqual([`npx playwright show-trace '/out/it'\\''s here/trace.zip'`, 'npx playwright show-trace /out/plain/trace.zip']);
  });

  it('leaves advisory accessibility scans and passing keyboard scans out of the failure', () => {
    const v = { ruleId: 'r', impact: 'serious', target: '#t', url: 'u', viewport: 'v', help: 'h', fingerprint: 'f' };
    const b = journeyBrief(failing({
      a11y: [{ url: 'u', viewport: 'v', baselinePath: null, baselineLoaded: false, seriousOrCritical: 1, newViolations: [v], baselinedCount: 0, advisory: true }, { url: 'u', viewport: 'v', baselinePath: null, baselineLoaded: false, seriousOrCritical: 1, newViolations: [{ ...v, ruleId: 'real' }], baselinedCount: 0, advisory: false }],
      keyboard: [{ url: 'u', viewport: 'v', tabsPressed: 3, ordered: true, entries: [], unreachable: [], outOfOrder: [], missingFocusRing: [], passed: true }],
    }));
    expect(b.newAccessibilityViolations.map((x) => x.ruleId)).toEqual(['real']);
    expect(b.keyboardProblems).toEqual([]);
  });
});

describe('renderUiFailureBrief on every optional part', () => {
  it('names a missing step, states only what is known, and shows partial visual comparisons with dashes', () => {
    const j = failing({
      failedStep: null,
      viewport: null,
      browser: null,
      error: { message: 'no assertion text', location: { file: 'journeys/a.spec.ts', line: 7 , column: 1 }, snippet: '  7 | await x', expected: '"a"', observed: null, diff: null },
      artifacts: [art('screenshot', '/out/s.png'), art('visual-diff', '/out/d.png')],
    });
    const md = renderUiFailureBrief(uiFailureBrief(runResult({ verdict: 'FAIL', journeys: [j] })));
    expect(md).toContain('- Project: desktop\n');
    expect(md).toContain('- Failed step: (no named step failed; see the source location)');
    expect(md).toContain('- Source: journeys/a.spec.ts:7');
    expect(md).toContain('- Expected: "a"\n- Observed: (not stated)');
    expect(md).toContain('Source excerpt:');
    expect(md).toContain('- visual comparison: expected -, actual -, diff /out/d.png');
    expect(md).not.toContain('Error message:');
  });

  it('states observed behaviour alone, and prints the error message when neither side is known', () => {
    const observedOnly = renderUiFailureBrief(uiFailureBrief(runResult({ verdict: 'FAIL', journeys: [failing({ error: { message: 'm', location: null, snippet: null, expected: null, observed: '"b"', diff: null } })] })));
    expect(observedOnly).toContain('- Expected: (not stated)\n- Observed: "b"');
    const neither = renderUiFailureBrief(uiFailureBrief(runResult({ verdict: 'FAIL', journeys: [failing()] })));
    expect(neither).toContain('Error message:');
    expect(neither).not.toContain('- Expected:');
  });

  it('lists accessibility violations, keyboard problems, DOM evidence, logs, traces, changed baselines and unverified text', () => {
    const v = { ruleId: 'color-contrast', impact: 'serious', target: '#a', url: 'u', viewport: 'v', help: 'Elements must have sufficient contrast', fingerprint: 'f' };
    const j = failing({
      project: 'mobile',
      viewport: { width: 390, height: 844 },
      browser: { name: 'chromium', version: '1' },
      a11y: [{ url: 'u', viewport: 'v', baselinePath: null, baselineLoaded: false, seriousOrCritical: 1, newViolations: [v], baselinedCount: 0, advisory: false }],
      keyboard: [{ url: 'http://app/', viewport: '390x844', tabsPressed: 5, ordered: false, entries: [], unreachable: ['#hidden'], outOfOrder: ['#b'], missingFocusRing: ['#c'], passed: false }],
      errorContext: { errorDetails: 'details', pageSnapshot: '- button "Export"' },
      diagnostics: { consoleErrors: [{ type: 'error', text: 'c', url: 'u', line: 1 }], pageErrors: [], failedRequests: [], badResponses: [], finalUrl: null, dropped: 0 },
      artifacts: [art('trace', '/out/trace.zip')],
    });
    const md = renderUiFailureBrief(uiFailureBrief(runResult({ verdict: 'BLOCKED', journeys: [j], visualBaselineChanges: ['tests/shots/a.png'], a11yBaselineChanges: ['a11y/b.json'], reasons: ['one reason'], unverified: ['not checked'] })));
    expect(md).toContain('- Project: mobile, viewport 390x844, chromium 1');
    expect(md).toContain('- serious color-contrast at #a: Elements must have sufficient contrast');
    expect(md).toContain('Keyboard navigation problems on http://app/ at 390x844 (5 Tab presses):');
    expect(md).toContain('- not reachable: #hidden');
    expect(md).toContain('- focused out of order: #b');
    expect(md).toContain('- no visible focus indicator: #c');
    expect(md).toContain('DOM evidence');
    expect(md).toContain('Console errors (untrusted):');
    expect(md).not.toContain('Page errors (untrusted):');
    expect(md).toContain('Inspect the trace:');
    expect(md).toContain('- tests/shots/a.png');
    expect(md).toContain('- a11y/b.json');
    expect(md).toContain('## Why this run did not pass');
    expect(md).toContain('## Not verified');
  });

  it('flattens control characters, cuts over-long values and fences text that contains backticks', () => {
    const long = `${'t'.repeat(400)}`;
    const j = failing({ title: 'x', id: `bad\u0007id\nwith newline \`tick\``, project: long });
    const brief = uiFailureBrief(runResult({ verdict: 'FAIL', reasons: ['text with ```` four backticks'], journeys: [j] }));
    const md = renderUiFailureBrief(brief);
    expect(md).toContain("## Journey bad id with newline 'tick'");
    expect(md).toContain(`- Project: ${'t'.repeat(300)}...`);
    expect(md).toContain('`````text\ntext with ```` four backticks\n`````');
  });

  it('prints a run with nothing to report as only its header and limits', () => {
    const md = renderUiFailureBrief(uiFailureBrief(runResult()));
    expect(md.startsWith('# UI failure brief (PASS)')).toBe(true);
    expect(md).toContain('## Limits of this evidence');
    expect(md).not.toContain('## Journey');
    expect(md).not.toContain('## Baselines changed');
  });
});
