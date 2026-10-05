import { describe, expect, it } from 'vitest';
import { getRun, acquireLease } from '../../../src/controller/run-store.ts';
import { planWorker } from '../../../src/storage/workers.ts';
import type { CredentialState, CredentialStatus, ProviderAdapter } from '../../../src/adapters/types.ts';
import {
  authBlocker,
  blockRunOnCredentials,
  checkRunCredentials,
  credentialCheckDue,
  providersForRun,
  validateCredentials,
  verdictOf,
} from '../../../src/recovery/credentials.ts';
import { eventTypes, makeRun, setup } from './helpers.ts';

function stub(id: string, answer: CredentialStatus | Error, extra: Record<string, unknown> = {}): ProviderAdapter {
  return {
    id,
    discoverCapabilities: async () => { throw new Error('unused'); },
    validateCredentials: async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    },
    startTask: async () => { throw new Error('unused'); },
    streamEvents: async () => ({ events: [], nextOffset: 0 }),
    cancelTask: async () => {},
    collectResult: async () => null,
    reportUsage: async () => { throw new Error('unused'); },
    ...extra,
  } as ProviderAdapter;
}

const status = (state: CredentialState, detail = 'd'): CredentialStatus => ({ state, method: 'api_key', detail });

describe('authBlocker', () => {
  it('names the provider, what is wrong, the command to run, that nothing is retried, and how to resume', () => {
    const b = authBlocker({ provider: 'claude', state: 'expired', runId: 'orb-7' });
    expect(b.message).toContain('claude');
    expect(b.message).toContain('are expired');
    expect(b.message).toContain('`claude auth login`');
    expect(b.message).toContain('ANTHROPIC_API_KEY');
    expect(b.message).toContain('orbit resume orb-7');
    expect(b.message).toContain('does not retry');
    expect(b.command).toBe('claude auth login');
    expect(authBlocker({ provider: 'codex', state: 'invalid' }).command).toBe('codex login');
    expect(authBlocker({ provider: 'codex', state: 'missing' }).message).toContain('are missing');
  });

  it('falls back to a generic command for an unknown provider and honours an override', () => {
    expect(authBlocker({ provider: 'acme-ai', state: 'expired' }).command).toBe('acme-ai login');
    expect(authBlocker({ provider: 'acme-ai', state: 'expired', loginCommands: { 'acme-ai': 'acme auth' } }).command).toBe('acme auth');
  });

  it('never prints credential material from the provider detail', () => {
    const b = authBlocker({ provider: 'claude', state: 'invalid', detail: 'rejected key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF' });
    expect(b.message).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });
});

describe('verdicts', () => {
  it('only a definite failure blocks; an unverifiable credential is reported as unverified, never as valid', () => {
    expect(verdictOf('valid')).toBe('valid');
    expect(verdictOf('unknown')).toBe('unverified');
    for (const s of ['missing', 'expired', 'invalid'] as const) expect(verdictOf(s)).toBe('blocked');
  });

  it('validateCredentials survives one provider failing and uses the live probe only when asked', async () => {
    const adapters = {
      claude: stub('claude', status('unknown'), { probeCredentials: async () => status('expired') }),
      codex: stub('codex', new Error('codex: command not found')),
    };
    const quick = await validateCredentials({ adapters, providers: ['claude', 'codex', 'ghost', 'claude'] });
    expect(quick.map((c) => [c.provider, c.verdict, c.live])).toEqual([['claude', 'unverified', false], ['codex', 'error', false], ['ghost', 'error', false]]);
    const live = await validateCredentials({ adapters, providers: ['claude'], live: true });
    expect(live[0]).toMatchObject({ verdict: 'blocked', live: true });
    // The probe is found through a wrapper's `inner`, as FakeAdapter exposes it.
    const wrapped = { claude: stub('claude', status('unknown'), { inner: { probeCredentials: async () => status('invalid') } }) };
    expect((await validateCredentials({ adapters: wrapped, providers: ['claude'], live: true }))[0]).toMatchObject({ verdict: 'blocked', live: true });
  });
});

describe('blocking a run', () => {
  it('moves the run to BLOCKED with the truthful blocker as its outcome, and is idempotent', () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    const blocker = authBlocker({ provider: 'claude', state: 'expired', runId: 'r1' });
    const first = blockRunOnCredentials(db, clock, 'ctl-1', 'r1', blocker);
    expect(first.outcome).toBe('blocked');
    const run = getRun(db, 'r1');
    expect(run.state).toBe('BLOCKED');
    expect(run.resumeState).toBe('IMPLEMENTING');
    expect(run.outcomeReason).toBe(blocker.message);
    expect(JSON.parse(run.outcomeJson!)).toMatchObject({ blocker: { kind: 'authentication', provider: 'claude', command: 'claude auth login' } });
    expect(blockRunOnCredentials(db, clock, 'ctl-1', 'r1', blocker).outcome).toBe('already-blocked');
    expect(eventTypes(db, 'r1').filter((t) => t === 'state.transition').length).toBe(5);
  });

  it('a durable cancellation wins, and a non-owner cannot block', () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    db.run('UPDATE runs SET cancel_requested = 1 WHERE id = ?', 'r1');
    const blocker = authBlocker({ provider: 'codex', state: 'missing' });
    expect(blockRunOnCredentials(db, clock, 'ctl-1', 'r1', blocker).outcome).toBe('cancel-pending');
    expect(getRun(db, 'r1').state).toBe('IMPLEMENTING');
    makeRun(db, clock, 'r2', 'ctl-1');
    expect(() => blockRunOnCredentials(db, clock, 'ctl-2', 'r2', blocker)).toThrow(/does not hold the lease/);
  });
});

describe('checkRunCredentials (scenario 12)', () => {
  it('expired credentials block the run once, naming the provider and the command, with no retry loop', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    const adapters = { claude: stub('claude', status('expired', 'OAuth token has expired')) };
    const rep = await checkRunCredentials({ db, clock, ownerId: 'ctl-1', runId: 'r1', adapters, providers: ['claude'] });
    expect(rep.blocked?.outcome).toBe('blocked');
    const run = getRun(db, 'r1');
    expect(run.state).toBe('BLOCKED');
    expect(run.outcomeReason).toMatch(/claude credentials are expired/);
    expect(run.outcomeReason).toMatch(/`claude auth login`/);
    // A second periodic check finds the same thing and changes nothing.
    const again = await checkRunCredentials({ db, clock, ownerId: 'ctl-1', runId: 'r1', adapters, providers: ['claude'] });
    expect(again.blocked?.outcome).toBe('already-blocked');
    expect(eventTypes(db, 'r1').filter((t) => t === 'credentials.checked')).toHaveLength(2);
  });

  it('valid, unverified and failed checks do not block; the verdicts are recorded without credential material', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    const adapters = { claude: stub('claude', status('unknown')), codex: stub('codex', status('valid')), broken: stub('broken', new Error('spawn ENOENT')) };
    const rep = await checkRunCredentials({ db, clock, ownerId: 'ctl-1', runId: 'r1', adapters, providers: ['claude', 'codex', 'broken'] });
    expect(rep.blocked).toBeNull();
    expect(rep.checks.map((c) => c.verdict)).toEqual(['unverified', 'valid', 'error']);
    expect(getRun(db, 'r1').state).toBe('IMPLEMENTING');
    const ev = db.get<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = 'r1' AND type = 'credentials.checked'");
    expect(JSON.parse(ev!.data_json).providers).toHaveLength(3);
  });

  it('reports the finding without acting when the caller is not the lease holder', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    const rep = await checkRunCredentials({ db, clock, ownerId: 'ctl-2', runId: 'r1', adapters: { claude: stub('claude', status('missing')) }, providers: ['claude'] });
    expect(rep.blocked?.outcome).toBe('not-applicable');
    expect(getRun(db, 'r1').state).toBe('IMPLEMENTING');
  });

  it('schedules periodic checks from the recorded events, and finds a run\'s providers from its workers', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    acquireLease(db, 'r1', 'ctl-1', 60_000, clock);
    expect(credentialCheckDue(db, 'r1', clock, 60_000)).toBe(true);
    await checkRunCredentials({ db, clock, ownerId: 'ctl-1', runId: 'r1', adapters: { claude: stub('claude', status('valid')) }, providers: ['claude'] });
    expect(credentialCheckDue(db, 'r1', clock, 60_000)).toBe(false);
    clock.advance(60_000);
    expect(credentialCheckDue(db, 'r1', clock, 60_000)).toBe(true);
    planWorker(db, { id: 'w1', runId: 'r1', role: 'implementer', provider: 'claude', workerDir: '/w1', cwd: '/c' }, clock);
    planWorker(db, { id: 'w2', runId: 'r1', role: 'reviewer', provider: 'codex', workerDir: '/w2', cwd: '/c' }, clock);
    expect(providersForRun(db, 'r1', ['gemini'])).toEqual(['claude', 'codex', 'gemini']);
  });
});
