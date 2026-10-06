/** `orbit repair` over recorded evidence, and the lease renewal of `orbit release resolve`. */
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { systemClock } from '../../../src/core/clock.ts';
import { defaultConfig } from '../../../src/policy/config.ts';
import type { OrbitConfig } from '../../../src/policy/types.ts';
import { startRun } from '../../../src/controller/start.ts';
import { ATTEMPT_EVENT } from '../../../src/controller/steps/implementing.ts';
import { getRun, setPaused } from '../../../src/controller/run-store.ts';
import { finalizeCandidate, insertEvidenceReport, recordFailure, reserveCandidate } from '../../../src/evidence/store.ts';
import type { EvidenceReport } from '../../../src/evidence/types.ts';
import { ActionLedger } from '../../../src/delivery/actions.ts';
import { appendEvent } from '../../../src/storage/events.ts';
import { registerController } from '../../../src/storage/controllers.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { defineCheck, makeLab, type Lab } from './lab.ts';

const hooks = vi.hoisted(() => ({ fake: false, ctor: [] as Array<Record<string, unknown>>, intervals: [] as Array<() => void> }));
vi.mock('../../../src/controller/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/controller/index.ts')>();
  class Fake {
    constructor(opts: Record<string, unknown>) {
      hooks.ctor.push(opts);
    }
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
  }
  const Wrapper = function (this: unknown, opts: ConstructorParameters<typeof actual.Controller>[0]) {
    return hooks.fake ? new Fake(opts as never) : new actual.Controller(opts);
  } as unknown as typeof actual.Controller;
  return { ...actual, Controller: Wrapper };
});

const labs: Lab[] = [];
const lab = () => {
  const l = makeLab();
  labs.push(l);
  return l;
};
beforeEach(() => {
  hooks.fake = false;
  hooks.ctor = [];
  hooks.intervals = [];
});
afterEach(() => {
  vi.restoreAllMocks();
  labs.splice(0).forEach((l) => l.close());
});

const TREE = 'b'.repeat(40);
function evidence(runId: string, verdict: EvidenceReport['verdict']): EvidenceReport {
  return { task_id: 't', run_id: runId, attempt: 1, candidate_revision: 'a'.repeat(40), tree_hash: TREE, check_config_hash: 'c', policy_hash: 'd', scope: {} as never, checks: [], ui: [], acceptance_evidence: [], verdict, unverified: [] };
}

/** A BLOCKED (or paused) run with a ready candidate and a stored evidence report. */
function failedRun(l: Lab, opts: { verdict?: EvidenceReport['verdict']; state?: 'BLOCKED' | 'PREFLIGHT'; paused?: boolean; failures?: Array<{ source: 'check' | 'flaky_check'; fingerprint: string }> } = {}) {
  const run = l.newRun();
  l.moveTo(run.id, opts.state === 'PREFLIGHT' ? ['PREFLIGHT'] : ['PREFLIGHT', 'BLOCKED']);
  const cand = reserveCandidate(l.db(), { runId: run.id, attempt: 1, workerId: null, treeHash: TREE, parentSha: 'c'.repeat(40) }, systemClock);
  finalizeCandidate(l.db(), cand.id, 'a'.repeat(40), { files: 1, insertions: 1, deletions: 0 } as never, systemClock);
  const report = insertEvidenceReport(l.db(), { candidateId: cand.id, report: evidence(run.id, opts.verdict ?? 'FAIL'), reportPath: null }, systemClock);
  (opts.failures ?? []).forEach((f, i) => recordFailure(l.db(), { runId: run.id, candidateId: cand.id, source: f.source, sourceId: `src-${i}`, fingerprint: f.fingerprint, excerpt: null }, systemClock));
  if (opts.paused) setPaused(l.db(), run.id, true, 'test', systemClock);
  return { run, cand, report };
}

describe('orbit repair <run-id>', () => {
  it('moves a blocked run to DIAGNOSING for its first non-flaky failure and says where the controller writes the brief', async () => {
    const l = lab();
    const { run, report } = failedRun(l, { failures: [{ source: 'flaky_check', fingerprint: 'fp:flaky' }, { source: 'check', fingerprint: 'fp:primary' }] });
    const r = await l.cli(['repair', run.id]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe(
      [
        `run ${run.id}: moved to DIAGNOSING to repair fp:primary (candidate 1, evidence ${report.id})`,
        `The controller writes the repair brief to .orbit/runs/${run.id}/briefs/attempt-1.json.`,
        `No controller is running. Start one with "orbit service run", or drive this run here with: orbit resume ${run.id} --foreground`,
        '',
      ].join('\n'),
    );
    expect(getRun(l.db(), run.id)).toMatchObject({ state: 'DIAGNOSING', paused: false });
    const ev = l.db().get<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'run.repair-requested'", run.id);
    expect(JSON.parse(ev!.data_json)).toMatchObject({ from: 'BLOCKED', fingerprint: 'fp:primary', report_id: report.id });
  });

  it('falls back to a flaky failure, then to the verdict itself, for the fingerprint it repairs', async () => {
    const l = lab();
    const flaky = failedRun(l, { failures: [{ source: 'flaky_check', fingerprint: 'fp:only-flaky' }] });
    expect((await l.cli(['repair', flaky.run.id])).out).toContain('to repair fp:only-flaky (candidate 1');
    const none = failedRun(l, {});
    expect((await l.cli(['repair', none.run.id])).out).toContain(`to repair verdict:${none.cand.id} (candidate 1`);
  });

  it('numbers the brief after the attempts already made, and stays quiet about the controller when a service runs', async () => {
    const l = lab();
    const { run } = failedRun(l, { paused: true });
    appendEvent(l.db(), run.id, ATTEMPT_EVENT, 'controller', { attempt: 3 }, Date.now());
    appendEvent(l.db(), run.id, ATTEMPT_EVENT, 'controller', { attempt: 2 }, Date.now());
    registerController(l.db(), { id: 'svc-1', pid: process.pid, host: hostname(), mode: 'service' }, systemClock);
    const r = await l.cli(['repair', run.id]);
    expect(r.out).toContain(`.orbit/runs/${run.id}/briefs/attempt-4.json.\n`);
    expect(r.out).not.toContain('No controller is running');
    expect(getRun(l.db(), run.id).paused).toBe(false);
  });

  it('with --json reports the brief path, the candidate and whether a service is running', async () => {
    const l = lab();
    const { run } = failedRun(l, { failures: [{ source: 'check', fingerprint: 'fp:one' }] });
    registerController(l.db(), { id: 'svc-1', pid: process.pid, host: hostname(), mode: 'service' }, systemClock);
    const r = await l.cli(['repair', run.id, '--json']);
    expect(JSON.parse(r.out)).toEqual({ run_id: run.id, state: 'DIAGNOSING', fingerprint: 'fp:one', brief_path: `.orbit/runs/${run.id}/briefs/attempt-1.json`, candidate_seq: 1, service_running: true });
  });

  it('only unpauses a paused run that is already DIAGNOSING', async () => {
    const l = lab();
    const { run } = failedRun(l, { paused: true });
    l.db().run("UPDATE runs SET state = 'DIAGNOSING' WHERE id = ?", run.id);
    const r = await l.cli(['repair', run.id]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('moved to DIAGNOSING to repair');
    expect(getRun(l.db(), run.id)).toMatchObject({ state: 'DIAGNOSING', paused: false });
    expect(l.db().get("SELECT 1 FROM events WHERE run_id = ? AND type = 'run.repair-requested'", run.id)).toBeUndefined();
  });

  it('refuses a run with a cancellation request, evidence that is not FAIL, a stage that cannot diagnose, or open material questions', async () => {
    const l = lab();
    const cancelled = failedRun(l);
    l.db().run('UPDATE runs SET cancel_requested = 1 WHERE id = ?', cancelled.run.id);
    const a = await l.cli(['repair', cancelled.run.id]);
    expect(a.code).toBe(5);
    expect(a.err).toContain('has a durable cancellation request and will end CANCELLED; it cannot be repaired');

    for (const verdict of ['PASS', 'INCOMPLETE'] as const) {
      const ok = failedRun(l, { verdict });
      const r = await l.cli(['repair', ok.run.id]);
      expect(r.code).toBe(5);
      expect(r.err).toContain(`(candidate 1) is ${verdict}, not FAIL, so there is no failure to repair.`);
      expect(getRun(l.db(), ok.run.id).state).toBe('BLOCKED');
    }

    const early = failedRun(l, { state: 'PREFLIGHT', paused: true });
    l.db().run("UPDATE runs SET state = 'CREATED' WHERE id = ?", early.run.id);
    const b = await l.cli(['repair', early.run.id]);
    expect(b.code).toBe(5);
    expect(b.err).toContain(`run ${early.run.id} is CREATED, which cannot move to DIAGNOSING`);

    const asked = failedRun(l);
    l.ask(asked.run.id, { id: 'q-material' });
    l.ask(asked.run.id, { id: 'q-minor', material: false });
    const c = await l.cli(['repair', asked.run.id]);
    expect(c.code).toBe(5);
    expect(c.err).toContain(`still has 1 material question(s) open (q-material); answer them with "orbit decide ${asked.run.id} <question-id> <answer>" before`);
    expect(getRun(l.db(), asked.run.id).state).toBe('BLOCKED');
  });

  it('drives the repair in the foreground, saying what it repairs, with or without JSON', async () => {
    const l = lab();
    await l.cli(['init']);
    const { run } = failedRun(l, { failures: [{ source: 'check', fingerprint: 'fp:fg' }] });
    hooks.fake = true;
    const seams = { pollMs: 5, controllerDeps: () => ({}) as never, signals: new EventEmitter() };
    const text = await l.cli(['repair', run.id, '--foreground', '--policy', '.orbit/config.yaml'], { seams });
    expect(text.out).toContain(`run ${run.id}: repairing failure fp:fg; the controller writes the brief to .orbit/runs/${run.id}/briefs/attempt-1.json. Driving it in the foreground (Ctrl-C pauses it)\n`);
    expect(text.code).toBe(1);
    expect(hooks.ctor).toHaveLength(1);

    const again = failedRun(l, { failures: [{ source: 'check', fingerprint: 'fp:fg2' }] });
    const json = await l.cli(['repair', again.run.id, '--foreground', '--json'], { seams: { ...seams, signals: new EventEmitter() } });
    expect(json.out).not.toContain('repairing failure');
    expect(json.out.trim().split('\n').map((x) => JSON.parse(x) as { type: string }).at(-1)).toMatchObject({ type: 'result', run_id: again.run.id });
  });
});

describe('orbit repair <description>', () => {
  it('forwards the options to a new run whose goal is "Repair: <text>"', async () => {
    const l = lab();
    await l.cli(['init']);
    defineCheck(l);
    const r = await l.cli(['repair', 'login', 'fails', 'for', 'new', 'users', '--detach', '--json', '--mode', 'autonomous-delivery', '--repo', l.repo, '--policy', '.orbit/config.yaml']);
    expect(r.code, r.err).toBe(0);
    const { run_id, mode } = JSON.parse(r.out) as { run_id: string; mode: string };
    expect(mode).toBe('autonomous-delivery');
    expect(getRun(l.db(), run_id).goal).toBe('Repair: login fails for new users');
    // The mode really is passed on: a bad one is rejected by `run`, not by repair.
    const bad = await l.cli(['repair', 'login', 'fails', '--mode', 'bogus']);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('--mode must be one of');
  });

  it('treats text that merely resembles a run id as a description only when it is not one', async () => {
    const l = lab();
    await l.cli(['init']);
    defineCheck(l);
    const r = await l.cli(['repair', 'orbit', 'is', 'slow', '--detach', '--json']);
    expect(getRun(l.db(), (JSON.parse(r.out) as { run_id: string }).run_id).goal).toBe('Repair: orbit is slow');
    const mixed = await l.cli(['repair', 'orb-20260101-000000-abcdef', 'and', 'text']);
    expect(mixed.code).toBe(2);
  });
});

describe('orbit release resolve: lease renewal', () => {
  const node = process.execPath;
  function unknownDeploy(l: Lab, state: 'BLOCKED' | 'PREFLIGHT') {
    const config: OrbitConfig = defaultConfig('release');
    config.actions = { ...config.actions, merge: true, deploy_production: true };
    config.isolation = { ...config.isolation, provider: 'none', allow_unisolated: true };
    config.release = {
      merge: { method: 'squash', require_checks: [], delete_branch: false, mark_ready: true },
      environments: { staging: { deploy_command: [node, '-e', '0'], allowed_branches: ['main'], require_ci_green: false, network_hosts: [], timeout_seconds: 30, verify_command: null } },
    };
    const run = startRun({ db: l.db(), repoRoot: l.repo, goal: 'Release the acme widget', config, clock: systemClock });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: l.repo, encoding: 'utf8' }).trim();
    const ledger = new ActionLedger(l.db(), systemClock, { runDir: join(l.repo, '.orbit', 'runs', run.id) });
    const created = ledger.recordIntent({ runId: run.id, kind: 'deploy', idempotencyKey: `release:${run.id}:deploy:staging:${sha}`, target: { environment: 'staging', branch: 'main', sha, command: ['node'] }, treeHash: 'a'.repeat(40), commitSha: sha });
    ledger.markUnknown(ledger.markExecuting(created.action), 'controller stopped while the deploy ran');
    const dir = join(l.repo, '.orbit', 'runs', run.id, 'release', `deploy-staging-${sha.slice(0, 12)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'started.json'), JSON.stringify({ environment: 'staging', sha, attempt: 1 }));
    l.moveTo(run.id, state === 'BLOCKED' ? ['PREFLIGHT', 'BLOCKED'] : ['PREFLIGHT']);
    return { runId: run.id, sha };
  }

  it('renews the CLI lease on a timer while resolving, and a renewal that cannot be written is ignored', async () => {
    const l = lab();
    const real = globalThis.setInterval;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void) => {
      hooks.intervals.push(fn);
      return real(() => {}, 1_000_000);
    }) as typeof setInterval);
    const { runId } = unknownDeploy(l, 'BLOCKED');
    const r = await l.cli(['release', 'resolve', runId, '--deployed']);
    expect(r.code, r.err).toBe(0);
    expect(hooks.intervals).toHaveLength(1);
    expect(() => hooks.intervals[0]!()).not.toThrow();
  });

  it('falls back to the user name for an empty --by, and tells a run that is not blocked that the controller picks it up', async () => {
    const l = lab();
    const { runId } = unknownDeploy(l, 'PREFLIGHT');
    const r = await l.cli(['release', 'resolve', runId, '--deployed', '--by', '   ']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/DEPLOYED \(it will not run again\)/);
    expect(r.out).toContain("The controller picks this up at the run's next release attempt.\n");
    expect(r.out).not.toContain('orbit resume');
    const d = l.db().get<{ summary: string }>("SELECT summary FROM decisions WHERE run_id = ? AND kind = 'release.deploy-resolved'", runId);
    expect(d?.summary).toContain('resolved as deployed by alice');
  });

  it('exits 1 with JSON when the outcome is still unknown', async () => {
    const l = lab();
    const { runId, sha } = unknownDeploy(l, 'BLOCKED');
    const r = await l.cli(['release', 'resolve', runId, '--json']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ run_id: runId, verdict: 'unknown', sha, run_state: 'BLOCKED' });
  });
});
