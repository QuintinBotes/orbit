/**
 * Issue #231: Review Voice as Orbit's same-family review pass (review.mode: review-voice). The controller runs Review
 * Voice's CLI on the exact candidate diff, outside any worker, and maps its review-output findings itself. The CLI is
 * tests/fakes/fake-review-voice.mjs; no model is called, and the live behaviour of the real CLI is not exercised here.
 *
 * US1 scenario 1: the exact candidate diff is reviewed and each finding is recorded with its anchor.
 * US1 scenario 2: a blocking finding sends the run to repair.
 * US1 scenario 3: a finding the owner declined is held back (Review Voice's own behaviour, played by the fake).
 * US1 scenario 4: a risky change gets exactly one Review Voice pass and one cross-model pass, and no other same-family pass.
 * Edge cases: a CLI that is not installed, and one that fails twice, fall back to the default reviewer with the fallback recorded;
 * one failure is retried once.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { OrbitConfig } from '../../src/policy/types.ts';
import { listFindings, listReviews } from '../../src/review/store.ts';
import { listDecisions } from '../../src/storage/decisions.ts';
import { listWorkers } from '../../src/storage/workers.ts';
import { drive, makeLab, ORBIT_ROOT, READY, startLabRun, writeScenario, type Lab } from './helpers/lab.ts';
import { APPROVE, GOAL, GOOD_IMPLEMENTATION, implementer, NOT_FOUND_TEXT, planner, review, scenario, type Edit } from './helpers/scenarios.ts';
import { assertRunInvariants, transitions } from './helpers/invariants.ts';

const FAKE_RV = join(ORBIT_ROOT, 'tests', 'fakes', 'fake-review-voice.mjs');
const FALLBACK_KIND = 'review.review-voice-fallback';

const labs: Lab[] = [];
const dirs: string[] = [];
afterEach(() => {
  labs.splice(0).forEach((l) => l.close());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

interface RvScript {
  declined?: string[];
  calls: object[];
}

/** A lab whose Codex implementer makes the change risky, with Review Voice's command pointing at the fake (or at `command`). */
function rvLab(script: RvScript, opts: { mode?: 'default' | 'review-voice'; command?: string[]; timeoutS?: number; reviewRounds?: number } = {}): { l: Lab; log: () => { base: string; head: string; cwd: string }[] } {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-rv-'));
  dirs.push(dir);
  const scriptPath = join(dir, 'script.json');
  writeFileSync(scriptPath, JSON.stringify(script));
  const l = makeLab({
    tweak(c: OrbitConfig) {
      c.routing.implementers = ['codex', 'claude'];
      c.review.mode = opts.mode ?? 'review-voice';
      if (opts.reviewRounds !== undefined) c.scheduler.hard_limits.review_rounds = opts.reviewRounds;
      c.review.review_voice = { command: opts.command ?? [process.execPath, FAKE_RV, '--script', scriptPath], ...(opts.timeoutS !== undefined ? { timeout_s: opts.timeoutS } : {}) };
    },
  });
  labs.push(l);
  const log = () => {
    try {
      return readFileSync(`${scriptPath}.log`, 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x) as { base: string; head: string; cwd: string });
    } catch {
      return [];
    }
  };
  return { l, log };
}

const RISKY = planner({
  allowed: ['src/server.ts', 'src/notes/**', 'tests/unit/**'],
  files: [
    ['src/server.ts', 'modify', 'new not-found text'],
    ['tests/unit/server.test.ts', 'modify', 'assert the text'],
    ['src/notes/not-found.md', 'add', 'note the text'],
  ],
  risks: [{ risk: 'the not-found handler sits in front of the auth token check', impact: 'high', mitigation: 'keep the check order' }],
});

const TEXT_ASSERTION = `    assert.equal(handle('/nope', new URLSearchParams()).body, '${NOT_FOUND_TEXT}');\n`;
const REPAIR: Edit = { op: 'replace', path: 'tests/unit/server.test.ts', find: TEXT_ASSERTION, replace: `${TEXT_ASSERTION}    assert.equal(handle('/nope/deeper', new URLSearchParams()).body, '${NOT_FOUND_TEXT}');\n` };

const reviewerWorkers = (l: Lab, runId: string) => listWorkers(l.db(), { runId, role: 'reviewer' });
const rvReviews = (l: Lab, runId: string) => listReviews(l.db(), runId, { includeInvalidated: true }).filter((r) => r.model === 'review-voice');

describe.skipIf(!READY)('acceptance: Review Voice as the same-family review pass (issue #231)', () => {
  it('US1 scenario 1: the exact candidate diff is reviewed outside any worker, and every finding is recorded with its anchor', async () => {
    const { l, log } = rvLab({ calls: [{ fromDiff: 'minor' }] });
    writeScenario(l, scenario({ planner: [RISKY], implementer: [GOOD_IMPLEMENTATION()] }));
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const cand = l.db().get<{ commit_sha: string }>('SELECT commit_sha FROM candidates WHERE run_id = ? ORDER BY seq DESC', run.id)!.commit_sha;
    // One call, on the run's base revision and the candidate's commit.
    expect(log()).toEqual([expect.objectContaining({ base: done.baseRevision, head: cand })]);
    const [rv] = rvReviews(l, run.id);
    expect(rv).toBeDefined();
    expect(rv!.provider).toBe('codex');
    expect(rv!.workerId).toBeNull();
    const findings = listFindings(l.db(), run.id).filter((f) => f.reviewId === rv!.id);
    expect(findings.map((f) => [f.externalId, f.severity, f.location]).sort()).toEqual([
      ['RV-1', 'low', 'src/server.ts:1'],
      ['RV-2', 'low', 'tests/unit/server.test.ts:1'],
    ]);
    assertRunInvariants(l, run.id);
  }, 300_000);

  it('US1 scenario 2: a blocking finding sends the run to repair, as with Orbit\'s own reviewer', async () => {
    const { l, log } = rvLab({ calls: [{ findings: [{ severity: 'blocking', path: 'tests/unit/server.test.ts', line: 20, category: 'correctness', text: 'Only one unknown path is asserted. A nested one is not covered.' }] }, { findings: [] }] });
    writeScenario(l, scenario({ planner: [RISKY], implementer: [GOOD_IMPLEMENTATION(), implementer([REPAIR], { refs: [{ criterion_id: null, ref: 'tests/unit/server.test.ts', note: 'validation for finding RV-1' }] })] }));
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const reviews = rvReviews(l, run.id);
    expect(reviews.map((r) => r.verdict)).toEqual(['REPAIR_REQUIRED', 'APPROVE']);
    const first = listFindings(l.db(), run.id).filter((f) => f.reviewId === reviews[0]!.id);
    expect(first.map((f) => [f.externalId, f.severity, f.location])).toEqual([['RV-1', 'high', 'tests/unit/server.test.ts:20']]);
    expect(transitions(l.db(), run.id)).toContain('REPAIRING');
    // Each pass reviews its own candidate's commit against the run's base: the repaired candidate is not reviewed as the first.
    const commits = l.db().all<{ commit_sha: string }>('SELECT commit_sha FROM candidates WHERE run_id = ? ORDER BY seq', run.id).map((c) => c.commit_sha);
    expect(commits).toHaveLength(2);
    expect(log().map((c) => [c.base, c.head])).toEqual(commits.map((c) => [done.baseRevision, c]));
    assertRunInvariants(l, run.id);
  }, 300_000);

  it('US1 scenario 3: a finding the owner declined is held back, and an identical one the owner kept is recorded (positive control)', async () => {
    const found = [
      { severity: 'important', path: 'src/server.ts', line: 7, category: 'correctness', text: 'Declined pattern. It repeats an old comment.' },
      { severity: 'important', path: 'src/server.ts', line: 9, category: 'correctness', text: 'Different problem. It changes behaviour.' },
    ];
    const held = rvLab({ declined: ['src/server.ts:7'], calls: [{ findings: found }] });
    writeScenario(held.l, scenario({ planner: [RISKY], implementer: [GOOD_IMPLEMENTATION()] }));
    const run = startLabRun(held.l, GOAL);
    expect((await drive(held.l, run.id)).state).toBe('SUCCEEDED');
    const heldFindings = listFindings(held.l.db(), run.id).filter((f) => rvReviews(held.l, run.id).some((r) => r.id === f.reviewId));
    expect(heldFindings.map((f) => f.location)).toEqual(['src/server.ts:9']);

    const control = rvLab({ calls: [{ findings: found }] });
    writeScenario(control.l, scenario({ planner: [RISKY], implementer: [GOOD_IMPLEMENTATION()] }));
    const run2 = startLabRun(control.l, GOAL);
    expect((await drive(control.l, run2.id)).state).toBe('SUCCEEDED');
    const kept = listFindings(control.l.db(), run2.id).filter((f) => rvReviews(control.l, run2.id).some((r) => r.id === f.reviewId));
    expect(kept.map((f) => f.location).sort()).toEqual(['src/server.ts:7', 'src/server.ts:9']);
    expect(kept.every((f) => f.severity === 'medium')).toBe(true);
  }, 400_000);

  it('US1 scenario 4: a risky change gets exactly one Review Voice pass and one cross-model pass, and no other same-family pass; the default mode keeps the same-family session (positive control)', async () => {
    const { l, log } = rvLab({ calls: [{ findings: [] }] });
    writeScenario(l, scenario({ planner: [RISKY], implementer: [GOOD_IMPLEMENTATION()] }));
    const run = startLabRun(l, GOAL);
    expect((await drive(l, run.id)).state).toBe('SUCCEEDED');
    expect(log()).toHaveLength(1);
    expect(reviewerWorkers(l, run.id).map((w) => w.provider)).toEqual(['claude']);
    expect(reviewerWorkers(l, run.id).some((w) => w.purpose?.startsWith('review-family:') === true)).toBe(false);
    expect(listReviews(l.db(), run.id).map((r) => `${r.provider}/${r.model === 'review-voice' ? 'review-voice' : 'model'}`).sort()).toEqual(['claude/model', 'codex/review-voice']);
    const report = readFileSync(join(l.runDir(run.id), 'final.md'), 'utf8');
    expect(report).toMatch(/Review Voice review/);

    const off = rvLab({ calls: [{ findings: [] }] }, { mode: 'default' });
    writeScenario(off.l, scenario({ planner: [RISKY], implementer: [GOOD_IMPLEMENTATION()] }));
    const run2 = startLabRun(off.l, GOAL);
    expect((await drive(off.l, run2.id)).state).toBe('SUCCEEDED');
    expect(off.log()).toHaveLength(0);
    expect(reviewerWorkers(off.l, run2.id).filter((w) => w.purpose?.startsWith('review-family:') === true).map((w) => w.provider)).toEqual(['codex']);
  }, 400_000);

  it('edge case: a CLI that is not installed falls back to the default same-family reviewer, and the fallback is recorded', async () => {
    const { l } = rvLab({ calls: [] }, { command: [join(tmpdir(), 'orbit-no-such-review-voice')] });
    writeScenario(l, scenario({ planner: [RISKY], implementer: [GOOD_IMPLEMENTATION()] }));
    const run = startLabRun(l, GOAL);
    expect((await drive(l, run.id)).state).toBe('SUCCEEDED');
    expect(listDecisions(l.db(), run.id, { kind: FALLBACK_KIND }).map((d) => (d.data as { reason: string }).reason)).toEqual([expect.stringMatching(/not installed|not found|cannot be run/)]);
    expect(rvReviews(l, run.id)).toEqual([]);
    expect(reviewerWorkers(l, run.id).filter((w) => w.purpose?.startsWith('review-family:') === true).map((w) => w.provider)).toEqual(['codex']);
  }, 300_000);

  it('edge case: a CLI that fails once is retried once and its review is used; one that fails twice falls back, recorded', async () => {
    const once = rvLab({ calls: [{ fail: true }, { findings: [] }] });
    writeScenario(once.l, scenario({ planner: [RISKY], implementer: [GOOD_IMPLEMENTATION()] }));
    const run = startLabRun(once.l, GOAL);
    expect((await drive(once.l, run.id)).state).toBe('SUCCEEDED');
    expect(once.log()).toHaveLength(2);
    expect(rvReviews(once.l, run.id)).toHaveLength(1);
    expect(listDecisions(once.l.db(), run.id, { kind: FALLBACK_KIND })).toEqual([]);

    const twice = rvLab({ calls: [{ fail: true }] });
    writeScenario(twice.l, scenario({ planner: [RISKY], implementer: [GOOD_IMPLEMENTATION()] }));
    const run2 = startLabRun(twice.l, GOAL);
    expect((await drive(twice.l, run2.id)).state).toBe('SUCCEEDED');
    expect(twice.log()).toHaveLength(2);
    expect(listDecisions(twice.l.db(), run2.id, { kind: FALLBACK_KIND })).toHaveLength(1);
    expect(rvReviews(twice.l, run2.id)).toEqual([]);
    expect(reviewerWorkers(twice.l, run2.id).filter((w) => w.purpose?.startsWith('review-family:') === true).map((w) => w.provider)).toEqual(['codex']);
  }, 400_000);

  it('a document that is not a review-output falls back without a retry, and the decision names why', async () => {
    const { l, log } = rvLab({ calls: [{ raw: '{"nope":true}' }] });
    writeScenario(l, scenario({ planner: [RISKY], implementer: [GOOD_IMPLEMENTATION()] }));
    const run = startLabRun(l, GOAL);
    expect((await drive(l, run.id)).state).toBe('SUCCEEDED');
    expect(log()).toHaveLength(1);
    expect(listDecisions(l.db(), run.id, { kind: FALLBACK_KIND }).map((d) => (d.data as { reason: string }).reason)).toEqual([expect.stringMatching(/review-output/)]);
    expect(rvReviews(l, run.id)).toEqual([]);
    expect(reviewerWorkers(l, run.id).filter((w) => w.purpose?.startsWith('review-family:') === true).map((w) => w.provider)).toEqual(['codex']);
  }, 300_000);

  it('a CLI that never answers and ignores SIGTERM is killed at review.review_voice.timeout_s, retried once, and the run falls back', async () => {
    const { l, log } = rvLab({ calls: [{ hang: true }] }, { timeoutS: 1 });
    writeScenario(l, scenario({ planner: [RISKY], implementer: [GOOD_IMPLEMENTATION()] }));
    const run = startLabRun(l, GOAL);
    expect((await drive(l, run.id)).state).toBe('SUCCEEDED');
    expect(log()).toHaveLength(2);
    expect(listDecisions(l.db(), run.id, { kind: FALLBACK_KIND }).map((d) => (d.data as { reason: string }).reason)).toEqual([expect.stringMatching(/timed out after 1 s/)]);
  }, 300_000);

  it('after the first candidate fell back, the repaired candidate makes no CLI call and goes to the default reviewer', async () => {
    const LOW = { id: 'COR-1', severity: 'low', category: 'correctness', location: 'tests/unit/server.test.ts:20', claim: 'The new text is asserted for one unknown path only; a nested unknown path is not covered.', evidence: "The unit test calls handle('/nope') and no other unknown path.", suggested_validation: "Assert the text for handle('/nope/deeper') as well." };
    const { l, log } = rvLab({ calls: [{ fail: true }] }, { reviewRounds: 6 });
    writeScenario(
      l,
      scenario({
        planner: [RISKY],
        implementer: [GOOD_IMPLEMENTATION(), implementer([REPAIR], { refs: [{ criterion_id: null, ref: 'tests/unit/server.test.ts', note: 'validation for finding COR-1' }] })],
        // Candidate 1: the cross-model review asks for repair, the fallback same-family session approves; candidate 2: both approve.
        reviewer: [review('REPAIR_REQUIRED', [LOW]), APPROVE, APPROVE, APPROVE],
      }),
    );
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(l.db().all('SELECT id FROM candidates WHERE run_id = ?', run.id)).toHaveLength(2);
    // The two calls of candidate 1 (one retry); none for candidate 2.
    expect(log()).toHaveLength(2);
    expect(listDecisions(l.db(), run.id, { kind: FALLBACK_KIND })).toHaveLength(1);
    expect(reviewerWorkers(l, run.id).filter((w) => w.purpose?.startsWith('review-family:') === true)).toHaveLength(2);
  }, 400_000);
});
