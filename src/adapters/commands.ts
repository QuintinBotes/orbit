/**
 * How Orbit invokes itself from a worker: the shim that supervises the
 * provider process, and the PreToolUse guard hook Claude Code runs before
 * each tool call. In the shipped bundle both are subcommands of
 * dist/orbit.mjs; from source (tests, development) they are the
 * stand-alone entries next to this file, run with Node's type stripping.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface OrbitCommands {
  shim: string[];
  hook: string[];
}

/** Commands for an explicit Orbit entry script (dist/orbit.mjs). */
export function orbitCommands(entry: string, node: string = process.execPath): OrbitCommands {
  return { shim: [node, entry, 'shim'], hook: [node, entry, 'hook', 'pre-tool-use'] };
}

/** Commands that run the TypeScript sources directly (Node >= 22.18 strips types by default). */
export function sourceCommands(node: string = process.execPath): OrbitCommands {
  const here = dirname(fileURLToPath(import.meta.url));
  return { shim: [node, '--no-warnings', join(here, 'shim-main.ts')], hook: [node, '--no-warnings', join(here, 'hook-main.ts')] };
}

/**
 * The bundle when this code runs from it, the sources otherwise. The bundle
 * is a single .mjs file, so this module's own URL names it.
 */
export function defaultOrbitCommands(self: string = fileURLToPath(import.meta.url)): OrbitCommands {
  if (self.endsWith('.mjs') && existsSync(self)) return orbitCommands(self);
  return sourceCommands();
}
