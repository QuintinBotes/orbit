import { spawn } from 'node:child_process';
import type { WrappedCommand } from '../../../src/isolation/types.ts';

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn a wrapped command the way the evidence runner does: its own process
 * group, so the deadline (or a test) can kill everything it started.
 */
export function runWrapped(
  w: WrappedCommand,
  cwd: string,
  opts: { timeoutMs?: number; killAfterMs?: number; killSignal?: NodeJS.Signals; onSpawn?: (pid: number) => void } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const [file, ...args] = w.argv;
    const child = spawn(file!, args, { cwd, env: w.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, signal);
      } catch {
        /* gone */
      }
    };
    const deadline = setTimeout(() => killGroup('SIGKILL'), opts.timeoutMs ?? 30_000);
    const early = opts.killAfterMs === undefined ? null : setTimeout(() => killGroup(opts.killSignal ?? 'SIGTERM'), opts.killAfterMs);
    if (child.pid !== undefined) opts.onSpawn?.(child.pid);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(deadline);
      if (early) clearTimeout(early);
      resolve({ code, signal, stdout, stderr });
    });
  });
}
