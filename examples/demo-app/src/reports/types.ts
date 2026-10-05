export type Status = 'open' | 'closed' | 'draft';
export type StatusFilter = Status | 'all';

export interface Report {
  id: string;
  title: string;
  owner: string;
  status: Status;
  /** Money is kept in integer cents; formatting happens at the edge. */
  amountCents: number;
  /** Calendar date, YYYY-MM-DD. */
  created: string;
}

export interface ReportQuery {
  status: StatusFilter;
  /** Case-insensitive substring of the title or owner; empty matches everything. */
  q: string;
  /** 1-based page number as requested; queryReports clamps it into range. */
  page: number;
}

export interface ReportPage {
  rows: Report[];
  /** Records matching the filters, across every page. */
  total: number;
  page: number;
  pageCount: number;
  pageSize: number;
  /** Sum of the amounts shown in the page footer. */
  totalAmountCents: number;
}
