import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createApp, handle } from '../../src/server.ts';
import { makeReports } from './helpers.ts';

describe('handle', () => {
  it('redirects / to /reports', () => {
    const r = handle('/', new URLSearchParams());
    assert.equal(r.status, 302);
    assert.equal(r.headers?.location, '/reports');
  });

  it('renders the reports page for the query string', () => {
    const r = handle('/reports', new URLSearchParams('status=open'), makeReports(30));
    assert.equal(r.status, 200);
    assert.match(String(r.body), /Showing 1-10 of 10 reports/);
  });

  it('serves the stylesheet', () => {
    const r = handle('/static/styles.css', new URLSearchParams());
    assert.equal(r.status, 200);
    assert.match(r.type, /text\/css/);
  });

  it('answers 404 for anything else', () => {
    assert.equal(handle('/nope', new URLSearchParams()).status, 404);
    assert.equal(handle('/static/../server.ts', new URLSearchParams()).status, 404);
  });
});

describe('the http server', () => {
  const server = createApp(makeReports(20));
  let base = '';
  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('serves /reports over a socket', async () => {
    const res = await fetch(`${base}/reports?page=2`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Showing 11-20 of 20 reports/);
  });
});
