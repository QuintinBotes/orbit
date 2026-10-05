import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPORTS } from './reports/data.ts';
import { parseQuery, queryReports } from './reports/query.ts';
import type { Report } from './reports/types.ts';
import { renderReportsPage } from './views/reports-page.ts';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');
const STATIC_TYPES: Record<string, string> = { 'styles.css': 'text/css; charset=utf-8' };

export interface Response {
  status: number;
  type: string;
  body: string | Buffer;
  headers?: Record<string, string>;
}

/** Route one request. Pure of the socket, so unit tests call it directly. */
export function handle(pathname: string, params: URLSearchParams, records: readonly Report[] = REPORTS): Response {
  if (pathname === '/') return { status: 302, type: 'text/plain', body: '', headers: { location: '/reports' } };
  if (pathname === '/reports') {
    const query = parseQuery(params);
    return { status: 200, type: 'text/html; charset=utf-8', body: renderReportsPage(query, queryReports(records, query)) };
  }
  const asset = /^\/static\/([\w.-]+)$/.exec(pathname)?.[1];
  if (asset && STATIC_TYPES[asset]) return { status: 200, type: STATIC_TYPES[asset]!, body: readFileSync(join(PUBLIC_DIR, asset)) };
  return { status: 404, type: 'text/plain; charset=utf-8', body: 'not found' };
}

export function createApp(records: readonly Report[] = REPORTS): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const out = handle(url.pathname, url.searchParams, records);
    res.writeHead(out.status, { 'content-type': out.type, 'cache-control': 'no-store', ...out.headers });
    res.end(out.body);
  });
}
