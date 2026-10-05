/**
 * Spec section 17, scenarios 16 and 19 (spec section 12, cross-provider
 * verification): a disagreement between the implementer (Claude) and the
 * independent reviewer (Codex) becomes a testable claim decided by evidence,
 * never by vote; security findings follow the policy's severity and
 * exception rules, and only an exception listed in trusted policy waives one.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listDecisions } from '../../src/storage/decisions.ts';
import { listFindings, listReviews } from '../../src/review/store.ts';
import { drive, makeLab, READY, startLabRun, writeScenario, type Lab } from './helpers/lab.ts';
import { GOAL, GOOD_IMPLEMENTATION, review, scenario } from './helpers/scenarios.ts';
import { assertRunInvariants, eventData, events, transitions } from './helpers/invariants.ts';

const labs: Lab[] = [];
afterEach(() => labs.splice(0).forEach((l) => l.close()));
function lab(opts: Parameters<typeof makeLab>[0] = {}): Lab {
  const l = makeLab(opts);
  labs.push(l);
  return l;
}

const CASE_FINDING = {
  id: 'COR-1',
  severity: 'medium',
  category: 'correctness',
  location: 'src/server.ts:28',
  claim: 'A request for /Reports (different case) answers 404 with the new text although the goal says only unknown paths do.',
  evidence: 'handle() compares pathname with === against "/reports"; nothing normalizes case.',
  suggested_validation: "Add a unit test asserting handle('/Reports') answers 404 with the not-found text, or that it answers 200 if case should not matter.",
};

function securityFinding(severity: string): object {
  return {
    id: 'SEC-1',
    severity,
    category: 'security',
    location: 'src/server.ts:28',
    claim: 'The not-found body echoes no request data, but the plain text response lacks X-Content-Type-Options: nosniff.',
    evidence: 'handle() returns only content-type for the 404 response.',
    suggested_validation: "Assert the 404 response of handle('/nope') carries x-content-type-options: nosniff.",
  };
}

describe.skipIf(!READY)('acceptance: cross-provider review and security policy', () => {
  it('scenario 16: a reviewer claim the implementer\'s evidence does not settle becomes a testable claim for the Inquisition, not a vote', async () => {
    const l = lab();
    writeScenario(l, scenario({ implementer: [GOOD_IMPLEMENTATION()], reviewer: [review('REPAIR_REQUIRED', [CASE_FINDING])] }));
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);

    const db = l.db();
    // Claude (implementer) and Codex (reviewer) are different providers.
    const [rev] = listReviews(db, run.id, { includeInvalidated: true });
    expect(rev).toMatchObject({ provider: 'codex', verdict: 'REPAIR_REQUIRED' });
    // The claim is recorded with its validation, pending evidence: neither accepted nor rejected by anyone's say-so.
    const [finding] = listFindings(db, run.id);
    expect(finding).toMatchObject({ externalId: 'COR-1', severity: 'medium', suggestedValidation: CASE_FINDING.suggested_validation });
    expect(['claim_pending', 'open']).toContain(finding!.status);
    expect((finding!.resolutionJson as { claim: string }).claim).toBe(CASE_FINDING.claim);
    expect(listDecisions(db, run.id).filter((d) => d.kind === 'review.finding.accepted' || d.kind === 'review.finding.rejected')).toEqual([]);
    // It went to the Inquisition in reconcile mode as a reviewer disagreement keyed to this tree.
    const entered = events(db, run.id, 'state.transition').find((e) => e.from_state === 'REVIEWING' && e.to_state === 'INQUISITION');
    expect(entered).toBeDefined();
    const trigger = eventData<{ data: { trigger: { kind: string; mode: string; key: string; evidence: string[] } } }>(entered!).data.trigger;
    expect(trigger).toMatchObject({ kind: 'reviewer_disagreement', mode: 'reconcile' });
    expect(trigger.key).toContain(rev!.treeHash);
    expect(trigger.evidence.join(' ')).toContain('/Reports');
    // An unsettled claim never authorizes delivery.
    expect(done.state).not.toBe('SUCCEEDED');
    expect(l.github().state.prs).toEqual([]);
    expect(done.outcomeReason).toMatch(/review|claim|COR-1|finding/i);
    assertRunInvariants(l, run.id);
  }, 180_000);

  it('scenario 19: a security finding covered by an exception listed in policy is waived with its recorded reason, and the run completes', async () => {
    const l = lab({
      tweak: (c) =>
        void (c.review.security = {
          block_severities: ['critical', 'high', 'medium'],
          exceptions: [{ category: 'security', severities: ['medium'], location: 'src/server.ts', reason: 'acme accepted risk: the demo server sits behind a proxy that sets nosniff', expires: null }],
        }),
    });
    writeScenario(l, scenario({ implementer: [GOOD_IMPLEMENTATION()], reviewer: [review('APPROVE', [securityFinding('medium')])] }));
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);

    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const db = l.db();
    const [finding] = listFindings(db, run.id);
    expect(finding).toMatchObject({ externalId: 'SEC-1', status: 'excepted' });
    expect((finding!.resolutionJson as { exception: { reason: string } }).exception.reason).toMatch(/acme accepted risk/);
    const waived = listDecisions(db, run.id, { kind: 'review.finding.excepted' });
    expect(waived).toHaveLength(1);
    expect(waived[0]!.summary).toMatch(/SEC-1 \(medium\) excepted: security exception 0 listed in policy/);
    expect(readFileSync(join(l.runDir(run.id), 'final.md'), 'utf8')).toMatch(/review\.finding\.excepted/);
    expect(l.github().state.prs).toHaveLength(1);
    assertRunInvariants(l, run.id);
  }, 180_000);

  it('scenario 19: a security finding above what the exception covers blocks completion; an APPROVE verdict does not override the policy', async () => {
    const l = lab({
      tweak: (c) => {
        c.review.security = {
          block_severities: ['critical', 'high', 'medium'],
          exceptions: [{ category: 'security', severities: ['medium'], location: 'src/server.ts', reason: 'acme accepted risk for medium findings only', expires: null }],
        };
        c.scheduler.hard_limits.review_rounds = 1;
      },
    });
    writeScenario(l, scenario({ implementer: [GOOD_IMPLEMENTATION()], reviewer: [review('APPROVE', [securityFinding('high')])] }));
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);

    const db = l.db();
    expect(done.state).not.toBe('SUCCEEDED');
    expect(['BLOCKED', 'EXHAUSTED']).toContain(done.state);
    expect(done.outcomeReason).toMatch(/SEC-1|security|finding|review/i);
    const [finding] = listFindings(db, run.id);
    expect(finding!.status).not.toBe('excepted');
    expect((finding!.resolutionJson as { blocking: boolean }).blocking).toBe(true);
    expect(listDecisions(db, run.id, { kind: 'review.finding.excepted' })).toEqual([]);
    expect(transitions(db, run.id)).not.toContain('DELIVERING');
    expect(l.github().state.prs).toEqual([]);
    assertRunInvariants(l, run.id);
  }, 180_000);

  it('scenario 19: a security warning below the blocking severities is reported as advisory and does not block', async () => {
    const l = lab();
    writeScenario(l, scenario({ implementer: [GOOD_IMPLEMENTATION()], reviewer: [review('APPROVE', [securityFinding('low')])] }));
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);

    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const [finding] = listFindings(l.db(), run.id);
    expect(finding).toMatchObject({ externalId: 'SEC-1', status: 'advisory' });
    expect(finding!.resolution).toMatch(/below the blocking severities/);
    assertRunInvariants(l, run.id);
  }, 180_000);
});
