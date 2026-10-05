/**
 * What a plugin user sees (docs/decisions/0006-plugin-packaging.md): messages name the form that works through the
 * plugin (P10), the SessionStart hook's `questions --pending --quiet` exists (P7), and free text reaches the CLI on
 * stdin rather than as shell words (P25).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { getRun } from '../../../src/controller/run-store.ts';
import { orbitHint, viaPlugin } from '../../../src/core/invocation.ts';
import { makeLab, type Lab } from './lab.ts';

const labs: Lab[] = [];
const lab = () => {
  const l = makeLab();
  labs.push(l);
  return l;
};
afterEach(() => labs.splice(0).forEach((l) => l.close()));

/** The environment bin/orbit gives the bundle. */
const PLUGIN_ENV = { ORBIT_PLUGIN_ROOT: '/opt/acme/plugins/orbit' };
const asPlugin = (l: Lab) => ({ env: { ...process.env, HOME: l.home, ORBIT_HOME: l.orbitHome, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...PLUGIN_ENV } });
const asTerminal = (l: Lab) => {
  const env: Record<string, string | undefined> = { ...process.env, HOME: l.home, ORBIT_HOME: l.orbitHome, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  delete env.ORBIT_PLUGIN_ROOT;
  return { env };
};

describe('orbitHint (P10)', () => {
  it('names the slash command and the Bash-tool form under the plugin, the terminal command otherwise', () => {
    expect(viaPlugin(PLUGIN_ENV)).toBe(true);
    expect(viaPlugin({})).toBe(false);
    expect(viaPlugin({ ORBIT_PLUGIN_ROOT: '' })).toBe(false);
    expect(orbitHint('init', {})).toBe('"orbit init"');
    expect(orbitHint('init', PLUGIN_ENV)).toBe('/orbit:init (or "orbit init" in Claude Code\'s Bash tool)');
    expect(orbitHint('doctor', PLUGIN_ENV)).toBe('/orbit:doctor (or "orbit doctor" in Claude Code\'s Bash tool)');
    // A command without a skill is still named in the form that works: the plugin puts orbit on the Bash tool's PATH.
    expect(orbitHint('service install', PLUGIN_ENV)).toBe('"orbit service install" in Claude Code\'s Bash tool');
    expect(orbitHint('service install', {})).toBe('"orbit service install"');
    // A doctor fix line is the bare command.
    expect(orbitHint('service install', {}, { quote: false })).toBe('orbit service install');
    expect(orbitHint('service install', PLUGIN_ENV, { quote: false })).toBe('orbit service install in Claude Code\'s Bash tool');
  });
});

describe('messages a plugin user can act on (P10)', () => {
  it('status before init names /orbit:init under the plugin and "orbit init" in a terminal', async () => {
    const l = lab();
    const plugin = await l.cli(['status', 'orb-x'], asPlugin(l));
    expect(plugin.code).toBe(3);
    expect(plugin.err).toContain('/orbit:init');
    const terminal = await l.cli(['status', 'orb-x'], asTerminal(l));
    expect(terminal.err).toContain('run "orbit init"');
    expect(terminal.err).not.toContain('/orbit:');
  });

  it('doctor without a config gives the fix in the plugin form', async () => {
    const l = lab();
    const r = await l.cli(['doctor', '--json'], asPlugin(l));
    const report = JSON.parse(r.out) as { checks: { id: string; fix?: string | null }[] };
    expect(report.checks.find((c) => c.id === 'config')?.fix).toContain('/orbit:init');
  });

  it('init names /orbit:doctor as the next step under the plugin', async () => {
    const l = lab();
    const r = await l.cli(['init'], asPlugin(l));
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('/orbit:doctor');
    const again = await l.cli(['init'], asTerminal(l));
    expect(again.out).toContain('"orbit doctor"');
  });

  it('run without a config names /orbit:init under the plugin', async () => {
    const l = lab();
    const r = await l.cli(['run', '--goal', 'Add CSV export', '--detach'], asPlugin(l));
    expect(r.code).toBe(3);
    expect(r.err).toContain('/orbit:init');
  });
});

describe('orbit questions --pending (P7)', () => {
  it('lists the open questions of every unfinished run, and nothing for finished ones', async () => {
    const l = lab();
    const a = l.newRun('one');
    const b = l.newRun('two');
    const done = l.newRun('three');
    const qa = l.ask(a.id, { id: 'q-aaaa1111' });
    const qb = l.ask(b.id, { id: 'q-bbbb2222', question: 'Which locale formats the totals?' });
    l.ask(done.id, { id: 'q-cccc3333' });
    l.moveTo(done.id, ['CANCELLED']);
    const r = await l.cli(['questions', '--pending']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(a.id);
    expect(r.out).toContain(qa.id);
    expect(r.out).toContain(qb.id);
    expect(r.out).toContain('Which locale formats the totals?');
    expect(r.out).not.toContain('q-cccc3333');
    expect(r.out).toContain(`orbit decide ${a.id} <question-id> <answer>`);
    const j = JSON.parse((await l.cli(['questions', '--pending', '--json'])).out) as { run_id: string; questions: { id: string }[] }[];
    expect(j.map((x) => x.run_id).sort()).toEqual([a.id, b.id].sort());
  });

  it('is silent with --quiet when nothing is pending, including before any run exists', async () => {
    const l = lab();
    const none = await l.cli(['questions', '--pending', '--quiet']);
    expect(none).toMatchObject({ code: 0, out: '', err: '' });
    l.newRun();
    const empty = await l.cli(['questions', '--pending', '--quiet']);
    expect(empty).toMatchObject({ code: 0, out: '', err: '' });
    expect((await l.cli(['questions', '--pending'])).out).toMatch(/no open questions/);
  });

  it('takes a run id or --pending, not both and not neither', async () => {
    const l = lab();
    const run = l.newRun();
    expect((await l.cli(['questions', run.id, '--pending'])).code).toBe(2);
    expect((await l.cli(['questions'])).code).toBe(2);
    expect((await l.cli(['questions', run.id, '--quiet'])).code).toBe(2);
  });
});

describe('free text on stdin (P25)', () => {
  it('repair - reads the failure description from stdin, shell metacharacters and all', async () => {
    const l = lab();
    await l.cli(['init']);
    const text = `login fails; $(touch /tmp/acme-pwned) "quoted" \`tick\``;
    const r = await l.cli(['repair', '-', '--detach', '--json'], {}, `${text}\n`);
    expect(r.code, r.err).toBe(0);
    expect(getRun(l.db(), (JSON.parse(r.out) as { run_id: string }).run_id).goal).toBe(`Repair: ${text}`);
  });

  it('repair - with a run id on stdin is the run-id form, checked by the CLI', async () => {
    const l = lab();
    l.newRun();
    const r = await l.cli(['repair', '-'], {}, 'orb-20260101-000000-abcdef\n');
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/no run orb-20260101-000000-abcdef/);
    const empty = await l.cli(['repair', '-'], {}, '\n');
    expect(empty.code).toBe(2);
  });
});

describe('resume hands a run on explicitly (P11)', () => {
  it('takes --detach, names the exact next command when no controller runs, and refuses --detach with --foreground', async () => {
    const l = lab();
    const run = l.newRun();
    l.moveTo(run.id, ['PREFLIGHT']);
    await l.cli(['pause', run.id]);
    const r = await l.cli(['resume', run.id, '--detach']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`orbit resume ${run.id} --foreground`);
    const both = await l.cli(['resume', run.id, '--detach', '--foreground']);
    expect(both.code).toBe(2);
    expect(both.err).toMatch(/cannot be combined/);
  });
});
