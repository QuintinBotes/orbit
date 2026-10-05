/** P22: a reader that closes the pipe early (`orbit help | head -1`) is not an error and prints no stack. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ENTRY = fileURLToPath(new URL('../../../src/cli/main.ts', import.meta.url));

function runWithClosedStdout(args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    // The reader goes away before the CLI has written anything: the next write is EPIPE.
    child.stdout.destroy();
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

describe('closed pipes', () => {
  it('"orbit help" with its reader gone exits 0 and prints no stack', async () => {
    const r = await runWithClosedStdout(['help']);
    expect(r.stderr).not.toMatch(/EPIPE|Error:|at .*node:/);
    expect(r.code).toBe(0);
  });

  it('a command that writes its output in many pieces ends quietly too', async () => {
    const r = await runWithClosedStdout(['help', 'exit-codes']);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
  });
});
