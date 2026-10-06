/**
 * P27 and P28 leftovers: the verify and repair guidance no longer sends a person round in a circle, a run that ended is
 * not described as running or paused, a "nothing to resume" says what to do instead, a policy parse error says where,
 * and the foreground footer names the result.
 */
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setPaused } from '../../../src/controller/run-store.ts';
import { systemClock } from '../../../src/core/clock.ts';
import { parseConfig } from '../../../src/policy/config.ts';
import { repairNextStep } from '../../../src/cli/commands/verify.ts';
import { defineCheck, makeLab, type Lab } from './lab.ts';

const hooks = vi.hoisted(() => ({ fake: false, start: null as null | ((runId: string) => Promise<void>) }));
vi.mock('../../../src/controller/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/controller/index.ts')>();
  class Fake {
    private readonly runId: string;
    constructor(opts: { runId: string }) {
      this.runId = opts.runId;
    }
    async start(): Promise<void> {
      await hooks.start?.(this.runId);
    }
    async stop(): Promise<void> {}
  }
  const Wrapper = function (this: unknown, opts: ConstructorParameters<typeof actual.Controller>[0]) {
    return hooks.fake ? new Fake(opts as never) : new actual.Controller(opts);
  } as unknown as typeof actual.Controller;
  return { ...actual, Controller: Wrapper };
});

const labs: Lab[] = [];
const lab = () => {
  const l = makeLab();
  labs.push(l);
  return l;
};
beforeEach(() => {
  hooks.fake = false;
  hooks.start = null;
});
afterEach(() => labs.splice(0).forEach((l) => l.close()));

describe('P27: verify and repair agree', () => {
  it('repair of a run with no contract says there is nothing to verify, not "run orbit verify first"', async () => {
    const l = lab();
    const run = l.newRun();
    setPaused(l.db(), run.id, true, 'test', systemClock);
    const r = await l.cli(['repair', run.id]);
    expect(r.code).toBe(5);
    expect(r.err).toContain('has no contract yet');
    expect(r.err).not.toMatch(/Run "orbit verify/);
  });

  it('names a repair only where one can be started', () => {
    const base = { id: 'orb-1', cancelRequested: false };
    expect(repairNextStep({ ...base, state: 'BLOCKED', paused: false } as never)).toBe('hand the failure to a repair with: orbit repair orb-1');
    expect(repairNextStep({ ...base, state: 'IMPLEMENTING', paused: true } as never)).toBe('hand the failure to a repair with: orbit repair orb-1');
    expect(repairNextStep({ ...base, state: 'IMPLEMENTING', paused: false } as never)).toBe('pause the run with "orbit pause orb-1", then hand the failure to a repair with: orbit repair orb-1');
    const ended = repairNextStep({ ...base, state: 'EXHAUSTED', paused: false } as never);
    expect(ended).toContain('EXHAUSTED');
    expect(ended).not.toContain('orbit repair orb-1');
    expect(ended).toContain('orbit repair "<description of the failure>"');
  });
});

describe('P28: status and resume wording', () => {
  it('a cancelled run is not shown as paused, in the list or in its own status', async () => {
    const l = lab();
    const run = l.newRun();
    setPaused(l.db(), run.id, true, 'test', systemClock);
    l.db().run("UPDATE runs SET state = 'CANCELLED', ended_at = ? WHERE id = ?", Date.now(), run.id);
    const list = await l.cli(['status']);
    expect(list.out).toContain('CANCELLED');
    expect(list.out).not.toMatch(/CANCELLED \(paused\)/);
    const one = await l.cli(['status', run.id]);
    expect(one.out).toMatch(/^run \S+  CANCELLED\n/);
  });

  it('"nothing to resume" says what to do instead', async () => {
    const l = lab();
    for (const state of ['SUCCEEDED', 'EXHAUSTED', 'CANCELLED']) {
      const run = l.newRun(`goal ${state}`);
      l.db().run('UPDATE runs SET state = ?, ended_at = ? WHERE id = ?', state, Date.now(), run.id);
      const r = await l.cli(['resume', run.id]);
      expect(r.code).toBe(5);
      expect(r.err, state).toContain(`${state}; nothing to resume.`);
      expect(r.err, state).toContain(`orbit report ${run.id}`);
      expect(r.err, state).toContain('orbit run --goal');
    }
  });

  it('a run that was never started is not "already running"', async () => {
    const l = lab();
    const run = l.newRun();
    const r = await l.cli(['resume', run.id, '--detach']);
    expect(r.out).not.toContain('already running');
    expect(r.out).toContain('created but not started; a controller picks it up');
  });
});

describe('P28: parse errors say where', () => {
  it('a YAML error names the line and the column', () => {
    const text = 'version: 1\nmode: autonomous\nscope:\n  allowed_paths: [src/**\nchecks: {}\n';
    let message = '';
    try {
      parseConfig(text, { source: '.orbit/config.yaml' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/yaml: .* \(line \d+, column \d+\)/);
  });

  it('reaches the person through the CLI, for the repository config', async () => {
    const l = lab();
    await l.cli(['init']);
    const path = join(l.repo, '.orbit', 'config.yaml');
    writeFileSync(path, 'version: 1\nmode: autonomous\nscope:\n  allowed_paths: [src/**\nchecks: {}\n');
    const r = await l.cli(['run', '--goal', 'x', '--detach']);
    expect(r.code).toBe(4);
    expect(r.err).toMatch(/\(line 4, column \d+\)|\(line 5, column \d+\)/);
  });
});

describe('P28: the foreground footer names the result', () => {
  it('prints the branch and the commit a succeeded run left, labelled as local', async () => {
    const l = lab();
    await l.cli(['init']);
    defineCheck(l);
    hooks.fake = true;
    hooks.start = async (id) => {
      const sha = 'a'.repeat(40);
      l.db().run("INSERT INTO candidates (id, run_id, seq, attempt, commit_sha, tree_hash, parent_sha, status, created_at) VALUES ('cand-1', ?, 1, 1, ?, ?, ?, 'READY', ?)", id, sha, 'b'.repeat(40), 'c'.repeat(40), Date.now());
      l.db().run("UPDATE runs SET state = 'SUCCEEDED', ended_at = ?, branch = ? WHERE id = ?", Date.now(), `orbit/${id}`, id);
    };
    const r = await l.cli(['run', '--goal', 'g', '--foreground'], { seams: { pollMs: 5, controllerDeps: () => ({}) as never, admission: async () => null, signals: new EventEmitter() } });
    expect(r.code).toBe(0);
    const id = /^run (orb-\S+) started/m.exec(r.out)![1]!;
    expect(r.out).toContain(`result: branch orbit/${id} at ${'a'.repeat(12)} (local, not delivered)`);
  });

  it('says there is no result when the run produced none', async () => {
    const l = lab();
    await l.cli(['init']);
    defineCheck(l);
    hooks.fake = true;
    hooks.start = async (id) => {
      l.db().run("UPDATE runs SET state = 'CANCELLED', ended_at = ? WHERE id = ?", Date.now(), id);
    };
    const r = await l.cli(['run', '--goal', 'g', '--foreground'], { seams: { pollMs: 5, controllerDeps: () => ({}) as never, admission: async () => null, signals: new EventEmitter() } });
    expect(r.out).not.toMatch(/^result: branch/m);
  });
});
