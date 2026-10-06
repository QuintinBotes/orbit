import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../../../src/storage/db.ts';
import { ModelRegistry } from '../../../src/routing/registry.ts';
import { SHARED_CATALOG_MAX_AGE_MS, loadSharedCatalog, saveSharedCatalog, sharedCatalogPath } from '../../../src/routing/shared-catalog.ts';

const dirs: string[] = [];
const home = () => {
  const d = mkdtempSync(join(tmpdir(), 'orbit-shared-'));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const CATALOG = { models: [{ slug: 'gpt-acme-1', display_name: 'Acme 1', visibility: 'list', priority: 1, default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'medium' }] }] };
const clock = (now: number) => ({ now: () => now, sleep: async () => {} });

describe('the shared Codex catalog file', () => {
  it('round trips, and is ignored when absent, malformed, from the future, or too old', () => {
    const path = sharedCatalogPath(home());
    expect(loadSharedCatalog(path, 1_000)).toBeNull();
    saveSharedCatalog(path, CATALOG, 1_000);
    expect(loadSharedCatalog(path, 2_000)).toEqual(CATALOG);
    expect(loadSharedCatalog(path, 1_000 + SHARED_CATALOG_MAX_AGE_MS + 1)).toBeNull();
    expect(loadSharedCatalog(path, 1_000 - 2 * 3600 * 1000)).toBeNull();
    writeFileSync(path, 'not json');
    expect(loadSharedCatalog(path, 2_000)).toBeNull();
    writeFileSync(path, JSON.stringify({ schema: 'other', saved_at: 1_000, catalog: CATALOG }));
    expect(loadSharedCatalog(path, 2_000)).toBeNull();
  });
});

describe('ModelRegistry.adoptSharedCatalog', () => {
  it('adopts into a registry with no Codex model, once, and never replaces the registry\'s own', () => {
    const path = sharedCatalogPath(home());
    saveSharedCatalog(path, CATALOG, 1_000);
    const db = openDb(':memory:');
    try {
      const registry = new ModelRegistry(db, clock(2_000)).useSharedCatalog(path);
      registry.seed();
      expect(registry.get('gpt-acme-1')?.surfaces.find((s) => s.surface === 'codex-cli')?.available).toBe(true);
      // A second catalog does not displace what the registry already has.
      saveSharedCatalog(path, { models: [{ slug: 'gpt-acme-2', visibility: 'list' }] }, 1_500);
      expect(registry.adoptSharedCatalog()).toBe(false);
      expect(registry.get('gpt-acme-2')).toBeNull();
    } finally {
      db.close();
    }
  });

  it('does nothing without a path, with a catalog that does not parse, or with an expired one', () => {
    const path = sharedCatalogPath(home());
    const db = openDb(':memory:');
    try {
      const plain = new ModelRegistry(db, clock(2_000));
      plain.seed();
      expect(plain.adoptSharedCatalog()).toBe(false);
      saveSharedCatalog(path, { nope: true }, 1_000);
      expect(new ModelRegistry(db, clock(2_000)).useSharedCatalog(path).adoptSharedCatalog()).toBe(false);
      saveSharedCatalog(path, CATALOG, 1_000);
      expect(new ModelRegistry(db, clock(1_000 + SHARED_CATALOG_MAX_AGE_MS + 5)).useSharedCatalog(path).adoptSharedCatalog()).toBe(false);
    } finally {
      db.close();
    }
  });
});
