import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoIsolation } from '../../../src/isolation/none.ts';
import { deliver } from '../../../src/delivery/deliver.ts';
import { performRelease } from '../../../src/delivery/release.ts';
import { makeLab, type Lab } from '../../integration/delivery/harness.ts';

// The platform the release module sees; everything else in node:os is real.
const os = vi.hoisted(() => ({ platform: 'darwin' as string }));
vi.mock('node:os', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:os')>()), platform: () => os.platform }));

let lab: Lab | null = null;
afterEach(() => {
  vi.unstubAllEnvs();
  lab?.cleanup();
  lab = null;
});

/**
 * Delivers a candidate, then runs a release whose deploy command evaluates `script` and returns what it printed.
 * `withoutPath` removes PATH from the controller's environment for the release step only (delivery needs git).
 */
async function deployOutput(script: string, withoutPath = false): Promise<string> {
  const l = (lab = makeLab({
    mode: 'release',
    tweak: (cfg) => {
      cfg.delivery.pull_request = 'ready';
      cfg.actions.merge = true;
      cfg.actions.deploy_production = true;
      cfg.isolation = { ...cfg.isolation, provider: 'none', allow_unisolated: true };
      cfg.release = {
        merge: { method: 'squash', require_checks: [], delete_branch: false, mark_ready: true },
        environments: { preview: { deploy_command: [process.execPath, '-e', script], allowed_branches: ['orbit/*'], require_ci_green: false, network_hosts: [], timeout_seconds: 60, verify_command: null } },
      };
    },
  }));
  const c = l.candidate('x');
  const ev = l.evidenceFor(c);
  const rv = l.reviewFor(c);
  const d = await deliver({ run: l.deliveryRun, candidate: c, evidence: ev, review: rv, snapshot: l.snapshot, ledger: l.ledger(), client: l.fake, clock: l.clock, report: { title: 't', summary: 's' } });
  if (withoutPath) vi.stubEnv('PATH', undefined as unknown as string);
  const r = await performRelease({
    run: l.deliveryRun, candidate: c, evidence: ev, review: rv, snapshot: l.snapshot, ledger: l.ledger(), client: l.fake, clock: l.clock,
    commit: d.commit, pr: d.pr?.number ?? null, contractMerge: false, environment: 'preview', readiness: () => ({ ok: true, reasons: [] }),
    isolation: new NoIsolation(), workDir: join(l.dir, 'runs', l.runId),
  });
  return r.deploy!.output.trim();
}

describe('the deploy command environment follows the platform', () => {
  it('uses the macOS locale on darwin', async () => {
    os.platform = 'darwin';
    expect(await deployOutput('console.log(process.env.LANG)')).toBe('en_US.UTF-8');
  });

  it('uses the C.UTF-8 locale on every other platform', async () => {
    os.platform = 'linux';
    expect(await deployOutput('console.log(process.env.LANG)')).toBe('C.UTF-8');
  });

  it('falls back to a minimal PATH when the controller has none', async () => {
    os.platform = 'linux';
    expect(await deployOutput('console.log(process.env.PATH)', true)).toBe('/usr/bin:/bin');
  });
});
