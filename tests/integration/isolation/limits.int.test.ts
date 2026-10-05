import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { findLimitShell, withResourceLimits } from '../../../src/isolation/limits.ts';
import { SandboxRuntimeIsolation } from '../../../src/isolation/sandbox-runtime.ts';
import type { SandboxProfile } from '../../../src/isolation/types.ts';
import type { IsolationLimits } from '../../../src/policy/types.ts';
import { tempRoot } from '../../unit/isolation/fixtures.ts';
import { runWrapped } from './run.ts';

/**
 * The ulimit wrapper on this host's real bash (macOS and Linux alike), and
 * under the real srt when it is available. Values are read back from inside
 * the command, and the file size limit is exercised by writing past it.
 */
const bash = findLimitShell();
const LIMITS: IsolationLimits = { cpu_seconds: 37, max_processes: 1500, max_file_mb: 1, memory_mb: null };
/** What `ulimit -u` reads back on this host after asking for `n` (no higher than the hard limit; macOS caps the reading at kern.maxprocperuid). */
function effectiveProcessLimit(n: number): number {
  const hard = spawnSync('/bin/bash', ['-c', 'ulimit -H -u'], { encoding: 'utf8' }).stdout.trim();
  const want = hard === 'unlimited' ? n : Math.min(n, Number(hard));
  return Number(spawnSync('/bin/bash', ['-c', `ulimit -u ${want} && ulimit -u`], { encoding: 'utf8' }).stdout.trim());
}

const READ_BACK = 'echo "t=$(ulimit -t) u=$(ulimit -u) f=$(ulimit -f) H=$(ulimit -H -t)"';

describe.skipIf(!bash)('isolation.limits with the host bash', () => {
  const t = tempRoot('orbit-limits-int-');
  afterAll(() => t.remove());

  it('sets CPU time, process count and file size as hard limits for the command', () => {
    // bash, not /bin/sh: dash (Ubuntu's /bin/sh) has no ulimit -u.
    const argv = withResourceLimits(['/bin/bash', '-c', READ_BACK], LIMITS);
    const r = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8' });
    expect(r.status).toBe(0);
    // /bin/sh reports -f in its own unit (512- or 1024-byte blocks); either way it is 1 MB.
    const m = /^t=(\d+) u=(\d+) f=(\d+) H=(\d+)$/.exec(r.stdout.trim());
    expect(m, r.stdout + r.stderr).not.toBeNull();
    expect(Number(m![1])).toBe(37);
    // The wrapper keeps a stricter host limit, and macOS reports at most kern.maxprocperuid: expect what this host shows for 1500.
    expect(Number(m![2])).toBe(effectiveProcessLimit(1500));
    expect([1024, 2048]).toContain(Number(m![3]));
    expect(Number(m![4])).toBe(37);
  });

  it('stops a write past max_file_mb and keeps the command from raising its limits', () => {
    const file = join(t.root, 'big.bin');
    const argv = withResourceLimits(['/bin/sh', '-c', `head -c 3000000 /dev/zero > "$1"; echo "write=$?"; ulimit -t 1000 2>/dev/null; echo "raise=$?"`, 'sh', file], LIMITS);
    const r = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8' });
    expect(r.stdout).not.toContain('write=0');
    expect(r.stdout).toMatch(/raise=[1-9]/);
    expect(existsSync(file) ? statSync(file).size : 0).toBeLessThanOrEqual(1024 * 1024);
  });
});

const orbitInstallDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const srtProbe = new SandboxRuntimeIsolation({ orbitInstallDir });
const status = await srtProbe.available();

describe.skipIf(!status.ok || !bash)('isolation.limits under the real srt', () => {
  const t = status.ok ? tempRoot('orbit-limits-srt-') : { root: '/nonexistent-orbit-test', remove: () => {} };
  afterAll(() => t.remove());

  it('applies the limits inside the sandbox', async () => {
    const provider = new SandboxRuntimeIsolation({ orbitInstallDir, limits: LIMITS });
    const profile: SandboxProfile = { writablePaths: [t.root], denyReadPaths: [], allowedHosts: [], limits: { timeoutMs: 30_000, memoryMb: null, cpus: null, pids: null } };
    const w = provider.wrap([bash!, '-c', READ_BACK], profile, { cwd: t.root, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: t.root } });
    try {
      const r = await runWrapped(w, t.root);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toMatch(new RegExp(`t=37 u=${effectiveProcessLimit(1500)} f=(1024|2048) H=37`));
    } finally {
      w.cleanup();
    }
  });
});
