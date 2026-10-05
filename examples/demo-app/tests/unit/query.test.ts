import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { filterReports, PAGE_SIZE, paginate, parseQuery, queryReports } from '../../src/reports/query.ts';
import { makeReports } from './helpers.ts';

const query = (over: Partial<Parameters<typeof queryReports>[1]> = {}) => ({ status: 'all' as const, q: '', page: 1, ...over });

describe('parseQuery', () => {
  it('defaults to everything on page 1', () => {
    assert.deepEqual(parseQuery(new URLSearchParams()), { status: 'all', q: '', page: 1 });
  });

  it('reads status, search text and page', () => {
    assert.deepEqual(parseQuery(new URLSearchParams('status=open&q=%20audit%20&page=3')), { status: 'open', q: 'audit', page: 3 });
  });

  it('ignores an unknown status and a bad page number', () => {
    assert.deepEqual(parseQuery(new URLSearchParams('status=bogus&page=-2')), { status: 'all', q: '', page: 1 });
    assert.equal(parseQuery(new URLSearchParams('page=abc')).page, 1);
  });
});

describe('filterReports', () => {
  const records = makeReports(9);

  it('filters by status', () => {
    assert.deepEqual(
      filterReports(records, { status: 'closed', q: '' }).map((r) => r.id),
      ['R-002', 'R-005', 'R-008'],
    );
  });

  it('matches the search text against the title and the owner, ignoring case', () => {
    assert.equal(filterReports(records, { status: 'all', q: 'REPORT 3' }).length, 1);
    assert.equal(filterReports(records, { status: 'all', q: 'blake' }).length, 4);
  });

  it('combines the filters', () => {
    assert.deepEqual(
      filterReports(records, { status: 'open', q: 'avery' }).map((r) => r.id),
      ['R-001', 'R-007'],
    );
  });
});

describe('paginate', () => {
  it('slices one page', () => {
    assert.deepEqual(paginate([1, 2, 3, 4, 5], 2, 2), [3, 4]);
    assert.deepEqual(paginate([1, 2, 3, 4, 5], 3, 2), [5]);
  });
});

describe('queryReports', () => {
  it('returns the first page of a longer list', () => {
    const page = queryReports(makeReports(20), query());
    assert.equal(page.rows.length, PAGE_SIZE);
    assert.equal(page.rows[0]?.id, 'R-001');
    assert.equal(page.total, 20);
    assert.equal(page.pageCount, 2);
  });

  it('returns the second page', () => {
    const page = queryReports(makeReports(20), query({ page: 2 }));
    assert.equal(page.page, 2);
    assert.equal(page.rows[0]?.id, 'R-011');
    assert.equal(page.rows.length, 10);
  });

  it('clamps a page past the end to the last page', () => {
    assert.equal(queryReports(makeReports(20), query({ page: 9 })).page, 2);
  });

  it('counts every filtered record, not only the page', () => {
    const page = queryReports(makeReports(30), query({ status: 'open' }));
    assert.equal(page.total, 10);
    assert.equal(page.pageCount, 1);
  });

  it('reports an empty result as one empty page', () => {
    const page = queryReports(makeReports(5), query({ q: 'nothing matches this' }));
    assert.deepEqual([page.rows.length, page.total, page.page, page.pageCount], [0, 0, 1, 1]);
  });

  it('adds up the amounts of a single page', () => {
    const page = queryReports(makeReports(5), query());
    assert.equal(page.totalAmountCents, 100 + 200 + 300 + 400 + 500);
  });
});
