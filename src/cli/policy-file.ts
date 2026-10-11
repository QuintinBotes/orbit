/**
 * Policy-file handling shared by commands that operate on a policy before a
 * run exists. Keeping this here makes `doctor --policy` resolve and reject a
 * path in exactly the same way as `run --policy`.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { OrbitError } from '../core/errors.ts';
import { loadConfig, type ConfigOptions } from '../policy/index.ts';
import type { OrbitConfig } from '../policy/types.ts';

/** Resolve and require an explicitly supplied policy file, as `orbit run` does. */
export function explicitPolicyPath(cwd: string, policy: string | undefined): string | undefined {
  if (policy === undefined) return undefined;
  const path = resolve(cwd, policy);
  if (!existsSync(path)) throw new OrbitError('NOT_FOUND', `policy file ${path} does not exist; check the --policy path`);
  return path;
}

/** Load the default repository policy or an explicitly selected policy file. */
export function loadCommandPolicy(repo: string, cwd: string, policy: string | undefined, opts: Omit<ConfigOptions, 'source'> = {}): OrbitConfig {
  const path = explicitPolicyPath(cwd, policy);
  // Keep the established `run --policy` distinction: an omitted or empty
  // value loads the repository default after checking an explicitly supplied
  // empty path exactly as run historically did.
  return loadConfig(repo, policy ? path : undefined, opts);
}
