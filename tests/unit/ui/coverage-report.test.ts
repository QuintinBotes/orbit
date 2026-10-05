import { describe, expect, it } from 'vitest';
import { describeError, failedStepPath, parseA11y, parseBrowserInfo, parseDiagnostics, parseErrorContext, parseKeyboard, parsePlaywrightReport, relativeTo, summarizeSteps, type RawStep } from '../../../src/ui/report.ts';

const json = (v: unknown) => Buffer.from(JSON.stringify(v));
const spec = (tests: unknown[], over: Record<string, unknown> = {}) => ({ title: 's', file: 'a.spec.ts', line: 1, tests, ...over });
const reportOf = (suites: unknown[], config: Record<string, unknown> = {}) => parsePlaywrightReport({ config, suites });

describe('run narrowing signals', () => {
  it('reads selection flags from the command line and from each project, once each', () => {
    const p = parsePlaywrightReport({
      config: {
        grepInvert: 'slow',
        argv: ['playwright', 'test', '--grep=checkout', '-g', 7, '--shard=1/2', '--workers=2', '--grep=checkout'],
        projects: [{ name: 'a', testIgnore: ['**/skip/**'] }, { name: 'b', testIgnore: [] }, { name: 'c', testIgnore: '*.slow.ts' }, { name: 'd', testIgnore: '' }, { testIgnore: ['x'] }, 'not a project', null],
      },
    });
    expect(p.selection).toEqual([
      'grepInvert is set',
      'the command line carries --grep=checkout',
      'the command line carries -g',
      'the command line carries --shard=1/2',
      'project a sets testIgnore',
      'project c sets testIgnore',
      'project ? sets testIgnore',
    ]);
    expect(p.projectNames).toEqual(['a', 'b', 'c', 'd']);
  });

  it('has no selection, version or settings for a bare report', () => {
    expect(parsePlaywrightReport({})).toMatchObject({ playwrightVersion: null, updateSnapshots: null, grepInvert: false, shard: false, projectNames: [], selection: [], errors: [], tests: [], stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 0 } });
  });
});

describe('global errors and statistics', () => {
  it('keeps the message, else the stack, else a stand-in, and the text of anything that is not an object', () => {
    const p = parsePlaywrightReport({ errors: [{ message: 'boom' }, { stack: 'at x' }, {}, 'plain failure', 42], stats: { expected: 2, unexpected: Number.NaN, flaky: '1', skipped: 3 } });
    expect(p.errors).toEqual(['boom', 'at x', 'unknown error', 'plain failure', '42']);
    expect(p.stats).toEqual({ expected: 2, unexpected: 0, flaky: 0, skipped: 3 });
  });
});

describe('walking suites, specs and tests', () => {
  it('names an untitled spec, takes the file from the suite when the spec has none, and falls back from project name to id', () => {
    const p = reportOf([{ title: 'f.spec.ts', file: 'suite-file.ts', specs: [{ tests: [{ projectId: 'mobile', annotations: [{ type: 'slow' }, { description: 'no type' }, 'x'], results: [] }] }], suites: [{ title: '', specs: [spec([{ status: 'flaky', expectedStatus: 'failed', results: [] }], { title: 'inner', file: null })] }] }]);
    expect(p.tests[0]).toMatchObject({ titlePath: ['(untitled)'], file: 'suite-file.ts', projectName: 'mobile', outcome: 'unknown', expectedStatus: 'passed', annotations: ['slow'], line: 0 });
    // A suite with an empty title adds nothing to the path.
    expect(p.tests[1]).toMatchObject({ titlePath: ['inner'], outcome: 'flaky', expectedStatus: 'failed', projectName: '' });
  });

  it('skips specs and suites that are not objects', () => {
    const p = reportOf([{ specs: [null, 'x'], suites: [null, 3, { title: 'g', specs: [spec([{ results: [] }])] }] }]);
    expect(p.tests.map((t) => t.titlePath)).toEqual([['g', 's']]);
  });
});

describe('results, steps and attachments', () => {
  const result = (over: Record<string, unknown>) => reportOf([{ specs: [spec([{ results: [over] }])] }]).tests[0]!.results[0]!;

  it('defaults a result with no status, and reads an error that has only a stack, an empty snippet or no location', () => {
    expect(result({})).toMatchObject({ status: 'unknown', durationMs: 0, retry: 0, error: null, steps: [], attachments: [] });
    expect(result({ error: { stack: 'at somewhere' } }).error).toEqual({ message: 'at somewhere', snippet: null, location: null });
    expect(result({ error: {} }).error!.message).toBe('unknown error');
    expect(result({ error: { message: 'm', snippet: '  1 | a', location: { line: 3 } } }).error).toMatchObject({ snippet: '  1 | a', location: null });
    expect(result({ error: { message: 'm', location: { file: 'a.ts' } } }).error!.location).toEqual({ file: 'a.ts', line: 0, column: 0 });
  });

  it('cuts nested steps at depth four, skips steps that are not objects, and marks a step with an error as failed', () => {
    let deep: Record<string, unknown> = { title: 'level 5' };
    for (let i = 4; i >= 0; i--) deep = { title: `level ${i}`, error: i === 2 ? {} : undefined, steps: [deep, null] };
    const r = result({ steps: [deep, 'nope'] });
    const walk = (s: RawStep): number => 1 + (s.steps.length ? Math.max(...s.steps.map(walk)) : 0);
    expect(r.steps).toHaveLength(1);
    expect(walk(r.steps[0]!)).toBe(5);
    expect(r.steps[0]!.steps[0]!.steps[0]!.failed).toBe(true);
    expect(result({ steps: [{}] }).steps[0]!.title).toBe('');
  });

  it('skips an attachment without a name, defaults its content type, and decodes a body that is within bounds', () => {
    const atts = result({ attachments: [{ contentType: 'text/plain' }, { name: 'shot', path: '/tmp/s.png' }, { name: 'note', contentType: 'text/plain', body: Buffer.from('hi').toString('base64') }, 'x'] }).attachments;
    expect(atts.map((a) => [a.name, a.contentType, a.path, a.body?.toString() ?? null])).toEqual([['shot', 'application/octet-stream', '/tmp/s.png', null], ['note', 'text/plain', null, 'hi']]);
  });
});

describe('steps and error descriptions', () => {
  const step = (title: string, failed: boolean, steps: RawStep[] = []): RawStep => ({ title, durationMs: 1.6, failed, steps });

  it('rounds durations, and has no path for failing steps without titles', () => {
    expect(summarizeSteps([step('a', false), step('b', true)])).toEqual([{ title: 'a', status: 'passed', durationMs: 2 }, { title: 'b', status: 'failed', durationMs: 2 }]);
    expect(failedStepPath([step('', true, [step('', true)])])).toBeNull();
    expect(failedStepPath([step('a', true, [step('', true), step('x', false)])])).toBe('a');
  });

  it('relativeTo handles roots with and without a trailing slash, other roots and no root', () => {
    expect(relativeTo('/repo/a.ts', '/repo/')).toBe('a.ts');
    expect(relativeTo('/repo/a.ts', '/repo')).toBe('a.ts');
    expect(relativeTo('/other/a.ts', '/repo')).toBe('/other/a.ts');
    expect(relativeTo('/repo/a.ts', null)).toBe('/repo/a.ts');
  });

  it('describeError has no location when the error has none, and no diff when the message does not start one', () => {
    const e = describeError({ message: 'something threw', snippet: null, location: null }, '/repo');
    expect(e).toEqual({ message: 'something threw', location: null, snippet: null, expected: null, observed: null, diff: null });
    expect(describeError({ message: '+ Received  + 1\n  [\n+ "x"\n]', snippet: null, location: null }, null).diff).toBeNull();
  });
});

describe('error-context.md', () => {
  it('takes a section without a code fence as it is, and ignores headings inside fences', () => {
    const md = ['# Instructions', 'do this', '# Error details', 'plain text details', '# Page snapshot', '```yaml', '# not a heading', '- button', '```'].join('\n');
    const out = parseErrorContext(md);
    expect(out.errorDetails).toBe('plain text details');
    expect(out.pageSnapshot).toBe('# not a heading\n- button');
  });
});

describe('fixture attachments', () => {
  it('diagnostics: defaults missing fields and drops entries that are not objects', () => {
    const d = parseDiagnostics(json({ consoleErrors: [{}, 5, { type: 'warning', text: 'w', url: 'u', line: 3 }], pageErrors: [{}, { name: 'TypeError', message: 'm' }], failedRequests: [{}], badResponses: [{}, { url: 'u', method: 'POST', status: 500 }], finalUrl: 7 }));
    expect(d).toEqual({
      consoleErrors: [{ type: 'error', text: '', url: '', line: 0 }, { type: 'warning', text: 'w', url: 'u', line: 3 }],
      pageErrors: [{ name: 'Error', message: '' }, { name: 'TypeError', message: 'm' }],
      failedRequests: [{ url: '', method: 'GET', failure: 'unknown' }],
      badResponses: [{ url: '', method: 'GET', status: 0 }, { url: 'u', method: 'POST', status: 500 }],
      finalUrl: null,
      dropped: 0,
    });
    expect(parseDiagnostics(Buffer.from('not json'))).toBeNull();
    expect(parseDiagnostics(json([1]))).toBeNull();
  });

  it('browser info: needs a name and a version, and takes a viewport only when it is numeric', () => {
    expect(parseBrowserInfo(json({ browserName: 'chromium' }))).toBeNull();
    expect(parseBrowserInfo(json({ browserVersion: '1' }))).toBeNull();
    expect(parseBrowserInfo(Buffer.from('x'))).toBeNull();
    expect(parseBrowserInfo(json({ browserName: 'chromium', browserVersion: '126', viewport: { width: 1280, height: '720' }, project: 'desktop' }))).toEqual({ name: 'chromium', version: '126', viewport: null, project: 'desktop' });
    expect(parseBrowserInfo(json({ browserName: 'chromium', browserVersion: '126', viewport: { width: 1280, height: 720 } }))).toEqual({ name: 'chromium', version: '126', viewport: { width: 1280, height: 720 }, project: null });
  });

  it('accessibility scan: fills defaults, skips entries that are not objects and counts the baselined ones', () => {
    const a = parseA11y(json({ newViolations: [{}, 'x', { ruleId: 'color-contrast', impact: 'serious', target: '#a', url: 'u', viewport: '1x1', help: 'h', fingerprint: 'f' }], baselined: [1, 2], advisory: true, baselineLoaded: true, baselinePath: 'b.json', seriousOrCritical: 2 }));
    expect(a).toMatchObject({ url: '', viewport: '', baselinePath: 'b.json', baselineLoaded: true, seriousOrCritical: 2, baselinedCount: 2, advisory: true });
    expect(a!.newViolations).toEqual([{ ruleId: '', impact: '', target: '', url: '', viewport: '', help: '', fingerprint: '' }, { ruleId: 'color-contrast', impact: 'serious', target: '#a', url: 'u', viewport: '1x1', help: 'h', fingerprint: 'f' }]);
    expect(parseA11y(Buffer.from('['))).toBeNull();
  });

  it('keyboard scan: keeps well-formed entries, recomputes passed, and treats a missing ordered flag as ordered', () => {
    const k = parseKeyboard(json({ passed: true, entries: [{ selector: '#a', reachedAtTab: 1, focusVisible: true }, { selector: '#b', reachedAtTab: 'x', focusVisible: 'y' }, { selector: 5 }, 'x'], unreachable: ['#c', 7], tabsPressed: 4 }));
    expect(k).toMatchObject({ url: '', viewport: '', tabsPressed: 4, ordered: true, passed: false, unreachable: ['#c'], outOfOrder: [], missingFocusRing: [] });
    expect(k!.entries).toEqual([{ selector: '#a', reachedAtTab: 1, focusVisible: true }, { selector: '#b', reachedAtTab: null, focusVisible: null }]);
    expect(parseKeyboard(json({ passed: true, ordered: false }))).toMatchObject({ ordered: false, passed: true });
    expect(parseKeyboard(json({ passed: 'yes' }))!.passed).toBe(false);
    expect(parseKeyboard(Buffer.from('x'))).toBeNull();
  });
});
