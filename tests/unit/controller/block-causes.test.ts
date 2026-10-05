// Block and stop messages name the real cause and the real way forward (P12, P17): a block that comes from the
// run's frozen policy says a new run is needed (editing the config cannot change a running run), a non-progress
// stop is not reported as a spent budget, and the next action does not repeat itself.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getRun } from '../../../src/controller/run-store.ts';
import { finishRun, frozenPolicyCause, outcomeForError } from '../../../src/controller/steps/common.ts';
import { OrbitError } from '../../../src/core/errors.ts';
import { makeUnitLab, type UnitLab } from './coverage-helpers.ts';

let lab: UnitLab;
afterEach(() => lab?.cleanup());

const nextAction = (runDir: string): string => (JSON.parse(readFileSync(join(runDir, 'final.json'), 'utf8')) as { next_action: string }).next_action;

const MODEL_NULL =
  'independent review unavailable: independent review is required (review.independent_provider_required=true, fallback_same_provider_allowed=false) and no independent reviewer is usable: "codex" has no model qualified for review. Review is not being substituted by "claude" or any equivalent label; verification is incomplete until an independent provider is available.';

describe('blocks caused by the frozen policy', () => {
  it('recognizes settings that live in the policy snapshot', () => {
    expect(frozenPolicyCause(MODEL_NULL)).toMatch(/providers\.codex\.model/);
    expect(frozenPolicyCause('environment gate: independent review: providers.codex.data_policy_eligible is not true, so the review packet may not be sent to it')).toMatch(/providers\.codex\.data_policy_eligible/);
    expect(frozenPolicyCause('CONTRACT_INVALID: no proposed path lies inside the policy scope (apps/**)')).toMatch(/scope\.allowed_paths/);
    expect(frozenPolicyCause('x', 'CONFIG_INVALID')).not.toBeNull();
    expect(frozenPolicyCause('Blocked: the claude credentials were rejected while a worker was running')).toBeNull();
    expect(frozenPolicyCause('CI was cancelled on abc; re-run it and resume the run')).toBeNull();
  });

  it('a reviewer block from a null providers.codex.model says the run needs a new run, records why, and the next action says so', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const ctx = lab.ctx();
    await finishRun(ctx, 'BLOCKED', MODEL_NULL);
    const run = getRun(lab.db, lab.runId);
    expect(run.outcomeReason).toMatch(/frozen policy/);
    expect(run.outcomeReason).toMatch(/new run/);
    expect(JSON.parse(run.outcomeJson!)).toMatchObject({ frozen_policy: { setting: expect.stringMatching(/providers\.codex\.model/) } });
    const next = nextAction(ctx.runDir);
    expect(next).toMatch(/new run/);
    expect(next).not.toMatch(/Resolve that, then run `orbit resume/);
  });

  it('a policy-scope contract failure is a frozen-policy block too', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING'] });
    const ctx = lab.ctx();
    await outcomeForError(ctx, new OrbitError('CONTRACT_INVALID', 'no proposed path lies inside the policy scope (apps/**, tests/**): .github/** was dropped (not inside the policy scope)'));
    const run = getRun(lab.db, lab.runId);
    expect(run.state).toBe('BLOCKED');
    expect(JSON.parse(run.outcomeJson!)).toHaveProperty('frozen_policy');
  });

  it('an environment block keeps the resume guidance, said once', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const ctx = lab.ctx();
    await finishRun(ctx, 'BLOCKED', `CI was cancelled on abc; re-run it and then orbit resume ${lab.runId}`);
    const run = getRun(lab.db, lab.runId);
    expect(run.outcomeJson).not.toContain('frozen_policy');
    const next = nextAction(ctx.runDir);
    expect(next.match(/orbit resume/g)).toHaveLength(1);
  });
});

describe('non-progress stops', () => {
  it('an EXHAUSTED non-progress stop is not reported as a spent budget', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const ctx = lab.ctx();
    await finishRun(ctx, 'EXHAUSTED', 'non-progress: 2 consecutive attempts made no progress: no measurable progress (same tree as attempt 1); more attempts, tokens or lines would not change that', {
      outcome: { non_progress: { terminate: true, consecutiveNoProgress: 2 } },
    });
    const next = nextAction(ctx.runDir);
    expect(next).not.toMatch(/budget is spent/);
    expect(next).toMatch(/no measurable progress \(same tree as attempt 1\)/);
  });
});
