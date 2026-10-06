/**
 * The "Polish" list of the second end-to-end test: small wording and lookup defects a person meets at the terminal.
 * Each case names the item it covers.
 */
import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getRun } from '../../../src/controller/run-store.ts';
import { orbitHint, viaPlugin } from '../../../src/core/invocation.ts';
import { parseConfig } from '../../../src/policy/config.ts';
import { makeLab, type Lab } from './lab.ts';

const labs: Lab[] = [];
const lab = (opts: { git?: boolean } = {}) => {
  const l = makeLab(opts);
  labs.push(l);
  return l;
};
afterEach(() => labs.splice(0).forEach((l) => l.close()));

describe('command-line wording', () => {
  it('"orbit help help" describes help instead of suggesting "help" for "help"', async () => {
    const l = lab({ git: false });
    const r = await l.cli(['help', 'help']);
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
    expect(r.out).toContain('orbit help <command>');
    expect(r.out).not.toMatch(/did you mean "help"/);
  });

  it('a negative number given as a separate word is a bad value, not "does not take a value"', async () => {
    const l = lab();
    for (const argv of [['gc', '--keep-days', '-1'], ['gc', '--keep-days=-1']]) {
      const r = await l.cli(argv);
      expect(r.code).toBe(2);
      expect(r.err).toContain('--keep-days must be a non-negative integer, got "-1"');
      expect(r.err).not.toContain('does not take a value');
    }
  });

  it('outside a git repository the error says how to make one', async () => {
    const l = lab({ git: false });
    const r = await l.cli(['status']);
    expect(r.code).toBe(3);
    expect(r.err).toContain('is not inside a git repository');
    expect(r.err).toContain('git init');
  });

  it('cancel does not repeat the state it just named ("cancelled (CANCELLED)")', async () => {
    const l = lab();
    const run = l.newRun();
    l.moveTo(run.id, ['PREFLIGHT', 'BLOCKED']);
    const r = await l.cli(['cancel', run.id]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).not.toMatch(/cancelled[^\n]*\(CANCELLED\)/i);
    const again = await l.cli(['cancel', run.id]);
    expect(again.out).toBe(`run ${run.id}: already CANCELLED; nothing to cancel\n`);
  });

  it('question ids are matched without regard to case', async () => {
    const l = lab();
    const run = l.newRun();
    const q = l.ask(run.id);
    const r = await l.cli(['decide', run.id, q.id.toUpperCase(), 'A']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(q.id);
    const prefix = await l.cli(['questions', run.id, '--all', '--json']);
    expect(prefix.code).toBe(0);
  });

  it('plugin wording is used only inside Claude Code, not when bin/orbit is run from a plain terminal', () => {
    const plain = { ORBIT_PLUGIN_ROOT: '/opt/acme/plugins/orbit' };
    expect(viaPlugin(plain)).toBe(false);
    expect(orbitHint('doctor', plain)).toBe('"orbit doctor"');
    const claude = { ...plain, CLAUDECODE: '1' };
    expect(viaPlugin(claude)).toBe(true);
    expect(orbitHint('doctor', claude)).toBe('/orbit:doctor (or "orbit doctor" in Claude Code\'s Bash tool)');
  });
});

describe('run guidance', () => {
  it('a block reason with no full stop is still separated from "Resolve that"', async () => {
    const l = lab();
    const run = l.newRun();
    l.moveTo(run.id, ['PREFLIGHT', 'BLOCKED']);
    l.db().run("UPDATE runs SET outcome_reason = 'no mandatory criterion is marked ui' WHERE id = ?", run.id);
    const r = await l.cli(['report', run.id, '--json']);
    expect(r.code, r.err).toBe(0);
    const next = (JSON.parse(r.out) as { next_action: string }).next_action;
    expect(next).toContain('marked ui. Resolve that');
  });

  it('verify after gc says the run was pruned, not that its policy was tampered with', async () => {
    const l = lab();
    const run = l.newRun();
    l.moveTo(run.id, ['PREFLIGHT', 'CANCELLED']);
    l.db().run("UPDATE runs SET contract_json = '{}' WHERE id = ?", run.id);
    rmSync(dirname(getRun(l.db(), run.id).policyPath), { recursive: true, force: true });
    const r = await l.cli(['verify', run.id]);
    expect(r.code).toBe(3);
    expect(r.err).toContain('orbit gc');
    expect(r.err).not.toMatch(/ENOENT|tamper/i);
  });
});

describe('configuration errors', () => {
  const problems = (text: string): string => {
    try {
      parseConfig(text);
    } catch (err) {
      return (err as Error).message;
    }
    throw new Error('the config was accepted');
  };

  it('an unknown key suggests the key it is close to', () => {
    expect(problems('version: 1\nmood: autonomous\n')).toContain('unknown key "mood"; did you mean "mode"?');
  });

  it('a value outside an enum names the value given and the closest allowed one', () => {
    const text = problems('version: 1\nmode: autonomus\n');
    expect(text).toContain('got "autonomus"');
    expect(text).toContain('did you mean "autonomous"?');
  });
});
