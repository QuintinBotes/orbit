import type { Report, Status } from '../../src/reports/types.ts';

const STATUS_CYCLE: Status[] = ['open', 'closed', 'draft'];

/** n deterministic records: ids R-001.., status cycling open/closed/draft, amount 100 cents more each. */
export function makeReports(n: number): Report[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `R-${String(i + 1).padStart(3, '0')}`,
    title: `Report ${i + 1}`,
    owner: i % 2 === 0 ? 'Avery' : 'Blake',
    status: STATUS_CYCLE[i % 3]!,
    amountCents: (i + 1) * 100,
    created: '2026-01-15',
  }));
}
