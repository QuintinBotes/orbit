/**
 * `orbit queue list` and `orbit queue run` (issue #171), in this process, over the real controller loop, git
 * repositories (a checkout on `next` and a bare remote), SQLite state, worker shim and the fake provider CLIs. Issues,
 * pull requests and comments live in the fake GitHub files the fake delivery provider selects; a "person" merging a
 * pull request is the test, through the queue's wait seam. Nothing here reaches GitHub or a model.
 */
import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../../../src/cli/cli.ts';
import { memoryIo } from '../../../src/cli/io.ts';
import type { CliContext, CliSeams } from '../../../src/cli/context.ts';
import type { QueueRecord } from '../../../src/cli/commands/queue.ts';
import { listRuns, type RunRecord } from '../../../src/controller/run-store.ts';
import { stateDbPath } from '../../../src/controller/start.ts';
import { FakeGitHub } from '../../../src/delivery/github.ts';
import { FakeIssueReader, FAKE_ISSUES_FILE, type FakeIssue } from '../../../src/intake/github.ts';
import { readIssueGoal } from '../../../src/intake/issue.ts';
import { failureClass } from '../../../src/intake/comment.ts';
import type { OrbitConfig, PolicySnapshot } from '../../../src/policy/types.ts';
import { APPROVE, argvCalls, baseScenario, DIAGNOSIS, git, IMPLEMENTER_OUTPUT, labDeps, makeLab, PLANNER_OUTPUT, seedRegistry, writeScenario, type Lab } from '../controller/harness.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);
const READY = ['spec', 'ready-for-agent'];

// ---------------------------------------------------------------------------
// the lab: a checkout on next, a bare remote, fake issues and pull requests

interface QueueLab extends Lab {
  remote: string;
}

const labs: Lab[] = [];
afterEach(() => labs.splice(0).forEach((l) => l.close()));

function lab(mode: 'autonomous-delivery' | 'autonomous' | 'supervised' = 'autonomous-delivery', tweak?: (c: OrbitConfig) => void): QueueLab {
  const l = makeLab({
    tweak: (c) => {
      c.mode = mode;
      c.delivery = { ...c.delivery, provider: 'fake', require_ci: false };
      if (mode === 'autonomous-delivery') c.actions = { ...c.actions, commit: true, push_task_branch: true, open_pull_request: true, read_ci_logs: true, repair_ci: true };
      tweak?.(c);
    },
  });
  labs.push(l);
  const remote = join(l.base, 'remote.git');
  git(l.base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(l.repo, 'remote', 'add', 'origin', remote);
  git(l.repo, 'push', '-q', 'origin', 'main');
  // The repository's default branch is main; the queue works against next, as orbit#165 does.
  git(l.repo, 'switch', '-q', '-c', 'next');
  git(l.repo, 'push', '-q', 'origin', 'next');
  git(l.repo, 'config', 'user.name', 'Acme Controller');
  git(l.repo, 'config', 'user.email', 'controller@acme.test');
  return { ...l, remote };
}

function issues(l: Lab): FakeIssueReader {
  return new FakeIssueReader({ statePath: join(l.repo, '.orbit', FAKE_ISSUES_FILE) });
}

function github(l: QueueLab): FakeGitHub {
  return new FakeGitHub({ statePath: join(l.repo, '.orbit', 'fake-github.json'), remoteGitDir: l.remote });
}

function seams(l: Lab, more: Partial<CliSeams> = {}): CliSeams {
  return {
    pollMs: 20,
    controller: { tickIntervalMs: 20, leaseTtlMs: 30_000, graceMs: 300, shutdownGraceMs: 400, startGraceMs: 2_000 },
    controllerDeps: (input) => {
      seedRegistry(input.db!);
      return labDeps(l, input.db);
    },
    // A test that does not merge anything must not wait: the queue would only sleep.
    queueWait: async () => {
      throw new Error('the queue waited, and this test does not expect it to');
    },
    ...more,
  };
}

async function cli(l: Lab, argv: string[], more: Partial<CliSeams> = {}, over: Partial<CliContext> = {}) {
  const io = memoryIo();
  const code = await main(argv, { io, cwd: l.repo, homeDir: l.base, orbitHome: l.orbitHome, env: { ...process.env, ORBIT_HOME: l.orbitHome, HOME: l.base }, user: 'alice', seams: seams(l, more), ...over });
  return { code, out: io.stdout, err: io.stderr };
}

// ---------------------------------------------------------------------------
// issues: each adds one function in its own file, so their pull requests merge independently

const OPS: Record<string, [string, number]> = { sub: ['-', 3], div: ['/', 2], pow: ['**', 216], mod: ['%', 0], max: ['>= b ? a :', 6] };

function spec(fn: string): string {
  return [
    '## Summary',
    '',
    `The calculator gains \`${fn}\`.`,
    '',
    '## User Scenarios & Testing',
    '',
    `### User Story 1 - ${fn} two numbers (Priority: P1)`,
    '',
    `A caller uses \`${fn}\`.`,
    '',
    '**Why this priority**: It is the feature.',
    '',
    `**Independent Test**: Call \`${fn}(6, 3)\` and compare.`,
    '',
    '**Acceptance Scenarios**:',
    '',
    `1. **Given** the calculator, **When** \`${fn}(6, 3)\` is called, **Then** it returns ${OPS[fn]![1]}.`,
    '',
    '## Requirements',
    '',
    '### Functional Requirements',
    '',
    `- **FR-001**: \`apps/${fn}.mjs\` MUST export \`${fn}\`.`,
    '',
    '## Success Criteria',
    '',
    '### Measurable Outcomes',
    '',
    `- **SC-001**: The unit check passes with a test for \`${fn}\`.`,
    '',
  ].join('\n');
}

function put(l: Lab, number: number, fn: string, o: Partial<FakeIssue> = {}): void {
  issues(l).put({ number, title: `Add ${fn}`, body: spec(fn), labels: READY, ...o });
}

function planner(fn: string): object {
  return {
    structured: {
      ...PLANNER_OUTPUT,
      objective: `Add ${fn} to the calculator.`,
      criteria: [{ key: 'S1-1', statement: `${fn}(6, 3) works`, mandatory: true, ui: false, proof: [`tests/${fn}.test.mjs`], check_ids: ['unit'], changes: [{ path: `apps/${fn}.mjs`, summary: `add ${fn}` }], kind: 'change', tests: [`tests/${fn}.test.mjs`] }],
      expected_changed_files: [
        { path: `apps/${fn}.mjs`, change: 'add', reason: `add ${fn}` },
        { path: `tests/${fn}.test.mjs`, change: 'add', reason: 'behaviour test' },
      ],
      non_goals: ['Change add'],
    },
  };
}

function implement(fn: string, wrong = false): object {
  const [op, want] = OPS[fn]!;
  return {
    edits: [
      { op: 'write', path: `apps/${fn}.mjs`, content: `export const ${fn} = (a, b) => a ${wrong ? '+' : op} b;\n` },
      { op: 'write', path: `tests/${fn}.test.mjs`, content: `import { ${fn} } from '../apps/${fn}.mjs';\nif (${fn}(6, 3) !== ${want}) { console.error('${fn}(6, 3) expected ${want}, got ' + ${fn}(6, 3)); process.exit(1); }\n` },
    ],
    structured: {
      ...IMPLEMENTER_OUTPUT,
      summary: `added ${fn} and a behaviour test`,
      changed_paths: [
        { path: `apps/${fn}.mjs`, change: 'add', purpose: `add ${fn}` },
        { path: `tests/${fn}.test.mjs`, change: 'add', purpose: 'behaviour test' },
      ],
      tests_added: [{ path: `tests/${fn}.test.mjs`, name: `${fn} works`, kind: 'unit', criterion_ids: ['AC-1'] }],
    },
  };
}

/** A diagnosis that rules out every hypothesis: the run ends IMPOSSIBLE after one attempt. */
const RULED_OUT = (() => {
  const d = structuredClone(DIAGNOSIS) as { structured: { competing_hypotheses: { status: string; refuting_evidence: string[] }[]; confidence: string } };
  for (const h of d.structured.competing_hypotheses) {
    h.status = 'ruled-out';
    h.refuting_evidence = ['the experiment recorded for it showed the opposite of what it predicts'];
  }
  d.structured.confidence = 'low';
  return d;
})();

/** Every run, oldest first, with the issue it was started from. */
function runs(l: Lab): (RunRecord & { issue: number })[] {
  return listRuns(l.db(), { limit: -1 })
    .map((r) => ({ ...r, issue: readIssueGoal(join(l.repo, '.orbit', 'runs', r.id))?.number ?? 0 }))
    .sort((a, b) => a.createdAt - b.createdAt);
}

function record(l: Lab): QueueRecord {
  const dir = join(l.repo, '.orbit', 'queue');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  expect(files).toHaveLength(1);
  return JSON.parse(readFileSync(join(dir, files[0]!), 'utf8')) as QueueRecord;
}

const outcomes = (r: QueueRecord) => r.issues.map((i) => [i.number, i.outcome, i.attempts.length]);

// ---------------------------------------------------------------------------

describe.skipIf(!canStripTypes)('orbit queue run', () => {
  it('story 1, scenario 1: of A, B and C where B blocks C, C starts only after B\'s pull request merges, from a base that holds it', async () => {
    const l = lab();
    put(l, 1, 'sub');
    put(l, 2, 'div');
    put(l, 3, 'pow', { blockedBy: [2] });
    writeScenario(l, baseScenario({ planner: [planner('sub'), planner('div'), planner('pow')], implementer: [implement('sub'), implement('div'), implement('pow')] }));
    let mergedAt = 0;
    let mergedTip = '';
    let waits = 0;
    // The person: marks B's pull request ready and merges it into next while the queue waits.
    const queueWait = async (): Promise<void> => {
      waits++;
      const gh = github(l);
      const pr = gh.state.prs.find((p) => p.body.startsWith('Closes #2') && p.state === 'OPEN');
      if (!pr) return;
      // Nothing of C has started while B was unmerged.
      expect(runs(l).map((r) => r.issue)).toEqual([1, 2]);
      await gh.markPullRequestReady(pr.number);
      await gh.mergePullRequest({ number: pr.number, headSha: (await gh.getMergeState(pr.number)).headRefOid, method: 'squash', deleteBranch: false });
      mergedAt = Date.now();
      mergedTip = git(l.remote, 'rev-parse', 'refs/heads/next');
    };
    const r = await cli(l, ['queue', 'run', '--base', 'next', '--policy', l.configPath], { queueWait });
    expect(r.code, `${r.out}\n${r.err}`).toBe(0);

    const all = runs(l);
    expect(all.map((x) => [x.issue, x.state])).toEqual([
      [1, 'SUCCEEDED'],
      [2, 'SUCCEEDED'],
      [3, 'SUCCEEDED'],
    ]);
    expect(waits).toBe(1);
    // C started after the merge, from next as it stood then: B's change is in its base, A's (unmerged) is not.
    const c = all[2]!;
    expect(c.createdAt).toBeGreaterThanOrEqual(mergedAt);
    expect(c.baseRevision).toBe(mergedTip);
    expect(git(l.remote, 'ls-tree', '--name-only', '-r', c.baseRevision!, 'apps')).toBe('apps/calc.mjs\napps/div.mjs');
    // A and B started from the same base: the one next had before any merge.
    expect(all[0]!.baseRevision).toBe(all[1]!.baseRevision);
    // Every pull request targets next, the configurable base branch, and closes its issue.
    const prs = github(l).state.prs;
    expect(prs.map((p) => [p.baseRefName, p.body.split('\n')[0]])).toEqual([
      ['next', 'Closes #1'],
      ['next', 'Closes #2'],
      ['next', 'Closes #3'],
    ]);
    // GitHub closes an issue only for the default branch: the queue closed B once its pull request merged into next.
    expect(issues(l).issue(2)).toMatchObject({ open: false, stateReason: 'completed' });
    expect(issues(l).comments(2)[0]).toMatch(/^Pull request #2 was merged into `next`, so Orbit's queue closes this issue\./);
    expect(issues(l).issue(1)!.open).not.toBe(false);
    expect(issues(l).writes).toEqual(['comment #2', 'close #2']);

    // The record: outcome, pull request and attempts per issue, and why the queue stopped.
    const rec = record(l);
    expect(outcomes(rec)).toEqual([
      [1, 'delivered', 1],
      [2, 'delivered', 1],
      [3, 'delivered', 1],
    ]);
    expect(rec.issues.map((i) => i.pull_request?.number)).toEqual([1, 2, 3]);
    expect(rec).toMatchObject({ base: 'next', label: 'ready-for-agent', stop: { kind: 'empty' }, closed: [{ number: 2, pr: 2 }] });
    expect(rec.spent_usd).toBeGreaterThan(0);
    expect(r.out).toContain('waiting for #2 to merge into next');
    expect(r.out).toContain('queue stopped: the frontier is empty');
    expect(r.out).toMatch(/#1 Add sub: delivered: pull request #1 waits to be merged into next/);

    // A pull request a person closes without merging gives its issue back to the frontier.
    github(l).setPullRequestState(1, 'CLOSED');
    const after = await cli(l, ['queue', 'list', '--base', 'next', '--policy', l.configPath]);
    expect(after.out).toMatch(/^frontier \(1, in priority order\):\n  #1 Add sub\n/);
  }, 300_000);

  it('story 1, scenario 2: an issue whose run fails goes to a person; an independent issue still runs, and its dependant is skipped with the reason', async () => {
    const l = lab('autonomous');
    put(l, 1, 'sub');
    put(l, 2, 'div');
    put(l, 3, 'pow', { blockedBy: [1] });
    writeScenario(l, baseScenario({ planner: [planner('sub'), planner('div')], implementer: [implement('sub', true), implement('div')], verifier: [RULED_OUT] }));
    const r = await cli(l, ['queue', 'run', '--base', 'next', '--attempts', '1', '--policy', l.configPath]);
    expect(r.code, `${r.out}\n${r.err}`).toBe(10);

    expect(runs(l).map((x) => [x.issue, x.state])).toEqual([
      [1, 'IMPOSSIBLE'],
      [2, 'SUCCEEDED'],
    ]);
    // The label and one comment built from the controller's records.
    expect(issues(l).issue(1)!.labels).toEqual(['spec', 'ready-for-agent', 'ready-for-human']);
    const comment = issues(l).comments(1);
    expect(comment).toHaveLength(1);
    expect(comment[0]).toMatch(/^Orbit's queue hands this issue to a person and labelled it `ready-for-human`/);
    const failed = runs(l).filter((x) => x.issue === 1);
    expect(comment[0]).toContain(`1 run ended without a delivered change:\n\n- Run \`${failed[0]!.id}\`: IMPOSSIBLE, failure class ${failureClass(failed[0]!)}, spend $`);
    // SC-002: a failed issue never starts a dependant.
    expect(runs(l).some((x) => x.issue === 3)).toBe(false);
    const rec = record(l);
    expect(outcomes(rec)).toEqual([
      [1, 'person', 1],
      [2, 'delivered', 1],
    ]);
    // Each attempt keeps the failure class its run recorded (ADR 0018).
    expect(rec.issues[0]!.attempts.map((a) => [a.run_id, a.failure_class, a.open_questions])).toEqual(failed.map((x) => [x.id, failureClass(x), 0]));
    expect(failed.every((x) => failureClass(x) !== 'none')).toBe(true);
    expect(rec.issues[1]).toMatchObject({ pull_request: null, branch: expect.stringMatching(/^orbit\/orb-/) });
    expect(rec.remaining).toMatchObject({ frontier: [], held: expect.arrayContaining([{ number: 3, title: 'Add pow', reason: 'blocked by #1 (needs a person: labelled ready-for-human)', blockedBy: [1] }]) });
    expect(r.out).toContain('#3 Add pow: blocked by #1 (needs a person: labelled ready-for-human)');
  }, 300_000);

  it('FR-004: two failed runs in a row stop the queue, also when both are attempts on one issue', async () => {
    const l = lab('autonomous');
    put(l, 1, 'sub');
    put(l, 2, 'div');
    // Issue 2 would deliver if the queue went on.
    writeScenario(l, baseScenario({ planner: [planner('sub'), planner('sub'), planner('div')], implementer: [implement('sub', true), implement('sub', true), implement('div')], verifier: [RULED_OUT, RULED_OUT] }));
    const r = await cli(l, ['queue', 'run', '--base', 'next', '--policy', l.configPath]);
    expect(r.code, `${r.out}\n${r.err}`).toBe(10);
    const failed = runs(l);
    expect(failed.map((x) => [x.issue, x.state])).toEqual([
      [1, 'IMPOSSIBLE'],
      [1, 'IMPOSSIBLE'],
    ]);
    const rec = record(l);
    expect(outcomes(rec)).toEqual([[1, 'person', 2]]);
    expect(rec.stop).toEqual({ kind: 'failed-runs', reason: `2 runs in a row ended without a delivered change (${failed[0]!.id} IMPOSSIBLE, ${failed[1]!.id} IMPOSSIBLE); look at them before the queue goes on` });
    // The issue still goes to a person, with both runs in its comment; the independent issue waits for the next queue.
    expect(issues(l).issue(1)!.labels).toEqual(['spec', 'ready-for-agent', 'ready-for-human']);
    expect(issues(l).comments(1)[0]).toContain('2 runs ended without a delivered change:');
    expect(rec.remaining).toMatchObject({ frontier: [{ number: 2, title: 'Add div' }] });
  }, 300_000);

  it('FR-004: fail, deliver, fail does not stop the queue; a spec that fails the check goes to a person without a run, which is no failed run', async () => {
    const l = lab('autonomous');
    issues(l).put({ number: 1, title: 'Vague', body: spec('sub').replace('It is the feature.', 'It is the feature [NEEDS CLARIFICATION: integers only?].'), labels: READY });
    put(l, 2, 'sub');
    put(l, 3, 'div');
    put(l, 4, 'pow');
    writeScenario(l, baseScenario({ planner: [planner('sub'), planner('div'), planner('pow')], implementer: [implement('sub', true), implement('div'), implement('pow', true)], verifier: [RULED_OUT, RULED_OUT] }));
    const r = await cli(l, ['queue', 'run', '--base', 'next', '--attempts', '1', '--policy', l.configPath]);
    expect(r.code, `${r.out}\n${r.err}`).toBe(10);
    expect(runs(l).map((x) => [x.issue, x.state])).toEqual([
      [2, 'IMPOSSIBLE'],
      [3, 'SUCCEEDED'],
      [4, 'IMPOSSIBLE'],
    ]);
    const rec = record(l);
    expect(outcomes(rec)).toEqual([
      [1, 'person', 0],
      [2, 'person', 1],
      [3, 'delivered', 1],
      [4, 'person', 1],
    ]);
    expect(rec.stop).toEqual({ kind: 'empty', reason: 'the frontier is empty' });
    // The spec's problem is quoted to the person who must fix it.
    expect(issues(l).comments(1)[0]).toContain('- line ');
    expect(issues(l).comments(1)[0]).toContain('[NEEDS CLARIFICATION: integers only?]');
  }, 300_000);

  it('story 2, scenario 1: with --max-issues 1 one issue runs, then the queue stops and lists the remaining frontier', async () => {
    const l = lab('autonomous');
    put(l, 1, 'sub');
    put(l, 2, 'div');
    put(l, 3, 'pow', { blockedBy: [2] });
    writeScenario(l, baseScenario({ planner: [planner('sub')], implementer: [implement('sub')] }));
    const r = await cli(l, ['queue', 'run', '--base', 'next', '--max-issues', '1', '--policy', l.configPath]);
    expect(r.code, `${r.out}\n${r.err}`).toBe(0);
    expect(runs(l).map((x) => [x.issue, x.state])).toEqual([[1, 'SUCCEEDED']]);
    expect(record(l)).toMatchObject({ stop: { kind: 'max-issues', reason: '--max-issues 1 reached' }, remaining: { frontier: [{ number: 2, title: 'Add div' }] } });
    expect(r.out).toContain('queue stopped: --max-issues 1 reached');
    expect(r.out).toMatch(/frontier \(1, in priority order\):\n  #2 Add div\nheld:\n  #1 Add sub: delivered by run orb-\S+ as branch orbit\/orb-\S+; waits for a person to merge it and close the issue\n  #3 Add pow: blocked by #2 \(open\)/);
  }, 300_000);

  it('in a mode that does not deliver, the queue waits for a person to merge and close a blocker before taking its dependant', async () => {
    const l = lab('supervised');
    put(l, 1, 'sub');
    put(l, 2, 'div', { blockedBy: [1] });
    writeScenario(l, baseScenario({ planner: [planner('sub'), planner('div')], implementer: [implement('sub'), implement('div')] }));
    let waits = 0;
    const queueWait = async (): Promise<void> => {
      waits++;
      if (waits < 3) return;
      // The person merges A's branch into next and closes A.
      const a = runs(l)[0]!;
      git(l.repo, 'push', '-q', 'origin', `${a.branch}:next`);
      await issues(l).close(1);
    };
    const r = await cli(l, ['queue', 'run', '--base', 'next', '--policy', l.configPath], { queueWait });
    expect(r.code, `${r.out}\n${r.err}`).toBe(0);
    expect(waits).toBe(3);
    const all = runs(l);
    expect(all.map((x) => [x.issue, x.state, x.mode])).toEqual([
      [1, 'SUCCEEDED', 'supervised'],
      [2, 'SUCCEEDED', 'supervised'],
    ]);
    expect(git(l.repo, 'ls-tree', '--name-only', '-r', all[1]!.baseRevision!, 'apps')).toBe('apps/calc.mjs\napps/sub.mjs');
    expect(r.out).toContain('waiting for #1 to merge into next');
  }, 300_000);

  it('stops at --budget-usd: each run is capped at what is left, and a run the cap ends does not hand its issue to a person', async () => {
    const l = lab('autonomous');
    put(l, 1, 'sub');
    put(l, 2, 'div');
    // The implementer's session costs more than the whole budget.
    writeScenario(l, baseScenario({ planner: [planner('sub')], implementer: [{ ...implement('sub'), usage: { costUSD: 1.6 } }] }));
    const r = await cli(l, ['queue', 'run', '--base', 'next', '--budget-usd', '1.5', '--policy', l.configPath]);
    expect(r.code, `${r.out}\n${r.err}`).toBe(0);
    expect(runs(l).map((x) => [x.issue, x.state])).toEqual([[1, 'BLOCKED']]);
    const snapshot = JSON.parse(readFileSync(runs(l)[0]!.policyPath, 'utf8')) as PolicySnapshot;
    expect(snapshot.config.scheduler.hard_limits.model_cost_usd).toBe(1.5);
    expect(l.config.scheduler.hard_limits.model_cost_usd).toBe(30);
    const rec = record(l);
    expect(rec.spent_usd).toBeGreaterThanOrEqual(1.5);
    expect(rec.stop).toMatchObject({ kind: 'budget', reason: expect.stringMatching(/^run orb-\S+ of #1 ran out of the \$1\.50 left of the budget of \$1\.5; the issue is not handed to a person; the run waits for a person to approve more spend \(orbit status orb-\S+ gives the command\), or orbit cancel orb-\S+$/) });
    expect(outcomes(rec)).toEqual([[1, 'budget', 1]]);
    expect(issues(l).writes).toEqual([]);
    expect(r.out).toMatch(/frontier \(2, in priority order\):\n  #1 Add sub\n  #2 Add div/);
  }, 300_000);

  it('with --budget-usd, a run its attempt cap ended is the issue\'s, not the budget\'s: it goes to a person and the queue goes on', async () => {
    const l = lab('autonomous', (c) => {
      c.scheduler.hard_limits.implementation_attempts = 1;
      c.scheduler.initial_allowances = { ...c.scheduler.initial_allowances, simple_attempts: 1, medium_attempts: 1, complex_attempts: 1 };
    });
    put(l, 1, 'sub');
    put(l, 2, 'div');
    writeScenario(l, baseScenario({ planner: [planner('sub'), planner('div')], implementer: [implement('sub', true), implement('div')] }));
    // Under the policy's $30, so the queue lowers every run's cap: that alone no longer makes an EXHAUSTED run the budget's.
    const r = await cli(l, ['queue', 'run', '--base', 'next', '--attempts', '1', '--budget-usd', '20', '--policy', l.configPath]);
    expect(r.code, `${r.out}\n${r.err}`).toBe(10);
    const all = runs(l);
    expect(all.map((x) => [x.issue, x.state])).toEqual([
      [1, 'EXHAUSTED'],
      [2, 'SUCCEEDED'],
    ]);
    expect(failureClass(all[0]!)).not.toMatch(/^budget/);
    const rec = record(l);
    expect(outcomes(rec)).toEqual([
      [1, 'person', 1],
      [2, 'delivered', 1],
    ]);
    expect(rec.stop).toMatchObject({ kind: 'empty' });
    expect(issues(l).issue(1)!.labels).toEqual(['spec', 'ready-for-agent', 'ready-for-human']);
  }, 300_000);

  it('a run that ran out of the queue\'s money after its session hit the turn cap (class turn-cap, then budget) stops the queue as budget, and the issue keeps its labels', async () => {
    const l = lab('autonomous');
    put(l, 1, 'sub');
    put(l, 2, 'div');
    // Attempt 1's session ends at its turn cap; the repair's session then costs more than the whole budget.
    writeScenario(l, baseScenario({ planner: [planner('sub')], implementer: [{ outcome: 'max_turns' }, { ...implement('sub'), usage: { costUSD: 1.6 } }], verifier: [DIAGNOSIS] }));
    // One attempt, so it is the run's own end that decides, not the queue's check before a second attempt.
    const r = await cli(l, ['queue', 'run', '--base', 'next', '--attempts', '1', '--budget-usd', '1.5', '--policy', l.configPath]);
    expect(r.code, `${r.out}\n${r.err}`).toBe(0);
    const all = runs(l);
    // Issue #254: at its cost cap the run waits BLOCKED for more spend; the record still says why it stopped.
    expect(all.map((x) => [x.issue, x.state])).toEqual([[1, 'BLOCKED']]);
    expect([all[0]!.failureClass, all[0]!.failureSecondary]).toEqual(['turn-cap', 'budget']);
    const rec = record(l);
    expect(outcomes(rec)).toEqual([[1, 'budget', 1]]);
    expect(rec.stop).toMatchObject({ kind: 'budget' });
    expect(issues(l).writes).toEqual([]);
  }, 300_000);

  // A review that asks for a repair the review_rounds cap leaves no round for: the run stops holding a verified candidate.
  const REPAIR_REQUIRED = {
    structured: {
      verdict: 'REPAIR_REQUIRED',
      candidate_revision: '$CANDIDATE',
      findings: [{ id: 'COR-1', severity: 'high', category: 'correctness', location: 'apps/sub.mjs:1', claim: 'sub accepts non-numeric arguments and returns NaN instead of throwing a TypeError.', evidence: 'sub("a", 2) evaluates "a" - 2, which is NaN.', suggested_validation: 'Add a test asserting that sub("a", 2) throws a TypeError.' }],
    },
  };

  it('a run that stops holding a verified candidate (BLOCKED with an offer, #169) is a failed run for FR-004, is not tried again, and goes to a person with the offer', async () => {
    const l = lab('autonomous', (c) => void (c.scheduler.hard_limits.review_rounds = 1));
    put(l, 1, 'sub');
    put(l, 2, 'div');
    put(l, 3, 'pow');
    writeScenario(l, baseScenario({ planner: [planner('sub'), planner('div')], implementer: [implement('sub'), implement('div', true)], verifier: [RULED_OUT], reviewer: [REPAIR_REQUIRED] }));
    const r = await cli(l, ['queue', 'run', '--base', 'next', '--policy', l.configPath]);
    expect(r.code, `${r.out}\n${r.err}`).toBe(10);
    const all = runs(l);
    expect(all.map((x) => [x.issue, x.state])).toEqual([
      [1, 'BLOCKED'],
      [2, 'IMPOSSIBLE'],
    ]);
    const rec = record(l);
    // One run of #1 (no second attempt), then #2's failed run is the second in a row: the queue stops before #3.
    expect(outcomes(rec)).toEqual([
      [1, 'person', 1],
      [2, 'person', 1],
    ]);
    expect(rec.issues[0]!.attempts[0]).toMatchObject({ state: 'BLOCKED', verified_candidate: true });
    expect(rec.stop).toMatchObject({ kind: 'failed-runs' });
    expect(issues(l).comments(1)[0]).toContain(`The last run holds a candidate that passed verification: \`orbit report ${all[0]!.id}\` gives the commands that deliver it as a draft pull request or discard it.`);
  }, 300_000);

  it('a run that runs out of the queue\'s money while holding a verified candidate stops the queue as budget, and the issue keeps its labels', async () => {
    const l = lab('autonomous');
    put(l, 1, 'sub');
    put(l, 2, 'div');
    // The candidate passes verification; the repair the review asks for then costs more than the whole budget.
    writeScenario(l, baseScenario({ planner: [planner('sub')], implementer: [implement('sub'), { ...implement('sub'), usage: { costUSD: 1.6 } }], reviewer: [REPAIR_REQUIRED] }));
    const r = await cli(l, ['queue', 'run', '--base', 'next', '--attempts', '1', '--budget-usd', '1.5', '--policy', l.configPath]);
    expect(r.code, `${r.out}\n${r.err}`).toBe(0);
    expect(runs(l).map((x) => [x.issue, x.state])).toEqual([[1, 'BLOCKED']]);
    const rec = record(l);
    expect(outcomes(rec)).toEqual([[1, 'budget', 1]]);
    expect(rec.stop).toMatchObject({ kind: 'budget', reason: expect.stringContaining('the run holds a verified candidate') });
    expect(issues(l).writes).toEqual([]);
  }, 300_000);

  it('SIGTERM during a run stops the queue: no further run, no failed run counted, and the issue keeps its labels', async () => {
    const l = lab('autonomous');
    put(l, 1, 'sub');
    put(l, 2, 'div');
    writeScenario(l, baseScenario({ planner: [planner('sub'), planner('div')], implementer: [implement('sub'), implement('div')] }));
    const signals = new EventEmitter();
    // `timeout`, systemd stop or docker stop: SIGTERM once the first run is under way.
    const timer = setInterval(() => {
      if (signals.listenerCount('SIGTERM') > 0 && runs(l).some((x) => x.state !== 'CREATED')) {
        clearInterval(timer);
        signals.emit('SIGTERM');
      }
    }, 20);
    const r = await cli(l, ['queue', 'run', '--base', 'next', '--attempts', '1', '--policy', l.configPath], { signals }).finally(() => clearInterval(timer));
    expect(r.code, `${r.out}\n${r.err}`).toBe(20);
    const all = runs(l);
    expect(all.map((x) => x.issue)).toEqual([1]);
    const rec = record(l);
    expect(outcomes(rec)).toEqual([[1, 'interrupted', 1]]);
    expect(rec.stop).toEqual({ kind: 'interrupted', reason: `interrupted during #1: run ${all[0]!.id} was stopped by SIGTERM; continue it with orbit resume ${all[0]!.id} --foreground` });
    expect(issues(l).issue(1)!.labels).toEqual(READY);
    expect(issues(l).writes).toEqual([]);
  }, 300_000);
});

describe('orbit queue without a run', () => {
  it('lists the frontier of a parent issue in its order and what holds every other issue, as for orbit#165', async () => {
    const l = lab();
    // The parent's table: 4 blocks 5 and 6; 6 is also blocked by 5; 7 and 8 block each other; 9 is for a person.
    issues(l).put({ number: 100, title: 'Tracking', body: 'the table', labels: ['spec'], subIssues: [3, 4, 5, 6, 7, 8, 9, 10] });
    put(l, 3, 'sub', { open: false });
    put(l, 4, 'div', { blockedBy: [3] });
    put(l, 5, 'pow', { blockedBy: [4] });
    put(l, 6, 'mod', { blockedBy: [4, 5] });
    put(l, 7, 'max', { blockedBy: [8] });
    put(l, 8, 'sub', { blockedBy: [7] });
    put(l, 9, 'div', { labels: [...READY, 'ready-for-human'] });
    put(l, 10, 'pow', { labels: ['spec'] });
    const r = await cli(l, ['queue', 'list', '--parent', '#100', '--base', 'next', '--policy', l.configPath]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe(
      [
        'frontier (1, in priority order):',
        '  #4 Add div',
        'held:',
        '  #5 Add pow: blocked by #4 (open)',
        '  #6 Add mod: blocked by #4 (open), #5 (itself blocked)',
        '  #7 Add max: in a dependency cycle (#7, #8 block one another); none of them runs until a person breaks it',
        '  #8 Add sub: in a dependency cycle (#7, #8 block one another); none of them runs until a person breaks it',
        'cycle: #7, #8 block one another; none of them runs',
        'not taken:',
        '  #9 Add div: labelled ready-for-human: a person decides',
        '  #10 Add pow: not labelled ready-for-agent',
        '',
      ].join('\n'),
    );
    const j = await cli(l, ['queue', 'list', '--parent', '100', '--base', 'next', '--policy', l.configPath, '--json']);
    expect(JSON.parse(j.out)).toMatchObject({ repo: 'acme/app', base: 'next', parent: 100, label: 'ready-for-agent', frontier: [{ number: 4 }], cycles: [[7, 8]] });
    // A parent in another repository is refused.
    expect((await cli(l, ['queue', 'list', '--parent', 'acme/other#100', '--policy', l.configPath])).err).toContain("is not in this checkout's repository (acme/app)");
    expect(argvCalls(l)).toEqual([]);
  });

  it('a cycle and an issue for a person never run: with nothing else, the queue stops at once and changes nothing', async () => {
    const l = lab();
    put(l, 1, 'sub', { blockedBy: [2] });
    put(l, 2, 'div', { blockedBy: [1] });
    put(l, 3, 'pow', { labels: [...READY, 'ready-for-human'] });
    const r = await cli(l, ['queue', 'run', '--base', 'next', '--policy', l.configPath]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('queue stopped: the frontier is empty');
    expect(r.out).toContain('cycle: #1, #2 block one another; none of them runs');
    expect(r.out).toContain('#3 Add pow: labelled ready-for-human: a person decides');
    expect(existsSync(stateDbPath(l.repo))).toBe(false);
    expect(issues(l).writes).toEqual([]);
    expect(argvCalls(l)).toEqual([]);
    // --json: one object per line, the last one the record.
    const j = await cli(l, ['queue', 'run', '--base', 'next', '--policy', l.configPath, '--json']);
    const lines = j.out.trim().split('\n').map((x) => JSON.parse(x) as { type: string; event: string; stop?: unknown; remaining?: unknown });
    expect(lines.map((x) => x.event)).toEqual(['started', 'stopped']);
    expect(lines[1]).toMatchObject({ type: 'queue', stop: { kind: 'empty' }, issues: [], remaining: { frontier: [], cycles: [[1, 2]] } });
  });

  it('an issue that already has an unfinished run is held with the reason, never started twice (#139)', async () => {
    const l = lab();
    put(l, 1, 'sub');
    const first = await cli(l, ['run', '--issue', '1', '--detach', '--policy', l.configPath, '--json']);
    expect(first.code, first.err).toBe(0);
    const id = (JSON.parse(first.out) as { run_id: string }).run_id;
    const r = await cli(l, ['queue', 'run', '--base', 'next', '--policy', l.configPath]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`#1 Add sub: run ${id} (CREATED) was started from it and is unfinished: continue it with orbit resume ${id}, or cancel it with orbit cancel ${id}`);
    expect(listRuns(l.db(), { limit: -1 })).toHaveLength(1);
  });

  it('refuses a checkout that is not on the base branch, and bad options, before taking an issue', async () => {
    const l = lab();
    put(l, 1, 'sub');
    git(l.repo, 'switch', '-q', 'main');
    const r = await cli(l, ['queue', 'run', '--base', 'next', '--policy', l.configPath]);
    expect(r.code).toBe(4);
    expect(r.err).toContain('the queue runs every issue from next, but this checkout is on branch main: switch to it with "git switch next"');
    expect(existsSync(stateDbPath(l.repo))).toBe(false);
    expect((await cli(l, ['queue', 'run', '--max-issues', '0', '--policy', l.configPath])).code).toBe(2);
    expect((await cli(l, ['queue', 'run', '--attempts', '9', '--policy', l.configPath])).code).toBe(2);
    expect((await cli(l, ['queue', 'run', '--label', 'a,b', '--policy', l.configPath])).code).toBe(2);
    expect((await cli(l, ['queue', 'run', '--base', 'orbit/x', '--policy', l.configPath])).err).toContain('also matches the base branch');
  });
});
