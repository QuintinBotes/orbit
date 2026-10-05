import { afterEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from '../../../src/adapters/fake.ts';
import { readExitRecord } from '../../../src/adapters/shim.ts';
import { getRun } from '../../../src/controller/run-store.ts';
import { classifyFailure, decideRetry } from '../../../src/recovery/backoff.ts';
import { blockRunOnCredentials, checkRunCredentials } from '../../../src/recovery/credentials.ts';
import { reconcileOnStart } from '../../../src/recovery/reconcile.ts';
import { FAKE_CLAUDE, FAKE_CODEX, writeScenario } from '../adapters/helpers.ts';
import { OWNER, canStripTypes, cleanupAll, clock, makeEnv, makeRun, startWorker, waitFor, workerRow, seedCounters, counterUsed, type Env } from './helpers.ts';

afterEach(cleanupAll);

function fakes(env: Env) {
  const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME, ORBIT_FAKE_SCENARIO: env.f.scenarioPath };
  return {
    claude: new FakeAdapter({ provider: 'claude', script: FAKE_CLAUDE, baseEnv }),
    codex: new FakeAdapter({ provider: 'codex', script: FAKE_CODEX, baseEnv }),
  };
}

describe.skipIf(!canStripTypes)('expired credentials produce a truthful blocker (scenario 12)', () => {
  it('a worker that is rejected for its credentials ends the run BLOCKED, naming the provider and the command; nothing is retried or restarted', async () => {
    const env = makeEnv();
    makeRun(env);
    seedCounters(env, { recovery_attempts: 3, infrastructure_retries: 5 });
    await startWorker(env, { outcome: 'auth_failure', hangAfterRetry: 30_000 });
    await waitFor(() => readExitRecord(env.f.workerDir), 30_000);

    // Recovery collects the failed worker...
    const rep = await reconcileOnStart({ db: env.db, ownerId: OWNER, clock, adapters: env.adapters, graceMs: 300 });
    expect(rep.runs[0]!.workers[0]).toMatchObject({ observation: 'finished', state: 'FAILED', restartPlanned: false });
    expect(workerRow(env)).toMatchObject({ state: 'FAILED', result_status: 'auth_failed' });

    // ...and the failure classifies as authentication: the decision is to block, never to retry.
    const signal = { status: workerRow(env).result_status };
    const decision = decideRetry({ classification: classifyFailure(signal), provider: 'claude', runId: env.runId, attempt: 1, infrastructureRetriesRemaining: 5, wallRemainingMs: 3_600_000, costRemainingUsd: 10 });
    expect(decision.action).toBe('block');
    if (decision.action !== 'block') return;
    const out = blockRunOnCredentials(env.db, clock, OWNER, env.runId, decision.blocker);
    expect(out.outcome).toBe('blocked');

    const run = getRun(env.db, env.runId);
    expect(run.state).toBe('BLOCKED');
    expect(run.outcomeReason).toContain('claude credentials were rejected');
    expect(run.outcomeReason).toContain('`claude auth login`');
    expect(run.outcomeReason).toContain(`orbit resume ${env.runId}`);
    expect(counterUsed(env, 'infrastructure_retries')).toBe(0);
    expect(counterUsed(env, 'recovery_attempts')).toBe(0);
    expect(workerRow(env).restart_count).toBe(0);
  });

  it('periodic validation blocks a run whose provider has no usable credential, for each provider kind', async () => {
    const env = makeEnv();
    makeRun(env);
    const a = fakes(env);
    // Logged out: claude reports no credential.
    writeScenario(env.f, { auth: { loggedIn: false } });
    const missing = await checkRunCredentials({ db: env.db, clock, ownerId: OWNER, runId: env.runId, adapters: a, providers: ['claude'], env: {} });
    expect(missing.checks[0]).toMatchObject({ provider: 'claude', verdict: 'blocked', status: { state: 'missing' } });
    expect(missing.blocked?.outcome).toBe('blocked');
    const run = getRun(env.db, env.runId);
    expect(run.state).toBe('BLOCKED');
    expect(run.outcomeReason).toMatch(/claude credentials are missing/);
    expect(run.outcomeReason).toContain('`claude auth login`');

    // The same run, resumed and checked again for the reviewer's provider: a credential codex itself rejects.
    const env2 = makeEnv();
    makeRun(env2);
    const b = fakes(env2);
    writeScenario(env2.f, { auth: { loggedIn: true, method: 'api_key', valid: false } });
    const invalid = await checkRunCredentials({ db: env2.db, clock, ownerId: OWNER, runId: env2.runId, adapters: b, providers: ['codex'] });
    expect(invalid.checks[0]).toMatchObject({ provider: 'codex', verdict: 'blocked', status: { state: 'invalid' } });
    expect(getRun(env2.db, env2.runId).outcomeReason).toContain('`codex login`');
  });

  it('a credential the cheap check cannot verify does not block, and is reported as unverified rather than valid', async () => {
    const env = makeEnv();
    makeRun(env);
    const a = fakes(env);
    writeScenario(env.f, { auth: { loggedIn: true, authMethod: 'claude.ai' } });
    const rep = await checkRunCredentials({ db: env.db, clock, ownerId: OWNER, runId: env.runId, adapters: a, providers: ['claude'] });
    expect(rep.checks[0]!.verdict).toBe('unverified');
    expect(rep.blocked).toBeNull();
    expect(getRun(env.db, env.runId).state).toBe('IMPLEMENTING');
  });
});
