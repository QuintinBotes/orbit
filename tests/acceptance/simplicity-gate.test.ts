/**
 * Issue #232, User Story 1: a candidate cannot quietly add new tangles. The lab's policy gets a `simplicity` check that
 * runs `unknot diagnose --baseline "$ORBIT_BASE_REVISION" --fail-on new:high --json`. Unknot is faked at the process
 * boundary (a script named `unknot` first on PATH) that behaves as unknot 0.4.0 does for `diagnose`: it needs a `.unknot`
 * directory (UK_NOT_INITIALIZED otherwise), reads --baseline, --fail-on and --json, exits 5 for a base that is not a commit,
 * 1 for a new high finding under --fail-on, and prints schema 1.0 with stats, errors and analysis. It reports a new
 * import-cycle finding when the checkout holds src/cycle-b.ts, hangs when it holds src/slow.ts, and logs every call.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultCheck } from '../../src/policy/config.ts';
import { listRuns } from '../../src/controller/run-store.ts';
import { listCandidates, listCheckRuns } from '../../src/evidence/store.ts';
import { drive, makeLab, orbitOnce, READY, startLabRun, writeScenario, git, seedRegistry, type Lab } from './helpers/lab.ts';
import { diagnosis, GOAL, GOOD_IMPLEMENTATION, implementer, planner, scenario, SRC_TEXT, TEST_TEXT } from './helpers/scenarios.ts';
import { assertRunInvariants } from './helpers/invariants.ts';

const GATE = 'unknot diagnose --baseline "$ORBIT_BASE_REVISION" --fail-on new:high --json';
const STATS = { detectors: 82, drafts: 1, findings: 1, open: 1, suppressed: 0, accepted: 0, by_category: { module: 1 }, duration_ms: 5, objective: null };
const REST = { stats: STATS, errors: [], analysis: { languages: [{ language: 'typescript', files: 2, ran: ['size'], missing: [] }], unavailable: [] } };
const doc = (extra: object) => ({ schema_version: '1.0', baseline: { ref: 'x', commit: 'c', findings: 1, new: 0, extraction_failures: { tree: 0, base: 0 } }, ...REST, ...extra });
const FINDING = { kind: 'module.dependency-cycle', category: 'module', severity: 'high', location: 'src/cycle-b.ts:1', title: '2 modules form an import cycle: src/server.ts -> src/cycle-b.ts -> src/server.ts', evidence: [{ ref: 'module:src/cycle-b.ts', label: 'observed', summary: 'imports src/server.ts', source_ref: 'src/cycle-b.ts:1' }] };
// A new cycle (fails under --fail-on new:high), and a clean change on a base that already has one finding.
const CYCLE_DOC = doc({ baseline: { ref: 'x', commit: 'c', findings: 1, new: 1, extraction_failures: { tree: 0, base: 0 } }, fail_on: 'new:high', failed: true, findings: [FINDING] });
const CLEAN_DOC = doc({ fail_on: 'new:high', failed: false, findings: [] });

function fakeUnknot(dir: string, version: string): string {
  mkdirSync(dir, { recursive: true });
  const log = join(dir, 'calls.log');
  writeFileSync(join(dir, 'cycle.json'), JSON.stringify(CYCLE_DOC, null, 2));
  writeFileSync(join(dir, 'clean.json'), JSON.stringify(CLEAN_DOC, null, 2));
  const script = `#!/bin/sh
if [ "$1" = "--version" ]; then echo ${version}; exit 0; fi
if [ "$1" != "diagnose" ]; then echo "unknown command $1" >&2; exit 2; fi
shift
base=""; failon=""; json=0
while [ $# -gt 0 ]; do
  case "$1" in --baseline) base="$2"; shift ;; --fail-on) failon="$2"; shift ;; --json) json=1 ;; esac
  shift
done
echo "$PWD|$(git rev-parse HEAD)|base=$base|failon=$failon|json=$json" >> '${log}'
echo '12:31PM INF 0 commits scanned.' >&2
if [ ! -d .unknot ]; then echo '{"error":{"code":"UK_NOT_INITIALIZED","message":"no .unknot directory"}}'; exit 1; fi
if [ "$json" != 1 ]; then echo 'text report'; exit 0; fi
if [ -n "$base" ] && [ "$base" != HEAD ] && ! git rev-parse --verify --quiet "$base^{commit}" >/dev/null; then
  echo '{"error":{"code":"UK_BASELINE_INVALID","message":"not a commit: '"$base"'"}}'; exit 5
fi
[ -f src/slow.ts ] && sleep 30
if [ -f src/cycle-b.ts ] && [ -n "$base" ]; then cat '${join(dir, 'cycle.json')}'; [ -n "$failon" ] && exit 1; exit 0; fi
cat '${join(dir, 'clean.json')}'
echo '12:31PM INF done }' >&2
`;
  writeFileSync(join(dir, 'unknot'), script);
  chmodSync(join(dir, 'unknot'), 0o755);
  return log;
}

const labs: Lab[] = [];
let bin: string;
let calls: string;
let pathBefore: string | undefined;
beforeEach(() => {
  bin = mkdtempSync(join(tmpdir(), 'orbit-fake-unknot-'));
  calls = fakeUnknot(bin, '0.4.0');
  pathBefore = process.env.PATH;
  process.env.PATH = `${bin}:${pathBefore}`;
});
afterEach(() => {
  process.env.PATH = pathBefore;
  rmSync(bin, { recursive: true, force: true });
  labs.splice(0).forEach((l) => l.close());
});
/** The lab commits an unknot project, as a repository that uses the gate does (`withProject` false: it does not). */
function lab(opts: { withProject?: boolean; timeout?: number } = {}): Lab {
  const l = makeLab({
    ...(opts.withProject === false ? {} : { files: { '.unknot/.gitignore': 'state/\n', '.unknot/config.yaml': 'version: 1\n' } }),
    tweak: (c) => void (c.checks = { simplicity: { ...defaultCheck('simplicity'), command: [GATE], shell: true, category: 'other', timeout_seconds: opts.timeout ?? 120 }, ...c.checks }),
  });
  labs.push(l);
  return l;
}

describe.skipIf(!READY)('acceptance: the simplicity gate (issue #232, User Story 1)', () => {
  it('scenario 1: a candidate that adds an import cycle fails the check, which names the finding; its repair passes', async () => {
    const l = lab();
    const cycle = { op: 'write' as const, path: 'src/cycle-b.ts', content: "import { handle } from './server.ts';\nexport const cycle = handle;\n" };
    writeScenario(
      l,
      scenario({
        planner: [planner({ allowed: ['src/server.ts', 'src/cycle-b.ts', 'tests/unit/**'] })],
        implementer: [implementer([SRC_TEXT, TEST_TEXT, cycle]), implementer([{ op: 'delete', path: 'src/cycle-b.ts' }])],
        verifier: [diagnosis({ evidence: 'simplicity: module.dependency-cycle src/cycle-b.ts:1', hypothesis: 'src/cycle-b.ts imports src/server.ts, which closes an import cycle', experiment: 'Run unknot diagnose --baseline HEAD^ --json on the candidate and read the new finding for src/cycle-b.ts', expected: 'a new module.dependency-cycle finding naming src/cycle-b.ts and src/server.ts', fix: 'Delete src/cycle-b.ts' })],
      }),
    );
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);
    const db = l.db();
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const [first, second] = listCandidates(db, run.id);
    const attempts = (id: string) => listCheckRuns(db, { runId: run.id, candidateId: id, checkId: 'simplicity' });
    expect(attempts(first!.id).map((r) => r.status)).toEqual(['FAILED']);
    expect(attempts(first!.id)[0]!.excerpt).toContain('simplicity gate: 1 new finding against the base (1 high-severity)');
    expect(attempts(first!.id)[0]!.excerpt).toContain('- [high] module.dependency-cycle src/cycle-b.ts:1');
    expect(attempts(first!.id)[0]!.excerpt).toContain('src/cycle-b.ts:1 imports src/server.ts');
    expect(attempts(second!.id).map((r) => r.status)).toEqual(['PASSED']);
    assertRunInvariants(l, run.id);
  }, 240_000);

  it('scenario 2: a clean change passes the check, though the base already has a finding, and the base itself ran it too', async () => {
    const l = lab();
    writeScenario(l, scenario({ implementer: [GOOD_IMPLEMENTATION()] }));
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);
    const db = l.db();

    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const [cand] = listCandidates(db, run.id);
    expect(listCheckRuns(db, { runId: run.id, candidateId: cand!.id, checkId: 'simplicity' }).map((r) => r.status)).toEqual(['PASSED']);
    expect(listCheckRuns(db, { runId: run.id, candidateId: null, checkId: 'simplicity' }).map((r) => r.status)).toEqual(['PASSED']);
    // What unknot was asked: the baseline run compared the base revision with itself (HEAD); the candidate's run, its parent.
    const asked = readFileSync(calls, 'utf8').trim().split('\n').map((line) => Object.fromEntries(line.split('|').map((kv, i) => (i < 2 ? [i === 0 ? 'cwd' : 'head', kv] : kv.split('=')))) as Record<string, string>);
    const baseline = asked.find((c) => c.base === 'HEAD');
    expect(baseline, JSON.stringify(asked)).toBeDefined();
    expect(baseline!.head).toBe(done.baseRevision);
    const onCandidate = asked.find((c) => c.base !== 'HEAD');
    expect(onCandidate).toMatchObject({ head: cand!.commitSha, base: done.baseRevision, failon: 'new:high', json: '1' });
    expect(cand!.parentSha).toBe(done.baseRevision);
    // Nothing the check wrote shows as a change in the candidate.
    expect(git(l.repo, 'ls-tree', '-r', '--name-only', cand!.commitSha).split('\n').filter((f) => f.startsWith('.unknot/'))).toEqual(['.unknot/.gitignore', '.unknot/config.yaml']);
    assertRunInvariants(l, run.id);
  }, 240_000);

  it('scenario 4: unknot not installed, or older than 0.4.0, and a run with the check configured refuses to start, with the install step', async () => {
    const l = lab();
    writeScenario(l, scenario({}));
    seedRegistry(l.db());
    const argv = ['run', '--goal', GOAL, '--detach', '--policy', l.configPath];

    const none = mkdtempSync(join(tmpdir(), 'orbit-no-unknot-'));
    const missing = await orbitOnce(l, argv, { PATH: `${none}:/usr/bin:/bin` });
    expect(missing.code).not.toBe(0);
    expect(missing.out).toContain('unknot is not installed');
    expect(missing.out).toContain('claude plugin install unknot@quintinbotes');

    fakeUnknot(none, '0.3.3');
    const old = await orbitOnce(l, argv, { PATH: `${none}:/usr/bin:/bin` });
    expect(old.code).not.toBe(0);
    expect(old.out).toContain('unknot 0.3.3 is older than 0.4.0');
    rmSync(none, { recursive: true, force: true });

    expect(listRuns(l.db(), {})).toEqual([]);
    expect(git(l.repo, 'status', '--porcelain', '--', 'src')).toBe('');
  }, 120_000);

  it('scenario 4: a repository with the check but no committed unknot project refuses to start, naming it, instead of failing every candidate', async () => {
    const l = lab({ withProject: false });
    writeScenario(l, scenario({}));
    seedRegistry(l.db());
    const r = await orbitOnce(l, ['run', '--goal', GOAL, '--detach', '--policy', l.configPath]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('no committed .unknot directory');
    expect(r.out).toContain('/unknot:init');
    expect(listRuns(l.db(), {})).toEqual([]);
  }, 120_000);

  it('edge case: a scope unknot cannot map within the check\'s timeout fails with a clear message, and the run does not succeed', async () => {
    const l = lab({ timeout: 3 });
    const slow = { op: 'write' as const, path: 'src/slow.ts', content: 'export const slow = 1;\n' };
    writeScenario(
      l,
      scenario({
        planner: [planner({ allowed: ['src/server.ts', 'src/slow.ts', 'tests/unit/**'] })],
        implementer: [implementer([SRC_TEXT, TEST_TEXT, slow]), implementer([])],
        verifier: [diagnosis({ evidence: 'simplicity: unknot did not finish mapping within 3 s', hypothesis: 'src/slow.ts makes the scope too large for unknot to map in the time', experiment: 'Run unknot diagnose --baseline HEAD^ --json on the candidate and time it', expected: 'a run longer than 3 s', fix: 'Remove src/slow.ts from the change' })],
      }),
    );
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);
    const [first] = listCandidates(l.db(), run.id);
    const [attempt] = listCheckRuns(l.db(), { runId: run.id, candidateId: first!.id, checkId: 'simplicity' });

    expect(attempt!.status).toBe('TIMEOUT');
    expect(attempt!.excerpt).toContain('simplicity gate: unknot did not finish mapping within 3 s');
    expect(attempt!.excerpt).toContain('timeout_seconds');
    expect(done.state, done.outcomeReason ?? '').not.toBe('SUCCEEDED');
  }, 300_000);
});
