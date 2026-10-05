import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyStaticFindings, findOnPath, judgeSastResult, parseSarif, sastCheckIds, scanCandidateSecrets, secretSeverity, type SastFinding } from '../../../src/controller/security.ts';
import { defaultStaticSecurity } from '../../../src/policy/config.ts';
import type { PolicySnapshot, StaticSecurityConfig } from '../../../src/policy/types.ts';

// Synthetic, built at runtime so no literal token sits in the repository.
const TOKEN = ['ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'acme', GIT_AUTHOR_EMAIL: 'dev@acme.test', GIT_COMMITTER_NAME: 'acme', GIT_COMMITTER_EMAIL: 'dev@acme.test', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-secu-')));
  dirs.push(d);
  return d;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function repoWith(files: Record<string, string | null>, baseFiles: Record<string, string> = { 'apps/a.mjs': 'export const a = 1;\n' }): { repo: string; base: string; head: string; out: string; root: string } {
  const root = tmp();
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  for (const [rel, content] of Object.entries(baseFiles)) {
    mkdirSync(join(repo, rel, '..'), { recursive: true });
    writeFileSync(join(repo, rel), content);
  }
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  for (const [rel, content] of Object.entries(files)) {
    if (content === null) {
      rmSync(join(repo, rel));
      continue;
    }
    mkdirSync(join(repo, rel, '..'), { recursive: true });
    writeFileSync(join(repo, rel), content);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'candidate');
  return { repo, base, head: git(repo, 'rev-parse', 'HEAD'), out: join(root, 'evidence'), root };
}

/** A gitleaks stand-in: behaves as the JSON file next to it says, so each scanner outcome can be produced on demand. */
function fakeGitleaks(behavior: { exit?: number; stderr?: string; report?: 'findings' | 'garbage' | 'none'; findings?: { rel: string; line?: number | null; rule?: string }[] }): string {
  const dir = tmp();
  const bin = join(dir, 'gitleaks');
  writeFileSync(join(dir, 'behavior.json'), JSON.stringify(behavior));
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const b = JSON.parse(fs.readFileSync(path.join(__dirname, 'behavior.json'), 'utf8'));
const args = process.argv.slice(2);
const root = args[1];
const report = args[args.indexOf('-r') + 1];
fs.writeFileSync(path.join(__dirname, 'args.json'), JSON.stringify(args));
if (b.report === 'findings') fs.writeFileSync(report, JSON.stringify((b.findings || []).map((f) => ({ File: f.rel === '' ? '' : path.join(root, 'files', f.rel), StartLine: f.line === undefined ? 1 : f.line, RuleID: f.rule }))));
if (b.report === 'garbage') fs.writeFileSync(report, 'not json');
if (b.stderr) process.stderr.write(b.stderr);
process.exit(b.exit ?? 0);
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

describe('findOnPath', () => {
  it('finds an executable file in the first directory that has one, skipping empty segments', () => {
    const a = tmp();
    const b = tmp();
    writeFileSync(join(b, 'tool'), '#!/bin/sh\n');
    chmodSync(join(b, 'tool'), 0o755);
    expect(findOnPath('tool', `::${a}:${b}`)).toBe(join(b, 'tool'));
  });

  it('skips a file that is not executable and a directory of the same name', () => {
    const a = tmp();
    const b = tmp();
    writeFileSync(join(a, 'tool'), 'x');
    chmodSync(join(a, 'tool'), 0o644);
    mkdirSync(join(b, 'tool'));
    expect(findOnPath('tool', `${a}:${b}`)).toBeNull();
  });

  it('finds nothing without a PATH', () => {
    expect(findOnPath('tool', '')).toBeNull();
    const saved = process.env.PATH;
    delete process.env.PATH;
    try {
      expect(findOnPath('tool')).toBeNull();
    } finally {
      process.env.PATH = saved;
    }
  });
});

describe('secretSeverity', () => {
  it('is critical for credentials that grant access to an account, a cloud or a signing identity and high for the rest', () => {
    for (const rule of ['github-pat', 'aws-access-token', 'private-key', 'builtin:anthropic', 'gcp-api-key', 'stripe-access-token', 'slack-bot-token', 'jwt-base64']) expect(secretSeverity(rule), rule).toBe('critical');
    for (const rule of ['generic-api-key', 'builtin:bearer', 'awsome-thing', 'secret']) expect(secretSeverity(rule), rule).toBe('high');
  });
});

describe('classifyStaticFindings', () => {
  const policy = (over: Partial<StaticSecurityConfig> = {}): StaticSecurityConfig => ({ block_severities: ['critical', 'high'], exceptions: [], ...over });
  const f = (rule: string, file: string | null, severity?: 'critical' | 'high' | 'medium' | 'low') => ({ rule, file, ...(severity ? { severity } : {}) });

  it('blocks the severities the policy lists, reports the rest as advisory, and derives a severity for a bare finding', () => {
    const c = classifyStaticFindings([f('github-pat', 'a'), f('x', 'b', 'medium'), f('y', 'c', 'low'), f('generic', 'd')], policy(), undefined);
    expect(c.blocking.map((x) => x.file)).toEqual(['a', 'd']);
    expect(c.advisory.map((x) => x.file)).toEqual(['b', 'c']);
    const all = classifyStaticFindings([f('x', 'b', 'medium')], policy({ block_severities: ['medium'] }), undefined);
    expect(all.blocking).toHaveLength(1);
  });

  it('an exception for the rule waives it, and records its reason, expiry and which exception waived it', () => {
    const p = policy({ exceptions: [{ rule_id: 'github-pat', path_glob: null, reason: 'test fixture', expires: null }] });
    const c = classifyStaticFindings([f('github-pat', 'a')], p, undefined);
    expect(c.blocking).toEqual([]);
    expect(c.excepted).toEqual([{ finding: f('github-pat', 'a'), rule_id: 'github-pat', reason: 'test fixture', expires: null }]);
  });

  it('an exception under a path glob waives only findings there, including dotfiles, and a finding with no file matches nothing', () => {
    const p = policy({ exceptions: [{ rule_id: 'github-pat', path_glob: 'fixtures/**', reason: 'r', expires: null }] });
    const c = classifyStaticFindings([f('github-pat', 'fixtures/.env'), f('github-pat', 'apps/a.mjs'), f('github-pat', null)], p, undefined);
    expect(c.excepted.map((e) => e.finding.file)).toEqual(['fixtures/.env']);
    expect(c.blocking.map((x) => x.file)).toEqual(['apps/a.mjs', null]);
  });

  it('an exception names the built-in scanner\'s rule by its kind', () => {
    const p = policy({ exceptions: [{ rule_id: 'bearer', path_glob: null, reason: 'r', expires: null }] });
    expect(classifyStaticFindings([f('builtin:bearer', 'a')], p, undefined).excepted).toHaveLength(1);
  });

  it('an expired exception does not waive, is listed once, and a date-only expiry runs through its last day', () => {
    const expiry = '2026-10-03';
    const p = policy({ exceptions: [{ rule_id: 'r1', path_glob: null, reason: 'x', expires: expiry }] });
    const endOfDay = Date.parse('2026-10-03T23:59:59.999Z');
    expect(classifyStaticFindings([f('r1', 'a')], p, endOfDay).excepted).toHaveLength(1);
    const late = classifyStaticFindings([f('r1', 'a'), f('r1', 'b')], p, endOfDay + 1);
    expect(late.excepted).toEqual([]);
    expect(late.blocking).toHaveLength(2);
    expect(late.expired).toEqual([{ rule_id: 'r1', expires: expiry }]);
    // Without a clock a dated exception cannot be shown to be current.
    expect(classifyStaticFindings([f('r1', 'a')], p, undefined).expired).toHaveLength(1);
  });

  it('the first exception that applies wins, and a later one is not consulted', () => {
    const p = policy({
      exceptions: [
        { rule_id: 'r1', path_glob: 'other/**', reason: 'wrong path', expires: null },
        { rule_id: 'r1', path_glob: null, reason: 'first match', expires: null },
        { rule_id: 'r1', path_glob: null, reason: 'second match', expires: null },
      ],
    });
    expect(classifyStaticFindings([f('r1', 'a')], p, undefined).excepted.map((e) => e.reason)).toEqual(['first match']);
  });
});

const sarif = (results: object[], rules: object[] = []): string => JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { rules } }, results }] });

describe('parseSarif', () => {
  it('refuses text that is not JSON and a log without runs', () => {
    expect(() => parseSarif('{nope')).toThrow('the SARIF file is not valid JSON');
    expect(() => parseSarif('{"runs": 4}')).toThrow('the SARIF file has no runs array');
    expect(() => parseSarif('null')).toThrow();
  });

  it('maps result levels to severities, defaulting to warning', () => {
    const out = parseSarif(sarif([{ ruleId: 'a', level: 'error' }, { ruleId: 'b', level: 'warning' }, { ruleId: 'c', level: 'note' }, { ruleId: 'd', level: 'none' }, { ruleId: 'e' }]));
    expect(out.map((r) => [r.rule, r.severity])).toEqual([
      ['a', 'high'],
      ['b', 'medium'],
      ['c', 'low'],
      ['d', 'low'],
      ['e', 'medium'],
    ]);
  });

  it('prefers a security-severity score from the result, then the rule, and reads its bands', () => {
    const rules = [{ id: 'r', properties: { 'security-severity': '9.5' }, defaultConfiguration: { level: 'note' } }];
    const out = parseSarif(
      sarif(
        [
          { ruleId: 'r' },
          { ruleId: 'r', properties: { 'security-severity': 7 } },
          { ruleId: 'r', properties: { 'security-severity': '4.0' } },
          { ruleId: 'r', properties: { 'security-severity': 'low' } },
          { ruleId: 'q', properties: { 'security-severity': 0.5 }, level: 'error' },
          { ruleId: 'q', properties: { 'security-severity': 'NaN' }, level: 'error' },
        ],
        rules,
      ),
    );
    expect(out.map((r) => r.severity)).toEqual(['critical', 'high', 'medium', 'critical', 'low', 'high']);
  });

  it('takes the level from the rule\'s default configuration when the result has none', () => {
    const out = parseSarif(sarif([{ ruleId: 'r' }, { ruleId: 'r2' }], [{ id: 'r', defaultConfiguration: { level: 'error' } }, { id: 'r2', defaultConfiguration: {} }, { notAnId: true }]));
    expect(out.map((r) => r.severity)).toEqual(['high', 'medium']);
  });

  it('names a result by its rule id, by a rule object, or as sast', () => {
    const out = parseSarif(sarif([{ ruleId: 'plain' }, { rule: { id: 'nested' } }, {}, { rule: { id: 5 } }]));
    expect(out.map((r) => r.rule)).toEqual(['plain', 'nested', 'sast', 'sast']);
  });

  it('reads the location with its file prefix stripped, and tolerates a missing or malformed one', () => {
    const loc = (uri: unknown, startLine: unknown) => [{ physicalLocation: { artifactLocation: { uri }, region: { startLine } } }];
    const out = parseSarif(sarif([{ ruleId: 'a', locations: loc('file:///work/x.js', 12) }, { ruleId: 'b', locations: loc('./src/y.js', '3') }, { ruleId: 'c' }, { ruleId: 'd', locations: [] }, { ruleId: 'e', locations: [{}] }]));
    expect(out.map((r) => [r.file, r.line])).toEqual([
      ['/work/x.js', 12],
      ['src/y.js', null],
      [null, null],
      [null, null],
      [null, null],
    ]);
  });

  it('redacts and bounds the message', () => {
    const [r] = parseSarif(sarif([{ ruleId: 'a', message: { text: `${'x'.repeat(400)} ${TOKEN}` } }, { ruleId: 'b', message: 'bare' }]));
    expect(r!.message).toHaveLength(300);
    const out = parseSarif(sarif([{ ruleId: 'a', message: { text: `leaked ${TOKEN}` } }, { ruleId: 'b', message: 'bare' }]));
    expect(out[0]!.message).not.toContain(TOKEN);
    expect(out[1]!.message).toBe('');
  });

  it('skips runs without results and non-object runs', () => {
    expect(parseSarif(JSON.stringify({ runs: [{}, { results: 'x' }, null, { tool: {}, results: [{ ruleId: 'a' }] }] })).map((r) => r.rule)).toEqual(['a']);
  });
});

describe('judgeSastResult', () => {
  const policy = defaultStaticSecurity();
  function sarifFile(results: object[]): string {
    const dir = tmp();
    const p = join(dir, 'out.sarif');
    writeFileSync(p, sarif(results));
    return p;
  }

  it('has nothing to say about a check that did not run', () => {
    expect(judgeSastResult(null, 'sast', policy, 0)).toEqual({ checkId: 'sast', status: null, sarif: false, classification: null, note: null });
    expect(judgeSastResult(undefined, 'sast', policy, 0).sarif).toBe(false);
  });

  it('leaves the status alone without SARIF output, or for a check that neither passed nor failed', () => {
    expect(judgeSastResult({ checkId: 'sast', status: 'FAILED', artifacts: [{ path: 'log.txt' }] }, 'sast', policy, 0)).toMatchObject({ status: 'FAILED', sarif: false });
    expect(judgeSastResult({ checkId: 'sast', status: 'FAILED' }, 'sast', policy, 0)).toMatchObject({ status: 'FAILED', sarif: false });
    expect(judgeSastResult({ checkId: 'sast', status: 'TIMEOUT', artifacts: [{ path: sarifFile([]) }] }, 'sast', policy, 0)).toMatchObject({ status: 'TIMEOUT', sarif: false });
    expect(judgeSastResult({ checkId: 'sast', status: null }, 'sast', policy, 0).status).toBeNull();
  });

  it('an unreadable SARIF file leaves the exit status standing and says so', () => {
    const v = judgeSastResult({ checkId: 'sast', status: 'PASSED', artifacts: [{ path: join(tmp(), 'missing.sarif') }] }, 'sast', policy, 0);
    expect(v).toMatchObject({ status: 'PASSED', sarif: false, classification: null });
    expect(v.note).toContain('SARIF output unreadable');
    const bad = join(tmp(), 'bad.sarif.json');
    writeFileSync(bad, 'not json');
    expect(judgeSastResult({ checkId: 'sast', status: 'FAILED', artifacts: [{ path: bad }] }, 'sast', policy, 0).note).toContain('the SARIF file is not valid JSON');
  });

  it('a check that passed but reports a blocking finding is failed, and a failed one with only advisory findings passes', () => {
    const blocking = judgeSastResult({ checkId: 'sast', status: 'PASSED', artifacts: [{ path: sarifFile([{ ruleId: 'x', level: 'error' }]) }] }, 'sast', policy, 0);
    expect(blocking).toMatchObject({ status: 'FAILED', sarif: true });
    expect(blocking.note).toBe('SAST check sast: 1 blocking, 0 advisory, 0 waived finding(s) under static_security');
    const advisory = judgeSastResult({ checkId: 'sast', status: 'FAILED', artifacts: [{ path: sarifFile([{ ruleId: 'x', level: 'warning' }]) }] }, 'sast', policy, 0);
    expect(advisory).toMatchObject({ status: 'PASSED' });
    expect(advisory.classification?.advisory).toHaveLength(1);
  });

  it('lists what a policy exception waived, with its reason, and reads every SARIF file the check wrote', () => {
    const dir = tmp();
    const a = join(dir, 'a.sarif');
    const b = join(dir, 'b.SARIF.JSON');
    writeFileSync(a, sarif([{ ruleId: 'waive-me', level: 'error', locations: [{ physicalLocation: { artifactLocation: { uri: 'src/a.js' } } }] }]));
    writeFileSync(b, sarif([{ ruleId: 'waive-me', level: 'error' }]));
    const p: StaticSecurityConfig = { block_severities: ['high'], exceptions: [{ rule_id: 'waive-me', path_glob: null, reason: 'accepted risk', expires: null }] };
    const v = judgeSastResult({ checkId: 'sast', status: 'FAILED', artifacts: [{ path: a }, { path: b }, { path: join(dir, 'notes.txt') }] }, 'sast', p, 0);
    expect(v.status).toBe('PASSED');
    expect(v.note).toContain('0 blocking, 0 advisory, 2 waived');
    expect(v.note).toContain('waive-me at src/a.js (accepted risk)');
    expect(v.note).toContain('waive-me at ? (accepted risk)');
  });
});

describe('sastCheckIds', () => {
  it('names the checks whose ids say static analysis, sorted', () => {
    const snapshot = { config: { checks: { unit: {}, semgrep: {}, 'sast-js': {}, CodeQL: {}, 'security_scan.fast': {}, 'static-analysis': {}, lint: {}, 'my-sast': {}, bandit: {} } } } as unknown as PolicySnapshot;
    expect(sastCheckIds(snapshot)).toEqual(['CodeQL', 'bandit', 'sast-js', 'security_scan.fast', 'semgrep', 'static-analysis']);
  });
});

describe('scanCandidateSecrets with the built-in patterns', () => {
  it('finds a secret in an added line with its file and line number, records it redacted and says why gitleaks did not run', async () => {
    const r = repoWith({ 'apps/b.mjs': `// header\nexport const token = '${TOKEN}';\n` });
    const res = await scanCandidateSecrets({ repoRoot: r.repo, baseRev: r.base, commit: r.head, outDir: r.out, gitleaksPath: null });
    expect(res.scanner).toBe('builtin');
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]).toMatchObject({ file: 'apps/b.mjs', line: 2 });
    expect(res.note).toContain('because gitleaks is not installed');
    expect(readFileSync(res.reportPath, 'utf8')).not.toContain(TOKEN);
  });

  it('numbers lines across hunks and counts only added lines', async () => {
    const base = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const lines = base.split('\n');
    lines.splice(25, 0, `token = '${TOKEN}'`);
    lines.splice(2, 0, 'added early');
    const r = repoWith({ 'notes.txt': lines.join('\n') }, { 'notes.txt': base });
    const res = await scanCandidateSecrets({ repoRoot: r.repo, baseRev: r.base, commit: r.head, outDir: r.out, gitleaksPath: null });
    expect(res.findings.map((f) => [f.file, f.line])).toEqual([['notes.txt', 27]]);
  });

  it('finds nothing in a deletion-only change', async () => {
    const r = repoWith({ 'apps/a.mjs': null });
    const res = await scanCandidateSecrets({ repoRoot: r.repo, baseRev: r.base, commit: r.head, outDir: r.out, gitleaksPath: null });
    expect(res).toMatchObject({ scanner: 'builtin', completed: true, findings: [], files: 0 });
  });

  it('judges a reused scan of the same commit by the policy in force now, and summarises waived, advisory and expired findings once', async () => {
    const r = repoWith({ 'apps/b.mjs': `export const token = '${TOKEN}';\n` });
    const input = { repoRoot: r.repo, baseRev: r.base, commit: r.head, outDir: r.out, gitleaksPath: null, now: Date.parse('2026-10-05T00:00:00Z') };
    const first = await scanCandidateSecrets(input);
    expect(first.findings).toHaveLength(1);
    const waived = await scanCandidateSecrets({ ...input, policy: { block_severities: ['critical', 'high'], exceptions: [{ rule_id: first.findings[0]!.rule, path_glob: null, reason: 'fixture', expires: null }] } });
    expect(waived.findings).toEqual([]);
    expect(waived.excepted).toHaveLength(1);
    expect(waived.note).toContain('1 finding(s) waived by static_security.exceptions');
    expect(waived.note).toContain('(fixture)');
    expect(waived.note.match(/waived by/g)).toHaveLength(1);
    const advisory = await scanCandidateSecrets({ ...input, policy: { block_severities: [], exceptions: [] } });
    expect(advisory.findings).toEqual([]);
    expect(advisory.advisory).toHaveLength(1);
    expect(advisory.note).toContain('1 advisory finding(s) below the blocking severities');
    const expired = await scanCandidateSecrets({ ...input, policy: { block_severities: ['critical', 'high'], exceptions: [{ rule_id: first.findings[0]!.rule, path_glob: null, reason: 'old', expires: '2026-01-01' }] } });
    expect(expired.findings).toHaveLength(1);
    expect(expired.note).toContain('expired exception(s) not applied');
    expect(expired.note).not.toContain('advisory');
  });

  it('a finding without a line number reads without one in the summary', async () => {
    const r = repoWith({ 'apps/b.mjs': `export const token = '${TOKEN}';\n` });
    const input = { repoRoot: r.repo, baseRev: r.base, commit: r.head, outDir: r.out, gitleaksPath: null };
    await scanCandidateSecrets(input);
    const report = JSON.parse(readFileSync(join(r.out, 'secret-scan.json'), 'utf8'));
    report.raw[0].line = null;
    writeFileSync(join(r.out, 'secret-scan.json'), JSON.stringify(report));
    const res = await scanCandidateSecrets({ ...input, policy: { block_severities: [], exceptions: [] } });
    expect(res.note).toMatch(/at apps\/b\.mjs\)?(;|$)/);
    expect(res.note).not.toContain('apps/b.mjs:');
  });

  it('a different commit is scanned afresh, and an unfinished earlier report is never reused', async () => {
    const r = repoWith({ 'apps/b.mjs': 'export const b = 2;\n' });
    const input = { repoRoot: r.repo, baseRev: r.base, commit: r.head, outDir: r.out, gitleaksPath: null };
    await scanCandidateSecrets(input);
    const path = join(r.out, 'secret-scan.json');
    const report = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...report, completed: false, findings: [{ file: 'x', line: 1, rule: 'stale' }], raw: [{ file: 'x', line: 1, rule: 'stale' }] }));
    const again = await scanCandidateSecrets(input);
    expect(again.findings).toEqual([]);
    writeFileSync(path, JSON.stringify({ ...report, commit: 'deadbeef', findings: [{ file: 'x', line: 1, rule: 'stale' }], raw: [{ file: 'x', line: 1, rule: 'stale' }] }));
    expect((await scanCandidateSecrets(input)).findings).toEqual([]);
  });

  it('reuses a recorded scan that predates raw findings, from its judged findings', async () => {
    const r = repoWith({ 'apps/b.mjs': 'export const b = 2;\n' });
    mkdirSync(r.out, { recursive: true });
    writeFileSync(join(r.out, 'secret-scan.json'), JSON.stringify({ scanner: 'builtin', completed: true, commit: r.head, findings: [{ file: 'old.txt', line: 4, rule: 'github-pat' }], files: 1, note: 'recorded earlier', reportPath: join(r.out, 'secret-scan.json') }));
    const res = await scanCandidateSecrets({ repoRoot: r.repo, baseRev: r.base, commit: r.head, outDir: r.out, gitleaksPath: null });
    expect(res.findings).toMatchObject([{ file: 'old.txt', severity: 'critical' }]);
    expect(res.note).toBe('recorded earlier');
  });

  it('refuses a revision git does not know', async () => {
    const r = repoWith({ 'apps/b.mjs': 'x\n' });
    await expect(scanCandidateSecrets({ repoRoot: r.repo, baseRev: r.base, commit: 'no-such-rev', outDir: r.out, gitleaksPath: null })).rejects.toMatchObject({ code: 'GIT_FAILED' });
  });
});

describe('scanCandidateSecrets through a gitleaks binary', () => {
  it('runs it on a directory of only the changed files with the trusted config and reads its findings relative to the scanned tree', async () => {
    const r = repoWith({ 'apps/b.mjs': 'export const b = 2;\n', '.gitleaksignore': 'x\n' });
    const bin = fakeGitleaks({ exit: 1, report: 'findings', findings: [{ rel: 'apps/b.mjs', line: 7, rule: 'github-pat' }, { rel: 'apps/c.mjs', line: null }, { rel: '' }] });
    const res = await scanCandidateSecrets({ repoRoot: r.repo, baseRev: r.base, commit: r.head, outDir: r.out, gitleaksPath: bin });
    expect(res.scanner).toBe('gitleaks');
    expect(res.files).toBe(2);
    expect(res.findings.map((f) => [f.file, f.line, f.rule, f.severity])).toEqual([
      ['apps/b.mjs', 7, 'github-pat', 'critical'],
      ['apps/c.mjs', null, 'secret', 'high'],
      ['', 1, 'secret', 'high'],
    ]);
    const args = JSON.parse(readFileSync(join(bin, '..', 'args.json'), 'utf8')) as string[];
    expect(args.slice(0, 1)).toEqual(['dir']);
    expect(args).toEqual(expect.arrayContaining(['--ignore-gitleaks-allow', '--redact', '--no-banner', '-c', '-i']));
    // The candidate's .gitleaksignore sits one level below the scan root, where gitleaks does not read it.
    expect(args[1]!.endsWith(join('secret-scan', 'tree'))).toBe(true);
    expect(res.note).toContain('trusted configuration');
  });

  it('a clean scan with no report file has no findings', async () => {
    const r = repoWith({ 'apps/b.mjs': 'export const b = 2;\n' });
    const res = await scanCandidateSecrets({ repoRoot: r.repo, baseRev: r.base, commit: r.head, outDir: r.out, gitleaksPath: fakeGitleaks({ exit: 0, report: 'none' }) });
    expect(res).toMatchObject({ scanner: 'gitleaks', completed: true, findings: [], files: 1 });
  });

  it('a candidate that changes no files is not scanned', async () => {
    const r = repoWith({ 'apps/a.mjs': null });
    const res = await scanCandidateSecrets({ repoRoot: r.repo, baseRev: r.base, commit: r.head, outDir: r.out, gitleaksPath: fakeGitleaks({ exit: 2, stderr: 'must not run' }) });
    expect(res).toMatchObject({ scanner: 'gitleaks', files: 0, findings: [], note: 'gitleaks: the candidate adds or modifies no files' });
  });

  it('falls back to the built-in patterns, saying why, when gitleaks fails to run', async () => {
    const r = repoWith({ 'apps/b.mjs': `export const token = '${TOKEN}';\n` });
    const res = await scanCandidateSecrets({ repoRoot: r.repo, baseRev: r.base, commit: r.head, outDir: r.out, gitleaksPath: fakeGitleaks({ exit: 2, stderr: `boom ${TOKEN}` }) });
    expect(res.scanner).toBe('builtin');
    expect(res.note).toContain('because gitleaks could not complete (exit 2: boom');
    expect(res.note).not.toContain(TOKEN);
    expect(res.findings).toHaveLength(1);
  });

  it('does not trust a scan that reports leaks but wrote no readable report', async () => {
    const r = repoWith({ 'apps/b.mjs': 'export const b = 2;\n' });
    const missing = await scanCandidateSecrets({ repoRoot: r.repo, baseRev: r.base, commit: r.head, outDir: join(r.root, 'out-none'), gitleaksPath: fakeGitleaks({ exit: 1, report: 'none' }) });
    expect(missing.scanner).toBe('builtin');
    expect(missing.note).toContain('reported leaks but wrote no readable report');
    const garbage = await scanCandidateSecrets({ repoRoot: r.repo, baseRev: r.base, commit: r.head, outDir: join(r.root, 'out-garbage'), gitleaksPath: fakeGitleaks({ exit: 1, report: 'garbage' }) });
    expect(garbage.scanner).toBe('builtin');
    expect(garbage.note).toContain('gitleaks could not complete');
  });

  it('falls back when the binary cannot be started at all', async () => {
    const r = repoWith({ 'apps/b.mjs': 'export const b = 2;\n' });
    const res = await scanCandidateSecrets({ repoRoot: r.repo, baseRev: r.base, commit: r.head, outDir: r.out, gitleaksPath: join(tmp(), 'missing-gitleaks') });
    expect(res.scanner).toBe('builtin');
    expect(res.note).toContain('gitleaks could not complete');
  });

  it('skips a file larger than the scan limit and counts only what it copied', async () => {
    const r = repoWith({ 'big.bin': 'x'.repeat(5 * 1024 * 1024 + 10), 'apps/b.mjs': 'export const b = 2;\n' });
    const res = await scanCandidateSecrets({ repoRoot: r.repo, baseRev: r.base, commit: r.head, outDir: r.out, gitleaksPath: fakeGitleaks({ exit: 0, report: 'none' }) });
    expect(res.files).toBe(1);
  });

  it('finds gitleaks on the host path when none is named', async () => {
    const r = repoWith({ 'apps/b.mjs': 'export const b = 2;\n' });
    const bin = fakeGitleaks({ exit: 0, report: 'none' });
    const res = await scanCandidateSecrets({ repoRoot: r.repo, baseRev: r.base, commit: r.head, outDir: r.out, hostPath: join(bin, '..') });
    expect(res.scanner).toBe('gitleaks');
  });
});
