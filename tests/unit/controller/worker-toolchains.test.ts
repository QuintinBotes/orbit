// A worker's toolchain profile (docs/decisions/0009-toolchain-profiles.md): the repository's dependency caches
// read-only, its build state private to the worker, and nothing pointing at the user's own caches.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { repoKey } from '../../../src/controller/context.ts';
import { implementingStep } from '../../../src/controller/steps/implementing.ts';
import { NUGET_MIGRATIONS_DIR } from '../../../src/evidence/runner.ts';
import { nugetUserConfigPath, toolchainLayout } from '../../../src/isolation/toolchains.ts';
import { giveRepository, initLedger, makeUnitLab, okResult, scriptedAdapter, setContract, validateModels, type UnitLab } from './coverage-helpers.ts';

// The real layout, watched: a worker's NuGet audit depends on the hosts its sandbox allows (see the last test).
vi.mock('../../../src/isolation/toolchains.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/isolation/toolchains.ts')>();
  return { ...actual, toolchainLayout: vi.fn(actual.toolchainLayout) };
});

let lab: UnitLab;
afterEach(() => lab?.cleanup());

const IMPL = { summary: 's', changed_paths: [], tests_added: [], checks_run: [], evidence_refs: [], remaining_issues: [], next_action: { kind: 'request-verification', detail: 'd' } };

describe('worker toolchain profiles', () => {
  it('gives an implementer in a Rust repository the repository cache read-only and private build state in its worker directory', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'], deps: { schedulerProbe: { availableParallelism: () => 16, freemem: () => 64_000 * 1024 * 1024 } } });
    const adapter = scriptedAdapter(lab, () => okResult(IMPL));
    lab.deps.adapters = { claude: adapter };
    validateModels(lab);
    const repo = await giveRepository(lab, { 'Cargo.toml': '[package]\nname = "acme"\n', 'apps/lib.rs': 'pub fn add() {}\n' });
    setContract(lab, { baseline_revision: repo.base });
    initLedger(lab);
    await implementingStep(lab.ctx());
    const spec = adapter.specs[0]!;
    const cache = join(lab.home, 'toolchains', repoKey(lab.repo), 'cargo');
    expect(spec.env).toMatchObject({ CARGO_HOME: cache, CARGO_TARGET_DIR: join(spec.workerDir, 'toolchains', 'cargo-target') });
    expect(spec.env).not.toHaveProperty('GOMODCACHE');
    const sandbox = spec.sandbox as typeof spec.sandbox & { readablePaths: string[] };
    expect(sandbox.readablePaths).toContain(cache);
    expect(sandbox.writablePaths).not.toContain(cache);
    expect(sandbox.writablePaths.some((p) => join(spec.workerDir, 'toolchains').startsWith(p))).toBe(true);
    expect(existsSync(cache)).toBe(true);
    // Not a .NET repository: no NIS domain name rule.
    expect(spec.sandbox.nisDomainName).toBeFalsy();
  });

  // .NET's CookieContainer reads the NIS domain name, which srt's Seatbelt profile does not allow, so every .NET HTTP
  // client failed under srt on macOS (ADR 0009, addendum). A worker in a .NET repository may run its tests itself.
  it('lets an implementer in a .NET repository read the NIS domain name', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'], deps: { schedulerProbe: { availableParallelism: () => 16, freemem: () => 64_000 * 1024 * 1024 } } });
    const adapter = scriptedAdapter(lab, () => okResult(IMPL));
    lab.deps.adapters = { claude: adapter };
    validateModels(lab);
    const repo = await giveRepository(lab, { 'acme.sln': '', 'apps/Acme.cs': 'namespace Acme;\n' });
    setContract(lab, { baseline_revision: repo.base });
    initLedger(lab);
    await implementingStep(lab.ctx());
    expect(adapter.specs[0]!.sandbox.nisDomainName).toBe(true);
  });

  it('gives a .NET worker a prepared private CLI home before it starts, without making the account home writable to it', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'], deps: { schedulerProbe: { availableParallelism: () => 16, freemem: () => 64_000 * 1024 * 1024 } } });
    const adapter = scriptedAdapter(
      lab,
      () => okResult(IMPL),
      (spec) => {
        const cliHome = spec.env.DOTNET_CLI_HOME!;
        expect(existsSync(join(cliHome, NUGET_MIGRATIONS_DIR, '1')), 'the private CLI home is ready before the adapter starts the worker').toBe(true);
      },
    );
    lab.deps.adapters = { claude: adapter };
    validateModels(lab);
    const repo = await giveRepository(lab, { 'acme.sln': '', 'apps/Acme.cs': 'namespace Acme;\n' });
    setContract(lab, { baseline_revision: repo.base });
    initLedger(lab);

    await implementingStep(lab.ctx());

    const spec = adapter.specs[0]!;
    const cliHome = spec.env.DOTNET_CLI_HOME!;
    expect(spec.env).toMatchObject({ DOTNET_CLI_HOME: cliHome, DOTNET_NOLOGO: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1' });
    expect(cliHome).not.toBe(lab.deps.homeDir!);
    expect(existsSync(nugetUserConfigPath(lab.deps.homeDir!))).toBe(false);
    const sandbox = spec.sandbox;
    expect(sandbox.writablePaths).toContain(cliHome);
    expect(sandbox.writablePaths).not.toContain(lab.deps.homeDir!);
  });

  // NuGet's vulnerability audit is off in a worker unless the worker's sandbox lets it reach the package source and it
  // is not on macOS, where .NET under srt cannot verify nuget.org's certificate (isolation/toolchains.ts): the layout
  // gets exactly the hosts the worker's sandbox allows, its provider's and the policy's.
  it('turns NuGet\'s vulnerability audit off for an implementer in a .NET repository unless its network has the package source, off macOS', async () => {
    for (const [i, extra] of [[], ['api.nuget.org']].entries()) {
      if (i > 0) lab.cleanup();
      lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'], tweak: (c) => void c.network.allowed_hosts.push(...extra), deps: { schedulerProbe: { availableParallelism: () => 16, freemem: () => 64_000 * 1024 * 1024 } } });
      const adapter = scriptedAdapter(lab, () => okResult(IMPL));
      lab.deps.adapters = { claude: adapter };
      validateModels(lab);
      const repo = await giveRepository(lab, { 'acme.sln': '', 'apps/Acme.cs': 'namespace Acme;\n' });
      setContract(lab, { baseline_revision: repo.base });
      initLedger(lab);
      vi.mocked(toolchainLayout).mockClear();
      await implementingStep(lab.ctx());
      const spec = adapter.specs[0]!;
      const layouts = vi.mocked(toolchainLayout).mock.calls.map(([input]) => input).filter((input) => input.mode === 'worker');
      expect(layouts).toHaveLength(1);
      expect([...layouts[0]!.networkHosts].sort(), JSON.stringify(extra)).toEqual([...spec.sandbox.allowedHosts].sort());
      expect(spec.sandbox.allowedHosts.includes('api.nuget.org'), JSON.stringify(extra)).toBe(extra.length > 0);
      expect(spec.env.NuGetAudit, JSON.stringify(extra)).toBe(extra.length > 0 && process.platform !== 'darwin' ? undefined : 'false');
    }
  });
});
