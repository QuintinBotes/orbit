import { describe, expect, it } from 'vitest';
import { baselineAuditNotes, disallowedLicenses, evaluateDependencyAudit, MAX_BASELINE_AUDIT_NOTES, parseNpmAudit, type DependencyAudit } from '../../../src/evidence/baseline.ts';
import { defaultDependencyAudit } from '../../../src/policy/config.ts';

const report = (vulns: Record<string, unknown>) => JSON.stringify({ auditReportVersion: 2, vulnerabilities: vulns, metadata: {} });

describe('parseNpmAudit', () => {
  it('turns each direct advisory into a finding and skips the transitive pointers', () => {
    const found = parseNpmAudit(
      report({
        'lib-a': { name: 'lib-a', severity: 'high', via: [{ source: 1096, name: 'lib-a', title: 'Prototype pollution', url: 'https://github.com/advisories/GHSA-c2qf-rxjj-qqgw', severity: 'high' }, 'lib-b'] },
        'lib-b': { name: 'lib-b', severity: 'critical', via: [{ source: 42, name: 'lib-b', title: 'RCE', url: 'https://example.com/advisory', severity: 'critical' }] },
        'lib-c': { name: 'lib-c', severity: 'moderate', via: ['lib-a'] },
        'lib-d': { name: 'lib-d', severity: 'high', via: [{ name: 'lib-d', severity: 'unknown-level', url: 'https://github.com/advisories/GHSA-9wv6-86v2-598j' }] },
      }),
    );
    expect(found).toEqual([
      { id: 'GHSA-c2qf-rxjj-qqgw', kind: 'vulnerability', package: 'lib-a', severity: 'high', detail: 'Prototype pollution' },
      { id: 'npm:42', kind: 'vulnerability', package: 'lib-b', severity: 'critical', detail: 'RCE' },
    ]);
  });

  it('refuses an error report, a non-JSON report and an npm 6 report', () => {
    expect(() => parseNpmAudit(JSON.stringify({ error: { code: 'ENOAUDIT', summary: 'registry unreachable' } }))).toThrow(/npm audit failed: registry unreachable/);
    expect(() => parseNpmAudit('npm ERR! oops')).toThrow(/did not write a JSON report/);
    expect(() => parseNpmAudit(JSON.stringify({ advisories: {} }))).toThrow(/npm 7 or later/);
  });
});

describe('disallowedLicenses', () => {
  const lock = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'acme-app', license: 'UNLICENSED' },
      'node_modules/ok-mit': { version: '1.0.0', license: 'MIT' },
      'node_modules/dual': { version: '2.0.0', license: '(MIT OR GPL-3.0-only)' },
      'node_modules/both': { version: '3.0.0', license: 'MIT AND GPL-3.0-only' },
      'node_modules/@acme/scoped': { version: '1.2.3', license: 'GPL-3.0-only' },
      'node_modules/x/node_modules/nolicense': { version: '0.0.1' },
      'node_modules/linked': { link: true, resolved: 'packages/linked' },
    },
  });

  it('allows an OR when one side is allowed, an AND only when all are, and never a package without a license', () => {
    expect(disallowedLicenses(lock, ['MIT', 'ISC']).map((f) => [f.id, f.detail])).toEqual([
      ['license:@acme/scoped@1.2.3', 'GPL-3.0-only'],
      ['license:both@3.0.0', 'MIT AND GPL-3.0-only'],
      ['license:nolicense@0.0.1', 'no license recorded'],
    ]);
    expect(() => disallowedLicenses('{', ['MIT'])).toThrow(/not valid JSON/);
    expect(() => disallowedLicenses(JSON.stringify({ lockfileVersion: 1, dependencies: {} }), ['MIT'])).toThrow(/lockfileVersion 2/);
  });
});

describe('evaluateDependencyAudit', () => {
  const audit = (over: Partial<DependencyAudit>): DependencyAudit => ({ ran: true, reason: null, manifestHash: 'h', vulnerabilities: [], licenses: [], logPath: null, ...over });
  const v = (id: string, pkg: string, severity: 'critical' | 'high' | 'moderate' | 'low') => ({ id, kind: 'vulnerability' as const, package: pkg, severity, detail: '' });

  it('blames only new findings at or above fail_on on the candidate', () => {
    const base = audit({ vulnerabilities: [v('GHSA-2222-3333-4444', 'old', 'critical')] });
    const cand = audit({ vulnerabilities: [v('GHSA-2222-3333-4444', 'old', 'critical'), v('GHSA-5555-6666-7777', 'new', 'moderate'), v('GHSA-8888-9999-cccc', 'new', 'high')] });
    const r = evaluateDependencyAudit(base, cand, { ...defaultDependencyAudit(), enabled: true, fail_on: 'high' }, 0);
    expect(r.preexisting.map((f) => f.package)).toEqual(['old']);
    expect(r.blocking.map((f) => f.id)).toEqual(['GHSA-8888-9999-cccc']);
    expect(r.advisory.map((f) => f.id)).toEqual(['GHSA-5555-6666-7777']);
    // Without a base audit nothing shows a finding was already there.
    expect(evaluateDependencyAudit(null, cand, { ...defaultDependencyAudit(), enabled: true, fail_on: 'critical' }, 0).blocking.map((f) => f.package)).toEqual(['old']);
  });

  it('applies dated exceptions only with a clock reading before their expiry', () => {
    const cand = audit({ vulnerabilities: [v('GHSA-8888-9999-cccc', 'new', 'high')] });
    const policy = { ...defaultDependencyAudit(), enabled: true, exceptions: [{ id: 'GHSA-8888-9999-cccc', reason: 'not reachable from our code', expires: '2026-12-31' }] };
    expect(evaluateDependencyAudit(audit({}), cand, policy, Date.UTC(2026, 11, 31, 12)).excepted).toHaveLength(1);
    expect(evaluateDependencyAudit(audit({}), cand, policy, Date.UTC(2027, 0, 1)).blocking).toHaveLength(1);
    expect(evaluateDependencyAudit(audit({}), cand, policy, undefined).expired).toEqual([{ id: 'GHSA-8888-9999-cccc', expires: '2026-12-31' }]);
  });
});

describe('baselineAuditNotes (G52)', () => {
  const audit = (over: Partial<DependencyAudit>): DependencyAudit => ({ ran: true, reason: null, manifestHash: 'h', vulnerabilities: [], licenses: [], logPath: null, ...over });
  const v = (id: string, pkg: string, severity: 'critical' | 'high' | 'moderate' | 'low') => ({ id, kind: 'vulnerability' as const, package: pkg, severity, detail: 'advisory title' });
  const on = { ...defaultDependencyAudit(), enabled: true, fail_on: 'high' as const };

  it('lists each base finding at or above fail_on and each disallowed license, and skips the rest', () => {
    const lic = { id: 'license:gpl-pkg@1.0.0', kind: 'license' as const, package: 'gpl-pkg', severity: null, detail: 'GPL-3.0-only' };
    const notes = baselineAuditNotes(audit({ vulnerabilities: [v('GHSA-1111-2222-3333', 'a', 'critical'), v('GHSA-4444-5555-6666', 'b', 'high'), v('GHSA-7777-8888-9999', 'c', 'moderate')], licenses: [lic] }), on);
    expect(notes).toEqual([
      'pre-existing vulnerability on the base revision: a: GHSA-1111-2222-3333 (critical) advisory title',
      'pre-existing vulnerability on the base revision: b: GHSA-4444-5555-6666 (high) advisory title',
      'pre-existing license problem on the base revision: gpl-pkg is licensed GPL-3.0-only, which is not on the license allowlist',
    ]);
    expect(baselineAuditNotes(audit({ vulnerabilities: [v('GHSA-7777-8888-9999', 'c', 'moderate')] }), { ...on, fail_on: 'moderate' })).toHaveLength(1);
  });

  it('claims nothing when the audit is off or did not run, and bounds a long list', () => {
    const found = audit({ vulnerabilities: [v('GHSA-1111-2222-3333', 'a', 'critical')] });
    expect(baselineAuditNotes(found, { ...on, enabled: false })).toEqual([]);
    expect(baselineAuditNotes(audit({ ...found, ran: false, reason: 'no npm lockfile' }), on)).toEqual([]);
    expect(baselineAuditNotes(null, on)).toEqual([]);
    const many = audit({ vulnerabilities: Array.from({ length: MAX_BASELINE_AUDIT_NOTES + 3 }, (_, i) => v(`GHSA-${i}`, `p${i}`, 'high')) });
    const notes = baselineAuditNotes(many, on);
    expect(notes).toHaveLength(MAX_BASELINE_AUDIT_NOTES + 1);
    expect(notes.at(-1)).toBe('and 3 more pre-existing dependency audit finding(s) on the base revision');
  });
});
