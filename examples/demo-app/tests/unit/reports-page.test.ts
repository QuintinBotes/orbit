import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { queryReports } from '../../src/reports/query.ts';
import { renderReportsPage, reportsHref } from '../../src/views/reports-page.ts';
import { makeReports } from './helpers.ts';

const all = { status: 'all', q: '', page: 1 } as const;

describe('reportsHref', () => {
  it('omits default values', () => {
    assert.equal(reportsHref(all, 1), '/reports');
    assert.equal(reportsHref({ status: 'open', q: 'a b' }, 2), '/reports?status=open&q=a+b&page=2');
  });
});

describe('renderReportsPage', () => {
  it('shows the table, the summary and the pager', () => {
    const html = renderReportsPage(all, queryReports(makeReports(20), all));
    assert.match(html, /<h1>Reports<\/h1>/);
    assert.equal(html.match(/<tr><td>/g)?.length, 10);
    assert.match(html, /Showing 1-10 of 20 reports/);
    assert.match(html, /Page 1 of 2/);
    assert.match(html, /rel="next" href="\/reports\?page=2"/);
  });

  it('keeps the filters in the pager links', () => {
    const q = { status: 'open', q: '', page: 1 } as const;
    const html = renderReportsPage(q, queryReports(makeReports(60), q));
    assert.match(html, /href="\/reports\?status=open&amp;page=2"/);
  });

  it('shows a message instead of a table when nothing matches', () => {
    const q = { status: 'all', q: 'zzz', page: 1 } as const;
    const html = renderReportsPage(q, queryReports(makeReports(5), q));
    assert.match(html, /No reports match your filters\./);
    assert.doesNotMatch(html, /<table/);
  });

  it('escapes record text', () => {
    const records = makeReports(1);
    records[0]!.title = '<script>alert(1)</script>';
    const html = renderReportsPage(all, queryReports(records, all));
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;/);
  });
});
