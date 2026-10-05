import { afterEach, describe, expect, it } from 'vitest';
import { getRun } from '../../../src/controller/run-store.ts';
import { listQuestions } from '../../../src/inquisition/store.ts';
import { makeLab, type Lab } from './lab.ts';

const labs: Lab[] = [];
const lab = () => {
  const l = makeLab();
  labs.push(l);
  return l;
};
afterEach(() => labs.splice(0).forEach((l) => l.close()));

// A worker's environment carries the policy variables (adapters/env.ts) and the plugin's ORBIT_WORKER marker.
// A model must not be able to make a human decision or steer a run by running the CLI from its shell.
const WORKER_ENVS: Record<string, string>[] = [{ ORBIT_WORKER: '1' }, { ORBIT_POLICY_HASH: 'abc', ORBIT_POLICY_PATH: '/x' }];

describe('the CLI refuses state-changing commands inside a worker', () => {
  for (const extra of WORKER_ENVS) {
    const tag = Object.keys(extra)[0]!;
    it(`decide, resume, cancel and pause are denied (${tag})`, async () => {
      const l = lab();
      const run = l.newRun();
      l.moveTo(run.id, ['PREFLIGHT', 'BLOCKED']);
      const q = l.ask(run.id);
      const env = { ...process.env, ...extra };
      for (const argv of [['decide', run.id, q.id, 'A', '--by', 'alice'], ['resume', run.id, '--force'], ['cancel', run.id], ['pause', run.id]]) {
        const r = await l.cli(argv, { env });
        expect(r.code, argv.join(' ')).toBe(4);
        expect(r.err).toMatch(/worker/i);
      }
      expect(listQuestions(l.db(), run.id)[0]!.status).toBe('open');
      expect(getRun(l.db(), run.id).state).toBe('BLOCKED');
      expect(getRun(l.db(), run.id).cancelRequested).toBe(false);
    });

    it(`read-only commands still work (${tag})`, async () => {
      const l = lab();
      const run = l.newRun();
      const r = await l.cli(['status', run.id], { env: { ...process.env, ...extra } });
      expect(r.code, r.err).toBe(0);
    });
  }
});
