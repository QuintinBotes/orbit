/**
 * Issue #22: a worker session Orbit refuses after it started (a plugin the policy does not allow, an MCP server,
 * another permission mode) ran in an environment the next session shares, so it is not transient and not a worker
 * attempt to spend again. The run ends BLOCKED at once, the outcome line carries the refusal in full (it was cut at
 * 200 characters, mid-sentence) and says which command shows the cause, and a run that ended this way produced
 * nothing for the curator to learn from.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { isSessionRefusal } from '../../../src/adapters/types.ts';
import { getRun } from '../../../src/controller/run-store.ts';
import { frozenPolicyCause, withSentence, handleWorkerFailure } from '../../../src/controller/steps/common.ts';
import { makeUnitLab, type UnitLab } from './coverage-helpers.ts';

let lab: UnitLab;
afterEach(() => lab?.cleanup());

const events = (type: string): { data_json: string | null }[] => lab.db.all('SELECT data_json FROM events WHERE run_id = ? AND type = ? ORDER BY id', lab.runId, type);

const IDS = ['acme-audit@acme-it', 'acme-guard@acme-it', 'acme-lint@acme-it', 'acme-notes@acme-it'];
const REFUSAL = `the session loaded ${IDS.length} plugin(s) that are not Claude Code built-ins and that the policy does not allow: ${IDS.map((id) => `${id} (scope managed; allow it with agents.allowed_plugins: ${JSON.stringify([id])} or agents.allow_managed_plugins: true)`).join('; ')}`;

describe('isSessionRefusal', () => {
  it('is a failed session whose end reason says Orbit refused it', () => {
    expect(isSessionRefusal({ status: 'failed', reason: 'unsafe_session' })).toBe(true);
    expect(isSessionRefusal({ status: 'failed', reason: 'crashed' })).toBe(false);
    expect(isSessionRefusal({ status: 'failed' })).toBe(false);
    expect(isSessionRefusal({ status: 'succeeded', reason: 'unsafe_session' })).toBe(false);
  });
});

describe('handleWorkerFailure on a refused session', () => {
  const opts = { attemptsUsed: 1, maxAttempts: 3, what: 'the planner', base: 'plan', purpose: 'plan#1' };

  it('does not retry it while attempts remain, and blocks the run once', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const out = await handleWorkerFailure(lab.ctx(), { provider: 'claude', status: 'failed', error: REFUSAL, reason: 'unsafe_session' }, opts);
    expect(out).toMatchObject({ retry: false, result: { done: true } });
    expect(getRun(lab.db, lab.runId).state).toBe('BLOCKED');
    expect(events('worker.regenerate'), 'no regeneration was spent').toEqual([]);
    expect(events('worker.retry'), 'no infrastructure retry was spent').toEqual([]);
  });

  it('names every refused plugin and the line that allows it without cutting the refusal, and says which command shows the cause', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    expect(REFUSAL.length).toBeGreaterThan(400);
    await handleWorkerFailure(lab.ctx(), { provider: 'claude', status: 'failed', error: REFUSAL, reason: 'unsafe_session' }, opts);
    const run = getRun(lab.db, lab.runId);
    const reason = run.outcomeReason ?? '';
    expect(reason).toContain(REFUSAL);
    expect(reason).toContain('orbit doctor');
    expect(reason).toMatch(/^the planner: its session was refused after it started and was not retried/);
    expect(reason).not.toContain('no usable result');
    // The marker the final report and the learning layer read.
    expect(JSON.parse(run.outcomeJson ?? '{}')).toMatchObject({ worker_refusal: { what: 'the planner', error: REFUSAL } });
  });

  it('a plugin refusal comes from the frozen policy, so the block says a new run is the way out', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    await handleWorkerFailure(lab.ctx(), { provider: 'claude', status: 'failed', error: REFUSAL, reason: 'unsafe_session' }, opts);
    const run = getRun(lab.db, lab.runId);
    expect(run.outcomeReason).toContain('frozen policy');
    expect(run.outcomeReason).toContain(`orbit cancel ${lab.runId}`);
    expect(JSON.parse(run.outcomeJson ?? '{}')).toHaveProperty('frozen_policy');
  });

  it('a failure with another reason is regenerated within the limit, as before', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    expect(await handleWorkerFailure(lab.ctx(), { provider: 'claude', status: 'failed', error: 'boom', reason: 'crashed' }, opts)).toEqual({ retry: true });
    expect(events('worker.regenerate')).toHaveLength(1);
    expect(getRun(lab.db, lab.runId).state).toBe('PREFLIGHT');
  });
});

describe('frozenPolicyCause for a plugin refusal', () => {
  it('recognises both wordings: the one at run start and the one from a refused session', () => {
    expect(frozenPolicyCause('workers would load 2 plugin(s) the policy does not allow, so every worker session would be refused: a@m (scope managed)')).toMatch(/agents\.allowed_plugins/);
    expect(frozenPolicyCause(`the planner: ... ${REFUSAL}`)).toMatch(/agents\.allowed_plugins/);
    expect(frozenPolicyCause('the session ran in permission mode default, not dontAsk')).toBeNull();
  });

  it('names agents.allow_managed_plugins only when a refused plugin is managed: it cannot admit a synced or user plugin', () => {
    expect(frozenPolicyCause('workers would load 1 plugin(s) the policy does not allow, so every worker session would be refused: slack@synced (scope synced); fix: add to .orbit/config.yaml: agents.allowed_plugins: ["slack@synced"]')).toBe('agents.allowed_plugins');
    expect(frozenPolicyCause('workers would load 1 plugin(s) the policy does not allow, so every worker session would be refused: a@m (scope managed); fix: add to .orbit/config.yaml: agents.allowed_plugins: ["a@m"] (or agents.allow_managed_plugins: true for every managed plugin)')).toBe('agents.allowed_plugins or agents.allow_managed_plugins');
  });
});

describe('withSentence', () => {
  it('starts the advice as its own sentence whether or not the reason ends with a full stop', () => {
    expect(withSentence('a plugin can add hooks and tools to workers', 'This comes from the policy.')).toBe('a plugin can add hooks and tools to workers. This comes from the policy.');
    expect(withSentence('agents.allowed_plugins: ["x"])', 'This comes.')).toBe('agents.allowed_plugins: ["x"]). This comes.');
    expect(withSentence('already ends.', 'This comes.')).toBe('already ends. This comes.');
  });
});
