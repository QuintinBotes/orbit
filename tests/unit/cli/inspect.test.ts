import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { systemClock } from '../../../src/core/clock.ts';
import { planWorker } from '../../../src/storage/workers.ts';
import { ModelRegistry } from '../../../src/routing/registry.ts';
import { makeLab, type Lab } from './lab.ts';

const labs: Lab[] = [];
const lab = (o?: Parameters<typeof makeLab>[0]) => {
  const l = makeLab(o);
  labs.push(l);
  return l;
};
afterEach(() => labs.splice(0).forEach((l) => l.close()));

describe('orbit report', () => {
  it('builds an interim report while the run is going and says it is not final', async () => {
    const l = lab();
    const run = l.newRun('Add a mul function to the calculator.');
    l.moveTo(run.id, ['PREFLIGHT']);
    const r = await l.cli(['report', run.id]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/^> INTERIM report: the run is PREFLIGHT/);
    expect(r.out).toContain('## Original goal');
    expect(r.out).toContain('Add a mul function to the calculator.');
    const j = JSON.parse((await l.cli(['report', run.id, '--json'])).out) as { interim: boolean; outcome: string; run_id: string };
    expect(j).toMatchObject({ interim: true, outcome: 'PREFLIGHT', run_id: run.id });
  });

  it('prints the final report of a finished run exactly as the controller wrote it', async () => {
    const l = lab();
    const run = l.newRun();
    l.moveTo(run.id, ['PREFLIGHT', 'BLOCKED']);
    expect((await l.cli(['cancel', run.id])).code).toBe(0);
    const final = await l.cli(['report', run.id]);
    expect(final.out).toMatch(/^# Orbit run .*: CANCELLED/);
    expect(final.out).not.toContain('INTERIM');
    const j = JSON.parse((await l.cli(['report', run.id, '--json'])).out) as { schema: string; outcome: string };
    expect(j).toMatchObject({ schema: 'orbit.final/1', outcome: 'CANCELLED' });
  });

  it('summarizes verified pass rate, attempts and cost over time', async () => {
    const l = lab();
    const a = l.newRun('one');
    l.moveTo(a.id, ['PREFLIGHT', 'BLOCKED']);
    const empty = await l.cli(['report', '--learning']);
    expect(empty.code, empty.err).toBe(0);
    const j = JSON.parse((await l.cli(['report', '--learning', '--json'])).out) as { windows: { window: string; runs: number; accepted: number; pass_rate: number | null }[] };
    expect(j.windows).toEqual([expect.objectContaining({ window: 'base prompt', runs: 1, accepted: 0, pass_rate: 0 })]);
    expect(empty.out).toContain('Learning report');
  });
});

describe('orbit policy show', () => {
  it('shows the frozen policy and what it allows', async () => {
    const l = lab();
    const run = l.newRun();
    const r = await l.cli(['policy', 'show', run.id]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`verified against hash ${run.policyHash}`);
    expect(r.out).toMatch(/mode:\s+autonomous/);
    expect(r.out).toMatch(/protected:.*\.orbit\/\*\*/);
    expect(r.out).toMatch(/actions off:.*merge/);
    expect(r.out).toMatch(/hard limits: 12 attempts/);
    const j = JSON.parse((await l.cli(['policy', 'show', run.id, '--json'])).out) as { verified: boolean; snapshot: { config: { mode: string } }; amendments: unknown[] };
    expect(j).toMatchObject({ verified: true, snapshot: { config: { mode: 'autonomous' } }, amendments: [] });
  });

  it('refuses a snapshot that no longer matches its hash', async () => {
    const l = lab();
    const run = l.newRun();
    chmodSync(run.policyPath, 0o644);
    writeFileSync(run.policyPath, `${JSON.stringify({ tampered: true })}\n`);
    const r = await l.cli(['policy', 'show', run.id]);
    expect(r.code).toBe(4);
    expect(r.err).toMatch(/does not match its recorded hash/);
  });
});

describe('orbit logs', () => {
  it('prints only this run\'s controller lines, and redacts what it prints', async () => {
    const l = lab();
    const a = l.newRun('one');
    const b = l.newRun('two');
    const file = join(l.orbitHome, 'logs', 'controller.jsonl');
    mkdirSync(dirname(file), { recursive: true });
    const lines = [
      { ts: '2026-01-01T00:00:01.000Z', level: 'info', msg: 'transition', run_id: a.id, from: 'CREATED', to: 'PREFLIGHT' },
      { ts: '2026-01-01T00:00:02.000Z', level: 'info', msg: 'transition', run_id: b.id, from: 'CREATED', to: 'PREFLIGHT' },
      { ts: '2026-01-01T00:00:03.000Z', level: 'warn', msg: 'leaked sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', run_id: a.id },
      { ts: '2026-01-01T00:00:04.000Z', level: 'info', msg: 'controller started' },
    ];
    writeFileSync(file, `${lines.map((x) => JSON.stringify(x)).join('\n')}\nnot json at all\n`);
    const r = await l.cli(['logs', a.id]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('[00:00:01] info  transition');
    expect(r.out).toContain('from=CREATED');
    expect(r.out).not.toContain(`run_id=${a.id}`);
    expect(r.out).not.toContain('2026-01-01T00:00:02');
    expect(r.out).not.toContain('controller started');
    expect(r.out).not.toContain('abcdefghijklmnop');
    expect(r.out).toContain('[REDACTED');
    const last = await l.cli(['logs', a.id, '--lines', '1']);
    expect(last.out.trim().split('\n')).toHaveLength(1);
    expect(last.out).toContain('warn');
    const raw = await l.cli(['logs', a.id, '--json']);
    expect(raw.out.trim().split('\n').map((x) => JSON.parse(x) as { source: string }).every((x) => x.source === 'controller')).toBe(true);
  });

  it('prints worker transcripts with the worker id, and can select one worker', async () => {
    const l = lab();
    const run = l.newRun();
    const dir = join(l.base, 'workers', 'w1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'log.jsonl'), '{"type":"system","subtype":"init"}\n{"type":"assistant"}\n');
    writeFileSync(join(dir, 'stderr.log'), 'warning: something\n');
    planWorker(l.db(), { id: 'w1', runId: run.id, role: 'implementer', provider: 'claude', workerDir: dir, cwd: dir }, systemClock);
    const dir2 = join(l.base, 'workers', 'w2');
    mkdirSync(dir2, { recursive: true });
    writeFileSync(join(dir2, 'log.jsonl'), '{"type":"other"}\n');
    planWorker(l.db(), { id: 'w2', runId: run.id, role: 'planner', provider: 'claude', workerDir: dir2, cwd: dir2 }, systemClock);
    const all = await l.cli(['logs', run.id, '--workers']);
    expect(all.out).toContain('[w1] {"type":"system","subtype":"init"}');
    expect(all.out).toContain('[w1:stderr] warning: something');
    expect(all.out).toContain('[w2]');
    const one = await l.cli(['logs', run.id, '--worker', 'w2']);
    expect(one.out).toContain('[w2]');
    expect(one.out).not.toContain('[w1]');
  });

  it('follows until the run is terminal, then stops', async () => {
    const l = lab();
    const run = l.newRun();
    l.moveTo(run.id, ['CANCELLED']);
    const file = join(l.orbitHome, 'logs', 'controller.jsonl');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ ts: '2026-01-01T00:00:01.000Z', level: 'info', msg: 'cancelled', run_id: run.id })}\n`);
    const r = await l.cli(['logs', run.id, '--follow'], { seams: { pollMs: 10 } });
    expect(r.code).toBe(0);
    expect(r.out).toContain('cancelled');
  });

  it('says where to look when a run has no logs', async () => {
    const l = lab();
    const run = l.newRun();
    const r = await l.cli(['logs', run.id]);
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/no logs found/);
    rmSync(join(l.orbitHome), { recursive: true, force: true });
  });
});

describe('orbit models list', () => {
  it('shows the shipped seed before any state exists', async () => {
    const l = lab();
    const r = await l.cli(['models', 'list', '--json']);
    expect(r.code, r.err).toBe(0);
    const j = JSON.parse(r.out) as { persisted: boolean; models: { model: string; availability: string; policy: string; eligible: boolean; surface: string }[] };
    expect(j.persisted).toBe(false);
    const sonnet = j.models.find((m) => m.model === 'claude-sonnet-5-5')!;
    expect(sonnet).toMatchObject({ surface: 'claude-cli', availability: 'unvalidated', policy: 'allowed' });
    // Fable is billed without a consent prompt, so a default policy does not route to it.
    expect(j.models.find((m) => m.model === 'claude-fable-5-1')).toMatchObject({ policy: 'not allowed', eligible: false });
    expect((await l.cli(['models', 'list'])).out).toMatch(/shipped registry seed/);
  });

  it('reflects what Orbit has observed once state exists', async () => {
    const l = lab();
    l.newRun();
    const reg = new ModelRegistry(l.db(), systemClock);
    reg.seed();
    reg.markAvailability('claude-sonnet-5-5', 'claude-cli', true, 'observed');
    reg.markAvailability('claude-opus-5-5', 'claude-cli', false, 'needs a newer claude');
    const j = JSON.parse((await l.cli(['models', 'list', '--json'])).out) as { persisted: boolean; models: { model: string; availability: string; eligible: boolean; reasons: string[] }[] };
    expect(j.persisted).toBe(true);
    expect(j.models.find((m) => m.model === 'claude-sonnet-5-5')).toMatchObject({ availability: 'available', eligible: true });
    const opus = j.models.find((m) => m.model === 'claude-opus-5-5')!;
    expect(opus.availability).toBe('unavailable');
    expect(opus.eligible).toBe(false);
    expect(opus.reasons.join(' ')).toMatch(/needs a newer claude/);
  });
});
