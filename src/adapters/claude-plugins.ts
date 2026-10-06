/**
 * Which plugins a Claude worker session may load (issue #9).
 *
 * Workers start with `--setting-sources ""`, so no user, project or local
 * plugin loads; Claude Code's built-ins (init entries whose source is
 * "<name>@builtin") and organisation-managed plugins (scope "managed",
 * installed by managed settings, which no setting-sources value excludes)
 * still do. A plugin can add hooks and tools to a worker, so anything that is
 * not a built-in is refused unless the policy admits it:
 *   - agents.allowed_plugins lists its exact name@marketplace id, or
 *   - it is managed and agents.allow_managed_plugins is true.
 * Both default to strict (none, false).
 *
 * Where the scope comes from: an init plugin entry's own `scope` when it has
 * one, otherwise the installed plugin with the same id in
 * `claude plugin list --json`. Claude Code 2.1.288 to 2.1.291 report init
 * entries as {name, path, source} with no scope, so in practice the scope is
 * read from `claude plugin list --json`. A plugin whose scope cannot be
 * established is never treated as managed.
 */
import type { OrbitConfig } from '../policy/types.ts';

export interface PluginPolicy {
  /** Exact name@marketplace ids (agents.allowed_plugins). */
  allowed: readonly string[];
  /** agents.allow_managed_plugins. */
  allowManaged: boolean;
}

export const STRICT_PLUGIN_POLICY: PluginPolicy = Object.freeze({ allowed: Object.freeze([]) as readonly string[], allowManaged: false });

/** One entry of `claude plugin list --json`. */
export interface InstalledPlugin {
  id: string;
  scope: string | null;
  enabled: boolean;
}

/** What the init check needs besides the init line: the policy, and the installed plugins when they could be listed. */
export interface PluginCheck {
  policy: PluginPolicy;
  installed: readonly InstalledPlugin[] | null;
}

export type PluginAllowance = 'agents.allowed_plugins' | 'agents.allow_managed_plugins';

/** A non-built-in plugin a worker session loaded, as recorded in the worker's result. */
export interface WorkerPlugin {
  /** name@marketplace (the init entry's source); null when the entry has none. */
  id: string | null;
  name: string | null;
  scope: string | null;
  /** The policy key that admitted it; null when it was refused. */
  allowed_by: PluginAllowance | null;
}

/** Scopes `--setting-sources ""` leaves out: a plugin installed only there never loads into a worker. */
export const WORKER_EXCLUDED_SCOPES: readonly string[] = ['user', 'project', 'local'];

export function pluginPolicyOf(config: Pick<OrbitConfig, 'agents'>): PluginPolicy {
  const a = config.agents;
  return { allowed: [...(a.allowed_plugins ?? [])], allowManaged: a.allow_managed_plugins === true };
}

/** Parse `claude plugin list --json`; null when it is not a list. Entries without a string id are dropped. */
export function parsePluginList(stdout: string): InstalledPlugin[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: InstalledPlugin[] = [];
  for (const e of parsed) {
    if (!isRecord(e) || typeof e.id !== 'string') continue;
    out.push({ id: e.id, scope: typeof e.scope === 'string' ? e.scope : null, enabled: e.enabled !== false });
  }
  return out;
}

/** True for a Claude Code built-in init entry. */
export function isBuiltinPlugin(entry: unknown): boolean {
  return isRecord(entry) && typeof entry.source === 'string' && entry.source.endsWith('@builtin');
}

/**
 * The non-built-in plugins of system/init's `plugins`, each judged against the policy. Absent `plugins` means
 * none; a value that is not a list counts as one unidentifiable plugin, which nothing can allow.
 */
export function workerPlugins(initPlugins: unknown, check: PluginCheck): WorkerPlugin[] {
  if (initPlugins === undefined) return [];
  const entries = Array.isArray(initPlugins) ? initPlugins : [null];
  const out: WorkerPlugin[] = [];
  for (const e of entries) {
    if (isBuiltinPlugin(e)) continue;
    const r = isRecord(e) ? e : {};
    const id = typeof r.source === 'string' && r.source.includes('@') ? r.source : null;
    const name = typeof r.name === 'string' ? r.name : null;
    const scope = typeof r.scope === 'string' ? r.scope : id === null ? null : (check.installed?.find((p) => p.id === id)?.scope ?? null);
    out.push({ id, name, scope, allowed_by: allowance(id, scope, check.policy) });
  }
  return out;
}

function allowance(id: string | null, scope: string | null, policy: PluginPolicy): PluginAllowance | null {
  if (id === null) return null;
  if (policy.allowed.includes(id)) return 'agents.allowed_plugins';
  if (scope === 'managed' && policy.allowManaged) return 'agents.allow_managed_plugins';
  return null;
}

/** The config lines that would allow a plugin, narrowest first; none for one without an id. */
export function pluginAllowLines(p: { id: string | null; scope: string | null }): string[] {
  if (p.id === null) return [];
  const lines = [`agents.allowed_plugins: ${JSON.stringify([p.id])}`];
  if (p.scope === 'managed') lines.push('agents.allow_managed_plugins: true');
  return lines;
}

/** How one refused plugin is named in a refusal. */
export function describeRefusedPlugin(p: WorkerPlugin): string {
  if (p.id === null) return p.name === null ? 'an entry with no name@marketplace source (no config line can allow it)' : `${p.name} (no name@marketplace source; no config line can allow it)`;
  return `${p.id} (scope ${p.scope ?? 'unknown'}; allow it with ${pluginAllowLines(p).join(' or ')})`;
}

/** The refusal for the plugins the policy did not admit, or null when it admitted all of them. */
export function pluginRefusal(plugins: readonly WorkerPlugin[]): string | null {
  const refused = plugins.filter((p) => p.allowed_by === null);
  if (refused.length === 0) return null;
  return `the session loaded ${refused.length} plugin(s) that are not Claude Code built-ins and that the policy does not allow: ${refused.map(describeRefusedPlugin).join('; ')}`;
}

/** Whether judging these init plugins needs `claude plugin list --json`: a non-built-in entry with an id and no scope of its own. */
export function needsPluginList(initPlugins: unknown): boolean {
  if (!Array.isArray(initPlugins)) return false;
  return initPlugins.some((e) => !isBuiltinPlugin(e) && isRecord(e) && typeof e.source === 'string' && typeof e.scope !== 'string');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
