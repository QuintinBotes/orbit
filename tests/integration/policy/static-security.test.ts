import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyStaticFindings, findOnPath, judgeSastResult, parseSarif, scanCandidateSecrets, secretSeverity } from '../../../src/controller/security.ts';
import { staticSecurityGate } from '../../../src/controller/gates.ts';
import { parseConfig } from '../../../src/policy/config.ts';
import type { StaticSecurityConfig } from '../../../src/policy/types.ts';
import { git } from '../controller/harness.ts';

/**
 * S5.18 / S5.38, gap G23: scanner findings carry a severity, and
 * `static_security` decides which block, which are advisory and which a
 * recorded exception waives.
 */

// Synthetic, built at runtime so no literal token sits in the repository.
const TOKEN = ['ghp', '_', 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2'].join('');
const gitleaks = findOnPath('gitleaks');
const NOW = Date.UTC(2026, 9, 5);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repoWith(files: Record<string, string>): { repo: string; base: string; head: string; out: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-static-sec-')));
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

function policy(yaml: string): StaticSecurityConfig {
  return parseConfig(`version: 1\n${yaml}`).static_security!;
}

const gate = (scan: Awaited<ReturnType<typeof scanCandidateSecrets>>) => staticSecurityGate({ scan, sast: [{ checkId: 'sast', status: 'PASSED' }] });

describe('secret scan findings under static_security', () => {
  it('gives every secret finding a severity: account and signing credentials critical, anything else high', () => {
    expect(secretSeverity('github-pat')).toBe('critical');
    expect(secretSeverity('builtin:github-token')).toBe('critical');
    expect(secretSeverity('private-key')).toBe('critical');
    expect(secretSeverity('aws-access-token')).toBe('critical');
    expect(secretSeverity('generic-api-key')).toBe('high');
    expect(secretSeverity('builtin:password')).toBe('high');
  });

  it.skipIf(!gitleaks)('passes an excepted gitleaks rule with its reason recorded, and blocks the same rule elsewhere', async () => {
    const r = repoWith({ 'tests/fixtures/token.mjs': `export const sample = '${TOKEN}';\n`, 'apps/config.mjs': `export const token = '${TOKEN}';\n` });
    const p = policy('static_security:\n  exceptions:\n    - {rule_id: github-pat, path_glob: "tests/fixtures/**", reason: revoked sample token kept for parser tests, expires: 2026-12-31}\n');
    const res = await scanCandidateSecrets({ repoRoot: r.repo, baseRev: r.base, commit: r.head, outDir: r.out, policy: p, now: NOW });
    expect(res.scanner).toBe('gitleaks');
    expect(res.findings).toEqual([expect.objectContaining({ file: 'apps/config.mjs', rule: 'github-pat', severity: 'critical' })]);
    expect(res.excepted).toEqual([expect.objectContaining({ rule_id: 'github-pat', reason: 'revoked sample token kept for parser tests', finding: expect.objectContaining({ file: 'tests/fixtures/token.mjs' }) })]);
    expect(res.note).toMatch(/waived by static_security\.exceptions: github-pat at tests\/fixtures\/token\.mjs:1 \(revoked sample token kept for parser tests\)/);
    expect(gate(res).status).toBe('fail');
    expect(readFileSync(res.reportPath, 'utf8')).not.toContain(TOKEN);
  });

  it.skipIf(!gitleaks)('lets the gate pass once every finding is excepted, and blocks again when the exception has expired', async () => {
    const r = repoWith({ 'tests/fixtures/token.mjs': `export const sample = '${TOKEN}';\n` });
    const yaml = (expires: string) => `static_security:\n  exceptions:\n    - {rule_id: github-pat, path_glob: null, reason: revoked sample token kept for parser tests, expires: ${expires}}\n`;
    const ok = await scanCandidateSecrets({ repoRoot: r.repo, baseRev: r.base, commit: r.head, outDir: r.out, policy: policy(yaml('2026-12-31')), now: NOW });
    expect(ok.findings).toEqual([]);
    expect(gate(ok).status).toBe('pass');
    // The same recorded scan, judged again under a policy whose exception has lapsed.
    const lapsed = await scanCandidateSecrets({ repoRoot: r.repo, baseRev: r.base, commit: r.head, outDir: r.out, policy: policy(yaml('2026-01-31')), now: NOW });
    expect(lapsed.findings).toHaveLength(1);
    expect(lapsed.note).toMatch(/expired exception\(s\) not applied: github-pat \(expired 2026-01-31\)/);
    expect(gate(lapsed).status).toBe('fail');
  });

  it('blocks an unexcepted finding with the built-in scanner, and reports it as advisory when its severity is not blocking', async () => {
    const r = repoWith({ 'apps/config.mjs': `export const token = '${TOKEN}';\n` });
    const strict = await scanCandidateSecrets({ repoRoot: r.repo, baseRev: r.base, commit: r.head, outDir: r.out, gitleaksPath: null });
    expect(strict.findings).toEqual([expect.objectContaining({ file: 'apps/config.mjs', rule: 'builtin:github-token', severity: 'critical' })]);
    expect(gate(strict).status).toBe('fail');

    const lenient = await scanCandidateSecrets({ repoRoot: r.repo, baseRev: r.base, commit: r.head, outDir: r.out, gitleaksPath: null, policy: policy('static_security: {block_severities: [high]}\n'), now: NOW });
    expect(lenient.findings).toEqual([]);
    expect(lenient.advisory).toEqual([expect.objectContaining({ rule: 'builtin:github-token' })]);
    expect(lenient.note).toMatch(/1 advisory finding\(s\) below the blocking severities/);
    expect(gate(lenient).status).toBe('pass');

    // An exception names the built-in rule by its kind.
    const waived = await scanCandidateSecrets({ repoRoot: r.repo, baseRev: r.base, commit: r.head, outDir: r.out, gitleaksPath: null, policy: policy('static_security: {exceptions: [{rule_id: github-token, reason: token is a revoked test credential}]}\n'), now: NOW });
    expect(waived.findings).toEqual([]);
    expect(waived.excepted?.[0]?.reason).toBe('token is a revoked test credential');
  });

  it('does not apply a dated exception without a clock reading', () => {
    const p = policy('static_security: {exceptions: [{rule_id: r1, reason: waived for the migration window, expires: 2030-01-01}]}\n');
    const c = classifyStaticFindings([{ file: 'a.ts', rule: 'r1', severity: 'high' as const }], p, undefined);
    expect(c.blocking).toHaveLength(1);
    expect(c.expired).toEqual([{ rule_id: 'r1', expires: '2030-01-01' }]);
  });
});

describe('SAST output (SARIF) under static_security', () => {
  const sarif = (results: object[], rules: object[] = []) => JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'acme-sast', rules } }, results }] });
  const result = (ruleId: string, level: string, uri: string, extra: object = {}) => ({ ruleId, level, message: { text: `issue ${ruleId}` }, locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: 3 } } }], ...extra });

  it('reads severity from security-severity scores, falling back to the result level', () => {
    const found = parseSarif(
      sarif(
        [result('sql-injection', 'error', 'file://apps/db.ts'), result('weak-hash', 'warning', './apps/hash.ts'), result('todo-comment', 'note', 'apps/x.ts'), result('scored', 'warning', 'apps/y.ts', { properties: { 'security-severity': '9.1' } })],
        [{ id: 'weak-hash', properties: { 'security-severity': '7.5' } }],
      ),
    );
    expect(found.map((f) => [f.rule, f.severity, f.file, f.line])).toEqual([
      ['sql-injection', 'high', 'apps/db.ts', 3],
      ['weak-hash', 'high', 'apps/hash.ts', 3],
      ['todo-comment', 'low', 'apps/x.ts', 3],
      ['scored', 'critical', 'apps/y.ts', 3],
    ]);
    expect(() => parseSarif('{')).toThrow(/not valid JSON/);
  });

  it('turns a failed SAST check with only advisory or waived findings into a pass, and a passing one with blocking findings into a failure', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-sarif-')));
    dirs.push(root);
    const advisoryFile = join(root, 'advisory.sarif');
    writeFileSync(advisoryFile, sarif([result('weak-random', 'warning', 'apps/a.ts'), result('sql-injection', 'error', 'tests/fixtures/q.ts')]));
    const p = policy('static_security: {exceptions: [{rule_id: sql-injection, path_glob: "tests/**", reason: fixture builds hostile queries on purpose}]}\n');
    const v = judgeSastResult({ checkId: 'sast', status: 'FAILED', artifacts: [{ path: advisoryFile, kind: 'file' }] }, 'sast', p, NOW);
    expect(v.status).toBe('PASSED');
    expect(v.note).toMatch(/0 blocking, 1 advisory, 1 waived finding\(s\).*fixture builds hostile queries on purpose/);
    expect(staticSecurityGate({ scan: { scanner: 'gitleaks', completed: true, findings: [], files: 1, note: 'gitleaks', reportPath: 'r' }, sast: [v] }).status).toBe('pass');

    const blockingFile = join(root, 'blocking.sarif.json');
    writeFileSync(blockingFile, sarif([result('sql-injection', 'error', 'apps/db.ts')]));
    const b = judgeSastResult({ checkId: 'sast', status: 'PASSED', artifacts: [{ path: blockingFile }] }, 'sast', p, NOW);
    expect(b.status).toBe('FAILED');

    // No SARIF, or unreadable SARIF: the exit status stands.
    expect(judgeSastResult({ checkId: 'sast', status: 'FAILED', artifacts: [] }, 'sast', p, NOW).status).toBe('FAILED');
    const broken = join(root, 'broken.sarif');
    writeFileSync(broken, 'not json');
    const u = judgeSastResult({ checkId: 'sast', status: 'FAILED', artifacts: [{ path: broken }] }, 'sast', p, NOW);
    expect(u.status).toBe('FAILED');
    expect(u.note).toMatch(/unreadable/);
    expect(judgeSastResult(null, 'sast', p, NOW).status).toBeNull();
  });
});
