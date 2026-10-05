/**
 * examples/demo-app on its own: a fresh copy installs from its lockfile and its
 * own checks pass, its Orbit policy is valid, and the seeded defect the
 * difficult goal needs is really there (and only there).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/policy/index.ts';
import { queryReports } from '../../../examples/demo-app/src/reports/query.ts';
import { chromiumAvailable, copyExample, ensureBaselines, EXAMPLE_DIR, ORBIT_ROOT, GOALS_DIR, installDependencies, runExampleChecks, type InstallMethod } from '../../../scripts/demo/lib/example.ts';

let base: string;
let dir: string;
let install: InstallMethod;
// Probed from Orbit's own checkout; the copy gets the same Playwright version from its lockfile.
const hasChromium = chromiumAvailable(ORBIT_ROOT);

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'orbit-demo-example-'));
  dir = join(base, 'demo-app');
  copyExample(dir);
  install = installDependencies(dir, { allowNetwork: true });
}, 300_000);
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('a fresh copy of the example', () => {
  it('leaves maintainer notes and installed state behind', () => {
    expect(existsSync(join(dir, 'DEMO.md'))).toBe(false);
    expect(existsSync(join(dir, 'README.md'))).toBe(true);
    expect(existsSync(join(dir, 'package-lock.json'))).toBe(true);
    expect(['npm-ci-offline', 'npm-ci', 'linked']).toContain(install);
  });

  it('passes the type check', () => {
    const [r] = runExampleChecks(dir, ['lint']);
    expect(r!.ok, r!.out).toBe(true);
  });

  it('passes the unit tests offline', () => {
    const [r] = runExampleChecks(dir, ['unit']);
    expect(r!.ok, r!.out).toBe(true);
    // Node's default reporter is TAP on some versions and spec on others; both print the counts.
    expect(r!.out).toMatch(/^(#|ℹ) fail 0$/m);
    expect(r!.out).toMatch(/^(#|ℹ) pass [1-9]/m);
  });

  it.skipIf(!hasChromium)('passes the browser journeys on desktop and mobile against the committed baselines', () => {
    // Baselines are per platform; where none were committed, the person recording them is this test.
    ensureBaselines(dir);
    const [r] = runExampleChecks(dir, ['ui']);
    expect(r!.ok, r!.out).toBe(true);
    expect(r!.out).toMatch(/\[desktop\]/);
    expect(r!.out).toMatch(/\[mobile\]/);
  }, 300_000);
});

describe('the example as committed', () => {
  it('pins its dependencies exactly and ships a lockfile that agrees', () => {
    const pkg = JSON.parse(readFileSync(join(EXAMPLE_DIR, 'package.json'), 'utf8')) as { devDependencies: Record<string, string>; dependencies?: unknown; scripts: Record<string, string> };
    const lock = JSON.parse(readFileSync(join(EXAMPLE_DIR, 'package-lock.json'), 'utf8')) as { lockfileVersion: number; packages: Record<string, { version?: string; devDependencies?: Record<string, string> }> };
    expect(pkg.dependencies).toBeUndefined();
    expect(Object.values(pkg.devDependencies).every((v) => /^\d+\.\d+\.\d+$/.test(v))).toBe(true);
    expect(lock.lockfileVersion).toBe(3);
    expect(lock.packages['']?.devDependencies).toEqual(pkg.devDependencies);
    for (const [name, version] of Object.entries(pkg.devDependencies)) expect(lock.packages[`node_modules/${name}`]?.version).toBe(version);
    expect(Object.keys(pkg.scripts)).toEqual(expect.arrayContaining(['lint', 'test', 'test:ui']));
  });

  it('copies Orbit\'s Playwright fixtures template unchanged', () => {
    expect(readFileSync(join(EXAMPLE_DIR, 'tests/e2e/orbit-fixtures.ts'), 'utf8')).toBe(readFileSync(join(ORBIT_ROOT, 'templates/playwright/orbit-fixtures.ts'), 'utf8'));
  });

  it('has desktop and mobile projects and committed visual baselines for both', () => {
    const config = readFileSync(join(EXAMPLE_DIR, 'playwright.config.ts'), 'utf8');
    expect(config).toMatch(/name: 'desktop'/);
    expect(config).toMatch(/name: 'mobile'/);
    for (const project of ['desktop', 'mobile']) {
      const platforms = existsSync(join(EXAMPLE_DIR, 'tests/e2e/__screenshots__', project)) ? ['darwin', 'linux'].filter((p) => existsSync(join(EXAMPLE_DIR, 'tests/e2e/__screenshots__', project, p, 'visual.spec.ts', 'reports-table.png'))) : [];
      expect(platforms.length, `baselines for ${project}`).toBeGreaterThan(0);
    }
  });

  it('has an Orbit policy for the autonomous-delivery profile', () => {
    const c = loadConfig(EXAMPLE_DIR);
    expect(c.mode).toBe('autonomous-delivery');
    expect(Object.keys(c.checks).sort()).toEqual(['lint', 'ui', 'unit']);
    expect(c.checks.ui?.kind).toBe('playwright');
    expect(c.scope.allowed_paths).toEqual(['src/**', 'tests/**']);
    expect(c.scope.protected_paths).toEqual(expect.arrayContaining(['.github/**', 'infra/**', '.orbit/config.yaml']));
    expect(Object.keys(c.providers).sort()).toEqual(['claude', 'codex']);
    expect(c.delivery.provider).toBe('github');
    expect(c.delivery.pull_request).toBe('draft');
    expect(c.actions.merge).toBe(false);
    expect(c.actions.deploy_production).toBe(false);
    expect(c.review.independent_provider_required).toBe(true);
    expect(c.ui?.journey_check_ids).toEqual(['ui']);
    expect(c.ui?.viewports).toHaveLength(2);
    expect(c.ui?.visual.baseline_globs).toEqual(['tests/e2e/__screenshots__/**']);
  });

  it('has the three goals, with no hint of where the defect is', () => {
    for (const goal of ['simple', 'difficult', 'ui']) {
      const text = readFileSync(join(GOALS_DIR, `${goal}.md`), 'utf8');
      expect(text.length, goal).toBeGreaterThan(100);
      expect(text, goal).not.toMatch(/query\.ts|Math\.(floor|ceil)|pageCountFor|sumAmounts/);
    }
    expect(readFileSync(join(GOALS_DIR, 'ui.md'), 'utf8')).toMatch(/reports-YYYY-MM-DD\.csv/);
    expect(readFileSync(join(GOALS_DIR, 'ui.md'), 'utf8')).toMatch(/local date/);
  });

  it('documents the seeded defects for maintainers only', () => {
    const demo = readFileSync(join(EXAMPLE_DIR, 'DEMO.md'), 'utf8');
    expect(demo).toMatch(/seeded defects/i);
    expect(demo).toMatch(/Math\.floor/);
    for (const worker of ['README.md', 'goals/simple.md', 'goals/difficult.md', 'goals/ui.md']) expect(readFileSync(join(EXAMPLE_DIR, worker), 'utf8'), worker).not.toMatch(/seeded|Math\.floor|defect/i);
  });

  it('ships no dash punctuation, employer or client names in what it says', () => {
    const files = ['README.md', 'DEMO.md', 'goals/simple.md', 'goals/difficult.md', 'goals/ui.md', '.orbit/config.yaml'];
    for (const f of files) expect(readFileSync(join(EXAMPLE_DIR, f), 'utf8'), f).not.toMatch(/[–—]/);
  });
});

describe('the seeded defects of the difficult goal', () => {
  const records = Array.from({ length: 47 }, (_, i) => ({ id: `R-${i}`, title: `Report ${i}`, owner: 'Avery', status: 'open' as const, amountCents: 100 * (i + 1), created: '2026-01-01' }));
  const all = { status: 'all' as const, q: '' };

  it('the total amount follows the page instead of the filtered records', () => {
    const first = queryReports(records, { ...all, page: 1 });
    const second = queryReports(records, { ...all, page: 2 });
    expect(first.total).toBe(47);
    expect(first.totalAmountCents).not.toBe(second.totalAmountCents);
    expect(first.totalAmountCents).toBe(100 * (1 + 2 + 3 + 4 + 5 + 6 + 7 + 8 + 9 + 10));
  });

  it('the last partial page cannot be reached, but exact multiples are fine', () => {
    expect(queryReports(records, { ...all, page: 1 }).pageCount).toBe(4);
    expect(queryReports(records.slice(0, 40), { ...all, page: 1 }).pageCount).toBe(4);
    expect(queryReports(records.slice(0, 20), { ...all, page: 1 }).pageCount).toBe(2);
  });
});
