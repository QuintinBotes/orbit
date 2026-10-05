import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHECK_CATEGORIES } from '../../../src/policy/types.ts';

describe('CHECK_CATEGORIES', () => {
  it('lists exactly the categories config.schema.json accepts, in the same order', () => {
    const schema = JSON.parse(readFileSync(new URL('../../../schemas/config.schema.json', import.meta.url), 'utf8')) as {
      $defs: Record<string, { properties?: { category?: { enum?: string[] } } }>;
    };
    const enums = Object.values(schema.$defs)
      .map((d) => d.properties?.category?.enum)
      .filter((e): e is string[] => Array.isArray(e));
    expect(enums).toHaveLength(1);
    expect([...CHECK_CATEGORIES]).toEqual(enums[0]);
    expect(new Set(CHECK_CATEGORIES).size).toBe(CHECK_CATEGORIES.length);
  });
});
