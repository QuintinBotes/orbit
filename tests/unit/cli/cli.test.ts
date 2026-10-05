import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COMMANDS, HIDDEN_COMMANDS, commandHelp, exitCodesText, helpText, main } from '../../../src/cli/cli.ts';
import { EXIT, EXIT_CODE_DOCS, UsageError, exitCodeFor, exitCodeForState } from '../../../src/cli/exit.ts';
import { memoryIo } from '../../../src/cli/io.ts';
import { OrbitError, type OrbitErrorCode } from '../../../src/core/errors.ts';
import { ORBIT_VERSION } from '../../../src/cli/version.ts';

async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const io = memoryIo();
  const code = await main(argv, { io, cwd: process.cwd() });
  return { code, out: io.stdout, err: io.stderr };
}

describe('command dispatch', () => {
  it('prints the help and exits 2 when given nothing', async () => {
    const r = await cli([]);
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.out).toContain('Usage: orbit <command>');
  });

  it('lists every public command and none of the hidden internals', async () => {
    const r = await cli(['help']);
    expect(r.code).toBe(0);
    for (const c of COMMANDS) expect(r.out).toContain(c.name);
    for (const name of ['doctor', 'init', 'run', 'status', 'logs', 'pause', 'resume', 'cancel', 'report', 'decide', 'questions', 'models list', 'models refresh', 'learn list', 'learn show', 'learn ingest', 'learn export', 'learn overlays', 'learn eval', 'service install', 'service uninstall', 'service status', 'service run', 'policy show']) {
      expect(COMMANDS.map((c) => c.name)).toContain(name);
    }
    expect(HIDDEN_COMMANDS).toEqual(['shim', 'hook', 'check-runner']);
    expect(helpText()).not.toMatch(/check-runner|\bshim\b|pre-tool-use/);
  });

  it('reports the version', async () => {
    const r = await cli(['--version']);
    expect(r).toEqual({ code: 0, out: `${ORBIT_VERSION}\n`, err: '' });
  });

  it('rejects an unknown command with the exit code for usage errors', async () => {
    const r = await cli(['frobnicate']);
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.err).toMatch(/unknown command "frobnicate"/);
  });

  it('asks for a subcommand where a command group needs one', async () => {
    const r = await cli(['models']);
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.err).toMatch(/needs a subcommand: list, refresh/);
    const l = await cli(['learn', 'bogus']);
    expect(l.code).toBe(EXIT.USAGE);
    expect(l.err).toMatch(/list, show, ingest, export, overlays, eval/);
  });

  it('rejects unknown options and prints the command usage', async () => {
    const r = await cli(['status', '--bogus']);
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.err).toMatch(/usage: orbit status/);
  });

  it('requires a goal and refuses contradictory run flags before touching any state', async () => {
    const none = await cli(['run']);
    expect(none.code).toBe(EXIT.USAGE);
    expect(none.err).toMatch(/a goal is required/);
    const both = await cli(['run', '--goal', 'x', '--foreground', '--detach']);
    expect(both.code).toBe(EXIT.USAGE);
    expect(both.err).toMatch(/cannot be combined/);
    const badMode = await cli(['run', '--goal', 'x', '--mode', 'reckless']);
    expect(badMode.code).toBe(EXIT.USAGE);
    expect(badMode.err).toMatch(/must be one of supervised, autonomous, autonomous-delivery, release/);
  });

  it('shows per-command help for every command', async () => {
    for (const c of COMMANDS) {
      const r = await cli([...c.name.split(' '), '--help']);
      expect(r.code, c.name).toBe(0);
      expect(r.out, c.name).toContain(`Usage: ${c.usage}`);
      expect(r.out).toContain('--repo <dir>');
      expect(commandHelp(c)).toContain(c.summary);
    }
  });

  it('answers errors as JSON on stderr when --json is given', async () => {
    const r = await cli(['frobnicate', '--json']);
    expect(r.code).toBe(EXIT.USAGE);
    expect(JSON.parse(r.err)).toEqual({ error: { code: 'USAGE', message: expect.stringContaining('frobnicate') } });
  });
});

describe('exit codes', () => {
  it('documents every code exactly once', () => {
    const codes = EXIT_CODE_DOCS.map((e) => e.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.sort((a, b) => a - b)).toEqual(Object.values(EXIT).sort((a, b) => a - b));
    const text = exitCodesText();
    for (const e of EXIT_CODE_DOCS) expect(text).toContain(e.name);
  });

  it('maps errors to codes by their Orbit error code, never by message', () => {
    const table: [OrbitErrorCode, number][] = [
      ['NOT_FOUND', EXIT.NOT_FOUND],
      ['CONFIG_INVALID', EXIT.CONFIG],
      ['POLICY_TAMPERED', EXIT.CONFIG],
      ['TRANSITION_INVALID', EXIT.CONFLICT],
      ['CONCURRENT_UPDATE', EXIT.CONFLICT],
      ['AUTH_MISSING', EXIT.ENVIRONMENT],
      ['ISOLATION_UNAVAILABLE', EXIT.ENVIRONMENT],
      ['INTERNAL', EXIT.FAILURE],
    ];
    for (const [code, exit] of table) expect(exitCodeFor(new OrbitError(code, 'x')), code).toBe(exit);
    expect(exitCodeFor(new UsageError('x'))).toBe(EXIT.USAGE);
    expect(exitCodeFor(new Error('plain'))).toBe(EXIT.FAILURE);
  });

  it('maps a foreground run outcome to a distinct code', () => {
    expect(exitCodeForState('SUCCEEDED')).toBe(0);
    expect(new Set(['BLOCKED', 'EXHAUSTED', 'IMPOSSIBLE', 'CANCELLED'].map(exitCodeForState)).size).toBe(4);
  });
});

describe('house rules', () => {
  it('uses no em or en dashes in the CLI sources or its tests', () => {
    const roots = [fileURLToPath(new URL('../../../src/cli/', import.meta.url)), fileURLToPath(new URL('../../unit/cli/', import.meta.url)), fileURLToPath(new URL('../../integration/cli/', import.meta.url))];
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    roots.forEach(walk);
    expect(files.length).toBeGreaterThan(10);
    const dash = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);
    expect(files.filter((f) => dash.test(readFileSync(f, 'utf8')))).toEqual([]);
  });
});
