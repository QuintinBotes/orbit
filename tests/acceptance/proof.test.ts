/**
 * Issue #200: a run is done only when each criterion's proof would fail without it. Lab replays of the four pull
 * requests behind it (#191, #192, #193, #196), under `verification.fail_before: required`, the demo's own default. The
 * fake reviewer answers each proof session as the reviewers of those pull requests should have; what each scenario
 * checks is what Orbit does with the answer and with the candidate it runs and reads: the per-criterion probes, the byte
 * check of a quote, the callers found by search, the route to repair, and that nothing is delivered before it is done.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listCandidates, listEvidenceReports } from '../../src/evidence/store.ts';
import { listDecisions } from '../../src/storage/decisions.ts';
import { listWorkers } from '../../src/storage/workers.ts';
import { PROOF_RESULT_KIND, type ProofResult } from '../../src/review/proof.ts';
import type { OrbitConfig } from '../../src/policy/types.ts';
import { drive, git, makeLab, READY, startLabRun, writeScenario, type Lab } from './helpers/lab.ts';
import { APPROVE, GOAL, GOOD_IMPLEMENTATION, implementer, NOT_FOUND_TEXT, planner, review, scenario, SRC_TEXT, TEST_TEXT, type Criterion, type Edit } from './helpers/scenarios.ts';
import { assertRunInvariants, transitions } from './helpers/invariants.ts';

const labs: Lab[] = [];
afterEach(() => labs.splice(0).forEach((l) => l.close()));
const required = (c: OrbitConfig) => {
  c.verification = { ...c.verification, fail_before: 'required' };
};
function lab(opts: Parameters<typeof makeLab>[0] = {}): Lab {
  const l = makeLab({ ...opts, tweak: (c) => (required(c), opts.tweak?.(c)) });
  labs.push(l);
  return l;
}

const finding = (id: string, severity: string, category: string, location: string | null, claim: string, evidence: string) => ({ id, severity, category, location, claim, evidence, suggested_validation: null });
const AUDIT_NO = (claim = 'The body assertion fails for any other not-found text, so the test would fail if the criterion were false.') => review('APPROVE', [finding('AUDIT-1', 'info', 'criterion-audit', 'tests/unit/server.test.ts:28', claim, 'assert.equal(...body, ...)')]);
const AUDIT_YES = (claim: string) => review('REPAIR_REQUIRED', [finding('AUDIT-1', 'high', 'criterion-audit', 'tests/unit/queue.test.ts:7', claim, 'pr!.merged = true;')]);
const met = (id: string, location: string, quote: string, claim = 'these lines implement it as worded') => review('APPROVE', [finding(id, 'info', 'conformance', location, claim, quote)]);
const NO_DOC_FINDING = APPROVE;

/** The demo's not-found branch after the change: line 29 of src/server.ts. */
const NOT_FOUND_LINE = `  return { status: 404, type: 'text/plain; charset=utf-8', body: '${NOT_FOUND_TEXT}' };`;
const GOAL_MUST = `Make the not-found response friendlier: unknown paths MUST answer 404 with the plain text "${NOT_FOUND_TEXT}" Add a unit test for the text.`;

function proofResults(l: Lab, runId: string): ProofResult[] {
  return listDecisions(l.db(), runId, { kind: PROOF_RESULT_KIND }).map((d) => d.data as ProofResult);
}
function finalJson(l: Lab, runId: string): { outcome: string; proof?: ProofResult } {
  return JSON.parse(readFileSync(join(l.runDir(runId), 'final.json'), 'utf8')) as { outcome: string; proof?: ProofResult };
}
function proofWorkers(l: Lab, runId: string, kind: 'criterion' | 'requirement' | 'artifacts') {
  return listWorkers(l.db(), { runId }).filter((w) => w.purpose?.startsWith(`proof-${kind}:`));
}

describe.skipIf(!READY)('acceptance: a run is done only when each criterion\'s proof would fail without it (issue #200)', () => {
  it('User Story 1.3, 2.4 and 3.3: a criterion whose test fails on the base tree, passes on the candidate and gets "no", a MUST quoted and matched, and documents that match are delivered, and the report shows each result', async () => {
    const l = lab();
    writeScenario(l, scenario({ implementer: [GOOD_IMPLEMENTATION()], reviewer: [APPROVE], auditor: [AUDIT_NO()], conformance: [met('MUST-1', 'src/server.ts:29', NOT_FOUND_LINE)], artifacts: [NO_DOC_FINDING] }));
    const run = startLabRun(l, GOAL_MUST);
    const done = await drive(l, run.id);
    const db = l.db();
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');

    // FR-003: the criterion's own test ran alone on both trees.
    const ev = listEvidenceReports(db, run.id).at(-1)!;
    expect(ev.report.acceptance_evidence[0]!.fail_before).toMatchObject({ mode: 'required', outcome: 'failed-before', tests: [{ path: 'tests/unit/server.test.ts', check_id: 'unit', base: 'failed', candidate: 'passed' }] });

    const [proof] = proofResults(l, run.id);
    expect(proof!.open).toEqual([]);
    // US1.3: proven, with both results.
    expect(proof!.criteria[0]).toMatchObject({ criterion_id: 'AC-1', status: 'proven', audit: { answer: 'no' }, fail_before: { outcome: 'failed-before' } });
    // US2.4: the MUST with its file and line range, checked byte for byte, and the callers of the changed function.
    expect(proof!.requirements).toMatchObject([{ id: 'MUST-1', status: 'met', quotes: [{ path: 'src/server.ts', start: 29, end: 29 }] }]);
    expect(proof!.requirements[0]!.callers[0]!.function).toBe('handle (src/server.ts:21)');
    expect(proof!.requirements[0]!.callers[0]!.callers).toContain('src/server.ts:35');
    // US3.3: no artifact finding, and delivery went on.
    expect(proof!.artifact_findings).toEqual([]);
    expect(l.github().state.prs).toHaveLength(1);

    // FR-001: the auditor saw the criterion, its test and the test helper it imports; no implementation and no contract.
    const [auditor] = proofWorkers(l, run.id, 'criterion');
    const prompt = readFileSync(join(auditor!.workerDir, 'prompt.md'), 'utf8');
    expect(prompt).toContain('mapped test tests/unit/server.test.ts');
    expect(prompt).toContain('test helper tests/unit/helpers.ts');
    expect(prompt).not.toContain('createServer((req, res)');
    expect(prompt).not.toContain('## Contract');
    expect(auditor!.cwd).toMatch(/audit-1-AC-1$/);

    // FR-012: the report shows each criterion, MUST and finding.
    expect(finalJson(l, run.id).proof?.tree_hash).toBe(proof!.tree_hash);
    const md = readFileSync(join(l.runDir(run.id), 'final.md'), 'utf8');
    expect(md).toContain('## Proof');
    expect(md).toMatch(/AC-1 \[proven\] \(change; tests: tests\/unit\/server\.test\.ts\): audit: no \(.+\); fail-before: failed-before/);
    expect(md).toContain('MUST-1 [met]');
    expect(md).toContain('quoted: src/server.ts:29-29');
    assertRunInvariants(l, run.id);
  }, 300_000);

  it('User Story 1.1 (the #196 SC-001 replay): a test in which a person does the merge the criterion says never happens fails on the base tree, yet the auditor\'s "yes" leaves SC-001 unproven and sends it to repair; the repaired test is delivered', async () => {
    const l = lab();
    const queue: Edit = {
      op: 'write',
      path: 'src/queue.ts',
      content: ['export interface PullRequest {', '  number: number;', '  merged: boolean;', '}', '', '/** Works the queue: each pull request it opens waits for a person to merge it. */', 'export function workQueue(prs: readonly PullRequest[]): PullRequest[] {', '  return prs.map((pr) => ({ ...pr }));', '}', ''].join('\n'),
    };
    const weak: Edit = {
      op: 'write',
      path: 'tests/unit/queue.test.ts',
      content: ["import assert from 'node:assert/strict';", "import { it } from 'node:test';", "import { workQueue } from '../../src/queue.ts';", '', "it('SC-001: the queue never merges a pull request', () => {", '  const [pr] = workQueue([{ number: 1, merged: false }]);', '  pr!.merged = true; // the person merges it', '  assert.equal(pr!.merged, true);', '});', ''].join('\n'),
    };
    const strong: Edit = { op: 'replace', path: 'tests/unit/queue.test.ts', find: '  pr!.merged = true; // the person merges it\n  assert.equal(pr!.merged, true);', replace: '  assert.equal(pr!.merged, false);' };
    const sc001: Criterion = { key: 'sc-001', statement: 'SC-001: the queue never merges a pull request itself; each one it opens waits for a person.', tests: ['tests/unit/queue.test.ts'], changes: [['src/queue.ts', 'the queue'], ['tests/unit/queue.test.ts', 'the SC-001 test']] };
    const yes = 'The test sets merged itself, as the person would, so it passes whether or not the queue merges.';
    writeScenario(
      l,
      scenario({
        planner: [planner({ criteria: [sc001], files: [['src/queue.ts', 'add', 'the queue'], ['tests/unit/queue.test.ts', 'add', 'SC-001']], allowed: ['src/queue.ts', 'tests/unit/**'] })],
        implementer: [implementer([queue, weak], { tests: [['tests/unit/queue.test.ts', 'SC-001']] }), implementer([strong], { tests: [['tests/unit/queue.test.ts', 'SC-001']] })],
        reviewer: [APPROVE, APPROVE],
        // Tree 1's audit answers "yes", tree 2's "no".
        auditor: [AUDIT_YES(yes), AUDIT_NO('assert.equal(pr.merged, false) fails for a queue that merges.')],
        artifacts: [NO_DOC_FINDING],
      }),
    );
    const run = startLabRun(l, 'Add a queue that opens pull requests and never merges them (SC-001).');
    const done = await drive(l, run.id);
    const db = l.db();
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');

    const [first, second] = listCandidates(db, run.id);
    // Fail-before alone would have accepted it: the test cannot load on the base tree.
    const firstReport = listEvidenceReports(db, run.id).find((e) => e.candidateId === first!.id)!;
    expect(firstReport.report.acceptance_evidence[0]!.fail_before?.outcome).toBe('failed-before');
    const [one, two] = proofResults(l, run.id);
    expect(one!.tree_hash).toBe(first!.treeHash);
    expect(one!.criteria[0]).toMatchObject({ criterion_id: 'AC-1', status: 'unproven', audit: { answer: 'yes', reason: yes } });
    expect(one!.open).toEqual([expect.stringContaining('AC-1 is unproven: the auditor answered yes, the test would still pass if it were false: The test sets merged itself')]);
    // It went to repair from delivery, and nothing was delivered for tree 1.
    const path = transitions(db, run.id);
    expect(path.slice(path.indexOf('DELIVERING'), path.indexOf('DELIVERING') + 2)).toEqual(['DELIVERING', 'REPAIRING']);
    const brief = JSON.parse(readFileSync(join(l.runDir(run.id), 'briefs', 'attempt-2.json'), 'utf8')) as { source: string; brief: { evidence: string[] } };
    expect(brief.source).toBe('proof');
    expect(brief.brief.evidence.join('\n')).toContain('AC-1 (mapped tests: tests/unit/queue.test.ts) is unproven');
    expect(two!.tree_hash).toBe(second!.treeHash);
    expect(two!.criteria[0]!.status).toBe('proven');
    expect(l.github().state.prs).toHaveLength(1);
    expect(treeOf(l.remote, `refs/heads/${done.branch}^{tree}`)).toBe(second!.treeHash);
    assertRunInvariants(l, run.id);
  }, 300_000);

  it('User Story 1.2: a criterion whose mapped test passes on the base tree is unproven, though the other criterion\'s test failed before; the tree is not delivered', async () => {
    const l = lab();
    const statusTest: Edit = { op: 'write', path: 'tests/unit/status.test.ts', content: ["import assert from 'node:assert/strict';", "import { it } from 'node:test';", "import { handle } from '../../src/server.ts';", '', "it('unknown paths answer 404', () => {", "  assert.equal(handle('/nope', new URLSearchParams()).status, 404);", '});', ''].join('\n') };
    const criteria: Criterion[] = [
      { key: 'text', statement: `A request for an unknown path answers the plain text body "${NOT_FOUND_TEXT}".`, tests: ['tests/unit/server.test.ts'] },
      { key: 'status', statement: 'A request for an unknown path answers 404.', tests: ['tests/unit/status.test.ts'] },
    ];
    writeScenario(l, scenario({ planner: [planner({ criteria })], implementer: [implementer([SRC_TEXT, TEST_TEXT, statusTest])] }));
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);
    const db = l.db();

    const first = listCandidates(db, run.id)[0]!;
    const report = listEvidenceReports(db, run.id).find((e) => e.candidateId === first.id)!.report;
    expect(report.acceptance_evidence.map((a) => [a.criterion_id, a.status, a.fail_before?.outcome])).toEqual([
      ['AC-1', 'supported', 'failed-before'],
      ['AC-2', 'unverified', 'passed-before'],
    ]);
    expect(report.acceptance_evidence[1]!.note).toBe('the mapped tests do not show AC-2: tests/unit/status.test.ts passes on the base revision with the new tests, so it does not show the change');
    expect(report.verdict).toBe('INCOMPLETE');
    expect(done.state).not.toBe('SUCCEEDED');
    expect(l.github().state.prs).toHaveLength(0);
    expect(proofResults(l, run.id).filter((p) => p.tree_hash === first.treeHash)).toEqual([]);
    assertRunInvariants(l, run.id);
  }, 300_000);

  it('User Story 1.4 (the #191 replay): every check green and the review approving, the tree is not done until its criterion has an audit verdict; green checks alone never end the run', async () => {
    const l = lab();
    const more: Edit = { op: 'replace', path: 'tests/unit/server.test.ts', find: `    assert.equal(handle('/nope', new URLSearchParams()).body, '${NOT_FOUND_TEXT}');\n`, replace: `    assert.equal(handle('/nope', new URLSearchParams()).body, '${NOT_FOUND_TEXT}');\n    assert.equal(handle('/nope/deeper', new URLSearchParams()).body, '${NOT_FOUND_TEXT}');\n` };
    // The first audit answers without the AUDIT-1 finding: green checks and an APPROVE, but no audit verdict.
    writeScenario(l, scenario({ implementer: [GOOD_IMPLEMENTATION(), implementer([more])], reviewer: [APPROVE, APPROVE], auditor: [APPROVE, AUDIT_NO()], artifacts: [NO_DOC_FINDING] }));
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);
    const db = l.db();
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');

    const [first, second] = listCandidates(db, run.id);
    const firstReport = listEvidenceReports(db, run.id).find((e) => e.candidateId === first!.id)!;
    expect(firstReport.verdict).toBe('PASS');
    const [one, two] = proofResults(l, run.id);
    expect(one).toMatchObject({ tree_hash: first!.treeHash, criteria: [{ status: 'unproven', audit: { answer: null } }] });
    expect(one!.criteria[0]!.reason).toContain('no audit verdict');
    expect(two).toMatchObject({ tree_hash: second!.treeHash, open: [] });
    expect(treeOf(l.remote, `refs/heads/${done.branch}^{tree}`)).toBe(second!.treeHash);
    assertRunInvariants(l, run.id);
  }, 300_000);

  it('User Story 2.1 and 2.2 (the #196 FR-004 replay): a MUST whose code counts something else is unmet with its wording and quote side by side, and a quote not in the candidate as quoted is unmet; both go to repair', async () => {
    const l = lab();
    const counter = ["/** Whether the queue stops: after two consecutive failed issues. */", 'export function queueStops(failedIssues: number): boolean {', '  return failedIssues >= 2;', '}', ''].join('\n');
    const fixed = ["/** Whether the queue stops: after two consecutive failed runs. */", 'export function queueStops(failedRuns: number): boolean {', '  return failedRuns >= 2;', '}', ''].join('\n');
    const test = (arg: string) => ["import assert from 'node:assert/strict';", "import { it } from 'node:test';", "import { queueStops } from '../../src/queue.ts';", '', "it('stops after two', () => {", `  assert.equal(queueStops(${arg}), true);`, '  assert.equal(queueStops(1), false);', '});', ''].join('\n');
    const fr = { key: 'fr-004', statement: 'The queue stops after two consecutive failed runs.', tests: ['tests/unit/queue.test.ts'], changes: [['src/queue.ts', 'stop rule']] as [string, string][] };
    const goal = ['Add the queue stop rule.', '', '- **FR-004**: The queue MUST stop after two consecutive failed runs.', '- **FR-005**: The queue MUST NOT stop after one failed run.'].join('\n');
    writeScenario(
      l,
      scenario({
        planner: [planner({ criteria: [fr], files: [['src/queue.ts', 'add', 'stop rule'], ['tests/unit/queue.test.ts', 'add', 'test']], allowed: ['src/queue.ts', 'tests/unit/**'] })],
        implementer: [implementer([{ op: 'write', path: 'src/queue.ts', content: counter }, { op: 'write', path: 'tests/unit/queue.test.ts', content: test('2') }]), implementer([{ op: 'write', path: 'src/queue.ts', content: fixed }])],
        reviewer: [APPROVE, APPROVE],
        auditor: [AUDIT_NO('queueStops(2) is asserted true and queueStops(1) false.')],
        conformance: [
          // Tree 1. FR-004: unmet, the reviewer says why, quoting the line.
          review('REPAIR_REQUIRED', [finding('FR-004', 'high', 'conformance', 'src/queue.ts:3', 'It counts failed issues where the requirement says failed runs.', '  return failedIssues >= 2;')]),
          // FR-005: "met", but the quote is not the candidate's line (its indentation and name differ).
          met('FR-005', 'src/queue.ts:3', 'return failedRuns >= 2;'),
          // Tree 2: both MUSTs quoted exactly.
          met('FR-004', 'src/queue.ts:2-3', 'export function queueStops(failedRuns: number): boolean {\n  return failedRuns >= 2;'),
          met('FR-005', 'src/queue.ts:3', '  return failedRuns >= 2;'),
        ],
        artifacts: [NO_DOC_FINDING],
      }),
    );
    const run = startLabRun(l, goal);
    const done = await drive(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');

    const [one, two] = proofResults(l, run.id);
    const [fr004, fr005] = one!.requirements;
    // US2.1: unmet, the wording and the quoted line side by side.
    expect(fr004).toMatchObject({ id: 'FR-004', status: 'unmet', wording: 'The queue MUST stop after two consecutive failed runs.', quotes: [{ path: 'src/queue.ts', start: 3, end: 3, text: '  return failedIssues >= 2;' }], reason: 'unmet: It counts failed issues where the requirement says failed runs.' });
    // US2.2: the quote is checked against the candidate tree byte for byte.
    expect(fr005).toMatchObject({ id: 'FR-005', status: 'unmet' });
    expect(fr005!.reason).toContain('does not match the candidate byte for byte');
    const md = readFileSync(join(l.runDir(run.id), 'final.md'), 'utf8');
    expect(md).toContain('FR-004 [met]');
    expect(two!.requirements.map((r) => [r.id, r.status])).toEqual([
      ['FR-004', 'met'],
      ['FR-005', 'met'],
    ]);
    expect(transitions(l.db(), run.id)).toContain('REPAIRING');
    assertRunInvariants(l, run.id);
  }, 300_000);

  it('User Story 2.3 (the #192 replay): a change to a routing function the planner and the inquisitor also call lists both callers, and the change to their routes is a finding no requirement asks for', async () => {
    const routing = ['export type Role = "planner" | "inquisitor" | "implementer";', '', '/** The model tier a role is routed to. */', 'export function routeFor(role: Role): string {', '  return role === "implementer" ? "large" : "small";', '}', ''].join('\n');
    const l = lab({
      files: {
        'src/routing.ts': routing,
        'src/planner.ts': ['import { routeFor } from "./routing.ts";', '', 'export function planWith(): string {', '  return routeFor("planner");', '}', ''].join('\n'),
        'src/inquisitor.ts': ['import { routeFor } from "./routing.ts";', '', 'export function inquireWith(): string {', '  return routeFor("inquisitor");', '}', ''].join('\n'),
      },
    });
    // The change sends every role to the large tier: the inquisitor, as asked, and the planner too, as nobody asked.
    const changed = routing.replace('return role === "implementer" ? "large" : "small";', 'return "large";');
    const repaired = routing.replace('return role === "implementer" ? "large" : "small";', 'return role === "planner" ? "small" : "large";');
    const test = ["import assert from 'node:assert/strict';", "import { it } from 'node:test';", "import { routeFor } from '../../src/routing.ts';", '', "it('routes the inquisitor to the large tier', () => {", "  assert.equal(routeFor('inquisitor'), 'large');", "  assert.equal(routeFor('implementer'), 'large');", '});', ''].join('\n');
    const goal = 'Route the inquisitor to the large tier.\n\n- **FR-001**: The router MUST send the inquisitor to the large tier.';
    const caller = finding('CALLER-1', 'high', 'scope', 'src/planner.ts:4', 'The planner is routed by the same function, and the change moves it to the large tier, which no requirement asks for.', 'return routeFor("planner");');
    writeScenario(
      l,
      scenario({
        planner: [planner({ criteria: [{ key: 'route', statement: 'The inquisitor is routed to the large tier.', tests: ['tests/unit/routing.test.ts'], changes: [['src/routing.ts', 'route']] }], files: [['src/routing.ts', 'modify', 'route'], ['tests/unit/routing.test.ts', 'add', 'test']], allowed: ['src/routing.ts', 'tests/unit/**'] })],
        implementer: [implementer([{ op: 'write', path: 'src/routing.ts', content: changed }, { op: 'write', path: 'tests/unit/routing.test.ts', content: test }]), implementer([{ op: 'write', path: 'src/routing.ts', content: repaired }])],
        reviewer: [APPROVE, APPROVE],
        auditor: [AUDIT_NO('routeFor("inquisitor") must be large.')],
        conformance: [
          review('REPAIR_REQUIRED', [finding('FR-001', 'info', 'conformance', 'src/routing.ts:5', 'every role, the inquisitor included, gets large', '  return "large";'), caller]),
          met('FR-001', 'src/routing.ts:5', '  return role === "planner" ? "small" : "large";'),
        ],
        artifacts: [NO_DOC_FINDING],
      }),
    );
    const run = startLabRun(l, goal);
    const done = await drive(l, run.id);

    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const [first, second] = listCandidates(l.db(), run.id);
    const [one, two] = proofResults(l, run.id);
    expect(one!.tree_hash).toBe(first!.treeHash);
    const fr = one!.requirements[0]!;
    expect(fr).toMatchObject({ id: 'FR-001', status: 'met' });
    // FR-008: the callers of the changed function holding the quoted line, by search in the candidate tree.
    expect(fr.callers).toHaveLength(1);
    expect(fr.callers[0]!.function).toBe('routeFor (src/routing.ts:4)');
    expect(fr.callers[0]!.callers).toEqual(expect.arrayContaining(['src/planner.ts:4', 'src/inquisitor.ts:4']));
    expect(one!.caller_findings).toMatchObject([{ id: 'CALLER-1', location: 'src/planner.ts:4' }]);
    expect(one!.open).toEqual([expect.stringContaining('CALLER-1 at src/planner.ts:4')]);
    // Delivery waited: the tree went to repair, and only the repaired tree, which keeps the planner's route, was delivered.
    const path = transitions(l.db(), run.id);
    expect(path[path.indexOf('DELIVERING') + 1]).toBe('REPAIRING');
    expect(two).toMatchObject({ tree_hash: second!.treeHash, caller_findings: [], open: [] });
    expect(treeOf(l.remote, `refs/heads/${done.branch}^{tree}`)).toBe(second!.treeHash);
    assertRunInvariants(l, run.id);
  }, 300_000);

  it('User Story 3.1 and 3.2 (the #193 replay): sentences of the pull request body and an ADR that describe behaviour the code no longer has are findings with file, sentence and reason; delivery waits, and the repaired documents are checked again and delivered', async () => {
    const l = lab({ tweak: (c) => void c.scope.allowed_paths.push('docs/**') });
    const adr = ['# 0001. Not-found text', '', 'Unknown paths answer 200 with a page that links to /reports.', ''].join('\n');
    const adrFixed = ['# 0001. Not-found text', '', `Unknown paths answer 404 with the plain text "${NOT_FOUND_TEXT}".`, ''].join('\n');
    const doc1 = finding('DOC-1', 'high', 'documentation', 'docs/decisions/0001-not-found.md:3', 'The candidate answers 404 with plain text, not 200 with a page.', 'Unknown paths answer 200 with a page that links to /reports.');
    const doc2 = finding('DOC-2', 'high', 'documentation', 'PULL-REQUEST', 'The ADR the body points to describes a 200 page the candidate does not serve.', 'See docs/decisions/0001-not-found.md for the not-found page.');
    writeScenario(
      l,
      scenario({
        planner: [planner({ files: [['src/server.ts', 'modify', 'text'], ['tests/unit/server.test.ts', 'modify', 'test'], ['docs/decisions/0001-not-found.md', 'add', 'ADR']], allowed: ['src/server.ts', 'tests/unit/**', 'docs/**'] })],
        implementer: [implementer([SRC_TEXT, TEST_TEXT, { op: 'write', path: 'docs/decisions/0001-not-found.md', content: adr }]), implementer([{ op: 'write', path: 'docs/decisions/0001-not-found.md', content: adrFixed }])],
        reviewer: [APPROVE, APPROVE],
        auditor: [AUDIT_NO()],
        artifacts: [review('REPAIR_REQUIRED', [doc1, doc2]), NO_DOC_FINDING],
      }),
    );
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');

    const [first, second] = listCandidates(l.db(), run.id);
    const [one, two] = proofResults(l, run.id);
    // US3.1: each sentence a finding with its file, the sentence and the reason; delivery waited for repair.
    expect(one!.tree_hash).toBe(first!.treeHash);
    expect(one!.artifact_findings.map((f) => [f.id, f.location, f.sentence, f.claim])).toEqual([
      ['DOC-1', 'docs/decisions/0001-not-found.md:3', doc1.evidence, doc1.claim],
      ['DOC-2', 'PULL-REQUEST', doc2.evidence, doc2.claim],
    ]);
    const path = transitions(l.db(), run.id);
    expect(path[path.indexOf('DELIVERING') + 1]).toBe('REPAIRING');
    // The artifact check was given the changed ADR and the pull request body Orbit delivers.
    const [check] = proofWorkers(l, run.id, 'artifacts');
    const prompt = readFileSync(join(check!.workerDir, 'prompt.md'), 'utf8');
    expect(prompt).toContain('change to docs/decisions/0001-not-found.md');
    expect(prompt).toContain(`Orbit run ${run.id}:`);
    // US3.2: the repair changed the sentence; the check ran again on the new candidate and the finding closed.
    expect(two).toMatchObject({ tree_hash: second!.treeHash, artifact_findings: [], open: [] });
    expect(proofWorkers(l, run.id, 'artifacts').map((w) => w.candidateId)).toEqual([first!.id, second!.id]);
    expect(l.github().state.prs).toHaveLength(1);
    assertRunInvariants(l, run.id);
  }, 300_000);
});

function treeOf(dir: string, rev: string): string {
  return git(dir, 'rev-parse', rev);
}
