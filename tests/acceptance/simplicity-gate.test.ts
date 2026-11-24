/**
 * Issue #232, User Story 1: a candidate cannot quietly add new tangles. The lab's policy gets a `simplicity` check that
 * runs `unknot diagnose --baseline "$ORBIT_BASE_REVISION" --fail-on new:high --json`. Unknot is faked at the process
 * boundary (a script named `unknot` first on PATH): it fails with a new import-cycle finding when the checkout holds
 * src/cycle-b.ts, and exits 5 when it is not given the candidate's parent (HEAD on the base revision) to compare with.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultCheck } from '../../src/policy/config.ts';
import { listRuns } from '../../src/controller/run-store.ts';
import { listCandidates, listCheckRuns } from '../../src/evidence/store.ts';
import { drive, makeLab, orbitOnce, READY, startLabRun, writeScenario, git, seedRegistry, type Lab } from './helpers/lab.ts';
import { diagnosis, GOAL, GOOD_IMPLEMENTATION, implementer, planner, scenario, SRC_TEXT, TEST_TEXT } from './helpers/scenarios.ts';
import { assertRunInvariants } from './helpers/invariants.ts';

const GATE = 'unknot diagnose --baseline "$ORBIT_BASE_REVISION" --fail-on new:high --json';
const CYCLE_DOC = {
  schema_version: '1.0',
  baseline: { ref: 'x', findings: 1, new: 1, extraction_failures: { tree: 0, base: 0 } },
  findings: [{ kind: 'module.dependency-cycle', severity: 'high', location: 'src/cycle-b.ts:1', title: '2 modules form an import cycle: src/server.ts -> src/cycle-b.ts -> src/server.ts', evidence: [{ summary: 'imports src/server.ts', source_ref: 'src/cycle-b.ts:1' }] }],
};
// The base already has one finding; the candidate adds none.
const CLEAN_DOC = { schema_version: '1.0', baseline: { ref: 'x', findings: 1, new: 0, extraction_failures: { tree: 0, base: 0 } }, findings: [] };

function fakeUnknot(dir: string, version: string): void {
  mkdirSync(dir, { recursive: true });
  const script = `#!/bin/sh
if [ "$1" = "--version" ]; then echo ${version}; exit 0; fi
base=""
while [ $# -gt 0 ]; do [ "$1" = "--baseline" ] && base="$2"; shift; done
if [ "$base" != "HEAD" ] && ! git rev-parse --verify --quiet "$base^{commit}" >/dev/null; then
  echo '{"error":{"code":"UK_BASELINE_INVALID","message":"not a commit: '"$base"'"}}'; exit 5
fi
if [ -f src/cycle-b.ts ]; then cat <<'JSON'
${JSON.stringify(CYCLE_DOC)}
JSON
exit 1; fi
cat <<'JSON'
${JSON.stringify(CLEAN_DOC)}
JSON
`;
  writeFileSync(join(dir, 'unknot'), script);
  chmodSync(join(dir, 'unknot'), 0o755);
}

const labs: Lab[] = [];
let bin: string;
let pathBefore: string | undefined;
beforeEach(() => {
  bin = mkdtempSync(join(tmpdir(), 'orbit-fake-unknot-'));
  fakeUnknot(bin, '0.4.0');
  pathBefore = process.env.PATH;
  process.env.PATH = `${bin}:${pathBefore}`;
});
afterEach(() => {
  process.env.PATH = pathBefore;
  rmSync(bin, { recursive: true, force: true });
  labs.splice(0).forEach((l) => l.close());
});
function lab(): Lab {
  const l = makeLab({ tweak: (c) => void (c.checks = { simplicity: { ...defaultCheck('simplicity'), command: [GATE], shell: true, category: 'other', timeout_seconds: 120 }, ...c.checks }) });
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
    expect(attempts(first!.id)[0]!.excerpt).toContain('simplicity gate: 1 new high-severity finding');
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
});
