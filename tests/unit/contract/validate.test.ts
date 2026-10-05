import { describe, expect, it } from 'vitest';
import { contractProblems, policyHashOf, validateContract } from '../../../src/contract/validate.ts';
import { isOrbitError, type OrbitError } from '../../../src/core/errors.ts';
import { check, contract, snapshot, uiConfig } from './fixtures.ts';

function problemsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    expect(isOrbitError(err, 'CONTRACT_INVALID')).toBe(true);
    return ((err as OrbitError).details?.problems as string[]) ?? [];
  }
  throw new Error('expected CONTRACT_INVALID');
}

describe('validateContract', () => {
  it('accepts a contract that matches the schema and the policy', () => {
    const snap = snapshot();
    const c = contract(snap);
    expect(validateContract(c, snap)).toEqual(c);
    expect(contractProblems(c, snap)).toEqual([]);
  });

  it('reports schema errors by location without echoing values', () => {
    const snap = snapshot();
    const c = { ...contract(snap), surprise: 'secret-value', task_id: '' } as unknown;
    const problems = problemsOf(() => validateContract(c, snap));
    expect(problems.some((p) => p.includes('unexpected property "surprise"'))).toBe(true);
    expect(problems.some((p) => p.includes('/task_id'))).toBe(true);
    expect(problems.join(' ')).not.toContain('secret-value');
  });

  it('does not echo an unexpected property name that could carry text', () => {
    const snap = snapshot();
    const c = { ...contract(snap), 'token=hunter2 for jane@acme.test': true } as unknown;
    const problems = problemsOf(() => validateContract(c, snap));
    expect(problems).toContain('schema: (root): unexpected property (name not shown)');
    expect(problems.join(' ')).not.toContain('hunter2');
  });

  it('rejects non-objects', () => {
    expect(problemsOf(() => validateContract(null, snapshot())).length).toBeGreaterThan(0);
    expect(problemsOf(() => validateContract('contract', snapshot())).length).toBeGreaterThan(0);
  });

  it('binds the contract to the snapshot hash, with an explicit override', () => {
    const snap = snapshot();
    const other = snapshot({ merge: true });
    expect(problemsOf(() => validateContract(contract(snap), other))).toContain('policy_hash does not match the frozen policy snapshot');
    const recorded = `sha256:${'b'.repeat(64)}`;
    const c = contract(snap, { policy_hash: recorded });
    expect(validateContract(c, snap, { policyHash: recorded })).toEqual(c);
    expect(policyHashOf(snap)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('requires every check id to be defined by the policy and cited checks to be required', () => {
    const snap = snapshot();
    const c = contract(snap, { required_check_ids: ['lint', 'typecheck', 'rm-rf'] });
    c.acceptance_criteria[0]!.check_ids = ['reports-tests', 'ghost'];
    const problems = problemsOf(() => validateContract(c, snap));
    expect(problems).toContain('required check "rm-rf" is not defined by the policy');
    expect(problems).toContain('criterion AC-1 cites check "ghost", which the policy does not define');
    expect(problems).toContain('criterion AC-1 cites check "reports-tests", which is not in required_check_ids');
  });

  it('does not let a contract drop a check the policy marks mandatory', () => {
    const snap = snapshot();
    const c = contract(snap, { required_check_ids: ['typecheck', 'reports-tests'] });
    expect(problemsOf(() => validateContract(c, snap))).toContain('policy check "lint" is mandatory but not in required_check_ids');
  });

  it('needs at least one mandatory criterion, and proof for each mandatory one', () => {
    const snap = snapshot();
    const c = contract(snap);
    for (const ac of c.acceptance_criteria) ac.mandatory = false;
    expect(problemsOf(() => validateContract(c, snap))).toContain('at least one acceptance criterion must be mandatory');

    const d = contract(snap);
    d.acceptance_criteria[1]!.proof = ['   '];
    expect(problemsOf(() => validateContract(d, snap))).toContain('mandatory criterion AC-2 has no proof');

    const e = contract(snap);
    e.acceptance_criteria[2]!.proof = ['  '];
    expect(validateContract(e, snap)).toBe(e);
  });

  it('rejects duplicate criterion and assumption ids and blank statements', () => {
    const snap = snapshot();
    const c = contract(snap);
    c.acceptance_criteria[1]!.id = 'AC-1';
    c.acceptance_criteria[2]!.statement = '  ';
    c.assumptions[1]!.id = 'AS-1';
    const problems = problemsOf(() => validateContract(c, snap));
    expect(problems).toContain('criterion id AC-1 is used more than once');
    expect(problems).toContain('assumption id AS-1 is used more than once');
    expect(problems).toContain('criterion AC-3 has an empty statement');
  });

  describe('baseline_exceptions', () => {
    const exception = (check_id: string, fingerprint = 'fp:0123456789abcdef') => ({ check_id, fingerprint, reason: 'already failing on the base revision' });

    it('is optional, and accepts an exception for a required check', () => {
      const snap = snapshot();
      expect(contractProblems(contract(snap), snap)).toEqual([]);
      const c = contract(snap, { baseline_exceptions: [exception('lint')] });
      expect(contractProblems(c, snap)).toEqual([]);
    });

    it('rejects an exception for a check that is not in required_check_ids', () => {
      const snap = snapshot();
      const c = contract(snap, { baseline_exceptions: [exception('build')] });
      expect(contractProblems(c, snap)).toContain('baseline exception for check "build", which is not in required_check_ids');
    });

    it('rejects two exceptions for the same check', () => {
      const snap = snapshot();
      const c = contract(snap, { baseline_exceptions: [exception('lint'), exception('lint', 'fp:fedcba9876543210')] });
      expect(contractProblems(c, snap)).toContain('check "lint" has more than one baseline exception');
    });

    it('is strict about the shape of each exception', () => {
      const snap = snapshot();
      const extra = contract(snap, { baseline_exceptions: [{ ...exception('lint'), note: 'x' }] as never });
      expect(contractProblems(extra, snap).some((p) => p.startsWith('schema:'))).toBe(true);
      const missing = contract(snap, { baseline_exceptions: [{ check_id: 'lint', reason: 'r' }] as never });
      expect(contractProblems(missing, snap).some((p) => p.startsWith('schema:'))).toBe(true);
    });
  });

  describe('allowed_paths containment', () => {
    it.each([
      ['apps/**', true],
      ['apps/web/**/*.tsx', true],
      ['./tests/reports/**', true],
      ['{apps,docs}/**', true],
      ['**', false],
      ['apps', true],
      ['apps*/**', false],
      ['infra/**', false],
      ['apps/../infra/**', false],
      ['/apps/**', false],
      ['apps/.env', false],
      ['apps/[ab]/**', false],
      ['{apps,infra}/**', false],
      ['apps/x|infra/**', false],
      ['apps/"x"', false],
    ])('%s within the default scope: %s', (glob, ok) => {
      const snap = snapshot();
      const c = contract(snap, { allowed_paths: [glob] });
      if (ok) expect(contractProblems(c, snap)).toEqual([]);
      else expect(contractProblems(c, snap).some((p) => p.startsWith('allowed_paths[0]'))).toBe(true);
    });

    it('accepts a dotfile path when the policy names the dot explicitly', () => {
      const snap = snapshot({ allowedPaths: ['apps/**', 'apps/.env.example'] });
      expect(contractProblems(contract(snap, { allowed_paths: ['apps/.env.example'] }), snap)).toEqual([]);
    });

    it('does not let a brace policy glob vouch for paths picomatch would not match', () => {
      // picomatch reads `{.,apps}/**` as "./..." or "apps/...", never as every path.
      const snap = snapshot({ allowedPaths: ['{.,apps}/**'] });
      const problems = contractProblems(contract(snap, { allowed_paths: ['secrets/**'] }), snap);
      expect(problems).toContain('allowed_paths[0] "secrets/**" is not contained in the policy scope');
    });

    it('names unanalysable syntax separately from out-of-scope paths', () => {
      const snap = snapshot();
      const problems = contractProblems(contract(snap, { allowed_paths: ['apps/[ab]/**', 'infra/**'] }), snap);
      expect(problems).toContain('allowed_paths[0] "apps/[ab]/**" uses glob syntax that cannot be checked against the policy scope');
      expect(problems).toContain('allowed_paths[1] "infra/**" is not contained in the policy scope');
    });
  });

  describe('UI requirements', () => {
    it('requires a ui criterion when the scope can touch UI paths and the policy requires UI evidence', () => {
      const snap = snapshot({ ui: uiConfig() });
      const c = contract(snap, { allowed_paths: ['apps/web/**'] });
      expect(problemsOf(() => validateContract(c, snap))).toContain(
        'allowed_paths can change UI paths and the policy requires UI evidence, but no mandatory criterion is marked ui',
      );
      c.acceptance_criteria[0]!.ui = true;
      expect(validateContract(c, snap)).toBe(c);
    });

    it('does not accept an optional ui criterion as the required UI evidence', () => {
      // An optional criterion needs no evidence to complete, so it would let
      // a UI change ship without the browser evidence the policy requires.
      const snap = snapshot({ ui: uiConfig() });
      const c = contract(snap, { allowed_paths: ['apps/web/**'] });
      c.acceptance_criteria[2]!.ui = true;
      expect(problemsOf(() => validateContract(c, snap))).toContain(
        'allowed_paths can change UI paths and the policy requires UI evidence, but no mandatory criterion is marked ui',
      );
    });

    it('does not require a ui criterion when the scope cannot touch UI paths or the policy does not require it', () => {
      const snap = snapshot({ ui: uiConfig() });
      expect(contractProblems(contract(snap, { allowed_paths: ['apps/api/**'] }), snap)).toEqual([]);
      const relaxed = snapshot({ ui: uiConfig({ required_when_ui_changes: false }) });
      expect(contractProblems(contract(relaxed, { allowed_paths: ['apps/web/**'] }), relaxed)).toEqual([]);
    });

    it('rejects a mandatory ui criterion when there is no ui configuration to prove it', () => {
      const snap = snapshot();
      const c = contract(snap);
      c.acceptance_criteria[0]!.ui = true;
      expect(problemsOf(() => validateContract(c, snap))).toContain('mandatory criterion AC-1 needs browser evidence, but the policy has no ui configuration');
      const d = contract(snap);
      d.acceptance_criteria[2]!.ui = true;
      expect(validateContract(d, snap)).toBe(d);
    });
  });

  describe('delivery', () => {
    it('allows merge only when the policy allows it', () => {
      const snap = snapshot();
      expect(problemsOf(() => validateContract(contract(snap, { delivery: { draft_pr: true, merge: true } }), snap))).toContain(
        'delivery.merge is true but the policy does not allow merge',
      );
      const permissive = snapshot({ merge: true });
      expect(contractProblems(contract(permissive, { delivery: { draft_pr: true, merge: true } }), permissive)).toEqual([]);
    });

    it('allows a draft pull request only when the policy allows opening one', () => {
      const noPr = snapshot({ openPullRequest: false });
      expect(contractProblems(contract(noPr), noPr)).toContain('delivery.draft_pr is true but the policy does not allow opening a pull request');
      const none = snapshot({ pullRequest: 'none' });
      expect(contractProblems(contract(none), none)).toContain('delivery.draft_pr is true but the policy does not allow opening a pull request');
      expect(contractProblems(contract(none, { delivery: { draft_pr: false, merge: false } }), none)).toEqual([]);
    });
  });

  it('collects every problem into one error', () => {
    const snap = snapshot({ checks: { lint: check('lint', { mandatory: true }) } });
    const c = contract(snap, { allowed_paths: ['infra/**'], required_check_ids: ['deploy'], delivery: { draft_pr: true, merge: true } });
    for (const ac of c.acceptance_criteria) delete ac.check_ids;
    let err: unknown;
    try {
      validateContract(c, snap);
    } catch (e) {
      err = e;
    }
    expect(isOrbitError(err, 'CONTRACT_INVALID')).toBe(true);
    const problems = (err as OrbitError).details?.problems as string[];
    expect(problems).toHaveLength(4);
    expect((err as OrbitError).message).toContain('4 problems');
  });
});
