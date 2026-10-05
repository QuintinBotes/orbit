// A tiny dependency-free web app that stands in for "the application under test"
// in Orbit's UI-runner tests. Defects are switched on by environment variable so
// one tree can play both the healthy and the broken candidate:
//   APP_DEFECT_EXPORT=1  the CSV export ignores the selected filter
//   APP_DEFECT_A11Y=1    the status filter loses its label
//   APP_DEFECT_VISUAL=1  the page background and heading change colour
//   APP_NOISE=1          the page logs a console error and requests a missing URL
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const flag = (name) => process.env[name] === '1';

const REPORTS = [
  { id: 'R-100', name: 'Quarterly summary', status: 'open', amount: '1200.00' },
  { id: 'R-101', name: 'Vendor audit', status: 'closed', amount: '310.50' },
  { id: 'R-102', name: 'Payroll check', status: 'open', amount: '8450.00' },
  { id: 'R-103', name: 'Travel claims', status: 'closed', amount: '95.25' },
  { id: 'R-104', name: 'Budget draft', status: 'draft', amount: '0.00' },
  { id: 'R-105', name: 'Renewals', status: 'open', amount: '4200.75' },
];
const STATUSES = ['all', 'open', 'closed', 'draft'];

function selected(url) {
  const status = url.searchParams.get('status') ?? 'all';
  return STATUSES.includes(status) ? status : 'all';
}
function rows(status) {
  return status === 'all' ? REPORTS : REPORTS.filter((r) => r.status === status);
}
function csv(list) {
  return ['id,name,status,amount', ...list.map((r) => `${r.id},${r.name},${r.status},${r.amount}`)].join('\n') + '\n';
}

function page() {
  let html = readFileSync(join(here, 'public', 'reports.html'), 'utf8');
  const label = flag('APP_DEFECT_A11Y') ? '' : '<label for="status">Status</label>';
  html = html.replace('<!--LABEL-->', label);
  const config = { noise: flag('APP_NOISE') };
  html = html.replace('<!--CONFIG-->', `<script>window.__APP__=${JSON.stringify(config)}</script>`);
  const css = flag('APP_DEFECT_VISUAL') ? '<style>body{background:#ffd54f}h1{color:#b00020;font-size:2.4rem}</style>' : '';
  return html.replace('<!--EXTRA-->', css);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const send = (status, type, body, headers = {}) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
    res.end(body);
  };
  if (url.pathname === '/') return send(302, 'text/plain', '', { location: '/reports' });
  if (url.pathname === '/reports') return send(200, 'text/html; charset=utf-8', page());
  if (url.pathname === '/app.js') return send(200, 'text/javascript; charset=utf-8', readFileSync(join(here, 'public', 'app.js')));
  if (url.pathname === '/styles.css') return send(200, 'text/css; charset=utf-8', readFileSync(join(here, 'public', 'styles.css')));
  if (url.pathname === '/api/reports') return send(200, 'application/json', JSON.stringify(rows(selected(url))));
  if (url.pathname === '/export.csv') {
    const status = selected(url);
    // The injected defect: the filter is dropped on the server, so the file
    // does not match what the page shows.
    const list = flag('APP_DEFECT_EXPORT') ? REPORTS : rows(status);
    return send(200, 'text/csv; charset=utf-8', csv(list), { 'content-disposition': `attachment; filename="reports-${status}.csv"` });
  }
  return send(404, 'text/plain', 'not found');
});

const port = Number(process.env.PORT ?? 4173);
server.listen(port, '127.0.0.1', () => console.log(`ui-app listening on http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
