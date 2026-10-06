/**
 * Issue #9: which plugins a worker session may load. Claude Code's built-ins always pass; anything else passes
 * only when the policy names its exact id (agents.allowed_plugins) or it is organisation-managed and
 * agents.allow_managed_plugins is true. The default stays strict. A refusal names every plugin it refused and
 * the config line that would allow it, and every non-built-in plugin is recorded with the worker's result.
 */
import { describe, expect, it } from 'vitest';
import { classifyClaudeTranscript, sessionProblems } from '../../../src/adapters/claude-transcript.ts';
import { STRICT_PLUGIN_POLICY, parsePluginList, pluginAllowLines, pluginPolicyOf, workerPlugins, type InstalledPlugin, type PluginCheck } from '../../../src/adapters/claude-plugins.ts';
import type { ExitRecord } from '../../../src/adapters/shim.ts';
import { defaultConfig } from '../../../src/policy/config.ts';

const SCHEMA = { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string' } } };
const INIT = { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-sonnet-5-5', permissionMode: 'dontAsk', mcp_servers: [], tools: ['Read'] };
const SUCCESS = { type: 'result', subtype: 'success', is_error: false, session_id: 's1', result: '{"answer":"hi"}', structured_output: { answer: 'hi' }, modelUsage: {}, permission_denials: [] };
const BUILTIN = { name: 'cc-plugin-agents-md', path: '/opt/claude/builtin', source: 'cc-plugin-agents-md@builtin' };
const GUARD = { name: 'acme-guard', path: '/opt/acme/plugins/acme-guard', source: 'acme-guard@acme-it' };
const NOTES = { name: 'acme-notes', path: '/home/dev/.claude/plugins/acme-notes', source: 'acme-notes@acme' };
const INSTALLED: InstalledPlugin[] = [
  { id: 'acme-guard@acme-it', scope: 'managed', enabled: true },
  { id: 'acme-notes@acme', scope: 'user', enabled: true },
];

function exit(): ExitRecord {
  return { version: 1, code: 0, signal: null, timedOut: false, cancelled: false, aborted: null, escalation: [], error: null, startedAt: 1000, endedAt: 3000 };
}

function classify(plugins: unknown[], check?: PluginCheck) {
  return classifyClaudeTranscript({ events: [{ ...INIT, plugins }, SUCCESS] as Record<string, unknown>[], malformedTail: false, exit: exit(), outputSchema: SCHEMA, ...(check ? { plugins: check } : {}) });
}

describe('the worker session init check for plugins', () => {
  it('accepts a session with only Claude Code built-ins and records nothing', () => {
    const r = classify([BUILTIN]);
    expect(r.status).toBe('succeeded');
    expect(r.plugins).toBeUndefined();
    expect(classify([BUILTIN], { policy: STRICT_PLUGIN_POLICY, installed: INSTALLED }).plugins).toBeUndefined();
  });

  it('accepts a plugin whose exact id is in agents.allowed_plugins, and records it', () => {
    const r = classify([BUILTIN, NOTES], { policy: { allowed: ['acme-notes@acme'], allowManaged: false }, installed: INSTALLED });
    expect(r.status).toBe('succeeded');
    expect(r.plugins).toEqual([{ id: 'acme-notes@acme', name: 'acme-notes', scope: 'user', allowed_by: 'agents.allowed_plugins' }]);
    // The id is matched exactly: another marketplace's plugin of the same name is not the one allowed.
    expect(classify([{ ...NOTES, source: 'acme-notes@elsewhere' }], { policy: { allowed: ['acme-notes@acme'], allowManaged: false }, installed: null })).toMatchObject({ status: 'failed', reason: 'unsafe_session' });
  });

  it('accepts a managed plugin with agents.allow_managed_plugins, its scope read from claude plugin list when init has none', () => {
    const r = classify([BUILTIN, GUARD], { policy: { allowed: [], allowManaged: true }, installed: INSTALLED });
    expect(r.status).toBe('succeeded');
    expect(r.plugins).toEqual([{ id: 'acme-guard@acme-it', name: 'acme-guard', scope: 'managed', allowed_by: 'agents.allow_managed_plugins' }]);
    // A scope in the init entry itself is used first.
    const fromInit = classify([{ ...GUARD, scope: 'managed' }], { policy: { allowed: [], allowManaged: true }, installed: null });
    expect(fromInit.status).toBe('succeeded');
    expect(fromInit.plugins).toEqual([{ id: 'acme-guard@acme-it', name: 'acme-guard', scope: 'managed', allowed_by: 'agents.allow_managed_plugins' }]);
    // An exact id wins over the managed flag as the reason recorded.
    expect(classify([GUARD], { policy: { allowed: ['acme-guard@acme-it'], allowManaged: true }, installed: INSTALLED }).plugins?.[0]?.allowed_by).toBe('agents.allowed_plugins');
  });

  it('refuses a managed plugin without the flag, naming it and both config lines that would allow it', () => {
    const r = classify([BUILTIN, GUARD], { policy: STRICT_PLUGIN_POLICY, installed: INSTALLED });
    expect(r).toMatchObject({ status: 'failed', reason: 'unsafe_session' });
    expect(r.error).toBe(
      'the session loaded 1 plugin(s) that are not Claude Code built-ins and that the policy does not allow: acme-guard@acme-it (scope managed; allow it with agents.allowed_plugins: ["acme-guard@acme-it"] or agents.allow_managed_plugins: true)',
    );
    expect(r.plugins).toEqual([{ id: 'acme-guard@acme-it', name: 'acme-guard', scope: 'managed', allowed_by: null }]);
    // No policy at all (an older launch) is the strict default.
    expect(classify([GUARD]).error).toContain('acme-guard@acme-it');
    // When the scope cannot be read, the managed flag cannot apply; the exact id still can.
    const unknown = classify([GUARD], { policy: { allowed: [], allowManaged: true }, installed: null });
    expect(unknown).toMatchObject({ status: 'failed', reason: 'unsafe_session' });
    expect(unknown.error).toContain('acme-guard@acme-it (scope unknown; allow it with agents.allowed_plugins: ["acme-guard@acme-it"])');
  });

  it('refuses a foreign plugin even with the managed flag, and names every plugin it refused', () => {
    const r = classify([BUILTIN, NOTES, GUARD, 'junk', { name: 'nameless' }], { policy: { allowed: [], allowManaged: true }, installed: INSTALLED });
    expect(r).toMatchObject({ status: 'failed', reason: 'unsafe_session' });
    expect(r.error).toBe(
      'the session loaded 3 plugin(s) that are not Claude Code built-ins and that the policy does not allow: ' +
        'acme-notes@acme (scope user; allow it with agents.allowed_plugins: ["acme-notes@acme"]); ' +
        'an entry with no name@marketplace source (no config line can allow it); ' +
        'nameless (no name@marketplace source; no config line can allow it)',
    );
    expect(r.plugins).toEqual([
      { id: 'acme-notes@acme', name: 'acme-notes', scope: 'user', allowed_by: null },
      { id: 'acme-guard@acme-it', name: 'acme-guard', scope: 'managed', allowed_by: 'agents.allow_managed_plugins' },
      { id: null, name: null, scope: null, allowed_by: null },
      { id: null, name: 'nameless', scope: null, allowed_by: null },
    ]);
  });

  it('records the plugins of a session that failed for another reason too', () => {
    const r = classifyClaudeTranscript({ events: [{ ...INIT, plugins: [GUARD] }, { ...SUCCESS, is_error: true }] as Record<string, unknown>[], malformedTail: false, exit: exit(), outputSchema: SCHEMA, plugins: { policy: STRICT_PLUGIN_POLICY, installed: INSTALLED } });
    expect(r.reason).toBe('execution_error');
    expect(r.plugins).toEqual([{ id: 'acme-guard@acme-it', name: 'acme-guard', scope: 'managed', allowed_by: null }]);
  });

  it('sessionProblems takes the same check, and a non-list plugins value is still refused', () => {
    expect(sessionProblems({ ...INIT, plugins: [GUARD] }, null, { policy: { allowed: [], allowManaged: true }, installed: INSTALLED })).toBeNull();
    expect(sessionProblems({ ...INIT, plugins: 'all' }, null, { policy: { allowed: [], allowManaged: true }, installed: INSTALLED })).toMatch(/1 plugin\(s\)/);
  });
});

describe('plugin policy and plugin list helpers', () => {
  it('reads the policy from the config, strict by default and for a snapshot that predates the keys', () => {
    expect(pluginPolicyOf(defaultConfig())).toEqual({ allowed: [], allowManaged: false });
    const c = defaultConfig();
    c.agents.allowed_plugins = ['acme-notes@acme'];
    c.agents.allow_managed_plugins = true;
    expect(pluginPolicyOf(c)).toEqual({ allowed: ['acme-notes@acme'], allowManaged: true });
    const old = { agents: { default_parallelism: 1 } } as unknown as Parameters<typeof pluginPolicyOf>[0];
    expect(pluginPolicyOf(old)).toEqual(STRICT_PLUGIN_POLICY);
  });

  it('parses claude plugin list --json, keeping id, scope and enabled, and rejects anything else', () => {
    const out = JSON.stringify([
      { id: 'acme-guard@acme-it', version: '1.0.0', scope: 'managed', enabled: true, installPath: '/opt/acme' },
      { id: 'acme-notes@acme', scope: 'user', enabled: false },
      { id: 'acme-odd@acme' },
      { version: '1' },
      'junk',
    ]);
    expect(parsePluginList(out)).toEqual([
      { id: 'acme-guard@acme-it', scope: 'managed', enabled: true },
      { id: 'acme-notes@acme', scope: 'user', enabled: false },
      { id: 'acme-odd@acme', scope: null, enabled: true },
    ]);
    expect(parsePluginList('not json')).toBeNull();
    expect(parsePluginList('{"id":"x@y"}')).toBeNull();
  });

  it('gives the config lines that would allow a plugin', () => {
    expect(pluginAllowLines({ id: 'acme-guard@acme-it', scope: 'managed' })).toEqual(['agents.allowed_plugins: ["acme-guard@acme-it"]', 'agents.allow_managed_plugins: true']);
    expect(pluginAllowLines({ id: 'acme-notes@acme', scope: 'user' })).toEqual(['agents.allowed_plugins: ["acme-notes@acme"]']);
    expect(pluginAllowLines({ id: null, scope: 'managed' })).toEqual([]);
  });

  it('lists only the non-built-in plugins of an init entry list', () => {
    expect(workerPlugins([BUILTIN], { policy: STRICT_PLUGIN_POLICY, installed: null })).toEqual([]);
    expect(workerPlugins(undefined, { policy: STRICT_PLUGIN_POLICY, installed: null })).toEqual([]);
  });
});
