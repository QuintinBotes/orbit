import { spawnSync } from 'node:child_process';
import { skipOrFailOnCi } from './skip.ts';

/**
 * Why this process cannot learn other processes' identity (start time, state, process group, the process table), or
 * null when it can. Linux reads /proc. macOS has none, so Orbit asks ps there, and a sandbox refuses ps: Orbit's own
 * check sandbox does (#203), and Orbit then treats an identity as unknown. A test that proves an identity skips there.
 */
export const PS_REFUSED: string | null = (() => {
  if (process.platform === 'linux') return null;
  const r = spawnSync('ps', ['-o', 'pid=', '-p', String(process.pid)], { stdio: 'ignore' });
  return r.error || r.status !== 0 ? `ps cannot run here (${r.error?.message ?? `exit ${String(r.status)}`}), as under Orbit's check sandbox on macOS` : null;
})();

/** Skip the current test, saying why (under CI: fail it), where ps is refused: `beforeEach(skipWithoutPs)`, or a test's first line. */
export function skipWithoutPs(ctx: { skip(condition: boolean, note?: string): void }): void {
  skipOrFailOnCi(ctx, PS_REFUSED);
}
