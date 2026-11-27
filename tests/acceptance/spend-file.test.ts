/** Issue #254: the spend file in the owner's stack inbox, as the claude-stack side reads it. */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/core/clock.ts';
import { startRun } from '../../src/controller/start.ts';
import { getRun } from '../../src/controller/run-store.ts';
import { listQuestions } from '../../src/inquisition/store.ts';
import { drive, seedRegistry } from './helpers/lab.ts';
import { blockedRun, cleanupSpend, cli, costlyLab, inbox, inboxFiles, inState, readInbox, tempDir } from './helpers/spend.ts';
import { GOAL } from './helpers/scenarios.ts';

afterEach(cleanupSpend);

describe('acceptance: the spend file of a run at its cost cap', () => {
  it('holds title, usd, tradeoff, recommendation, command and the time from the run clock, once however often it asks', async () => {
    const lab = costlyLab();
    const stateHome = tempDir();
    const clock = new ManualClock(Date.parse('2031-05-06T07:08:09.010Z'));
    seedRegistry(lab.db());
    const started = startRun({ db: lab.db(), repoRoot: lab.repo, goal: GOAL, config: lab.config, clock });
    const deps = { ...inState(stateHome), clock };
    const run = await drive(lab, started.id, deps);
    expect(run.state, run.outcomeReason ?? '').toBe('BLOCKED');

    const files = inboxFiles(stateHome);
    expect(files).toEqual([`orbit-${run.id}-24.json`]);
    const body = readInbox(stateHome, files[0]!);
    expect(Object.keys(body).sort()).toEqual(['at', 'command', 'recommendation', 'title', 'tradeoff', 'usd']);
    for (const key of ['title', 'tradeoff', 'recommendation', 'command']) expect(String(body[key]).trim(), key).not.toBe('');
    expect(body.usd).toBe(24);
    const [question] = listQuestions(lab.db(), run.id, { status: 'open' });
    expect(question!.question.endsWith(`To approve: ${String(body.command)}`)).toBe(true);
    // The run clock, which the controller's waits move on: the time the request was recorded, in 2031.
    const asked = lab.db().get<{ ts: number }>("SELECT ts FROM events WHERE run_id = ? AND type = 'budget.spend-requested'", run.id)!.ts;
    expect(body.at).toBe(new Date(asked).toISOString());
    expect(String(body.at).startsWith('2031-05-06T')).toBe(true);
    expect(statSync(join(inbox(stateHome), files[0]!)).mode & 0o777).toBe(0o600);
    expect(statSync(inbox(stateHome)).mode & 0o777).toBe(0o700);

    // A second block of the same request replaces the file.
    clock.advance(60_000);
    const secondAsk = clock.now();
    const resumed = await cli(lab, ['resume', run.id, '--force', '--detach']);
    expect(resumed.code, resumed.out).toBe(0);
    await drive(lab, run.id, deps);
    expect(getRun(lab.db(), run.id).state).toBe('BLOCKED');
    expect(inboxFiles(stateHome)).toEqual(files);
    const rewritten = Date.parse(String(readInbox(stateHome, files[0]!).at));
    expect(rewritten).toBeGreaterThanOrEqual(secondAsk);
    expect(rewritten).toBeLessThanOrEqual(clock.now());
  }, 180_000);

  it('is written under ~/.local/state when XDG_STATE_HOME is not set', async () => {
    const lab = costlyLab();
    const home = tempDir();
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.XDG_STATE_HOME;
    seedRegistry(lab.db());
    const started = startRun({ db: lab.db(), repoRoot: lab.repo, goal: GOAL, config: lab.config, clock: new ManualClock(Date.now()) });
    const run = await drive(lab, started.id, { hostEnv: env, homeDir: home });
    expect(run.state, run.outcomeReason ?? '').toBe('BLOCKED');
    expect(inboxFiles(join(home, '.local', 'state'))).toEqual([`orbit-${run.id}-24.json`]);
  }, 180_000);

  it('names a command that carries the repository, so it works from anywhere', async () => {
    const { lab, run, stateHome } = await blockedRun();
    const body = readInbox(stateHome, `orbit-${run.id}-24.json`);
    expect(String(body.command)).toContain(`--repo ${lab.repo}`);
  }, 180_000);
});
