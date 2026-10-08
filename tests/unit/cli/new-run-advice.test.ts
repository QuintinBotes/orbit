/**
 * Issue #33 (0.2.1 retest): the CLI's closing line after an environment block, and `orbit status` ("will return to
 * VERIFYING"), pointed at `orbit resume` where only a new run helps: a block that comes from the environment or a
 * check's definition (the run's policy and the check results recorded for its candidate are frozen, so a resume reads
 * the same evidence and blocks again) and a frozen-policy block with open questions. Where a resume can clear the block
 * (a baseline exception to approve, a decision to answer) the advice stays as it was, also for a run whose attempt counter
 * is full: the counter is charged when an attempt starts, and a block in the middle of the last attempt resumes into that
 * attempt, which spends nothing new.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildRunStatus, renderRunStatus } from '../../../src/cli/commands/status.ts';
import { systemClock } from '../../../src/core/clock.ts';
import { getRun } from '../../../src/controller/run-store.ts';
import { buildFinalReport } from '../../../src/controller/report.ts';
import { newRunNeeded } from '../../../src/controller/resume.ts';
import type { RunState } from '../../../src/controller/states.ts';
import { buildPayload } from '../../../src/notify/payload.ts';
import { makeLab, type Lab } from './lab.ts';

const hooks = vi.hoisted(() => ({ fake: false, start: null as null | ((runId: string) => Promise<void>) }));
vi.mock('../../../src/controller/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/controller/index.ts')>();
  class Fake {
    private readonly runId: string;
    constructor(opts: { runId: string }) {
      this.runId = opts.runId;
    }
    async start(): Promise<void> {
      await hooks.start?.(this.runId);
    }
    async stop(): Promise<void> {}
  }
  const Wrapper = function (this: unknown, opts: ConstructorParameters<typeof actual.Controller>[0]) {
    return hooks.fake ? new Fake(opts as never) : new actual.Controller(opts);
  } as unknown as typeof actual.Controller;
  return { ...actual, Controller: Wrapper };
});

const labs: Lab[] = [];
const lab = () => {
  const l = makeLab();
  labs.push(l);
  return l;
};
beforeEach(() => {
  hooks.fake = false;
  hooks.start = null;
});
afterEach(() => labs.splice(0).forEach((l) => l.close()));

/** The CLI with a scripted controller and fast polling. */
function drive(l: Lab, argv: string[]) {
  hooks.fake = true;
  return l.cli(argv, { seams: { pollMs: 5, controllerDeps: () => ({}) as never, admission: async () => null, signals: new EventEmitter(), exit: (() => undefined) as never } });
}

/** A candidate-level environment block, as verifying.ts blockOnEnvironment records it. */
const ENVIRONMENT = (questionId: string | null) => ({
  candidate_id: 'cand-1',
  report_id: 'ev-1',
  environment_failures: [{ check_id: 'build', fingerprint: questionId === null ? null : 'fp-1', signals: ['sandbox-violation'], cause: 'the sandbox refused a path', evidence_lines: ['denied'], question_id: questionId }],
  other_failing_checks: [],
});

function block(l: Lab, id: string, path: Parameters<Lab['moveTo']>[1], outcome: Record<string, unknown> = {}): void {
  l.moveTo(id, [...path, 'BLOCKED'], 'the reason');
  l.db().run('UPDATE runs SET outcome_reason = ?, outcome_json = ? WHERE id = ?', 'the reason', JSON.stringify({ state: 'BLOCKED', reason: 'the reason', ...outcome }), id);
}
const VERIFYING: RunState[] = ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'VERIFYING'];
const spendAttempts = (l: Lab, id: string, used: number, cap: number) => l.db().run("INSERT INTO budget_counters (run_id, counter, used, allowance, hard_cap) VALUES (?, 'implementation_attempts', ?, ?, ?)", id, used, cap, cap);

describe('the CLI closing line of a blocked run', () => {
  it('says a new run, not a resume, after an environment block with nothing to approve', async () => {
    const l = lab();
    await l.cli(['init']);
    hooks.start = async (id) => block(l, id, VERIFYING, ENVIRONMENT(null));
    const r = await drive(l, ['run', '--goal', 'one', '--foreground']);
    expect(r.out).toMatch(/ended BLOCKED: the reason\n/);
    expect(r.out).toMatch(/resuming would only block again \(the block comes from the environment or a check's definition[^)]*\): fix it, then "orbit cancel orb-\S+" and start a new run with "orbit run"\n$/);
    expect(r.out).not.toMatch(/then "orbit resume/);
    expect(r.out).not.toMatch(/resolve the reason above/);
  });

  it('keeps "answer, then resume" where the environment block has a baseline exception to approve', async () => {
    const l = lab();
    await l.cli(['init']);
    hooks.start = async (id) => {
      l.ask(id, { id: 'q-base', question: 'Accept the failure of build?' });
      block(l, id, VERIFYING, ENVIRONMENT('q-base'));
    };
    const r = await drive(l, ['run', '--goal', 'one', '--foreground']);
    expect(r.out).toMatch(/answer with "orbit decide orb-\S+ <question-id> <answer>", then "orbit resume orb-\S+ --foreground"\n$/);
    expect(r.out).not.toMatch(/start a new run/);
  });

  it('says a new run for a frozen-policy block even with a question open, since a resume is refused for it', async () => {
    const l = lab();
    await l.cli(['init']);
    hooks.start = async (id) => {
      l.ask(id, { id: 'q-open', question: 'Anything else?' });
      block(l, id, ['PREFLIGHT', 'CONTRACTING'], { frozen_policy: { setting: 'scope.allowed_paths' } });
    };
    const r = await drive(l, ['run', '--goal', 'one', '--foreground']);
    expect(r.out).toContain('  open question q-open: Anything else?\n');
    expect(r.out).toMatch(/this block comes from the run's frozen policy: fix \.orbit\/config\.yaml, then "orbit cancel orb-\S+" and start a new run with "orbit run"\n$/);
    expect(r.out).not.toMatch(/then "orbit resume/);
  });

  it('still says to answer, then resume, when every implementation attempt is used but the last one is in progress: a resume continues it', async () => {
    const l = lab();
    await l.cli(['init']);
    hooks.start = async (id) => {
      spendAttempts(l, id, 3, 3);
      l.ask(id, { id: 'q-1', question: 'Run chmod +x?' });
      block(l, id, ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'], { authorization: ['q-1'] });
    };
    const r = await drive(l, ['run', '--goal', 'one', '--foreground']);
    expect(r.out).toContain('  open question q-1: Run chmod +x?\n');
    expect(r.out).toMatch(/answer with "orbit decide orb-\S+ <question-id> <answer>", then "orbit resume orb-\S+ --foreground"\n$/);
    expect(r.out).not.toMatch(/start a new run|would only block again/);
  });

  it('still says to resolve and resume for a block a resume can clear', async () => {
    const l = lab();
    await l.cli(['init']);
    hooks.start = async (id) => {
      spendAttempts(l, id, 1, 3);
      block(l, id, ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING']);
    };
    const r = await drive(l, ['run', '--goal', 'one', '--foreground']);
    expect(r.out).toMatch(/resolve the reason above, then "orbit resume orb-\S+ --foreground"\n$/);
  });
});

describe('orbit status of a blocked run', () => {
  const stage = (l: Lab, id: string) => buildRunStatus({ clock: systemClock }, l.db(), getRun(l.db(), id)).stage;

  it('names the stage a resume returns to only where a resume can clear the block, and a new run where it cannot', () => {
    const l = lab();
    const generic = l.newRun('one');
    block(l, generic.id, VERIFYING, {});
    expect(stage(l, generic.id)).toBe('BLOCKED (will return to VERIFYING)');
    const env = l.newRun('two');
    block(l, env.id, VERIFYING, ENVIRONMENT(null));
    expect(stage(l, env.id)).toBe("BLOCKED (a new run is needed: the block comes from the environment or a check's definition, which a resume does not change: the run's policy and the check results recorded for its candidate are frozen)");
    expect(renderRunStatus(buildRunStatus({ clock: systemClock }, l.db(), getRun(l.db(), env.id)), Date.now())).not.toMatch(/will return to/);
    const frozen = l.newRun('three');
    block(l, frozen.id, ['PREFLIGHT', 'CONTRACTING'], { frozen_policy: { setting: 'checks.build.command' } });
    expect(stage(l, frozen.id)).toBe("BLOCKED (a new run is needed: its frozen policy (checks.build.command) causes the block)");
    // Where a fix outside the policy clears the block (a model catalog refresh), the outcome reason offers a forced resume too,
    // and the stage line does not contradict it.
    const refreshable = l.newRun('five');
    block(l, refreshable.id, ['PREFLIGHT', 'CONTRACTING'], { frozen_policy: { setting: 'providers.claude.model' } });
    expect(stage(l, refreshable.id)).toBe('BLOCKED (a new run is needed: its frozen policy (providers.claude.model) causes the block; if what you fixed is outside the policy, "orbit resume --force" is the other way forward)');
  });

  it('keeps the stage for an environment block that has a question to answer, and for a block with every implementation attempt used', () => {
    const l = lab();
    const asked = l.newRun('one');
    l.ask(asked.id, { id: 'q-base' });
    block(l, asked.id, VERIFYING, ENVIRONMENT('q-base'));
    expect(stage(l, asked.id)).toBe('BLOCKED (will return to VERIFYING)');
    expect(newRunNeeded(l.db(), getRun(l.db(), asked.id))).toBeNull();
    const verifying = l.newRun('two');
    spendAttempts(l, verifying.id, 3, 3);
    block(l, verifying.id, VERIFYING, {});
    expect(stage(l, verifying.id)).toBe('BLOCKED (will return to VERIFYING)');
    expect(newRunNeeded(l.db(), getRun(l.db(), verifying.id))).toBeNull();
    // The counter is charged when an attempt starts: a block at IMPLEMENTING with it full is the last attempt, in progress,
    // and a resume continues it (implementing.ts continueAttempt), so the stage is the one a resume returns to.
    const last = l.newRun('three');
    spendAttempts(l, last.id, 3, 3);
    block(l, last.id, ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'], {});
    expect(stage(l, last.id)).toBe('BLOCKED (will return to IMPLEMENTING)');
    expect(newRunNeeded(l.db(), getRun(l.db(), last.id))).toBeNull();
  });
});

describe('the report and the notification of a blocked run', () => {
  const nextAction = (l: Lab, id: string) => buildFinalReport(l.db(), getRun(l.db(), id), { runDir: l.base, clock: systemClock, snapshot: null }).next_action;

  it('does not append "resume" after an environment block that needs a new run, and keeps it with every attempt used', () => {
    const l = lab();
    const env = l.newRun('one');
    block(l, env.id, VERIFYING, ENVIRONMENT(null));
    l.db().run('UPDATE runs SET outcome_reason = ? WHERE id = ?', 'Check build could not execute. Way forward: fix the environment and start a new run (this run\'s policy is frozen)', env.id);
    expect(nextAction(l, env.id)).toBe('Check build could not execute. Way forward: fix the environment and start a new run (this run\'s policy is frozen)');
    // Every attempt used, the last in progress: a resume continues it, so the old line stays.
    const spent = l.newRun('two');
    spendAttempts(l, spent.id, 3, 3);
    block(l, spent.id, ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'], {});
    expect(nextAction(l, spent.id)).toBe(`the reason. Resolve that, then run \`orbit resume ${spent.id}\`.`);
    // A block a resume can clear keeps the old line.
    const plain = l.newRun('three');
    block(l, plain.id, VERIFYING, {});
    expect(nextAction(l, plain.id)).toBe(`the reason. Resolve that, then run \`orbit resume ${plain.id}\`.`);
  });

  it('tells a notification of an environment block with no open question that a resume would only block again', () => {
    const l = lab();
    const env = l.newRun('one');
    block(l, env.id, VERIFYING, ENVIRONMENT(null));
    const run = getRun(l.db(), env.id);
    const payload = buildPayload({ kind: 'run.ended', run, questionIds: [], pullRequest: null, remote: null } as never);
    expect(payload.next_action).toBe(`Read orbit report ${run.id}; this block comes from the environment or a check's definition, so resuming alone would only block again.`);
    const plain = l.newRun('two');
    block(l, plain.id, VERIFYING, {});
    expect(buildPayload({ kind: 'run.ended', run: getRun(l.db(), plain.id), questionIds: [], pullRequest: null, remote: null } as never).next_action).toBe(`Resolve the block, then run orbit resume ${plain.id}.`);
  });
});
