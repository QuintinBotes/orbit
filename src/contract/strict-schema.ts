/**
 * Mechanical check that a JSON Schema fits the strict structured-output
 * subset both providers accept (docs/interfaces/codex-cli.md section 4,
 * claude-headless-and-sandbox.md `--json-schema`). Codex sends the schema with
 * `strict: true`, and the API rejects the whole request on one unsupported
 * keyword, so a schema that drifts out of the subset would fail every worker
 * of that role at spawn time. Adapters can call this before spawning; the
 * schema tests call it on every model-output schema.
 *
 * The rules are applied conservatively: anything the notes do not list as
 * supported is reported, even where a provider might tolerate it.
 */

const STRUCTURAL = ['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'anyOf', '$defs', '$ref'];
const ANNOTATIONS = ['title', 'description'];
const STRING_KEYWORDS = ['pattern', 'format'];
const NUMBER_KEYWORDS = ['multipleOf', 'maximum', 'exclusiveMaximum', 'minimum', 'exclusiveMinimum'];
const ARRAY_KEYWORDS = ['minItems', 'maxItems'];
const ALLOWED_KEYWORDS = new Set([...STRUCTURAL, ...ANNOTATIONS, ...STRING_KEYWORDS, ...NUMBER_KEYWORDS, ...ARRAY_KEYWORDS]);

export const STRICT_SUPPORTED_FORMATS: ReadonlySet<string> = new Set(['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'ipv4', 'ipv6', 'uuid']);
const JSON_TYPES = new Set(['string', 'number', 'boolean', 'integer', 'object', 'array', 'null']);

/** Provider limits from the strict-mode notes. */
export const STRICT_LIMITS = {
  maxObjectDepth: 10,
  maxProperties: 5000,
  maxNameAndEnumChars: 120_000,
  maxEnumValues: 1000,
} as const;

interface Totals {
  properties: number;
  chars: number;
  enumValues: number;
}

type Node = Record<string, unknown>;

function isNode(v: unknown): v is Node {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function jsonTypeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeAccepts(types: readonly string[], value: unknown): boolean {
  const t = jsonTypeOf(value);
  if (types.includes(t)) return true;
  return t === 'integer' && types.includes('number');
}

/** Returns every rule violation found; an empty list means the schema fits the subset. */
export function strictSchemaViolations(schema: unknown): string[] {
  const out: string[] = [];
  if (!isNode(schema)) return ['(root): schema must be an object'];
  if (schema.type !== 'object') out.push('(root): root type must be exactly "object"');
  if ('anyOf' in schema) out.push('(root): root must not be anyOf');
  const defs = isNode(schema.$defs) ? schema.$defs : {};
  const totals: Totals = { properties: 0, chars: 0, enumValues: 0 };
  walk(schema, '#', 1, true, defs, totals, out);
  if (totals.properties > STRICT_LIMITS.maxProperties) out.push(`(root): ${totals.properties} object properties exceed ${STRICT_LIMITS.maxProperties}`);
  if (totals.chars > STRICT_LIMITS.maxNameAndEnumChars) out.push(`(root): ${totals.chars} characters of names and enum values exceed ${STRICT_LIMITS.maxNameAndEnumChars}`);
  if (totals.enumValues > STRICT_LIMITS.maxEnumValues) out.push(`(root): ${totals.enumValues} enum values exceed ${STRICT_LIMITS.maxEnumValues}`);
  return out;
}

function walk(node: unknown, path: string, depth: number, isRoot: boolean, defs: Node, totals: Totals, out: string[]): void {
  if (!isNode(node)) {
    out.push(`${path}: subschema must be an object`);
    return;
  }
  for (const key of Object.keys(node)) {
    if (!ALLOWED_KEYWORDS.has(key)) out.push(`${path}: keyword "${key}" is not supported in strict structured output`);
  }
  if ('$defs' in node && !isRoot) out.push(`${path}: $defs is only supported at the root`);
  if (isRoot && isNode(node.$defs)) {
    for (const [name, def] of Object.entries(node.$defs)) {
      totals.chars += name.length;
      walk(def, `${path}/$defs/${name}`, depth, false, defs, totals, out);
    }
  }

  if ('$ref' in node) {
    const ref = node.$ref;
    const m = typeof ref === 'string' ? /^#\/\$defs\/([^/]+)$/.exec(ref) : null;
    if (!m || !Object.prototype.hasOwnProperty.call(defs, m[1]!)) out.push(`${path}: $ref must point to an existing #/$defs entry`);
    for (const key of Object.keys(node)) {
      if (key !== '$ref' && !ANNOTATIONS.includes(key)) out.push(`${path}: $ref must not have sibling keyword "${key}"`);
    }
    return;
  }

  if ('anyOf' in node) {
    if ('type' in node) out.push(`${path}: use either type or anyOf, not both`);
    const branches = node.anyOf;
    if (!Array.isArray(branches) || branches.length === 0) {
      out.push(`${path}: anyOf must be a non-empty array`);
      return;
    }
    branches.forEach((b, i) => walk(b, `${path}/anyOf/${i}`, depth, false, defs, totals, out));
    return;
  }

  const types = readTypes(node.type, path, out);
  if (types.length === 0) return;
  const has = (t: string) => types.includes(t);

  // Arrays count as a nesting level too: the notes do not say whether the
  // provider counts them, so the stricter reading is used.
  if ((has('object') || has('array')) && depth > STRICT_LIMITS.maxObjectDepth) {
    out.push(`${path}: nesting deeper than ${STRICT_LIMITS.maxObjectDepth} levels`);
  }

  if (has('object')) {
    if (node.additionalProperties !== false) out.push(`${path}: additionalProperties must be false`);
    const props = node.properties;
    if (!isNode(props)) {
      out.push(`${path}: object schemas must declare properties`);
    } else {
      const keys = Object.keys(props);
      const required = Array.isArray(node.required) ? node.required : null;
      if (!required) {
        out.push(`${path}: required must list every property`);
      } else {
        const req = new Set(required.map(String));
        if (req.size !== required.length) out.push(`${path}: required has duplicates`);
        for (const k of keys) if (!req.has(k)) out.push(`${path}: property "${k}" is not listed in required`);
        for (const r of req) if (!keys.includes(r)) out.push(`${path}: required names undefined property "${r}"`);
      }
      for (const [k, sub] of Object.entries(props)) {
        totals.properties += 1;
        totals.chars += k.length;
        walk(sub, `${path}/properties/${k}`, depth + 1, false, defs, totals, out);
      }
    }
  } else {
    for (const k of ['properties', 'required', 'additionalProperties']) {
      if (k in node) out.push(`${path}: "${k}" on a non-object schema`);
    }
  }

  if (has('array')) {
    if (!isNode(node.items)) out.push(`${path}: arrays must declare a single items schema`);
    else walk(node.items, `${path}/items`, depth + 1, false, defs, totals, out);
    checkCount(node, 'minItems', path, out);
    checkCount(node, 'maxItems', path, out);
    if (typeof node.minItems === 'number' && typeof node.maxItems === 'number' && node.minItems > node.maxItems) {
      out.push(`${path}: minItems exceeds maxItems`);
    }
  } else {
    for (const k of ['items', ...ARRAY_KEYWORDS]) if (k in node) out.push(`${path}: "${k}" on a non-array schema`);
  }

  if (has('string')) {
    if ('pattern' in node) {
      if (typeof node.pattern !== 'string') out.push(`${path}: pattern must be a string`);
      else {
        try {
          new RegExp(node.pattern, 'u');
        } catch {
          out.push(`${path}: pattern is not a valid regular expression`);
        }
      }
    }
    if ('format' in node && (typeof node.format !== 'string' || !STRICT_SUPPORTED_FORMATS.has(node.format))) {
      out.push(`${path}: format "${String(node.format)}" is not supported`);
    }
  } else {
    for (const k of STRING_KEYWORDS) if (k in node) out.push(`${path}: "${k}" on a non-string schema`);
  }

  if (has('number') || has('integer')) {
    for (const k of NUMBER_KEYWORDS) if (k in node && typeof node[k] !== 'number') out.push(`${path}: ${k} must be a number`);
  } else {
    for (const k of NUMBER_KEYWORDS) if (k in node) out.push(`${path}: "${k}" on a non-numeric schema`);
  }

  if ('enum' in node) {
    const values = node.enum;
    if (!Array.isArray(values) || values.length === 0) {
      out.push(`${path}: enum must be a non-empty array`);
    } else {
      totals.enumValues += values.length;
      for (const v of values) {
        if (typeof v === 'string') totals.chars += v.length;
        if (!typeAccepts(types, v)) out.push(`${path}: enum value of type ${jsonTypeOf(v)} does not match the declared type`);
      }
      if (has('null') && !values.includes(null)) out.push(`${path}: nullable enum must list null`);
    }
  }
  if ('const' in node) {
    if (typeof node.const === 'string') totals.chars += node.const.length;
    if (!typeAccepts(types, node.const)) out.push(`${path}: const value does not match the declared type`);
  }
}

function readTypes(type: unknown, path: string, out: string[]): string[] {
  if (type === undefined) {
    out.push(`${path}: every subschema needs a type, anyOf or $ref`);
    return [];
  }
  const list = Array.isArray(type) ? type : [type];
  if (list.length === 0) {
    out.push(`${path}: type must not be empty`);
    return [];
  }
  const types: string[] = [];
  for (const t of list) {
    if (typeof t !== 'string' || !JSON_TYPES.has(t)) out.push(`${path}: unknown type ${JSON.stringify(t)}`);
    else if (types.includes(t)) out.push(`${path}: duplicate type "${t}"`);
    else types.push(t);
  }
  return types;
}

function checkCount(node: Node, key: string, path: string, out: string[]): void {
  if (!(key in node)) return;
  const v = node[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) out.push(`${path}: ${key} must be a non-negative integer`);
}
