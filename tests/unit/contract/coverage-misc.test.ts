import { afterEach, describe, expect, it, vi } from 'vitest';
import { draftContract, type DraftContractInput } from '../../../src/contract/draft.ts';
import { modesRequestedInGoal, reconcileAuthority } from '../../../src/contract/authority.ts';
import { formatErrors, validateAgainst } from '../../../src/contract/json-schema.ts';
import { contractProblems, policyHashOf } from '../../../src/contract/validate.ts';
import { BASELINE, contract, planner, snapshot } from './fixtures.ts';

function input(overrides: Partial<DraftContractInput> = {}): DraftContractInput {
  return { goal: 'Implement CSV export for the reports page.', plannerOutput: planner(), snapshot: snapshot(), baselineRevision: BASELINE, taskId: 'ORB-001', ...overrides };
}

describe('draftContract with a thin policy', () => {
  it('drops every proposed check when the policy defines no checks section', () => {
    const snap = snapshot();
    const thin = { ...snap, config: { ...snap.config, checks: undefined as never } };
    const { contract: drafted, adjustments } = draftContract(input({ snapshot: thin }));
    expect(drafted.required_check_ids).toEqual([]);
    expect(drafted.acceptance_criteria.every((ac) => ac.check_ids?.length === 0)).toBe(true);
    expect(adjustments.filter((a) => a.kind === 'check-dropped').map((a) => a.subject)).toContain('reports-tests');
  });

  it('refuses to draft a contract when the policy has no scope section, so no path can be inside it', () => {
    const snap = snapshot();
    const thin = { ...snap, config: { ...snap.config, scope: undefined as never } };
    expect(() => draftContract(input({ snapshot: thin }))).toThrow(/no proposed path lies inside the policy scope/);
  });

  it('records a goal that asks for less than the policy grants without turning it into a question', () => {
    const snap = snapshot({ merge: true });
    const { contract: drafted, adjustments } = draftContract(input({ goal: 'Add the export. Do not merge anything yourself.', snapshot: snap }));
    const mismatch = adjustments.filter((a) => a.kind === 'authority-mismatch');
    expect(mismatch.map((a) => a.subject)).toEqual(['actions.merge']);
    expect(mismatch[0]?.reason).toMatch(/the goal forbids merge/);
    expect(drafted.assumptions.some((a) => a.status === 'needs-decision' && a.statement.includes('more authority'))).toBe(false);
  });
});

describe('reconcileAuthority details', () => {
  const config = { mode: 'autonomous' as const, actions: snapshot().config.actions };

  it('reports a repeated request once and a request and its negation separately', () => {
    const out = reconcileAuthority('Merge the change when green. Later, merge it again. Never merge on Fridays.', { ...config, actions: { ...config.actions, merge: false } });
    expect(out.filter((m) => m.subject === 'actions.merge' && m.kind === 'exceeds-policy')).toHaveLength(1);
    expect(out.filter((m) => m.kind === 'stricter-than-policy')).toHaveLength(0);
    const both = reconcileAuthority('Merge the change when green. Never merge on Fridays.', { ...config, actions: { ...config.actions, merge: true } });
    expect(both.map((m) => m.kind)).toEqual(['stricter-than-policy']);
  });

  it('compares a requested mode with the policy mode in both directions and skips negated or repeated mentions', () => {
    expect(reconcileAuthority('Run in supervised mode please.', config).map((m) => m.kind)).toEqual(['stricter-than-policy']);
    expect(reconcileAuthority('Use release mode for this.', config).map((m) => m.kind)).toEqual(['exceeds-policy']);
    expect(reconcileAuthority('Run in autonomous mode.', config)).toEqual([]);
    expect(modesRequestedInGoal('Do not use the release mode here.')).toEqual([]);
    expect(modesRequestedInGoal('Use autonomous-delivery mode, i.e. autonomous-delivery profile.').map((m) => m.mode)).toEqual(['autonomous-delivery']);
  });
});

describe('formatErrors', () => {
  it('falls back to the keyword when an error has no message, and de-duplicates', () => {
    const errors = [
      { keyword: 'custom', instancePath: '/a', schemaPath: '#', params: {} },
      { keyword: 'custom', instancePath: '/a', schemaPath: '#', params: {} },
      { keyword: 'additionalProperties', instancePath: '', schemaPath: '#', params: { additionalProperty: 'x'.repeat(80) } },
      { keyword: 'required', instancePath: '/b', schemaPath: '#', params: { missingProperty: 'name' } },
    ];
    expect(formatErrors(errors as never)).toEqual(['/a: custom', '(root): unexpected property (name not shown)', '/b: missing property "name"']);
  });

  it('shows a short plain property name it was not told about', () => {
    const schema = { type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } };
    const res = validateAgainst(schema, { a: 'x', extra: 1 });
    expect(res).toEqual({ ok: false, errors: ['(root): unexpected property "extra"'] });
    expect(validateAgainst(schema, { a: 'x' })).toEqual({ ok: true, value: { a: 'x' } });
  });
});

describe('json-schema helper under a module loader that exposes no default member', () => {
  afterEach(() => {
    vi.doUnmock('ajv/dist/2020.js');
    vi.doUnmock('ajv-formats');
    vi.resetModules();
  });

  it('still compiles and validates', async () => {
    const realAjv = (await vi.importActual<{ default: { default?: new (o: object) => object } & (new (o: object) => object) }>('ajv/dist/2020.js')).default;
    const AjvClass = realAjv.default ?? realAjv;
    const realFormats = (await vi.importActual<{ default: { default?: (a: object) => void } & ((a: object) => void) }>('ajv-formats')).default;
    const formats = realFormats.default ?? realFormats;
    vi.resetModules();
    // Plain wrappers carry no `default` property of their own.
    vi.doMock('ajv/dist/2020.js', () => ({ default: function Wrapped(options: object) { return new AjvClass(options); } }));
    vi.doMock('ajv-formats', () => ({ default: (a: object) => formats(a) }));
    const mod = await import('../../../src/contract/json-schema.ts');
    const schema = { type: 'object', additionalProperties: false, required: ['n'], properties: { n: { type: 'integer' } } };
    expect(mod.validateAgainst(schema, { n: 1 })).toEqual({ ok: true, value: { n: 1 } });
    expect(mod.validateAgainst(schema, { n: 'x' }).ok).toBe(false);
  });
});

describe('contract validation against a thin policy', () => {
  it('treats missing checks and scope sections as empty', () => {
    const snap = snapshot();
    const thin = { ...snap, config: { ...snap.config, checks: undefined as never, scope: undefined as never } };
    const c = contract(thin, { policy_hash: policyHashOf(thin) });
    const problems = contractProblems(c, thin);
    expect(problems).toEqual(
      expect.arrayContaining(['required check "lint" is not defined by the policy', 'allowed_paths[0] "apps/api/**" is not contained in the policy scope', 'criterion AC-1 cites check "reports-tests", which the policy does not define']),
    );
  });
});
