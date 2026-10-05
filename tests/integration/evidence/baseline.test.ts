import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installDependencies, runBaseline } from '../../../src/evidence/baseline.ts';
import { listCheckRuns, listFailures } from '../../../src/evidence/store.ts';
import { systemClock } from '../../../src/core/clock.ts';
import { NoIsolation } from '../../../src/isolation/none.ts';
import { recordingIsolation } from './harness.ts';
import type { OrbitConfig } from '../../../src/policy/types.ts';
import { checkDef, makeRepo, makeRun, nodeCheck, sh, tempRoot, write, type TestRun } from '../../unit/evidence/fixtures.ts';
import { cleanupCandidateCheckout, materializeCandidate } from '../../../src/evidence/candidate.ts';

const npmProbe = (() => {
  try {
    return execFileSync('npm', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
})();

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function baselineInput(t: ReturnType<typeof tempRoot>, repo: string, base: string, run: TestRun, over: Record<string, unknown> = {}) {
  return { db: run.db, run: { id: run.runId, policyHash: run.policyHash }, repoRoot: repo, baseRev: base, snapshot: run.snapshot, isolation: new NoIsolation(), runDir: run.runDir, clock: systemClock, pollMs: 20, killGraceMs: 500, homeDir: join(t.root, 'home'), ...over };
}

describe('runBaseline', () => {
  it('records pre-existing failures on the base revision and never blames them on the candidate', async () => {
    const t = tempRoot();
    const r = makeRepo(t.root);
    const run = makeRun(t.root, r.repo, [
      nodeCheck('lint', 'console.log("clean")'),
      nodeCheck('tests', 'console.error("Error: 2 tests were already broken"); process.exit(1)'),
      nodeCheck('extra', 'process.exit(1)', { mandatory: false }),
    ]);
    cleanups.push(() => run.db.close(), () => t.remove());

    const out = await runBaseline(baselineInput(t, r.repo, r.base, run));
    expect(out.reused).toBe(false);
    expect(out.report).toMatchObject({ schema: 'orbit.baseline/1', baseRevision: r.base, baseTree: r.baseTree, complete: true });
    expect(out.report.install.skipped).toBe(true);
    expect(out.report.checks.map((c) => [c.checkId, c.status, c.mandatory])).toEqual([['lint', 'PASSED', true], ['tests', 'FAILED', true]]);
    expect(out.report.failures).toHaveLength(1);
    expect(out.report.failures[0]).toMatchObject({ checkId: 'tests' });
    expect(out.report.failures[0]!.excerpt).toContain('2 tests were already broken');

    const onDisk = JSON.parse(readFileSync(join(run.runDir, 'baseline.json'), 'utf8'));
    expect(onDisk.failures[0].fingerprint).toBe(out.report.failures[0]!.fingerprint);
    const rows = listCheckRuns(run.db, { runId: run.runId, candidateId: null });
    expect(rows.map((x) => x.checkId).sort()).toEqual(['lint', 'tests']);
    expect(rows.every((x) => x.treeHash === r.baseTree && x.candidateId === null)).toBe(true);
    expect(out.results[0]!.binding.candidateId).toBe(`baseline:${r.baseTree}`);
    expect(listFailures(run.db, run.runId).map((f) => f.source)).toEqual(['baseline']);
    expect(run.db.get("SELECT 1 AS x FROM events WHERE type = 'baseline.recorded'")).toBeTruthy();
    // The throwaway checkout is gone.
    expect(sh(r.repo, 'worktree', 'list').trim().split('\n')).toHaveLength(1);

    const again = await runBaseline(baselineInput(t, r.repo, r.base, run));
    expect(again.reused).toBe(true);
    expect(again.report.failures).toEqual(out.report.failures);
    expect(listCheckRuns(run.db, { runId: run.runId })).toHaveLength(2);
  });

  it('runs the base revision\'s checks with the loopback permission their definitions carry', async () => {
    const t = tempRoot();
    const r = makeRepo(t.root);
    const run = makeRun(t.root, r.repo, [nodeCheck('serves', 'process.exit(0)', { local_binding: true }), nodeCheck('plain', 'process.exit(0)', { local_binding: false })]);
    cleanups.push(() => run.db.close(), () => t.remove());
    const isolation = recordingIsolation();
    await runBaseline(baselineInput(t, r.repo, r.base, run, { isolation }));
    expect(isolation.profiles.map((p) => p.allowLocalBinding).sort()).toEqual([false, true]);
  });

  it('runs only the requested checks and refuses ids the policy does not define', async () => {
    const t = tempRoot();
    const r = makeRepo(t.root);
    const run = makeRun(t.root, r.repo, [nodeCheck('a', ''), nodeCheck('b', 'process.exit(1)')]);
    cleanups.push(() => run.db.close(), () => t.remove());
    await expect(runBaseline(baselineInput(t, r.repo, r.base, run, { checkIds: ['ghost'] }))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    const out = await runBaseline(baselineInput(t, r.repo, r.base, run, { checkIds: ['a'] }));
    expect(out.report.checks.map((c) => c.checkId)).toEqual(['a']);
    expect(out.report.failures).toEqual([]);
  });

  it('is not complete, and not reused, when a check could not run', async () => {
    const t = tempRoot();
    const r = makeRepo(t.root);
    const run = makeRun(t.root, r.repo, [checkDef('broken', { command: ['no-such-binary-acme'] })]);
    cleanups.push(() => run.db.close(), () => t.remove());
    const out = await runBaseline(baselineInput(t, r.repo, r.base, run));
    expect(out.report.checks[0]!.status).toBe('ERROR');
    expect(out.report.complete).toBe(false);
    expect((await runBaseline(baselineInput(t, r.repo, r.base, run))).reused).toBe(false);
  });

  it('stops when cancelled and says the baseline is incomplete', async () => {
    const t = tempRoot();
    const r = makeRepo(t.root);
    const run = makeRun(t.root, r.repo, [nodeCheck('slow', 'setInterval(()=>{},1000)', { timeout_seconds: 60 })]);
    cleanups.push(() => run.db.close(), () => t.remove());
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 800);
    const out = await runBaseline(baselineInput(t, r.repo, r.base, run, { signal: ac.signal }));
    expect(out.report.complete).toBe(false);
    expect(out.results.map((x) => x.status)).toEqual(['CANCELLED']);
    expect(out.report.failures).toEqual([]);
  });

  it('rejects a tampered snapshot and a bad revision', async () => {
    const t = tempRoot();
    const r = makeRepo(t.root);
    const run = makeRun(t.root, r.repo, [nodeCheck('a', '')]);
    cleanups.push(() => run.db.close(), () => t.remove());
    const bad = JSON.parse(JSON.stringify(run.snapshot));
    bad.config.checks.a.command = ['sh', '-c', 'echo pwned'];
    await expect(runBaseline(baselineInput(t, r.repo, r.base, run, { snapshot: bad }))).rejects.toMatchObject({ code: 'POLICY_TAMPERED' });
    await expect(runBaseline(baselineInput(t, r.repo, 'nope', run))).rejects.toMatchObject({ code: 'GIT_FAILED' });
  });
});

describe.skipIf(!npmProbe)(npmProbe ? 'dependency install from the lockfile' : 'dependency install skipped: npm is not available', () => {
  /** A project with one local tarball dependency whose postinstall leaves a marker, and a real package-lock.json. */
  function npmProject(root: string) {
    const files: Record<string, string> = {};
    const vendor = join(root, 'pkgsrc');
    write(join(vendor, 'package.json'), JSON.stringify({ name: 'acme-local', version: '1.0.0', main: 'index.js', scripts: { postinstall: "node -e \"require('fs').writeFileSync('postinstall-ran','x')\"" } }));
    write(join(vendor, 'index.js'), 'module.exports = 42;\n');
    const npmEnv = { PATH: process.env.PATH ?? '', HOME: join(root, 'npmhome'), npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' };
    mkdirSync(npmEnv.HOME, { recursive: true });
    const tgz = execFileSync('npm', ['pack', '--silent', '--pack-destination', root], { cwd: vendor, env: npmEnv, encoding: 'utf8' }).trim();
    const project = join(root, 'project');
    write(join(project, 'package.json'), JSON.stringify({ name: 'acme-app', version: '1.0.0', private: true, dependencies: { 'acme-local': 'file:./vendor/acme-local-1.0.0.tgz' } }));
    write(join(project, 'vendor', tgz), '');
    execFileSync('cp', [join(root, tgz), join(project, 'vendor', tgz)]);
    execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--offline'], { cwd: project, env: npmEnv, stdio: 'ignore' });
    for (const f of ['package.json', 'package-lock.json']) files[f] = readFileSync(join(project, f), 'utf8');
    files[`vendor/${tgz}`] = '';
    return { project, tgz, files };
  }

  async function installIn(scripts: OrbitConfig['dependencies']['install_scripts'], allowlist: string[]) {
    const t = tempRoot();
    cleanups.push(() => t.remove());
    const { project, tgz } = npmProject(t.root);
    // Track the project as a repository so the checkout is a real candidate checkout.
    const { sh: git } = await import('../../unit/evidence/fixtures.ts');
    git(project, 'init', '-q', '-b', 'main');
    git(project, 'add', '-A');
    git(project, 'commit', '-qm', 'init');
    expect(existsSync(join(project, 'vendor', tgz))).toBe(true);
    const run = makeRun(t.root, project, [nodeCheck('probe', 'console.log("dep=" + require("acme-local"))')], {
      configure: (c) => {
        c.dependencies.install_scripts = scripts;
        c.dependencies.install_script_allowlist = allowlist;
      },
    });
    cleanups.push(() => run.db.close());
    const base = git(project, 'rev-parse', 'HEAD').trim();
    const baseTree = git(project, 'rev-parse', 'HEAD^{tree}').trim();
    const dir = await materializeCandidate(project, base, join(t.root, 'co'), { readOnly: false });
    cleanups.push(() => cleanupCandidateCheckout(project, dir));
    const outcome = await installDependencies({
      db: run.db, run: { id: run.runId, policyHash: run.policyHash }, snapshot: run.snapshot, isolation: new NoIsolation(),
      checkoutDir: dir, runDir: run.runDir, clock: systemClock, pollMs: 20, killGraceMs: 500, homeDir: join(t.root, 'home'), baseTree,
    });
    const marker = join(dir, 'node_modules', 'acme-local', 'postinstall-ran');
    return { outcome, marker, dir, run, t, project };
  }

  it('installs from the lockfile with scripts denied by default', async () => {
    const { outcome, marker, dir } = await installIn('deny', []);
    expect(outcome).toMatchObject({ skipped: false, ok: true });
    expect(outcome.results.map((r) => r.command)).toEqual([['npm', 'ci', '--ignore-scripts']]);
    expect(readFileSync(join(dir, 'node_modules', 'acme-local', 'index.js'), 'utf8')).toContain('42');
    expect(existsSync(marker)).toBe(false);
  });

  it('lets scripts run only when policy allows them', async () => {
    const { outcome, marker } = await installIn('allow', []);
    expect(outcome.results.map((r) => r.command)).toEqual([['npm', 'ci']]);
    expect(existsSync(marker)).toBe(true);
  });

  it('runs scripts of allowlisted packages only, after an install that ran none', async () => {
    const { outcome, marker } = await installIn('deny-unless-allowlisted', ['acme-local']);
    expect(outcome.ok).toBe(true);
    expect(outcome.results.map((r) => r.command)).toEqual([['npm', 'ci', '--ignore-scripts'], ['npm', 'rebuild', 'acme-local']]);
    expect(existsSync(marker)).toBe(true);
    const none = await installIn('deny-unless-allowlisted', []);
    expect(none.outcome.results.map((r) => r.command)).toEqual([['npm', 'ci', '--ignore-scripts']]);
    expect(existsSync(none.marker)).toBe(false);
  });

  it('reports a failed install and runs no baseline checks on top of it', async () => {
    const t = tempRoot();
    cleanups.push(() => t.remove());
    const { project } = npmProject(t.root);
    writeFileSync(join(project, 'package-lock.json'), '{ not json');
    sh(project, 'init', '-q', '-b', 'main');
    sh(project, 'add', '-A');
    sh(project, 'commit', '-qm', 'broken lock');
    const run = makeRun(t.root, project, [nodeCheck('probe', 'console.log("ran")')]);
    cleanups.push(() => run.db.close());
    const out = await runBaseline(baselineInput(t, project, sh(project, 'rev-parse', 'HEAD').trim(), run));
    expect(out.report.install).toMatchObject({ skipped: false, ok: false });
    expect(out.report.checks).toEqual([]);
    expect(out.report.complete).toBe(false);
    expect(listFailures(run.db, run.runId).map((f) => f.source)).toEqual(['install']);
  });

  it('runs the baseline checks against the installed tree', async () => {
    const t = tempRoot();
    cleanups.push(() => t.remove());
    const { project } = npmProject(t.root);
    sh(project, 'init', '-q', '-b', 'main');
    sh(project, 'add', '-A');
    sh(project, 'commit', '-qm', 'init');
    const run = makeRun(t.root, project, [nodeCheck('probe', 'console.log("dep=" + require("acme-local"))')]);
    cleanups.push(() => run.db.close());
    const out = await runBaseline(baselineInput(t, project, sh(project, 'rev-parse', 'HEAD').trim(), run));
    expect(out.report.install).toMatchObject({ skipped: false, ok: true });
    expect(out.report.checks[0]).toMatchObject({ checkId: 'probe', status: 'PASSED' });
    expect(readFileSync(out.results[0]!.logPath, 'utf8')).toContain('dep=42');
    expect(out.report.complete).toBe(true);
  });
});
