/** Hidden subcommands that Orbit invokes on itself: the worker shim and the check runner. */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { shimMain } from '../../adapters/shim.ts';
import { ensureShim } from '../../evidence/check-shim.ts';
import { EXIT } from '../exit.ts';
import type { CliContext } from '../context.ts';

/** `orbit shim --worker-dir D [...] -- <provider argv>`: supervise one provider process; see adapters/shim.ts. */
export async function shimCommand(rawArgs: readonly string[]): Promise<number> {
  return shimMain(rawArgs);
}

/**
 * `orbit check-runner <run-dir> <check-dir>`: run the check shim for one check
 * from the bundled copy of its source (the evidence runner normally spawns the
 * written file directly; this form exists so a check can be supervised by the
 * same binary that wrote it). Exits with the shim's own exit code.
 */
export async function checkRunnerCommand(rawArgs: readonly string[], ctx: CliContext): Promise<number> {
  const [runDir, checkDir, ...extra] = rawArgs;
  if (!runDir || !checkDir || extra.length > 0 || !isAbsolute(runDir) || !isAbsolute(checkDir)) {
    ctx.io.err('usage: orbit check-runner <absolute run dir> <absolute check dir>\n');
    return EXIT.USAGE;
  }
  mkdirSync(runDir, { recursive: true });
  const shim = ensureShim(runDir);
  return new Promise<number>((resolve) => {
    const child = spawn(process.execPath, [shim, checkDir], { stdio: 'inherit', env: process.env });
    child.on('error', (err) => {
      ctx.io.err(`check-runner: cannot start the check shim: ${err.message}\n`);
      resolve(EXIT.FAILURE);
    });
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 128 : EXIT.FAILURE)));
  });
}
