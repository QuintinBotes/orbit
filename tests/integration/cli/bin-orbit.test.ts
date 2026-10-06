/**
 * Nm9: `plugin/bin/orbit` says what is wrong when there is no usable Node, instead of `exec: node: not found` or a raw
 * SyntaxError from an old Node. The minimum comes from package.json "engines".
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BIN = join(ROOT, 'plugin', 'bin', 'orbit');
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A PATH holding only what the launcher needs from the system (dirname, readlink) and, optionally, a `node`. */
function pathWith(node?: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-bin-')));
  dirs.push(dir);
  for (const tool of ['dirname', 'readlink']) {
    const found = ['/usr/bin', '/bin'].map((d) => join(d, tool)).find((p) => existsSync(p));
    if (found) symlinkSync(found, join(dir, tool));
  }
  if (node !== undefined) {
    writeFileSync(join(dir, 'node'), node);
    chmodSync(join(dir, 'node'), 0o755);
  }
  return dir;
}

function run(pathDir: string, ...args: string[]) {
  return spawnSync('/bin/sh', [BIN, ...args], { encoding: 'utf8', env: { PATH: pathDir, HOME: pathDir } });
}

describe('plugin/bin/orbit', () => {
  it('names the problem and the minimum when there is no node on PATH', () => {
    const r = run(pathWith());
    expect(r.status).toBe(127);
    expect(r.stderr).toMatch(/Orbit needs Node\.js >= 22\.16, and no node was found on PATH/);
    expect(r.stderr).not.toMatch(/not found\n.*exec/s);
  });

  it('names the version it found when node is too old, instead of a SyntaxError', () => {
    const r = run(pathWith('#!/bin/sh\nif [ "$1" = "-p" ]; then echo 16.20.2; exit 0; fi\necho "SyntaxError: availableParallelism" >&2\nexit 1\n'));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Orbit needs Node\.js >= 22\.16, but node 16\.20\.2 is first on PATH/);
    expect(r.stderr).not.toMatch(/SyntaxError/);
  });

  it('accepts an exactly-minimum, newer minor and newer major node, and passes the arguments through', () => {
    for (const v of ['22.16.0', '22.20.1', '24.0.0']) {
      const r = run(pathWith(`#!/bin/sh\nif [ "$1" = "-p" ]; then echo ${v}; exit 0; fi\necho "ran: $*"\n`), '--version', 'x y');
      expect(r.status, v).toBe(0);
      expect(r.stdout, v).toContain('ran: ');
      expect(r.stdout).toContain('--version x y');
    }
  });

  it('refuses 22.15 and 21.x', () => {
    for (const v of ['22.15.9', '21.7.0', '20.0.0']) {
      const r = run(pathWith(`#!/bin/sh\nif [ "$1" = "-p" ]; then echo ${v}; exit 0; fi\n`));
      expect(r.status, v).toBe(1);
    }
  });

  it('states the same minimum as package.json engines', () => {
    const engines = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { engines: { node: string } }).engines.node;
    expect(engines).toBe('>=22.16');
    expect(readFileSync(BIN, 'utf8')).toContain('22.16');
  });

  it('works with the real node', () => {
    const real = pathWith();
    symlinkSync(process.execPath, join(real, 'node'));
    const r = run(real, '--version');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/\d+\.\d+\.\d+/);
  });
});
