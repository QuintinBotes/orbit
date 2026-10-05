import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { baselineAuditNotes, disallowedLicenses, evaluateDependencyAudit, installDependencies, manifestHash, parseNpmAudit, runDependencyAudit, type AuditFinding, type DependencyAudit } from '../../../src/evidence/baseline.ts';
import { cleanupCandidateCheckout, materializeCandidate, snapshotCandidate } from '../../../src/evidence/candidate.ts';
import { candidateSubject } from '../../../src/evidence/runner.ts';
import type { Candidate } from '../../../src/evidence/types.ts';
import { systemClock } from '../../../src/core/clock.ts';
import { NoIsolation } from '../../../src/isolation/none.ts';
import type { DependencyAuditConfig } from '../../../src/policy/types.ts';
import { defaultDependencyAudit } from '../../../src/policy/config.ts';
import { addWorktree, makeRepo, makeRun, nodeCheck, tempRoot, write, type TestRun } from './fixtures.ts';

const report = (vulns: Record<string, unknown>) => JSON.stringify({ auditReportVersion: 2, vulnerabilities: vulns });
const GHSA_A = 'GHSA-c2qf-rxjj-qqgw';
const GHSA_B = 'GHSA-9wv6-86v2-598j';
const vuln = (id: string, pkg: string, severity: AuditFinding['severity'], detail = ''): AuditFinding => ({ id, kind: 'vulnerability', package: pkg, severity, detail });
const lic = (pkg: string, detail = 'GPL-3.0-only'): AuditFinding => ({ id: `license:${pkg}@1.0.0`, kind: 'license', package: pkg, severity: null, detail });

describe('parseNpmAudit on unusual reports', () => {
  it('names an error by its code, or generically, when the summary is missing', () => {
    expect(() => parseNpmAudit(JSON.stringify({ error: { code: 'EAUDITNOLOCK' } }))).toThrow('npm audit failed: EAUDITNOLOCK');
    expect(() => parseNpmAudit(JSON.stringify({ error: {} }))).toThrow('npm audit failed: error');
  });

  it('skips entries without a via list, advisories without an id or a known severity, and keeps what is left sorted', () => {
    const found = parseNpmAudit(
      report({
        broken: null,
        'no-via': { name: 'no-via', severity: 'high' },
        'lib-b': { via: [{ source: 'abc', severity: 'low', title: 42 }, { url: 5, severity: 'high' }, null, 'string-via'] },
        'lib-a': { via: [{ name: 'zeta', url: `https://github.com/advisories/${GHSA_A}`, severity: 'high', title: 'Zeta flaw' }, { name: 'alpha', url: `https://github.com/advisories/${GHSA_A}`, severity: 'moderate', title: 'Alpha flaw' }] },
      }),
    );
    expect(found).toEqual([
      { id: GHSA_A, kind: 'vulnerability', package: 'alpha', severity: 'moderate', detail: 'Alpha flaw' },
      { id: GHSA_A, kind: 'vulnerability', package: 'zeta', severity: 'high', detail: 'Zeta flaw' },
      // Named by the entry it was found under when the advisory has no name, and untitled when the title is not text.
      { id: 'npm:abc', kind: 'vulnerability', package: 'lib-b', severity: 'low', detail: '' },
    ]);
  });
});

describe('disallowedLicenses on unusual lockfiles', () => {
  it('names a package by its entry path, defaults the version, and prefers an explicit name', () => {
    const lock = JSON.stringify({
      packages: {
        'node_modules/a/node_modules/nested': { license: 'GPL-3.0-only' },
        'node_modules/alias': { name: 'real-name', version: '4.0.0', license: 'GPL-3.0-only' },
        'node_modules/odd': { version: 7, license: 5 },
        'node_modules/null-entry': null,
      },
    });
    expect(disallowedLicenses(lock, ['MIT']).map((f) => [f.id, f.detail])).toEqual([
      ['license:nested@0.0.0', 'GPL-3.0-only'],
      ['license:odd@0.0.0', 'no license recorded'],
      ['license:real-name@4.0.0', 'GPL-3.0-only'],
    ]);
  });
});

describe('manifestHash', () => {
  let t: ReturnType<typeof tempRoot>;
  beforeEach(() => void (t = tempRoot()));
  afterEach(() => t.remove());

  it('is null with no manifest, and changes when any manifest or lockfile changes', () => {
    expect(manifestHash(t.root)).toBeNull();
    write(join(t.root, 'package.json'), '{"name":"a"}');
    const one = manifestHash(t.root);
    expect(one).toMatch(/^sha256:|^[0-9a-f]{64}$/);
    write(join(t.root, 'package-lock.json'), '{}');
    const two = manifestHash(t.root);
    expect(two).not.toBe(one);
    write(join(t.root, 'package-lock.json'), '{"x":1}');
    expect(manifestHash(t.root)).not.toBe(two);
    rmSync(join(t.root, 'package-lock.json'));
    expect(manifestHash(t.root)).toBe(one);
  });
});

describe('evaluateDependencyAudit corner cases', () => {
  const audit = (over: Partial<DependencyAudit>): DependencyAudit => ({ ran: true, reason: null, manifestHash: 'h', vulnerabilities: [], licenses: [], logPath: null, ...over });
  const policy = (over: Partial<DependencyAuditConfig> = {}): DependencyAuditConfig => ({ ...defaultDependencyAudit(), enabled: true, fail_on: 'high', exceptions: [], ...over });

  it('counts a base that could not be audited as knowing only its licenses', () => {
    const base = audit({ ran: false, vulnerabilities: [vuln(GHSA_A, 'lib', 'critical')], licenses: [lic('old-gpl')] });
    const cand = audit({ vulnerabilities: [vuln(GHSA_A, 'lib', 'critical')], licenses: [lic('old-gpl'), lic('new-gpl')] });
    const out = evaluateDependencyAudit(base, cand, policy(), 0);
    expect(out.preexisting.map((f) => f.package)).toEqual(['old-gpl']);
    expect(out.blocking.map((f) => f.package)).toEqual(['lib', 'new-gpl']);
  });

  it('treats every finding as new without a base, and judges a missing severity as below the bar', () => {
    const cand = audit({ vulnerabilities: [vuln(GHSA_A, 'lib', 'low'), { ...vuln(GHSA_B, 'odd', 'low'), severity: 'high' }] });
    const out = evaluateDependencyAudit(undefined, cand, policy({ fail_on: 'moderate' }), 0);
    expect(out.blocking.map((f) => f.package)).toEqual(['odd']);
    expect(out.advisory.map((f) => f.package)).toEqual(['lib']);
  });

  it('lists an expired exception once however many findings it covered, and still blocks them', () => {
    const exceptions = [{ id: GHSA_A, reason: 'risk accepted', expires: '2020-01-01' }, { id: 'license:gpl-lib', reason: 'legal ok', expires: null }];
    const cand = audit({ vulnerabilities: [vuln(GHSA_A, 'one', 'critical'), vuln(GHSA_A, 'two', 'critical')], licenses: [lic('gpl-lib')] });
    const out = evaluateDependencyAudit(undefined, cand, policy({ exceptions }), Date.parse('2026-06-01T00:00:00Z'));
    expect(out.expired).toEqual([{ id: GHSA_A, expires: '2020-01-01' }]);
    expect(out.blocking.map((f) => f.package)).toEqual(['one', 'two']);
    // A license is excepted by package name alone, whatever its version.
    expect(out.excepted.map((e) => [e.finding.package, e.reason])).toEqual([['gpl-lib', 'legal ok']]);
  });
});

describe('baselineAuditNotes wording', () => {
  const policy: DependencyAuditConfig = { ...defaultDependencyAudit(), enabled: true, fail_on: 'low', exceptions: [] };
  const ran = (over: Partial<DependencyAudit>): DependencyAudit => ({ ran: true, reason: null, manifestHash: 'h', vulnerabilities: [], licenses: [], logPath: null, ...over });

  it('omits the detail when an advisory has none, and counts a missing severity as low', () => {
    const notes = baselineAuditNotes(ran({ vulnerabilities: [vuln(GHSA_A, 'lib', 'high'), { ...vuln(GHSA_B, 'odd', 'low'), severity: null }] }), policy);
    expect(notes).toEqual([
      `pre-existing vulnerability on the base revision: lib: ${GHSA_A} (high)`,
      `pre-existing vulnerability on the base revision: odd: ${GHSA_B} (null)`,
    ]);
    expect(baselineAuditNotes(ran({ vulnerabilities: [vuln(GHSA_A, 'lib', 'high', 'Prototype pollution')] }), policy)[0]).toBe(`pre-existing vulnerability on the base revision: lib: ${GHSA_A} (high) Prototype pollution`);
  });
});

// ---------------------------------------------------------------------------
// the audit itself, with npm replaced on PATH

const cleanups: (() => void | Promise<void>)[] = [];
let savedPath: string | undefined;
beforeEach(() => void (savedPath = process.env.PATH));
afterEach(async () => {
  process.env.PATH = savedPath;
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface Lab {
  t: ReturnType<typeof tempRoot>;
  repo: string;
  base: string;
  run: TestRun;
}

const LOCK = `${JSON.stringify({ name: 'acme-app', lockfileVersion: 3, packages: { '': { name: 'acme-app' }, 'node_modules/ok': { version: '1.0.0', license: 'MIT' } } })}\n`;

function lab(npmScript: string, tweak: (c: import('../../../src/policy/types.ts').OrbitConfig) => void = () => {}, files: Record<string, string> | null = null): Lab {
  const t = tempRoot();
  cleanups.push(() => t.remove());
  write(join(t.root, 'fakebin', 'npm'), `#!/bin/sh\n${npmScript}\n`, 0o755);
  process.env.PATH = `${join(t.root, 'fakebin')}:${savedPath ?? '/usr/bin:/bin'}`;
  const r = makeRepo(t.root, files ?? { 'package.json': '{"name":"acme-app"}', 'package-lock.json': LOCK, 'src/a.txt': 'one\n' });
  const run = makeRun(t.root, r.repo, [nodeCheck('lint', '')], {
    configure: (c) => {
      c.dependencies.install_command = ['true'];
      c.dependencies.audit = { enabled: true, fail_on: 'high', license_allowlist: ['MIT'], exceptions: [] };
      tweak(c);
    },
  });
  cleanups.push(() => run.db.close());
  return { t, repo: r.repo, base: r.base, run };
}

const ctxFor = (l: Lab, over: Record<string, unknown> = {}) => ({ db: l.run.db, run: { id: l.run.runId, policyHash: l.run.policyHash }, snapshot: l.run.snapshot, isolation: new NoIsolation(), runDir: l.run.runDir, clock: systemClock, pollMs: 20, killGraceMs: 500, homeDir: join(l.t.root, 'home'), ...over });

async function candidateOf(l: Lab, change: (worktree: string) => void, name = 'c1'): Promise<{ cand: Candidate; dir: string }> {
  const wt = addWorktree(l.repo, join(l.t.root, `wt-${name}`), `orbit-${name}`);
  change(wt);
  const cand = await snapshotCandidate({ db: l.run.db, clock: systemClock, repoRoot: l.repo, worktree: wt, runId: l.run.runId, baseRev: l.base, attempt: 1, workerId: null });
  const dir = await materializeCandidate(l.repo, cand.commitSha, join(l.t.root, `co-${name}`), { readOnly: false });
  cleanups.push(() => cleanupCandidateCheckout(l.repo, dir));
  return { cand, dir };
}

const GOOD_NPM = `cat <<'JSON'\n${report({ ok: { name: 'ok', severity: 'low', via: [{ source: 1, name: 'ok', title: 'Minor', url: `https://github.com/advisories/${GHSA_B}`, severity: 'low' }] } })}\nJSON`;

describe('runDependencyAudit', () => {
  it('does nothing when the audit is off', async () => {
    const l = lab(GOOD_NPM, (c) => void (c.dependencies.audit = { enabled: false, fail_on: 'high', license_allowlist: null, exceptions: [] }));
    const { cand, dir } = await candidateOf(l, () => {});
    expect(await runDependencyAudit({ ...ctxFor(l), checkoutDir: dir }, candidateSubject(l.run.runDir, cand))).toBeNull();
  });

  it('says so when there is no npm lockfile, without running anything', async () => {
    const l = lab(GOOD_NPM, () => {}, { 'src/a.txt': 'one\n' });
    const { cand, dir } = await candidateOf(l, () => {});
    const out = await runDependencyAudit({ ...ctxFor(l), checkoutDir: dir }, candidateSubject(l.run.runDir, cand));
    expect(out).toMatchObject({ ran: false, manifestHash: null, vulnerabilities: [], licenses: [], logPath: null, reason: expect.stringContaining('no npm lockfile') });
  });

  it('still audits when the license policy cannot be read, and says the license policy was not checked', async () => {
    const l = lab(GOOD_NPM, () => {}, { 'package.json': '{}', 'package-lock.json': 'not json', 'src/a.txt': 'one\n' });
    const { cand, dir } = await candidateOf(l, () => {});
    const out = await runDependencyAudit({ ...ctxFor(l), checkoutDir: dir }, candidateSubject(l.run.runDir, cand));
    expect(out).toMatchObject({ ran: true, reason: 'license policy not checked: the lockfile is not valid JSON' });
    expect(out!.vulnerabilities.map((v) => v.id)).toEqual([GHSA_B]);
    expect(out!.logPath).toMatch(/orbit-dependency-audit\.log$/);
  });

  it('reports an audit that wrote no report and failed', async () => {
    const l = lab('echo "npm ERR! network" >&2; exit 3');
    const { cand, dir } = await candidateOf(l, () => {});
    const out = await runDependencyAudit({ ...ctxFor(l), checkoutDir: dir }, candidateSubject(l.run.runDir, cand));
    expect(out).toMatchObject({ ran: false, reason: 'npm audit could not produce a report (FAILED)', vulnerabilities: [] });
  });

  it('reports an audit that exits cleanly with an empty or non-JSON report', async () => {
    const empty = lab('exit 0');
    const e1 = await candidateOf(empty, () => {});
    const out1 = await runDependencyAudit({ ...ctxFor(empty), checkoutDir: e1.dir }, candidateSubject(empty.run.runDir, e1.cand));
    expect(out1).toMatchObject({ ran: false });
    expect(out1!.reason).toMatch(/npm audit wrote no report|npm audit did not write a JSON report/);

    const junk = lab('echo "<html>proxy login</html>"');
    const e2 = await candidateOf(junk, () => {});
    const out2 = await runDependencyAudit({ ...ctxFor(junk), checkoutDir: e2.dir }, candidateSubject(junk.run.runDir, e2.cand));
    expect(out2).toMatchObject({ ran: false, reason: 'npm audit did not write a JSON report' });
  });

  it('reports an audit that was cancelled before it started', async () => {
    const l = lab(GOOD_NPM);
    const { cand, dir } = await candidateOf(l, () => {});
    const ac = new AbortController();
    ac.abort();
    const out = await runDependencyAudit({ ...ctxFor(l, { signal: ac.signal }), checkoutDir: dir }, candidateSubject(l.run.runDir, cand));
    expect(out).toMatchObject({ ran: false, reason: 'npm audit did not start (cancelled)', logPath: null });
  });
});

describe('installDependencies and the audit gate', () => {
  it('needs a candidate or a base tree to bind the install to', async () => {
    const l = lab(GOOD_NPM);
    const { dir } = await candidateOf(l, () => {});
    await expect(installDependencies({ ...ctxFor(l), checkoutDir: dir })).rejects.toMatchObject({ code: 'INTERNAL', message: expect.stringContaining('needs a candidate or a base tree') });
  });

  it('returns not ok, with nothing run, when it is cancelled before the install starts', async () => {
    const l = lab(GOOD_NPM);
    const { cand, dir } = await candidateOf(l, () => {});
    const ac = new AbortController();
    ac.abort();
    const out = await installDependencies({ ...ctxFor(l, { signal: ac.signal }), checkoutDir: dir, candidate: cand });
    expect(out).toMatchObject({ skipped: false, ok: false, results: [], reason: null });
  });

  it('when policy forbids installing, still audits a candidate and blocks what the policy forbids', async () => {
    const l = lab(GOOD_NPM, (c) => void (c.dependencies.install_existing_lockfile = false));
    const strict = lab(GOOD_NPM, (c) => {
      c.dependencies.install_existing_lockfile = false;
      c.dependencies.audit = { enabled: true, fail_on: 'low', license_allowlist: ['MIT'], exceptions: [] };
    });
    const clean = await candidateOf(l, (wt) => writeFileSync(join(wt, 'src', 'a.txt'), 'two\n'));
    // The base manifests are unchanged, but with no recorded baseline there is nothing to compare against, so it is audited.
    const ok = await installDependencies({ ...ctxFor(l), checkoutDir: clean.dir, candidate: clean.cand });
    expect(ok).toMatchObject({ skipped: true, ok: false, results: [], reason: expect.stringContaining('does not allow installing') });
    expect(ok.audit).toMatchObject({ audited: true, blocking: [] });
    expect(ok.audit!.advisory.map((f) => f.package)).toEqual(['ok']);

    const blocked = await candidateOf(strict, (wt) => writeFileSync(join(wt, 'src', 'a.txt'), 'two\n'));
    const out = await installDependencies({ ...ctxFor(strict), checkoutDir: blocked.dir, candidate: blocked.cand });
    expect(out).toMatchObject({ skipped: false, ok: false, results: [], reason: expect.stringContaining('introduces 1 finding(s) the policy blocks') });
    expect(out.audit!.blocking.map((f) => f.id)).toEqual([GHSA_B]);
  });

  it('calls the dependency audit unverified, and does not block, when the candidate has no lockfile to audit', async () => {
    const l = lab(GOOD_NPM);
    const { cand, dir } = await candidateOf(l, (wt) => rmSync(join(wt, 'package-lock.json')));
    const out = await installDependencies({ ...ctxFor(l), checkoutDir: dir, candidate: cand });
    expect(out.ok).toBe(true);
    expect(out.audit).toMatchObject({ audited: true, blocking: [], summary: expect.stringMatching(/^dependency audit unverified: no npm lockfile/) });
    expect(out.reason).toBeNull();
  });
});

