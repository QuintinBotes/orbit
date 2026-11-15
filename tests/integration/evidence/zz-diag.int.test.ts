// TEMPORARY diagnostic for PR #179: removed before merge.
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { checkSandboxCheck } from '../../../src/cli/commands/doctor-sandbox.ts';
import { SandboxRuntimeIsolation } from '../../../src/isolation/sandbox-runtime.ts';
import { defaultCheck, defaultConfig } from '../../../src/policy/config.ts';

const provider = new SandboxRuntimeIsolation({ orbitInstallDir: resolve(dirname(fileURLToPath(import.meta.url)), '../../..') });
const temp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));

it.skipIf(process.env.ORBIT_DIAG !== '1')('diag', async () => {
  const probe = await provider.available();
  console.log('DIAG probe', JSON.stringify(probe), 'tmpdir', tmpdir());
  for (const [name, body] of [
    ['mkdir', (t: string) => `mkdir ${JSON.stringify(t)} || exit 1`],
    ['touch', (t: string) => `touch ${JSON.stringify(t)} || exit 1`],
    ['redirect', (t: string) => `: > ${JSON.stringify(t)} || exit 1`],
    ['inside', () => 'mkdir ./ok && touch ./ok/f || exit 1'],
  ] as const) {
    const outside = temp('orbit-diag-denied-');
    const target = join(outside, 'cache');
    const tool = join(temp('orbit-diag-tool-'), 'acme-tool');
    writeFileSync(tool, `#!/bin/sh\n${body(target)}\n`, { mode: 0o755 });
    const config = defaultConfig('autonomous');
    config.checks = { build: { ...defaultCheck('build'), command: [tool], mandatory: true } };
    const c = await checkSandboxCheck({ config, repo: temp('orbit-diag-repo-'), provider, available: true, env: process.env, homeDir: homedir() });
    console.log('DIAG', name, JSON.stringify({ status: c.status, details: c.details, wroteOutside: existsSync(target) }));
  }
  expect(true).toBe(true);
}, 120_000);
