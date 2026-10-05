// Resuming a BLOCKED run after the person fixed the cause (spec section 14, recovery): the stored failure of the
// blocked work unit is not replayed. Resume starts a fresh worker for that unit, the reset is recorded and spends
// one recovery attempt, so the number of resets stays bounded by scheduler.hard_limits.recovery_attempts.
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../../src/cli/cli.ts';
import { memoryIo } from '../../src/cli/io.ts';
import { listWorkers } from '../../src/storage/workers.ts';
import { APPROVE, baseScenario, calls, canStripTypes, drive, events, implementMul, runState, startLabRun, tracker, writeScenario, type Lab } from './helpers.ts';

const t = tracker();
afterEach(() => t.cleanup());

/** `orbit resume <run>` through the real CLI entry, in this process (no --foreground: it only changes the run). */
async function resume(l: Lab, runId: string): Promise<{ code: number; out: string; err: string }> {
  const io = memoryIo('');
  const code = await main(['resume', runId], { io, cwd: l.repo, homeDir: l.base, orbitHome: l.orbitHome, env: { ...process.env, ORBIT_HOME: l.orbitHome }, user: 'acme' });
  return { code, out: io.stdout, err: io.stderr };
}

describe.skipIf(!canStripTypes)('fault: resume after the cause of a block was fixed', () => {
  it('a reviewer that failed twice blocks; after the fix, resume starts review attempt 3 instead of replaying the stored failure', async () => {
    const l = t.lab();
    // Two reviewer sessions that end without a result, then (the wrapper fixed) a working reviewer.
    writeScenario(l, baseScenario({ implementer: [implementMul('*')], reviewer: [{ outcome: 'no_result' }, { outcome: 'no_result' }, APPROVE] }));
    const run = startLabRun(l);
    await drive(l, run.id);
    const blocked = runState(l, run.id);
    expect(blocked.state, blocked.outcomeReason ?? '').toBe('BLOCKED');
    expect(blocked.outcomeReason).toMatch(/no usable result after 2 attempt/);
    expect(calls(l, 'reviewer')).toHaveLength(2);

    const r = await resume(l, run.id);
    expect(r.code, r.err).toBe(0);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const purposes = listWorkers(l.db(), { runId: run.id, role: 'reviewer' }).map((w) => w.purpose);
    expect(purposes.some((p) => /^review:.+#3$/.test(p ?? ''))).toBe(true);
    expect(calls(l, 'reviewer')).toHaveLength(3);
    const resets = events(l, run.id, 'resume.reset');
    expect(resets).toHaveLength(1);
    expect(JSON.parse(resets[0]!.data_json!)).toMatchObject({ after_attempt: 2, next_attempt: 3 });
    expect(events(l, run.id, 'recovery.attempt').length).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('an implementer blocked on rejected credentials gets a fresh session after the login is fixed and the run is resumed', async () => {
    const l = t.lab();
    writeScenario(l, baseScenario({ implementer: [{ outcome: 'auth_failure' }, implementMul('*')] }));
    const run = startLabRun(l);
    await drive(l, run.id);
    const blocked = runState(l, run.id);
    expect(blocked.state, blocked.outcomeReason ?? '').toBe('BLOCKED');
    expect(blocked.outcomeReason).toMatch(/credentials/);

    const r = await resume(l, run.id);
    expect(r.code, r.err).toBe(0);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const sessions = listWorkers(l.db(), { runId: run.id, role: 'implementer' });
    expect(sessions.map((w) => w.purpose)).toEqual(['implement:1#1', 'implement:1#2']);
    expect(sessions.map((w) => w.resultStatus)).toEqual(['auth_failed', 'succeeded']);
  }, 120_000);

  it('resets are bounded by recovery_attempts: with the budget spent, resume ends the run EXHAUSTED instead of looping', async () => {
    const l = t.lab({ tweak: (c) => void (c.scheduler.hard_limits.recovery_attempts = 1) });
    writeScenario(l, baseScenario({ implementer: [implementMul('*')], reviewer: [{ outcome: 'no_result' }] }));
    const run = startLabRun(l);
    await drive(l, run.id);
    expect(runState(l, run.id).state).toBe('BLOCKED');
    // First resume: one reset (the whole budget), two more failures, blocked again.
    expect((await resume(l, run.id)).code).toBe(0);
    await drive(l, run.id);
    expect(runState(l, run.id).state).toBe('BLOCKED');
    expect(calls(l, 'reviewer')).toHaveLength(4);
    // Second resume: no recovery attempt is left, so no new reviewer starts.
    expect((await resume(l, run.id)).code).toBe(0);
    await drive(l, run.id);
    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('EXHAUSTED');
    expect(done.outcomeReason).toMatch(/recovery_attempts/);
    expect(calls(l, 'reviewer')).toHaveLength(4);
  }, 180_000);
});
