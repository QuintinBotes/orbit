/**
 * Ubuntu 26.04 as installed (#181): AppArmor's bwrap-userns-restrict profile leaves what bubblewrap starts no
 * capabilities in its user namespace, so neither srt's sandbox nor Claude Code's (the claude-sandbox tier) can start.
 * Orbit refuses rather than run with less isolation, and doctor names the cause and the fix. Runs where
 * ORBIT_STOCK_APPARMOR=1 says the host is such an Ubuntu: CI's "sandbox (ubuntu-26.04, stock AppArmor)" job, which then
 * applies the fix doctor names and runs the sandbox tests. Skipped everywhere else.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const BUNDLE = fileURLToPath(new URL('../../../plugin/dist/orbit.mjs', import.meta.url));

describe.skipIf(process.env.ORBIT_STOCK_APPARMOR !== '1')('Ubuntu 26.04 with AppArmor as installed (#181; runs where ORBIT_STOCK_APPARMOR=1)', () => {
  it('doctor fails isolation, naming the bwrap-userns-restrict profile and the AppArmor change that lets the sandbox start', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orbit-apparmor-'));
    try {
      spawnSync('git', ['init', '-q'], { cwd: repo });
      const r = spawnSync(process.execPath, [BUNDLE, 'doctor', '--json'], { cwd: repo, encoding: 'utf8', timeout: 120_000 });
      const checks = (JSON.parse(r.stdout) as { checks: { id: string; status: string; summary: string; fix: string | null }[] }).checks;
      const iso = checks.find((c) => c.id === 'isolation');
      expect(iso?.status).toBe('fail');
      expect(iso?.summary).toContain('apply-seccomp: write /proc/self/setgroups (nested userns is capability-restricted');
      expect(iso?.summary).toContain("AppArmor's bwrap-userns-restrict profile, the default on Ubuntu 26.04");
      expect(iso?.fix).toContain('sudo apparmor_parser -r /etc/apparmor.d/bwrap');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
