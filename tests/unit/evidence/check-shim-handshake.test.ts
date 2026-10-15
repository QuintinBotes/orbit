/**
 * The check shim's handshake, run for real: it records its own identity (registration.json) before it spawns the check,
 * gives the check its intent's token in the environment (ORBIT_CHECK_TOKEN), where a process-table search finds every
 * process of the check that kept it, and never leaves a check running that nothing on disk names: when pid.json cannot be
 * written after the spawn, it stops the check's group before it reports the error.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findProcesses, findProcessesWithEnv } from '../../../src/core/proc.ts';
import { CHECK_TOKEN_ENV, ensureShim, readJsonFile, shimPath, type ShimExit, type ShimRegistration } from '../../../src/evidence/check-shim.ts';

let root: string;
const marked: string[] = [];
afterEach(() => {
  for (const m of marked.splice(0)) {
    for (const pid of findProcesses((line) => line.includes(m))) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  }
  rmSync(root, { recursive: true, force: true });
});

/** Run the real check shim on `argv` in a fresh check directory, after `prepare` (fault injection), until it exits. */
async function runShim(argv: string[], prepare: (dir: string) => void = () => {}): Promise<{ dir: string; token: string; shimPid: number }> {
  root = mkdtempSync(join(tmpdir(), 'orbit-shim-hs-'));
  const dir = join(root, 'evidence', '1', 'unit');
  mkdirSync(dir, { recursive: true });
  const token = randomBytes(8).toString('hex');
  writeFileSync(shimPath(dir, 'intent'), JSON.stringify({ token, checkRunId: 'cr-1', argv, cwd: root, timeoutMs: 60_000, killGraceMs: 200, maxOutputBytes: 100_000, writtenAt: Date.now() }));
  prepare(dir);
  const shim = ensureShim(root);
  const child = spawn(process.execPath, [shim, dir, token], { cwd: dir, stdio: 'ignore', env: { PATH: process.env.PATH } });
  await new Promise<void>((done) => child.on('exit', () => done()));
  return { dir, token, shimPid: child.pid! };
}

async function until(pred: () => boolean, ms = 5_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

describe('the check shim', () => {
  it('registers itself before it spawns the check, and gives the check its token in the environment', async () => {
    const { dir, token, shimPid } = await runShim([process.execPath, '-e', `process.stdout.write('token=' + process.env.${CHECK_TOKEN_ENV})`]);
    expect(readJsonFile<ShimRegistration>(shimPath(dir, 'registration'))).toMatchObject({ token, shimPid, registeredAt: expect.any(Number) });
    expect(readJsonFile<ShimExit>(shimPath(dir, 'exit'))).toMatchObject({ token, exitCode: 0, error: null });
    expect(readFileSync(shimPath(dir, 'output'), 'utf8')).toBe(`token=${token}`);
  });

  it('stops its check and reports the error when pid.json cannot be written after the spawn, so nothing runs that no record names', async () => {
    const marker = `CHECK-${randomBytes(6).toString('hex')}`;
    marked.push(marker);
    // A directory where pid.json goes: the rename after the spawn fails (an ENOSPC or EIO stand-in).
    const { dir, token } = await runShim([process.execPath, '-e', 'setInterval(() => {}, 1000)', '--', marker], (d) => mkdirSync(join(d, 'pid.json', 'blocker'), { recursive: true }));
    const exit = readJsonFile<ShimExit>(shimPath(dir, 'exit'));
    expect(exit).toMatchObject({ token, exitCode: null });
    expect(exit!.error).toMatch(/could not record the check process/);
    expect(existsSync(shimPath(dir, 'registration'))).toBe(true);
    expect(await until(() => findProcesses((line) => line.includes(marker)).length === 0)).toBe(true);
    expect(findProcessesWithEnv(CHECK_TOKEN_ENV, token)).toEqual([]);
  });

  it('starts nothing, and says why, when it cannot register itself', async () => {
    const marker = `CHECK-${randomBytes(6).toString('hex')}`;
    marked.push(marker);
    const { dir, token } = await runShim([process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(join(tmpdir(), marker))}, 'ran')`], (d) => mkdirSync(join(d, 'registration.json', 'blocker'), { recursive: true }));
    const exit = readJsonFile<ShimExit>(shimPath(dir, 'exit'));
    expect(exit).toMatchObject({ token, exitCode: null });
    expect(exit!.error).toMatch(/could not register the check shim/);
    expect(existsSync(shimPath(dir, 'pid'))).toBe(false);
    expect(existsSync(join(tmpdir(), marker))).toBe(false);
  });
});
