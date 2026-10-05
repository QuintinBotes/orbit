/**
 * Scripted fake-provider scenarios for the three demo goals (spec section 2).
 *
 * Each scenario replays what a competent worker would do on examples/demo-app:
 * a planner output, one or more implementer steps whose `edits` are applied to
 * the worker's worktree by tests/fakes, a verifier diagnosis where a run needs
 * a repair, and an APPROVE review. `$CANDIDATE` and `$FINGERPRINT` are filled in
 * from the controller's own prompts by the scenario adapter before each task.
 *
 * Edits are replace operations on the example's real files, so a change to the
 * example that these scenarios no longer fit fails loudly instead of silently.
 */

import { ENGINEERING_PRACTICES, type PracticeSelection } from '../../../src/contract/practices.ts';

export interface Edit {
  op: 'write' | 'replace' | 'delete';
  path: string;
  content?: string;
  find?: string;
  replace?: string;
}

export interface Scenario {
  auth: { loggedIn: boolean; authMethod: string; method: string; valid: boolean };
  roles: Record<string, object[]>;
}

export type GoalName = 'simple' | 'difficult' | 'ui';
export const GOAL_NAMES: readonly GoalName[] = ['simple', 'difficult', 'ui'];

export interface DemoExpectation {
  /** Terminal state the run must reach. */
  state: 'SUCCEEDED';
  /** The run must record at least one repair (a failed evidence report, a diagnosis and a second attempt). */
  repair: boolean;
  /** The run must leave a draft pull request on FakeGitHub. */
  draftPr: boolean;
}

export const EXPECTATIONS: Record<GoalName, DemoExpectation> = {
  simple: { state: 'SUCCEEDED', repair: false, draftPr: true },
  difficult: { state: 'SUCCEEDED', repair: true, draftPr: true },
  ui: { state: 'SUCCEEDED', repair: true, draftPr: true },
};

const COMMAND_CHECKS = ['lint', 'unit'];
const ALL_CHECKS = [...COMMAND_CHECKS, 'ui'];

/**
 * The planner's engineering-practice selection (spec section 5) for a demo goal: every practice listed once.
 * UI work always selects accessibility; the others the demo app has no use for are omitted with the reason.
 */
function practices(ui: boolean): PracticeSelection[] {
  const omitted: Record<string, string> = {
    'empty-and-loading-states': 'the demo app renders nothing that loads asynchronously, and an empty result is already covered by an existing test',
    'sensitive-data-handling': 'the demo data is public sample content and the change adds no new field or log line',
    'performance-hotspots': 'the demo app serves a handful of rows, so no request path is a material hotspot',
    'rollback-and-migration': 'the change has no schema or data migration and no deployment action is authorized',
    ...(ui ? {} : { accessibility: 'the change touches server responses only and adds no user interface element' }),
  };
  return ENGINEERING_PRACTICES.map((practice) => {
    const reason = omitted[practice];
    return reason === undefined
      ? { practice, applicable: true, justification: practice === 'accessibility' ? 'the UI journey runs the accessibility scan on the changed page' : 'covered by the criteria, their tests and the existing checks' }
      : { practice, applicable: false, justification: reason };
  });
}

function plan(p: {
  objective: string;
  current: [string, string][];
  criteria: { key: string; statement: string; ui: boolean; proof: string[]; changes: [string, string][] }[];
  files: [string, 'add' | 'modify', string][];
  allowed: string[];
  nonGoals: string[];
  risks?: { risk: string; impact: 'low' | 'medium' | 'high'; mitigation: string }[];
}): object {
  return {
    objective: p.objective,
    current_behavior: p.current.map(([statement, evidence]) => ({ statement, evidence: [evidence] })),
    criteria: p.criteria.map((c) => ({
      key: c.key,
      statement: c.statement,
      mandatory: true,
      ui: c.ui,
      proof: c.proof,
      check_ids: c.ui ? ALL_CHECKS : COMMAND_CHECKS,
      changes: c.changes.map(([path, summary]) => ({ path, summary })),
    })),
    expected_changed_files: p.files.map(([path, change, reason]) => ({ path, change, reason })),
    allowed_paths: p.allowed,
    required_check_ids: p.criteria.some((c) => c.ui) ? ALL_CHECKS : COMMAND_CHECKS,
    non_goals: p.nonGoals,
    risks: p.risks ?? [],
    practices: practices(p.criteria.some((c) => c.ui)),
    assumptions: [],
    unresolved_decisions: [],
    material_topics: [],
  };
}

function implementer(summary: string, paths: [string, 'add' | 'modify', string][], tests: [string, string, 'unit' | 'e2e', string[]][], remaining: string[], edits: Edit[]): object {
  return {
    edits,
    structured: {
      summary,
      changed_paths: paths.map(([path, change, purpose]) => ({ path, change, purpose })),
      tests_added: tests.map(([path, name, kind, criterion_ids]) => ({ path, name, kind, criterion_ids })),
      checks_run: [],
      evidence_refs: [],
      remaining_issues: remaining,
      next_action: { kind: 'request-verification', detail: 'run the trusted checks' },
    },
  };
}

const APPROVE = { structured: { verdict: 'APPROVE', candidate_revision: '$CANDIDATE', findings: [] } };

function diagnosis(p: { evidence: string; hypothesis: string; alternative: string; experiment: string; expected: string; fix: string; preserved: string }): object {
  return {
    structured: {
      repair_brief: {
        fingerprint: '$FINGERPRINT',
        evidence: [p.evidence],
        hypotheses: [{ statement: p.hypothesis, supporting: p.evidence, refuting: null }],
        experiment: p.experiment,
        expected_observation: p.expected,
        scoped_fix: p.fix,
        post_fix_checks: ALL_CHECKS,
        preserved_constraints: [p.preserved],
      },
      fingerprint_comparison: { current: '$FINGERPRINT', previous: [], relation: 'first-occurrence', progress: 'unknown', explanation: 'first failure of this kind' },
      competing_hypotheses: [
        {
          id: 'H1',
          statement: p.hypothesis,
          supporting_evidence: [p.evidence],
          refuting_evidence: [],
          discriminating_experiment: p.experiment,
          expected_if_true: p.expected,
          status: 'leading',
          previously_tested: false,
        },
        {
          id: 'H2',
          statement: p.alternative,
          supporting_evidence: [],
          refuting_evidence: [p.evidence],
          discriminating_experiment: 'Rerun the failing check on the base revision',
          expected_if_true: 'the same failure on the base revision',
          status: 'alternative',
          previously_tested: false,
        },
      ],
      chosen_hypothesis_id: 'H1',
      confidence: 'high',
    },
  };
}

function scenario(roles: Record<string, object[]>): Scenario {
  return { auth: { loggedIn: true, authMethod: 'api_key', method: 'api_key', valid: true }, roles };
}

// ---------------------------------------------------------------------------
// simple: a text change, one attempt, no repair.

const NOT_FOUND_TEXT = 'Page not found. Try /reports.';

function simple(): Scenario {
  return scenario({
    planner: [
      {
        structured: plan({
          objective: `Answer unknown paths with the text "${NOT_FOUND_TEXT}" (still 404, still plain text).`,
          current: [['unknown paths get the plain text body "not found"', 'src/server.ts:28']],
          criteria: [
            {
              key: 'text',
              statement: `A request for an unknown path answers 404 with the plain text body "${NOT_FOUND_TEXT}".`,
              ui: false,
              proof: ['A unit test asserts the 404 body text'],
              changes: [
                ['src/server.ts', 'new body text'],
                ['tests/unit/server.test.ts', 'assert the text'],
              ],
            },
          ],
          files: [
            ['src/server.ts', 'modify', 'new not-found text'],
            ['tests/unit/server.test.ts', 'modify', 'assert the text'],
          ],
          allowed: ['src/server.ts', 'tests/unit/**'],
          nonGoals: ['Change the status code or content type', 'Touch the reports page'],
        }),
      },
    ],
    implementer: [
      implementer(
        'Changed the 404 body and asserted it in the existing server unit test.',
        [
          ['src/server.ts', 'modify', 'new not-found text'],
          ['tests/unit/server.test.ts', 'modify', 'assert the text'],
        ],
        [['tests/unit/server.test.ts', 'answers 404 for anything else', 'unit', ['AC-1']]],
        [],
        [
          { op: 'replace', path: 'src/server.ts', find: "body: 'not found'", replace: `body: '${NOT_FOUND_TEXT}'` },
          {
            op: 'replace',
            path: 'tests/unit/server.test.ts',
            find: "    assert.equal(handle('/nope', new URLSearchParams()).status, 404);\n",
            replace: `    assert.equal(handle('/nope', new URLSearchParams()).status, 404);\n    assert.equal(handle('/nope', new URLSearchParams()).body, '${NOT_FOUND_TEXT}');\n`,
          },
        ],
      ),
    ],
    reviewer: [APPROVE],
  });
}

// ---------------------------------------------------------------------------
// difficult: attempt 1 fixes the totals but not the unreachable last page; the
// new tests catch it, the verifier diagnoses it, attempt 2 repairs it.

const TOTALS_UNIT_TEST = `import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { queryReports } from '../../src/reports/query.ts';
import { makeReports } from './helpers.ts';

const all = { status: 'all' as const, q: '', page: 1 };

describe('totals across pages', () => {
  it('the total amount covers every filtered record on every page', () => {
    const records = makeReports(25);
    const expected = records.reduce((sum, r) => sum + r.amountCents, 0);
    for (const page of [1, 2, 3]) assert.equal(queryReports(records, { ...all, page }).totalAmountCents, expected);
  });

  it('the total amount follows the filters, not the page', () => {
    const records = makeReports(30);
    const open = records.filter((r) => r.status === 'open');
    assert.equal(queryReports(records, { ...all, status: 'open' }).totalAmountCents, open.reduce((sum, r) => sum + r.amountCents, 0));
  });
});

describe('reaching every record', () => {
  it('a count that is not a multiple of the page size still gets a last, partial page', () => {
    const page = queryReports(makeReports(25), all);
    assert.equal(page.pageCount, 3);
    assert.equal(queryReports(makeReports(25), { ...all, page: 3 }).rows.length, 5);
  });

  it('walking the pages visits every matching record exactly once', () => {
    const records = makeReports(47);
    const seen: string[] = [];
    const { pageCount } = queryReports(records, all);
    for (let page = 1; page <= pageCount; page++) seen.push(...queryReports(records, { ...all, page }).rows.map((r) => r.id));
    assert.deepEqual(seen, records.map((r) => r.id));
  });
});
`;

const PAGE_COUNT_TEST = `import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pageCountFor } from '../../src/reports/query.ts';

describe('pageCountFor', () => {
  it('a trailing partial page counts as a page', () => {
    assert.equal(pageCountFor(47, 10), 5);
    assert.equal(pageCountFor(11, 10), 2);
  });

  it('exact multiples and empty results keep their page counts', () => {
    assert.equal(pageCountFor(20, 10), 2);
    assert.equal(pageCountFor(0, 10), 1);
  });
});
`;

const TOTALS_JOURNEY = `import { expect, test } from './orbit-fixtures.ts';

test('reports-totals-across-pages', async ({ page }) => {
  await page.goto('/reports');
  const totals = await page.locator('#totals').innerText();
  await test.step('The total amount stays the same on the next page', async () => {
    await page.getByRole('link', { name: 'Next' }).click();
    await expect(page.locator('#summary')).toHaveText('Showing 11-20 of 47 reports');
    await expect(page.locator('#totals')).toHaveText(totals);
  });
  await test.step('Every record can be reached', async () => {
    await expect(page.locator('#page-of')).toHaveText('Page 2 of 5');
    for (let n = 3; n <= 5; n++) await page.getByRole('link', { name: 'Next' }).click();
    await expect(page.locator('#summary')).toHaveText('Showing 41-47 of 47 reports');
    await expect(page.locator('#reports-table tbody tr')).toHaveCount(7);
    await expect(page.locator('#totals')).toHaveText(totals);
  });
});
`;

function difficult(): Scenario {
  const files: [string, 'add' | 'modify', string][] = [
    ['src/reports/query.ts', 'modify', 'total over all filtered records; page count rounds up'],
    ['tests/unit/totals.test.ts', 'add', 'regression tests for both problems'],
    ['tests/e2e/totals.spec.ts', 'add', 'journey across pages'],
  ];
  const tests: [string, string, 'unit' | 'e2e', string[]][] = [
    ['tests/unit/totals.test.ts', 'the total amount covers every filtered record on every page', 'unit', ['AC-1']],
    ['tests/unit/totals.test.ts', 'a count that is not a multiple of the page size still gets a last, partial page', 'unit', ['AC-2']],
    ['tests/e2e/totals.spec.ts', 'reports-totals-across-pages', 'e2e', ['AC-1', 'AC-2']],
  ];
  const addTests: Edit[] = [
    { op: 'write', path: 'tests/unit/totals.test.ts', content: TOTALS_UNIT_TEST },
    { op: 'write', path: 'tests/e2e/totals.spec.ts', content: TOTALS_JOURNEY },
  ];
  return scenario({
    planner: [
      {
        structured: plan({
          objective: 'The reports total amount covers every record matching the filters, and every matching record can be reached by paging.',
          current: [
            ['totalAmountCents is summed from the rows of the current page', 'src/reports/query.ts:58'],
            ['the page count is computed with Math.floor, which drops a trailing partial page', 'src/reports/query.ts:43'],
          ],
          criteria: [
            {
              key: 'total',
              statement: 'The total amount equals the sum over all records matching the filters, on every page.',
              ui: true,
              proof: ['Unit test over a multi-page fixture', 'Journey compares the total on page 1 and page 2'],
              changes: [['src/reports/query.ts', 'sum the filtered records, not the page rows']],
            },
            {
              key: 'reach',
              statement: 'Every matching record is reachable by paging, including when the count is not a multiple of the page size.',
              ui: true,
              proof: ['Unit test with 25 and 47 records', 'Journey pages to the last page of 47 records'],
              changes: [['src/reports/query.ts', 'round the page count up']],
            },
          ],
          files,
          allowed: ['src/reports/**', 'tests/**'],
          nonGoals: ['Change the filtering rules', 'Change the page size', 'Reword the page'],
          risks: [{ risk: 'Both problems sit in the same query function and can mask each other', impact: 'medium', mitigation: 'Test each with its own fixture' }],
        }),
      },
    ],
    implementer: [
      // Attempt 1: the obvious fix for the symptom the first report describes. The second problem is left for the tests to expose.
      implementer(
        'Summed the filtered records for the total amount and added tests and a journey for both reports.',
        files,
        tests,
        ['The page count still rounds down; the new reachability tests are expected to show it'],
        [{ op: 'replace', path: 'src/reports/query.ts', find: 'totalAmountCents: sumAmounts(rows)', replace: 'totalAmountCents: sumAmounts(filtered)' }, ...addTests],
      ),
      // Attempt 2: the diagnosed repair.
      implementer(
        'Rounded the page count up so a trailing partial page is reachable, with a direct test of the page count.',
        [
          ['src/reports/query.ts', 'modify', 'page count rounds up'],
          ['tests/unit/page-count.test.ts', 'add', 'regression test for the page count'],
        ],
        [['tests/unit/page-count.test.ts', 'a trailing partial page counts as a page', 'unit', ['AC-2']]],
        [],
        [
          { op: 'replace', path: 'src/reports/query.ts', find: 'Math.floor(total / pageSize)', replace: 'Math.ceil(total / pageSize)' },
          { op: 'write', path: 'tests/unit/page-count.test.ts', content: PAGE_COUNT_TEST },
        ],
      ),
    ],
    verifier: [
      diagnosis({
        evidence: 'tests/unit/totals.test.ts: pageCount was 2 for 25 records, expected 3; the journey stops at "Page 4 of 4" with 47 records',
        hypothesis: 'pageCountFor divides with Math.floor, so the trailing partial page is never counted',
        alternative: 'paginate slices the wrong range for the last page',
        experiment: 'Evaluate pageCountFor(25, 10) and pageCountFor(47, 10) and compare with the expected 3 and 5',
        expected: 'it returns 2 and 4',
        fix: 'Use Math.ceil in pageCountFor in src/reports/query.ts',
        preserved: 'Keep the totals fix and every new test assertion unchanged',
      }),
    ],
    reviewer: [APPROVE],
  });
}

// ---------------------------------------------------------------------------
// ui: CSV export. Attempt 1 exports only the current page; the journey fails in
// the browser; the verifier diagnoses it; attempt 2 exports every match.

const CSV_TS = `import { statusLabel } from './format.ts';
import type { Report } from './types.ts';

/** The CSV columns, in the order the table shows them. */
export const CSV_COLUMNS: readonly { header: string; value: (r: Report) => string }[] = [
  { header: 'ID', value: (r) => r.id },
  { header: 'Title', value: (r) => r.title },
  { header: 'Owner', value: (r) => r.owner },
  { header: 'Status', value: (r) => statusLabel(r.status) },
  { header: 'Amount', value: (r) => (r.amountCents / 100).toFixed(2) },
  { header: 'Created', value: (r) => r.created },
];

/** Quote a value when it holds a comma, a double quote or a line break; double any quote inside it. */
export function escapeCsv(value: string): string {
  return /[",\\r\\n]/.test(value) ? \`"\${value.replaceAll('"', '""')}"\` : value;
}

/** A header row and one row per record, CRLF terminated. */
export function toCsv(records: readonly Report[]): string {
  const rows = [CSV_COLUMNS.map((c) => escapeCsv(c.header)), ...records.map((r) => CSV_COLUMNS.map((c) => escapeCsv(c.value(r))))];
  return rows.map((row) => row.join(',')).join('\\r\\n') + '\\r\\n';
}
`;

const CSV_UNIT_TEST = `import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CSV_COLUMNS, escapeCsv, toCsv } from '../../src/reports/csv.ts';
import { COLUMNS } from '../../src/views/reports-page.ts';
import { makeReports } from './helpers.ts';

describe('escapeCsv', () => {
  it('leaves plain values alone', () => {
    assert.equal(escapeCsv('Quarterly summary'), 'Quarterly summary');
  });

  it('quotes values with a comma, a quote or a line break, doubling quotes', () => {
    assert.equal(escapeCsv('Vendor audit, Q3'), '"Vendor audit, Q3"');
    assert.equal(escapeCsv('Board "offsite" costs'), '"Board ""offsite"" costs"');
    assert.equal(escapeCsv('two\\nlines'), '"two\\nlines"');
  });
});

describe('toCsv', () => {
  it('writes the header in the order the table shows its columns', () => {
    assert.deepEqual(CSV_COLUMNS.map((c) => c.header), [...COLUMNS]);
    assert.equal(toCsv([]).split('\\r\\n')[0], COLUMNS.join(','));
  });

  it('writes one row per record with plain decimal amounts', () => {
    const lines = toCsv(makeReports(2)).split('\\r\\n');
    assert.equal(lines[1], 'R-001,Report 1,Avery,Open,1.00,2026-01-15');
    assert.equal(lines[2], 'R-002,Report 2,Blake,Closed,2.00,2026-01-15');
  });

  it('writes only the header row when there are no records', () => {
    assert.equal(toCsv([]), 'ID,Title,Owner,Status,Amount,Created\\r\\n');
  });

  it('escapes inside a row', () => {
    const [record] = makeReports(1);
    const line = toCsv([{ ...record!, title: 'Board "offsite", costs' }]).split('\\r\\n')[1];
    assert.equal(line, 'R-001,"Board ""offsite"", costs",Avery,Open,1.00,2026-01-15');
  });
});
`;

const CSV_ROUTE_TEST = `import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handle } from '../../src/server.ts';
import { makeReports } from './helpers.ts';

describe('GET /reports.csv', () => {
  it('exports every record matching the filters, beyond the first page', () => {
    const r = handle('/reports.csv', new URLSearchParams('status=open'), makeReports(60));
    assert.equal(r.status, 200);
    assert.match(r.type, /^text\\/csv/);
    assert.equal(String(r.body).trimEnd().split('\\r\\n').length, 1 + 20);
  });

  it('applies the search text and the status together', () => {
    const lines = String(handle('/reports.csv', new URLSearchParams('status=open&q=avery'), makeReports(60)).body).trimEnd().split('\\r\\n');
    assert.equal(lines.length, 1 + 10);
  });

  it('does not name the file on the server, so the page can use the visitor\\'s local date', () => {
    assert.equal(handle('/reports.csv', new URLSearchParams(), makeReports(3)).headers?.['content-disposition'], undefined);
  });
});
`;

const EXPORT_JS = `// Name the download after the visitor's own local date, not the server's or UTC.
(() => {
  const link = document.getElementById('export-csv');
  if (!link) return;
  const pad = (n) => String(n).padStart(2, '0');
  const name = () => {
    const d = new Date();
    return \`reports-\${d.getFullYear()}-\${pad(d.getMonth() + 1)}-\${pad(d.getDate())}.csv\`;
  };
  link.download = name();
  link.addEventListener('click', () => {
    link.download = name();
  });
})();
`;

const EXPORT_JOURNEY = `import { readFileSync } from 'node:fs';
import type { Page, TestInfo } from '@playwright/test';
import { expect, test } from './orbit-fixtures.ts';

// 2026-03-14 20:00 UTC is already 2026-03-15 in Auckland: the file name must use the local date.
test.use({ timezoneId: 'Pacific/Auckland' });

async function exportCsv(page: Page, testInfo: TestInfo): Promise<{ name: string; lines: string[] }> {
  const downloading = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Export CSV' }).click();
  const download = await downloading;
  const saved = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(saved);
  return { name: download.suggestedFilename(), lines: readFileSync(saved, 'utf8').split('\\r\\n').filter((l) => l !== '') };
}

async function applyFilters(page: Page, status: string, search: string): Promise<void> {
  await page.getByLabel('Status').selectOption(status);
  await page.getByLabel('Search').fill(search);
  await page.getByRole('button', { name: 'Apply filters' }).click();
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-03-14T20:00:00Z'));
  await page.goto('/reports');
});

test('reports-export', async ({ page }, testInfo) => {
  await applyFilters(page, 'open', '');
  await expect(page.locator('#summary')).toHaveText('Showing 1-10 of 16 reports');
  const { name, lines } = await exportCsv(page, testInfo);
  await test.step('Named with the local date', () => expect(name).toBe('reports-2026-03-15.csv'));
  await test.step('Visible column order', () => expect(lines[0]).toBe('ID,Title,Owner,Status,Amount,Created'));
  await test.step('Every matching record, not just the page', () => {
    expect(lines).toHaveLength(1 + 16);
    expect(new Set(lines.slice(1).map((l) => l.split(',')[0])).size).toBe(16);
    expect(lines.slice(1).every((l) => l.includes(',Open,'))).toBe(true);
  });
});

test('reports-export-escaping', async ({ page }, testInfo) => {
  await applyFilters(page, 'all', 'Board');
  const board = await exportCsv(page, testInfo);
  expect(board.lines[1]).toContain('"Board ""offsite"" costs"');
  await applyFilters(page, 'all', 'Vendor audit');
  const vendor = await exportCsv(page, testInfo);
  expect(vendor.lines[1]).toContain('"Vendor audit, Q3"');
});

test('reports-export-empty', async ({ page }, testInfo) => {
  await applyFilters(page, 'all', 'no such report');
  await expect(page.locator('#empty')).toBeVisible();
  const { lines } = await exportCsv(page, testInfo);
  expect(lines).toEqual(['ID,Title,Owner,Status,Amount,Created']);
});
`;

function ui(): Scenario {
  const files: [string, 'add' | 'modify', string][] = [
    ['src/reports/csv.ts', 'add', 'CSV serialisation and escaping'],
    ['src/server.ts', 'modify', 'GET /reports.csv and the export script'],
    ['src/views/reports-page.ts', 'modify', 'Export CSV link'],
    ['src/views/layout.ts', 'modify', 'load the export script'],
    ['src/public/export.js', 'add', 'local-date file name'],
    ['tests/unit/csv.test.ts', 'add', 'escaping, column order and empty results'],
    ['tests/e2e/export.spec.ts', 'add', 'export journeys'],
  ];
  const attempt1Edits: Edit[] = [
    { op: 'write', path: 'src/reports/csv.ts', content: CSV_TS },
    { op: 'write', path: 'src/public/export.js', content: EXPORT_JS },
    { op: 'write', path: 'tests/unit/csv.test.ts', content: CSV_UNIT_TEST },
    { op: 'write', path: 'tests/e2e/export.spec.ts', content: EXPORT_JOURNEY },
    {
      op: 'replace',
      path: 'src/server.ts',
      find: "import { parseQuery, queryReports } from './reports/query.ts';",
      replace: "import { toCsv } from './reports/csv.ts';\nimport { parseQuery, queryReports } from './reports/query.ts';",
    },
    { op: 'replace', path: 'src/server.ts', find: "{ 'styles.css': 'text/css; charset=utf-8' }", replace: "{ 'styles.css': 'text/css; charset=utf-8', 'export.js': 'text/javascript; charset=utf-8' }" },
    {
      op: 'replace',
      path: 'src/server.ts',
      find: '  const asset = /^\\/static',
      replace:
        "  if (pathname === '/reports.csv') {\n    const query = parseQuery(params);\n    // No filename here: the page names the download after the visitor's local date.\n    return { status: 200, type: 'text/csv; charset=utf-8', body: toCsv(queryReports(records, query).rows) };\n  }\n  const asset = /^\\/static",
    },
    {
      op: 'replace',
      path: 'src/views/reports-page.ts',
      find: 'function filterForm(',
      replace:
        "/** A link to the CSV export for the current filters. */\nexport function csvHref(query: Pick<ReportQuery, 'status' | 'q'>): string {\n  const params = new URLSearchParams();\n  if (query.status !== 'all') params.set('status', query.status);\n  if (query.q !== '') params.set('q', query.q);\n  const qs = params.toString();\n  return qs === '' ? '/reports.csv' : `/reports.csv?${qs}`;\n}\n\nfunction filterForm(",
    },
    {
      op: 'replace',
      path: 'src/views/reports-page.ts',
      find: '${filterForm(query)}\n',
      replace: '${filterForm(query)}\n<p id="actions"><a id="export-csv" href="${escapeHtml(csvHref(query))}" download="reports.csv">Export CSV</a></p>\n',
    },
    { op: 'replace', path: 'src/views/layout.ts', find: '</head>', replace: '<script src="/static/export.js" defer></script>\n</head>' },
  ];
  const tests: [string, string, 'unit' | 'e2e', string[]][] = [
    ['tests/unit/csv.test.ts', 'escapeCsv and toCsv', 'unit', ['AC-2', 'AC-4']],
    ['tests/e2e/export.spec.ts', 'reports-export', 'e2e', ['AC-1', 'AC-2', 'AC-3']],
    ['tests/e2e/export.spec.ts', 'reports-export-escaping', 'e2e', ['AC-2']],
    ['tests/e2e/export.spec.ts', 'reports-export-empty', 'e2e', ['AC-4']],
  ];
  return scenario({
    planner: [
      {
        structured: plan({
          objective: 'Add CSV export of the filtered reports with escaping, visible column order and a local-date file name.',
          current: [
            ['the reports page has filters and a pager but no export', 'src/views/reports-page.ts:72'],
            ['the server has no CSV route', 'src/server.ts:22'],
          ],
          criteria: [
            {
              key: 'all',
              statement: 'Export every record matching the current filters, including records beyond the current page.',
              ui: true,
              proof: ['A multi-page filtered journey downloads every matching record'],
              changes: [
                ['src/server.ts', 'GET /reports.csv over the filtered records'],
                ['src/views/reports-page.ts', 'Export CSV link'],
              ],
            },
            {
              key: 'format',
              statement: 'Preserve the visible column order and escape CSV values correctly.',
              ui: true,
              proof: ['Header ordering and escaping unit tests', 'Escaping journey with a comma and a quote'],
              changes: [['src/reports/csv.ts', 'serialise in table column order, quoting as needed']],
            },
            {
              key: 'name',
              statement: "The file is named reports-YYYY-MM-DD.csv using the user's local date.",
              ui: true,
              proof: ['Journey in a non-UTC time zone near midnight UTC'],
              changes: [['src/public/export.js', 'build the download name from the local date']],
            },
            {
              key: 'empty',
              statement: 'An empty result downloads a file with only the header row.',
              ui: true,
              proof: ['Unit test and journey with a filter that matches nothing'],
              changes: [['src/reports/csv.ts', 'header row only']],
            },
          ],
          files,
          allowed: ['src/**', 'tests/**'],
          nonGoals: ['Change report filtering semantics', 'Change the table layout'],
          risks: [{ risk: 'The export link changes the page; the table baseline must stay unchanged', impact: 'low', mitigation: 'Visual baseline covers the table only; run the visual journey' }],
        }),
      },
    ],
    implementer: [
      // Attempt 1: exports the rows on screen. Unit tests pass; the journey does not.
      implementer('Added the CSV serialiser, the /reports.csv route, the Export CSV link, a local-date download name, unit tests and journeys.', files, tests, [], attempt1Edits),
      // Attempt 2: the diagnosed repair, with a regression test at the route.
      implementer(
        'Exported every filtered record instead of the current page, and added a route test.',
        [
          ['src/server.ts', 'modify', 'export the filtered records, not the page'],
          ['tests/unit/csv-route.test.ts', 'add', 'regression test for the route'],
        ],
        [['tests/unit/csv-route.test.ts', 'exports every record matching the filters, beyond the first page', 'unit', ['AC-1']]],
        [],
        [
          { op: 'replace', path: 'src/server.ts', find: "import { parseQuery, queryReports } from './reports/query.ts';", replace: "import { filterReports, parseQuery, queryReports } from './reports/query.ts';" },
          { op: 'replace', path: 'src/server.ts', find: 'toCsv(queryReports(records, query).rows)', replace: 'toCsv(filterReports(records, query))' },
          { op: 'write', path: 'tests/unit/csv-route.test.ts', content: CSV_ROUTE_TEST },
        ],
      ),
    ],
    verifier: [
      diagnosis({
        evidence: 'tests/e2e/export.spec.ts reports-export: downloaded 11 lines (header + 10), expected 17 for 16 open reports; the same on desktop and mobile',
        hypothesis: 'The /reports.csv route serialises queryReports(...).rows, which is only the current page',
        alternative: 'The Export CSV link drops the status filter from its href',
        experiment: 'Request /reports.csv?status=open directly and count the lines',
        expected: 'the response has 11 lines although 16 reports match',
        fix: 'Serialise filterReports(records, query) in the route instead of the page rows',
        preserved: 'Keep the escaping, column order and local-date name unchanged',
      }),
    ],
    reviewer: [APPROVE],
  });
}

export function scenarioFor(goal: GoalName): Scenario {
  return goal === 'simple' ? simple() : goal === 'difficult' ? difficult() : ui();
}
