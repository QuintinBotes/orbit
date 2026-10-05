// `orbit run --environment <name>` (docs/gaps.md G50): the run names the one release environment it deploys to.
// The name is checked against the policy before any state exists; the run keeps it, and its contract carries it.
import { afterEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { defaultConfig } from '../../../src/policy/config.ts';
import type { OrbitConfig } from '../../../src/policy/types.ts';
import { getRun } from '../../../src/controller/run-store.ts';
import { makeLab, type Lab } from './lab.ts';

const labs: Lab[] = [];
afterEach(() => labs.splice(0).forEach((l) => l.close()));

const node = process.execPath;

function releasePolicy(l: Lab): string {
  const config: OrbitConfig = defaultConfig('release');
  config.actions = { ...config.actions, merge: true, deploy_production: true };
  config.isolation = { ...config.isolation, provider: 'none', allow_unisolated: true };
  const env = { deploy_command: [node, '-e', '0'], allowed_branches: ['main'], require_ci_green: false, network_hosts: [], timeout_seconds: 30, verify_command: null };
  config.release = { merge: { method: 'squash', require_checks: [], delete_branch: false, mark_ready: true }, environments: { staging: env, canary: env } };
  // Outside the repository: an untracked file inside it would be an uncommitted change, which `orbit run` now refuses before creating a run.
  const file = join(l.base, 'release-policy.yaml');
  writeFileSync(file, stringify(config));
  return file;
}

const runCount = (l: Lab): number => l.db().get<{ n: number }>('SELECT COUNT(*) AS n FROM runs')!.n;

describe('orbit run --environment', () => {
  it('records the environment on the run and in the created event, and says so', async () => {
    const l = makeLab();
    labs.push(l);
    const policy = releasePolicy(l);
    const r = await l.cli(['run', '--goal', 'Ship the acme widget', '--detach', '--json', '--policy', policy, '--environment', 'canary']);
    expect(r.code, r.err).toBe(0);
    const out = JSON.parse(r.out) as { run_id: string; environment?: string };
    expect(out.environment).toBe('canary');
    expect(getRun(l.db(), out.run_id).environment).toBe('canary');
    const created = l.db().get<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'run.created'", out.run_id)!;
    expect(JSON.parse(created.data_json)).toMatchObject({ environment: 'canary' });

    const text = await l.cli(['run', '--goal', 'Ship the acme widget again', '--detach', '--policy', policy, '--environment', 'staging']);
    expect(text.out).toMatch(/run orb-\S+ created \(release, environment staging\), handed to the service/);
  });

  it('without --environment the run names none', async () => {
    const l = makeLab();
    labs.push(l);
    const r = await l.cli(['run', '--goal', 'Ship the acme widget', '--detach', '--json', '--policy', releasePolicy(l)]);
    const out = JSON.parse(r.out) as { run_id: string; environment?: string };
    expect(out.environment).toBeUndefined();
    expect(getRun(l.db(), out.run_id).environment).toBeNull();
  });

  it('refuses an environment the release profile does not define, naming the defined ones, before any run exists', async () => {
    const l = makeLab();
    labs.push(l);
    const policy = releasePolicy(l);
    const r = await l.cli(['run', '--goal', 'Ship the acme widget', '--detach', '--policy', policy, '--environment', 'production']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/--environment production: "production" is not defined in release\.environments \(defined: staging, canary\)/);
    expect(runCount(l)).toBe(0);
  });

  it('refuses an environment when the policy is not in release mode', async () => {
    const l = makeLab();
    labs.push(l);
    await l.cli(['init']);
    const r = await l.cli(['run', '--goal', 'Ship the acme widget', '--detach', '--environment', 'staging']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/--environment staging: a release environment can be named only in mode release/);
    expect(runCount(l)).toBe(0);
  });

  it('is listed in the help for run and not offered by repair', async () => {
    const l = makeLab();
    labs.push(l);
    const run = await l.cli(['run', '--help']);
    expect(run.out).toMatch(/--environment <name>/);
    const repair = await l.cli(['repair', '--help']);
    expect(repair.out).not.toMatch(/--environment/);
  });
});
