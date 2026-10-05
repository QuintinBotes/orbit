import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findOnPath, scanCandidateSecrets } from '../../../src/controller/security.ts';
import { git } from './harness.ts';

// Synthetic, built at runtime so no literal token sits in the repository.
const TOKEN = ['ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
const gitleaks = findOnPath('gitleaks');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repoWith(files: Record<string, string>): { repo: string; base: string; head: string; out: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-sec-')));
  dirs.push(root);
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'apps'), { recursive: true });
  writeFileSync(join(repo, 'apps', 'a.mjs'), 'export const a = 1;\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(repo, rel, '..'), { recursive: true });
    writeFileSync(join(repo, rel), content);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'candidate');
  return { repo, base, head: git(repo, 'rev-parse', 'HEAD'), out: join(root, 'evidence') };
}

describe('secret scan of a candidate', () => {
  it.skipIf(!gitleaks)('runs gitleaks with the trusted config, so the repository cannot allowlist its own leak', async () => {
    const r = repoWith({
      '.gitleaks.toml': '[allowlist]\npaths = [".*"]\n',
      '.gitleaksignore': 'apps/config.mjs:github-pat:1\n',
      'apps/config.mjs': `export const token = '${TOKEN}'; // gitleaks:allow\n`,
    });
    const res = await scanCandidateSecrets({ repoRoot: r.repo, baseRev: r.base, commit: r.head, outDir: r.out });
    expect(res.scanner).toBe('gitleaks');
    expect(res.findings).toEqual([expect.objectContaining({ file: 'apps/config.mjs', line: 1 })]);
    // Redacted: the report never holds the value.
    expect(readFileSync(res.reportPath, 'utf8')).not.toContain(TOKEN);
  });

  it.skipIf(!gitleaks)('ignores a .gitleaksignore the candidate adds, even one naming the exact scan fingerprints', async () => {
    // gitleaks reads <scanned dir>/.gitleaksignore despite -i, and its fingerprints are absolute paths of the
    // scanned copy, which a worker can predict from the run directory layout.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-sec-')));
    dirs.push(root);
    const out = join(root, 'evidence');
    const scanned = [join(out, 'secret-scan', 'tree'), join(out, 'secret-scan', 'tree', 'files')];
    const r = repoWith({
      '.gitleaksignore': scanned.map((d) => `${d}/apps/config.mjs:github-pat:1\n`).join(''),
      'apps/config.mjs': `export const token = '${TOKEN}';\n`,
    });
    const res = await scanCandidateSecrets({ repoRoot: r.repo, baseRev: r.base, commit: r.head, outDir: out });
    expect(res.scanner).toBe('gitleaks');
    expect(res.findings).toEqual([expect.objectContaining({ file: 'apps/config.mjs', line: 1 })]);
  });

  it('falls back to the built-in patterns without gitleaks and says so', async () => {
    const r = repoWith({ 'apps/config.mjs': `export const token = '${TOKEN}';\n` });
    const res = await scanCandidateSecrets({ repoRoot: r.repo, baseRev: r.base, commit: r.head, outDir: r.out, gitleaksPath: null });
    expect(res.scanner).toBe('builtin');
    expect(res.note).toMatch(/built-in secret patterns/);
    expect(res.findings).toEqual([expect.objectContaining({ file: 'apps/config.mjs', line: 1 })]);
    expect(readFileSync(res.reportPath, 'utf8')).not.toContain(TOKEN);
  });

  it('finds nothing in a clean change and reuses the result for the same commit', async () => {
    const r = repoWith({ 'apps/b.mjs': 'export const b = 2;\n' });
    const first = await scanCandidateSecrets({ repoRoot: r.repo, baseRev: r.base, commit: r.head, outDir: r.out });
    expect(first.findings).toEqual([]);
    expect(first.completed).toBe(true);
    const again = await scanCandidateSecrets({ repoRoot: r.repo, baseRev: r.base, commit: r.head, outDir: r.out, gitleaksPath: null });
    expect(again.scanner).toBe(first.scanner);
  });
});
