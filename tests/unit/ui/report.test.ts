import { describe, expect, it } from 'vitest';
import { cleanText, describeError, failedStepPath, parseA11y, parseDiagnostics, parseErrorContext, parsePlaywrightReport, stripAnsi } from '../../../src/ui/report.ts';

const ESC = '\u001b';
const red = (s: string) => `${ESC}[31m${s}${ESC}[39m`;

function report(overrides: Record<string, unknown> = {}, tests: unknown[] = [test()]) {
  return {
    config: { version: '1.63.0', updateSnapshots: 'none', grepInvert: null, shard: null, projects: [{ name: 'desktop' }, { name: 'mobile' }] },
    suites: [{ title: 'reports.spec.ts', file: 'reports.spec.ts', specs: [], suites: [{ title: 'group', specs: [{ title: 'export', file: 'reports.spec.ts', line: 5, tests }] }] }],
    errors: [],
    stats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0 },
    ...overrides,
  };
}
function test(over: Record<string, unknown> = {}) {
  return { projectName: 'desktop', status: 'expected', expectedStatus: 'passed', annotations: [], results: [{ status: 'passed', duration: 12, retry: 0, attachments: [], steps: [] }], ...over };
}

describe('parsePlaywrightReport', () => {
  it('flattens nested suites into titled tests and reads the run settings', () => {
    const p = parsePlaywrightReport(report());
    expect(p).toMatchObject({ playwrightVersion: '1.63.0', updateSnapshots: 'none', projectNames: ['desktop', 'mobile'], grepInvert: false, shard: false });
    // The file-level suite title is the file name and is not part of the journey's title path.
    expect(p.tests[0]).toMatchObject({ titlePath: ['group', 'export'], file: 'reports.spec.ts', projectName: 'desktop', outcome: 'expected' });
  });

  it('flags a config that filters tests and keeps global errors', () => {
    const p = parsePlaywrightReport(report({ config: { version: '1.63.0', updateSnapshots: 'all', grepInvert: {}, shard: { current: 1, total: 2 } }, errors: [{ message: `${red('Error: webServer failed')}` }] }));
    expect(p).toMatchObject({ updateSnapshots: 'all', grepInvert: true, shard: true });
    expect(p.errors).toEqual(['Error: webServer failed']);
  });

  it('rejects a report that is not an object and ignores malformed entries', () => {
    expect(() => parsePlaywrightReport(null)).toThrow(TypeError);
    expect(() => parsePlaywrightReport([])).toThrow(TypeError);
    const p = parsePlaywrightReport({ suites: [null, 7, { specs: [{ title: 'x', tests: [null, { results: [3] }] }] }] });
    expect(p.tests).toHaveLength(1);
    expect(p.tests[0]?.results).toEqual([]);
    expect(p.tests[0]?.projectName).toBe('');
  });

  it('strips ANSI from error text, redacts secrets and bounds long messages', () => {
    const msg = `${red('Error:')} token ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked ${'x'.repeat(5000)}`;
    const p = parsePlaywrightReport(report({}, [test({ status: 'unexpected', results: [{ status: 'failed', duration: 1, retry: 0, error: { message: msg }, attachments: [], steps: [] }] })]));
    const m = p.tests[0]?.results[0]?.error?.message ?? '';
    expect(m).not.toContain(ESC);
    expect(m).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(m.length).toBeLessThan(4200);
    expect(m).toContain('[orbit: truncated');
  });

  it('decodes inline attachments but refuses oversized ones', () => {
    const small = Buffer.from('{"a":1}').toString('base64');
    const huge = 'A'.repeat(3 * 1024 * 1024);
    const p = parsePlaywrightReport(
      report({}, [test({ results: [{ status: 'passed', duration: 1, retry: 0, steps: [], attachments: [{ name: 'a', contentType: 'application/json', body: small }, { name: 'b', contentType: 'text/plain', body: huge }] }] })]),
    );
    const [a, b] = p.tests[0]!.results[0]!.attachments;
    expect(a?.body?.toString()).toBe('{"a":1}');
    expect(b?.body).toBeNull();
  });
});

describe('describeError', () => {
  const base = { snippet: null, location: { file: '/repo/journeys/a.spec.ts', line: 3, column: 9 } };
  it('reads Expected and Received lines', () => {
    const e = describeError({ ...base, message: 'expect(received).toBe(expected)\n\nExpected: "reports-open.csv"\nReceived: "reports.csv"' }, '/repo');
    expect(e).toMatchObject({ expected: '"reports-open.csv"', observed: '"reports.csv"', diff: null, location: { file: 'journeys/a.spec.ts', line: 3 } });
  });
  it('reads typed variants such as "Expected string:" and locator timeouts', () => {
    const e = describeError({ ...base, message: 'expect(locator).toHaveText(expected)\n\nExpected string: "3 reports"\nReceived string: "6 reports"\nTimeout: 5000ms' }, null);
    expect(e).toMatchObject({ expected: '"3 reports"', observed: '"6 reports"' });
  });
  it('keeps a jest-style diff when there is no Expected line', () => {
    const e = describeError({ ...base, message: 'expect(received).toEqual(expected)\n\n- Expected  - 0\n+ Received  + 1\n\n  [\n+   "x",\n  ]' }, null);
    expect(e.expected).toBeNull();
    expect(e.diff).toContain('+   "x"');
  });
  it('has neither for a thrown error', () => {
    const e = describeError({ ...base, message: 'Error: boom' }, null);
    expect(e).toMatchObject({ expected: null, observed: null, diff: null });
  });
});

describe('failedStepPath', () => {
  interface S {
    title: string;
    durationMs: number;
    failed: boolean;
    steps: S[];
  }
  const step = (title: string, failed: boolean, steps: S[] = []): S => ({ title, durationMs: 1, failed, steps });
  it('follows the failing path to the deepest step', () => {
    expect(failedStepPath([step('Open', false), step('Export', true, [step('Click', false), step('Wait for download', true)])])).toBe('Export > Wait for download');
  });
  it('is null when no step failed', () => {
    expect(failedStepPath([step('Open', false)])).toBeNull();
    expect(failedStepPath([])).toBeNull();
  });
});

describe('parseErrorContext', () => {
  const md = [
    '# Instructions',
    '',
    '- Following Playwright test failed.',
    '- Explain why, be concise.',
    '',
    '# Test info',
    '',
    '- Name: x',
    '',
    '# Error details',
    '',
    '```',
    'Error: expect(received).toBe(expected)',
    '```',
    '',
    '# Page snapshot',
    '',
    '```yaml',
    '- main [ref=e2]:',
    '  - heading "Reports" [level=1] [ref=e3]',
    '# not a heading, inside the fence',
    '```',
    '',
    '# Test source',
    '',
  ].join('\n');
  it('keeps the error and the page snapshot and drops the instructions addressed to a model', () => {
    const c = parseErrorContext(md);
    expect(c.errorDetails).toBe('Error: expect(received).toBe(expected)');
    expect(c.pageSnapshot).toContain('heading "Reports"');
    expect(c.pageSnapshot).toContain('# not a heading');
    expect(JSON.stringify(c)).not.toContain('Explain why');
  });
  it('has nulls when sections are absent', () => {
    expect(parseErrorContext('# Instructions\n\nhello')).toEqual({ errorDetails: null, pageSnapshot: null });
  });
});

describe('fixture attachments', () => {
  it('bounds diagnostics lists and redacts their text', () => {
    const body = Buffer.from(JSON.stringify({ consoleErrors: Array.from({ length: 500 }, (_, i) => ({ type: 'error', text: `e${i} sk-ant-api03-abcdefghijklmnopqrstuvwxyz`, url: 'u', line: 1 })), pageErrors: [], failedRequests: [], badResponses: [], finalUrl: 'http://x', dropped: 2 }));
    const d = parseDiagnostics(body)!;
    expect(d.consoleErrors).toHaveLength(200);
    expect(d.consoleErrors[0]?.text).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz');
    expect(d.dropped).toBe(2);
  });
  it('returns null for junk', () => {
    expect(parseDiagnostics(Buffer.from('not json'))).toBeNull();
    expect(parseA11y(Buffer.from('[]'))).toBeNull();
  });
  it('reads an accessibility scan', () => {
    const scan = parseA11y(Buffer.from(JSON.stringify({ url: '/r', viewport: '1x1', baselinePath: '/b.json', baselineLoaded: true, seriousOrCritical: 2, newViolations: [{ ruleId: 'select-name', impact: 'critical', target: '["#s"]', url: '/r', viewport: '1x1', help: 'h', fingerprint: 'f' }], baselined: [{}] })))!;
    expect(scan).toMatchObject({ baselineLoaded: true, baselinedCount: 1, newViolations: [{ ruleId: 'select-name', fingerprint: 'f' }] });
  });
});

describe('text helpers', () => {
  it('stripAnsi removes colour codes only', () => {
    expect(stripAnsi(`${red('a')} b`)).toBe('a b');
  });
  it('cleanText leaves short text alone', () => {
    expect(cleanText('plain')).toBe('plain');
  });
});
