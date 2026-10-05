import { afterEach, describe, expect, it } from 'vitest';
import { COMMANDS, exitCodesText } from '../../../src/cli/cli.ts';
import { EXIT, EXIT_CODE_DOCS } from '../../../src/cli/exit.ts';
import { exitCodeForVerdict } from '../../../src/cli/commands/verify.ts';
import { listRuns } from '../../../src/controller/run-store.ts';
import { makeLab, type Lab } from './lab.ts';

const labs: Lab[] = [];
const lab = (): Lab => {
  const l = makeLab();
  labs.push(l);
  return l;
};
afterEach(() => labs.splice(0).forEach((l) => l.close()));

describe('verify and repair are commands', () => {
  it('are registered, documented and refused inside a worker', async () => {
    expect(COMMANDS.map((c) => c.name)).toEqual(expect.arrayContaining(['verify', 'repair']));
    const l = lab();
    for (const argv of [['verify'], ['repair', 'x']]) {
      const r = await l.cli(argv, { env: { ...process.env, ORBIT_WORKER: '1' } });
      expect(r.code, argv.join(' ')).toBe(EXIT.CONFIG);
      expect(r.err).toMatch(/refused inside a worker/);
    }
  });

  it('give FAIL and INCOMPLETE their own exit codes, listed in the exit code table', () => {
    expect(EXIT.VERIFY_FAILED).toBe(14);
    expect(EXIT.VERIFY_INCOMPLETE).toBe(15);
    expect(new Set(EXIT_CODE_DOCS.map((e) => e.code)).size).toBe(EXIT_CODE_DOCS.length);
    expect(exitCodesText()).toMatch(/14  VERIFY_FAILED/);
    expect(exitCodesText()).toMatch(/15  VERIFY_INCOMPLETE/);
    expect([exitCodeForVerdict('PASS'), exitCodeForVerdict('FAIL'), exitCodeForVerdict('INCOMPLETE')]).toEqual([0, 14, 15]);
  });
});

describe('orbit verify: argument handling', () => {
  it('takes at most one run id', async () => {
    const r = await lab().cli(['verify', 'a', 'b']);
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.err).toMatch(/expected 0 to 1 arguments, got 2/);
  });

  it('says what to do when there is no state, no run, or an unknown run', async () => {
    const l = lab();
    expect((await l.cli(['verify'])).err).toMatch(/no Orbit state/);
    l.db();
    const none = await l.cli(['verify']);
    expect(none.code).toBe(EXIT.NOT_FOUND);
    expect(none.err).toMatch(/no runs to verify/);
    const unknown = await l.cli(['verify', 'orb-nope-000000']);
    expect(unknown.code).toBe(EXIT.NOT_FOUND);
  });

  it('refuses a run that has no contract yet instead of reporting an empty pass', async () => {
    const l = lab();
    const run = l.newRun();
    const r = await l.cli(['verify']);
    expect(r.code).toBe(EXIT.CONFLICT);
    expect(r.err).toContain(`run ${run.id} has no contract yet (it is CREATED)`);
  });
});

describe('orbit repair: argument handling', () => {
  it('needs a run id or a description', async () => {
    const r = await lab().cli(['repair']);
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.err).toMatch(/a run id or a description of the failure is required/);
  });

  it('refuses a run id mixed with words, and an unknown run id, without starting a run', async () => {
    const l = lab();
    const mixed = await l.cli(['repair', 'orb-20261005-000000-aaaaaa', 'and', 'more']);
    expect(mixed.code).toBe(EXIT.USAGE);
    expect(mixed.err).toMatch(/either one run id or a description/);
    l.db();
    const unknown = await l.cli(['repair', 'orb-20261005-000000-aaaaaa']);
    expect(unknown.code).toBe(EXIT.NOT_FOUND);
    expect(listRuns(l.db())).toHaveLength(0);
  });

  it('refuses a run that is running, finished, or has no FAIL evidence, saying why', async () => {
    const l = lab();
    const running = l.newRun();
    l.moveTo(running.id, ['PREFLIGHT', 'CONTRACTING']);
    const a = await l.cli(['repair', running.id]);
    expect(a.code).toBe(EXIT.CONFLICT);
    expect(a.err).toMatch(/is CONTRACTING and running; a controller is already working on it/);

    const blocked = l.newRun('Another goal.');
    l.moveTo(blocked.id, ['PREFLIGHT', 'BLOCKED']);
    const b = await l.cli(['repair', blocked.id]);
    expect(b.code).toBe(EXIT.CONFLICT);
    expect(b.err).toMatch(/no verified candidate, so there is no failure to repair/);

    const done = l.newRun('A third goal.');
    l.moveTo(done.id, ['PREFLIGHT', 'CANCELLED']);
    const c = await l.cli(['repair', done.id]);
    expect(c.code).toBe(EXIT.CONFLICT);
    expect(c.err).toMatch(/ended CANCELLED; a finished run cannot be repaired/);
  });
});
