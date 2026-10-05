import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isOrbitError } from '../../../src/core/errors.ts';
import { systemClock } from '../../../src/core/clock.ts';
import { NoIsolation } from '../../../src/isolation/none.ts';
import { runBaseline } from '../../../src/evidence/baseline.ts';
import { cleanupCandidateCheckout } from '../../../src/evidence/candidate.ts';
import { candidateSubject, INSTALL_CHECK_ID, resumeChecks, runChecks, runCheckSet } from '../../../src/evidence/runner.ts';
import { listCheckRuns } from '../../../src/evidence/store.ts';
import { makeRepo, makeRun, nodeCheck, tempRoot } from '../../unit/evidence/fixtures.ts';
import { checkDirOf, runnerEnv, waitFor, type RunnerEnv } from './harness.ts';

/**
 * Defects found by adversarial review of the evidence module. Each test
 * failed against the implementation as first delivered.
 */

const envs: RunnerEnv[] = [];
const cleanups: (() => void | Promise<void>)[] = [];
async function setup(checks: Parameters<typeof runnerEnv>[0], opts?: Parameters<typeof runnerEnv>[1]): Promise<RunnerEnv> {
  const e = await runnerEnv(checks, opts);
  envs.push(e);
  return e;
}
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close();
  for (const c of cleanups.splice(0)) await c();
});

const run = (e: RunnerEnv, ids: string[], extra: Record<string, unknown> = {}) => runChecks({ ...e.ctx, candidate: e.candidate, checkIds: ids, ...extra });

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

describe('fingerprints of runner results', () => {
  it('tells apart two silent failures of the same check that print different output', async () => {
    // Each execution prints a different line with no error keyword, then exits 1.
    const counter = join(tmpdir(), `orbit-evidence-counter-${Math.random().toString(36).slice(2)}`);
    cleanups.push(() => rmSync(counter, { force: true }));
    const script = `const fs=require("fs");const f=${JSON.stringify(counter)};let n=0;try{n=+fs.readFileSync(f,"utf8")}catch{}fs.writeFileSync(f,String(n+1));console.log(n===0?"wrong answer: apples":"wrong answer: oranges");process.exit(1)`;
    const e = await setup([nodeCheck('quiet', script, { flaky_reruns: 1 })]);
    await run(e, ['quiet']);
    const rows = listCheckRuns(e.run.db, { runId: e.run.runId, checkId: 'quiet' });
    expect(rows).toHaveLength(2);
    expect(readFileSync(rows[0]!.logPath!, 'utf8')).toContain('apples');
    expect(readFileSync(rows[1]!.logPath!, 'utf8')).toContain('oranges');
    expect(rows[0]!.fingerprint).not.toBe(rows[1]!.fingerprint);
  });
});

describe('the checkout must stay the candidate tree', () => {
  it('refuses to start a check after an earlier check modified a tracked file of the checkout', async () => {
    const e = await setup([
      nodeCheck('mutate', 'require("fs").writeFileSync("src/a.txt","two\\n")'),
      nodeCheck('verify', 'process.exit(require("fs").readFileSync("src/a.txt","utf8")==="two\\n"?0:1)'),
    ]);
    const err = await rejection(run(e, ['mutate', 'verify']));
    expect(isOrbitError(err, 'STALE_EVIDENCE')).toBe(true);
    expect(String((err as Error).message)).toContain('src/a.txt');
    const rows = listCheckRuns(e.run.db, { runId: e.run.runId });
    expect(rows.map((r) => [r.checkId, r.status])).toEqual([['mutate', 'PASSED']]);
  });
});

describe('artifacts', () => {
  it('does not follow a symlink a check planted in its artifacts directory', async () => {
    const e = await setup([nodeCheck('art', 'const fs=require("fs");const d=process.env.ORBIT_ARTIFACTS_DIR;fs.writeFileSync(d+"/real.txt","ok");fs.symlinkSync("/etc/hosts",d+"/hosts.txt")')]);
    const [r] = await run(e, ['art']);
    expect(r!.status).toBe('PASSED');
    const names = r!.artifacts.map((a) => a.path.split('/').at(-1));
    expect(names).toContain('real.txt');
    expect(names).not.toContain('hosts.txt');
  });
});

describe('trusted definitions and the recorded policy', () => {
  it('does not let a generated definition shadow a check of the policy snapshot', async () => {
    const e = await setup([nodeCheck('tests', 'process.exit(1)')]);
    const err = await rejection(run(e, ['tests'], { definitions: { tests: nodeCheck('tests', 'process.exit(0)') } }));
    expect(isOrbitError(err, 'POLICY_DENIED')).toBe(true);
    expect(listCheckRuns(e.run.db, { runId: e.run.runId })).toHaveLength(0);
  });

  it('checks the snapshot against the policy hash stored for the run, not only the one the caller passed', async () => {
    const e = await setup([nodeCheck('tests', '')]);
    e.run.db.run('UPDATE runs SET policy_hash = ? WHERE id = ?', 'sha256:someone-else', e.run.runId);
    const err = await rejection(run(e, ['tests']));
    expect(isOrbitError(err, 'POLICY_TAMPERED')).toBe(true);
    expect(listCheckRuns(e.run.db, { runId: e.run.runId })).toHaveLength(0);
  });
});

describe('reattaching an Orbit-generated install step', () => {
  it('collects an in-flight install on resume without the caller re-supplying its definition', async () => {
    const e = await setup([nodeCheck('tests', '')]);
    const install = nodeCheck(INSTALL_CHECK_ID, 'setTimeout(()=>console.log("installed"),800)', { mandatory: false });
    const subject = { ...candidateSubject(e.run.runDir, e.candidate), source: 'install' as const };
    const first = runCheckSet({ ...e.ctx, definitions: { [INSTALL_CHECK_ID]: install } }, subject, [install]);
    await waitFor(() => existsSync(join(checkDirOf(e, INSTALL_CHECK_ID), 'pid.json')));
    // A restarted controller knows nothing about generated definitions.
    const resumed = await resumeChecks(e.ctx);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({ checkId: INSTALL_CHECK_ID, status: 'PASSED' });
    const [original] = await first;
    expect(original!.id).toBe(resumed[0]!.id);
    expect(listCheckRuns(e.run.db, { runId: e.run.runId })).toHaveLength(1);
  });

  it('refuses a persisted generated definition that no longer matches the recorded configuration hash', async () => {
    const e = await setup([nodeCheck('tests', '')]);
    const install = nodeCheck(INSTALL_CHECK_ID, 'setTimeout(()=>{},600)', { mandatory: false });
    const subject = { ...candidateSubject(e.run.runDir, e.candidate), source: 'install' as const };
    const first = runCheckSet({ ...e.ctx, definitions: { [INSTALL_CHECK_ID]: install } }, subject, [install]);
    const defFile = join(checkDirOf(e, INSTALL_CHECK_ID), 'definition.json');
    await waitFor(() => existsSync(join(checkDirOf(e, INSTALL_CHECK_ID), 'pid.json')));
    expect(existsSync(defFile)).toBe(true);
    writeFileSync(defFile, JSON.stringify({ ...install, command: ['node', '-e', 'console.log("swapped")'] }));
    const err = await rejection(resumeChecks(e.ctx));
    expect(isOrbitError(err, 'POLICY_TAMPERED')).toBe(true);
    await first;
  });
});

describe('cleanupCandidateCheckout', () => {
  it('never deletes the main working tree of the repository', async () => {
    const t = tempRoot();
    cleanups.push(t.remove);
    const r = makeRepo(t.root);
    const err = await rejection(cleanupCandidateCheckout(r.repo, r.repo));
    expect(isOrbitError(err)).toBe(true);
    expect(existsSync(join(r.repo, 'README.md'))).toBe(true);
    expect(existsSync(join(r.repo, '.git'))).toBe(true);
  });

  it('never deletes a directory that contains the repository', async () => {
    const t = tempRoot();
    cleanups.push(t.remove);
    const r = makeRepo(t.root);
    await expect(cleanupCandidateCheckout(r.repo, t.root)).rejects.toThrow();
    expect(existsSync(join(r.repo, 'README.md'))).toBe(true);
  });

  it('is not a way for runBaseline to delete the repository through checkoutDir', async () => {
    const t = tempRoot();
    cleanups.push(t.remove);
    const r = makeRepo(t.root);
    const runRec = makeRun(t.root, r.repo, [nodeCheck('a', '')]);
    cleanups.push(() => runRec.db.close());
    await expect(
      runBaseline({ db: runRec.db, run: { id: runRec.runId, policyHash: runRec.policyHash }, repoRoot: r.repo, baseRev: r.base, snapshot: runRec.snapshot, isolation: new NoIsolation(), runDir: runRec.runDir, clock: systemClock, pollMs: 20, checkoutDir: r.repo }),
    ).rejects.toThrow();
    expect(existsSync(join(r.repo, 'README.md'))).toBe(true);
  });
});

describe('baseline reuse', () => {
  it('does not reuse a complete baseline that covered fewer checks than now requested', async () => {
    const t = tempRoot();
    cleanups.push(t.remove);
    const r = makeRepo(t.root);
    const runRec = makeRun(t.root, r.repo, [nodeCheck('a', ''), nodeCheck('b', 'console.error("Error: b broken"); process.exit(1)')]);
    cleanups.push(() => runRec.db.close());
    const input = { db: runRec.db, run: { id: runRec.runId, policyHash: runRec.policyHash }, repoRoot: r.repo, baseRev: r.base, snapshot: runRec.snapshot, isolation: new NoIsolation(), runDir: runRec.runDir, clock: systemClock, pollMs: 20, killGraceMs: 500, homeDir: join(t.root, 'home') };
    const first = await runBaseline({ ...input, checkIds: ['a'] });
    expect(first.report.complete).toBe(true);
    const second = await runBaseline({ ...input, checkIds: ['a', 'b'] });
    expect(second.reused).toBe(false);
    expect(second.report.checks.map((c) => c.checkId).sort()).toEqual(['a', 'b']);
    expect(second.report.failures.map((f) => f.checkId)).toEqual(['b']);
    // The same set again is reused.
    expect((await runBaseline({ ...input, checkIds: ['b', 'a'] })).reused).toBe(true);
  });
});

