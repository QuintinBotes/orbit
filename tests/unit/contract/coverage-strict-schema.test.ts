import { describe, expect, it } from 'vitest';
import { STRICT_LIMITS, strictSchemaViolations } from '../../../src/contract/strict-schema.ts';

const obj = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required: Object.keys(properties),
  ...extra,
});

const v = (schema: unknown) => strictSchemaViolations(schema);

describe('strictSchemaViolations: shape of the schema itself', () => {
  it('accepts a conforming schema', () => {
    expect(v(obj({ a: { type: 'string' }, b: { type: ['integer', 'null'] }, c: { type: 'array', items: { type: 'number' }, minItems: 0, maxItems: 3 } }))).toEqual([]);
  });

  it.each([null, 'schema', 42, [], undefined])('refuses a root that is not an object: %j', (root) => {
    expect(v(root)).toEqual(['(root): schema must be an object']);
  });

  it('requires an object root that is not anyOf', () => {
    expect(v({ type: 'string' })).toContain('(root): root type must be exactly "object"');
    expect(v({ anyOf: [{ type: 'string' }] })).toEqual(expect.arrayContaining(['(root): root type must be exactly "object"', '(root): root must not be anyOf']));
  });

  it('flags keywords outside the supported subset', () => {
    expect(v(obj({ a: { type: 'string', minLength: 1 } }))).toContain('#/properties/a: keyword "minLength" is not supported in strict structured output');
  });

  it('flags a subschema that is not an object', () => {
    expect(v(obj({ a: 5 }))).toContain('#/properties/a: subschema must be an object');
    expect(v(obj({ a: { anyOf: [5] } }))).toContain('#/properties/a/anyOf/0: subschema must be an object');
  });
});

describe('strictSchemaViolations: references and unions', () => {
  it('resolves $ref to the root $defs and counts definition names', () => {
    const schema = obj({ a: { $ref: '#/$defs/item' }, b: { $ref: '#/$defs/item', description: 'ok' } }, { $defs: { item: { type: 'string' } } });
    expect(v(schema)).toEqual([]);
  });

  it('flags a $ref that is missing, malformed or not a string, and sibling keywords next to it', () => {
    const base = { $defs: { item: { type: 'string' } } };
    expect(v(obj({ a: { $ref: '#/$defs/nope' } }, base))).toContain('#/properties/a: $ref must point to an existing #/$defs entry');
    expect(v(obj({ a: { $ref: '#/definitions/item' } }, base))).toContain('#/properties/a: $ref must point to an existing #/$defs entry');
    expect(v(obj({ a: { $ref: 5 } }, base))).toContain('#/properties/a: $ref must point to an existing #/$defs entry');
    expect(v(obj({ a: { $ref: '#/$defs/item', type: 'string' } }, base))).toContain('#/properties/a: $ref must not have sibling keyword "type"');
  });

  it('flags $defs below the root', () => {
    expect(v(obj({ a: { type: 'string', $defs: {} } }))).toContain('#/properties/a: $defs is only supported at the root');
  });

  it('checks every anyOf branch and the anyOf container', () => {
    expect(v(obj({ a: { anyOf: [{ type: 'string' }, { type: 'null' }] } }))).toEqual([]);
    expect(v(obj({ a: { anyOf: [] } }))).toContain('#/properties/a: anyOf must be a non-empty array');
    expect(v(obj({ a: { anyOf: 'x' } }))).toContain('#/properties/a: anyOf must be a non-empty array');
    expect(v(obj({ a: { type: 'string', anyOf: [{ type: 'string' }] } }))).toContain('#/properties/a: use either type or anyOf, not both');
  });
});

describe('strictSchemaViolations: types', () => {
  it('requires a type, a non-empty known list without duplicates', () => {
    expect(v(obj({ a: {} }))).toContain('#/properties/a: every subschema needs a type, anyOf or $ref');
    expect(v(obj({ a: { type: [] } }))).toContain('#/properties/a: type must not be empty');
    expect(v(obj({ a: { type: 'blob' } }))).toContain('#/properties/a: unknown type "blob"');
    expect(v(obj({ a: { type: 5 } }))).toContain('#/properties/a: unknown type 5');
    expect(v(obj({ a: { type: ['string', 'string'] } }))).toContain('#/properties/a: duplicate type "string"');
  });

  it('flags object keywords on a non-object and requires properties, required and closed objects', () => {
    expect(v(obj({ a: { type: 'string', properties: {}, required: [], additionalProperties: false } }))).toEqual(
      expect.arrayContaining(['#/properties/a: "properties" on a non-object schema', '#/properties/a: "required" on a non-object schema', '#/properties/a: "additionalProperties" on a non-object schema']),
    );
    expect(v({ type: 'object' })).toEqual(expect.arrayContaining(['#: additionalProperties must be false', '#: object schemas must declare properties']));
    expect(v({ type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } })).toContain('#: required must list every property');
  });

  it('checks required against properties both ways and for duplicates', () => {
    const res = v({ type: 'object', additionalProperties: false, properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a', 'a', 'ghost'] });
    expect(res).toEqual(expect.arrayContaining(['#: required has duplicates', '#: property "b" is not listed in required', '#: required names undefined property "ghost"']));
  });

  it('flags nesting deeper than the provider limit', () => {
    let node: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < STRICT_LIMITS.maxObjectDepth + 2; i++) node = obj({ n: node });
    expect(v(node).some((m) => m.includes(`nesting deeper than ${STRICT_LIMITS.maxObjectDepth} levels`))).toBe(true);
  });
});

describe('strictSchemaViolations: arrays, strings and numbers', () => {
  it('requires one items schema and sane counts, and rejects array keywords elsewhere', () => {
    expect(v(obj({ a: { type: 'array' } }))).toContain('#/properties/a: arrays must declare a single items schema');
    expect(v(obj({ a: { type: 'array', items: [{ type: 'string' }] } }))).toContain('#/properties/a: arrays must declare a single items schema');
    const counts = v(obj({ a: { type: 'array', items: { type: 'string' }, minItems: -1, maxItems: 1.5 } }));
    expect(counts).toEqual(expect.arrayContaining(['#/properties/a: minItems must be a non-negative integer', '#/properties/a: maxItems must be a non-negative integer']));
    expect(v(obj({ a: { type: 'array', items: { type: 'string' }, minItems: 'x' } }))).toContain('#/properties/a: minItems must be a non-negative integer');
    expect(v(obj({ a: { type: 'array', items: { type: 'string' }, minItems: 5, maxItems: 2 } }))).toContain('#/properties/a: minItems exceeds maxItems');
    expect(v(obj({ a: { type: 'string', items: { type: 'string' }, minItems: 1, maxItems: 2 } }))).toEqual(
      expect.arrayContaining(['#/properties/a: "items" on a non-array schema', '#/properties/a: "minItems" on a non-array schema', '#/properties/a: "maxItems" on a non-array schema']),
    );
  });

  it('checks pattern and format on strings and rejects them on other types', () => {
    expect(v(obj({ a: { type: 'string', pattern: '^[a-z]+$', format: 'date-time' } }))).toEqual([]);
    expect(v(obj({ a: { type: 'string', pattern: 5 } }))).toContain('#/properties/a: pattern must be a string');
    expect(v(obj({ a: { type: 'string', pattern: '(' } }))).toContain('#/properties/a: pattern is not a valid regular expression');
    expect(v(obj({ a: { type: 'string', format: 'uri' } }))).toContain('#/properties/a: format "uri" is not supported');
    expect(v(obj({ a: { type: 'string', format: 7 } }))).toContain('#/properties/a: format "7" is not supported');
    expect(v(obj({ a: { type: 'integer', pattern: 'x', format: 'date' } }))).toEqual(expect.arrayContaining(['#/properties/a: "pattern" on a non-string schema', '#/properties/a: "format" on a non-string schema']));
  });

  it('requires numeric bounds to be numbers and keeps them off non-numeric types', () => {
    expect(v(obj({ a: { type: 'integer', minimum: 0, maximum: 10, multipleOf: 2 } }))).toEqual([]);
    expect(v(obj({ a: { type: 'number', minimum: '0' } }))).toContain('#/properties/a: minimum must be a number');
    expect(v(obj({ a: { type: 'string', minimum: 0 } }))).toContain('#/properties/a: "minimum" on a non-numeric schema');
  });
});

describe('strictSchemaViolations: enum and const', () => {
  it('requires a non-empty enum whose values fit the type', () => {
    expect(v(obj({ a: { type: 'string', enum: ['x', 'y'] } }))).toEqual([]);
    expect(v(obj({ a: { type: 'string', enum: [] } }))).toContain('#/properties/a: enum must be a non-empty array');
    expect(v(obj({ a: { type: 'string', enum: 'x' } }))).toContain('#/properties/a: enum must be a non-empty array');
    expect(v(obj({ a: { type: 'string', enum: ['x', 1.5, null, [], {}, true] } }))).toEqual(
      expect.arrayContaining([
        '#/properties/a: enum value of type number does not match the declared type',
        '#/properties/a: enum value of type null does not match the declared type',
        '#/properties/a: enum value of type array does not match the declared type',
        '#/properties/a: enum value of type object does not match the declared type',
        '#/properties/a: enum value of type boolean does not match the declared type',
      ]),
    );
  });

  it('accepts an integer where a number is declared, and wants null listed for a nullable enum', () => {
    expect(v(obj({ a: { type: 'number', enum: [1, 2.5] } }))).toEqual([]);
    expect(v(obj({ a: { type: ['string', 'null'], enum: ['x'] } }))).toContain('#/properties/a: nullable enum must list null');
    expect(v(obj({ a: { type: ['string', 'null'], enum: ['x', null] } }))).toEqual([]);
  });

  it('checks const against the declared type', () => {
    expect(v(obj({ a: { type: 'string', const: 'x' }, b: { type: 'null', const: null }, c: { type: 'integer', const: 3 } }))).toEqual([]);
    expect(v(obj({ a: { type: 'string', const: 3 } }))).toContain('#/properties/a: const value does not match the declared type');
    expect(v(obj({ a: { type: 'string', const: [] } }))).toContain('#/properties/a: const value does not match the declared type');
  });
});

describe('strictSchemaViolations: provider limits', () => {
  it('flags too many properties', () => {
    const props: Record<string, unknown> = {};
    for (let i = 0; i < STRICT_LIMITS.maxProperties + 1; i++) props[`p${i}`] = { type: 'string' };
    expect(v(obj(props)).some((m) => m.startsWith(`(root): ${STRICT_LIMITS.maxProperties + 1} object properties exceed`))).toBe(true);
  });

  it('flags too many characters of names and enum values', () => {
    const props: Record<string, unknown> = {};
    for (let i = 0; i < 5; i++) props[`${i}${'n'.repeat(30_000)}`] = { type: 'string' };
    expect(v(obj(props)).some((m) => m.includes('characters of names and enum values exceed'))).toBe(true);
  });

  it('flags too many enum values', () => {
    const values = Array.from({ length: STRICT_LIMITS.maxEnumValues + 1 }, (_, i) => `v${i}`);
    expect(v(obj({ a: { type: 'string', enum: values } })).some((m) => m.includes('enum values exceed'))).toBe(true);
  });
});
