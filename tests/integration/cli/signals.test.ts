/**
 * Ctrl-C in a real foreground `orbit run` process: it must pause the run and
 * exit by itself, leaving the worker for the next controller.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type OrbitDb } from '../../../src/storage/db.ts';
import { stateDbPath } from '../../../src/controller/start.ts';
import { getRun, listRuns } from '../../../src/controller/run-store.ts';
import { listWorkers } from '../../../src/storage/workers.ts';
import { CLI_ENTRY, makeSandbox, makeScratch, removeScratch, type Sandbox } from './helpers.ts';

const boxes: Sandbox[] = [];
const dbs: OrbitDb[] = [];
afterEach(() => {
  dbs.splice(0).forEach((d) => d.close());
  boxes.splice(0).forEach((b) => b.close());
  removeScratch();
});

async function waitFor<T>(fn: () => T | null | undefined | false, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    let v: T | null | undefined | false = null;
    try {
      v = fn();
    } catch {
      v = null;
    }
    if (v) return v as T;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('orbit run --foreground in its own process', () => {
  it('pauses on SIGINT, exits 20 by itself, and keeps the run resumable', async () => {
    const scenario = join(makeScratch(), 'scenario.json');
    // The planner is slow, so the process is waiting on a live worker when the interrupt arrives.
    writeFileSync(scenario, JSON.stringify({ auth: { loggedIn: true, authMethod: 'api_key', method: 'api_key', valid: true }, roles: { '*': [{ sleepMs: 30_000, structured: {} }] } }));
    const b = makeSandbox({ fakes: { claude: { ORBIT_FAKE_SCENARIO: scenario }, codex: { ORBIT_FAKE_SCENARIO: scenario } } });
    boxes.push(b);
    const child = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', CLI_ENTRY, 'run', '--goal', 'Add a mul function to the calculator.', '--foreground'], { cwd: b.repo, env: b.env(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    const closed = new Promise<number | null>((r) => child.on('close', (c) => r(c)));

    const db = await waitFor(() => {
      const d = openDb(stateDbPath(b.repo));
      dbs.push(d);
      return d;
    });
    const runId = await waitFor(() => listRuns(db, { limit: 1 })[0]?.id);
    try {
      await waitFor(() => listWorkers(db, { runId }).find((w) => w.state === 'RUNNING'));
    } catch (err) {
      child.kill('SIGKILL');
      throw new Error(`${(err as Error).message}\n${out}`);
    }
    child.kill('SIGINT');
    const code = await Promise.race([closed, new Promise<'hung'>((r) => setTimeout(() => r('hung'), 30_000))]);
    if (code === 'hung') {
      child.kill('SIGKILL');
      throw new Error(`the process did not exit after Ctrl-C\n${out}`);
    }
    expect(code, out).toBe(20);
    expect(out).toMatch(/pausing the run \(not cancelling it\)/);
    expect(getRun(db, runId)).toMatchObject({ paused: true, cancelRequested: false });
    expect(getRun(db, runId).state).not.toBe('CANCELLED');

    // Stop the detached worker so the sandbox can be removed.
    const cancel = await b.run(['cancel', runId]);
    expect(cancel.code, cancel.stderr).toBe(0);
  }, 180_000);
});
