import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUDIT_CHECK_ID, installDependencies, runBaseline } from '../../../src/evidence/baseline.ts';
import { cleanupCandidateCheckout, materializeCandidate, snapshotCandidate } from '../../../src/evidence/candidate.ts';
import { listFailures } from '../../../src/evidence/store.ts';
import type { Candidate } from '../../../src/evidence/types.ts';
import { systemClock } from '../../../src/core/clock.ts';
import { NoIsolation } from '../../../src/isolation/none.ts';
import type { DependencyAuditConfig } from '../../../src/policy/types.ts';
import { addWorktree, makeRepo, makeRun, nodeCheck, sh, tempRoot, write, type TestRun } from '../../unit/evidence/fixtures.ts';

/**
 * S5.13 / gap G22: vulnerability and license policy at the baseline and on
 * a candidate that changes its dependencies. npm is replaced on PATH by a
 * script that answers `npm audit --json` from the lockfile it sees, so the
 * test needs no registry.
 */

const OLD_ADVISORY = 'GHSA-p6mc-m468-83gw';
const NEW_ADVISORY = 'GHSA-c2qf-rxjj-qqgw';

function lockfile(extra: Record<string, { version: string; license?: string }> = {}): string {
  const packages: Record<string, unknown> = { '': { name: 'acme-app', version: '1.0.0' }, 'node_modules/old-pkg': { version: '2.0.0', license: 'MIT' } };
  for (const [name, p] of Object.entries(extra)) packages[`node_modules/${name}`] = p;
  return `${JSON.stringify({ name: 'acme-app', version: '1.0.0', lockfileVersion: 3, requires: true, packages }, null, 2)}\n`;
}

const advisory = (pkg: string, ghsa: string, severity: string, title: string) => ({ name: pkg, severity, via: [{ source: 1000 + pkg.length, name: pkg, title, url: `https://github.com/advisories/${ghsa}`, severity }], effects: [], range: '*' });

const FAKE_NPM = `#!/bin/sh
[ "$1" = audit ] || { echo "unexpected npm $*" >&2; exit 2; }
if grep -q evil-pkg package-lock.json; then
cat <<'JSON'
${JSON.stringify({ auditReportVersion: 2, vulnerabilities: { 'old-pkg': advisory('old-pkg', OLD_ADVISORY, 'moderate', 'ReDoS in parser'), 'evil-pkg': advisory('evil-pkg', NEW_ADVISORY, 'high', 'Prototype pollution'), 'meh-pkg': advisory('meh-pkg', 'GHSA-9wv6-86v2-598j', 'low', 'Verbose errors') } })}
JSON
else
cat <<'JSON'
${JSON.stringify({ auditReportVersion: 2, vulnerabilities: { 'old-pkg': advisory('old-pkg', OLD_ADVISORY, 'moderate', 'ReDoS in parser') } })}
JSON
fi
echo "npm warn audit some noise" >&2
exit 1
`;

const cleanups: (() => void | Promise<void>)[] = [];
let savedPath: string | undefined;
beforeEach(() => {
  savedPath = process.env.PATH;
});
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

function lab(audit: Partial<DependencyAuditConfig>): Lab {
  const t = tempRoot();
  cleanups.push(() => t.remove());
  const bin = join(t.root, 'fakebin');
  write(join(bin, 'npm'), FAKE_NPM, 0o755);
  process.env.PATH = `${bin}:${savedPath ?? '/usr/bin:/bin'}`;
  const r = makeRepo(t.root, { 'package.json': JSON.stringify({ name: 'acme-app', version: '1.0.0' }), 'package-lock.json': lockfile(), 'src/a.txt': 'one\n' });
  const run = makeRun(t.root, r.repo, [nodeCheck('lint', '')], {
    configure: (c) => {
      // A configured install command that does nothing keeps the real npm out of the test.
      c.dependencies.install_command = ['true'];
      c.dependencies.audit = { enabled: true, fail_on: 'high', license_allowlist: ['MIT', 'ISC', 'Apache-2.0'], exceptions: [], ...audit };
    },
  });
  cleanups.push(() => run.db.close());
  return { t, repo: r.repo, base: r.base, run };
}

const ctxFor = (l: Lab, over: Record<string, unknown> = {}) => ({ db: l.run.db, run: { id: l.run.runId, policyHash: l.run.policyHash }, snapshot: l.run.snapshot, isolation: new NoIsolation(), runDir: l.run.runDir, clock: systemClock, pollMs: 20, killGraceMs: 500, homeDir: join(l.t.root, 'home'), ...over });

async function candidateWith(l: Lab, lock: string, name: string): Promise<{ cand: Candidate; dir: string }> {
  const wt = addWorktree(l.repo, join(l.t.root, `wt-${name}`), `orbit-${name}`);
  writeFileSync(join(wt, 'package-lock.json'), lock);
  writeFileSync(join(wt, 'src', 'a.txt'), `changed by ${name}\n`);
  const cand = await snapshotCandidate({ db: l.run.db, clock: systemClock, repoRoot: l.repo, worktree: wt, runId: l.run.runId, baseRev: l.base, attempt: 1, workerId: null });
  const dir = await materializeCandidate(l.repo, cand.commitSha, join(l.t.root, `co-${name}`), { readOnly: false });
  cleanups.push(() => cleanupCandidateCheckout(l.repo, dir));
  return { cand, dir };
}

describe('dependency audit at the baseline and dependency gates', () => {
  it('records the base revision findings and blocks a candidate that adds a high vulnerability or a disallowed license', async () => {
    const l = lab({});
    const baseline = await runBaseline({ ...ctxFor(l), repoRoot: l.repo, baseRev: l.base, checkoutDir: join(l.t.root, 'baseline') });
    expect(baseline.report.audit).toMatchObject({ ran: true, reason: null, licenses: [] });
    expect(baseline.report.audit!.vulnerabilities.map((v) => [v.id, v.package, v.severity])).toEqual([[OLD_ADVISORY, 'old-pkg', 'moderate']]);
    // Below fail_on (high), so the gate has nothing to list.
    expect(baseline.report.auditNotes).toEqual([]);
    // A pre-existing finding is recorded, not a failure of anything.
    expect(listFailures(l.run.db, l.run.runId)).toEqual([]);

    const { cand, dir } = await candidateWith(l, lockfile({ 'evil-pkg': { version: '1.0.0', license: 'GPL-3.0-only' }, 'meh-pkg': { version: '0.1.0', license: '(MIT OR GPL-3.0-only)' } }), 'evil');
    const out = await installDependencies({ ...ctxFor(l), checkoutDir: dir, candidate: cand });
    expect(out.ok).toBe(false);
    expect(out.skipped).toBe(false);
    expect(out.audit?.audited).toBe(true);
    expect(out.audit!.blocking.map((f) => f.id)).toEqual([NEW_ADVISORY, 'license:evil-pkg@1.0.0']);
    expect(out.audit!.advisory.map((f) => [f.package, f.severity])).toEqual([['meh-pkg', 'low']]);
    expect(out.audit!.preexisting.map((f) => f.id)).toEqual([OLD_ADVISORY]);
    expect(out.reason).toMatch(/introduces 2 finding\(s\) the policy blocks: evil-pkg: GHSA-c2qf-rxjj-qqgw \(high\) Prototype pollution; evil-pkg is licensed GPL-3\.0-only/);
    const failures = listFailures(l.run.db, l.run.runId).filter((f) => f.fingerprint.startsWith('dependency-audit:'));
    expect(failures.map((f) => [f.source, f.candidateId, f.fingerprint])).toEqual([
      ['install', cand.id, `dependency-audit:${NEW_ADVISORY}`],
      ['install', cand.id, 'dependency-audit:license:evil-pkg@1.0.0'],
    ]);
    const audited = l.run.db.get<{ data_json: string }>("SELECT data_json FROM events WHERE type = 'dependency.audit'");
    expect(JSON.parse(audited!.data_json)).toMatchObject({ candidate_id: cand.id, ran: true, blocking: [NEW_ADVISORY, 'license:evil-pkg@1.0.0'], preexisting: 1 });
    // The audit ran as an isolated, recorded check bound to the candidate.
    expect(l.run.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM check_runs WHERE check_id = ? AND candidate_id = ?', AUDIT_CHECK_ID, cand.id)?.n).toBe(1);

    // A candidate that leaves package.json and the lockfile alone is not audited again.
    const same = await candidateWith(l, lockfile(), 'same');
    const unchanged = await installDependencies({ ...ctxFor(l), checkoutDir: same.dir, candidate: same.cand });
    expect(unchanged).toMatchObject({ ok: true, audit: { audited: false, blocking: [] } });
  });

  it('accepts findings an unexpired exception covers, recording why, and ignores an expired one', async () => {
    const l = lab({
      exceptions: [
        { id: NEW_ADVISORY, reason: 'the polluted path is never reached from our code', expires: '2999-12-31' },
        { id: 'license:evil-pkg', reason: 'legal approved this package for internal tooling', expires: null },
        { id: 'GHSA-9wv6-86v2-598j', reason: 'expired waiver kept for the record', expires: '2001-01-01' },
      ],
      fail_on: 'low',
    });
    await runBaseline({ ...ctxFor(l), repoRoot: l.repo, baseRev: l.base, checkoutDir: join(l.t.root, 'baseline') });
    const { cand, dir } = await candidateWith(l, lockfile({ 'evil-pkg': { version: '1.0.0', license: 'GPL-3.0-only' } }), 'excepted');
    const out = await installDependencies({ ...ctxFor(l), checkoutDir: dir, candidate: cand });
    expect(out.audit!.excepted.map((e) => [e.finding.id, e.reason])).toEqual([
      [NEW_ADVISORY, 'the polluted path is never reached from our code'],
      ['license:evil-pkg@1.0.0', 'legal approved this package for internal tooling'],
    ]);
    // meh-pkg's low finding is blocking at fail_on: low, because its exception expired.
    expect(out.audit!.expired).toEqual([{ id: 'GHSA-9wv6-86v2-598j', expires: '2001-01-01' }]);
    expect(out.audit!.blocking.map((f) => f.package)).toEqual(['meh-pkg']);
    expect(out.ok).toBe(false);
  });

  it('records one gate note per base finding at or above fail_on, for the baseline gate to show (G52)', async () => {
    const l = lab({ fail_on: 'moderate' });
    const baseline = await runBaseline({ ...ctxFor(l), repoRoot: l.repo, baseRev: l.base, checkoutDir: join(l.t.root, 'baseline') });
    expect(baseline.report.auditNotes).toEqual([`pre-existing vulnerability on the base revision: old-pkg: ${OLD_ADVISORY} (moderate) ReDoS in parser`]);
    // The note is part of the stored baseline, so a reused baseline carries it too.
    const again = await runBaseline({ ...ctxFor(l), repoRoot: l.repo, baseRev: l.base, checkoutDir: join(l.t.root, 'baseline') });
    expect(again.reused).toBe(true);
    expect(again.report.auditNotes).toEqual(baseline.report.auditNotes);
  });

  it('does nothing when the audit is off', async () => {
    const l = lab({ enabled: false });
    const baseline = await runBaseline({ ...ctxFor(l), repoRoot: l.repo, baseRev: l.base, checkoutDir: join(l.t.root, 'baseline') });
    expect(baseline.report.audit).toBeUndefined();
    expect(baseline.report.auditNotes).toEqual([]);
    const { cand, dir } = await candidateWith(l, lockfile({ 'evil-pkg': { version: '1.0.0', license: 'GPL-3.0-only' } }), 'off');
    const out = await installDependencies({ ...ctxFor(l), checkoutDir: dir, candidate: cand });
    expect(out).toMatchObject({ ok: true });
    expect(out.audit).toBeNull();
    expect(readFileSync(join(l.run.runDir, 'baseline.json'), 'utf8')).not.toContain('"audit"');
    expect(sh(l.repo, 'status', '--porcelain')).toBe('');
  });
});
