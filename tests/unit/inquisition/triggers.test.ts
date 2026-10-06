import { afterEach, describe, expect, it } from 'vitest';
import { isOrbitError } from '../../../src/core/errors.ts';
import type { ImplementerOutput } from '../../../src/contract/model-outputs.ts';
import { detectTriggers, groupByMode, loadInquisitionSnapshot, proofAdequacy, type SnapshotExtras } from '../../../src/inquisition/triggers.ts';
import type { TriggerKind } from '../../../src/inquisition/types.ts';
import { RUN, addDecision, addEvidence, addFailure, addReview, setup, type Env } from './helpers.ts';

let env: Env | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

/** A contract with no open decision, so only the condition under test fires. */
function clean(extra?: (c: import('../../../src/contract/types.ts').GoalContract) => import('../../../src/contract/types.ts').GoalContract): Env {
  env = setup({ contract: (c) => (extra ?? ((x) => x))({ ...c, assumptions: [{ id: 'AS-1', statement: 'Exports use the existing report query.', status: 'unverified' }], escalation: { material_topics: [] } }) });
  return env;
}

function kinds(e: Env, extras: SnapshotExtras = {}): TriggerKind[] {
  return detectTriggers(loadInquisitionSnapshot(e.db, RUN, extras)).map((t) => t.kind);
}

function find(e: Env, kind: TriggerKind, extras: SnapshotExtras = {}) {
  return detectTriggers(loadInquisitionSnapshot(e.db, RUN, extras)).filter((t) => t.kind === kind);
}

const GREEN = [
  { id: 'lint', status: 'PASSED' },
  { id: 'typecheck', status: 'PASSED' },
  { id: 'reports-tests', status: 'PASSED' },
];

describe('baseline', () => {
  it('a well-formed contract with no evidence raises nothing', () => {
    expect(kinds(clean())).toEqual([]);
  });

  it('an unknown run is NOT_FOUND', () => {
    const e = clean();
    try {
      loadInquisitionSnapshot(e.db, 'nope');
      throw new Error('expected failure');
    } catch (err) {
      expect(isOrbitError(err, 'NOT_FOUND')).toBe(true);
    }
  });
});

describe('missing measurable outcomes (clarify)', () => {
  it('flags a criterion with no testable proof', () => {
    const e = clean((c) => ({ ...c, acceptance_criteria: [{ ...c.acceptance_criteria[0]!, proof: [] }, ...c.acceptance_criteria.slice(1)] }));
    const [t] = find(e, 'missing_outcomes');
    expect(t?.mode).toBe('clarify');
    expect(t?.subjects).toEqual(['AC-1']);
    expect(t?.evidence[0]).toContain('no testable proof');
  });

  it('flags proof that is only a placeholder', () => {
    const e = clean((c) => ({ ...c, acceptance_criteria: [{ ...c.acceptance_criteria[0]!, proof: ['Looks good', 'manually verified'] }, ...c.acceptance_criteria.slice(1)] }));
    expect(find(e, 'missing_outcomes')[0]?.subjects).toEqual(['AC-1']);
  });

  it('flags vague wording with nothing measurable', () => {
    const e = clean((c) => ({ ...c, acceptance_criteria: [{ id: 'AC-1', statement: 'Make the export nicer and more robust', proof: ['Reviewers agree it feels better overall'], mandatory: true }] }));
    const [t] = find(e, 'missing_outcomes');
    expect(t?.evidence[0]).toMatch(/vague wording/);
  });

  it('does not flag vague words next to a measurable outcome', () => {
    const e = clean((c) => ({ ...c, acceptance_criteria: [{ id: 'AC-1', statement: 'Improve export speed to under 2 seconds for 10000 rows', proof: ['Benchmark test asserts under 2000 ms'], mandatory: true }] }));
    expect(find(e, 'missing_outcomes')).toEqual([]);
  });

  it('flags a contract without any mandatory criterion', () => {
    const e = clean((c) => ({ ...c, acceptance_criteria: c.acceptance_criteria.map((a) => ({ ...a, mandatory: false })) }));
    expect(find(e, 'missing_outcomes')[0]?.evidence[0]).toContain('no mandatory criterion');
  });
});

describe('contradictory sources (reconcile)', () => {
  it('reports sources that disagree about the same subject', () => {
    const e = clean();
    const ts = find(e, 'contradictory_sources', {
      sources: [
        { source: 'docs/export.md', authority: 'doc', claims: [{ subject: 'Export page size', value: '100 rows' }] },
        { source: 'issue 12', authority: 'issue', claims: [{ subject: 'export  page size', value: '500 rows' }] },
      ],
    });
    expect(ts).toHaveLength(1);
    expect(ts[0]?.mode).toBe('reconcile');
    expect(ts[0]?.evidence[0]).toContain('docs/export.md (doc)');
    expect(ts[0]?.evidence[0]).toContain('issue 12 (issue)');
  });

  it('ignores agreement that differs only in formatting', () => {
    const e = clean();
    expect(
      find(e, 'contradictory_sources', {
        sources: [
          { source: 'a', authority: 'doc', claims: [{ subject: 'timezone', value: 'User local time' }] },
          { source: 'b', authority: 'code', claims: [{ subject: 'Timezone', value: 'user  local time.' }] },
        ],
      }),
    ).toEqual([]);
  });
});

describe('green checks without proof (challenge)', () => {
  it('fires when every required check passed but a mandatory criterion is unverified', () => {
    const e = clean();
    addEvidence(e.db, {
      verdict: 'INCOMPLETE',
      checks: GREEN,
      acceptance: [
        { criterion_id: 'AC-1', status: 'supported', artifacts: ['reports-tests.log'] },
        { criterion_id: 'AC-2', status: 'unverified' },
      ],
    });
    const [t] = find(e, 'green_without_proof');
    expect(t?.mode).toBe('challenge');
    expect(t?.subjects).toEqual(['AC-2']);
    expect(t?.evidence[0]).toContain('INCOMPLETE');
  });

  it('treats "supported" with no artifact as unproven', () => {
    const e = clean();
    addEvidence(e.db, { checks: GREEN, acceptance: [{ criterion_id: 'AC-1', status: 'supported', artifacts: ['a.log'] }, { criterion_id: 'AC-2', status: 'supported', artifacts: [] }] });
    expect(find(e, 'green_without_proof')[0]?.subjects).toEqual(['AC-2']);
  });

  it('is silent when a required check failed (that is repair, not challenge)', () => {
    const e = clean();
    addEvidence(e.db, { checks: [GREEN[0]!, { id: 'typecheck', status: 'FAILED' }, GREEN[2]!], acceptance: [] });
    expect(find(e, 'green_without_proof')).toEqual([]);
  });

  it('is silent when a required check never ran, or only passed flaky', () => {
    const e = clean();
    addEvidence(e.db, { checks: [GREEN[0]!, GREEN[1]!], acceptance: [] });
    expect(find(e, 'green_without_proof')).toEqual([]);
    addEvidence(e.db, { checks: [GREEN[0]!, GREEN[1]!, { id: 'reports-tests', status: 'PASSED', flaky: true }], acceptance: [] });
    expect(find(e, 'green_without_proof')).toEqual([]);
  });

  it('is silent when every mandatory criterion is supported by artifacts', () => {
    const e = clean();
    addEvidence(e.db, {
      verdict: 'PASS',
      checks: GREEN,
      acceptance: [
        { criterion_id: 'AC-1', status: 'supported', artifacts: ['a.log'] },
        { criterion_id: 'AC-2', status: 'supported', artifacts: ['b.log'] },
      ],
    });
    expect(find(e, 'green_without_proof')).toEqual([]);
  });

  it('ignores an invalidated report', () => {
    const e = clean();
    addEvidence(e.db, { checks: GREEN, acceptance: [] }, 'ev-old');
    e.db.run("UPDATE evidence_reports SET invalidated_at = 5 WHERE id = 'ev-old'");
    expect(find(e, 'green_without_proof')).toEqual([]);
  });
});

describe('repeated equivalent failures (diagnose)', () => {
  it('fires once the fingerprint has hit the threshold on distinct candidates', () => {
    const e = clean();
    addFailure(e.db, 'fp-a', 'cand-1');
    expect(find(e, 'repeated_failure')).toEqual([]);
    addFailure(e.db, 'fp-a', 'cand-2', 'TypeError: x is undefined');
    const [t] = find(e, 'repeated_failure');
    expect(t?.mode).toBe('diagnose');
    expect(t?.evidence[0]).toContain('fp-a on 2 distinct candidates');
    expect(t?.evidence[1]).toContain('TypeError');
  });

  it('counts a rerun of the same candidate once', () => {
    const e = clean();
    addFailure(e.db, 'fp-a', 'cand-1');
    addFailure(e.db, 'fp-a', 'cand-1');
    expect(find(e, 'repeated_failure')).toEqual([]);
  });

  it('honours the policy threshold and gives a further occurrence a new key', () => {
    const e = clean();
    addFailure(e.db, 'fp-a', 'c1');
    addFailure(e.db, 'fp-a', 'c2');
    expect(find(e, 'repeated_failure', { thresholds: { repeatedFailure: 3 } })).toEqual([]);
    const k2 = find(e, 'repeated_failure')[0]!.key;
    addFailure(e.db, 'fp-a', 'c3');
    expect(find(e, 'repeated_failure')[0]!.key).not.toBe(k2);
  });

  it('keeps different fingerprints apart', () => {
    const e = clean();
    addFailure(e.db, 'fp-a', 'c1');
    addFailure(e.db, 'fp-b', 'c2');
    expect(find(e, 'repeated_failure')).toEqual([]);
  });
});

describe('unexplained architecture changes (risk-review)', () => {
  const expected = ['apps/api/export.ts', 'apps/api/routes.ts'];

  it('fires when too many changed files are outside the expected set', () => {
    const e = clean();
    const changed = [...expected, 'apps/api/db.ts', 'apps/api/queue.ts', 'packages/core/index.ts', 'infra/deploy.yml'];
    const [t] = find(e, 'unexplained_architecture', { expectedChangedFiles: expected, changedFiles: changed });
    expect(t?.mode).toBe('risk-review');
    expect(t?.evidence[0]).toContain('4 changed files');
    expect(t?.evidence.join('\n')).toContain('infra');
  });

  it('tolerates files up to the threshold and does not count new tests', () => {
    const e = clean();
    const within = [...expected, 'apps/api/a.ts', 'apps/api/b.ts', 'apps/api/c.ts'];
    expect(find(e, 'unexplained_architecture', { expectedChangedFiles: expected, changedFiles: within })).toEqual([]);
    const withTests = [...within, 'tests/reports/export.test.ts', 'tests/reports/more.test.ts'];
    expect(find(e, 'unexplained_architecture', { expectedChangedFiles: expected, changedFiles: withTests })).toEqual([]);
    expect(find(e, 'unexplained_architecture', { expectedChangedFiles: expected, changedFiles: within, thresholds: { unexplainedFiles: 2 } })).toHaveLength(1);
  });

  it('cannot judge without an expected set', () => {
    const e = clean();
    expect(find(e, 'unexplained_architecture', { changedFiles: ['a', 'b', 'c', 'd', 'e'] })).toEqual([]);
  });
});

describe('hidden security, privacy, billing, data and compatibility decisions', () => {
  it('flags a security change the contract never mentions, from the diff', () => {
    const e = clean();
    const diff = '--- a/apps/api/export.ts\n+++ b/apps/api/export.ts\n@@\n+  const token = signSessionToken(user);\n+  res.cookie("session", token);\n';
    const ts = find(e, 'hidden_decision', { diff });
    expect(ts).toHaveLength(1);
    expect(ts[0]?.mode).toBe('risk-review');
    expect(ts[0]?.summary).toContain('security');
  });

  it('flags changed paths (billing, data)', () => {
    const e = clean();
    const ts = find(e, 'hidden_decision', { changedFiles: ['apps/api/billing/invoice.ts', 'db/migrations/0004_add_col.sql'] });
    expect(ts.map((t) => t.summary).join(' ')).toMatch(/billing/);
    expect(ts.map((t) => t.summary).join(' ')).toMatch(/data/);
  });

  it('ignores removed and context lines', () => {
    const e = clean();
    expect(find(e, 'hidden_decision', { diff: '-  const password = read();\n   const secret = 1;\n+  const rows = 3;\n' })).toEqual([]);
  });

  it('is quiet when the contract already names the area', () => {
    const e = clean((c) => ({ ...c, acceptance_criteria: [...c.acceptance_criteria, { id: 'AC-4', statement: 'Reject export requests without a valid session cookie', proof: ['Test asserts 401 without a session'], mandatory: true }] }));
    expect(find(e, 'hidden_decision', { diff: '+ const token = signSessionToken(user);' })).toEqual([]);
  });

  it('is quiet when the contract lists the topic as material', () => {
    const e = clean((c) => ({ ...c, escalation: { material_topics: ['security rules'] } }));
    expect(find(e, 'hidden_decision', { diff: '+ verifyPassword(input)' })).toEqual([]);
  });

  it('is quiet once an inquisition decision covers it, and sees camelCase identifiers before that', () => {
    const e = clean();
    expect(find(e, 'hidden_decision', { diff: '+ verifyPassword(input)' })).toHaveLength(1);
    addDecision(e.db, 'inquisition.answer', 'chose bcrypt for password hashing');
    expect(find(e, 'hidden_decision', { diff: '+ verifyPassword(input)' })).toEqual([]);
  });

  it('turns open needs-decision assumptions into a decision-record trigger', () => {
    env = setup();
    const ts = find(env, 'hidden_decision');
    expect(ts[0]?.mode).toBe('decision-record');
    expect(ts[0]?.evidence[0]).toContain('AS-2');
  });
});

describe('scope pressure (risk-review)', () => {
  it('fires on repeated denials of the same target', () => {
    const e = clean();
    addDecision(e.db, 'policy.deny', 'edit denied', { rule: 'scope.protected', path: '.github/workflows/ci.yml' });
    expect(find(e, 'scope_pressure')).toEqual([]);
    addDecision(e.db, 'policy.deny', 'edit denied', { rule: 'scope.protected', path: '.github/workflows/ci.yml' });
    const [t] = find(e, 'scope_pressure');
    expect(t?.mode).toBe('risk-review');
    expect(t?.evidence.join('\n')).toContain('scope.protected .github/workflows/ci.yml x2');
  });

  it('fires on the total number of denials', () => {
    const e = clean();
    for (const p of ['a', 'b', 'c']) addDecision(e.db, 'policy.deny', 'denied', { rule: 'scope.out', path: p });
    expect(find(e, 'scope_pressure')).toHaveLength(1);
  });
});

describe('unsupported confidence (challenge)', () => {
  function claims(over: Partial<ImplementerOutput>): ImplementerOutput {
    return { summary: 'done', changed_paths: [], tests_added: [], checks_run: [], evidence_refs: [], remaining_issues: [], next_action: { kind: 'continue-implementation', detail: '' }, ...over };
  }

  it('flags a passed claim the controller has no record of', () => {
    const e = clean();
    const [t] = find(e, 'unsupported_confidence', { claims: claims({ checks_run: [{ check_id: 'reports-tests', command: null, claimed_result: 'passed', note: '' }] }) });
    expect(t?.mode).toBe('challenge');
    expect(t?.evidence[0]).toContain('no evidence yet');
  });

  it('flags a passed claim the controller recorded as failed', () => {
    const e = clean();
    addEvidence(e.db, { checks: [{ id: 'build', status: 'FAILED' }] });
    expect(find(e, 'unsupported_confidence', { claims: claims({ checks_run: [{ check_id: 'build', command: null, claimed_result: 'passed', note: '' }] }) })[0]?.evidence[0]).toContain('recorded FAILED');
  });

  it('flags evidence refs for a criterion the report does not support', () => {
    const e = clean();
    addEvidence(e.db, { acceptance: [{ criterion_id: 'AC-1', status: 'unverified' }] });
    const [t] = find(e, 'unsupported_confidence', { claims: claims({ evidence_refs: [{ criterion_id: 'AC-1', ref: 'tests/x.test.ts', note: '' }] }) });
    expect(t?.subjects).toEqual(['AC-1']);
  });

  it('does not reject green over an optional criterion no check is mapped to: no stronger test could change its status (Nm11)', () => {
    const e = clean();
    // AC-3 is optional with no check_ids (an amendment can add one like that): the controller records it unverified whatever the tests do.
    addEvidence(e.db, { checks: GREEN, acceptance: [{ criterion_id: 'AC-1', status: 'supported', artifacts: ['a'] }, { criterion_id: 'AC-3', status: 'unverified' }] });
    const s = loadInquisitionSnapshot(e.db, RUN, { claims: claims({ evidence_refs: [{ criterion_id: 'AC-3', ref: 'tests/toast.test.ts:12', note: 'toast shown' }] }) });
    expect(detectTriggers(s).filter((t) => t.kind === 'unsupported_confidence')).toEqual([]);
    expect(proofAdequacy(s).triggers.map((t) => t.kind)).not.toContain('unsupported_confidence');
    // A claim for a criterion a check is mapped to still fires (the test above): a stronger test can make that one supported.
  });

  it('flags a verification request with nothing behind it', () => {
    const e = clean();
    expect(find(e, 'unsupported_confidence', { claims: claims({ next_action: { kind: 'request-verification', detail: 'ready' } }) })).toHaveLength(1);
  });

  it('is quiet when claims match the record', () => {
    const e = clean();
    addEvidence(e.db, { checks: GREEN, acceptance: [{ criterion_id: 'AC-1', status: 'supported', artifacts: ['a'] }] });
    expect(
      find(e, 'unsupported_confidence', {
        claims: claims({ checks_run: [{ check_id: 'lint', command: null, claimed_result: 'passed', note: '' }], evidence_refs: [{ criterion_id: 'AC-1', ref: 'a', note: '' }] }),
      }),
    ).toEqual([]);
  });
});

describe('oracle weakening (challenge)', () => {
  it('fires on weakening signals and on visual baseline changes', () => {
    const e = clean();
    addEvidence(e.db, { weakening: [{ path: 'tests/reports/export.test.ts', signal: 'assertion-removed', detail: '2 expect() calls' }], visual: ['tests/ui/__screenshots__/export.png'] });
    const [t] = find(e, 'oracle_weakening');
    expect(t?.mode).toBe('challenge');
    expect(t?.evidence).toEqual(['tests/reports/export.test.ts: assertion-removed (2 expect() calls)', 'tests/ui/__screenshots__/export.png: visual baseline changed']);
  });

  it('is quiet without signals', () => {
    const e = clean();
    addEvidence(e.db, { checks: GREEN });
    expect(find(e, 'oracle_weakening')).toEqual([]);
  });
});

describe('reviewer disagreement (reconcile)', () => {
  it('fires when providers disagree about the same tree', () => {
    const e = clean();
    addReview(e.db, 'codex', 'APPROVE');
    addReview(e.db, 'claude', 'REPAIR_REQUIRED');
    const [t] = find(e, 'reviewer_disagreement');
    expect(t?.mode).toBe('reconcile');
    expect(t?.evidence.join('|')).toContain('codex: APPROVE');
  });

  it('uses each provider\'s latest verdict for the tree', () => {
    const e = clean();
    addReview(e.db, 'codex', 'REPAIR_REQUIRED', 'tree-1', 1);
    addReview(e.db, 'codex', 'APPROVE', 'tree-1', 2);
    addReview(e.db, 'claude', 'APPROVE', 'tree-1', 2);
    expect(find(e, 'reviewer_disagreement')).toEqual([]);
  });

  it('does not compare reviews of different trees', () => {
    const e = clean();
    addReview(e.db, 'codex', 'APPROVE', 'tree-1');
    addReview(e.db, 'claude', 'REPAIR_REQUIRED', 'tree-2');
    expect(find(e, 'reviewer_disagreement')).toEqual([]);
  });

  it('fires when a review approves a tree the evidence does not pass', () => {
    const e = clean();
    addEvidence(e.db, { verdict: 'FAIL', tree: 'tree-1' });
    addReview(e.db, 'codex', 'APPROVE', 'tree-1');
    expect(find(e, 'reviewer_disagreement')[0]?.evidence[0]).toContain('evidence verdict FAIL');
  });
});

describe('composition', () => {
  it('orders the highest-stakes trigger first and groups by mode', () => {
    const e = clean();
    addEvidence(e.db, { checks: GREEN, weakening: [{ path: 'tests/a.test.ts', signal: 'test-skipped', detail: '' }], acceptance: [] });
    addFailure(e.db, 'fp-a', 'c1');
    addFailure(e.db, 'fp-a', 'c2');
    const ts = detectTriggers(loadInquisitionSnapshot(e.db, RUN));
    expect(ts[0]?.kind).toBe('oracle_weakening');
    const groups = groupByMode(ts);
    expect(groups.map((g) => g.mode)).toEqual(['challenge', 'diagnose']);
    expect(groups[0]?.triggers.map((t) => t.kind)).toEqual(['oracle_weakening', 'green_without_proof']);
  });

  it('trigger keys are stable across detections and distinct across conditions', () => {
    const e = clean();
    addEvidence(e.db, { checks: GREEN, acceptance: [] });
    const a = detectTriggers(loadInquisitionSnapshot(e.db, RUN)).map((t) => t.key);
    const b = detectTriggers(loadInquisitionSnapshot(e.db, RUN)).map((t) => t.key);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
  });

  it('proofAdequacy closes the green gate for weakening, unverified criteria and unsupported claims', () => {
    const e = clean();
    addEvidence(e.db, { verdict: 'PASS', checks: GREEN, acceptance: [{ criterion_id: 'AC-1', status: 'supported', artifacts: ['a'] }, { criterion_id: 'AC-2', status: 'supported', artifacts: ['b'] }] });
    expect(proofAdequacy(loadInquisitionSnapshot(e.db, RUN)).adequate).toBe(true);
    e.db.run('DELETE FROM evidence_reports');
    addEvidence(e.db, { verdict: 'PASS', checks: GREEN, acceptance: [{ criterion_id: 'AC-1', status: 'supported', artifacts: ['a'] }, { criterion_id: 'AC-2', status: 'supported', artifacts: ['b'] }], weakening: [{ path: 't.test.ts', signal: 'assertion-removed', detail: '' }] });
    const r = proofAdequacy(loadInquisitionSnapshot(e.db, RUN));
    expect(r.adequate).toBe(false);
    expect(r.triggers.map((t) => t.kind)).toEqual(['oracle_weakening']);
  });
});
