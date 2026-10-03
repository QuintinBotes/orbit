import { createHash } from 'node:crypto';

/**
 * Deterministic JSON: object keys sorted, no insignificant whitespace,
 * `undefined` members dropped. Two semantically equal values always produce
 * the same bytes, which is what policy and evidence hashes rely on.
 */
export function canonicalJson(value: unknown): string {
  // JSON.stringify(undefined) is undefined, not a string; hash it as null.
  return JSON.stringify(sortValue(value)) ?? 'null';
}

function sortValue(value: unknown): unknown {
  // Match JSON.stringify: Dates and other toJSON objects serialize through it.
  if (value !== null && typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    return sortValue((value as { toJSON(): unknown }).toJSON());
  }
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    // Null prototype: a "__proto__" key stays an ordinary key instead of becoming the prototype.
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortValue(v);
    }
    return out;
  }
  return value;
}

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** `sha256:<hex>` of the canonical JSON form. */
export function hashObject(value: unknown): string {
  return `sha256:${sha256(canonicalJson(value))}`;
}
