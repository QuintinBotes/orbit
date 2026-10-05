// Fault: cancellation during checks (spec sections 6, 17; mandatory scenario 20). A check is running
// (with a grandchild in its process group) when `orbit cancel` is issued. The whole group is killed,
// the run ends CANCELLED, and a restarted controller neither resumes it nor starts anything for it.
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { listCheckRuns } from '../../src/evidence/store.ts';
import { listWorkers } from '../../src/storage/workers.ts';
import { alive, baseScenario, canStripTypes, events, exited, implementMul, ORBIT_ROOT, runState, spawnFaultyController, startLabRun, tracker, transitions, waitFor, writeScenario } from './helpers.ts';

const t = tracker();
const dirs: string[] = [];
afterEach(() => {
  t.cleanup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The lab's test runner, plus: when slow.flag exists, a grandchild sleep in the same process group, its pid written to pidFile. */
function slowRunner(pidFile: string): string {
  return [
    "import { existsSync, readdirSync, writeFileSync } from 'node:fs';",
    "import { spawn } from 'node:child_process';",
    "const here = new URL('.', import.meta.url);",
    "if (existsSync(new URL('slow.flag', here))) {",
    "  const g = spawn('/bin/sleep', ['600'], { stdio: 'ignore' });",
    `  writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));`,
    '  await new Promise((r) => setTimeout(r, 60_000));',
    '}',
    "for (const f of readdirSync(here).filter((n) => n.endsWith('.test.mjs')).sort()) await import(new URL(f, here));",
    "console.log('all tests passed');",
    '',
  ].join('\n');
}

function orbitCli(lab: { repo: string; base: string; orbitHome: string }, args: string[]): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings', join(ORBIT_ROOT, 'src', 'cli', 'main.ts'), ...args], {
    cwd: lab.repo,
    encoding: 'utf8',
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: lab.base, ORBIT_HOME: lab.orbitHome, LANG: 'C' },
    timeout: 30_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe.skipIf(!canStripTypes)('fault: cancellation during checks', () => {
  it('orbit cancel during a long check kills the check process group, ends the run CANCELLED, and the outcome survives a controller restart', async () => {
    const pidDir = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-fi-pid-')));
    dirs.push(pidDir);
    const pidFile = join(pidDir, 'grandchild.pid');
    const l = t.lab({ files: { 'tests/run.mjs': slowRunner(pidFile) } });
    writeScenario(l, baseScenario({ implementer: [implementMul('*', [{ op: 'write', path: 'tests/slow.flag', content: '1\n' }])] }));
    const run = startLabRun(l);
    const a = t.child(spawnFaultyController(l, { mode: 'service', leaseTtlMs: 1_500 }));
    const check = await waitFor(() => listCheckRuns(l.db(), { runId: run.id }).find((r) => r.candidateId !== null && r.status === 'RUNNING' && r.pid !== null), 30_000);
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '', 15_000);
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    t.group(check.pid);
    expect(alive(grandchild)).toBe(true);

    const cancel = orbitCli(l, ['cancel', run.id]);
    expect(cancel.code, cancel.out).toBe(0);
    await waitFor(() => runState(l, run.id).state === 'CANCELLED', 20_000);
    // The whole process group went: the check and the grandchild it started.
    await waitFor(() => !alive(check.pid!) && !alive(grandchild), 10_000);
    expect(listCheckRuns(l.db(), { runId: run.id, checkId: 'unit' }).filter((r) => r.candidateId !== null).at(-1)?.status).toBe('CANCELLED');
    expect(listWorkers(l.db(), { runId: run.id, role: 'reviewer' })).toEqual([]);
    a.kill('SIGKILL');
    await exited(a);

    // A fresh controller: the cancellation is durable, nothing restarts.
    const before = { workers: listWorkers(l.db(), { runId: run.id }).length, checks: listCheckRuns(l.db(), { runId: run.id }).length, transitions: transitions(l, run.id) };
    const b = t.child(spawnFaultyController(l, { mode: 'service', leaseTtlMs: 1_500 }));
    await new Promise((r) => setTimeout(r, 2_500));
    b.kill('SIGTERM');
    await exited(b);
    expect(runState(l, run.id).state).toBe('CANCELLED');
    expect(listWorkers(l.db(), { runId: run.id })).toHaveLength(before.workers);
    expect(listCheckRuns(l.db(), { runId: run.id })).toHaveLength(before.checks);
    expect(transitions(l, run.id)).toEqual(before.transitions);
    expect(events(l, run.id, 'run.cancel-requested')).toHaveLength(1);
    expect(transitions(l, run.id).at(-1)).toBe('VERIFYING>CANCELLED');
  }, 60_000);
});
