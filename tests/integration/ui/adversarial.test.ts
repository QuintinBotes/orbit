import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isGroupAlive } from '../../../src/core/proc.ts';
import { NoIsolation } from '../../../src/isolation/none.ts';
import { startApp, stopApp } from '../../../src/ui/app-fixture.ts';
import { candidateAt, commitAll, freePort, git, harness, makeUiRepo, resetTo, runUi, writeFile, type UiRepo } from './helpers.ts';

let repo: UiRepo;
beforeAll(async () => {
  repo = await makeUiRepo();
}, 120_000);
afterAll(() => repo.cleanup());
beforeEach(() => resetTo(repo));

describe('stale or inconsistent reports', () => {
  it('a report left in the evidence directory by an earlier run is never read as this run', async () => {
    const port = await freePort();
    const h = harness(repo, port, { filter: ['reports.spec.ts'] });
    const cand = candidateAt(repo.dir, repo.baseSha);
    const first = await runUi(repo, cand, h, { name: 'reuse' });
    expect(first.verdict).toBe('PASS');
    // The same evidence directory, a check that cannot produce a report: the old all-green file is still there.
    writeFileSync(join(repo.dir, '..', 'broken.sh'), 'exit 0\n');
    const h2 = harness(repo, port, {});
    const broken = { ...h2.snapshot, config: { ...h2.snapshot.config, checks: { 'ui-journeys': { ...h2.snapshot.config.checks['ui-journeys']!, command: ['/bin/sh', join(repo.dir, '..', 'broken.sh')] } } } };
    const second = await runUi(repo, cand, { ...h2, snapshot: broken }, { name: 'reuse' });
    expect(second.verdict).toBe('ERROR');
    expect(second.journeys).toEqual([]);
  }, 120_000);

  it('a nonzero exit with a report that shows no failure is an error, not a pass', async () => {
    writeFile(repo.dir, 'wrap.sh', 'npx --no-install playwright test "$@"\nexit 3\n');
    const cand = commitAll(repo.dir, 'wrapper');
    const port = await freePort();
    const h = harness(repo, port, {});
    const check = { ...h.snapshot.config.checks['ui-journeys']!, command: ['/bin/sh', 'wrap.sh', 'reports.spec.ts'] };
    const snap = { ...h.snapshot, config: { ...h.snapshot.config, checks: { 'ui-journeys': check } } };
    const r = await runUi(repo, cand, { ...h, snapshot: snap }, { name: 'exit3' });
    expect(r.verdict).toBe('ERROR');
    expect(r.reasons.join(' ')).toMatch(/exit/);
  }, 90_000);
});

describe('evidence must describe the candidate', () => {
  it('refuses a checkout holding an untracked journey the candidate does not contain', async () => {
    writeFile(repo.dir, 'journeys/extra.spec.ts', `import { test } from './orbit-fixtures.ts';\ntest('extra', async () => {});\n`);
    const port = await freePort();
    await expect(runUi(repo, candidateAt(repo.dir, repo.baseSha), harness(repo, port, { filter: ['extra.spec.ts'] }), { name: 'untracked' })).rejects.toMatchObject({ code: 'STALE_EVIDENCE' });
  });

  it('a journey that edits tracked application source cannot produce a pass', async () => {
    writeFile(
      repo.dir,
      'journeys/mutate.spec.ts',
      `import { appendFileSync } from 'node:fs';\nimport { test } from './orbit-fixtures.ts';\ntest('mutate', async ({ page }) => {\n  await page.goto('/reports');\n  appendFileSync('public/app.js', '\\n// changed during the run\\n');\n});\n`,
    );
    const cand = commitAll(repo.dir, 'mutating journey');
    const port = await freePort();
    const r = await runUi(repo, cand, harness(repo, port, { filter: ['mutate.spec.ts'] }), { name: 'mutate' });
    expect(r.verdict).not.toBe('PASS');
    expect(r.reasons.join(' ')).toContain('public/app.js');
  }, 90_000);

  it('says so when the candidate deletes a journey file', async () => {
    git(repo.dir, 'rm', '-q', 'journeys/a11y.spec.ts');
    const cand = commitAll(repo.dir, 'drop a11y journey');
    const port = await freePort();
    const r = await runUi(repo, cand, harness(repo, port, { filter: ['reports.spec.ts'] }), { name: 'deleted-journey' });
    expect(r.unverified.join(' ')).toContain('journeys/a11y.spec.ts');
  }, 90_000);
});

describe('app lifecycle across a crash', () => {
  it('startApp stops an application a previous incarnation left running before starting another', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbit-recon-'));
    try {
      const port = await freePort();
      const baseUrl = `http://127.0.0.1:${port}`;
      const iso = { provider: new NoIsolation(), profile: { writablePaths: [], denyReadPaths: [], allowedHosts: [], limits: { timeoutMs: 60_000, memoryMb: null, cpus: null, pids: null }, allowLocalBinding: true } };
      const opts = { command: ['node', 'server.mjs'], cwd: join(repo.dir), baseUrl, readyTimeoutMs: 15_000, env: { PORT: String(port) }, isolation: iso, stateDir: join(dir, 'state') };
      const first = await startApp(opts);
      // The controller dies here: nobody calls stopApp, the state file still says running.
      let second;
      try {
        second = await startApp(opts);
      } catch (err) {
        await stopApp(first);
        throw err;
      }
      expect(isGroupAlive(first.pgid)).toBe(false);
      expect(isGroupAlive(second.pgid)).toBe(true);
      await stopApp(second);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
