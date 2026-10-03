import { createHash } from 'node:crypto';

/**
 * Deterministic JSON: object keys sorted, no insignificant whitespace,
 * `undefined` members dropped. Two semantically equal values always produce
 * the same bytes, which is what policy and evidence hashes rely on.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
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
