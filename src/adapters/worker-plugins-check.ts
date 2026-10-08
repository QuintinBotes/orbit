/**
 * The plugins a Claude worker session would load, and whether the policy allows each, judged before any session
 * exists (issues #9 and #22). One judgement serves `orbit doctor` (claude.plugins), `orbit run` (admission, before a
 * run exists) and the controller's PREFLIGHT (before a base-revision check or a worker runs), so the three cannot
 * disagree about whether every worker session would be refused. A session's system/init is judged by the same
 * rules at collection (adapters/claude-plugins.ts); this is the same judgement made early, from
 * `claude plugin list --json`, because system/init does not report a plugin's scope.
 *
 * Workers start with `--setting-sources ""`, so an installed plugin of scope user, project or local never loads;
 * a managed plugin always does. A plugin of any other scope may load, so a refused one is a warning, not a failure.
 */
import type { OrbitConfig } from '../policy/types.ts';
import { WORKER_EXCLUDED_SCOPES, pluginAllowLines, pluginPolicyOf, workerPlugins, type InstalledPlugin, type WorkerPlugin } from './claude-plugins.ts';
import type { ProviderAdapter } from './types.ts';

type PluginLister = () => Promise<{ ok: true; plugins: InstalledPlugin[] } | { ok: false; detail: string }>;

export type WorkerPluginsStatus = 'pass' | 'warn' | 'fail';

export interface WorkerPluginsVerdict {
  status: WorkerPluginsStatus;
  summary: string;
  details: string[];
  /** The capability that is absent, for warn and fail. */
  missing: string | null;
  fix: string | null;
  /** The plugins workers would load (or may load) that the policy does not allow; empty unless the status is fail or warn on a plugin. */
  refused: WorkerPlugin[];
}

const HOOKS_NOTE = 'a plugin can add hooks and tools to workers';
const SCOPE_SOURCE = "scope source: claude plugin list --json (system/init does not report a plugin's scope)";

/** The verdict for one adapter, or null for one that cannot list plugins (a stand-in, or another provider). */
export async function judgeWorkerPlugins(adapter: ProviderAdapter | undefined, config: Pick<OrbitConfig, 'agents'>): Promise<WorkerPluginsVerdict | null> {
  const list = (adapter as { listPlugins?: PluginLister } | undefined)?.listPlugins;
  if (typeof list !== 'function') return null;
  const listed = await list.call(adapter);
  if (!listed.ok) {
    return {
      status: 'warn',
      summary: `could not list the installed plugins (${listed.detail.replace(/\s+/g, ' ').trim()})`,
      details: [],
      missing: 'the output of claude plugin list --json',
      fix: 'run "claude plugin list --json" to see why; a worker session that loads a plugin the policy does not allow is refused',
      refused: [],
    };
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
  if (judged.length === 0) return { status: 'pass', summary: 'workers load only Claude Code built-ins', details, missing: null, fix: null, refused: [] };

  const refused = judged.filter((p) => p.allowed_by === null);
  if (refused.length > 0) {
    const managed = refused.some((p) => p.scope === 'managed') ? ' (or agents.allow_managed_plugins: true for every managed plugin)' : '';
    const fix = `add to .orbit/config.yaml: agents.allowed_plugins: ${JSON.stringify(refused.map((p) => p.id))}${managed}; ${HOOKS_NOTE}`;
    const definite = refused.filter((p) => loads.includes(p));
    const missing = 'a policy that allows each plugin a worker loads';
    if (definite.length > 0) {
      return { status: 'fail', summary: `workers would load ${definite.length} plugin(s) the policy does not allow, so every worker session would be refused: ${definite.map(named).join(', ')}`, details: [...details, SCOPE_SOURCE], missing, fix, refused: definite };
    }
    return { status: 'warn', summary: `workers may load ${refused.length} plugin(s) the policy does not allow: ${refused.map(named).join(', ')}`, details: [...details, SCOPE_SOURCE], missing, fix, refused };
  }
  // Only a managed plugin is known to load into a worker (no setting-sources value leaves it out). A plugin of a scope
  // doctor cannot place (synced, say) may load, and the 0.2.1 retest's workers loaded none: "would load" is for the
  // first kind only, and the report names what a session reported loading and says nothing when that is nothing (issue #33).
  const allowed = judged.map((p) => `${p.id} (scope ${p.scope}, ${p.allowed_by})`).join(', ');
  const placed = loads.length === 0 ? '' : `${loads.length} plugin(s)${maybe.length > 0 ? ' (scope managed)' : ''}`;
  const unplaced = maybe.length === 0 ? '' : loads.length === 0 ? `${maybe.length} plugin(s) of a scope doctor cannot place` : `${maybe.length} more of a scope doctor cannot place`;
  const verb = [placed && `workers would load ${placed}`, unplaced && `${placed ? 'and ' : 'workers '}may load ${unplaced}`].filter(Boolean).join(' ');
  const reportNote = `a run's final report lists the plugins its worker sessions reported loading and says nothing when they loaded none`;
  const unplacedNote = maybe.length > 0 ? '; a scope doctor cannot place may not be loaded at all, because workers start with no user, project or local settings' : '';
  return {
    status: 'pass',
    summary: `${verb}, each allowed by the policy: ${allowed}`,
    details: [...details, `${HOOKS_NOTE}; ${reportNote}${unplacedNote}`, SCOPE_SOURCE],
    missing: null,
    fix: null,
    refused: [],
  };
}

/**
 * The providers whose workers would be refused (a `fail` verdict), each with its verdict. A provider that cannot be
 * judged (no plugin listing) or whose list could not be read is not a refusal: its sessions are still judged at
 * collection, one by one.
 */
export async function workerPluginRefusals(adapters: Readonly<Record<string, ProviderAdapter>>, config: Pick<OrbitConfig, 'agents'>): Promise<{ provider: string; verdict: WorkerPluginsVerdict }[]> {
  const out: { provider: string; verdict: WorkerPluginsVerdict }[] = [];
  for (const [provider, adapter] of Object.entries(adapters)) {
    let verdict: WorkerPluginsVerdict | null = null;
    try {
      verdict = await judgeWorkerPlugins(adapter, config);
    } catch {
      verdict = null; // a listing that throws is "could not list", which is never a refusal
    }
    if (verdict?.status === 'fail') out.push({ provider, verdict });
  }
  return out;
}
