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
  describe('files above the gitleaks input limit', () => {
    // The old built-in scanner read the candidate's diff through a capture bounded at 8 MiB, so a secret only counts as
    // found by the streaming scan when it sits beyond that: these files are about 9.6 MiB with the secret at the end.
    const OLD_CAPTURE = 8 * 1024 * 1024;
    const big = (): string => `${'x'.repeat(79)}\n`.repeat(120_000) + `export const token = '${TOKEN}';\n`;

    it('place the secret beyond what the old scanner read', () => {
      expect(big().indexOf(TOKEN)).toBeGreaterThan(OLD_CAPTURE + 1024 * 1024);
    });

    it.skipIf(!gitleaks)('are scanned by the built-in detector, not skipped, when gitleaks runs', async () => {
      const r = repoWith({ 'apps/big.txt': big() });
      const res = await scanCandidateSecrets({ repoRoot: r.repo, baseRev: r.base, commit: r.head, outDir: r.out });
      expect(res.scanner).toBe('gitleaks');
      expect(res.findings).toEqual([expect.objectContaining({ file: 'apps/big.txt', line: 120_001 })]);
      expect(readFileSync(res.reportPath, 'utf8')).not.toContain(TOKEN);
    });

    it('are scanned in chunks by the built-in scan too', async () => {
      const r = repoWith({ 'apps/big.txt': big() });
      const res = await scanCandidateSecrets({ repoRoot: r.repo, baseRev: r.base, commit: r.head, outDir: r.out, gitleaksPath: null });
      expect(res.scanner).toBe('builtin');
      expect(res.findings).toEqual([expect.objectContaining({ file: 'apps/big.txt', line: 120_001 })]);
      expect(res.completed).toBe(true);
    });

    it('find a secret that straddles a chunk boundary on one very long line, beyond the old capture', async () => {
      // Windows are 1 MiB and each starts 8 KiB before the previous one ended; the end of the ninth is at this offset.
      const boundary = 8 * (1024 * 1024 - 8 * 1024) + 1024 * 1024;
      expect(boundary).toBeGreaterThan(OLD_CAPTURE);
      const r = repoWith({ 'apps/long.txt': `${'y'.repeat(boundary - Math.floor(TOKEN.length / 2) - 1)} ${TOKEN} tail\n` });
      const res = await scanCandidateSecrets({ repoRoot: r.repo, baseRev: r.base, commit: r.head, outDir: r.out, gitleaksPath: null });
      expect(res.findings).toEqual([expect.objectContaining({ file: 'apps/long.txt', line: 1 })]);
    });
  });

  describe('a file that cannot be scanned', () => {
    it('makes the scan incomplete and blocking', async () => {
      const r = repoWith({ 'apps/huge.bin': 'z'.repeat(4096) });
      const res = await scanCandidateSecrets({ repoRoot: r.repo, baseRev: r.base, commit: r.head, outDir: r.out, gitleaksPath: null, maxScanBytes: 1024 });
      expect(res.completed).toBe(false);
      expect(res.findings).toEqual([expect.objectContaining({ file: 'apps/huge.bin', rule: 'unscannable-file' })]);
      expect(res.note).toMatch(/could not be scanned/);
    });

    it.each([[['high']], [['critical']], [[]]] as const)('is incomplete and blocking whatever block_severities says (%j)', async (severities) => {
      const r = repoWith({ 'apps/huge.bin': 'z'.repeat(4096) });
      const policy = { block_severities: [...severities] as ('critical' | 'high' | 'medium' | 'low')[], exceptions: [] };
      const res = await scanCandidateSecrets({ repoRoot: r.repo, baseRev: r.base, commit: r.head, outDir: r.out, gitleaksPath: null, maxScanBytes: 1024, policy });
      expect(res.completed).toBe(false);
      expect(res.findings).toEqual([expect.objectContaining({ file: 'apps/huge.bin', rule: 'unscannable-file' })]);
      expect(res.advisory ?? []).toEqual([]);
    });

    it('stays incomplete when block_severities would make it advisory and the exception covers another path', async () => {
      const r = repoWith({ 'apps/huge.bin': 'z'.repeat(4096), 'apps/vendored.bin': 'z'.repeat(4096) });
      const policy = { block_severities: ['high'] as 'high'[], exceptions: [{ rule_id: 'unscannable-file', path_glob: 'apps/vendored.bin', reason: 'vendored blob', expires: null }] };
      const res = await scanCandidateSecrets({ repoRoot: r.repo, baseRev: r.base, commit: r.head, outDir: r.out, gitleaksPath: null, maxScanBytes: 1024, policy });
      expect(res.completed).toBe(false);
      expect(res.findings).toEqual([expect.objectContaining({ file: 'apps/huge.bin', rule: 'unscannable-file' })]);
      expect(res.excepted).toEqual([expect.objectContaining({ reason: 'vendored blob' })]);
    });

    it('is waived only by a policy exception for that rule and path', async () => {
      const r = repoWith({ 'apps/huge.bin': 'z'.repeat(4096), 'apps/other.bin': 'z'.repeat(4096) });
      const policy = { block_severities: ['critical', 'high'] as ('critical' | 'high')[], exceptions: [{ rule_id: 'unscannable-file', path_glob: 'apps/huge.bin', reason: 'vendored blob', expires: null }] };
      const res = await scanCandidateSecrets({ repoRoot: r.repo, baseRev: r.base, commit: r.head, outDir: r.out, gitleaksPath: null, maxScanBytes: 1024, policy });
      expect(res.findings).toEqual([expect.objectContaining({ file: 'apps/other.bin', rule: 'unscannable-file' })]);
      expect(res.completed).toBe(false);
      expect(res.excepted).toEqual([expect.objectContaining({ reason: 'vendored blob' })]);
      const all = { ...policy, exceptions: [{ ...policy.exceptions[0]!, path_glob: 'apps/*.bin' }] };
      const ok = await scanCandidateSecrets({ repoRoot: r.repo, baseRev: r.base, commit: r.head, outDir: join(r.out, '2'), gitleaksPath: null, maxScanBytes: 1024, policy: all });
      expect(ok.findings).toEqual([]);
      expect(ok.completed).toBe(true);
    });
  });
});
