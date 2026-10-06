// scripts/bump-catalog-ref.mjs: the edit the release workflow makes to the catalog's marketplace.json.
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bumpOrbitRef } from '../../../scripts/bump-catalog-ref.mjs';

const SCRIPT = fileURLToPath(new URL('../../../scripts/bump-catalog-ref.mjs', import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CATALOG = `{
  "name": "acme-catalog",
  "plugins": [
    {
      "name": "other",
      "source": { "source": "github", "repo": "acme/other", "ref": "stable" },
      "tags": ["a", "b"]
    },
    {
      "name": "orbit",
      "source": {
        "source": "git-subdir",
        "url": "acme/orbit",
        "path": "plugin",
        "ref": "v0.1.0"
      },
      "tags": ["x", "y"]
    }
  ]
}
`;

describe('bumpOrbitRef', () => {
  it('changes only the orbit entry ref and leaves every other byte alone', () => {
    const out = bumpOrbitRef(CATALOG, 'v0.2.0');
    expect(out).toBe(CATALOG.replace('"ref": "v0.1.0"', '"ref": "v0.2.0"'));
    expect(JSON.parse(out).plugins[0].source.ref).toBe('stable');
    expect(JSON.parse(out).plugins[1].source.ref).toBe('v0.2.0');
  });

  it('works when orbit is the first entry and when the ref sits on one line', () => {
    const text = '{"plugins":[{"name":"orbit","source":{"source":"git-subdir","ref":"v0.1.0"}},{"name":"o","source":{"ref":"keep"}}]}';
    expect(bumpOrbitRef(text, 'v0.2.0')).toBe(text.replace('"v0.1.0"', '"v0.2.0"'));
  });

  it('is a no-op for the current tag', () => {
    expect(bumpOrbitRef(CATALOG, 'v0.1.0')).toBe(CATALOG);
  });

  it('refuses a malformed tag, invalid JSON, a missing orbit entry and an orbit entry with no ref', () => {
    expect(() => bumpOrbitRef(CATALOG, '0.2.0')).toThrow(/release tag/);
    expect(() => bumpOrbitRef('{ nope', 'v0.2.0')).toThrow(/not valid JSON/);
    expect(() => bumpOrbitRef('{"plugins":[{"name":"other"}]}', 'v0.2.0')).toThrow(/no orbit entry/);
    expect(() => bumpOrbitRef('{"plugins":[{"name":"orbit","source":"./plugins/orbit"}]}', 'v0.2.0')).toThrow(/no source\.ref/);
  });

  it('the CLI rewrites the file in place', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbit-bump-'));
    dirs.push(dir);
    const file = join(dir, 'marketplace.json');
    writeFileSync(file, CATALOG);
    const r = spawnSync(process.execPath, [SCRIPT, file, 'v0.2.0'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(readFileSync(file, 'utf8')).toContain('"ref": "v0.2.0"');
    expect(spawnSync(process.execPath, [SCRIPT, file, 'nope'], { encoding: 'utf8' }).status).toBe(1);
    expect(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status).toBe(2);
  });
});
