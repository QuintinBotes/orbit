/**
 * The stand-alone source entries of the guard hook and the worker shim. Each
 * runs on import, so they are loaded in this process with the module they
 * call replaced by a recorder, and the effect on the process exit code is
 * checked and then undone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runGuardHookProcess = vi.fn(async () => {});
const shimMain = vi.fn(async (_args: readonly string[]) => 0);

vi.mock('../../../src/policy/guard-hook.ts', () => ({ runGuardHookProcess: () => runGuardHookProcess() }));
vi.mock('../../../src/adapters/shim.ts', () => ({ shimMain: (args: readonly string[]) => shimMain(args) }));

let savedArgv: string[];
let savedExitCode: typeof process.exitCode;
beforeEach(() => {
  savedArgv = process.argv;
  savedExitCode = process.exitCode;
  runGuardHookProcess.mockClear();
  shimMain.mockClear();
  vi.resetModules();
});
afterEach(() => {
  process.argv = savedArgv;
  process.exitCode = savedExitCode;
});

describe('src/adapters/hook-main.ts', () => {
  it('runs the guard hook process once when it is loaded', async () => {
    await import('../../../src/adapters/hook-main.ts');
    expect(runGuardHookProcess).toHaveBeenCalledTimes(1);
  });

  it('waits for the guard to finish before the module is considered loaded', async () => {
    let finished = false;
    runGuardHookProcess.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 30));
      finished = true;
    });
    await import('../../../src/adapters/hook-main.ts');
    expect(finished).toBe(true);
  });
});

describe('src/adapters/shim-main.ts', () => {
  it('hands everything after the script path to shimMain and uses its result as the exit code', async () => {
    process.argv = ['node', '/x/shim-main.ts', '--worker-dir', '/w', '--', 'provider', '-p'];
    shimMain.mockResolvedValueOnce(2);
    await import('../../../src/adapters/shim-main.ts');
    expect(shimMain).toHaveBeenCalledWith(['--worker-dir', '/w', '--', 'provider', '-p']);
    expect(process.exitCode).toBe(2);
  });

  it('exits 0 when the shim finished normally', async () => {
    process.argv = ['node', '/x/shim-main.ts'];
    process.exitCode = 9;
    await import('../../../src/adapters/shim-main.ts');
    expect(shimMain).toHaveBeenCalledWith([]);
    expect(process.exitCode).toBe(0);
  });
});
