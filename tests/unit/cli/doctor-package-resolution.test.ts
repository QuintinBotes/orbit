import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { packageInstalled } from '../../../src/cli/commands/doctor.ts';

// Some packages (for example @axe-core/playwright) restrict their exports map so that
// "<name>/package.json" cannot be resolved; they are still installed.
describe('packageInstalled', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  function repoWith(pkg: string, exportsMap: unknown): string {
    const root = mkdtempSync(join(tmpdir(), 'orbit-doctor-'));
    dirs.push(root);
    writeFileSync(join(root, 'package.json'), '{"name":"acme-app"}');
    const dir = join(root, 'node_modules', ...pkg.split('/'));
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: pkg, main: 'dist/index.js', exports: exportsMap }));
    writeFileSync(join(dir, 'dist', 'index.js'), 'module.exports = {};');
    return root;
  }
  it('treats a package whose exports hide package.json as installed', () => {
    const root = repoWith('@acme/hidden-manifest', { '.': './dist/index.js' });
    expect(packageInstalled(createRequire(join(root, 'package.json')), '@acme/hidden-manifest')).toBe(true);
  });
  it('reports a package that is not there as missing', () => {
    const root = repoWith('@acme/present', { '.': './dist/index.js' });
    expect(packageInstalled(createRequire(join(root, 'package.json')), '@acme/absent')).toBe(false);
  });
});
