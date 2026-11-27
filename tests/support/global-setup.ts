/**
 * One id per test run, and a teardown that removes exactly the acceptance templates this run made. The templates
 * are a copy of the demo app with its dependencies (about 50 MB each, one per worker); a worker's 'exit' handler does
 * not run when vitest ends the worker, so cleaning up there leaked a template per worker on every run.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TEMPLATE_PREFIX = 'orbit-acc-template-';

export default function setup(): () => void {
  const run = `${process.pid}-${Date.now().toString(36)}`;
  process.env.ORBIT_TEST_RUN = run;
  // A run that reaches its cost cap writes a request into the owner's state folder (issue #254): never the real one.
  const state = mkdtempSync(join(tmpdir(), 'orbit-state-'));
  process.env.XDG_STATE_HOME = state;
  return () => {
    rmSync(state, { recursive: true, force: true });
    const mine = `${TEMPLATE_PREFIX}${run}-`;
    for (const name of readdirSync(tmpdir())) {
      if (name.startsWith(mine)) rmSync(join(tmpdir(), name), { recursive: true, force: true });
    }
  };
}
