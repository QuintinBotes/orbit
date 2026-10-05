import type { Report, ReportPage, ReportQuery, Status, StatusFilter } from './types.ts';

export const PAGE_SIZE = 10;
export const STATUSES: readonly Status[] = ['open', 'closed', 'draft'];

function toStatusFilter(value: string | null): StatusFilter {
  return (STATUSES as readonly string[]).includes(value ?? '') ? (value as Status) : 'all';
}

/** Read the query string the way the page writes it. Unknown values fall back to the defaults. */
export function parseQuery(params: URLSearchParams): ReportQuery {
  const page = Number.parseInt(params.get('page') ?? '1', 10);
  return {
    status: toStatusFilter(params.get('status')),
    q: (params.get('q') ?? '').trim(),
    page: Number.isFinite(page) && page > 0 ? page : 1,
  };
}

export function filterReports(records: readonly Report[], query: Pick<ReportQuery, 'status' | 'q'>): Report[] {
  const needle = query.q.toLowerCase();
  return records.filter((r) => {
    if (query.status !== 'all' && r.status !== query.status) return false;
    if (needle === '') return true;
    return r.title.toLowerCase().includes(needle) || r.owner.toLowerCase().includes(needle);
  });
}

export function paginate<T>(items: readonly T[], page: number, pageSize: number): T[] {
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

export function pageCountFor(total: number, pageSize: number): number {
  return Math.max(1, Math.floor(total / pageSize));
}

export function sumAmounts(records: readonly Report[]): number {
  return records.reduce((sum, r) => sum + r.amountCents, 0);
}

/** One page of the filtered records, with the numbers the page footer shows. */
export function queryReports(records: readonly Report[], query: ReportQuery, pageSize: number = PAGE_SIZE): ReportPage {
  const filtered = filterReports(records, query);
  const pageCount = pageCountFor(filtered.length, pageSize);
  const page = Math.min(Math.max(query.page, 1), pageCount);
  const rows = paginate(filtered, page, pageSize);
  return { rows, total: filtered.length, page, pageCount, pageSize, totalAmountCents: sumAmounts(rows) };
}
