// `orbit release resolve` (docs/gaps.md G51): settle a deploy whose outcome is unknown, by the environment's
// verify_command or by what a person found out.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { systemClock } from '../../../src/core/clock.ts';
import { defaultConfig } from '../../../src/policy/config.ts';
import type { OrbitConfig } from '../../../src/policy/types.ts';
import { startRun } from '../../../src/controller/start.ts';
import { ActionLedger } from '../../../src/delivery/actions.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { getRun } from '../../../src/controller/run-store.ts';
import { makeLab, type Lab } from './lab.ts';

const labs: Lab[] = [];
const scratch: string[] = [];
afterEach(() => {
  labs.splice(0).forEach((l) => l.close());
  scratch.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const node = process.execPath;

interface Setup {
  l: Lab;
  runId: string;
  sha: string;
  ledger: ActionLedger;
  deployDir: string;
}

/** A release-mode run with a deploy to "staging" that started and left no outcome. */
function unknownDeploy(opts: { verify?: string[] | null; envName?: string } = {}): Setup {
  const l = makeLab();
  labs.push(l);
  const config: OrbitConfig = defaultConfig('release');
  config.actions = { ...config.actions, merge: true, deploy_production: true };
  config.isolation = { ...config.isolation, provider: 'none', allow_unisolated: true };
  config.release = {
    merge: { method: 'squash', require_checks: [], delete_branch: false, mark_ready: true },
    environments: { staging: { deploy_command: [node, '-e', '0'], allowed_branches: ['main'], require_ci_green: false, network_hosts: [], timeout_seconds: 30, verify_command: opts.verify ?? null } },
  };
  const run = startRun({ db: l.db(), repoRoot: l.repo, goal: 'Release the acme widget', config, clock: systemClock });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: l.repo, encoding: 'utf8' }).trim();
  const ledger = new ActionLedger(l.db(), systemClock, { runDir: join(l.repo, '.orbit', 'runs', run.id) });
  const created = ledger.recordIntent({ runId: run.id, kind: 'deploy', idempotencyKey: `release:${run.id}:deploy:staging:${sha}`, target: { environment: 'staging', branch: 'main', sha, command: ['node'] }, treeHash: 'a'.repeat(40), commitSha: sha });
  ledger.markUnknown(ledger.markExecuting(created.action), 'controller stopped while the deploy ran');
  const deployDir = join(l.repo, '.orbit', 'runs', run.id, 'release', `deploy-staging-${sha.slice(0, 12)}`);
  mkdirSync(deployDir, { recursive: true });
  writeFileSync(join(deployDir, 'started.json'), JSON.stringify({ environment: 'staging', sha, attempt: 1 }));
  l.moveTo(run.id, ['PREFLIGHT', 'BLOCKED']);
  return { l, runId: run.id, sha, ledger, deployDir };
}

const action = (s: Setup) => s.ledger.list(s.runId, { kind: 'deploy' })[0]!;

describe('orbit release resolve', () => {
  it('--deployed adopts the deploy: the action has its receipt, the run is told to resume, and a decision records who said so', async () => {
    const s = unknownDeploy();
    const r = await s.l.cli(['release', 'resolve', s.runId, '--deployed', '--by', 'acme-operator']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/DEPLOYED \(it will not run again\)/);
    expect(r.out).toContain(`orbit resume ${s.runId}`);
    expect(action(s)).toMatchObject({ state: 'SUCCEEDED', receipt: { environment: 'staging', sha: s.sha, exitCode: 0 } });
    const [d] = listDecisions(s.l.db(), s.runId, { kind: 'release.deploy-resolved' });
    expect(d?.summary).toMatch(/resolved as deployed by acme-operator/);
    expect(getRun(s.l.db(), s.runId).state).toBe('BLOCKED');
  });

  it('--not-deployed forgets that it started, so the next release attempt may run it', async () => {
    const s = unknownDeploy();
    const r = await s.l.cli(['release', 'resolve', s.runId, '--not-deployed', '--json']);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ verdict: 'not-deployed', via: 'person', environment: 'staging', sha: s.sha });
    expect(existsSync(join(s.deployDir, 'started.json'))).toBe(false);
    expect(action(s).state).toBe('UNKNOWN');
  });

  it('with no flag it runs the environment\'s verify_command: exit 0 is deployed, exit 1 is not deployed', async () => {
    const yes = unknownDeploy({ verify: [node, '-e', 'process.exit(0)'] });
    const a = await yes.l.cli(['release', 'resolve', yes.runId]);
    expect(a.code, a.err).toBe(0);
    expect(a.out).toMatch(/DEPLOYED/);
    expect(action(yes).state).toBe('SUCCEEDED');
    expect(action(yes).receipt).toMatchObject({ isolation: 'verify_command' });

    const no = unknownDeploy({ verify: [node, '-e', 'process.exit(1)'] });
    const b = await no.l.cli(['release', 'resolve', no.runId]);
    expect(b.code, b.err).toBe(0);
    expect(b.out).toMatch(/NOT DEPLOYED/);
    expect(action(no).state).toBe('UNKNOWN');
    expect(existsSync(join(no.deployDir, 'started.json'))).toBe(false);
  });

  it('the verify_command runs in a checkout of the deployed commit and sees its sha and environment', async () => {
    const out = join(realpathSync(mkdtempSync(join(tmpdir(), 'orbit-verify-'))), 'seen.txt');
    scratch.push(dirname(out));
    const verify = [node, '-e', `const fs=require('fs');fs.writeFileSync(${JSON.stringify(out)}, [process.env.ORBIT_RELEASE_SHA, process.env.ORBIT_RELEASE_ENVIRONMENT, process.env.ORBIT_RELEASE_VERIFY, fs.existsSync('README.md')].join(' '));`];
    const s = unknownDeploy({ verify });
    const r = await s.l.cli(['release', 'resolve', s.runId, '--json']);
    expect(r.code, r.err).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe(`${s.sha} staging 1 true`);
  });

  it('a verify_command that cannot tell, or no verify_command, changes nothing and exits 1 telling the person what to run', async () => {
    const cannot = unknownDeploy({ verify: [node, '-e', 'process.exit(3)'] });
    const a = await cannot.l.cli(['release', 'resolve', cannot.runId]);
    expect(a.code).toBe(1);
    expect(a.out).toMatch(/still unknown: verify_command exited 3/);
    expect(a.out).toContain(`orbit release resolve ${cannot.runId} --deployed`);
    expect(action(cannot).state).toBe('UNKNOWN');
    expect(existsSync(join(cannot.deployDir, 'started.json'))).toBe(true);

    const none = unknownDeploy();
    const b = await none.l.cli(['release', 'resolve', none.runId]);
    expect(b.code).toBe(1);
    expect(b.out).toMatch(/has no verify_command/);
    expect(action(none).state).toBe('UNKNOWN');
  });

  it('refuses contradictory flags, a run with nothing to resolve, a finished run, and a worker', async () => {
    const s = unknownDeploy();
    const both = await s.l.cli(['release', 'resolve', s.runId, '--deployed', '--not-deployed']);
    expect(both.code).toBe(2);

    const wrong = await s.l.cli(['release', 'resolve', s.runId, '--deployed', '--environment', 'production']);
    expect(wrong.code).toBe(3);
    expect(wrong.err).toMatch(/no deploy with an unknown outcome to production/);
    expect(action(s).state).toBe('UNKNOWN');

    const worker = await s.l.cli(['release', 'resolve', s.runId, '--deployed'], { env: { ...process.env, ORBIT_WORKER: '1' } });
    expect(worker.code).toBe(4);
    expect(action(s).state).toBe('UNKNOWN');

    await s.l.cli(['release', 'resolve', s.runId, '--deployed']);
    const again = await s.l.cli(['release', 'resolve', s.runId, '--deployed']);
    expect(again.code).toBe(3);

    const plain = makeLab();
    labs.push(plain);
    const r = plain.newRun();
    plain.moveTo(r.id, ['PREFLIGHT', 'BLOCKED', 'CANCELLED']);
    const done = await plain.cli(['release', 'resolve', r.id, '--deployed']);
    expect(done.code).toBe(5);
  });

  it('is listed in the help text', async () => {
    const l = makeLab();
    labs.push(l);
    expect((await l.cli(['help'])).out).toMatch(/release resolve/);
    expect((await l.cli(['release'])).err).toMatch(/needs a subcommand: resolve/);
  });
});
