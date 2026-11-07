// A worker's toolchain profile (docs/decisions/0009-toolchain-profiles.md): the repository's dependency caches
// read-only, its build state private to the worker, and nothing pointing at the user's own caches.
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderClaudeSettings } from '../../../src/adapters/claude-settings.ts';
import { repoKey } from '../../../src/controller/context.ts';
import { implementingStep } from '../../../src/controller/steps/implementing.ts';
import { orbitTmpRoot, workerTmpDir } from '../../../src/isolation/profiles.ts';
import { removeScratch, toolchainLayout } from '../../../src/isolation/toolchains.ts';
import { readablePathsOf } from '../../../src/isolation/util.ts';
import { giveRepository, initLedger, makeUnitLab, okResult, scriptedAdapter, setContract, validateModels, type UnitLab } from './coverage-helpers.ts';

// The real layout, watched: a worker's NuGet audit depends on the hosts its sandbox allows (see the last test).
vi.mock('../../../src/isolation/toolchains.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/isolation/toolchains.ts')>();
  return { ...actual, toolchainLayout: vi.fn(actual.toolchainLayout) };
});

// A process the worker started that outlived its session: before every filesystem call the controller makes, it swaps
// each build-state directory in the worker's temp directory, and every directory in one, for a link to `outside`.
const adversary = vi.hoisted(() => ({ tmp: null as string | null, outside: '', moved: 0 }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const strike = (): void => {
    const tmp = adversary.tmp;
    if (tmp === null || !fs.existsSync(tmp)) return;
    for (const name of fs.readdirSync(tmp)) {
      const p = join(tmp, name);
      if (!name.startsWith('toolchains') || fs.lstatSync(p).isSymbolicLink()) continue;
      for (const child of fs.readdirSync(p)) {
        const c = join(p, child);
        if (!fs.lstatSync(c).isSymbolicLink()) {
          fs.rmSync(c, { recursive: true, force: true });
          fs.symlinkSync(join(adversary.outside, 'cargo-target'), c);
        }
      }
      fs.renameSync(p, join(tmp, `.moved-${adversary.moved++}`));
      fs.symlinkSync(adversary.outside, p);
    }
  };
  const watched = ['mkdirSync', 'chmodSync', 'lstatSync', 'mkdtempSync', 'renameSync', 'rmSync', 'readdirSync'] as const;
  const over = Object.fromEntries(watched.map((n) => [n, (...a: unknown[]) => (strike(), (fs[n] as (...x: unknown[]) => unknown)(...a))]));
  return { ...fs, ...over, default: { ...fs, ...over } };
});

let lab: UnitLab;
const tmps: string[] = [];
afterEach(() => {
  adversary.tmp = null;
  lab?.cleanup();
  for (const t of tmps.splice(0)) removeScratch(t);
});

const IMPL = { summary: 's', changed_paths: [], tests_added: [], checks_run: [], evidence_refs: [], remaining_issues: [], next_action: { kind: 'request-verification', detail: 'd' } };

describe('worker toolchain profiles', () => {
  // Issue #140: the build state sits in the worker's private temp directory, which Bash may write in both tiers. Under
  // the worker directory the claude-sandbox tier denied it (its Edit deny becomes a sandbox denyWrite).
  it('gives an implementer in a Rust repository the repository cache read-only and private build state in its temp directory', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'], deps: { schedulerProbe: { availableParallelism: () => 16, freemem: () => 64_000 * 1024 * 1024 } } });
    const adapter = scriptedAdapter(lab, () => okResult(IMPL));
    lab.deps.adapters = { claude: adapter };
    validateModels(lab);
    const repo = await giveRepository(lab, { 'Cargo.toml': '[package]\nname = "acme"\n', 'apps/lib.rs': 'pub fn add() {}\n' });
    setContract(lab, { baseline_revision: repo.base });
    initLedger(lab);
    const ctx = lab.ctx();
    await implementingStep(ctx);
    const spec = adapter.specs[0]!;
    const tmp = workerTmpDir(spec.workerDir);
    tmps.push(tmp);
    const target = spec.env.CARGO_TARGET_DIR!;
    const cache = join(lab.home, 'toolchains', repoKey(lab.repo), 'cargo');
    expect(spec.env.CARGO_HOME).toBe(cache);
    expect(target).toMatch(new RegExp(`^${tmp}/toolchains-[A-Za-z0-9]{6}/cargo-target$`));
    expect(target.startsWith(`${spec.workerDir}/`)).toBe(false);
    expect(spec.env).not.toHaveProperty('GOMODCACHE');
    const sandbox = spec.sandbox as typeof spec.sandbox & { readablePaths: string[] };
    expect(sandbox.readablePaths).toContain(cache);
    expect(sandbox.writablePaths).not.toContain(cache);
    expect(sandbox.writablePaths).toContain(tmp);
    expect(existsSync(cache)).toBe(true);
    // Created owner-only before the layout was prepared in it.
    expect(statSync(tmp).mode & 0o777).toBe(0o700);
    expect(existsSync(target)).toBe(true);
    // Not a .NET repository: no NIS domain name rule.
    expect(spec.sandbox.nisDomainName).toBeFalsy();

    // The claude-sandbox tier's settings let Bash write it, and no Edit deny (a sandbox denyWrite) covers it.
    const settings = renderClaudeSettings({
      snapshot: ctx.snapshot,
      worktree: spec.cwd,
      workerDir: spec.workerDir,
      policyPath: spec.policyPath,
      tier: 'claude-sandbox',
      readOnly: spec.readOnly,
      hookCommand: ['orbit', 'hook'],
      denyReadPaths: spec.sandbox.denyReadPaths,
      readablePaths: readablePathsOf(spec.sandbox),
      tmpDir: tmp,
      claudeConfigDir: join(lab.home, '.claude'),
      otherClaudeLogins: [],
    });
    const fs = settings.sandbox.enabled ? settings.sandbox.filesystem : null;
    expect(fs!.allowWrite.some((p) => target.startsWith(`${p}/`))).toBe(true);
    const editDenies = settings.permissions.deny.filter((r) => r.startsWith('Edit(')).map((r) => r.slice('Edit(/'.length, -1).replace(/\/\*\*$/, ''));
    expect(editDenies.filter((p) => target === p || target.startsWith(`${p}/`))).toEqual([]);

    // Private to this worker: every other worker's temp directory is another path, and the whole temp root stays
    // read-denied to this one but for its own directory.
    const other = workerTmpDir(join(dirname(spec.workerDir), 'another-worker'));
    expect(other).not.toBe(tmp);
    expect(target.startsWith(`${other}/`)).toBe(false);
    expect(spec.sandbox.denyReadPaths).toContain(orbitTmpRoot());
    expect(sandbox.writablePaths).not.toContain(orbitTmpRoot());
    expect(fs!.allowWrite).not.toContain(orbitTmpRoot());
  });

  // Review of #140: the controller runs outside any sandbox, so a link the worker's lingering process swaps in while
  // its build state is prepared must never lead it to create, chmod or remove anything elsewhere.
  it('creates, changes and removes nothing outside the worker\'s temp directory while a process it left swaps in links', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-outside-')));
    tmps.push(outside);
    mkdirSync(join(outside, 'cargo-target'));
    writeFileSync(join(outside, 'cargo-target', 'keep'), 'x');
    chmodSync(outside, 0o755);
    chmodSync(join(outside, 'cargo-target'), 0o755);
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'], deps: { schedulerProbe: { availableParallelism: () => 16, freemem: () => 64_000 * 1024 * 1024 } } });
    const adapter = scriptedAdapter(lab, () => okResult(IMPL));
    lab.deps.adapters = { claude: adapter };
    validateModels(lab);
    const repo = await giveRepository(lab, { 'Cargo.toml': '[package]\nname = "acme"\n' });
    setContract(lab, { baseline_revision: repo.base });
    initLedger(lab);
    // It starts once the worker's temp directory is known: when the controller lays out the worker's build state.
    const actual = vi.mocked(toolchainLayout).getMockImplementation()!;
    vi.mocked(toolchainLayout).mockImplementation((input) => {
      if (input.mode === 'worker') Object.assign(adversary, { tmp: input.tmpDir, outside });
      return actual(input);
    });
    let struck = 0;
    try {
      await implementingStep(lab.ctx()).catch(() => undefined);
      struck = adversary.moved;
    } finally {
      vi.mocked(toolchainLayout).mockImplementation(actual);
      if (adversary.tmp) tmps.push(adversary.tmp);
      adversary.tmp = null;
    }
    expect(statSync(outside).mode & 0o777).toBe(0o755);
    expect(statSync(join(outside, 'cargo-target')).mode & 0o777).toBe(0o755);
    expect(readdirSync(outside)).toEqual(['cargo-target']);
    expect(readdirSync(join(outside, 'cargo-target'))).toEqual(['keep']);
    expect(lstatSync(outside).isDirectory()).toBe(true);
    expect(struck).toBeGreaterThan(0);
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
