/**
 * The Codex model catalog, kept for the user instead of for one repository. `codex debug models` answers for the
 * logged-in user and the installed Codex client, so what `orbit models refresh` learns in one repository is just as
 * true in the next. The catalog is saved under ORBIT_HOME and a repository whose own registry holds no Codex models
 * adopts it (ModelRegistry.adoptSharedCatalog), so the reviewer gate does not demand a second refresh per repository.
 *
 * The saved text is the raw catalog and it goes through the same parser and registration as a live read; nothing is
 * probed on adoption. It expires: a model that was withdrawn must not stay "available" for ever on the strength of a
 * refresh made long ago, and an expired catalog is treated as none (the refusal then says to refresh).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJson } from '../core/fsx.ts';

export const SHARED_CATALOG_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

export function sharedCatalogPath(orbitHome: string): string {
  return join(orbitHome, 'models', 'codex-catalog.json');
}

export function saveSharedCatalog(path: string, catalog: unknown, nowMs: number): void {
  atomicWriteJson(path, { schema: 'orbit.codex-catalog/1', saved_at: nowMs, catalog });
}

/** The saved catalog, or null when there is none, it is unreadable, or it is older than the maximum age. */
export function loadSharedCatalog(path: string, nowMs: number): unknown | null {
  try {
    const saved = JSON.parse(readFileSync(path, 'utf8')) as { schema?: unknown; saved_at?: unknown; catalog?: unknown };
    if (saved.schema !== 'orbit.codex-catalog/1' || typeof saved.saved_at !== 'number' || saved.catalog === undefined) return null;
    if (nowMs - saved.saved_at > SHARED_CATALOG_MAX_AGE_MS || saved.saved_at > nowMs + 3600 * 1000) return null;
    return saved.catalog;
  } catch {
    return null;
  }
}
