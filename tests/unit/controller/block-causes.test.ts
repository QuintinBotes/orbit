// Block and stop messages name the real cause and the real way forward (P12, P17): a block that comes from the
// run's frozen policy says a new run is needed (editing the config cannot change a running run), a non-progress
// stop is not reported as a spent budget, and the next action does not repeat itself.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { frozenPolicySetting } from '../../../src/controller/resume.ts';
import { getRun } from '../../../src/controller/run-store.ts';
import { finishRun, frozenPolicyCause, outcomeForError } from '../../../src/controller/steps/common.ts';
import { OrbitError } from '../../../src/core/errors.ts';
import { makeUnitLab, type UnitLab } from './coverage-helpers.ts';
import { insertQuestion } from '../../../src/inquisition/store.ts';

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

  it('a block that brings its own advice gets it in place of the generic one, and is still a frozen-policy block that resume refuses', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING'] });
    const ctx = lab.ctx();
    await finishRun(ctx, 'BLOCKED', 'Check lint is misconfigured, not a pre-existing failure: its command names something that does not exist.', { frozenAdvice: 'Start a new run whose goal says it creates the target.' });
    const run = getRun(lab.db, lab.runId);
    expect(run.outcomeReason).toBe('Check lint is misconfigured, not a pre-existing failure: its command names something that does not exist. Start a new run whose goal says it creates the target.');
    expect(run.outcomeReason).not.toMatch(/This comes from the run's frozen policy|--force/);
    expect(JSON.parse(run.outcomeJson!)).toMatchObject({ frozen_policy: { setting: 'checks.lint.command' } });
    expect(frozenPolicySetting(run)).toBe('checks.lint.command');
    // The next action is the reason itself: it already names the way forward.
    expect(nextAction(ctx.runDir)).toBe(run.outcomeReason);
  });

  it('the advice is the end of the reason, so the cap on the stored reason cuts the evidence before it, never the way forward', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING'] });
    const ctx = lab.ctx();
    // Several checks with long log paths: the evidence alone is longer than the cap.
    const evidence = Array.from({ length: 12 }, (_, i) => `"error: no such command: \`tool${i}\`", command in checks.c${i}.command, output in /orbit/runs/acme/baseline/${'deep/'.repeat(12)}c${i}.log`).join('; ');
    const reason = `Checks c0, c1 are misconfigured, not a pre-existing failure: ${evidence}.`;
    const advice = 'Fix, by cause: say so in the goal of a new run; or install it and start a new run. Resuming this run would only block again, so cancel it (orbit cancel orb-9) and start the new run with orbit run.';
    expect(reason.length + advice.length).toBeGreaterThan(2000);
    await finishRun(ctx, 'BLOCKED', reason, { frozenAdvice: advice });
    const run = getRun(lab.db, lab.runId);
    expect(run.outcomeReason!.length).toBeLessThanOrEqual(2000);
    expect(run.outcomeReason!.endsWith(advice)).toBe(true);
    expect(run.outcomeReason).toMatch(/^Checks c0, c1 are misconfigured/);
    // The record keeps the whole reason.
    expect((JSON.parse(run.outcomeJson!) as { reason: string }).reason).toBe(`${reason} ${advice}`);
    // The next action of the final report is the stored reason, so it names the way forward too.
    expect(nextAction(ctx.runDir).endsWith(advice)).toBe(true);
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

describe('every EXHAUSTED cause is named in the next action (P17)', () => {
  async function stop(reason: string, outcome: Record<string, unknown> = {}): Promise<string> {
    lab?.cleanup();
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const ctx = lab.ctx();
    await finishRun(ctx, 'EXHAUSTED', reason, { outcome });
    return nextAction(ctx.runDir);
  }

  it('a stop that is not about spend never says the authorized budget is spent, and names its real cause', async () => {
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ['diagnosis produced no valid repair brief within 2 attempts for fp:2e034027c239accb', {}, /diagnosis could not produce a usable repair brief/i],
      [
        'implementation attempt allowance spent (4 of 4) and no extension for the review repair: no materially new, evidence-backed hypothesis; open findings: COR-1 (high): x',
        { extension: { decision: 'deny_extension', denied_because: ['no materially new, evidence-backed hypothesis'] } },
        /no extension was granted.*no materially new, evidence-backed hypothesis/i,
      ],
      ['implementation attempt allowance spent (3 of 3) and no extension: no measurable progress (a newly supported criterion)', { extension: { decision: 'deny_extension' } }, /no extension was granted/i],
      ['the codex reviewer: the provider kept failing transiently and infrastructure retries are spent (last: overloaded)', {}, /provider kept failing/i],
      ['recovery_attempts exhausted: the run was resumed after the planner failed (attempt 4), and no recovery attempt is left to start it again', {}, /recovery attempts/i],
      ['review_rounds hard cap reached (4 of 4) with 1 open finding(s): COR-1 (high): x', {}, /review round/i],
      ['implementation attempts hard cap reached (4 of 4); the last failure was fp:abc', {}, /implementation attempts/i],
      ['CI failed and the CI repair budget is spent: 3 of 3 CI repairs used', {}, /CI repair/i],
    ];
    for (const [reason, outcome, cause] of cases) {
      const next = await stop(reason, outcome);
      expect(next, reason).not.toMatch(/authorized budget is spent/);
      expect(next, reason).toMatch(cause);
      expect(next, reason).toContain(reason.slice(0, 40));
    }
  });

  it('a stop on money or time still says the budget is spent', async () => {
    for (const reason of ['model cost hard cap reached (12 of 12)', 'wall time hard cap reached (3600000 of 3600000)', 'attempt 1 not started: no model budget left under the hard cap less the closing reserve', 'attempt 2 not admitted: the remaining budget cannot support an honest completion (not admitted by budget: cost exceeds)', 'cost_usd exhausted at the hard cap 12: used 12.24, requested 4']) {
      expect(await stop(reason), reason).toContain(`The authorized budget is spent (${reason})`);
    }
  });

  it('an EXHAUSTED run with an open material question names it, since its answer is what a new run needs', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const ctx = lab.ctx();
    const q = insertQuestion(lab.db, { runId: lab.runId, mode: 'clarify', question: 'Population or sample variance?', evidence: [], options: [], changes: ['implementation'], recommendation: { option: 'A', reason: 'r' }, safeDefault: { exists: false, option: null, reason: 'differs' }, material: true, affected: ['AC-2'], unblocked: [] }, lab.clock);
    await finishRun(ctx, 'EXHAUSTED', 'implementation attempts hard cap reached (4 of 4); the last failure was fp:abc');
    const next = nextAction(ctx.runDir);
    expect(next).toContain(q.id);
    expect(next).toContain('Population or sample variance?');
  });
});
