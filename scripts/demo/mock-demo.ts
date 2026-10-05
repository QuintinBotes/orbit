/**
 * The three demo runs of spec section 2, offline: the real controller, worker
 * shim, adapters, evidence runner, UI runner, review and delivery code, with the
 * provider CLIs replaced by tests/fakes and GitHub by FakeGitHub. Used in CI.
 *
 *   node --experimental-transform-types scripts/demo/mock-demo.ts [--out DIR] [--goals simple,difficult,ui] [--keep] [--json]
 *
 * Exit 0 when every run ended as expected (see scenarios.ts), 1 when one did not,
 * 3 when the machine cannot run the browser journeys.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { systemClock } from '../../src/core/clock.ts';
import { readJsonIfExists } from '../../src/core/fsx.ts';
import { openDb } from '../../src/storage/db.ts';
import { listDecisions } from '../../src/storage/decisions.ts';
import { listWorkers } from '../../src/storage/workers.ts';
import { loadConfig } from '../../src/policy/index.ts';
import type { OrbitConfig } from '../../src/policy/types.ts';
import { Controller } from '../../src/controller/loop.ts';
import { getRun } from '../../src/controller/run-store.ts';
import { startRun, stateDbPath } from '../../src/controller/start.ts';
import { listEvidenceReports } from '../../src/evidence/store.ts';
import { listReviews } from '../../src/review/store.ts';
import { FakeGitHub } from '../../src/delivery/github.ts';
// The scenario adapter fills $CANDIDATE and $FINGERPRINT from the controller's own prompts.
import { FAKE_CLAUDE, FAKE_CODEX, labDeps, seedRegistry, type Lab } from '../../tests/integration/controller/harness.ts';
import { chromiumAvailable, copyExample, ensureBaselines, freePortSync, git, GOALS_DIR, initRepo, installDependencies, type InstallMethod } from './lib/example.ts';
import { EXPECTATIONS, GOAL_NAMES, scenarioFor, type GoalName } from './mock/scenarios.ts';

export interface GoalOutcome {
  goal: GoalName;
  runId: string;
  state: string;
  reason: string | null;
  difficulty: string | null;
  implementerAttempts: number;
  evidenceVerdicts: string[];
  repairs: number;
  escalations: string[];
  routes: string[];
  reviews: string[];
  branch: string | null;
  pr: { number: number; url: string; draft: boolean; branch: string } | null;
  reportPath: string | null;
  problems: string[];
}

export interface MockDemoResult {
  ok: boolean;
  install: InstallMethod;
  recordedBaselines: boolean;
  outDir: string;
  goals: GoalOutcome[];
}

function demoConfig(repo: string): OrbitConfig {
  const c = structuredClone(loadConfig(repo)) as OrbitConfig;
  c.isolation = { provider: 'none', allow_unisolated: true, container: null };
  c.providers = {
    claude: { command: FAKE_CLAUDE, data_policy_eligible: true, model: null, reasoning_effort: null, extra_args: [] },
    codex: { command: FAKE_CODEX, data_policy_eligible: true, model: 'gpt-6-astra', reasoning_effort: null, extra_args: [] },
  };
  c.delivery = { ...c.delivery, provider: 'fake' };
  // Offline: the checkout gets the dependencies that were installed from the lockfile into the copy.
  c.dependencies = { ...c.dependencies, install_command: ['ln', '-sfn', join(repo, 'node_modules'), 'node_modules'] };
  c.knowledge = { ...c.knowledge, enabled: false };
  // The app of each run listens on a port nobody else holds, so demos and tests can run side by side.
  if (c.ui) c.ui.environment.base_url = `http://127.0.0.1:${freePortSync()}`;
  return c;
}

export async function runMockDemo(opts: { outDir?: string; goals?: readonly GoalName[]; keep?: boolean; log?: (line: string) => void } = {}): Promise<MockDemoResult> {
  const log = opts.log ?? (() => {});
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-mock-demo-')));
  const repo = join(base, 'repo');
  // Reports outlive the scratch repository.
  const outDir = opts.outDir ?? mkdtempSync(join(tmpdir(), 'orbit-mock-demo-reports-'));
  mkdirSync(outDir, { recursive: true });
  const goals = opts.goals ?? GOAL_NAMES;

  copyExample(repo);
  log(`demo repository: ${repo}`);
  const install = installDependencies(repo);
  log(`dependencies: ${install}`);
  if (!chromiumAvailable(repo)) throw Object.assign(new Error('Playwright Chromium is not installed; run: npx playwright install chromium'), { exitCode: 3 });
  const recordedBaselines = ensureBaselines(repo);
  if (recordedBaselines) log(`recorded visual baselines for ${process.platform} (none were committed for it)`);
  initRepo(repo);
  const remote = join(base, 'remote.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', 'origin', 'main');

  const config = demoConfig(repo);
  const db = openDb(stateDbPath(repo));
  seedRegistry(db);
  const outcomes: GoalOutcome[] = [];
  try {
    for (const goal of goals) {
      log(`run ${goal}: starting`);
      const dir = join(base, 'scenarios', goal);
      mkdirSync(dir, { recursive: true });
      const lab = { config, orbitHome: join(base, 'orbit-home'), templatePath: join(dir, 'scenario.template.json'), scenarioPath: join(dir, 'scenario.json'), argvLog: join(dir, 'argv.jsonl') } as unknown as Lab;
      writeFileSync(lab.templatePath, JSON.stringify(scenarioFor(goal)));
      writeFileSync(lab.scenarioPath, JSON.stringify(scenarioFor(goal)));
      const run = startRun({ db, repoRoot: repo, goal: readFileSync(join(GOALS_DIR, `${goal}.md`), 'utf8').trim(), config, clock: systemClock });
      await new Controller({ mode: 'foreground', runId: run.id, deps: labDeps(lab, db), tickIntervalMs: 50, leaseTtlMs: 30_000, graceMs: 500 }).start();
      const outcome = collect(goal, run.id, db, repo, outDir);
      outcomes.push(outcome);
      log(`run ${goal}: ${outcome.state}${outcome.problems.length ? ` (${outcome.problems.join('; ')})` : ''}`);
    }
  } finally {
    db.close();
    if (!opts.keep) rmSync(base, { recursive: true, force: true });
  }
  return { ok: outcomes.every((o) => o.problems.length === 0), install, recordedBaselines, outDir, goals: outcomes };
}

function collect(goal: GoalName, runId: string, db: ReturnType<typeof openDb>, repo: string, outDir: string): GoalOutcome {
  const want = EXPECTATIONS[goal];
  const run = getRun(db, runId);
  const evidence = listEvidenceReports(db, runId);
  const decisions = listDecisions(db, runId);
  const implementers = listWorkers(db, { runId, role: 'implementer' });
  const repairs = decisions.filter((d) => d.kind === 'repair.brief').length;
  const escalations = decisions.filter((d) => (d.data as { escalated_from?: unknown } | null)?.escalated_from !== undefined).map((d) => d.summary);
  const routes = decisions.filter((d) => d.kind === 'route').map((d) => d.summary);
  const reviews = listReviews(db, runId).map((r) => `${r.provider}:${r.verdict}`);
  const gh = new FakeGitHub({ statePath: join(repo, '.orbit', 'fake-github.json') }).state;
  const delivery = readJsonIfExists<{ branch: string; pr: { number: number } }>(join(repo, '.orbit', 'runs', runId, 'delivery.json'));
  const pr = delivery ? gh.prs.find((p) => p.number === delivery.pr.number) : undefined;
  const finalMd = join(repo, '.orbit', 'runs', runId, 'final.md');
  let reportPath: string | null = null;
  if (existsSync(finalMd)) {
    mkdirSync(join(outDir, goal), { recursive: true });
    reportPath = join(outDir, goal, 'final.md');
    copyFileSync(finalMd, reportPath);
  }

  const problems: string[] = [];
  if (run.state !== want.state) problems.push(`ended ${run.state}, expected ${want.state}: ${run.outcomeReason ?? 'no reason recorded'}`);
  if (reportPath === null) problems.push('no final report');
  if (want.repair && !(repairs > 0 || escalations.length > 0)) problems.push('expected a recorded repair or escalation, found none');
  if (want.repair && !evidence.some((e) => e.verdict === 'FAIL')) problems.push('expected a failing evidence report before the repair');
  if (!want.repair && implementers.length !== 1) problems.push(`expected one implementation attempt, found ${implementers.length}`);
  if (want.draftPr && !(pr && pr.isDraft)) problems.push('expected a draft pull request on FakeGitHub');
  if (evidence.at(-1)?.verdict !== 'PASS') problems.push(`final evidence verdict is ${evidence.at(-1)?.verdict ?? 'missing'}`);
  if (!reviews.some((r) => r === 'codex:APPROVE')) problems.push('expected an APPROVE review by codex');
  return {
    goal,
    runId,
    state: run.state,
    reason: run.outcomeReason,
    difficulty: run.difficulty,
    implementerAttempts: implementers.length,
    evidenceVerdicts: evidence.map((e) => e.verdict),
    repairs,
    escalations,
    routes,
    reviews,
    branch: delivery?.branch ?? null,
    pr: pr ? { number: pr.number, url: pr.url, draft: pr.isDraft, branch: pr.headRefName } : null,
    reportPath,
    problems,
  };
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { out: { type: 'string' }, goals: { type: 'string' }, keep: { type: 'boolean' }, json: { type: 'boolean' } } });
  const names = values.goals ? values.goals.split(',').map((g) => g.trim()) : [...GOAL_NAMES];
  const bad = names.filter((g) => !(GOAL_NAMES as readonly string[]).includes(g));
  if (bad.length) {
    console.error(`unknown goal(s): ${bad.join(', ')}; choose from ${GOAL_NAMES.join(', ')}`);
    return 2;
  }
  try {
    const result = await runMockDemo({ outDir: values.out, goals: names as GoalName[], keep: values.keep, log: (l) => console.error(l) });
    if (values.json) console.log(JSON.stringify(result, null, 2));
    else {
      for (const g of result.goals) {
        console.log(`${g.goal.padEnd(10)} ${g.state.padEnd(10)} difficulty=${g.difficulty ?? '?'} attempts=${g.implementerAttempts} evidence=${g.evidenceVerdicts.join('>')} repairs=${g.repairs} review=${g.reviews.join(',')} pr=${g.pr ? `#${g.pr.number}${g.pr.draft ? ' (draft)' : ''}` : 'none'}`);
        for (const p of g.problems) console.log(`  PROBLEM: ${p}`);
      }
      console.log(`reports: ${result.outDir}`);
    }
    return result.ok ? 0 : 1;
  } catch (err) {
    console.error((err as Error).message);
    return (err as { exitCode?: number }).exitCode ?? 1;
  }
}

if (import.meta.main) process.exit(await main());
