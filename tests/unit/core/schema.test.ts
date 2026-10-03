import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isOrbitError, type OrbitError } from '../../../src/core/errors.ts';
import { clearSchemaCache, compileSchema, formatSchemaErrors, schemaErrors, validate } from '../../../src/core/schema.ts';

const S = 'https://json-schema.org/draft/2020-12/schema';

const person = {
  $schema: S,
  type: 'object',
  additionalProperties: false,
  required: ['name', 'role'],
  properties: {
    name: { type: 'string', minLength: 1 },
    role: { enum: ['planner', 'reviewer'] },
    version: { const: '1.0' },
    email: { type: 'string', format: 'email' },
    at: { type: 'string', format: 'date-time' },
    nickname: { type: ['string', 'null'] },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 2 },
  },
} as const;

interface Person {
  name: string;
  role: 'planner' | 'reviewer';
}

function thrown(fn: () => unknown): OrbitError {
  try {
    fn();
  } catch (err) {
    if (isOrbitError(err)) return err;
    throw err;
  }
  throw new Error('expected an OrbitError');
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orbit-schema-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('validate', () => {
  it('returns the value, typed, when it matches', () => {
    const v = validate<Person>(person, { name: 'a', role: 'planner', nickname: null, at: '2026-10-03T09:37:05Z' });
    expect(v.role).toBe('planner');
  });

  it('throws SCHEMA_INVALID listing every problem with its path', () => {
    const err = thrown(() => validate(person, { role: 'boss', version: '2', email: 'nope', extra: 1, tags: [1, 'a', 'b'] }, 'planner output'));
    expect(err.code).toBe('SCHEMA_INVALID');
    expect(err.message).toMatch(/^planner output does not match its schema: /);
    const errors = err.details!.errors as string[];
    expect(errors).toEqual(
      expect.arrayContaining([
        "(root): missing required property 'name'",
        "(root): unexpected property 'extra'",
        '/role: must be one of "planner", "reviewer"',
        '/version: must equal "1.0"',
        '/email: must be a valid email',
        '/tags/0: must be string',
        '/tags: must NOT have more than 2 items',
      ]),
    );
    for (const e of errors) expect(err.message).toContain(e);
  });

  it('accepts union types and checks formats', () => {
    expect(schemaErrors(person, { name: 'a', role: 'reviewer', nickname: 'n' })).toEqual([]);
    expect(schemaErrors(person, { name: 'a', role: 'reviewer', nickname: 3 })).toEqual(['/nickname: must be string or null']);
    expect(schemaErrors(person, { name: 'a', role: 'reviewer', at: 'yesterday' })).toEqual(['/at: must be a valid date-time']);
  });

  it('rejects non-objects at the root with a readable message', () => {
    expect(schemaErrors(person, null)).toEqual(['(root): must be object']);
    expect(schemaErrors(person, [])).toEqual(['(root): must be object']);
  });

  it('accepts a compiled validator directly', () => {
    const fn = compileSchema<Person>(person);
    expect(validate(fn, { name: 'x', role: 'planner' }).name).toBe('x');
    expect(() => validate(fn, {})).toThrow(/missing required property 'name'/);
  });

  it('names the schema by $id when no label is given, and caps a long error list', () => {
    const schema = { $schema: S, $id: 'https://acme.test/many.json', type: 'array', items: { type: 'integer' } };
    const err = thrown(() => validate(schema, Array.from({ length: 80 }, () => 'x')));
    expect(err.message.startsWith('https://acme.test/many.json does not match its schema')).toBe(true);
    expect(err.message).toContain('(and 70 more)');
    expect((err.details!.errors as string[]).length).toBe(50);
  });

  it('reports unevaluated properties under unevaluatedProperties', () => {
    const schema = { $schema: S, type: 'object', properties: { a: { type: 'number' } }, unevaluatedProperties: false };
    expect(schemaErrors(schema, { a: 1, b: 2 })).toEqual(["(root): unexpected property 'b'"]);
  });
});

describe('compileSchema', () => {
  it('runs in strict mode: unknown keywords and undefined required properties do not compile', () => {
    const unknownKeyword = thrown(() => compileSchema({ $schema: S, type: 'object', propertes: {} }));
    expect(unknownKeyword.code).toBe('INTERNAL');
    expect(unknownKeyword.message).toMatch(/does not compile/);
    expect(() => compileSchema({ $schema: S, type: 'object', properties: {}, required: ['ghost'] })).toThrow(/does not compile/);
    expect(() => compileSchema({ $schema: S, type: 'array', prefixItems: [{ type: 'string' }] })).toThrow(/does not compile/);
  });

  it('rejects a draft-07 schema, so every schema is 2020-12', () => {
    expect(() => compileSchema({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'object' })).toThrow(/does not compile/);
  });

  it('caches by identity and by content', () => {
    const a = compileSchema(person);
    expect(compileSchema(person)).toBe(a);
    expect(compileSchema(JSON.parse(JSON.stringify(person)) as object)).toBe(a);
    expect(compileSchema({ ...person, required: ['name'] })).not.toBe(a);
  });

  it('compiles two different schemas that share an $id', () => {
    const v1 = compileSchema({ $schema: S, $id: 'https://acme.test/s.json', type: 'string' });
    const v2 = compileSchema({ $schema: S, $id: 'https://acme.test/s.json', type: 'number' });
    expect(v1('x')).toBe(true);
    expect(v2('x')).toBe(false);
    expect(v2(1)).toBe(true);
  });

  it('loads a schema file, caches it, and reloads it when the file changes', () => {
    const path = join(dir, 'thing.schema.json');
    writeFileSync(path, JSON.stringify({ $schema: S, type: 'object', required: ['a'], properties: { a: { type: 'string' } } }));
    const first = compileSchema(path);
    expect(compileSchema(path)).toBe(first);
    expect(validate<{ a: string }>(path, { a: 'x' }).a).toBe('x');
    writeFileSync(path, JSON.stringify({ $schema: S, type: 'object', required: ['b'], properties: { b: { type: 'number' } } }, null, 2));
    expect(schemaErrors(path, { a: 'x' })).toEqual(["(root): missing required property 'b'"]);
  });

  it('reports missing, malformed and non-object schema files', () => {
    expect(thrown(() => compileSchema(join(dir, 'missing.json'))).code).toBe('NOT_FOUND');
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{"type":');
    expect(thrown(() => compileSchema(bad)).message).toMatch(/not valid JSON/);
    const arr = join(dir, 'arr.json');
    writeFileSync(arr, '[]');
    expect(thrown(() => compileSchema(arr)).message).toMatch(/does not contain a JSON object/);
  });

  it('rejects things that are not schemas', () => {
    expect(() => compileSchema([] as unknown as object)).toThrow(/must be an object/);
  });

  it('starts from scratch after clearSchemaCache', () => {
    const before = compileSchema(person);
    clearSchemaCache();
    const after = compileSchema(person);
    expect(after).not.toBe(before);
    expect(after({ name: 'a', role: 'planner' })).toBe(true);
  });

  it('compiles every shipped schema under strict mode', () => {
    const schemasDir = fileURLToPath(new URL('../../../schemas/', import.meta.url));
    const files = readdirSync(schemasDir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(() => compileSchema(join(schemasDir, f)), f).not.toThrow();
  });
});

describe('formatSchemaErrors', () => {
  it('handles empty input and removes duplicates', () => {
    expect(formatSchemaErrors(null)).toEqual([]);
    expect(formatSchemaErrors(undefined)).toEqual([]);
    const e = { instancePath: '/a', schemaPath: '#', keyword: 'type', params: { type: 'string' }, message: 'must be string' };
    expect(formatSchemaErrors([e, e])).toEqual(['/a: must be string']);
  });

  it('falls back to the ajv message for other keywords', () => {
    expect(formatSchemaErrors([{ instancePath: '', schemaPath: '#', keyword: 'minLength', params: { limit: 3 }, message: 'must NOT have fewer than 3 characters' }])).toEqual([
      '(root): must NOT have fewer than 3 characters',
    ]);
  });
});

describe('adversarial review', () => {
  it('refuses an asynchronous schema, whose validator returns a promise that validate() would take as success', () => {
    const asyncSchema = { $schema: S, $async: true, type: 'string' };
    const rejected: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejected.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      expect(thrown(() => compileSchema(asyncSchema)).message).toMatch(/asynchronous/);
      expect(() => validate(asyncSchema, 5)).toThrow(/asynchronous/);
      expect(() => schemaErrors(asyncSchema, 5)).toThrow(/asynchronous/);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    expect(rejected).toEqual([]);
  });

  it('refuses an asynchronous validator handed in already compiled', () => {
    const fake = Object.assign(() => Promise.resolve(true), { $async: true as const, errors: null }) as unknown as Parameters<typeof validate>[0];
    expect(() => validate(fake, 5)).toThrow(/asynchronous/);
    expect(() => schemaErrors(fake as Parameters<typeof schemaErrors>[0], 5)).toThrow(/asynchronous/);
  });
});
