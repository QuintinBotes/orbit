import { describe, expect, it } from 'vitest';
import { authorizationIds, blockingDisposition, classifyAmbiguity, resolveAmbiguities, type Ambiguity, type ResolveInput } from '../../../src/inquisition/resolve.ts';
import { contract as makeContract, snapshot } from '../contract/fixtures.ts';
import { goodQuestion } from './helpers.ts';

const snap = snapshot();
const contract = makeContract(snap);
const AUTH = authorizationIds(snap.config);

function amb(over: Partial<Ambiguity> = {}): Ambiguity {
  return {
    id: 'AMB-1',
    description: 'Column order when the user has not reordered columns',
    kind: 'implementation-detail',
    evidence: ['The report table renders columns in schema order when no order is stored.'],
    reversibility: 'reversible',
    affects: ['AC-2'],
    choice: { option: 'Use the schema order', rationale: 'It matches what the on-screen table does.' },
    ...over,
  };
}

function plan(ambiguities: Ambiguity[], over: Partial<ResolveInput> = {}) {
  return resolveAmbiguities({ ambiguities, contract, mode: 'autonomous', policy: snap.config, authorizations: AUTH, ...over });
}

const productQuestion = amb({
  id: 'AMB-9',
  kind: 'product-semantics',
  description: 'Should the export include every matching record or only the current page?',
  reversibility: 'costly-to-reverse',
  affects: ['AC-1'],
  question: goodQuestion(),
});

describe('scenario 3: reversible ambiguity is resolved unattended with a recorded decision', () => {
  it('chooses the reversible option, records evidence, pins it with a test and a derived proof entry', () => {
    const p = plan([amb()]);
    expect(p.questions).toEqual([]);
    expect(p.decisions).toHaveLength(1);
    expect(p.decisions[0]).toMatchObject({
      kind: 'inquisition.resolve',
      data: { ambiguity_id: 'AMB-1', category: 'implementation-detail', choice: 'Use the schema order', reversibility: 'reversible', affects: ['AC-2'] },
    });
    expect(p.decisions[0]!.data.evidence).toEqual(['The report table renders columns in schema order when no order is stored.']);
    expect(p.experiments).toEqual([expect.objectContaining({ kind: 'pin-test', ambiguityId: 'AMB-1' })]);
    expect(p.amendments).toHaveLength(1);
    expect(p.amendments[0]!.change).toMatchObject({ op: 'add_proof', criterion_id: 'AC-2' });
    expect(p.blockedCriteria).toEqual([]);
    expect(p.disposition).toBe('continue');
  });

  it('follows an established convention when evidence is recorded', () => {
    const p = plan([amb({ kind: 'convention', choice: undefined, convention: { statement: 'Name files kebab-case.', evidence: ['All 40 files under apps/web use kebab-case.'] } })]);
    expect(p.decisions[0]!.data).toMatchObject({ category: 'convention', choice: 'Name files kebab-case.', evidence: ['All 40 files under apps/web use kebab-case.'] });
    expect(p.decisions[0]!.summary).toContain('followed convention');
  });

  it('a "convention" without evidence is not established: it falls back to a named reversible choice, or stays unresolved', () => {
    const withChoice = plan([amb({ kind: 'convention', convention: { statement: 'Use kebab-case.', evidence: [] } })]);
    expect(withChoice.decisions[0]!.data.category).toBe('implementation-detail');
    const bare = plan([amb({ kind: 'convention', convention: { statement: 'Use kebab-case.', evidence: [' '] }, choice: undefined })]);
    expect(bare.decisions).toEqual([]);
    expect(bare.unresolved[0]?.reason).toContain('no recorded evidence');
    expect(bare.blockedCriteria).toEqual(['AC-2']);
  });

  it('a reversible detail with no named choice is unresolved, not guessed', () => {
    const p = plan([amb({ choice: undefined })]);
    expect(p.decisions).toEqual([]);
    expect(p.unresolved).toEqual([{ ambiguityId: 'AMB-1', reason: 'no reversible choice was named' }]);
  });

  it('technical hypotheses become experiments, not decisions, and need an authorized experiment', () => {
    const h = amb({ id: 'AMB-2', kind: 'technical-hypothesis', description: 'Pagination may truncate before filtering', experiment: { description: 'Export a 250 row fixture', expectedObservation: 'Only 100 rows return', authorization: 'reports-tests' } });
    const p = plan([h]);
    expect(p.decisions).toEqual([]);
    expect(p.experiments).toEqual([expect.objectContaining({ kind: 'technical', authorization: 'reports-tests' })]);
    expect(plan([{ ...h, experiment: { ...h.experiment!, authorization: 'rm-rf' } }]).unresolved[0]?.reason).toContain('not a defined check');
    expect(plan([{ ...h, experiment: undefined }]).unresolved[0]?.reason).toContain('needs a discriminating experiment');
  });

  it('a technical hypothesis about security text is still an experiment, because it only observes', () => {
    const p = plan([amb({ kind: 'technical-hypothesis', description: 'The session cookie may be dropped on redirect', experiment: { description: 'Replay the request', expectedObservation: 'cookie missing', authorization: 'reports-tests' } })]);
    expect(p.experiments).toHaveLength(1);
    expect(p.questions).toEqual([]);
  });

  it('policy that forbids autonomous choices turns them into non-material questions that block what they touch', () => {
    const cfg = structuredClone(snap.config);
    cfg.ambiguity.resolve_reversible_choices = false;
    const p = plan([amb({ options: [{ label: 'Use the schema order', description: 'Schema order.', consequences: 'Matches the table today.' }, { label: 'Alphabetical', description: 'A to Z.', consequences: 'Differs from the table today.' }] })], { policy: cfg });
    expect(p.decisions).toEqual([]);
    expect(p.questions[0]?.classification.material).toBe(true); // synthesized questions carry no safe default
    expect(p.blockedCriteria).toEqual(['AC-2']);
  });
});

describe('scenario 4: material ambiguity blocks affected work while independent work continues', () => {
  it('turns product semantics into a question that blocks only AC-1', () => {
    const p = plan([productQuestion]);
    expect(p.decisions).toEqual([]);
    expect(p.questions).toHaveLength(1);
    expect(p.questions[0]).toMatchObject({ ambiguityId: 'AMB-9', blocks: ['AC-1'] });
    expect(p.blockedCriteria).toEqual(['AC-1']);
    expect(p.continuingCriteria).toEqual(['AC-2', 'AC-3']);
    expect(p.disposition).toBe('continue-partial');
    expect(p.reason).toContain('AC-2, AC-3 are independent and continue');
  });

  it('never guesses, even when a choice was named', () => {
    const p = plan([{ ...productQuestion, choice: { option: 'All matching records', rationale: 'The criterion says so.' } }]);
    expect(p.decisions).toEqual([]);
    expect(p.questions).toHaveLength(1);
  });

  it('dependent criteria are blocked with the one they build on', () => {
    const p = plan([productQuestion], { dependsOn: { 'AC-2': ['AC-1'] } });
    expect(p.blockedCriteria).toEqual(['AC-1', 'AC-2']);
    expect(p.continuingCriteria).toEqual(['AC-3']);
  });

  it('criteria already proven are not remaining independent work', () => {
    const p = plan([productQuestion], { supportedCriteria: ['AC-2', 'AC-3'] });
    expect(p.continuingCriteria).toEqual([]);
    expect(p.disposition).toBe('block');
  });

  it('unattended with nothing independent left: BLOCKED. Supervised: wait for the person', () => {
    const dep = { dependsOn: { 'AC-2': ['AC-1'], 'AC-3': ['AC-1'] } };
    expect(plan([productQuestion], dep)).toMatchObject({ disposition: 'block', continuingCriteria: [] });
    expect(plan([productQuestion], { ...dep, mode: 'supervised' }).disposition).toBe('ask');
    expect(plan([productQuestion], { mode: 'supervised' }).disposition).toBe('continue-partial');
  });

  it('alreadyBlocked criteria from open questions stay blocked', () => {
    const p = plan([], { alreadyBlocked: ['AC-3'] });
    expect(p.blockedCriteria).toEqual(['AC-3']);
    expect(p.continuingCriteria).toEqual(['AC-1', 'AC-2']);
  });

  it('a material ambiguity that names no criterion could touch any: it blocks them all (fail closed)', () => {
    const p = plan([{ ...productQuestion, affects: [], question: goodQuestion({ affected_work: ['csv export'] }) }]);
    expect(p.rejected[0]?.problems.join()).toContain('acceptance criterion');
    expect(p.blockedCriteria).toEqual(['AC-1', 'AC-2', 'AC-3']);
    expect(p.disposition).toBe('block');
  });

  it('a question too weak to ask is rejected, and its criteria stay blocked anyway', () => {
    const p = plan([{ ...productQuestion, question: goodQuestion({ options: [] }) }]);
    expect(p.questions).toEqual([]);
    expect(p.rejected).toEqual([expect.objectContaining({ ambiguityId: 'AMB-9', blocks: ['AC-1'] })]);
    expect(p.rejected[0]!.problems.join()).toContain('two options');
    expect(p.blockedCriteria).toEqual(['AC-1']);
  });

  it('builds the question from options and a recommendation when none was prepared', () => {
    const p = plan([{ ...productQuestion, question: undefined, options: goodQuestion().options, choice: { option: 'All matching records', rationale: 'The criterion says every matching record.' } }]);
    expect(p.questions).toHaveLength(1);
    expect(p.questions[0]!.question.recommendation).toBe('All matching records');
    expect(p.questions[0]!.question.safe_default.exists).toBe(false);
    const none = plan([{ ...productQuestion, question: undefined }]);
    expect(none.rejected[0]?.problems[0]).toContain('no question could be built');
  });
});

describe('classifyAmbiguity: labels only ever upgrade', () => {
  it.each([
    ['security text under an implementation-detail label', amb({ description: 'How passwords are hashed for stored exports' }), 'security'],
    ['billing text', amb({ description: 'Whether the export is charged per row' }), 'billing'],
    ['irreversible reversibility', amb({ reversibility: 'irreversible' }), 'irreversible'],
    ['costly-to-reverse reversibility', amb({ reversibility: 'costly-to-reverse' }), 'costly-to-reverse'],
    ['destructive wording', amb({ description: 'Old exports could be permanently removed after a week' }), 'irreversible'],
    ['a declared material topic', amb({ description: 'Which security rules apply to shared reports' }), 'security rules'],
    ['an unknown kind', amb({ kind: 'unknown' }), 'unknown'],
    ['a material kind', amb({ kind: 'financial' }), 'financial'],
  ])('%s is material', (_name, a, needle) => {
    const c = classifyAmbiguity(a, contract, snap.config);
    expect(c.material).toBe(true);
    expect(c.reasons.join()).toContain(needle);
  });

  it('is not material for a plain reversible detail', () => {
    expect(classifyAmbiguity(amb(), contract, snap.config)).toMatchObject({ material: false, reasons: [] });
  });

  it('a behaviour change with nothing inspected behind it is material', () => {
    const a = amb({ changesBehavior: true, evidence: [] });
    expect(classifyAmbiguity(a, contract, snap.config).material).toBe(true);
    expect(classifyAmbiguity({ ...a, evidence: ['The table already does this.'] }, contract, snap.config).material).toBe(false);
  });

  it('block_security_or_data_semantics: false cannot loosen the spec rule', () => {
    const cfg = structuredClone(snap.config);
    cfg.ambiguity.block_security_or_data_semantics = false;
    expect(classifyAmbiguity(amb({ kind: 'security' }), contract, cfg).material).toBe(true);
    expect(classifyAmbiguity(amb({ description: 'How passwords are hashed' }), contract, cfg).material).toBe(true);
  });

  it('a material ambiguity is never decided: a security detail labelled implementation-detail becomes a question', () => {
    const p = plan([amb({ description: 'How passwords are hashed for stored exports', options: goodQuestion().options })]);
    expect(p.decisions).toEqual([]);
    expect(p.rejected.length + p.questions.length).toBe(1);
    expect(p.blockedCriteria).toEqual(['AC-2']);
  });
});

describe('blockingDisposition and authorizationIds', () => {
  it('reports nothing blocked as continue', () => {
    expect(blockingDisposition({ blocked: [], contract, mode: 'autonomous' })).toMatchObject({ disposition: 'continue', blockedCriteria: [] });
  });

  it('resolves dependency chains transitively', () => {
    const r = blockingDisposition({ blocked: ['AC-1'], contract, mode: 'autonomous', dependsOn: { 'AC-2': ['AC-1'], 'AC-3': ['AC-2'] } });
    expect(r.blockedCriteria).toEqual(['AC-1', 'AC-2', 'AC-3']);
    expect(r.disposition).toBe('block');
  });

  it('lists check ids and enabled actions only', () => {
    const ids = authorizationIds(snap.config);
    expect(ids).toEqual(expect.arrayContaining(['lint', 'reports-tests', 'test', 'edit']));
    expect(ids).not.toContain('merge');
    expect(ids).not.toContain('deploy_production');
  });
});
