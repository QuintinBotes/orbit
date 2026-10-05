import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NoIsolation } from '../../../src/isolation/none.ts';
import { exploreUi, explorationFollowUps, renderExplorationReport, type ExploreOptions, type ExplorerRun, type SpecRequest } from '../../../src/ui/explore.ts';
import { candidateAt, freePort, harness, makeUiRepo, resetTo, type UiRepo } from './helpers.ts';

// G33. A fake explorer proposes candidate findings; the real controller code
// turns each into a Playwright test and runs it in real Chromium against the
// fixture application. Only a test that fails on every run counts.
let repo: UiRepo;

beforeAll(async () => {
  repo = await makeUiRepo();
}, 120_000);
afterAll(() => repo.cleanup());
beforeEach(() => resetTo(repo));

const finding = (id: string, severity: 'critical' | 'high' | 'medium' | 'low', summary: string) => ({
  id,
  summary,
  steps: ['Open /reports'],
  expected: 'as stated',
  observed: 'as observed',
  severity,
  proposed_test: summary,
});

const output = (findings: ReturnType<typeof finding>[]) => ({ observations: ['Reports page loads'], candidate_findings: findings, coverage_notes: 'Reports page at 1440x900.' });
const ok = (out: unknown, costUsd: number | null = 0.01): ExplorerRun => ({ status: 'succeeded', output: out, costUsd });

const EXPORT_SPEC = `import { expect, test } from '@playwright/test';
test('export respects the filter', async ({ page }) => {
  await page.goto('/reports');
  await page.locator('#status').selectOption('open');
  await expect(page.locator('#count')).toHaveText('3 reports');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export CSV' }).click()]);
  const chunks: Buffer[] = [];
  for await (const c of await download.createReadStream()) chunks.push(Buffer.from(c));
  expect(Buffer.concat(chunks).toString('utf8')).not.toContain('R-101');
});
`;

const COUNT_SPEC = `import { expect, test } from '@playwright/test';
test('count follows the filter', async ({ page }) => {
  await page.goto('/reports');
  await page.locator('#status').selectOption('closed');
  await expect(page.locator('#count')).toHaveText('3 reports');
});
`;
const TRUE_COUNT_SPEC = COUNT_SPEC.replace('3 reports', '2 reports');

const FLAKY_SPEC = `import { expect, test } from '@playwright/test';
test('warm-up endpoint answers', async ({ request }) => {
  const res = await request.get('/api/flaky');
  expect(res.status()).toBe(200);
});
`;

const NODE_SPEC = `import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
test('reads the disk', async ({ page }) => {
  await page.goto('/reports');
  expect(readFileSync('/etc/hosts', 'utf8')).toBe('');
});
`;

async function run(over: Partial<ExploreOptions> & { explore: ExploreOptions['explore']; authorSpec: ExploreOptions['authorSpec']; name: string; appEnv?: Record<string, string> }) {
  const port = await freePort();
  const h = harness(repo, port);
  const ui = h.snapshot.config.ui!;
  const { name, ...rest } = over;
  return exploreUi({
    checkoutDir: repo.dir,
    snapshot: h.snapshot,
    candidate: candidateAt(repo.dir, repo.baseSha),
    uiConfig: ui,
    exploration: { enabled: true, max_minutes: 5, budget_usd: 1 },
    isolation: new NoIsolation(),
    outDir: join(repo.home, 'exploration', name),
    homeDir: repo.home,
    ...rest,
  });
}

describe('exploreUi', () => {
  it('counts a finding only when its test fails on every run; reports the rest as what they are', async () => {
    const specs: Record<string, string | null> = { 'EX-1': EXPORT_SPEC, 'EX-2': COUNT_SPEC, 'EX-3': FLAKY_SPEC, 'EX-4': NODE_SPEC, 'EX-5': null, 'EX-6': TRUE_COUNT_SPEC };
    const seen: SpecRequest[] = [];
    const r = await run({
      name: 'mixed',
      appEnv: { APP_DEFECT_EXPORT: '1', APP_FLAKY: '1' },
      explore: async (task) => {
        expect(task.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        // The application is already up when the explorer is asked to look at it.
        expect((await fetch(task.baseUrl)).status).toBe(200);
        expect(task.workUnit).toContain(task.baseUrl);
        return ok(
          output([
            finding('EX-1', 'high', 'Export ignores the status filter'),
            finding('EX-2', 'medium', 'Closed filter shows three reports'),
            finding('EX-3', 'low', 'Warm-up endpoint fails'),
            finding('EX-4', 'low', 'A test that touches the disk'),
            finding('EX-5', 'low', 'Nothing can be written'),
            finding('EX-6', 'low', 'Closed filter count is wrong'),
          ]),
        );
      },
      authorSpec: async (req) => {
        seen.push(req);
        const source = specs[req.finding.id] ?? null;
        return source === null ? null : { source, costUsd: 0.02 };
      },
    });

    const by = Object.fromEntries(r.findings.map((f) => [f.id, f]));
    expect(by['EX-1']?.status).toBe('reproduced');
    expect(by['EX-1']?.runs.map((x) => x.status)).toEqual(['failed', 'failed', 'failed']);
    expect(by['EX-1']?.runs[0]?.error).toContain('toContain');
    expect(by['EX-1']?.spec?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(by['EX-1']!.spec!.path)).toBe(true);
    expect(by['EX-1']?.reproduction).toContain('playwright test');
    expect(by['EX-1']?.artifacts.some((a) => a.endsWith('.zip'))).toBe(true);
    // EX-2 asserts the wrong count, so it fails; EX-6 asserts the right one and passes: not reproduced.
    expect(by['EX-2']?.status).toBe('reproduced');
    expect(by['EX-6']?.status).toBe('not_reproduced');
    expect(by['EX-6']?.runs.map((x) => x.status)).toEqual(['passed']);
    expect(by['EX-3']?.status).toBe('intermittent');
    expect(by['EX-3']?.runs.map((x) => x.status)).toEqual(['failed', 'passed']);
    expect(by['EX-4']?.status).toBe('invalid_test');
    expect(by['EX-4']?.reason).toContain('node:fs');
    expect(by['EX-4']?.runs).toEqual([]);
    expect(by['EX-5']?.status).toBe('no_test');

    expect(r.reproduced.map((f) => f.id).sort()).toEqual(['EX-1', 'EX-2']);
    expect(r.unreproduced.map((f) => f.id).sort()).toEqual(['EX-3', 'EX-4', 'EX-5', 'EX-6']);
    expect(r.outcome).toBe('completed');
    // Never acceptance evidence, at any level.
    expect(r.acceptanceEvidence).toBe(false);
    expect(r.findings.every((f) => f.countsAsAcceptanceEvidence === false)).toBe(true);
    expect(r.observations).toEqual(['Reports page loads']);
    // Most severe first.
    expect(seen[0]?.finding.id).toBe('EX-1');
    // Cost is the explorer plus five test-writing calls.
    expect(r.costUsd).toBeCloseTo(0.01 + 5 * 0.02, 6);
    expect(r.unverified.join(' ')).toMatch(/not acceptance evidence/);

    const followUps = explorationFollowUps(r);
    expect(followUps.map((f) => f.id).sort()).toEqual(['EX-1', 'EX-2']);
    expect(followUps[0]?.specSource).toContain('@playwright/test');
    expect(renderExplorationReport(r)).toContain('EX-3 (low): intermittent');
    expect(JSON.parse(readFileSync(join(r.outDir, 'exploration.json'), 'utf8')).acceptanceEvidence).toBe(false);
    // The application was stopped afterwards.
    await expect(fetch(r.baseUrl)).rejects.toThrow();
  }, 240_000);

  it('the same claim on a healthy build does not reproduce and is reported as such', async () => {
    const r = await run({
      name: 'healthy',
      explore: async () => ok(output([finding('EX-1', 'high', 'Export ignores the status filter')])),
      authorSpec: async () => ({ source: EXPORT_SPEC, costUsd: 0 }),
    });
    expect(r.reproduced).toEqual([]);
    expect(r.findings[0]?.status).toBe('not_reproduced');
    expect(r.findings[0]?.reason).toContain('did not reproduce');
    expect(explorationFollowUps(r)).toEqual([]);
  }, 90_000);

  it('does nothing when exploration is disabled', async () => {
    let calls = 0;
    const r = await run({
      name: 'disabled',
      exploration: { enabled: false, max_minutes: 5, budget_usd: 1 },
      explore: async () => {
        calls += 1;
        return ok(output([]));
      },
      authorSpec: async () => {
        calls += 1;
        return null;
      },
    });
    expect(r.outcome).toBe('disabled');
    expect(calls).toBe(0);
    expect(r.findings).toEqual([]);
  });

  it('stops at ui.exploration.max_minutes when the explorer does not return', async () => {
    let aborted = false;
    const r = await run({
      name: 'timeout',
      exploration: { enabled: true, max_minutes: 0.01, budget_usd: 1 },
      explore: (task) =>
        new Promise<ExplorerRun>(() => {
          task.signal.addEventListener('abort', () => {
            aborted = true;
          });
        }),
      authorSpec: async () => {
        throw new Error('must not be called');
      },
    });
    expect(r.outcome).toBe('timeout');
    expect(r.reasons.join(' ')).toContain('max_minutes');
    expect(aborted).toBe(true);
    expect(r.findings).toEqual([]);
  }, 60_000);

  it('stops writing tests once ui.exploration.budget_usd is spent; candidates stay unproven', async () => {
    let authored = 0;
    const r = await run({
      name: 'budget',
      exploration: { enabled: true, max_minutes: 5, budget_usd: 0.05 },
      explore: async () => ok(output([finding('EX-1', 'high', 'one'), finding('EX-2', 'low', 'two')]), 0.04),
      authorSpec: async () => {
        authored += 1;
        return { source: COUNT_SPEC, costUsd: 0.03 };
      },
    });
    // The first call fits (0.04 spent of 0.05); its own cost then exhausts the budget before the second.
    expect(authored).toBe(1);
    expect(r.outcome).toBe('budget_exhausted');
    const second = r.findings.find((f) => f.id === 'EX-2')!;
    expect(second.status).toBe('not_attempted');
    expect(second.reason).toContain('budget_usd');
    expect(r.reproduced.length + r.unreproduced.length).toBe(2);
  }, 120_000);

  it('malformed explorer output is a failure, not an empty result', async () => {
    const r = await run({
      name: 'malformed',
      explore: async () => ok({ candidate_findings: 'many' }),
      authorSpec: async () => null,
    });
    expect(r.outcome).toBe('explorer_failed');
    expect(r.reasons.join(' ')).toMatch(/explorer-output\.schema\.json/);
    expect(r.findings).toEqual([]);
  }, 60_000);
});
