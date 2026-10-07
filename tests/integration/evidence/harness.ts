import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ManualClock, systemClock, type Clock } from '../../../src/core/clock.ts';
import { NoIsolation } from '../../../src/isolation/none.ts';
import type { IsolationProvider, SandboxProfile } from '../../../src/isolation/types.ts';
import { cleanupCandidateCheckout, materializeCandidate, snapshotCandidate } from '../../../src/evidence/candidate.ts';
import type { RunnerContext } from '../../../src/evidence/runner.ts';
import type { CandidateRecord } from '../../../src/evidence/store.ts';
import { which } from '../../../src/isolation/util.ts';
import { addWorktree, makeRepo, makeRun, tempRoot, type TestRepo, type TestRun } from '../../unit/evidence/fixtures.ts';
import type { CheckDefinition } from '../../../src/policy/types.ts';

export interface RunnerEnv {
  t: ReturnType<typeof tempRoot>;
  r: TestRepo;
  run: TestRun;
  candidate: CandidateRecord;
  checkoutDir: string;
  ctx: RunnerContext;
  close(): Promise<void>;
}

/**
 * A repo, a candidate snapshotted from a worktree, a writable checkout of it, and a ready RunnerContext. `checkoutAt`
 * places the checkout (from the temp root), as a run's sits in <orbit home>/worktrees/<key>/<run>/; the default is
 * `<root>/checkout`, with nothing read-denied above it.
 */
export async function runnerEnv(checks: CheckDefinition[], opts: { clock?: Clock; isolation?: IsolationProvider; files?: Record<string, string>; checkoutAt?: (root: string) => string } = {}): Promise<RunnerEnv> {
  const t = tempRoot();
  const r = makeRepo(t.root, opts.files);
  const clock = opts.clock ?? systemClock;
  const run = makeRun(t.root, r.repo, checks, { clock });
  const wt = addWorktree(r.repo, join(t.root, 'wt', 'w1'));
  const candidate = await snapshotCandidate({ db: run.db, clock: clock instanceof ManualClock ? clock : systemClock, repoRoot: r.repo, worktree: wt, runId: run.runId, baseRev: r.base, attempt: 1, workerId: 'w1' });
  const checkoutDir = await materializeCandidate(r.repo, candidate.commitSha, opts.checkoutAt ? opts.checkoutAt(t.root) : join(t.root, 'checkout'), { readOnly: false });
  const ctx: RunnerContext = {
    db: run.db,
    run: { id: run.runId, policyHash: run.policyHash },
    snapshot: run.snapshot,
    isolation: opts.isolation ?? new NoIsolation(),
    checkoutDir,
    runDir: run.runDir,
    clock,
    pollMs: 20,
    killGraceMs: 500,
    homeDir: join(t.root, 'home'),
  };
  return {
    t,
    r,
    run,
    candidate,
    checkoutDir,
    ctx,
    async close() {
      run.db.close();
      await cleanupCandidateCheckout(r.repo, checkoutDir).catch(() => {});
      t.remove();
    },
  };
}

export async function waitFor(pred: () => boolean, timeoutMs = 15_000, stepMs = 25): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

export function pidGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

/** Where a check's detached-process files live for a candidate. */
export function checkDirOf(env: RunnerEnv, checkId: string, attempt = 0): string {
  return join(env.run.runDir, 'evidence', String(env.candidate.seq), attempt === 0 ? checkId : `${checkId}~${attempt}`);
}

/** NoIsolation that remembers every profile it was asked to wrap, to assert what the runner asked the provider to enforce. */
export function recordingIsolation(): IsolationProvider & { profiles: SandboxProfile[] } {
  const inner = new NoIsolation();
  const profiles: SandboxProfile[] = [];
  return {
    kind: inner.kind,
    profiles,
    available: () => inner.available(),
    wrap: (argv, profile, opts) => (profiles.push(profile), inner.wrap(argv, profile, opts)),
  };
}

/** A tool of the host for a test that runs it for real: its path, or why the test counts it as not installed. */
export type HostTool = { path: string; absent: null } | { path: null; absent: string };

/**
 * A tool the host has: found on PATH (or at a fallback) and starting there with `args`, outside any sandbox. Being on
 * PATH is not enough: every Mac has /usr/bin/java, a stub that only starts a JDK installed elsewhere, and rustup's
 * cargo is a proxy that cannot run where rustup has no default toolchain.
 */
export function hostTool(name: string, args: string[], ...fallbacks: string[]): HostTool {
  const found = which(name, process.env.PATH) ?? fallbacks.find((p) => existsSync(p)) ?? null;
  if (found === null) return { path: null, absent: `${name} is not installed` };
  if (spawnSync(found, args, { stdio: 'ignore', timeout: 60_000 }).status === 0) return { path: found, absent: null };
  return { path: null, absent: `${name} is not installed: "${found} ${args.join(' ')}" fails outside the sandbox` };
}

/**
 * The host's rustup installation: RUSTUP_HOME, else ~/.rustup of the real home. A cargo that is a rustup proxy (a link
 * to rustup in ~/.cargo/bin, as on GitHub's runners) finds its toolchains only there. The runner looks for it under the
 * run's home, which in these tests is a scratch directory (runnerEnv), so a test that runs cargo passes it in
 * RUSTUP_HOME, as a host that sets the variable would. Null where there is none (Homebrew's cargo is not a proxy and
 * needs none).
 */
export const hostRustupHome: string | null = process.env.RUSTUP_HOME?.trim() || (existsSync(join(homedir(), '.rustup')) ? join(homedir(), '.rustup') : null);
