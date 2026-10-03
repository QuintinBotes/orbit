import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020Module, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { OrbitError } from './errors.ts';
import { hashObject } from './hash.ts';

/**
 * JSON Schema (draft 2020-12) validation for contracts, config and every
 * structured model output. A field from a model is used only after the whole
 * document passed its schema.
 *
 * Ajv runs in strict mode so a typo in a schema (an unknown keyword, a
 * `required` property that is never defined) fails at compile time instead of
 * silently validating nothing. Union types (`["string", "null"]`) are allowed
 * because nullable fields are written that way throughout schemas/.
 *
 * Compiled validators are cached by object identity and by canonical content
 * hash, so a schema read twice from disk or rebuilt per call compiles once.
 */

type Ajv2020 = InstanceType<typeof Ajv2020Module>;

// ajv and ajv-formats are CommonJS; depending on the loader the default
// import is either the export itself or a namespace holding it.
const Ajv2020Ctor = ((Ajv2020Module as unknown as { default?: typeof Ajv2020Module }).default ?? Ajv2020Module) as typeof Ajv2020Module;
const addFormats = ((addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ?? addFormatsModule) as typeof addFormatsModule;

/** A schema object, or a path to a JSON file containing one. */
export type SchemaSource = object | string;

export type Validator<T = unknown> = ValidateFunction<T>;

const MAX_REPORTED_ERRORS = 50;

let ajv: Ajv2020 | null = null;
let byObject = new WeakMap<object, Validator>();
const byHash = new Map<string, Validator>();
const byPath = new Map<string, { mtimeMs: number; size: number; fn: Validator }>();
const labels = new WeakMap<Validator, string>();

function instance(): Ajv2020 {
  if (!ajv) {
    ajv = new Ajv2020Ctor({ strict: true, allErrors: true, allowUnionTypes: true });
    addFormats(ajv);
  }
  return ajv;
}

/** Compile (or fetch from cache) the validator for a schema object or schema file. */
export function compileSchema<T = unknown>(source: SchemaSource): Validator<T> {
  if (typeof source === 'string') return compilePath(source) as Validator<T>;
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw new OrbitError('INTERNAL', 'a JSON Schema must be an object or a file path');
  }
  // Identity cache: callers must not mutate a schema object after compiling it.
  const cached = byObject.get(source);
  if (cached) return cached as Validator<T>;
  const fn = compileObject(source, labelOf(source, null));
  byObject.set(source, fn);
  return fn as Validator<T>;
}

/**
 * Validate `value` and return it typed, or throw OrbitError SCHEMA_INVALID
 * whose message lists what is wrong (`/path: problem`) and whose details hold
 * the full list. `label` names the document in the message.
 */
export function validate<T>(schema: SchemaSource | Validator<T>, value: unknown, label?: string): T {
  const fn = (typeof schema === 'function' ? assertSync(schema as Validator<T>) : compileSchema<T>(schema)) as Validator<T>;
  if (fn(value)) return value as T;
  const errors = formatSchemaErrors(fn.errors);
  const name = label ?? labels.get(fn as Validator) ?? 'value';
  const shown = errors.slice(0, 10).join('; ');
  const more = errors.length > 10 ? ` (and ${errors.length - 10} more)` : '';
  throw new OrbitError('SCHEMA_INVALID', `${name} does not match its schema: ${shown}${more}`, {
    schema: labels.get(fn as Validator) ?? null,
    errors: errors.slice(0, MAX_REPORTED_ERRORS),
  });
}

/** Non-throwing form: the readable error list, empty when `value` is valid. */
export function schemaErrors(schema: SchemaSource | Validator, value: unknown): string[] {
  const fn = (typeof schema === 'function' ? assertSync(schema as Validator) : compileSchema(schema)) as Validator;
  return fn(value) ? [] : formatSchemaErrors(fn.errors);
}

/** Ajv errors as one line each: `/acceptance_criteria/0: missing required property 'id'`. */
export function formatSchemaErrors(errors: readonly ErrorObject[] | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of errors ?? []) {
    const line = `${e.instancePath || '(root)'}: ${describe(e)}`;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

/** Drop every compiled validator. For tests that rewrite schema files or need a fresh Ajv. */
export function clearSchemaCache(): void {
  ajv = null;
  byObject = new WeakMap();
  byHash.clear();
  byPath.clear();
}

// ---------------------------------------------------------------------------

function compilePath(path: string): Validator {
  const abs = resolve(path);
  let stat;
  try {
    stat = statSync(abs);
  } catch (err) {
    throw new OrbitError('NOT_FOUND', `schema file not found: ${abs}`, { path: abs }, { cause: err });
  }
  const hit = byPath.get(abs);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.fn;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(abs, 'utf8'));
  } catch (err) {
    throw new OrbitError('INTERNAL', `schema file ${abs} is not valid JSON: ${(err as Error).message}`, { path: abs }, { cause: err });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OrbitError('INTERNAL', `schema file ${abs} does not contain a JSON object`, { path: abs });
  }
  const fn = compileObject(parsed, labelOf(parsed, abs));
  byPath.set(abs, { mtimeMs: stat.mtimeMs, size: stat.size, fn });
  return fn;
}

function compileObject(schema: object, label: string): Validator {
  const key = hashObject(schema);
  const cached = byHash.get(key);
  if (cached) return cached;
  const a = instance();
  const id = (schema as { $id?: unknown }).$id;
  // Ajv refuses a second schema under an $id it already holds. Only a schema
  // with different content can get here, so the old registration goes; its
  // compiled validator stays valid.
  if (typeof id === 'string') a.removeSchema(id);
  let fn: Validator;
  try {
    fn = a.compile(schema);
  } catch (err) {
    throw new OrbitError('INTERNAL', `schema ${label} does not compile: ${(err as Error).message}`, { schema: label }, { cause: err });
  }
  assertSync(fn, label);
  labels.set(fn, label);
  byHash.set(key, fn);
  return fn;
}

/**
 * An $async validator returns a promise, which is truthy: validate() would
 * pass every value and the rejection would surface later, unhandled.
 */
function assertSync<V extends Validator>(fn: V, label?: string): V {
  if ((fn as { $async?: unknown }).$async === true) {
    const name = label ?? labels.get(fn) ?? 'validator';
    throw new OrbitError('INTERNAL', `schema ${name} is asynchronous ($async); Orbit validates synchronously`, { schema: name });
  }
  return fn;
}

function labelOf(schema: object, path: string | null): string {
  const s = schema as { $id?: unknown; title?: unknown };
  if (typeof s.$id === 'string') return s.$id;
  if (path) return path;
  if (typeof s.title === 'string') return s.title;
  return 'schema';
}

function describe(e: ErrorObject): string {
  const p = e.params as Record<string, unknown>;
  switch (e.keyword) {
    case 'required':
      return `missing required property '${String(p.missingProperty)}'`;
    case 'additionalProperties':
      return `unexpected property '${String(p.additionalProperty)}'`;
    case 'unevaluatedProperties':
      return `unexpected property '${String(p.unevaluatedProperty)}'`;
    case 'enum':
      return `must be one of ${(p.allowedValues as unknown[] | undefined)?.map((v) => JSON.stringify(v)).join(', ') ?? 'the allowed values'}`;
    case 'const':
      return `must equal ${JSON.stringify(p.allowedValue)}`;
    case 'type':
      return `must be ${Array.isArray(p.type) ? p.type.join(' or ') : String(p.type)}`;
    case 'format':
      return `must be a valid ${String(p.format)}`;
    default:
      return e.message ?? e.keyword;
  }
}
