/**
 * Small JSON Schema helper for the contract module. Every schema Orbit ships
 * is draft 2020-12 and compiled in ajv strict mode, so a typo in a schema
 * fails loudly at compile time instead of silently accepting anything.
 *
 * Kept local so this module does not depend on the shared validator's
 * timing; it has the same semantics (strict, all errors, formats on).
 */
import Ajv2020Import from 'ajv/dist/2020.js';
import addFormatsImport from 'ajv-formats';
import type { ErrorObject, ValidateFunction } from 'ajv/dist/2020.js';

type Ajv2020Ctor = typeof Ajv2020Import;
type AddFormats = typeof addFormatsImport;

// Both packages are CommonJS; under ESM the class can arrive as the module
// object or as its `default` member depending on the loader.
const Ajv2020: Ajv2020Ctor = (Ajv2020Import as unknown as { default?: Ajv2020Ctor }).default ?? Ajv2020Import;
const addFormats: AddFormats = (addFormatsImport as unknown as { default?: AddFormats }).default ?? addFormatsImport;

let instance: InstanceType<Ajv2020Ctor> | null = null;
const compiled = new WeakMap<object, ValidateFunction>();

function ajv(): InstanceType<Ajv2020Ctor> {
  if (!instance) {
    // allowUnionTypes: strict structured-output schemas express "nullable" as
    // a type union, which ajv's strictTypes would otherwise reject.
    instance = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
    addFormats(instance);
  }
  return instance;
}

export type SchemaResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/**
 * Compile once per schema object. Ajv registers schemas by `$id`, so
 * compiling the same object twice would throw; the WeakMap keeps one
 * validator per imported schema.
 */
export function schemaValidator(schema: object): ValidateFunction {
  let fn = compiled.get(schema);
  if (!fn) {
    fn = ajv().compile(schema);
    compiled.set(schema, fn);
  }
  return fn;
}

export function validateAgainst<T>(schema: object, value: unknown): SchemaResult<T> {
  const fn = schemaValidator(schema);
  if (fn(value)) return { ok: true, value: value as T };
  return { ok: false, errors: formatErrors(fn.errors ?? []) };
}

// A property name the schema does not define was chosen by the model, so it
// is shown only when it is a short plain identifier.
const PRINTABLE_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,47}$/;

/**
 * Error text names the location and the rule, never the offending value, so
 * a model-produced secret or private term is not echoed into logs.
 */
export function formatErrors(errors: readonly ErrorObject[]): string[] {
  const out: string[] = [];
  for (const e of errors) {
    const at = e.instancePath === '' ? '(root)' : e.instancePath;
    if (e.keyword === 'additionalProperties') {
      const name = String((e.params as { additionalProperty?: unknown }).additionalProperty);
      out.push(PRINTABLE_NAME.test(name) ? `${at}: unexpected property "${name}"` : `${at}: unexpected property (name not shown)`);
    } else if (e.keyword === 'required') {
      out.push(`${at}: missing property "${String((e.params as { missingProperty?: unknown }).missingProperty)}"`);
    } else {
      out.push(`${at}: ${e.message ?? e.keyword}`);
    }
  }
  return [...new Set(out)];
}
