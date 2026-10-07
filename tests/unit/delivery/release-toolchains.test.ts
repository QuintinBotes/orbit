// Release commands get the toolchain profile a check gets (issue #26; ADR 0009 and its addendum): the repository's
// dependency caches read-only, build state private to the command, and for .NET a home prepared as a check's, the NIS
// domain name rule and the runner's early stop for a refused MSBuild worker node. Before, a deploy or verify command ran
// with a fresh private HOME and nothing else: every dotnet command died at its first-run step under srt (measured on
// macOS: "The system cannot open the device or file specified. : 'NuGet-Migrations'"), there was no NuGet cache and no
// NIS rule, and a publish without -m:1 waited out MSBuild's node retries, past many a deploy's timeout (an UNKNOWN deploy).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { deliver } from '../../../src/delivery/deliver.ts';
import { performRelease, resolveDeploy } from '../../../src/delivery/release.ts';
import { NUGET_MIGRATIONS_DIR } from '../../../src/evidence/runner.ts';
import { NoIsolation } from '../../../src/isolation/none.ts';
import { toolchainCacheRoot } from '../../../src/isolation/toolchains.ts';
import type { IsolationProvider, SandboxProfile, WrappedCommand } from '../../../src/isolation/types.ts';
import { makeLab, type Lab } from '../../integration/delivery/harness.ts';

let lab: Lab | null = null;
afterEach(() => {
  lab?.cleanup();
  lab = null;
});

const MSBUILD_FAILURE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/environment', 'msbuild-node-pipe-denied.failure.txt'), 'utf8');
// Stands in for `dotnet publish` under srt: the refused node recorded, then a wait; srt exits 0 on SIGTERM (measured).
const REFUSED_NODE = `const fs = require('node:fs'); const dir = process.env.TMPDIR + '/MSBuildTempacme'; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(dir + '/MSBuild_pid-4242_01234567.failure.txt', ${JSON.stringify(MSBUILD_FAILURE)}); process.on('SIGTERM', () => process.exit(0)); setTimeout(() => {}, 120000);`;
const DEPLOY = ['dotnet', 'publish', 'Acme.csproj', '-c', 'Release'];
const VERIFY = ['dotnet', 'run', '--project', 'tools/Verify', '--no-build'];

interface Wrap {
  argv: string[];
  profile: SandboxProfile & { readablePaths: string[] };
  env: Record<string, string>;
  homePrepared: boolean;
}

/** A provider that records each wrap and runs `standIn` in its place (by default a process that exits 0). */
function recording(standIn: () => string[] = () => [process.execPath, '-e', '0']): { provider: IsolationProvider; wraps: Wrap[] } {
  const wraps: Wrap[] = [];
  const inner = new NoIsolation();
  const provider = {
    kind: 'sandbox-runtime' as const,
    available: () => inner.available(),
    wrap(argv: string[], profile: SandboxProfile, opts: { cwd: string; env: Record<string, string> }): WrappedCommand {
      wraps.push({ argv, profile: profile as Wrap['profile'], env: opts.env, homePrepared: existsSync(join(opts.env.HOME!, NUGET_MIGRATIONS_DIR, '1')) });
      return inner.wrap(standIn(), profile, opts);
    },
  };
  return { provider: provider as IsolationProvider, wraps };
}

/** A .NET repository in release mode with one environment, a candidate delivered, and the repository's cache root. */
async function released(provider: IsolationProvider, deploy: string[] = [...DEPLOY, '-m:1']) {
  const l = (lab = makeLab({
    mode: 'release',
    tweak: (cfg) => {
      cfg.delivery.pull_request = 'ready';
      cfg.actions.merge = true;
      cfg.actions.deploy_production = true;
      cfg.isolation = { ...cfg.isolation, provider: 'none', allow_unisolated: true };
      cfg.release = {
        merge: { method: 'squash', require_checks: [], delete_branch: false, mark_ready: true },
        environments: { preview: { deploy_command: deploy, allowed_branches: ['orbit/*'], require_ci_green: false, network_hosts: [], timeout_seconds: 60, verify_command: VERIFY } },
      };
    },
  }));
  const c = l.candidate('<Project Sdk="Microsoft.NET.Sdk" />\n', 'Acme.csproj');
  const ev = l.evidenceFor(c);
  const rv = l.reviewFor(c);
  const d = await deliver({ run: l.deliveryRun, candidate: c, evidence: ev, review: rv, snapshot: l.snapshot, ledger: l.ledger(), client: l.fake, clock: l.clock, report: { title: 't', summary: 's' } });
  const cacheRoot = toolchainCacheRoot(join(l.dir, 'orbit'), 'abcdefabcdef');
  const release = () =>
    performRelease({
      run: l.deliveryRun, candidate: c, evidence: ev, review: rv, snapshot: l.snapshot, ledger: l.ledger(), client: l.fake, clock: l.clock,
      commit: d.commit, pr: d.pr?.number ?? null, contractMerge: false, environment: 'preview', readiness: () => ({ ok: true, reasons: [] }),
      isolation: provider, workDir: join(l.dir, 'runs', l.runId), deployEnv: { ACME_DEPLOY_TOKEN: 'acme-token' }, toolchainCacheRoot: cacheRoot,
    });
  return { l, c, d, cacheRoot, release };
}

function expectDotnetProfile(w: Wrap, cache: string): void {
  expect(w.env.NUGET_PACKAGES).toBe(cache);
  expect(w.profile.readablePaths).toContain(cache);
  expect(w.profile.writablePaths).not.toContain(cache);
  expect(w.profile.writablePaths.some((p) => w.env.NUGET_HTTP_CACHE_PATH!.startsWith(p))).toBe(true);
  expect(w.env).toMatchObject({ DOTNET_CLI_HOME: w.env.HOME, DOTNET_NOLOGO: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', NuGetAudit: 'false' });
  expect(w.homePrepared).toBe(true);
  expect(w.profile.nisDomainName).toBe(true);
}

describe('release commands get the toolchain profile of a check (issue #26)', () => {
  it('deploys a .NET repository with its NuGet cache read-only, private build state, a prepared home and the NIS rule, the deploy credentials kept', async () => {
    const r = recording();
    const { cacheRoot, release } = await released(r.provider);
    const out = await release();
    expect(out.deploy).toMatchObject({ environment: 'preview', exitCode: 0 });
    const [w] = r.wraps;
    expect(w!.argv).toEqual([...DEPLOY, '-m:1']);
    expectDotnetProfile(w!, join(cacheRoot, 'nuget'));
    expect(w!.env.ACME_DEPLOY_TOKEN).toBe('acme-token');
    // The build state is gone with the deploy.
    expect(existsSync(w!.env.NUGET_HTTP_CACHE_PATH!)).toBe(false);
  });

  it('settles an unknown deploy with a verify command that gets the same profile', async () => {
    const r = recording();
    const { l, c, cacheRoot } = await released(r.provider);
    const ledger = l.ledger();
    const { action } = ledger.recordIntent({ runId: l.runId, kind: 'deploy', idempotencyKey: `release:${l.runId}:deploy:preview:${c.commitSha}`, target: { environment: 'preview', branch: 'orbit/x', sha: c.commitSha, command: ['x'] }, treeHash: c.treeHash, commitSha: c.commitSha });
    ledger.markExecuting(action);
    const res = await resolveDeploy({ run: l.deliveryRun, snapshot: l.snapshot, ledger, clock: l.clock, workDir: join(l.dir, 'runs', l.runId), resolution: 'verify', by: 'acme-operator', isolation: r.provider, toolchainCacheRoot: cacheRoot });
    expect(res.verdict).toBe('deployed');
    const [w] = r.wraps;
    expect(w!.argv).toEqual(VERIFY);
    expect(w!.env.ORBIT_RELEASE_VERIFY).toBe('1');
    expectDotnetProfile(w!, join(cacheRoot, 'nuget'));
  });

  it('stops a deploy as soon as MSBuild records a refused worker node, a definite failure with the note and the deploy command pinned', async () => {
    const r = recording(() => [process.execPath, '-e', REFUSED_NODE]);
    const { release } = await released(r.provider, DEPLOY);
    const started = Date.now();
    const err = await release().then(() => null, (e: unknown) => e as { code: string; message: string; details: Record<string, unknown> });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(err).toMatchObject({ code: 'DELIVERY_FAILED', details: expect.objectContaining({ definitive: true }) });
    expect(err!.details).not.toHaveProperty('outcomeUnknown');
    expect(err!.message).toContain('the sandbox of the deploy command denied MSBuild node (pid 4242) its named pipe /tmp/MSBuild4242 (System.Net.Sockets.SocketException (13): Permission denied); MSBuild waits 30 s for each of ten node starts before it fails, so Orbit stopped the deploy command.');
    expect(err!.message).toContain('Fix: release.environments.preview.deploy_command: ["dotnet", "publish", "Acme.csproj", "-c", "Release", "-m:1"]');
  }, 60_000);
});
