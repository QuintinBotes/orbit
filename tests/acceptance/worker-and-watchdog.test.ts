/**
 * Issue #166, FR-002: a worker that can build in its own sandbox tier (issue #140) and a watchdog that tells a long
 * baseline from a stalled run (issue #141). Both drive the real controller in the lab: the first reads what a Claude
 * worker was actually started with, the second runs the service-mode watchdog against a slow check of the base revision.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Controller } from '../../src/controller/loop.ts';
import { isTerminal } from '../../src/controller/states.ts';
import { systemClock } from '../../src/core/clock.ts';
import { listCheckRuns } from '../../src/evidence/store.ts';
import { watchdogTick, type WatchdogFinding } from '../../src/recovery/watchdog.ts';
import { drive, FAKE_CLAUDE, labDeps, makeLab, READY, runState, startLabRun, waitFor, writeScenario, type Lab, type LabOptions } from './helpers/lab.ts';
import { GOAL, GOOD_IMPLEMENTATION, planner, scenario } from './helpers/scenarios.ts';
import { events, transitions } from './helpers/invariants.ts';

const labs: Lab[] = [];
afterEach(() => labs.splice(0).forEach((l) => l.close()));
function lab(opts: LabOptions = {}): Lab {
  const l = makeLab(opts);
  labs.push(l);
  return l;
}

interface WorkerStart {
  cwd: string;
  tmp: string | null;
  target: string | null;
  built: string | null;
  settings: { sandbox?: { enabled?: boolean; filesystem?: { allowWrite?: string[] } }; permissions?: { deny?: string[] } } | null;
}

/**
 * A `claude` that records what it was started with, then behaves as the fake CLI. Where the worker has a Cargo target
 * directory it writes build state into it the way `cargo build` does first, and records whether that worked.
 */
function recordingClaude(path: string, log: string): void {
  writeFileSync(
    path,
    `#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const argv = process.argv.slice(2);
const at = argv.indexOf('--settings');
if (at >= 0) {
  const target = process.env.CARGO_TARGET_DIR ?? null;
  let built = null;
  if (target) {
    try {
      mkdirSync(join(target, 'debug'), { recursive: true });
      writeFileSync(join(target, 'debug', '.cargo-lock'), '');
      built = 'ok';
    } catch (err) {
      built = String(err);
    }
  }
  let settings = null;
  try {
    settings = JSON.parse(readFileSync(argv[at + 1], 'utf8'));
  } catch {}
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), tmp: process.env.TMPDIR ?? null, target, built, settings }) + '\\n');
}
await import(${JSON.stringify(FAKE_CLAUDE)});
`,
    { mode: 0o755 },
  );
}

describe.skipIf(!READY)('acceptance: workers and the watchdog (issue #166, FR-002)', () => {
  it('issue #140: a Claude worker in the claude-sandbox tier gets Rust build state it may write: in its private temp directory, not in its worker directory', async () => {
    // Given a Rust workspace and workers in the claude-sandbox tier (no exported credential, as the lab's adapters run).
    const l = lab({ files: { 'Cargo.toml': '[workspace]\nmembers = []\n' } });
    const log = join(l.base, 'worker-starts.jsonl');
    // Named as the fake CLI is, so the lab's adapter treats it as one (adapters/fake.ts tells a fake by its file name).
    mkdirSync(join(l.base, 'recording'));
    const claude = join(l.base, 'recording', 'fake-claude.mjs');
    recordingClaude(claude, log);
    l.config.providers.claude!.command = claude;
    writeFileSync(l.configPath, JSON.stringify(l.config));
    writeScenario(l, scenario({ implementer: [GOOD_IMPLEMENTATION()] }));

    // When a run implements a change.
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');

    // Then every worker that got a Cargo target directory can write it with Bash in that tier: it lies in the worker's
    // own temp directory, the sandbox block of its settings allows writing there, and no Edit deny (which the sandbox
    // turns into a write denial) covers it.
    const starts = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as WorkerStart);
    const rust = starts.filter((s) => s.target !== null);
    expect(rust.length).toBeGreaterThan(0);
    // The implementer, which works in the run's worktree, is among them.
    expect(rust.some((s) => s.cwd.startsWith(join(l.orbitHome, 'worktrees')))).toBe(true);
    for (const s of rust) {
      const target = s.target!;
      expect(s.built, target).toBe('ok');
      expect(s.tmp).not.toBeNull();
      expect(target.startsWith(`${s.tmp}/`), `${target} is not under the worker's temp directory ${s.tmp}`).toBe(true);
      expect(s.settings?.sandbox?.enabled).toBe(true);
      const allowWrite = s.settings!.sandbox!.filesystem!.allowWrite ?? [];
      expect(allowWrite.some((p) => target === p || target.startsWith(`${p}/`)), `sandbox allowWrite ${JSON.stringify(allowWrite)} does not cover ${target}`).toBe(true);
      const editDenies = (s.settings!.permissions?.deny ?? []).filter((r) => r.startsWith('Edit(')).map((r) => r.slice('Edit(/'.length, -1).replace(/\/\*\*$/, ''));
      expect(editDenies.filter((p) => target === p || target.startsWith(`${p}/`))).toEqual([]);
    }
    // Each worker has build state of its own.
    expect(new Set(rust.map((s) => s.target)).size).toBe(rust.length);
  }, 180_000);

  it('issue #141: a baseline whose check runs longer than the stall limit, and keeps printing, is neither reported stalled nor abandoned', async () => {
    // Given a mandatory check that takes about 14 s on the base revision and prints as it goes, and a watchdog that
    // calls a run stalled after 5 s without activity and abandons a PREFLIGHT step after 8 s (10 and 15 min by default).
    const slow = "let n = 0; const t = setInterval(() => { console.log('Compiling crate ' + n); if (++n >= 70) { clearInterval(t); } }, 200);";
    const l = lab({
      tweak: (c) => {
        c.checks.lint = { ...c.checks.lint!, command: ['node', '-e', ''] };
        c.checks.unit = { ...c.checks.unit!, command: ['node', '-e', ''] };
        c.checks.build = { ...c.checks.lint!, id: 'build', category: 'build', command: ['node', '-e', slow], mandatory: true };
      },
    });
    // The planner leaves a material question open, so the run ends BLOCKED right after PREFLIGHT with no worker left running.
    const open = { question: 'Should unknown /api paths answer JSON?', options: ['yes', 'no'], recommendation: null, material: true, affected_criteria: ['text'] };
    writeScenario(l, scenario({ planner: [planner({ decisions: [open] })], implementer: [GOOD_IMPLEMENTATION()] }));
    const run = startLabRun(l, GOAL);

    // When a service controller drives the run through PREFLIGHT, and its watchdog looks at the run while the check
    // has been running for 5.5 to 11 s. The passes are made here, with the controller's own identity and the function
    // its timer calls, so that each one is known to fall while the check is still running.
    const deps = labDeps(l);
    const c = new Controller({ mode: 'service', deps, maxRuns: 1, tickIntervalMs: 50, leaseTtlMs: 30_000, leaseRenewMs: 1_000, graceMs: 300, watchdogMs: 0 });
    const started = c.start();
    const db = l.db();
    const findings: WatchdogFinding[] = [];
    let passes = 0;
    try {
      const startedAt = await waitFor(() => listCheckRuns(db, { runId: run.id, candidateId: null, checkId: 'build', rootsOnly: true }).find((r) => r.status === 'RUNNING')?.startedAt, 60_000, 50);
      while (Date.now() - startedAt < 11_000) {
        if (Date.now() - startedAt >= 5_500) {
          const report = await watchdogTick({ db, clock: systemClock, ownerId: c.ownerId, adapters: deps.adapters, orbitHome: l.orbitHome, config: { stallMs: 5_000, stepTimeoutMs: { PREFLIGHT: 8_000 }, graceMs: 300 } });
          findings.push(...report.findings);
          passes += 1;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      await waitFor(() => isTerminal(runState(l, run.id).state), 120_000, 100);
    } finally {
      await c.stop('scenario over');
      await started;
    }

    // Then no pass reported a stall or abandoned the step, and the baseline ran to its end with the slow check passed.
    expect(passes).toBeGreaterThanOrEqual(5);
    expect(findings).toEqual([]);
    const path = transitions(db, run.id);
    expect(path, runState(l, run.id).outcomeReason ?? '').not.toContain('RECOVERING');
    expect(path).toContain('CONTRACTING');
    expect(events(db, run.id, 'watchdog.stall')).toEqual([]);
    const build = listCheckRuns(db, { runId: run.id, candidateId: null, checkId: 'build', rootsOnly: true });
    expect(build.map((r) => r.status)).toEqual(['PASSED']);
    expect((build[0]!.endedAt ?? 0) - (build[0]!.startedAt ?? 0)).toBeGreaterThan(8_000);
    expect(existsSync(join(l.runDir(run.id), 'baseline'))).toBe(true);
  }, 180_000);
});
