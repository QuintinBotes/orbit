import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManualClock } from '../../../src/core/clock.ts';
import { createRun, getRun, type RunRecord } from '../../../src/controller/run-store.ts';
import { openDb, type OrbitDb } from '../../../src/storage/db.ts';
import { defaultConfig } from '../../../src/policy/config.ts';
import { snapshotPolicy } from '../../../src/policy/snapshot.ts';
import type { OrbitConfig, PolicySnapshot } from '../../../src/policy/types.ts';
import { ActionLedger, type LedgerOptions } from '../../../src/delivery/actions.ts';
import { FakeGitHub } from '../../../src/delivery/github.ts';
import type { DeliveryCandidate, DeliveryEvidence, DeliveryReview, DeliveryRun } from '../../../src/delivery/gate.ts';

/** Git with a fixed identity and no user configuration, so the lab is reproducible. */
export function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Acme Dev',
      GIT_AUTHOR_EMAIL: 'dev@example.com',
      GIT_COMMITTER_NAME: 'Acme Dev',
      GIT_COMMITTER_EMAIL: 'dev@example.com',
      ...env,
    },
  }).trim();
}

export interface Lab {
  dir: string;
  work: string;
  remote: string;
  db: OrbitDb;
  clock: ManualClock;
  config: OrbitConfig;
  snapshot: PolicySnapshot;
  policyHash: string;
  runId: string;
  run: RunRecord;
  deliveryRun: DeliveryRun;
  base: string;
  fake: FakeGitHub;
  ledger(opts?: LedgerOptions): ActionLedger;
  /** A candidate: a commit on top of the base whose tree is the exact tree under review. */
  candidate(content: string, name?: string): DeliveryCandidate;
  evidenceFor(c: DeliveryCandidate, over?: Partial<DeliveryEvidence>): DeliveryEvidence;
  reviewFor(c: DeliveryCandidate, over?: Partial<DeliveryReview>): DeliveryReview;
  remoteSha(branch: string): string | null;
  cleanup(): void;
}

export function makeLab(opts: { mode?: Parameters<typeof defaultConfig>[0]; tweak?: (c: OrbitConfig) => void } = {}): Lab {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-delivery-')));
  const work = join(dir, 'work');
  const remote = join(dir, 'remote.git');
  mkdirSync(work);
  git(dir, ['init', '--bare', '-b', 'main', remote]);
  git(work, ['init', '-b', 'main']);
  git(work, ['config', 'user.name', 'Orbit Controller']);
  git(work, ['config', 'user.email', 'controller@example.com']);
  writeFileSync(join(work, 'README.md'), '# acme\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-m', 'base']);
  git(work, ['remote', 'add', 'origin', remote]);
  const base = git(work, ['rev-parse', 'HEAD']);
  git(work, ['push', 'origin', 'main']);

  const clock = new ManualClock();
  const config = defaultConfig(opts.mode ?? 'autonomous-delivery');
  config.delivery.provider = 'fake';
  opts.tweak?.(config);
  const runId = 'orb-20260101-acme01';
  const runDir = join(dir, 'runs', runId);
  const { snapshot, hash, path } = snapshotPolicy(config, { runId, repoRoot: work, runDir, clock });
  const db = openDb(join(dir, 'state.sqlite'));
  createRun(db, { id: runId, repoRoot: work, goal: 'Add the acme widget', mode: config.mode, policyHash: hash, policyPath: path }, clock);
  db.run('UPDATE runs SET base_revision = ?, branch = ? WHERE id = ?', base, `orbit/${runId}`, runId);
  const run = getRun(db, runId);
  const fake = new FakeGitHub({ statePath: join(dir, 'fake-github.json'), remoteGitDir: remote });

  let seq = 0;
  let rows = 0;
  const lab: Lab = {
    dir,
    work,
    remote,
    db,
    clock,
    config,
    snapshot,
    policyHash: hash,
    runId,
    run,
    deliveryRun: { id: runId, repoRoot: work, branch: run.branch, baseRevision: base, policyHash: hash, goal: 'Add the acme widget' },
    base,
    fake,
    ledger: (o) => new ActionLedger(db, clock, { runDir, backoffMs: () => 10, ...o }),
    candidate(content, name = 'widget.txt') {
      seq++;
      const ref = `refs/heads/cand-${seq}`;
      git(work, ['checkout', '-q', '--detach', base]);
      writeFileSync(join(work, name), content);
      git(work, ['add', '-A']);
      git(work, ['commit', '-q', '-m', `candidate ${seq}`]);
      const commit = git(work, ['rev-parse', 'HEAD']);
      git(work, ['update-ref', ref, commit]);
      git(work, ['checkout', '-q', 'main']);
      return { id: `cand-${seq}`, commitSha: commit, treeHash: git(work, ['rev-parse', `${commit}^{tree}`]), parentSha: base };
    },
    // Recorded rows, as the evidence and review stores write them: delivery re-reads them before every action.
    evidenceFor(c, over = {}) {
      const e: DeliveryEvidence = { id: `ev-${++rows}`, candidateId: c.id, treeHash: c.treeHash, policyHash: hash, verdict: 'PASS', ...over };
      db.run(
        `INSERT INTO evidence_reports (id, run_id, candidate_id, tree_hash, check_config_hash, policy_hash, verdict, report_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?)`,
        e.id!, runId, e.candidateId, e.treeHash, e.checkConfigHash ?? 'sha256:checks', e.policyHash, e.verdict, clock.now(),
      );
      return e;
    },
    reviewFor(c, over = {}) {
      const r: DeliveryReview = { id: `rv-${++rows}`, candidateId: c.id, treeHash: c.treeHash, verdict: 'APPROVE', ...over };
      db.run(
        `INSERT INTO reviews (id, run_id, candidate_id, tree_hash, round, provider, verdict, created_at) VALUES (?, ?, ?, ?, 1, 'fake', ?, ?)`,
        r.id!, runId, r.candidateId, r.treeHash, r.verdict, clock.now(),
      );
      return r;
    },
    remoteSha(branch) {
      try {
        return git(remote, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]) || null;
      } catch {
        return null;
      }
    },
    cleanup() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return lab;
}
