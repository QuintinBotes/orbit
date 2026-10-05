import { writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { renderUiFailureBrief, uiFailureBrief } from '../../../src/ui/brief.ts';
import { candidateAt, commitAll, freePort, harness, makeUiRepo, resetTo, runUi, writeFile, type UiRepo } from './helpers.ts';

let repo: UiRepo;

beforeAll(async () => {
  repo = await makeUiRepo();
}, 120_000);
afterAll(() => repo.cleanup());
beforeEach(() => resetTo(repo));

describe('console and network capture', () => {
  it('records console errors, failed responses and the viewport without failing a passing journey', async () => {
    const port = await freePort();
    const h = harness(repo, port, { filter: ['reports.spec.ts'] });
    const r = await runUi(repo, candidateAt(repo.dir, repo.baseSha), h, { name: 'noise', appEnv: { APP_NOISE: '1' } });

    expect(r.verdict).toBe('PASS');
    expect(r.consoleErrorCount).toBeGreaterThanOrEqual(4);
    for (const j of r.journeys) {
      expect(j.diagnostics?.consoleErrors.some((c) => c.text.includes('legacy widget failed to initialise'))).toBe(true);
      expect(j.diagnostics?.badResponses).toEqual(expect.arrayContaining([expect.objectContaining({ status: 404, method: 'GET' })]));
      expect(j.diagnostics?.badResponses.some((b) => b.url.endsWith('/api/missing'))).toBe(true);
      expect(j.diagnostics?.finalUrl).toBe(`${h.baseUrl}/reports`);
      // The diagnostics attachment is kept as a file, bound to the journey.
      expect(j.artifacts.find((a) => a.kind === 'diagnostics')?.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  }, 90_000);

  it('a failing journey carries those errors into its brief, fenced as untrusted', async () => {
    const port = await freePort();
    const h = harness(repo, port, { filter: ['reports.spec.ts'] });
    const r = await runUi(repo, candidateAt(repo.dir, repo.baseSha), h, { name: 'noise-fail', appEnv: { APP_NOISE: '1', APP_DEFECT_EXPORT: '1' } });
    expect(r.verdict).toBe('FAIL');
    const brief = uiFailureBrief(r);
    expect(brief.failures[0]?.evidence.consoleErrors.join('\n')).toContain('legacy widget failed to initialise');
    expect(brief.failures[0]?.evidence.badResponses.join('\n')).toContain('HTTP 404');
    const md = renderUiFailureBrief(brief);
    expect(md).toContain('Console errors (untrusted):');
    expect(md).toContain('HTTP error responses (untrusted):');
  }, 90_000);
});

describe('what the runner refuses', () => {
  it('rejects a check that tries to update snapshots, before anything starts', async () => {
    const port = await freePort();
    const h = harness(repo, port, { checkExtra: ['--update-snapshots=all'] });
    await expect(runUi(repo, candidateAt(repo.dir, repo.baseSha), h, { name: 'forbidden-flag' })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(fetch(h.baseUrl)).rejects.toThrow();
  });

  it('refuses a base URL that is not loopback when isolated test data is required', async () => {
    const h = harness(repo, 3000, { baseUrl: 'http://staging.acme.test:3000' });
    await expect(runUi(repo, candidateAt(repo.dir, repo.baseSha), h, { name: 'remote' })).rejects.toMatchObject({ code: 'POLICY_DENIED', details: { host: 'staging.acme.test' } });
  });

  it('refuses a checkout that does not match the candidate', async () => {
    const port = await freePort();
    const cand = candidateAt(repo.dir, repo.baseSha);
    writeFileSync(join(repo.dir, 'public/app.js'), '// edited after the candidate was made\n');
    await expect(runUi(repo, cand, harness(repo, port), { name: 'stale' })).rejects.toMatchObject({ code: 'STALE_EVIDENCE' });
  });

  it('refuses a candidate whose recorded tree is not its commit tree', async () => {
    const port = await freePort();
    const cand = { ...candidateAt(repo.dir, repo.baseSha), treeHash: '0'.repeat(40) };
    await expect(runUi(repo, cand, harness(repo, port), { name: 'wrong-tree' })).rejects.toMatchObject({ code: 'STALE_EVIDENCE' });
  });

  describe('a server already answering at base_url', () => {
    let squatter: Server;
    let port: number;
    beforeAll(async () => {
      port = await freePort();
      squatter = createServer((_req, res) => res.end('not the app')).listen(port, '127.0.0.1');
      await new Promise((r) => squatter.once('listening', r));
    });
    afterAll(() => new Promise((r) => squatter.close(r)));

    it('is reported as an errored run, not tested', async () => {
      const r = await runUi(repo, candidateAt(repo.dir, repo.baseSha), harness(repo, port), { name: 'squatter' });
      expect(r.verdict).toBe('ERROR');
      expect(r.journeys).toEqual([]);
      expect(r.reasons.join(' ')).toMatch(/already answers/);
    });
  });

  it('reports an application that exits at start as an errored run with its output', async () => {
    const port = await freePort();
    writeFile(repo.dir, 'server.mjs', 'console.error("boom: cannot bind"); process.exit(3);\n');
    const cand = commitAll(repo.dir, 'break the server');
    const r = await runUi(repo, cand, harness(repo, port), { name: 'app-exit' });
    expect(r.verdict).toBe('ERROR');
    expect(r.reasons.join(' ')).toContain('boom: cannot bind');
  }, 60_000);
});

describe('journeys are untrusted code', () => {
  it('a journey that plants a baseline file is flagged', async () => {
    writeFile(
      repo.dir,
      'journeys/sneaky.spec.ts',
      `import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from './orbit-fixtures.ts';

test('sneaky', async ({ page }, testInfo) => {
  await page.goto('/reports');
  // Writes straight into the snapshot directory, bypassing --update-snapshots=none.
  mkdirSync('journeys/__screenshots__/desktop', { recursive: true });
  writeFileSync('journeys/__screenshots__/desktop/planted.png', 'not a real baseline');
  await testInfo.attach('host-file', { path: '/etc/hosts' });
});
`,
    );
    const cand = commitAll(repo.dir, 'add sneaky journey');
    const port = await freePort();
    const r = await runUi(repo, cand, harness(repo, port, { filter: ['sneaky.spec.ts'] }), { name: 'sneaky' });

    expect(r.stats.failed).toBe(0);
    expect(r.visualBaselineChanges).toContain('journeys/__screenshots__/desktop/planted.png');
    expect(r.verdict).toBe('BLOCKED');
    expect(r.reasons.join(' ')).toContain('wrote baseline files');
    // Playwright copies attached files into its output directory; whatever is recorded lives under the evidence directory.
    for (const a of r.journeys.flatMap((j) => j.artifacts)) expect(a.path.startsWith(r.outDir)).toBe(true);
  }, 90_000);

  it('a run with no tests is an error, not a pass', async () => {
    const port = await freePort();
    const r = await runUi(repo, candidateAt(repo.dir, repo.baseSha), harness(repo, port, { filter: ['nothing-matches-this'] }), { name: 'empty' });
    expect(r.verdict).toBe('ERROR');
    expect(r.passed).toBe(false);
  }, 60_000);

  it('a skipped journey is a failure, not a pass', async () => {
    writeFile(repo.dir, 'journeys/skipped.spec.ts', `import { test } from './orbit-fixtures.ts';\ntest.skip('hidden-failure', async () => {});\n`);
    const cand = commitAll(repo.dir, 'skip a journey');
    const port = await freePort();
    const r = await runUi(repo, cand, harness(repo, port, { filter: ['skipped.spec.ts'] }), { name: 'skipped' });
    expect(r.stats.skipped).toBe(2);
    expect(r.verdict).toBe('FAIL');
    expect(r.reasons.join(' ')).toContain('skipped');
  }, 60_000);
});
