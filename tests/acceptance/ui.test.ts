/**
 * Spec section 17, scenarios 17 and 18 (spec section 13, UI testing), with
 * real Chromium through Playwright against the demo app's own journeys:
 * a UI defect is reproduced in the browser, repaired and reverified, and a
 * changed visual baseline cannot hide a visual regression. Scenario 17 is
 * also the third demo run of spec section 2 (fails browser checks, repairs,
 * passes independent review, opens a draft PR on FakeGitHub).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { listDecisions } from '../../src/storage/decisions.ts';
import { listWorkers } from '../../src/storage/workers.ts';
import { listEvidenceReports } from '../../src/evidence/store.ts';
import { listReviews } from '../../src/review/store.ts';
import { chromiumAvailable, DEMO_DIR, drive, ensureBaselines, freePort, git, makeLab, READY, startLabRun, waitFor, writeScenario, type Lab } from './helpers/lab.ts';
import { implementer, scenario } from './helpers/scenarios.ts';
import { assertRunInvariants, transitions } from './helpers/invariants.ts';
import { scenarioFor } from '../../scripts/demo/mock/scenarios.ts';

const CHROMIUM = READY && chromiumAvailable();
const labs: Lab[] = [];
afterAll(() => labs.splice(0).forEach((l) => l.close()));

describe.skipIf(!CHROMIUM)('acceptance: UI verification in a real browser', () => {
  let l: Lab;
  let runId: string;
  beforeAll(async () => {
    ensureBaselines();
    l = makeLab();
    labs.push(l);
    writeScenario(l, scenarioFor('ui'));
    runId = startLabRun(l, readFileSync(join(DEMO_DIR, 'goals', 'ui.md'), 'utf8').trim()).id;
    await drive(l, runId);
  }, 600_000);

  it('scenario 17 (and demo run 3): a UI defect is reproduced in Chromium, diagnosed, repaired, reverified, independently reviewed and delivered as a draft PR', () => {
    const db = l.db();
    const done = db.get<{ state: string; outcome_reason: string }>('SELECT state, outcome_reason FROM runs WHERE id = ?', runId)!;
    expect(done.state, done.outcome_reason).toBe('SUCCEEDED');
    const reports = listEvidenceReports(db, runId);
    expect(reports.map((r) => r.verdict)).toEqual(['FAIL', 'PASS']);
    // Reproduced: the export journey failed in the browser on both viewports, with artifacts kept.
    const failed = reports[0]!.report.ui.filter((u) => u.status === 'FAILED');
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.map((u) => u.journey).join(' ')).toMatch(/reports-export/);
    expect(failed.map((u) => u.journey).join(' ')).toMatch(/desktop/);
    expect(failed.map((u) => u.journey).join(' ')).toMatch(/mobile/);
    const artifacts = failed.flatMap((u) => u.artifacts);
    expect(artifacts.length).toBeGreaterThan(0);
    expect(artifacts.some((a) => existsSync(a.startsWith('/') ? a : join(l.runDir(runId), a)))).toBe(true);
    // The command checks alone were green: only the browser showed the defect.
    expect(reports[0]!.report.checks.filter((c) => c.id === 'unit' || c.id === 'lint').every((c) => c.status === 'PASSED')).toBe(true);
    // Diagnosed and repaired with a brief naming the failing journey.
    const brief = JSON.parse(readFileSync(join(l.runDir(runId), 'briefs', 'attempt-2.json'), 'utf8')) as { source: string; brief: { evidence: string[] } };
    expect(brief.source).toBe('diagnosis');
    expect(brief.brief.evidence.join(' ')).toMatch(/reports-export/);
    expect(listDecisions(db, runId, { kind: 'repair.brief' })).toHaveLength(1);
    // Reverified: every journey passed on the repaired tree, on both viewports.
    const final = reports[1]!;
    expect(final.report.ui.length).toBeGreaterThan(0);
    expect(final.report.ui.every((u) => u.status === 'PASSED')).toBe(true);
    expect(final.report.acceptance_evidence.every((a) => a.status === 'supported')).toBe(true);
    // The table baseline was not touched to get there.
    expect(final.report.scope.visual_baseline_changes).toEqual([]);
    // Independent review of the repaired tree, then one draft PR carrying exactly that tree.
    expect(listReviews(db, runId).map((r) => [r.provider, r.verdict, r.treeHash])).toEqual([['codex', 'APPROVE', final.treeHash]]);
    const gh = l.github().state;
    expect(gh.prs).toHaveLength(1);
    expect(gh.prs[0]).toMatchObject({ isDraft: true, headRefName: `orbit/${runId}` });
    expect(git(l.remote, 'rev-parse', `refs/heads/orbit/${runId}^{tree}`)).toBe(final.treeHash);
    expect(listWorkers(db, { runId, role: 'implementer' })).toHaveLength(2);
    assertRunInvariants(l, runId);
  });

  it('scenario 18: a visual regression shipped with a re-recorded baseline is caught: green pixels over a changed baseline are not accepted', async () => {
    // A person (not Orbit) records what the regressed table looks like, in a scratch copy of the app.
    const regress = { op: 'replace' as const, path: 'src/public/styles.css', find: 'table { width: 100%; border-collapse: collapse; }', replace: 'table { width: 70%; border-collapse: separate; }' };
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-acc-regressed-')));
    const lab18 = makeLab({ tweak: (c) => void (c.scheduler.hard_limits.implementation_attempts = 1) });
    labs.push(lab18);
    try {
      const copy = join(scratch, 'app');
      cpSync(lab18.repo, copy, { recursive: true, filter: (p) => !p.includes('/node_modules') && !p.endsWith('/.git') && !p.includes('/.git/') && !p.includes('/.orbit/') });
      symlinkSync(realpathSync(join(lab18.repo, 'node_modules')), join(copy, 'node_modules'));
      const css = join(copy, 'src/public/styles.css');
      const text = readFileSync(css, 'utf8');
      expect(text).toContain(regress.find);
      writeFileSync(css, text.replace(regress.find, regress.replace));
      const env: NodeJS.ProcessEnv = { ...process.env, PORT: freePort() };
      for (const k of Object.keys(env)) if (k.startsWith('ORBIT_UI_')) delete env[k];
      const rec = spawnSync('npx', ['--no-install', 'playwright', 'test', 'visual', '-u', '--reporter=null'], { cwd: copy, env, encoding: 'utf8', timeout: 300_000 });
      expect(rec.status, `${rec.stdout}${rec.stderr}`.slice(-2000)).toBe(0);
      const shots = ['desktop', 'mobile'].map((p) => `tests/e2e/__screenshots__/${p}/${process.platform}/visual.spec.ts/reports-table.png`);
      for (const s of shots) expect(readFileSync(join(copy, s)).equals(readFileSync(join(lab18.repo, s)))).toBe(false);

      // The worker makes the CSS change; while it works, the re-recorded baselines land in its worktree as its own writes.
      const plan = (scenarioFor('ui').roles.planner![0] as { structured: Record<string, unknown> }).structured;
      const planner = { structured: { ...plan, objective: 'Tidy the reports table styles.', criteria: [{ key: 'style', statement: 'The reports table keeps its layout on desktop and mobile.', mandatory: true, ui: true, proof: ['The visual journey passes against the stored baseline'], check_ids: ['lint', 'unit', 'ui'], changes: [{ path: 'src/public/styles.css', summary: 'styles' }] }], expected_changed_files: [{ path: 'src/public/styles.css', change: 'modify', reason: 'styles' }] } };
      writeScenario(lab18, scenario({ planner: [planner], implementer: [implementer([regress], { extra: { sleepMs: 4_000 }, tests: [], changed: [['src/public/styles.css', 'modify']] })] }));
      const run = startLabRun(lab18, 'Tidy the reports table styles without changing its layout.');
      const driving = drive(lab18, run.id);
      const w = await waitFor(() => listWorkers(lab18.db(), { runId: run.id, role: 'implementer' }).find((x) => x.state === 'RUNNING'), 120_000);
      for (const s of shots) {
        mkdirSync(dirname(join(w.cwd, s)), { recursive: true });
        copyFileSync(join(copy, s), join(w.cwd, s));
      }
      const done = await driving;

      const db = lab18.db();
      const [ev] = listEvidenceReports(db, run.id);
      // The browser ran, and against the swapped baselines the pixels "match"...
      const visual = ev!.report.ui.filter((u) => /reports-visual/.test(u.journey));
      expect(visual.length).toBeGreaterThan(0);
      expect(visual.every((u) => u.status === 'PASSED')).toBe(true);
      // ...but the baseline change itself is evidence of weakened proof, so the candidate is not accepted.
      expect(ev!.report.scope.visual_baseline_changes.sort()).toEqual(shots.sort());
      expect(ev!.verdict).not.toBe('PASS');
      expect(ev!.report.unverified.join(' ')).toMatch(/visual baselines changed and require review/);
      const path = transitions(db, run.id);
      expect(path).not.toContain('REVIEWING');
      expect(path).not.toContain('DELIVERING');
      // The UI gate names the swapped baselines as needing a person's review.
      const uiGate = listDecisions(db, run.id, { kind: 'gate.ui' });
      expect(uiGate.at(-1)!.summary).toMatch(/baselines changed in the candidate and need human review/);
      expect(uiGate.at(-1)!.summary).toContain('reports-table.png');
      expect(done.state).not.toBe('SUCCEEDED');
      expect(['EXHAUSTED', 'BLOCKED']).toContain(done.state);
      expect(listReviews(db, run.id, { includeInvalidated: true })).toEqual([]);
      expect(lab18.github().state.prs).toEqual([]);
      // The stored baselines in the repository are unchanged.
      for (const s of shots) expect(readFileSync(join(lab18.repo, s)).equals(readFileSync(join(DEMO_DIR, s)))).toBe(existsSync(join(DEMO_DIR, s)));
      assertRunInvariants(lab18, run.id);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 600_000);
});
