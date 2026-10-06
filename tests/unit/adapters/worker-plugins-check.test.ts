/**
 * Issue #22: `orbit doctor`, `orbit run` (admission) and the controller's PREFLIGHT judge the plugins a worker
 * session would load with one function, so they cannot disagree about whether workers would be refused.
 */
import { describe, expect, it } from 'vitest';
import { judgeWorkerPlugins, workerPluginRefusals } from '../../../src/adapters/worker-plugins-check.ts';
import type { InstalledPlugin } from '../../../src/adapters/claude-plugins.ts';
import type { ProviderAdapter } from '../../../src/adapters/types.ts';
import { defaultConfig } from '../../../src/policy/config.ts';
import type { OrbitConfig } from '../../../src/policy/types.ts';

type Listing = { ok: true; plugins: InstalledPlugin[] } | { ok: false; detail: string };
const adapter = (listing: Listing | null): ProviderAdapter => (listing === null ? ({} as ProviderAdapter) : ({ listPlugins: async () => listing } as unknown as ProviderAdapter));
const config = (agents: Partial<OrbitConfig['agents']> = {}): OrbitConfig => {
  const c = defaultConfig('autonomous');
  c.agents = { ...c.agents, ...agents };
  return c;
};

const MANAGED: InstalledPlugin[] = [
  { id: 'acme-guard@acme-it', scope: 'managed', enabled: true },
  { id: 'acme-lint@acme-it', scope: 'managed', enabled: true },
  { id: 'acme-notes@acme', scope: 'user', enabled: true },
];

describe('judgeWorkerPlugins', () => {
  it('has no verdict for an adapter that cannot list plugins', async () => {
    expect(await judgeWorkerPlugins(undefined, config())).toBeNull();
    expect(await judgeWorkerPlugins(adapter(null), config())).toBeNull();
  });

  it('fails on managed plugins the default policy refuses, with the exact ids and the config line', async () => {
    const v = await judgeWorkerPlugins(adapter({ ok: true, plugins: MANAGED }), config());
    expect(v).toMatchObject({
      status: 'fail',
      summary: 'workers would load 2 plugin(s) the policy does not allow, so every worker session would be refused: acme-guard@acme-it (scope managed), acme-lint@acme-it (scope managed)',
      missing: 'a policy that allows each plugin a worker loads',
      fix: 'add to .orbit/config.yaml: agents.allowed_plugins: ["acme-guard@acme-it","acme-lint@acme-it"] (or agents.allow_managed_plugins: true for every managed plugin); a plugin can add hooks and tools to workers',
    });
    expect(v!.refused.map((p) => p.id)).toEqual(['acme-guard@acme-it', 'acme-lint@acme-it']);
  });

  it('passes when the policy allows every plugin, and when only built-ins load', async () => {
    expect((await judgeWorkerPlugins(adapter({ ok: true, plugins: MANAGED }), config({ allow_managed_plugins: true })))?.status).toBe('pass');
    expect((await judgeWorkerPlugins(adapter({ ok: true, plugins: MANAGED }), config({ allowed_plugins: ['acme-guard@acme-it', 'acme-lint@acme-it'] })))?.status).toBe('pass');
    expect(await judgeWorkerPlugins(adapter({ ok: true, plugins: [MANAGED[2]!] }), config())).toMatchObject({ status: 'pass', summary: 'workers load only Claude Code built-ins' });
  });

  it('warns, and does not fail, when the list cannot be read or a scope cannot be placed', async () => {
    expect(await judgeWorkerPlugins(adapter({ ok: false, detail: 'claude plugin list --json: exit 1' }), config())).toMatchObject({ status: 'warn', refused: [] });
    const odd = await judgeWorkerPlugins(adapter({ ok: true, plugins: [{ id: 'acme-sync@acme', scope: 'synced', enabled: true }] }), config());
    expect(odd).toMatchObject({ status: 'warn', summary: 'workers may load 1 plugin(s) the policy does not allow: acme-sync@acme (scope synced)' });
  });
});

describe('workerPluginRefusals', () => {
  it('lists the providers whose workers would be refused, each with its verdict, and ignores those that pass or cannot be judged', async () => {
    const refusals = await workerPluginRefusals({ claude: adapter({ ok: true, plugins: MANAGED }), codex: adapter(null), other: adapter({ ok: true, plugins: [] }) }, config());
    expect(refusals.map((r) => r.provider)).toEqual(['claude']);
    expect(refusals[0]!.verdict.status).toBe('fail');
    expect(await workerPluginRefusals({ claude: adapter({ ok: true, plugins: MANAGED }) }, config({ allow_managed_plugins: true }))).toEqual([]);
  });
});
