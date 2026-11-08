// Within-run parallel units (spec section 8; docs/gaps.md G14): a security-sensitive change that touches UI
// paths gets a security review and a UI review as separate read-only units that run at the same time, each
// bound to the candidate tree; a new candidate cancels both.
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../../../src/cli/cli.ts';
import { memoryIo } from '../../../src/cli/io.ts';
import { defaultUi } from '../../../src/policy/config.ts';
import { loadRunContext } from '../../../src/controller/context.ts';
import { cancelObsoleteWork } from '../../../src/controller/steps/reviewing.ts';
import { step } from '../../../src/controller/steps/index.ts';
import { newRunNeeded } from '../../../src/controller/resume.ts';
import { systemClock } from '../../../src/core/clock.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { listWorkers, type WorkerRecord } from '../../../src/storage/workers.ts';
import { listReviews, markReviewInvalidated } from '../../../src/review/store.ts';
import { FAKE_CODEX, type Lab } from './harness.ts';
import type { OrbitConfig } from '../../../src/policy/types.ts';
import { APPROVE, baseScenario, canStripTypes, drive, events, FIXED_PROBE, implementMul, PLANNER_OUTPUT, runState, startLabRun, stepTo, tracker, waitFor, writeScenario } from '../../fault-injection/helpers.ts';

const t = tracker();
afterEach(() => t.cleanup());

// The objective names a permission check, so planning classifies the change as security-sensitive; apps/** is a UI path.
const PLANNER = { structured: { ...PLANNER_OUTPUT, objective: 'Add a mul function to the calculator behind the existing permission check.' } };
// A roomy machine, so capacity is decided by the units and not by whatever else this host is running.
const ROOMY = { schedulerProbe: FIXED_PROBE };
const lab = () => t.lab({ tweak: (c) => void (c.ui = { ...defaultUi(), ui_paths: ['apps/**'], required_when_ui_changes: false, journey_check_ids: [] }) });
/** Each reviewer session as purpose, state and error, for a failure message that says why a unit ran twice. */
const counter = (l: Lab, runId: string) => l.db().get<{ used: number; hard_cap: number }>("SELECT used, hard_cap FROM budget_counters WHERE run_id = ? AND counter = 'review_rounds'", runId);
const sessions = (ws: readonly WorkerRecord[]): string => ws.map((w) => `${w.purpose} ${w.state}${w.error ? ` (${w.error})` : ''}`).join('; ');

describe.skipIf(!canStripTypes)('controller: parallel review units', () => {
  it('starts the security and the UI review together, records both, and succeeds once both approve', async () => {
    const l = lab();
    const slow = { ...APPROVE, sleepMs: 1_500 };
    writeScenario(l, baseScenario({ planner: [PLANNER], implementer: [implementMul('*')], reviewer: [slow, slow] }));
    const run = startLabRun(l);
    await drive(l, run.id, ROOMY);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const reviewers = listWorkers(l.db(), { runId: run.id, role: 'reviewer' });
    // One session per unit: nothing here fails, so a second session of a unit would be a defect (the rows say which).
    expect(reviewers.map((w) => w.purpose!.split(':')[0]).sort(), sessions(reviewers)).toEqual(['review-security', 'review-ui']);
    expect(events(l, run.id, 'worker.regenerate')).toEqual([]);
    // Together: each started before the other ended.
    const [a, b] = reviewers;
    expect(a!.spawnedAt!).toBeLessThan(b!.endedAt!);
    expect(b!.spawnedAt!).toBeLessThan(a!.endedAt!);
    const tree = listReviews(l.db(), run.id)[0]!.treeHash;
    expect(listReviews(l.db(), run.id).map((r) => [r.verdict, r.treeHash])).toEqual([
      ['APPROVE', tree],
      ['APPROVE', tree],
    ]);
    const prompts = reviewers.map((w) => readFileSync(join(w.workerDir, 'prompt.md'), 'utf8'));
    expect(prompts.some((p) => p.includes('Focus: security.'))).toBe(true);
    expect(prompts.some((p) => p.includes('Focus: the user interface.'))).toBe(true);
    // Two sessions on one revision: the second was admitted with the cost of re-reading the shared context.
    expect(events(l, run.id, 'scheduler.context-duplication')).toHaveLength(1);
    expect(l.db().get<{ used: number }>("SELECT used FROM budget_counters WHERE run_id = ? AND counter = 'review_rounds'", run.id)?.used).toBe(2);
  }, 90_000);

  it('a unit whose session fails gets one more session of its own, recorded with why; the other unit runs once', async () => {
    const l = lab();
    const slow = { ...APPROVE, sleepMs: 1_500 };
    // The security unit's first session exits 1 with no result, as the fake did when it read a torn scenario.
    writeScenario(l, baseScenario({ planner: [PLANNER], implementer: [implementMul('*')], 'reviewer@security': [{ outcome: 'no_result' }, slow], 'reviewer@ui': [slow] }));
    const run = startLabRun(l);
    await drive(l, run.id, ROOMY);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const reviewers = listWorkers(l.db(), { runId: run.id, role: 'reviewer' });
    const byPurpose = new Map(reviewers.map((w) => [w.purpose!.replace(/:cand-[^#]+/, ''), w]));
    expect([...byPurpose.keys()].sort(), sessions(reviewers)).toEqual(['review-security#1', 'review-security#2', 'review-ui#1']);
    // The record says why there are two: the first session failed, and the regeneration names its status and error.
    const failed = byPurpose.get('review-security#1')!;
    expect([failed.state, failed.resultStatus, failed.exitCode]).toEqual(['FAILED', 'failed', 1]);
    expect(failed.error).toMatch(/exited 1/);
    const regen = events(l, run.id, 'worker.regenerate').map((e) => JSON.parse(e.data_json!) as { what: string; status: string; attempts: number; error: string });
    expect(regen).toHaveLength(1);
    expect(regen[0]).toMatchObject({ status: 'failed', attempts: 1, error: failed.error });
    expect(regen[0]!.what).toMatch(/ security reviewer$/);
    // A failed session reviews nothing: the two reviews are the second security session's and the UI session's.
    const tree = listReviews(l.db(), run.id)[0]!.treeHash;
    expect(listReviews(l.db(), run.id).map((r) => [r.workerId, r.verdict, r.treeHash]).sort()).toEqual(
      [
        [byPurpose.get('review-security#2')!.id, 'APPROVE', tree],
        [byPurpose.get('review-ui#1')!.id, 'APPROVE', tree],
      ].sort(),
    );
    // Every session started costs a review round, the failed one included.
    expect(l.db().get<{ used: number }>("SELECT used FROM budget_counters WHERE run_id = ? AND counter = 'review_rounds'", run.id)?.used).toBe(3);
  }, 90_000);

  it('a new candidate cancels both running reviewers', async () => {
    const l = lab();
    const stuck = { ...APPROVE, sleepMs: 60_000 };
    writeScenario(l, baseScenario({ planner: [PLANNER], implementer: [implementMul('*')], reviewer: [stuck, stuck] }));
    const run = startLabRun(l);
    const deps = await stepTo(l, run.id, 'REVIEWING', 'controller-a', ROOMY);
    const r = await step(deps, run.id, new AbortController().signal);
    expect(r.waiting).toBeDefined();
    const running = await waitFor(() => {
      const ws = listWorkers(l.db(), { runId: run.id, role: 'reviewer' });
      return ws.length === 2 && ws.every((w) => w.state === 'RUNNING') ? ws : null;
    }, 20_000);
    for (const w of running) t.group(w.pgid);

    const ctx = loadRunContext(deps, run.id, new AbortController().signal);
    const stopped = await cancelObsoleteWork(ctx, 'f'.repeat(40));
    expect(stopped.sort()).toEqual(running.map((w) => w.id).sort());
    expect(listWorkers(l.db(), { runId: run.id, role: 'reviewer' }).map((w) => w.state)).toEqual(['CANCELLED', 'CANCELLED']);
    expect(events(l, run.id, 'workers.obsolete-cancelled')).toHaveLength(1);
    // Work on the current tree is left alone.
    expect(await cancelObsoleteWork(ctx, ctx.candidate!.treeHash)).toEqual([]);
  }, 90_000);

  // #116: the security unit's reviewer fails on every attempt after the UI unit's review is in.
  const twoReviewers = (more?: (c: OrbitConfig) => void) =>
    t.lab({
      tweak: (c) => {
        more?.(c);
        c.ui = { ...defaultUi(), ui_paths: ['apps/**'], required_when_ui_changes: false, journey_check_ids: [] };
        c.providers['codex-b'] = { command: FAKE_CODEX, data_policy_eligible: true, model: 'gpt-6-astra', reasoning_effort: null, extra_args: [] };
        c.review = { ...c.review, providers: ['codex', 'codex-b'] };
      },
    });

  it('a reviewer that fails on one unit is replaced on every unit: the next listed reviewer reviews both, and the review it already gave is set aside', async () => {
    // Five sessions at the default review_rounds of 4: two failed, one set aside, two by the next reviewer.
    const l = twoReviewers();
    const fail = { outcome: 'no_result', sleepMs: 1_500 };
    writeScenario(l, baseScenario({ planner: [PLANNER], implementer: [implementMul('*')], 'reviewer@security': [fail, fail, APPROVE], 'reviewer@ui': [APPROVE] }));
    const run = startLabRun(l);
    await drive(l, run.id, ROOMY);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const reviewers = listWorkers(l.db(), { runId: run.id, role: 'reviewer' });
    expect(reviewers.map((w) => `${w.purpose!.replace(/:cand-[^#~]+/, '')} ${w.provider}`).sort(), sessions(reviewers)).toEqual(['review-security#1 codex', 'review-security#2 codex', 'review-security~codex-b#1 codex-b', 'review-ui#1 codex', 'review-ui~codex-b#1 codex-b']);
    // One reviewer reviewed every unit of the tree, so its independence is one property of the tree.
    expect(listReviews(l.db(), run.id).map((r) => r.provider)).toEqual(['codex-b', 'codex-b']);
    expect(listReviews(l.db(), run.id, { includeInvalidated: true }).filter((r) => r.invalidatedAt !== null).map((r) => r.provider)).toEqual(['codex']);
    // Every round is counted, and the three the replaced reviewer spent were granted back.
    expect(counter(l, run.id)).toEqual({ used: 5, hard_cap: 4 });
    expect(events(l, run.id, 'budget.exhausted')).toEqual([]);
  }, 90_000);

  it('a reviewer that fails on one unit has its other running unit stopped, and the next listed reviewer reviews both', async () => {
    // Five sessions, one stopped and charged its worst case: more than the default cost cap fits.
    const l = twoReviewers((c) => void (c.scheduler.hard_limits.model_cost_usd = 200));
    writeScenario(l, baseScenario({ planner: [PLANNER], implementer: [implementMul('*')], 'reviewer@security': [{ outcome: 'no_result' }, { outcome: 'no_result' }, APPROVE], 'reviewer@ui': [{ ...APPROVE, sleepMs: 30_000 }, APPROVE] }));
    const run = startLabRun(l);
    await drive(l, run.id, ROOMY);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const reviewers = listWorkers(l.db(), { runId: run.id, role: 'reviewer' });
    const uiOnCodex = reviewers.find((w) => w.purpose!.startsWith('review-ui:') && w.provider === 'codex');
    expect(uiOnCodex?.state, sessions(reviewers)).toBe('CANCELLED');
    expect(listReviews(l.db(), run.id).map((r) => r.provider)).toEqual(['codex-b', 'codex-b']);
    expect(events(l, run.id, 'workers.reviewer-failed-cancelled')).toHaveLength(1);
    expect(counter(l, run.id)).toEqual({ used: 5, hard_cap: 4 });
  }, 90_000);

  // One listed reviewer, when_unavailable block: the security unit answers first, then the UI unit fails on every
  // attempt, which sets the security review aside and blocks the run. A resume selects the same reviewer again.
  const oneReviewer = () =>
    t.lab({
      tweak: (c) => {
        c.ui = { ...defaultUi(), ui_paths: ['apps/**'], required_when_ui_changes: false, journey_check_ids: [] };
        c.review = { ...c.review, providers: ['codex'], when_unavailable: 'block' };
      },
    });
  const BLOCK = { structured: { verdict: 'BLOCK', candidate_revision: '$CANDIDATE', findings: [] } };
  const fail = { outcome: 'no_result', sleepMs: 1_500 };
  const unitPurposes = (ws: readonly WorkerRecord[]): string[] => ws.map((w) => w.purpose!.replace(/:cand-[^#~]+/, '')).sort();
  async function resume(l: Lab, runId: string): Promise<void> {
    const io = memoryIo('');
    expect(await main(['resume', runId, '--detach'], { io, cwd: l.repo, homeDir: l.base, orbitHome: l.orbitHome, env: { ...process.env, ORBIT_HOME: l.orbitHome }, user: 'acme' }), io.stderr).toBe(0);
  }

  it('a review set aside by a reviewer failure does not count after a resume: its unit runs a new session, and the run does not succeed on the other unit alone', async () => {
    const l = oneReviewer();
    writeScenario(l, baseScenario({ planner: [PLANNER], implementer: [implementMul('*')], 'reviewer@security': [BLOCK, BLOCK], 'reviewer@ui': [fail, fail, APPROVE] }));
    const run = startLabRun(l);
    await drive(l, run.id, ROOMY);
    expect(runState(l, run.id).state).toBe('BLOCKED');

    // No review of the tree stands, so the report names no standing reviewer.
    const blockedReport = readFileSync(join(l.repo, '.orbit', 'runs', run.id, 'final.md'), 'utf8');
    expect(blockedReport).toContain('Reviewer: none, no review of this tree stands\n- Tried first: codex/gpt-6-astra, which failed (');
    expect(blockedReport).not.toMatch(/Reviewer: codex/);

    await resume(l, run.id);
    await drive(l, run.id, ROOMY);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    const reviewers = listWorkers(l.db(), { runId: run.id, role: 'reviewer' });
    expect(unitPurposes(reviewers), sessions(reviewers)).toEqual(['review-security#1', 'review-security#2', 'review-ui#1', 'review-ui#2', 'review-ui#3']);
    expect(listReviews(l.db(), run.id).map((r) => r.verdict).sort()).toEqual(['APPROVE', 'BLOCK']);
  }, 120_000);

  it('a review set aside by a reviewer failure: the run succeeds once the unit\'s new session approves too', async () => {
    const l = oneReviewer();
    writeScenario(l, baseScenario({ planner: [PLANNER], implementer: [implementMul('*')], 'reviewer@security': [BLOCK, APPROVE], 'reviewer@ui': [fail, fail, APPROVE] }));
    const run = startLabRun(l);
    await drive(l, run.id, ROOMY);
    expect(runState(l, run.id).state).toBe('BLOCKED');
    await resume(l, run.id);
    await drive(l, run.id, ROOMY);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const reviewers = listWorkers(l.db(), { runId: run.id, role: 'reviewer' });
    expect(unitPurposes(reviewers), sessions(reviewers)).toEqual(['review-security#1', 'review-security#2', 'review-ui#1', 'review-ui#2', 'review-ui#3']);
    const secondSecurity = reviewers.find((w) => /^review-security:[^#]+#2$/.test(w.purpose!))!;
    const standing = listReviews(l.db(), run.id);
    expect(standing.map((r) => r.verdict)).toEqual(['APPROVE', 'APPROVE']);
    expect(standing.map((r) => r.workerId)).toContain(secondSecurity.id);
    // One recovery attempt for each unit that started again on this resume.
    expect(events(l, run.id, 'resume.reset')).toHaveLength(2);
  }, 120_000);

  // Both units approve, one or both without inspecting anything, so ADR 0016 asks one fresh general review.
  const SHALLOW = { ...APPROVE, inspect: false };
  const EXIT = { outcome: 'no_result' };
  const providerPurposes = (ws: readonly WorkerRecord[]): string[] => ws.map((w) => `${w.purpose!.replace(/:cand-[^#~]+/, '')} ${w.provider}`).sort();
  const FRESH_FAILED_THEN_SUBSTITUTE_UNITS = ['review-fresh#1 codex', 'review-fresh#2 codex', 'review-security#1 codex', 'review-security~codex-b#1 codex-b', 'review-ui#1 codex', 'review-ui~codex-b#1 codex-b'];
  const grants = (l: Lab, runId: string) => listDecisions(l.db(), runId, { kind: 'review.reviewer-failed' }).map((d) => d.data as { provider: string; rounds_granted: number; reason: string; set_aside: string[] });

  it('a fresh reviewer that fails after both units approved: the next reviewer runs the security and ui units, and the run does not clear before they stand', async () => {
    const l = twoReviewers();
    const slow = { ...APPROVE, sleepMs: 3_000 };
    writeScenario(l, baseScenario({ planner: [PLANNER], implementer: [implementMul('*')], 'reviewer@security': [SHALLOW, slow], 'reviewer@ui': [SHALLOW, slow], reviewer: [EXIT, EXIT, APPROVE] }));
    const run = startLabRun(l);
    const driving = drive(l, run.id, ROOMY);

    const substitutes = await waitFor(() => {
      const ws = listWorkers(l.db(), { runId: run.id, role: 'reviewer' }).filter((w) => w.provider === 'codex-b');
      return ws.length === 2 && ws.every((w) => w.state === 'RUNNING') ? ws : null;
    }, 60_000);
    expect(substitutes.map((w) => w.purpose!.split(':')[0]).sort()).toEqual(['review-security', 'review-ui']);
    // Both earlier reviews are set aside and neither new one is in: nothing stands, and the run has not moved on.
    expect(listReviews(l.db(), run.id)).toEqual([]);
    expect(runState(l, run.id).state).toBe('REVIEWING');
    await driving;

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(listReviews(l.db(), run.id).map((r) => [r.provider, r.verdict])).toEqual([
      ['codex-b', 'APPROVE'],
      ['codex-b', 'APPROVE'],
    ]);
  }, 120_000);

  it('the substitute units carry the fresh review\'s brief and approve: the run succeeds at the default limits, with every round counted and granted once', async () => {
    const l = twoReviewers();
    writeScenario(l, baseScenario({ planner: [PLANNER], implementer: [implementMul('*')], 'reviewer@security': [SHALLOW, APPROVE], 'reviewer@ui': [APPROVE, APPROVE], reviewer: [EXIT, EXIT, APPROVE] }));
    const run = startLabRun(l);
    await drive(l, run.id, ROOMY);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const reviewers = listWorkers(l.db(), { runId: run.id, role: 'reviewer' });
    expect(providerPurposes(reviewers), sessions(reviewers)).toEqual(FRESH_FAILED_THEN_SUBSTITUTE_UNITS);
    const units = reviewers.filter((w) => w.provider === 'codex-b');
    for (const w of units) expect(readFileSync(join(w.workerDir, 'prompt.md'), 'utf8')).toContain('This is a fresh review of a tree that an earlier review');
    expect(listReviews(l.db(), run.id).map((r) => r.workerId).sort()).toEqual(units.map((w) => w.id).sort());
    // Two units and two fresh attempts were codex's, all granted; the substitute's two make six of the effective eight.
    expect(grants(l, run.id).map((g) => [g.provider, g.rounds_granted])).toEqual([['codex', 4]]);
    expect(counter(l, run.id)).toEqual({ used: 6, hard_cap: 4 });
    expect(events(l, run.id, 'budget.exhausted')).toEqual([]);
  }, 120_000);

  it('one substitute unit blocks after the fresh reviewer failed: the run does not succeed', async () => {
    const l = twoReviewers();
    writeScenario(l, baseScenario({ planner: [PLANNER], implementer: [implementMul('*')], 'reviewer@security': [SHALLOW, BLOCK], 'reviewer@ui': [SHALLOW, APPROVE], reviewer: [EXIT, EXIT, APPROVE] }));
    const run = startLabRun(l);
    await drive(l, run.id, ROOMY);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    expect(done.outcomeReason).toMatch(/codex-b review \S+ is BLOCK with no findings to resolve/);
    expect(done.outcomeReason).toMatch(/the fresh review of the tree asked after review\(s\) [^;]+ did not come back/);
    const reviewers = listWorkers(l.db(), { runId: run.id, role: 'reviewer' });
    expect(providerPurposes(reviewers), sessions(reviewers)).toEqual(FRESH_FAILED_THEN_SUBSTITUTE_UNITS);
    expect(listReviews(l.db(), run.id).map((r) => r.verdict).sort()).toEqual(['APPROVE', 'BLOCK']);
  }, 120_000);

  it('a substitute unit that inspected nothing blocks: it stood in for the fresh review, and a resume would decide the tree the same way', async () => {
    const l = twoReviewers();
    writeScenario(l, baseScenario({ planner: [PLANNER], implementer: [implementMul('*')], 'reviewer@security': [SHALLOW, SHALLOW], 'reviewer@ui': [SHALLOW, APPROVE], reviewer: [EXIT, EXIT, APPROVE] }));
    const run = startLabRun(l);
    await drive(l, run.id, ROOMY);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    expect(done.outcomeReason).toMatch(/judged it from the packet alone and inspected nothing/);
    expect(newRunNeeded(l.db(), done)).toBe('the tree had its one fresh review, and a resume starts no other');
  }, 120_000);

  it('a resume after the only reviewer failed the fresh review runs every unit again, for one recovery attempt each, and clears once they approve', async () => {
    const l = oneReviewer();
    writeScenario(l, baseScenario({ planner: [PLANNER], implementer: [implementMul('*')], 'reviewer@security': [SHALLOW, APPROVE], 'reviewer@ui': [SHALLOW, APPROVE], reviewer: [EXIT, EXIT, APPROVE] }));
    const run = startLabRun(l);
    await drive(l, run.id, ROOMY);
    expect(runState(l, run.id).state).toBe('BLOCKED');
    expect(listReviews(l.db(), run.id)).toEqual([]);

    await resume(l, run.id);
    await drive(l, run.id, ROOMY);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const reviewers = listWorkers(l.db(), { runId: run.id, role: 'reviewer' });
    expect(unitPurposes(reviewers), sessions(reviewers)).toEqual(['review-fresh#1', 'review-fresh#2', 'review-security#1', 'review-security#2', 'review-ui#1', 'review-ui#2']);
    expect(listReviews(l.db(), run.id).map((r) => r.verdict)).toEqual(['APPROVE', 'APPROVE']);
    expect(events(l, run.id, 'resume.reset')).toHaveLength(2);
  }, 120_000);

  it('a resume after the fresh review failed does not clear when one unit blocks', async () => {
    const l = oneReviewer();
    writeScenario(l, baseScenario({ planner: [PLANNER], implementer: [implementMul('*')], 'reviewer@security': [SHALLOW, BLOCK], 'reviewer@ui': [SHALLOW, APPROVE], reviewer: [EXIT, EXIT, APPROVE] }));
    const run = startLabRun(l);
    await drive(l, run.id, ROOMY);
    await resume(l, run.id);
    await drive(l, run.id, ROOMY);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    expect(listReviews(l.db(), run.id).map((r) => r.verdict).sort()).toEqual(['APPROVE', 'BLOCK']);
  }, 120_000);

  it('a fresh review that came back stands for the units it replaced: no unit runs twice when both were shallow', async () => {
    const l = twoReviewers();
    writeScenario(l, baseScenario({ planner: [PLANNER], implementer: [implementMul('*')], 'reviewer@security': [SHALLOW], 'reviewer@ui': [SHALLOW], reviewer: [APPROVE] }));
    const run = startLabRun(l);
    await drive(l, run.id, ROOMY);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const reviewers = listWorkers(l.db(), { runId: run.id, role: 'reviewer' });
    expect(unitPurposes(reviewers), sessions(reviewers)).toEqual(['review-fresh#1', 'review-security#1', 'review-ui#1']);
    expect(listReviews(l.db(), run.id).map((r) => r.workerId)).toEqual([reviewers.find((w) => w.purpose!.startsWith('review-fresh:'))!.id]);
  }, 120_000);

  it('a fresh review that came back stands only for the unit it replaced: the other unit\'s own review still stands', async () => {
    const l = twoReviewers();
    writeScenario(l, baseScenario({ planner: [PLANNER], implementer: [implementMul('*')], 'reviewer@security': [APPROVE], 'reviewer@ui': [SHALLOW], reviewer: [APPROVE] }));
    const run = startLabRun(l);
    await drive(l, run.id, ROOMY);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const reviewers = listWorkers(l.db(), { runId: run.id, role: 'reviewer' });
    expect(unitPurposes(reviewers), sessions(reviewers)).toEqual(['review-fresh#1', 'review-security#1', 'review-ui#1']);
    expect(listReviews(l.db(), run.id)).toHaveLength(2);
  }, 120_000);

  it('the decision to clear refuses a tree that lost a unit\'s review on any path: a fresh review of another unit does not stand for it', async () => {
    const l = twoReviewers();
    writeScenario(l, baseScenario({ planner: [PLANNER], implementer: [implementMul('*')], 'reviewer@security': [APPROVE], 'reviewer@ui': [SHALLOW], reviewer: [{ ...APPROVE, sleepMs: 3_000 }] }));
    const run = startLabRun(l);
    const driving = drive(l, run.id, ROOMY);
    await waitFor(() => listWorkers(l.db(), { runId: run.id, role: 'reviewer' }).find((w) => w.purpose!.startsWith('review-fresh:') && w.state === 'RUNNING'), 60_000);
    const security = listWorkers(l.db(), { runId: run.id, role: 'reviewer' }).find((w) => w.purpose!.startsWith('review-security:'))!;
    expect(markReviewInvalidated(l.db(), `rev-${security.id}`, 'lost by the test', systemClock)).toBe(true);
    await driving;

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    expect(done.outcomeReason).toMatch(/no standing review of the required review unit\(s\) security/);
    expect(events(l, run.id, 'review.approved')).toEqual([]);
  }, 120_000);

  it('a replay after a crash between setting reviews aside and the decision still names them, so the next reviewer runs every unit', async () => {
    const l = twoReviewers();
    writeScenario(l, baseScenario({ planner: [PLANNER], implementer: [implementMul('*')], 'reviewer@security': [SHALLOW, APPROVE], 'reviewer@ui': [SHALLOW, APPROVE], reviewer: [EXIT, { ...EXIT, sleepMs: 3_000 }, APPROVE] }));
    const run = startLabRun(l);
    const driving = drive(l, run.id, ROOMY);
    await waitFor(() => listWorkers(l.db(), { runId: run.id, role: 'reviewer' }).find((w) => /^review-fresh:[^#]+#2$/.test(w.purpose!) && w.state === 'RUNNING'), 60_000);
    // What the first pass left: the reviews invalidated, and no decision yet.
    const before = listReviews(l.db(), run.id).map((r) => r.id).sort();
    expect(before).toHaveLength(2);
    for (const id of before) expect(markReviewInvalidated(l.db(), id, 'set aside before the crash', systemClock)).toBe(true);
    await driving;

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(grants(l, run.id).map((g) => [...g.set_aside].sort())).toEqual([before]);
    const reviewers = listWorkers(l.db(), { runId: run.id, role: 'reviewer' });
    expect(providerPurposes(reviewers), sessions(reviewers)).toEqual(FRESH_FAILED_THEN_SUBSTITUTE_UNITS);
  }, 120_000);

  it('stopping a sibling exhausts model cost at the default cap: the reviewer failure is still recorded and reported, and the run ends EXHAUSTED', async () => {
    const l = twoReviewers();
    writeScenario(l, baseScenario({ planner: [PLANNER], implementer: [implementMul('*')], 'reviewer@security': [{ outcome: 'no_result' }, { outcome: 'no_result' }, APPROVE], 'reviewer@ui': [{ ...APPROVE, sleepMs: 30_000 }, APPROVE] }));
    const run = startLabRun(l);
    await drive(l, run.id, ROOMY);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('EXHAUSTED');
    expect(done.outcomeReason).toMatch(/^cost_usd exhausted at the hard cap \$30/);
    const reason = `failed: exited 1 without turn.completed or turn.failed after 2 attempt(s)`;
    expect(grants(l, run.id).map((g) => [g.provider, g.reason])).toEqual([['codex', reason]]);
    expect(events(l, run.id, 'workers.reviewer-failed-cancelled')).toHaveLength(1);
    const dir = join(l.repo, '.orbit', 'runs', run.id);
    expect(readFileSync(join(dir, 'final.md'), 'utf8')).toContain(`- Tried first: codex/gpt-6-astra, which failed (${reason})`);
    const json = JSON.parse(readFileSync(join(dir, 'final.json'), 'utf8')) as { no_standing_review: { failed_reviewers: { provider: string; reason: string }[] } };
    expect(json.no_standing_review.failed_reviewers).toEqual([{ provider: 'codex', model: 'gpt-6-astra', reason }]);
  }, 120_000);
});
