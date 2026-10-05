import { formatAmount, statusLabel } from '../reports/format.ts';
import { STATUSES } from '../reports/query.ts';
import type { ReportPage, ReportQuery } from '../reports/types.ts';
import { escapeHtml } from './html.ts';
import { layout } from './layout.ts';

/** The columns of the table, left to right. */
export const COLUMNS = ['ID', 'Title', 'Owner', 'Status', 'Amount', 'Created'] as const;

/** A link to the reports page that keeps the current filters. */
export function reportsHref(query: Pick<ReportQuery, 'status' | 'q'>, page: number): string {
  const params = new URLSearchParams();
  if (query.status !== 'all') params.set('status', query.status);
  if (query.q !== '') params.set('q', query.q);
  if (page > 1) params.set('page', String(page));
  const qs = params.toString();
  return qs === '' ? '/reports' : `/reports?${qs}`;
}

function filterForm(query: ReportQuery): string {
  const options = (['all', ...STATUSES] as const)
    .map((s) => `<option value="${s}"${s === query.status ? ' selected' : ''}>${s === 'all' ? 'All statuses' : statusLabel(s)}</option>`)
    .join('');
  return `<form id="filters" class="toolbar" method="get" action="/reports" role="search">
  <label for="status">Status</label>
  <select id="status" name="status">${options}</select>
  <label for="q">Search</label>
  <input id="q" name="q" type="search" value="${escapeHtml(query.q)}">
  <button type="submit">Apply filters</button>
</form>`;
}

function table(page: ReportPage): string {
  if (page.total === 0) return '<p id="empty">No reports match your filters.</p>';
  const head = COLUMNS.map((c) => `<th scope="col">${c}</th>`).join('');
  const rows = page.rows
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.id)}</td><td>${escapeHtml(r.title)}</td><td>${escapeHtml(r.owner)}</td><td>${statusLabel(r.status)}</td><td class="num">${formatAmount(r.amountCents)}</td><td>${r.created}</td></tr>`,
    )
    .join('\n');
  return `<table id="reports-table">
<thead><tr>${head}</tr></thead>
<tbody>
${rows}
</tbody>
</table>`;
}

function pager(query: ReportQuery, page: ReportPage): string {
  if (page.total === 0) return '';
  const prev = page.page > 1 ? `<a rel="prev" href="${escapeHtml(reportsHref(query, page.page - 1))}">Previous</a>` : '<span aria-disabled="true">Previous</span>';
  const next = page.page < page.pageCount ? `<a rel="next" href="${escapeHtml(reportsHref(query, page.page + 1))}">Next</a>` : '<span aria-disabled="true">Next</span>';
  return `<nav id="pager" class="pager" aria-label="Pagination">${prev}<span id="page-of">Page ${page.page} of ${page.pageCount}</span>${next}</nav>`;
}

export function renderReportsPage(query: ReportQuery, page: ReportPage): string {
  const first = page.total === 0 ? 0 : (page.page - 1) * page.pageSize + 1;
  const last = first === 0 ? 0 : first + page.rows.length - 1;
  const summary = page.total === 0 ? 'Showing 0 reports' : `Showing ${first}-${last} of ${page.total} reports`;
  const body = `<h1>Reports</h1>
${filterForm(query)}
<p id="summary">${summary}</p>
${table(page)}
<p id="totals">Total amount: ${formatAmount(page.totalAmountCents)}</p>
${pager(query, page)}`;
  return layout('Reports', body);
}
