import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MODEL_OUTPUT_SCHEMA_FILES,
  MODEL_OUTPUT_SCHEMAS,
  validateModelOutput,
  type CuratorOutput,
  type DiagnosisOutput,
  type ImplementerOutput,
  type InquisitorOutput,
  type ModelOutputKind,
  type ModelOutputs,
  type PlannerOutput,
  type ReviewOutput,
} from '../../../src/contract/model-outputs.ts';
import type { AmendmentOp } from '../../../src/contract/amendment-types.ts';
import { STRICT_LIMITS, strictSchemaViolations } from '../../../src/contract/strict-schema.ts';
import { schemaValidator, validateAgainst } from '../../../src/contract/json-schema.ts';
import { applyAmendment } from '../../../src/contract/amend.ts';
import { isOrbitError } from '../../../src/core/errors.ts';
import type { RepairBrief } from '../../../src/evidence/types.ts';
import type { Lesson } from '../../../src/knowledge/types.ts';
import lessonSchema from '../../../schemas/lesson.schema.json' with { type: 'json' };
import { contract, snapshot } from '../contract/fixtures.ts';

const KINDS = Object.keys(MODEL_OUTPUT_SCHEMAS) as ModelOutputKind[];
const schemasDir = fileURLToPath(new URL('../../../schemas/', import.meta.url));

function loadFile(kind: ModelOutputKind): Record<string, unknown> {
  return JSON.parse(readFileSync(`${schemasDir}${MODEL_OUTPUT_SCHEMA_FILES[kind]}`, 'utf8')) as Record<string, unknown>;
}

type Node = Record<string, unknown>;

/** Every subschema with its JSON pointer, independent of the checker under test. */
function subschemas(node: unknown, path = '#'): [string, Node][] {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return [];
  const n = node as Node;
  const out: [string, Node][] = [[path, n]];
  if (n.properties && typeof n.properties === 'object') {
    for (const [k, v] of Object.entries(n.properties as Node)) out.push(...subschemas(v, `${path}/properties/${k}`));
  }
  if (n.items) out.push(...subschemas(n.items, `${path}/items`));
  if (Array.isArray(n.anyOf)) n.anyOf.forEach((b, i) => out.push(...subschemas(b, `${path}/anyOf/${i}`)));
  if (n.$defs && typeof n.$defs === 'object') {
    for (const [k, v] of Object.entries(n.$defs as Node)) out.push(...subschemas(v, `${path}/$defs/${k}`));
  }
  return out;
}

const typesOf = (n: Node): string[] => (Array.isArray(n.type) ? (n.type as string[]) : typeof n.type === 'string' ? [n.type] : []);

// ---------------------------------------------------------------------------
// Valid examples, typed against the TypeScript mirrors so drift fails tsc too.

const plannerExample: PlannerOutput = {
  objective: 'Add CSV export for filtered reports.',
  current_behavior: [{ statement: 'Reports paginate server side.', evidence: ['apps/api/reports.ts:40'] }],
  criteria: [
    { key: 'all', statement: 'Export every matching record.', mandatory: true, ui: false, proof: ['multi-page fixture'], check_ids: ['reports-tests'], changes: [{ path: 'apps/api/export.ts', summary: 'stream pages' }] },
  ],
  expected_changed_files: [{ path: 'apps/api/export.ts', change: 'add', reason: 'endpoint' }],
  allowed_paths: ['apps/api/**'],
  required_check_ids: ['lint'],
  non_goals: ['Change filtering'],
  risks: [{ risk: 'Large exports', impact: 'medium', mitigation: 'stream' }],
  assumptions: [{ statement: 'Same query', basis: 'reports.ts', status: 'unverified' }],
  unresolved_decisions: [{ question: 'All pages?', options: ['all', 'current'], recommendation: null, material: true, affected_criteria: ['all'] }],
  material_topics: ['billing'],
};

const implementerExample: ImplementerOutput = {
  summary: 'Added the export endpoint.',
  changed_paths: [{ path: 'apps/api/export.ts', change: 'add', purpose: 'endpoint' }],
  tests_added: [{ path: 'tests/reports/export.test.ts', name: 'exports all pages', kind: 'unit', criterion_ids: ['AC-1'] }],
  checks_run: [
    { check_id: 'reports-tests', command: null, claimed_result: 'passed', note: '' },
    { check_id: null, command: 'npx vitest run tests/reports', claimed_result: 'failed', note: 'one flaky test' },
  ],
  evidence_refs: [{ criterion_id: 'AC-1', ref: 'tests/reports/export.test.ts:12', note: '' }, { criterion_id: null, ref: 'log', note: '' }],
  remaining_issues: [{ description: 'Large result handling', blocking: false, criterion_id: null }],
  next_action: { kind: 'request-verification', detail: 'ready for trusted checks' },
};

const repairBrief: RepairBrief = {
  fingerprint: 'TypeError:export.ts:undefined-row',
  evidence: ['evidence/2/reports-tests.log'],
  hypotheses: [{ statement: 'Rows are read after the cursor closes', supporting: 'stack trace' }],
  experiment: 'Log cursor state before read',
  expected_observation: 'cursor closed',
  scoped_fix: 'Read rows before closing',
  post_fix_checks: ['reports-tests'],
  preserved_constraints: ['No assertion removed'],
};

const diagnosisExample: DiagnosisOutput = {
  repair_brief: { ...repairBrief, hypotheses: [{ ...repairBrief.hypotheses[0]!, refuting: null }] },
  fingerprint_comparison: { current: repairBrief.fingerprint, previous: [], relation: 'first-occurrence', progress: 'unknown', explanation: 'first failure' },
  competing_hypotheses: [
    { id: 'H1', statement: 'Cursor closed', supporting_evidence: ['trace'], refuting_evidence: [], discriminating_experiment: 'log', expected_if_true: 'closed', status: 'leading', previously_tested: false },
    { id: 'H2', statement: 'Fixture empty', supporting_evidence: [], refuting_evidence: ['fixture has rows'], discriminating_experiment: 'count', expected_if_true: '0 rows', status: 'alternative', previously_tested: false },
  ],
  chosen_hypothesis_id: 'H1',
  confidence: 'medium',
};

const reviewExample: ReviewOutput = {
  verdict: 'REPAIR_REQUIRED',
  candidate_revision: 'abc1234',
  findings: [
    { id: 'SEC-1', severity: 'high', category: 'authorization', location: 'src/export.ts:42', claim: 'Export omits tenant scope.', evidence: 'No tenant predicate.', suggested_validation: 'Add a cross-tenant negative test.' },
    { id: 'TEST-2', severity: 'info', category: 'test-adequacy', location: null, claim: 'c', evidence: 'e', suggested_validation: null },
  ],
};

const inquisitorExample: InquisitorOutput = {
  mode: 'clarify',
  trigger: 'Missing outcome for pagination',
  facts: [{ statement: 'Filtering happens before pagination', source: 'apps/api/reports.ts:40' }],
  assumptions: [{ statement: 'Export reuses the query', basis: 'convention' }],
  unknowns: [{ statement: 'All pages or current page', material: true, blocks: ['AC-1'] }],
  ledger: [{ claim: 'Query is reusable', source: 'reports.ts', confidence: 'medium', consequence_if_wrong: 'rewrite', reversibility: 'reversible', validation_experiment: null, status: 'unverified' }],
  interpretations: [
    { id: 'I1', statement: 'All matching records', impact: 'high', reversibility: 'costly-to-reverse', rank: 1, evidence: ['goal text'] },
    { id: 'I2', statement: 'Current page', impact: 'medium', reversibility: 'reversible', rank: 2, evidence: [] },
  ],
  chosen_experiment: { description: 'Read the goal and existing exports', discriminates: ['I1', 'I2'], expected_observations: [{ interpretation_id: 'I1', observation: 'goal says all' }], authorization: 'read', cost: 'low' },
  autonomous_decisions: [{ decision: 'Use the existing CSV helper', category: 'convention', rationale: 'used elsewhere', evidence: ['apps/api/csv.ts'], reversibility: 'reversible' }],
  questions: [
    {
      question: 'Should export include every matching record or only the current page?',
      changes: ['implementation', 'proof'],
      evidence: ['filtering occurs before pagination; no export convention exists'],
      options: [
        { label: 'A', description: 'All matching records', consequences: 'separate querying and large-result handling' },
        { label: 'B', description: 'Current page', consequences: 'simpler but potentially surprising' },
      ],
      recommendation: 'A',
      recommendation_reason: 'matches the goal wording',
      safe_default: { exists: false, option: null, reason: 'product behaviour differs' },
      material: true,
      affected_work: ['AC-1'],
      unblocked_work: ['escaping', 'column serialization', 'filename tests'],
    },
  ],
  amendments: [
    {
      change: { op: 'add_criterion', statement: 'An empty result exports only the header row.', proof: ['empty fixture test'], mandatory: true, ui: false, check_ids: ['reports-tests'] },
      evidence: 'goal asks to cover empty results',
      reason: 'derived test',
    },
    { change: { op: 'add_required_checks', criterion_id: null, check_ids: ['build'] }, evidence: 'e', reason: 'r' },
    { change: { op: 'set_assumption', assumption_id: null, statement: 's', status: 'unverified' }, evidence: 'e', reason: 'r' },
  ],
};

const curatorExample: CuratorOutput = {
  lessons: [
    {
      schema: 'orbit.lesson/1',
      kind: 'repair-recipe',
      statement: 'Read all rows before closing a database cursor.',
      rationale: 'A closed cursor yields undefined rows.',
      applicability: { languages: ['typescript'], frameworks: [], paths: [], check_ids: ['reports-tests'], fingerprints: ['TypeError:export.ts:undefined-row'], roles: ['implementer'], keywords: ['cursor'] },
      verification: 'The regression test passes after the fix.',
      evidence: [{ run_id: 'orb-20261003-120000-abcdef', artifact: 'evidence/2/reports-tests.log', relation: 'supports' }],
      provenance: { source: 'run', uri: null, derived_from: ['orb-20261003-120000-abcdef'], generated_by: 'curator-model', generated_at: '2026-10-03T12:00:00.000Z' },
      confidence: 'low',
      code_free: true,
      supersedes: null,
    },
  ],
  discarded: [{ source: 'observation 3', reason: 'only one run' }],
};

const EXAMPLES: { [K in ModelOutputKind]: ModelOutputs[K] } = {
  planner: plannerExample,
  implementer: implementerExample,
  diagnosis: diagnosisExample,
  review: reviewExample,
  inquisitor: inquisitorExample,
  curator: curatorExample,
};

// ---------------------------------------------------------------------------

describe('model-output schemas obey the strict structured-output rules', () => {
  it('covers exactly the six model roles', () => {
    expect(KINDS.sort()).toEqual(['curator', 'diagnosis', 'implementer', 'inquisitor', 'planner', 'review']);
  });

  describe.each(KINDS)('%s', (kind) => {
    const schema = loadFile(kind);
    const nodes = subschemas(schema);

    it('is the same document the code imports', () => {
      expect(MODEL_OUTPUT_SCHEMAS[kind]).toEqual(schema);
    });

    it('passes the strict-subset checker', () => {
      expect(strictSchemaViolations(schema)).toEqual([]);
    });

    it('has an object root that is not anyOf', () => {
      expect(schema.type).toBe('object');
      expect(schema.anyOf).toBeUndefined();
    });

    it('sets additionalProperties false and requires every property on every object', () => {
      const objects = nodes.filter(([, n]) => typesOf(n).includes('object'));
      expect(objects.length).toBeGreaterThan(0);
      for (const [path, n] of objects) {
        expect(n.additionalProperties, path).toBe(false);
        expect([...((n.required as string[]) ?? [])].sort(), path).toEqual(Object.keys((n.properties as Node) ?? {}).sort());
      }
    });

    it('uses no unsupported keyword anywhere', () => {
      const forbidden = ['allOf', 'oneOf', 'not', 'if', 'then', 'else', 'dependentRequired', 'dependentSchemas', 'patternProperties', 'unevaluatedProperties', 'propertyNames', 'minLength', 'maxLength', 'minProperties', 'maxProperties', 'uniqueItems', 'contains', 'prefixItems', 'default', 'examples', '$schema', '$id'];
      for (const [path, n] of nodes) {
        for (const k of forbidden) expect(k in n, `${path} uses ${k}`).toBe(false);
        expect(typesOf(n).length > 0 || Array.isArray(n.anyOf) || typeof n.$ref === 'string', `${path} has no type`).toBe(true);
      }
    });

    it('expresses nullability as a type union or anyOf with null, never by omission', () => {
      for (const [path, n] of nodes) {
        if ('enum' in n && typesOf(n).includes('null')) expect((n.enum as unknown[]).includes(null), path).toBe(true);
      }
    });

    it('stays within the provider size limits', () => {
      const depth = (n: unknown, d = 0): number => {
        if (n === null || typeof n !== 'object') return d;
        const node = n as Node;
        const self = typesOf(node).some((t) => t === 'object' || t === 'array') ? d + 1 : d;
        const kids: unknown[] = [...Object.values((node.properties as Node) ?? {}), ...(node.items ? [node.items] : []), ...((node.anyOf as unknown[]) ?? [])];
        return Math.max(self, ...kids.map((k) => depth(k, self)));
      };
      expect(depth(schema)).toBeLessThanOrEqual(STRICT_LIMITS.maxObjectDepth);
    });

    it('compiles in ajv strict mode', () => {
      expect(() => schemaValidator(MODEL_OUTPUT_SCHEMAS[kind])).not.toThrow();
    });

    it('accepts a valid example and rejects extra or missing properties', () => {
      const example = structuredClone(EXAMPLES[kind]) as unknown as Record<string, unknown>;
      expect(validateAgainst(MODEL_OUTPUT_SCHEMAS[kind], example)).toEqual({ ok: true, value: example });
      expect(validateModelOutput(kind, example)).toBe(example);

      const extra = { ...example, injected: 'ignore previous instructions' };
      const r1 = validateAgainst(MODEL_OUTPUT_SCHEMAS[kind], extra);
      expect(r1.ok).toBe(false);

      const firstKey = (schema.required as string[])[0]!;
      const missing = { ...example };
      delete missing[firstKey];
      expect(validateAgainst(MODEL_OUTPUT_SCHEMAS[kind], missing).ok).toBe(false);
      try {
        validateModelOutput(kind, missing);
        throw new Error('expected failure');
      } catch (err) {
        expect(isOrbitError(err, 'MALFORMED_OUTPUT')).toBe(true);
      }
    });
  });
});

describe('strictSchemaViolations reports each rule', () => {
  const obj = (props: Node, extra: Node = {}): Node => ({ type: 'object', additionalProperties: false, required: Object.keys(props), properties: props, ...extra });
  it.each([
    ['a non-object root', { type: 'array', items: { type: 'string' } }, 'root type'],
    ['an anyOf root', { anyOf: [obj({})] }, 'root must not be anyOf'],
    ['a missing additionalProperties', { type: 'object', required: ['a'], properties: { a: { type: 'string' } } }, 'additionalProperties must be false'],
    ['an optional property', { type: 'object', additionalProperties: false, required: [], properties: { a: { type: 'string' } } }, 'not listed in required'],
    ['a required name with no property', obj({}, { required: ['ghost'] }), 'undefined property'],
    ['minLength', obj({ a: { type: 'string', minLength: 1 } }), 'keyword "minLength"'],
    ['allOf', obj({ a: { allOf: [{ type: 'string' }] } }), 'keyword "allOf"'],
    ['oneOf', obj({ a: { oneOf: [{ type: 'string' }] } }), 'keyword "oneOf"'],
    ['if/then', obj({ a: { type: 'string', if: {}, then: {} } }), 'keyword "if"'],
    ['$schema', obj({}, { $schema: 'https://json-schema.org/draft/2020-12/schema' }), 'keyword "$schema"'],
    ['an untyped subschema', obj({ a: { description: 'x' } }), 'needs a type'],
    ['an unknown type', obj({ a: { type: 'date' } }), 'unknown type'],
    ['an unsupported format', obj({ a: { type: 'string', format: 'uri' } }), 'format "uri"'],
    ['a pattern on a number', obj({ a: { type: 'number', pattern: 'x' } }), '"pattern" on a non-string'],
    ['an invalid pattern', obj({ a: { type: 'string', pattern: '(' } }), 'not a valid regular expression'],
    ['minItems on a string', obj({ a: { type: 'string', minItems: 1 } }), '"minItems" on a non-array'],
    ['an array without items', obj({ a: { type: 'array' } }), 'single items schema'],
    ['tuple items', obj({ a: { type: 'array', items: [{ type: 'string' }] } }), 'single items schema'],
    ['minItems above maxItems', obj({ a: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 1 } }), 'minItems exceeds maxItems'],
    ['an enum value of the wrong type', obj({ a: { type: 'string', enum: ['x', 1] } }), 'does not match the declared type'],
    ['a nullable enum without null', obj({ a: { type: ['string', 'null'], enum: ['x'] } }), 'must list null'],
    ['a nested object missing additionalProperties', obj({ a: { type: 'object', required: [], properties: {} } }), 'additionalProperties must be false'],
    ['a dangling $ref', obj({ a: { $ref: '#/$defs/missing' } }), 'existing #/$defs'],
    ['a $ref to an inherited name', obj({ a: { $ref: '#/$defs/constructor' } }), 'existing #/$defs'],
    ['$defs below the root', obj({ a: obj({}, { $defs: {} }) }), 'only supported at the root'],
    ['type and anyOf together', obj({ a: { type: 'string', anyOf: [{ type: 'string' }] } }), 'either type or anyOf'],
  ])('flags %s', (_label, schema, fragment) => {
    const v = strictSchemaViolations(schema);
    expect(v.join('\n')).toContain(fragment);
  });

  it('accepts $defs with $ref, anyOf branches and nullable unions', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['a', 'b', 'c'],
      properties: {
        a: { $ref: '#/$defs/thing' },
        b: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        c: { type: ['integer', 'null'], minimum: 0 },
      },
      $defs: { thing: { type: 'object', additionalProperties: false, required: [], properties: {} } },
    };
    expect(strictSchemaViolations(schema)).toEqual([]);
  });

  it('enforces the nesting limit', () => {
    let node: Node = { type: 'string' };
    for (let i = 0; i < 11; i++) node = { type: 'object', additionalProperties: false, required: ['x'], properties: { x: node } };
    expect(strictSchemaViolations(node).join('\n')).toContain('nesting deeper than 10');
  });

  it('enforces the enum budget', () => {
    const values = Array.from({ length: 1001 }, (_, i) => `v${i}`);
    expect(strictSchemaViolations({ type: 'object', additionalProperties: false, required: ['e'], properties: { e: { type: 'string', enum: values } } }).join('\n')).toContain('enum values exceed');
  });
});

describe('role-specific shape', () => {
  it('gives the implementer no way to claim completion', () => {
    const schema = loadFile('implementer');
    for (const [path, n] of subschemas(schema)) {
      for (const key of Object.keys((n.properties as Node) ?? {})) expect(key, path).not.toMatch(/complete|done|success|finish|goal_met/i);
      for (const v of (n.enum as unknown[]) ?? []) expect(String(v), path).not.toMatch(/complete|done|success|finish/i);
    }
  });

  it('mirrors RepairBrief exactly in the diagnosis output', () => {
    const brief = (loadFile('diagnosis').properties as Node).repair_brief as Node;
    expect(Object.keys(brief.properties as Node).sort()).toEqual(Object.keys(repairBrief).sort());
    const hyp = ((brief.properties as Node).hypotheses as Node).items as Node;
    expect(Object.keys(hyp.properties as Node).sort()).toEqual(['refuting', 'statement', 'supporting']);
  });

  it('matches the spec section 12 findings shape', () => {
    const review = loadFile('review');
    expect(((review.properties as Node).verdict as Node).enum).toEqual(['APPROVE', 'REPAIR_REQUIRED', 'BLOCK']);
    const finding = ((review.properties as Node).findings as Node).items as Node;
    expect(Object.keys(finding.properties as Node).sort()).toEqual(['category', 'claim', 'evidence', 'id', 'location', 'severity', 'suggested_validation']);
    expect(((finding.properties as Node).severity as Node).enum).toEqual(['critical', 'high', 'medium', 'low', 'info']);
  });

  it('lists every amendment operation the controller understands, and no other', () => {
    const ops: Record<AmendmentOp, true> = {
      clarify_objective: true,
      clarify_criterion: true,
      add_criterion: true,
      add_proof: true,
      replace_proof: true,
      set_mandatory: true,
      remove_criterion: true,
      add_required_checks: true,
      remove_required_checks: true,
      set_allowed_paths: true,
      add_non_goal: true,
      remove_non_goal: true,
      set_assumption: true,
      add_escalation_topic: true,
      remove_escalation_topic: true,
      set_delivery: true,
    };
    const amendments = ((loadFile('inquisitor').properties as Node).amendments as Node).items as Node;
    const variants = ((amendments.properties as Node).change as Node).anyOf as Node[];
    const schemaOps = variants.map((v) => (((v.properties as Node).op as Node).enum as string[])[0]);
    expect(schemaOps.sort()).toEqual(Object.keys(ops).sort());
  });

  it('builds the spec section 10 question-quality rules into each question', () => {
    const q = ((loadFile('inquisitor').properties as Node).questions as Node).items as Node;
    const p = q.properties as Node;
    expect((p.changes as Node).minItems).toBe(1);
    expect(((p.changes as Node).items as Node).enum).toEqual(['implementation', 'proof', 'authority', 'scope']);
    expect((p.evidence as Node).minItems).toBe(1);
    expect((p.options as Node).minItems).toBe(2);
    expect(Object.keys((((p.options as Node).items as Node).properties as Node))).toContain('consequences');
    expect(p.recommendation).toBeDefined();
    expect(Object.keys((p.safe_default as Node).properties as Node).sort()).toEqual(['exists', 'option', 'reason']);
    expect((p.affected_work as Node).minItems).toBe(1);
    expect(p.unblocked_work).toBeDefined();
  });

  it('feeds a validated inquisitor amendment straight into applyAmendment', () => {
    const out = validateModelOutput('inquisitor', structuredClone(inquisitorExample));
    const snap = snapshot();
    let c = contract(snap);
    for (const a of out.amendments) c = applyAmendment(c, a, { snapshot: snap }).contract;
    expect(c.acceptance_criteria.at(-1)!.statement).toBe('An empty result exports only the header row.');
    expect(c.required_check_ids).toContain('build');
  });

  it('proposes lessons that become valid orbit.lesson/1 records once the controller fills its fields', () => {
    const lessonProps = (lessonSchema as unknown as Node).properties as Node;
    const curated = (((loadFile('curator').properties as Node).lessons as Node).items as Node).properties as Node;
    expect(Object.keys(curated).sort()).toEqual(Object.keys(lessonProps).filter((k) => !['id', 'status', 'scope'].includes(k)).sort());
    const lessonEvidence = Object.keys((((lessonProps.evidence as Node).items as Node).properties as Node));
    const curatedEvidence = Object.keys((((curated.evidence as Node).items as Node).properties as Node));
    expect(curatedEvidence.sort()).toEqual(lessonEvidence.filter((k) => k !== 'sha256').sort());

    const proposed = curatorExample.lessons[0]!;
    const lesson: Lesson = {
      ...proposed,
      id: 'les-0123456789ab',
      status: 'candidate',
      scope: 'repo',
      evidence: proposed.evidence.map((e) => ({ ...e, sha256: 'd'.repeat(64) })),
    };
    expect(validateAgainst(lessonSchema as unknown as object, lesson).ok).toBe(true);
  });
});
