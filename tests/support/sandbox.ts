import { fileURLToPath } from 'node:url';
import { SandboxRuntimeIsolation } from '../../src/isolation/sandbox-runtime.ts';
import { skipOrFailOnCi } from './skip.ts';

/**
 * Why no sandbox can start here, or null when one can: srt's own probe, once per test file, as the srt tests probe srt.
 * Claude Code's sandbox (the claude-sandbox tier) is srt too, and neither starts inside another sandbox, such as the one
 * Orbit runs a command check in on macOS (#206).
 */
const probe = await new SandboxRuntimeIsolation({ orbitInstallDir: fileURLToPath(new URL('../../', import.meta.url)) }).available();
export const SANDBOX_REFUSED: string | null = probe.ok ? null : `no sandbox can start here (${probe.detail}), as inside Orbit's check sandbox on macOS`;

/** Skip the current test, saying why (under CI: fail it), where no sandbox can start: a claude-sandbox tier test's first line. */
export function skipWithoutSandbox(ctx: { skip(condition: boolean, note?: string): void }): void {
  skipOrFailOnCi(ctx, SANDBOX_REFUSED);
}
