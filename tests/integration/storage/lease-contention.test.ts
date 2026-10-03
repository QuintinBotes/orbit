import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../../../src/core/clock.ts';
import { suppressSqliteExperimentalWarning } from '../../../src/core/warnings.ts';
import { createRun, getRun } from '../../../src/controller/run-store.ts';
import { openDb } from '../../../src/storage/db.ts';

/**
 * Two controller processes contend for one run's lease on a WAL database.
 * The events table is the record of who owned the lease when: every
 * transition must come from whoever most recently acquired or took over the
 * lease, and transitions must chain (each starts where the previous ended),
 * which together mean no two processes ever both held it.
 */

const require = createRequire(import.meta.url);
function sqliteAvailable(): boolean {
  suppressSqliteExperimentalWarning();
  try {
    require('node:sqlite');
    return true;
  } catch {
    return false;
  }
}
const SKIP_REASON = 'node:sqlite is unavailable in this Node build';

const CHILD = fileURLToPath(new URL('./fixtures/lease-child.ts', import.meta.url));
const TTL_MS = 150;

interface Stats {
  holds: number;
  transitions: number;
  leaseLost: number;
  conflicts: number;
  stalls: number;
  failedAcquires: number;
}

interface ChildRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runChild(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<ChildRun> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CHILD, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    p.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

interface EventRow {
  id: number;
  type: string;
  actor: string;
  from_state: string | null;
  to_state: string | null;
  data_json: string | null;
}

/** Replays the event log and fails on any transition made by a non-owner or out of sequence. */
function checkOwnership(events: EventRow[], initialState: string): { transitionsBy: Map<string, number>; takeovers: number; lastState: string } {
  let owner: string | null = null;
  let state = initialState;
  let takeovers = 0;
  const transitionsBy = new Map<string, number>();
  for (const e of events) {
    if (e.type === 'lease.acquired' || e.type === 'lease.takeover') {
      if (e.type === 'lease.takeover') {
        takeovers++;
        const prev = (JSON.parse(e.data_json ?? '{}') as { previous_owner?: string }).previous_owner;
        expect(prev, `event ${e.id}: takeover names the owner we last saw`).toBe(owner);
        expect(e.actor, `event ${e.id}: takeover by a different owner`).not.toBe(owner);
      }
      owner = e.actor;
    } else if (e.type === 'state.transition') {
      expect(e.actor, `event ${e.id}: transition by a process that did not hold the lease`).toBe(owner);
      expect(e.from_state, `event ${e.id}: transition does not continue from the previous state`).toBe(state);
      state = e.to_state!;
      transitionsBy.set(e.actor, (transitionsBy.get(e.actor) ?? 0) + 1);
    }
  }
  return { transitionsBy, takeovers, lastState: state };
}

let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orbit-lease-'));
  dbPath = join(dir, '.orbit', 'state.sqlite');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seedRun(): number {
  const db = openDb(dbPath);
  createRun(db, { id: 'r1', repoRoot: dir, goal: 'contend', mode: 'autonomous', policyHash: 'sha256:x', policyPath: '/p' }, new ManualClock());
  // Start inside a cycle of allowed edges so the children can transition indefinitely.
  db.run("UPDATE runs SET state = 'VERIFYING' WHERE id = 'r1'");
  const journal = db.get<{ journal_mode: string }>('PRAGMA journal_mode')!.journal_mode;
  const version = getRun(db, 'r1').version;
  db.close();
  expect(journal).toBe('wal');
  return version;
}

function readEvents(): { events: EventRow[]; version: number; state: string; integrity: string } {
  const db = openDb(dbPath);
  try {
    const events = db.all<EventRow>("SELECT id, type, actor, from_state, to_state, data_json FROM events WHERE run_id = 'r1' AND type != 'run.created' ORDER BY id");
    const run = getRun(db, 'r1');
    const integrity = db.get<{ integrity_check: string }>('PRAGMA integrity_check')!.integrity_check;
    return { events, version: run.version, state: run.state, integrity };
  } finally {
    db.close();
  }
}

describe('the ownership check', () => {
  const ev = (id: number, type: string, actor: string, from: string | null = null, to: string | null = null, data: unknown = null): EventRow => ({
    id,
    type,
    actor,
    from_state: from,
    to_state: to,
    data_json: data === null ? null : JSON.stringify(data),
  });

  it('accepts a clean handoff and a takeover', () => {
    const log = [
      ev(1, 'lease.acquired', 'a'),
      ev(2, 'state.transition', 'a', 'VERIFYING', 'DIAGNOSING'),
      ev(3, 'lease.acquired', 'b'),
      ev(4, 'state.transition', 'b', 'DIAGNOSING', 'REPAIRING'),
      ev(5, 'lease.takeover', 'a', null, null, { previous_owner: 'b' }),
      ev(6, 'state.transition', 'a', 'REPAIRING', 'VERIFYING'),
    ];
    expect(checkOwnership(log, 'VERIFYING')).toMatchObject({ takeovers: 1, lastState: 'VERIFYING' });
  });

  it('rejects a transition by a process that lost the lease', () => {
    const log = [ev(1, 'lease.acquired', 'a'), ev(2, 'lease.takeover', 'b', null, null, { previous_owner: 'a' }), ev(3, 'state.transition', 'a', 'VERIFYING', 'DIAGNOSING')];
    expect(() => checkOwnership(log, 'VERIFYING')).toThrow(/did not hold the lease/);
  });

  it('rejects a broken chain of states (a lost update)', () => {
    const log = [ev(1, 'lease.acquired', 'a'), ev(2, 'state.transition', 'a', 'VERIFYING', 'DIAGNOSING'), ev(3, 'state.transition', 'a', 'VERIFYING', 'DIAGNOSING')];
    expect(() => checkOwnership(log, 'VERIFYING')).toThrow(/does not continue/);
  });
});

describe('lease contention across processes on a WAL database', () => {
  it.skipIf(!sqliteAvailable())(`two processes never both hold the lease (skips when ${SKIP_REASON})`, async () => {
    const v0 = seedRun();
    const [a, b] = await Promise.all([
      runChild([dbPath, 'r1', 'ctl-a', '30', String(TTL_MS), '11', '0.08']),
      runChild([dbPath, 'r1', 'ctl-b', '30', String(TTL_MS), '29', '0.08']),
    ]);
    expect(a.code, a.stderr).toBe(0);
    expect(b.code, b.stderr).toBe(0);
    const sa = JSON.parse(a.stdout) as Stats;
    const sb = JSON.parse(b.stdout) as Stats;

    const { events, version, state, integrity } = readEvents();
    expect(integrity).toBe('ok');
    const { transitionsBy, takeovers, lastState } = checkOwnership(events, 'VERIFYING');

    // Both made progress, and every counted transition is in the log exactly once.
    expect(transitionsBy.get('ctl-a')).toBe(sa.transitions);
    expect(transitionsBy.get('ctl-b')).toBe(sb.transitions);
    expect(sa.transitions).toBeGreaterThan(0);
    expect(sb.transitions).toBeGreaterThan(0);
    expect(version - v0).toBe(sa.transitions + sb.transitions);
    expect(state).toBe(lastState);
    expect(sa.conflicts + sb.conflicts).toBe(0);

    // Stalls past the TTL forced takeovers, and the stalled owner was refused afterwards.
    expect(sa.stalls + sb.stalls).toBeGreaterThan(0);
    expect(takeovers).toBeGreaterThan(0);
    expect(sa.leaseLost + sb.leaseLost).toBeGreaterThan(0);
  });

  it.skipIf(!sqliteAvailable())(`a controller killed right after committing a transition is taken over and its work kept (skips when ${SKIP_REASON})`, async () => {
    seedRun();
    const crashEnv = { ...process.env, ORBIT_FAULTS: 'controller.transition.after-commit=crash' };
    const crashed = await runChild([dbPath, 'r1', 'ctl-dead', '5', String(TTL_MS), '3', '0'], crashEnv);
    expect(crashed.code).toBe(137);
    expect(crashed.stderr).toContain('fault injected at controller.transition.after-commit');

    const survivor = await runChild([dbPath, 'r1', 'ctl-live', '5', String(TTL_MS), '5', '0']);
    expect(survivor.code, survivor.stderr).toBe(0);
    const stats = JSON.parse(survivor.stdout) as Stats;

    const { events, integrity } = readEvents();
    expect(integrity).toBe('ok');
    const { transitionsBy, takeovers } = checkOwnership(events, 'VERIFYING');
    // The dead controller's one committed transition survived the crash...
    expect(transitionsBy.get('ctl-dead')).toBe(1);
    // ...its lease was never released, so the survivor had to wait out the TTL and take over.
    expect(takeovers).toBe(1);
    const takeover = events.find((e) => e.type === 'lease.takeover')!;
    expect(takeover.actor).toBe('ctl-live');
    expect(JSON.parse(takeover.data_json!)).toMatchObject({ previous_owner: 'ctl-dead' });
    expect(transitionsBy.get('ctl-live')).toBe(stats.transitions);
  });
});
