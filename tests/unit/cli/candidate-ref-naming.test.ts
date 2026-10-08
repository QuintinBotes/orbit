/**
 * Issue #33 (0.2.1 retest): `orbit status` and the final report named a branch `orbit/<run>` for runs that never reached
 * delivery, where no such branch exists: PREFLIGHT chooses the name, and the branch is only created when the reviewed
 * candidate is delivered. What exists before that is the candidate, pinned at refs/orbit/<run>/candidates/<seq>
 * (evidence/candidate.ts), and that is what they name now.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { renderRunStatus, buildRunStatus } from '../../../src/cli/commands/status.ts';
import { systemClock } from '../../../src/core/clock.ts';
import { buildFinalReport, renderMarkdown } from '../../../src/controller/report.ts';
import { getRun } from '../../../src/controller/run-store.ts';
import type { RunState } from '../../../src/controller/states.ts';
import { makeLab, type Lab } from './lab.ts';

const labs: Lab[] = [];
const lab = () => {
  const l = makeLab();
  labs.push(l);
  return l;
};
afterEach(() => labs.splice(0).forEach((l) => l.close()));

const VERIFYING: RunState[] = ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'VERIFYING'];

/** A run PREFLIGHT gave its branch name, with one READY candidate, ended in `end`. */
function candidateRun(l: Lab, end: 'BLOCKED' | 'EXHAUSTED' | 'SUCCEEDED', delivered = false) {
  const run = l.newRun('Add mul.');
  l.db().run('UPDATE runs SET branch = ? WHERE id = ?', `orbit/${run.id}`, run.id);
  l.db().run("INSERT INTO candidates (id, run_id, seq, attempt, worker_id, commit_sha, tree_hash, parent_sha, status, created_at) VALUES (?, ?, 1, 1, NULL, 'c0ffee', 'tree1', 'base1', 'READY', ?)", `cand-${run.id}`, run.id, Date.now());
  l.moveTo(run.id, end === 'SUCCEEDED' ? [...VERIFYING, 'REVIEWING', 'DELIVERING'] : VERIFYING);
  if (end === 'SUCCEEDED') l.moveTo(run.id, ['SUCCEEDED']);
  else l.moveTo(run.id, [end]);
  // A local delivery records the branch it created in the outcome.
  const outcome = delivered ? { branch: `orbit/${run.id}`, commit: 'c0ffee' } : {};
  l.db().run('UPDATE runs SET outcome_reason = ?, outcome_json = ? WHERE id = ?', 'the reason', JSON.stringify({ state: end, reason: 'the reason', ...outcome }), run.id);
  return getRun(l.db(), run.id);
}

const report = (l: Lab, run: ReturnType<typeof getRun>) => buildFinalReport(l.db(), run, { runDir: l.base, clock: systemClock, snapshot: null });

describe('orbit status', () => {
  it('names the candidate ref that exists, not the planned branch, for a run that never delivered', () => {
    const l = lab();
    const run = candidateRun(l, 'BLOCKED');
    const status = buildRunStatus({ clock: systemClock }, l.db(), run);
    expect(status.branch).toBeNull();
    expect(status.candidate_ref).toBe(`refs/orbit/${run.id}/candidates/1`);
    const text = renderRunStatus(status, Date.now());
    expect(text).toContain(`candidate: refs/orbit/${run.id}/candidates/1`);
    expect(text).not.toMatch(/branch: orbit\//);
  });

  it('names the branch once delivery created it, and no candidate before there is one', () => {
    const l = lab();
    const run = candidateRun(l, 'SUCCEEDED', true);
    const status = buildRunStatus({ clock: systemClock }, l.db(), run);
    expect(status.branch).toBe(run.branch);
    expect(renderRunStatus(status, Date.now())).toContain(`branch: orbit/${run.id}`);
    const fresh = l.newRun('Another goal.');
    l.db().run('UPDATE runs SET branch = ? WHERE id = ?', `orbit/${fresh.id}`, fresh.id);
    const none = buildRunStatus({ clock: systemClock }, l.db(), getRun(l.db(), fresh.id));
    expect(none).toMatchObject({ branch: null, candidate_ref: null });
    expect(renderRunStatus(none, Date.now())).not.toMatch(/branch:|candidate:/);
  });
});

/** The action row a successful push leaves (delivery/deliver.ts), the first durable record that the branch exists. */
function pushAction(l: Lab, runId: string, state: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN', ref = `refs/heads/orbit/${runId}`) {
  l.db().run(
    'INSERT INTO actions (id, run_id, kind, idempotency_key, target_json, state, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
    `act-${runId}-${state}`,
    runId,
    'push',
    `deliver:${runId}:push:${state}`,
    JSON.stringify({ remote: 'origin', ref, commit: 'c0ffee' }),
    state,
    Date.now(),
    Date.now(),
  );
}

describe('a delivery that pushed the branch and then failed', () => {
  it('names the branch in status and the report: it exists on the remote, though no delivery was recorded', () => {
    const l = lab();
    const run = candidateRun(l, 'BLOCKED');
    pushAction(l, run.id, 'SUCCEEDED');
    const status = buildRunStatus({ clock: systemClock }, l.db(), getRun(l.db(), run.id));
    expect(status.branch).toBe(`orbit/${run.id}`);
    expect(renderRunStatus(status, Date.now())).toContain(`branch: orbit/${run.id}`);
    const r = report(l, getRun(l.db(), run.id));
    expect(r.revision.branch).toBe(`orbit/${run.id}`);
    expect(renderMarkdown(r)).toContain(`branch: orbit/${run.id}`);
  });

  it('names no branch for a push that did not succeed, or whose outcome is unknown', () => {
    const l = lab();
    const failed = candidateRun(l, 'BLOCKED');
    pushAction(l, failed.id, 'FAILED');
    expect(buildRunStatus({ clock: systemClock }, l.db(), getRun(l.db(), failed.id)).branch).toBeNull();
    const unknown = candidateRun(l, 'BLOCKED');
    pushAction(l, unknown.id, 'UNKNOWN');
    expect(buildRunStatus({ clock: systemClock }, l.db(), getRun(l.db(), unknown.id)).branch).toBeNull();
  });

  it('names no branch when the push record does not name one', () => {
    const l = lab();
    const run = candidateRun(l, 'BLOCKED');
    pushAction(l, run.id, 'SUCCEEDED', 'refs/tags/v1');
    expect(buildRunStatus({ clock: systemClock }, l.db(), getRun(l.db(), run.id)).branch).toBeNull();
    const garbled = candidateRun(l, 'BLOCKED');
    pushAction(l, garbled.id, 'SUCCEEDED');
    l.db().run('UPDATE actions SET target_json = ? WHERE run_id = ?', '{not json', garbled.id);
    expect(buildRunStatus({ clock: systemClock }, l.db(), getRun(l.db(), garbled.id)).branch).toBeNull();
  });

  it('names the branch the push recorded, not one the run only planned', () => {
    const l = lab();
    const run = candidateRun(l, 'BLOCKED');
    l.db().run('UPDATE runs SET branch = NULL WHERE id = ?', run.id);
    pushAction(l, run.id, 'SUCCEEDED', 'refs/heads/orbit/custom-prefix-1');
    expect(buildRunStatus({ clock: systemClock }, l.db(), getRun(l.db(), run.id)).branch).toBe('orbit/custom-prefix-1');
  });
});

describe('the final report', () => {
  it('names the candidate ref and no branch for a run that never delivered, in the revision, the markdown and the next action', () => {
    const l = lab();
    for (const end of ['BLOCKED', 'EXHAUSTED'] as const) {
      const run = candidateRun(l, end);
      const r = report(l, run);
      expect(r.revision).toMatchObject({ branch: null, candidate: 'c0ffee', candidate_ref: `refs/orbit/${run.id}/candidates/1` });
      const md = renderMarkdown(r);
      expect(md).toContain(`candidate ref: refs/orbit/${run.id}/candidates/1`);
      expect(md).toContain('branch: none');
      expect(md).not.toContain(`orbit/${run.id}\n`);
      expect(r.next_action).not.toMatch(new RegExp(`(?<!refs/)orbit/${run.id}`));
    }
  });

  it('keeps the branch of a run that delivered, and points the next action at it', () => {
    const l = lab();
    const run = candidateRun(l, 'SUCCEEDED', true);
    const r = report(l, run);
    expect(r.revision.branch).toBe(`orbit/${run.id}`);
    expect(r.revision.candidate_ref).toBe(`refs/orbit/${run.id}/candidates/1`);
    expect(r.next_action).toBe(`Inspect the local branch orbit/${run.id} (the reviewed candidate) and merge it yourself if you accept it.`);
  });

  it('says so, in the next action, when a succeeded run recorded no branch: the candidate ref is what there is', () => {
    const l = lab();
    const run = candidateRun(l, 'SUCCEEDED');
    l.db().run('UPDATE runs SET branch = NULL WHERE id = ?', run.id);
    expect(report(l, getRun(l.db(), run.id)).next_action).toBe(`Inspect the reviewed candidate at refs/orbit/${run.id}/candidates/1 (git log refs/orbit/${run.id}/candidates/1) and merge it yourself if you accept it.`);
  });
});
