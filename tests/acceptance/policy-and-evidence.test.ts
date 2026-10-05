/**
 * Spec section 17, scenarios 9 and 10: an unauthorized protected change is
 * rejected (never repaired, reviewed or delivered, and never a policy
 * expansion), and stale evidence cannot authorize delivery, even when it goes
 * stale in the middle of a delivery.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listDecisions } from '../../src/storage/decisions.ts';
import { listWorkers } from '../../src/storage/workers.ts';
import { listCandidates, listEvidenceReports } from '../../src/evidence/store.ts';
import { listReviews } from '../../src/review/store.ts';
import { verifySnapshot } from '../../src/policy/snapshot.ts';
import { stateDbPath } from '../../src/controller/start.ts';
import { drive, git, makeLab, READY, startLabRun, writeScenario, type Lab } from './helpers/lab.ts';
import { GOAL, GOOD_IMPLEMENTATION, implementer, scenario, SRC_TEXT, TEST_TEXT } from './helpers/scenarios.ts';
import { assertRunInvariants, eventData, events, transitions } from './helpers/invariants.ts';

const labs: Lab[] = [];
afterEach(() => labs.splice(0).forEach((l) => l.close()));
function lab(): Lab {
  const l = makeLab();
  labs.push(l);
  return l;
}

describe.skipIf(!READY)('acceptance: policy and evidence', () => {
  it('scenario 9: a candidate that edits protected paths (the policy file and the manifest) is rejected outright, not repaired, reviewed or delivered', async () => {
    const l = lab();
    const widen = { op: 'replace', path: '.orbit/config.yaml', find: 'allowed_paths: ["src/**", "tests/**"]', replace: 'allowed_paths: ["**"]' };
    const manifest = { op: 'replace', path: 'package.json', find: '"lint": "tsc --noEmit"', replace: '"lint": "true"' };
    writeScenario(l, scenario({ implementer: [implementer([SRC_TEXT, TEST_TEXT, widen as never, manifest as never])] }));
    const run = startLabRun(l, GOAL);
    const policyBefore = readFileSync(run.policyPath, 'utf8');
    const done = await drive(l, run.id);

    const db = l.db();
    expect(done.state).toBe('BLOCKED');
    expect(done.outcomeReason).toMatch(/policy violation/);
    expect(done.outcomeReason).toMatch(/\.orbit\/config\.yaml/);
    expect(done.outcomeReason).toMatch(/package\.json/);
    // Rejected, not repaired: no diagnosis, no second attempt, no review, no delivery.
    const path = transitions(db, run.id);
    expect(path.slice(-2)).toEqual(['VERIFYING', 'BLOCKED']);
    expect(listWorkers(db, { runId: run.id, role: 'implementer' })).toHaveLength(1);
    expect(listWorkers(db, { runId: run.id, role: 'verifier' })).toEqual([]);
    expect(listReviews(db, run.id, { includeInvalidated: true })).toEqual([]);
    expect(listCandidates(db, run.id).map((c) => c.status)).toEqual(['INVALIDATED']);
    const deny = listDecisions(db, run.id, { kind: 'policy.deny' });
    expect(deny).toHaveLength(1);
    expect((deny[0]!.data as { scope: { forbidden_paths_changed: string[] } }).scope.forbidden_paths_changed).toEqual(expect.arrayContaining(['.orbit/config.yaml', 'package.json']));
    expect(l.github().state.prs).toEqual([]);
    expect(git(l.remote, 'for-each-ref', 'refs/heads/orbit/')).toBe('');
    // No model-authorized policy expansion: the frozen snapshot is byte-identical and still verifies.
    expect(readFileSync(run.policyPath, 'utf8')).toBe(policyBefore);
    expect(verifySnapshot(done.policyPath, done.policyHash).config.scope.allowed_paths).toEqual(['src/**', 'tests/**']);
    expect(done.policyHash).toBe(run.policyHash);
    // The checkout and the evidence are kept for a person to inspect.
    expect(listEvidenceReports(db, run.id)).toHaveLength(1);
    assertRunInvariants(l, run.id);
  }, 180_000);

  it('scenario 10: evidence that goes stale in the middle of delivery stops the next external action; only re-verified evidence authorizes the PR', async () => {
    const l = lab();
    writeScenario(l, scenario({ implementer: [GOOD_IMPLEMENTATION()] }));
    const run = startLabRun(l, GOAL);
    // The remote invalidates the run's evidence as it receives the first push (once): the pushed tree's
    // evidence is stale before the PR is opened.
    const marker = join(l.base, 'invalidated-by-remote');
    const script = join(l.base, 'invalidate.mjs');
    writeFileSync(
      script,
      [
        "import { DatabaseSync } from 'node:sqlite';",
        "import { existsSync, writeFileSync } from 'node:fs';",
        'const [db, runId, marker] = process.argv.slice(2);',
        'if (!existsSync(marker)) {',
        '  const d = new DatabaseSync(db);',
        "  d.exec('PRAGMA busy_timeout = 10000');",
        "  d.prepare(\"UPDATE evidence_reports SET invalidated_at = ?, invalidated_reason = 'the check configuration changed while delivering' WHERE run_id = ? AND invalidated_at IS NULL\").run(Date.now(), runId);",
        '  d.close();',
        "  writeFileSync(marker, '1');",
        '}',
        '',
      ].join('\n'),
    );
    const hook = join(l.remote, 'hooks', 'post-receive');
    writeFileSync(hook, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} --no-warnings ${JSON.stringify(script)} ${JSON.stringify(stateDbPath(l.repo))} ${run.id} ${JSON.stringify(marker)}\n`);
    chmodSync(hook, 0o755);

    const done = await drive(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const db = l.db();
    // The PR action was refused on the stale binding and the run went back to verification.
    const path = transitions(db, run.id);
    const firstDeliver = path.indexOf('DELIVERING');
    expect(path.slice(firstDeliver, firstDeliver + 2)).toEqual(['DELIVERING', 'VERIFYING']);
    const refused = events(db, run.id, 'state.transition').find((e) => e.from_state === 'DELIVERING' && e.to_state === 'VERIFYING')!;
    expect(eventData<{ reason: string }>(refused).reason).toMatch(/freshness gate.*invalidated/);
    // Two reports for the same tree: the stale one is kept with its reason, the fresh one authorized delivery.
    const reports = listEvidenceReports(db, run.id);
    expect(reports).toHaveLength(2);
    expect(reports[0]!.treeHash).toBe(reports[1]!.treeHash);
    expect(reports[0]!.invalidatedAt).not.toBeNull();
    expect(reports[1]!.invalidatedAt).toBeNull();
    expect(done.outcomeJson && (JSON.parse(done.outcomeJson) as { evidence_id: string }).evidence_id).toBe(reports[1]!.id);
    // One push, one PR, and the PR was opened only after the re-verification.
    const acts = db.all<{ kind: string; updated_at: number }>('SELECT kind, updated_at FROM actions WHERE run_id = ? ORDER BY created_at', run.id);
    expect(acts.filter((a) => a.kind === 'push')).toHaveLength(1);
    const pr = acts.filter((a) => a.kind === 'pr_create');
    expect(pr).toHaveLength(1);
    expect(pr[0]!.updated_at).toBeGreaterThanOrEqual(reports[1]!.createdAt);
    expect(l.github().state.prs).toHaveLength(1);
    assertRunInvariants(l, run.id);
  }, 180_000);
});
