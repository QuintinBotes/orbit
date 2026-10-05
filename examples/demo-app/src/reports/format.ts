import type { Status } from './types.ts';

/** 123456 -> "$1,234.56". */
export function formatAmount(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

const STATUS_LABELS: Record<Status, string> = { open: 'Open', closed: 'Closed', draft: 'Draft' };

export function statusLabel(status: Status): string {
  return STATUS_LABELS[status];
}
