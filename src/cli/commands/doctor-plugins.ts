/**
 * `orbit doctor`: the plugins a Claude worker session would load, and whether the policy allows each (issue #9),
 * judged before any run exactly as a session's system/init is judged at collection (adapters/claude-plugins.ts).
 *
 * Workers start with `--setting-sources ""`, so an installed plugin of scope user, project or local never loads;
 * a managed plugin always does. A plugin of any other scope may load, so a refused one is a warning, not a failure.
 * Scopes come from `claude plugin list --json`, because system/init does not report them.
 */
import { WORKER_EXCLUDED_SCOPES, pluginAllowLines, pluginPolicyOf, workerPlugins, type InstalledPlugin, type WorkerPlugin } from '../../adapters/claude-plugins.ts';
import type { ProviderAdapter } from '../../adapters/types.ts';
import type { OrbitConfig } from '../../policy/types.ts';
import { flat } from '../io.ts';
import type { DoctorCheck } from './doctor.ts';

type PluginLister = () => Promise<{ ok: true; plugins: InstalledPlugin[] } | { ok: false; detail: string }>;

const HOOKS_NOTE = 'a plugin can add hooks and tools to workers';
const SCOPE_SOURCE = "scope source: claude plugin list --json (system/init does not report a plugin's scope)";

/** The check, or null for an adapter that cannot list plugins (a stand-in, or another provider). */
export async function workerPluginsCheck(id: string, adapter: ProviderAdapter | undefined, config: OrbitConfig): Promise<DoctorCheck | null> {
  const list = (adapter as { listPlugins?: PluginLister } | undefined)?.listPlugins;
  if (typeof list !== 'function') return null;
  const check = `${id}.plugins`;
  const listed = await list.call(adapter);
  if (!listed.ok) {
    return { id: check, area: 'providers', status: 'warn', summary: `could not list the installed plugins (${flat(listed.detail)})`, details: [], missing: 'the output of claude plugin list --json', fix: 'run "claude plugin list --json" to see why; a worker session that loads a plugin the policy does not allow is refused' };
  }
  const policy = pluginPolicyOf(config);
  const loads: WorkerPlugin[] = [];
  const maybe: WorkerPlugin[] = [];
  const skipped: string[] = [];
  for (const p of listed.plugins) {
    if (!p.enabled) skipped.push(`not loaded by workers: ${p.id} (disabled)`);
    else if (p.scope !== null && WORKER_EXCLUDED_SCOPES.includes(p.scope)) skipped.push(`not loaded by workers: ${p.id} (scope ${p.scope}; workers load no user, project or local settings)`);
    else {
      const [judged] = workerPlugins([{ name: p.id.split('@')[0], source: p.id, scope: p.scope ?? 'unknown' }], { policy, installed: null });
      (p.scope === 'managed' ? loads : maybe).push(judged!);
    }
  }
  const named = (p: WorkerPlugin) => `${p.id} (scope ${p.scope})`;
  const line = (p: WorkerPlugin) => `${named(p)}${maybe.includes(p) ? ', may load' : ''}: ${p.allowed_by ? `allowed by ${p.allowed_by}` : `refused; allow it with ${pluginAllowLines(p).join(' or ')}`}`;
  const judged = [...loads, ...maybe];
  const details = [...judged.map(line), ...skipped];
  if (judged.length === 0) return { id: check, area: 'providers', status: 'pass', summary: 'workers load only Claude Code built-ins', details, missing: null, fix: null };

  const refused = judged.filter((p) => p.allowed_by === null);
  if (refused.length > 0) {
    const managed = refused.some((p) => p.scope === 'managed') ? ' (or agents.allow_managed_plugins: true for every managed plugin)' : '';
    const fix = `add to .orbit/config.yaml: agents.allowed_plugins: ${JSON.stringify(refused.map((p) => p.id))}${managed}; ${HOOKS_NOTE}`;
    const definite = refused.filter((p) => loads.includes(p));
    const missing = 'a policy that allows each plugin a worker loads';
    if (definite.length > 0) {
      return { id: check, area: 'providers', status: 'fail', summary: `workers would load ${definite.length} plugin(s) the policy does not allow, so every worker session would be refused: ${definite.map(named).join(', ')}`, details: [...details, SCOPE_SOURCE], missing, fix };
    }
    return { id: check, area: 'providers', status: 'warn', summary: `workers may load ${refused.length} plugin(s) the policy does not allow: ${refused.map(named).join(', ')}`, details: [...details, SCOPE_SOURCE], missing, fix };
  }
  return {
    id: check,
    area: 'providers',
    status: 'pass',
    summary: `workers would load ${judged.length} plugin(s), each allowed by the policy: ${judged.map((p) => `${p.id} (scope ${p.scope}, ${p.allowed_by})`).join(', ')}`,
    details: [...details, `${HOOKS_NOTE}; each run lists the plugins its workers loaded in its final report`, SCOPE_SOURCE],
    missing: null,
    fix: null,
  };
}
