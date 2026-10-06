/**
 * NM1: a reader that closes the pipe (`orbit run --foreground | head -2`) must not stop the run it is driving.
 * The EPIPE handler is only for commands that have nothing left to do; a driving controller discards the output
 * and carries on, and Ctrl-C still pauses it cleanly.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type OrbitDb } from '../../../src/storage/db.ts';
import { stateDbPath } from '../../../src/controller/start.ts';
import { getLease, getRun, listRuns } from '../../../src/controller/run-store.ts';
import { listWorkers } from '../../../src/storage/workers.ts';
import { CLI_ENTRY, makeSandbox, makeScratch, removeScratch, type Sandbox } from './helpers.ts';

const boxes: Sandbox[] = [];
const dbs: OrbitDb[] = [];
afterEach(() => {
  dbs.splice(0).forEach((d) => d.close());
  boxes.splice(0).forEach((b) => b.close());
  removeScratch();
});

async function waitFor<T>(fn: () => T | null | undefined | false, ms = 20_000): Promise<T> {
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

describe('orbit run --foreground with its reader gone', () => {
  it('keeps driving the run after stdout is closed, and Ctrl-C still pauses it cleanly', async () => {
    const scenario = join(makeScratch(), 'scenario.json');
    writeFileSync(scenario, JSON.stringify({ auth: { loggedIn: true, authMethod: 'api_key', method: 'api_key', valid: true }, roles: { '*': [{ sleepMs: 30_000, structured: {} }] } }));
    const b = makeSandbox({ fakes: { claude: { ORBIT_FAKE_SCENARIO: scenario }, codex: { ORBIT_FAKE_SCENARIO: scenario } } });
    boxes.push(b);
    const child = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', CLI_ENTRY, 'run', '--goal', 'Add a mul function to the calculator.', '--foreground'], { cwd: b.repo, env: b.env(), stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    let exited: number | null | 'running' = 'running';
    const closed = new Promise<number | null>((r) =>
      child.on('close', (c) => {
        exited = c;
        r(c);
      }),
    );
    // `| head -1`: read the first chunk, then go away.
    await new Promise<void>((r) => child.stdout.once('data', () => r()));
    child.stdout.destroy();

    const db = await waitFor(() => {
      const d = openDb(stateDbPath(b.repo));
      dbs.push(d);
      return d;
    });
    const runId = await waitFor(() => listRuns(db, { limit: 1 })[0]?.id);
    try {
      await waitFor(() => listWorkers(db, { runId }).find((w) => w.state === 'RUNNING'));
    } catch (e) {
      child.kill('SIGKILL');
      throw new Error(`${(e as Error).message}\nexit ${String(exited)}\n${err}`);
    }
    // The run is mid-worker and the reader is long gone: the controller must still be there.
    await new Promise((r) => setTimeout(r, 1_500));
    expect(exited, `the process left when the pipe closed\n${err}`).toBe('running');
    expect(getRun(db, runId).state).not.toBe('CANCELLED');

    child.kill('SIGINT');
    const code = await Promise.race([closed, new Promise<'hung'>((r) => setTimeout(() => r('hung'), 30_000))]);
    if (code === 'hung') {
      child.kill('SIGKILL');
      throw new Error(`the process did not exit after Ctrl-C\n${err}`);
    }
    expect(code, err).toBe(20);
    expect(getRun(db, runId)).toMatchObject({ paused: true, cancelRequested: false });
    // A paused run is not held by a dead controller: the lease was released, so the next command can take it at once.
    expect(getLease(db, runId)).toBeNull();
    const cancel = await b.run(['cancel', runId]);
    expect(cancel.code, cancel.stderr).toBe(0);
  }, 180_000);
});
