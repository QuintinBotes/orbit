import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { COMMANDS } from '../../../src/cli/cli.ts';
import { RUN_STATES } from '../../../src/core/run-states.ts';
import { SRT_VERIFIED_VERSION } from '../../../src/isolation/sandbox-runtime.ts';
import { makeLab } from '../../unit/cli/lab.ts';

const root = resolve(import.meta.dirname, '../../..');
/** The plugin payload (docs/decisions/0006-plugin-packaging.md): the repository root is only the development workspace. */
const plugin = join(root, 'plugin');
const SKILLS = ['doctor', 'init', 'inquisition', 'repair', 'resume', 'run', 'status', 'verify'];
const skillText = (s: string) => readFileSync(join(plugin, 'skills', s, 'SKILL.md'), 'utf8');
/** The bodies of the ```bash fences of a skill. */
const bashFences = (text: string) => [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]!);
const hasEntry = existsSync(join(root, 'src/cli/main.ts'));
const run = (cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}) =>
  spawnSync(cmd, args, { cwd: opts.cwd ?? root, env: opts.env ?? process.env, input: opts.input, encoding: 'utf8', timeout: 90_000 });

const tmp: string[] = [];
const mkTmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); tmp.push(d); return d; };
afterAll(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

describe('plugin manifest and components', () => {
  it('validates under --strict', () => {
    const r = run('claude', ['plugin', 'validate', '--strict', plugin]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });

  it('has no CLAUDE.md at the plugin root', () => {
    expect(existsSync(join(plugin, 'CLAUDE.md'))).toBe(false);
  });

  it('lists eight skills, init and doctor among them, and the seven agents (P10)', () => {
    const r = run('claude', ['--plugin-dir', plugin, 'plugin', 'details', 'orbit']);
    expect(r.status, r.stderr).toBe(0);
    for (const s of SKILLS) expect(r.stdout).toMatch(new RegExp(`Skills \\(8\\).*\\b${s}\\b`));
    for (const a of ['reviewer', 'inquisitor', 'curator', 'verifier', 'planner', 'implementer', 'explorer']) expect(r.stdout).toMatch(new RegExp(`Agents \\(7\\).*\\b${a}\\b`));
  });

  it('keeps frontmatter inside the verified key lists and the payload inside the allowed set', () => {
    const r = run('node', ['scripts/check-plugin.mjs']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });

  it('skills show the arguments to the model and run the plugin\'s own orbit by absolute path', () => {
    for (const s of SKILLS) {
      const text = skillText(s);
      expect(text, s).toContain('"${CLAUDE_PLUGIN_ROOT}/bin/orbit"');
      expect(text, s).not.toContain('dist/orbit.mjs');
      expect(text, s).toContain('$ARGUMENTS');
      expect(text, s).toContain(`/orbit:${s}`);
    }
  });
});

/** The parsed frontmatter of a skill. */
const skillMeta = (s: string) => {
  const text = skillText(s);
  const end = text.indexOf('\n---', 4);
  return parseYaml(text.slice(4, end)) as Record<string, unknown>;
};
/** A copy of the plugin's skills and agents, for linting edited variants. */
const copySkills = () => {
  const d = mkTmp('orbit-skills-');
  for (const e of ['skills', 'agents']) cpSync(join(plugin, e), join(d, e), { recursive: true });
  return d;
};
const setInvocation = (dir: string, skill: string, line: string | null) => {
  const p = join(dir, 'skills', skill, 'SKILL.md');
  const text = readFileSync(p, 'utf8').replace(/^disable-model-invocation: .*\n/m, '');
  writeFileSync(p, line === null ? text : text.replace(/^---\n/, `---\n${line}\n`));
};

describe('skill invocation policy (#2, ADR 0006 addendum)', () => {
  const MODEL = ['doctor', 'init', 'inquisition', 'status'];
  const PERSON = ['repair', 'resume', 'run', 'verify'];

  it('lets an agent use status, doctor, init and inquisition, and leaves run, resume, repair and verify to a person', () => {
    for (const s of MODEL) expect(skillMeta(s)['disable-model-invocation'] ?? false, s).toBe(false);
    for (const s of PERSON) {
      const meta = skillMeta(s);
      expect(meta['disable-model-invocation'], s).toBe(true);
      // The description says who starts it and what an agent may do instead.
      expect(String(meta.description), s).toMatch(/a person starts/i);
      expect(String(meta.description), s).toMatch(/an agent may prepare the goal and suggest the command/i);
    }
  });

  it('check-plugin enforces exactly that allowlist', async () => {
    const { lint, MODEL_INVOCABLE_SKILLS } = await import('../../../scripts/check-plugin.mjs');
    expect([...MODEL_INVOCABLE_SKILLS].sort()).toEqual(MODEL);
    expect(lint(plugin)).toEqual([]);

    // A skill outside the allowlist without disable-model-invocation: true fails, whether the key is absent or false.
    for (const line of [null, 'disable-model-invocation: false']) {
      const d = copySkills();
      setInvocation(d, 'run', line);
      expect(lint(d).join('\n')).toMatch(/skills\/run\/SKILL\.md: .*disable-model-invocation: true/);
    }
    // A new skill that is not on the allowlist must opt out of model invocation too.
    const extra = copySkills();
    mkdirSync(join(extra, 'skills', 'acme'));
    writeFileSync(join(extra, 'skills', 'acme', 'SKILL.md'), '---\nname: acme\ndescription: acme\n---\nbody\n');
    expect(lint(extra).join('\n')).toMatch(/skills\/acme\/SKILL\.md: .*disable-model-invocation: true/);
    // An allowlisted skill that is missing, or that turns model invocation off, fails.
    const missing = copySkills();
    rmSync(join(missing, 'skills', 'status'), { recursive: true });
    expect(lint(missing).join('\n')).toMatch(/skills\/status\/SKILL\.md: .*missing/);
    const off = copySkills();
    setInvocation(off, 'doctor', 'disable-model-invocation: true');
    expect(lint(off).join('\n')).toMatch(/skills\/doctor\/SKILL\.md: .*model-invocable/);
  });

  it('pre-approves only the read-only orbit commands that status and doctor run', () => {
    /** The commands a skill's bash fences run through the plugin's orbit, unquoted as a permission rule spells them. */
    const fenceCommands = (s: string) => bashFences(skillText(s)).flatMap((f) => [...f.matchAll(/^"\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/orbit" ([^\n]+)$/gm)].map((m) => `\${CLAUDE_PLUGIN_ROOT}/bin/orbit ${m[1]!.trim()}`));
    /** Claude Code's Bash rule: exact, or a trailing " *" for any further words. */
    const matches = (rule: string, cmd: string) => rule.endsWith(' *') ? cmd.startsWith(rule.slice(0, -1)) : cmd === rule;
    // The read-only commands each skill may pre-approve: status also shows the run's timeline.
    const READ_ONLY: Record<string, string[]> = { status: ['status', 'timeline'], doctor: ['doctor'] };
    for (const s of ['status', 'doctor']) {
      const tools = skillMeta(s)['allowed-tools'];
      expect(Array.isArray(tools), s).toBe(true);
      const rules = (tools as string[]).map((t) => /^Bash\((.+)\)$/.exec(t)?.[1]);
      for (const r of rules) expect(r, `${s}: ${JSON.stringify(tools)}`).toMatch(new RegExp(`^\\$\\{CLAUDE_PLUGIN_ROOT\\}/bin/orbit (${READ_ONLY[s]!.join('|')})\\b`));
      // Every command the skill runs is covered, with <run-id> as the one further word, and every rule covers one of them.
      const cmds = fenceCommands(s).map((c) => c.replace('<run-id>', 'orb-acme-1'));
      expect(cmds.length, s).toBeGreaterThan(1);
      for (const c of cmds) expect(rules.some((r) => matches(r!, c)), `${s}: ${c}`).toBe(true);
      for (const r of rules) expect(cmds.some((c) => matches(r!, c)), `${s}: ${r}`).toBe(true);
    }
    // Nothing that starts work, records a decision or changes config is pre-approved.
    for (const s of ['init', 'inquisition', 'repair', 'resume', 'run', 'verify']) expect(skillMeta(s)['allowed-tools'], s).toBeUndefined();
  });
});

describe('docs (#2, #5)', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const install = readFileSync(join(root, 'docs', 'installation.md'), 'utf8');
  const adr = readFileSync(join(root, 'docs', 'decisions', '0006-plugin-packaging.md'), 'utf8');

  it('say orbit reaches the Bash tool PATH only after /reload-plugins or a new session, and what to use until then', () => {
    for (const [name, text] of [['README.md', readme], ['docs/installation.md', install]] as const) {
      const flat = text.replace(/\s+/g, ' ');
      expect(flat, name).toContain('/reload-plugins');
      expect(flat, name).toMatch(/new (Claude Code )?session/);
      expect(flat, name).toContain('"${CLAUDE_PLUGIN_ROOT}/bin/orbit"');
      expect(flat, name).toMatch(/absolute path/);
      // The old claim that install alone puts orbit on the PATH is gone.
      expect(flat, name).not.toMatch(/You get the skills [^.]*, and `orbit` on the PATH/);
    }
  });

  it('record who invokes which skill', () => {
    const flatAdr = adr.replace(/\s+/g, ' ');
    expect(flatAdr).toMatch(/Addendum/);
    for (const s of ['status', 'doctor', 'init', 'inquisition', 'run', 'resume', 'repair', 'verify']) expect(flatAdr, s).toContain(`/orbit:${s}`);
    expect(flatAdr).toContain('scripts/check-plugin.mjs');
    expect(readme.replace(/\s+/g, ' ')).toMatch(/An agent asked to use Orbit uses the model-invocable skills[^.]*and the `orbit` CLI[^.]*; a person starts `\/orbit:run`, `\/orbit:resume`, `\/orbit:repair` and `\/orbit:verify`/);
  });
});

describe('skills keep user text away from the shell (P25)', () => {
  it('never puts $ARGUMENTS in a bash fence', () => {
    for (const s of SKILLS) for (const fence of bashFences(skillText(s))) expect(fence, `skills/${s}/SKILL.md`).not.toContain('$ARGUMENTS');
  });

  it('passes goals and other free text through a here-document with a quoted delimiter', () => {
    const free = [
      ['run', /orbit" run --goal - .*<<'ORBIT_GOAL'/],
      ['repair', /orbit" repair - .*<<'ORBIT_TEXT'/],
      ['inquisition', /orbit" decide <run-id> <question-id> - <<'ORBIT_ANSWER'/],
    ] as const;
    for (const [s, re] of free) expect(bashFences(skillText(s)).join('\n'), s).toMatch(re);
    // Every here-document in every skill has a quoted delimiter, so nothing inside it is expanded.
    for (const s of SKILLS) for (const fence of bashFences(skillText(s))) for (const m of fence.matchAll(/<<-?\s*(\S+)/g)) expect(m[1], `skills/${s}/SKILL.md`).toMatch(/^'[A-Z_]+'$/);
  });

  it('validates a run id before it reaches a command line', () => {
    for (const s of ['status', 'resume', 'verify', 'repair', 'inquisition']) expect(skillText(s), s).toContain('^orb-[0-9a-z-]+$');
  });
});

describe('skills never leave a run idle or orphaned (P11, D11)', () => {
  it('check the service, then detach to it or drive in the background and say so', () => {
    for (const s of ['run', 'resume', 'repair']) {
      const text = skillText(s);
      expect(text, s).toContain('"${CLAUDE_PLUGIN_ROOT}/bin/orbit" service status');
      expect(text, s).toContain('--detach');
      expect(text, s).toContain('--foreground');
      expect(text, s).toContain('run_in_background');
      expect(text, s).toContain('"${CLAUDE_PLUGIN_ROOT}/bin/orbit" service install');
    }
  });

  it('does not contradict itself', () => {
    const runSkill = skillText('run');
    expect(runSkill).not.toMatch(/Do not rewrite, quote or reorder/);
    expect(runSkill).not.toMatch(/Submit, report the run id, and stop/);
    expect(skillText('resume')).toContain('--foreground');
  });
});

describe('plugin payload (ADR 0006, P9)', () => {
  it('holds only the allowed files, and a package whose only dependency is srt at the verified version', async () => {
    const { payloadProblems } = await import('../../../scripts/check-plugin.mjs');
    expect(payloadProblems(plugin)).toEqual([]);
    const pkg = JSON.parse(readFileSync(join(plugin, 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(pkg.dependencies).toEqual({ '@anthropic-ai/sandbox-runtime': SRT_VERIFIED_VERSION });
    expect(pkg).not.toHaveProperty('devDependencies');
  });

  it('fails on a devDependency, a dev lockfile entry, a stray file or a wrong srt pin', async () => {
    const { payloadProblems } = await import('../../../scripts/check-plugin.mjs');
    const copy = () => {
      const d = mkTmp('orbit-payload-');
      for (const e of readdirSync(plugin)) if (e !== 'node_modules') cpSync(join(plugin, e), join(d, e), { recursive: true });
      return d;
    };
    const edit = (d: string, file: string, fn: (j: Record<string, any>) => void) => {
      const j = JSON.parse(readFileSync(join(d, file), 'utf8')) as Record<string, any>;
      fn(j);
      writeFileSync(join(d, file), JSON.stringify(j, null, 2));
    };

    const dev = copy();
    edit(dev, 'package.json', (j) => { j.devDependencies = { vitest: '5.0.3' }; });
    expect(payloadProblems(dev).join('\n')).toMatch(/devDependencies/);

    const lock = copy();
    edit(lock, 'package-lock.json', (j) => { j.packages['node_modules/vitest'] = { version: '5.0.3', dev: true }; });
    expect(payloadProblems(lock).join('\n')).toMatch(/node_modules\/vitest/);

    const stray = copy();
    writeFileSync(join(stray, 'notes.md'), 'x');
    mkdirSync(join(stray, 'src'));
    writeFileSync(join(stray, 'src', 'x.ts'), 'x');
    const strayProblems = payloadProblems(stray).join('\n');
    expect(strayProblems).toMatch(/notes\.md/);
    expect(strayProblems).toMatch(/src\/x\.ts/);

    const pin = copy();
    edit(pin, 'package.json', (j) => { j.dependencies['@anthropic-ai/sandbox-runtime'] = '^0.0.78'; });
    expect(payloadProblems(pin).join('\n')).toMatch(/sandbox-runtime/);

    const extraDep = copy();
    edit(extraDep, 'package.json', (j) => { j.dependencies.yaml = '2.9.1'; });
    expect(payloadProblems(extraDep).join('\n')).toMatch(/yaml/);
  });

  it('ships bin/orbit, which runs the bundle by absolute path, through PATH and through a link', () => {
    const bin = join(plugin, 'bin', 'orbit');
    expect(statSync(bin).mode & 0o111).not.toBe(0);
    const direct = run(bin, ['--version'], { cwd: mkTmp('orbit-bin-') });
    expect(direct.status, direct.stderr).toBe(0);
    expect(direct.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    const viaPath = run('orbit', ['--version'], { cwd: mkTmp('orbit-bin-'), env: { ...process.env, PATH: `${join(plugin, 'bin')}:${process.env.PATH}` } });
    expect(viaPath.status, viaPath.stderr).toBe(0);
    expect(viaPath.stdout).toBe(direct.stdout);
    const links = mkTmp('orbit-binlink-');
    symlinkSync(bin, join(links, 'orbit'));
    const linked = run('orbit', ['--version'], { cwd: links, env: { ...process.env, PATH: `${links}:${process.env.PATH}` } });
    expect(linked.status, linked.stderr).toBe(0);
    expect(linked.stdout).toBe(direct.stdout);
  });
});

/** Every `".../bin/orbit" <words>` invocation a skill tells the model to run, with the skill it came from. */
function skillInvocations(): { skill: string; words: string[]; text: string }[] {
  const out: { skill: string; words: string[]; text: string }[] = [];
  for (const skill of SKILLS) {
    const body = skillText(skill);
    for (const m of body.matchAll(/bin\/orbit"\s+([^\n`]+)/g)) {
      out.push({ skill, words: m[1]!.trim().split(/\s+/), text: m[1]!.trim() });
    }
  }
  return out;
}

describe('skills call commands that exist', () => {
  const names = COMMANDS.map((c) => c.name);

  it('resolves every orbit command a skill names to a registered command', () => {
    const calls = skillInvocations();
    expect(calls.length).toBeGreaterThanOrEqual(8);
    for (const { skill, words } of calls) {
      const [a, b] = words;
      const resolved = names.includes(`${a} ${b}`) || names.includes(a!);
      expect(resolved, `skills/${skill}/SKILL.md runs "orbit ${words.join(' ')}", which is not in COMMANDS`).toBe(true);
    }
    // The commands the skills exist for.
    const used = new Set(calls.map((c) => c.words[0]));
    for (const c of ['init', 'doctor', 'run', 'verify', 'repair', 'status', 'resume', 'decide', 'questions', 'service']) expect(used.has(c), c).toBe(true);
  });

  it('never invents an inquisition command', () => {
    for (const s of ['inquisition', 'run', 'repair', 'verify']) {
      expect(skillText(s)).not.toMatch(/bin\/orbit"\s+inquisition/);
    }
    expect(names).not.toContain('inquisition');
  });

  it('records decisions with the run id first, then the question id, as orbit decide takes them', () => {
    const decide = COMMANDS.find((c) => c.name === 'decide')!;
    expect(decide.usage).toMatch(/^orbit decide <run-id> <question-id> <answer\.\.\.>/);
    const line = skillInvocations().find((c) => c.skill === 'inquisition' && c.words[0] === 'decide');
    expect(line?.text).toMatch(/^decide <run-id> <question-id> - <<'ORBIT_ANSWER'/);
    expect(skillInvocations().some((c) => c.skill === 'inquisition' && c.text === 'questions <run-id>')).toBe(true);
  });

  it('names only real run states in the status skill', () => {
    const body = skillText('status').split('---').slice(2).join('---');
    expect(body).not.toMatch(/\b(RUNNING|DONE|FAILED)\b/);
    const states = (body.match(/\b[A-Z]{5,}(?:_[A-Z]+)?\b/g) ?? []).filter((w) => w !== 'ARGUMENTS');
    expect(states.length).toBeGreaterThan(3);
    for (const st of new Set(states)) expect(RUN_STATES as readonly string[], st).toContain(st);
    for (const st of ['VERIFYING', 'BLOCKED', 'SUCCEEDED', 'EXHAUSTED']) expect(body).toContain(st);
  });

  it('documents the verify exit codes and the repair hand-off', () => {
    const verify = skillText('verify');
    expect(verify).toMatch(/14 means FAIL/);
    expect(verify).toMatch(/15 means INCOMPLETE/);
    const repair = skillText('repair');
    expect(repair).toMatch(/Repair: <your text>/);
    expect(repair).toMatch(/DIAGNOSING/);
  });

  it('offers native /goal as an optional aid while keeping the controller as the completion authority', () => {
    const run = skillText('run');
    expect(run).toMatch(/\/goal/);
    expect(run).toMatch(/evidence: orbit status <run-id> reports SUCCEEDED/);
    expect(run).toMatch(/completion gate stays the authority|stays the authority/);
    expect(run).toMatch(/If `\/goal` is not available, skip this step/);
  });
});

describe('manifest', () => {
  it('carries the keywords of the spec example', () => {
    const manifest = JSON.parse(readFileSync(join(plugin, '.claude-plugin/plugin.json'), 'utf8')) as { name: string; keywords: string[] };
    expect(manifest.name).toBe('orbit');
    for (const k of ['claude-code', 'autonomous', 'verification', 'self-healing', 'engineering']) expect(manifest.keywords).toContain(k);
  });
});

describe('hooks.json', () => {
  const hooks = JSON.parse(readFileSync(join(plugin, 'hooks/hooks.json'), 'utf8')) as {
    hooks: Record<string, { matcher?: string; hooks: { type: string; command: string; args?: string[]; timeout?: number }[] }[]>;
  };
  const handlers = Object.values(hooks.hooks).flatMap((g) => g.flatMap((e) => e.hooks));

  it('uses exec-form commands whose script files exist and with short timeouts', () => {
    expect(handlers.length).toBeGreaterThan(0);
    for (const h of handlers) {
      expect(h.type).toBe('command');
      expect(h.command).toBe('node');
      const script = (h.args?.[0] ?? '').replace('${CLAUDE_PLUGIN_ROOT}', plugin);
      expect(existsSync(script), script).toBe(true);
      expect(h.timeout).toBeLessThanOrEqual(10);
    }
  });

  it('guards the expected tools', () => {
    expect(hooks.hooks.PreToolUse?.[0]?.matcher).toBe('Bash|PowerShell|Edit|Write|NotebookEdit|Read');
  });

  it('guard is a no-op outside workers and fails closed for workers', () => {
    const env = { ...process.env };
    delete env.ORBIT_WORKER;
    delete env.CLAUDE_PROJECT_DIR;
    expect(run('node', [join(plugin, 'hooks/guard.mjs')], { env, input: '{}' }).status).toBe(0);
    // A copy without dist/ models a missing bundle: the guard must block, not silently pass.
    const copy = mkTmp('orbit-plugin-');
    mkdirSync(join(copy, 'hooks'));
    cpSync(join(plugin, 'hooks/guard.mjs'), join(copy, 'hooks/guard.mjs'));
    const r = run('node', [join(copy, 'hooks/guard.mjs')], { env: { ...env, ORBIT_WORKER: '1' }, input: '{}' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('failed closed');
  });

  it('session start is silent in a repo without Orbit state', () => {
    const dir = mkTmp('orbit-ss-');
    const r = run('node', [join(plugin, 'hooks/session-start.mjs')], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
});

describe('hook scripts against a fake bundle', () => {
  // A throwaway plugin copy lets the scripts run against controlled bundle behaviour.
  const mkPlugin = (bundleSrc: string) => {
    const fake = mkTmp('orbit-fake-');
    mkdirSync(join(fake, 'hooks'));
    mkdirSync(join(fake, 'dist'));
    for (const f of ['guard.mjs', 'session-start.mjs']) cpSync(join(plugin, 'hooks', f), join(fake, 'hooks', f));
    writeFileSync(join(fake, 'dist/orbit.mjs'), bundleSrc);
    return fake;
  };
  const worker = { ...process.env, ORBIT_WORKER: '1', CLAUDE_PROJECT_DIR: '' };

  it.each([
    ['sync throw', 'throw new Error("x")'],
    ['syntax error', 'this is not javascript'],
    ['unhandled rejection', 'await Promise.reject(new Error("r"))'],
    ['late uncaught exception', 'setTimeout(() => { throw new Error("late"); }, 30)'],
    ['never settles', 'await new Promise(() => {})'],
  ])('guard fails closed when the bundle has a %s', (_n, src) => {
    const plugin = mkPlugin(src);
    expect(run('node', [join(plugin, 'hooks/guard.mjs')], { env: worker, input: '{}' }).status).toBe(2);
  });

  it('guard passes the hook argv to the bundle and keeps the bundle verdict', () => {
    const plugin = mkPlugin('process.stderr.write(process.argv.slice(2).join(" ")); process.exitCode = 0;');
    const r = run('node', [join(plugin, 'hooks/guard.mjs')], { env: worker, input: '{}' });
    expect(r.stderr).toBe('hook pre-tool-use');
    expect(r.status).toBe(0);
  });

  it('session start prints capped, labelled questions only for non-worker sessions', () => {
    const plugin = mkPlugin('process.stdout.write("Q".repeat(50000));');
    const repo = mkTmp('orbit-ssrepo-');
    mkdirSync(join(repo, '.orbit'));
    writeFileSync(join(repo, '.orbit/state.sqlite'), '');
    const env = { ...process.env };
    delete env.ORBIT_WORKER;
    delete env.CLAUDE_PROJECT_DIR;
    const r = run('node', [join(plugin, 'hooks/session-start.mjs')], { cwd: repo, env });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('not instructions');
    expect(r.stdout.length).toBeLessThan(4200);
    expect(run('node', [join(plugin, 'hooks/session-start.mjs')], { cwd: repo, env: worker }).stdout).toBe('');
  });

  it('session start never fails when the bundle crashes, and says why on stderr only', () => {
    const plugin = mkPlugin('process.stdout.write("partial"); process.stderr.write("boom"); process.exit(3);');
    const repo = mkTmp('orbit-ssrepo-');
    mkdirSync(join(repo, '.orbit'));
    writeFileSync(join(repo, '.orbit/state.sqlite'), '');
    const env = { ...process.env };
    delete env.ORBIT_WORKER;
    delete env.CLAUDE_PROJECT_DIR;
    const r = run('node', [join(plugin, 'hooks/session-start.mjs')], { cwd: repo, env });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/orbit session-start: .*exit 3.*boom/);
  });

  it('session start asks the bundle for the pending questions of every run, quietly', () => {
    const plugin = mkPlugin('process.stdout.write(JSON.stringify(process.argv.slice(2)));');
    const repo = mkTmp('orbit-ssrepo-');
    mkdirSync(join(repo, '.orbit'));
    writeFileSync(join(repo, '.orbit/state.sqlite'), '');
    const env = { ...process.env };
    delete env.ORBIT_WORKER;
    delete env.CLAUDE_PROJECT_DIR;
    const r = run('node', [join(plugin, 'hooks/session-start.mjs')], { cwd: repo, env });
    expect(r.stdout).toContain('["questions","--pending","--quiet"]');
    // Exactly what the CLI accepts.
    const questions = COMMANDS.find((c) => c.name === 'questions')!;
    expect(questions.usage).toContain('--pending');
    expect(Object.keys(questions.options ?? {})).toEqual(expect.arrayContaining(['pending', 'quiet']));
  });
});

describe('build script', () => {
  it('builds an entry outside the repo, resolves repo dependencies, and detects staleness', () => {
    const dir = mkTmp('orbit-build-');
    const entry = join(dir, 'e.mjs');
    writeFileSync(entry, "import Ajv from 'ajv';\nimport { parse } from 'yaml';\nif (process.argv[2] === '--version') console.log('9.9.9', typeof Ajv, parse('a: 1').a);\n");
    const out = join(dir, 'out/orbit.mjs');
    const env = { ...process.env, ORBIT_BUILD_ENTRY: entry, ORBIT_BUILD_OUT: out };
    const b = run('node', ['scripts/build.mjs'], { env });
    expect(b.status, b.stdout + b.stderr).toBe(0);
    expect(readFileSync(out, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(run('node', ['scripts/build.mjs', '--check'], { env }).status).toBe(0);
    appendFileSync(out, '// tampered\n');
    expect(run('node', ['scripts/build.mjs', '--check'], { env }).status).toBe(1);
  });

  it('ships the srt preload beside a bundle that locates it, and treats a stale copy as a stale build', () => {
    const dir = mkTmp('orbit-build-');
    const entry = join(dir, 'e.mjs');
    writeFileSync(entry, "if (process.argv[2] === '--version') console.log('9.9.9', new URL('./srt-chromium-preload.mjs', import.meta.url).pathname.length > 0);\n");
    const out = join(dir, 'out/orbit.mjs');
    const env = { ...process.env, ORBIT_BUILD_ENTRY: entry, ORBIT_BUILD_OUT: out };
    const b = run('node', ['scripts/build.mjs'], { env });
    expect(b.status, b.stdout + b.stderr).toBe(0);
    const copy = join(dir, 'out/srt-chromium-preload.mjs');
    expect(readFileSync(copy, 'utf8')).toBe(readFileSync(join(root, 'src/isolation/srt-chromium-preload.mjs'), 'utf8'));
    expect(run('node', ['scripts/build.mjs', '--check'], { env }).status).toBe(0);
    appendFileSync(copy, '// tampered\n');
    const stale = run('node', ['scripts/build.mjs', '--check'], { env });
    expect(stale.status).toBe(1);
    expect(stale.stderr).toMatch(/srt-chromium-preload\.mjs does not match/);
  });

  it('fails cleanly on a missing entry or a broken import', () => {
    const dir = mkTmp('orbit-build-');
    expect(run('node', ['scripts/build.mjs'], { env: { ...process.env, ORBIT_BUILD_ENTRY: join(dir, 'nope.ts'), ORBIT_BUILD_OUT: join(dir, 'o.mjs') } }).status).toBe(1);
    const bad = join(dir, 'bad.mjs');
    writeFileSync(bad, "import 'does-not-exist-pkg';\n");
    const r = run('node', ['scripts/build.mjs'], { env: { ...process.env, ORBIT_BUILD_ENTRY: bad, ORBIT_BUILD_OUT: join(dir, 'o.mjs') } });
    expect(r.status).toBe(1);
    expect(r.stderr).not.toContain('    at ');
  });
});

describe.skipIf(!hasEntry)('bundle', () => {
  beforeAll(() => {
    const r = run('node', ['scripts/build.mjs']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });

  it('is current and starts with a node shebang, with the srt preload beside it', () => {
    expect(readFileSync(join(plugin, 'dist/orbit.mjs'), 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(readFileSync(join(plugin, 'dist/srt-chromium-preload.mjs'), 'utf8')).toBe(readFileSync(join(root, 'src/isolation/srt-chromium-preload.mjs'), 'utf8'));
    expect(existsSync(join(root, 'dist'))).toBe(false);
    expect(run('node', ['scripts/build.mjs', '--check']).status).toBe(0);
  });

  it('runs --version and doctor --json in a temp repo', () => {
    const repo = mkTmp('orbit-bundle-');
    const home = mkTmp('orbit-home-');
    run('git', ['init', '-q'], { cwd: repo });
    const env = { ...process.env, ORBIT_HOME: home };
    const v = run('node', [join(plugin, 'dist/orbit.mjs'), '--version'], { cwd: repo, env });
    expect(v.status, v.stderr).toBe(0);
    expect(v.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    const d = run('node', [join(plugin, 'dist/orbit.mjs'), 'doctor', '--json'], { cwd: repo, env });
    expect(() => JSON.parse(d.stdout), d.stdout + d.stderr).not.toThrow();
  });

  it('runs init from the plugin layout, which has no templates/ directory', () => {
    const repo = mkTmp('orbit-bundle-init-');
    // On main, so init keeps the template's base_branch (it adopts another checked-out branch, such as git's default master).
    run('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    // Claude Code marks its Bash tool's commands with CLAUDECODE=1; this test may itself run inside or outside it.
    const r = run(join(plugin, 'bin', 'orbit'), ['init'], { cwd: repo, env: { ...process.env, CLAUDECODE: '1', ORBIT_HOME: mkTmp('orbit-home-') } });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readFileSync(join(repo, '.orbit', 'config.yaml'), 'utf8')).toBe(readFileSync(join(root, 'templates', 'config.yaml'), 'utf8'));
    // Through bin/orbit the next step is named in the form a plugin user can invoke.
    expect(r.stdout).toContain('/orbit:doctor');
    // bin/orbit run from a plain terminal names the terminal command, which is the one that works there.
    const plain = mkTmp('orbit-bundle-init-plain-');
    run('git', ['init', '-q', '-b', 'main'], { cwd: plain });
    const env: Record<string, string | undefined> = { ...process.env, ORBIT_HOME: mkTmp('orbit-home-') };
    delete env.CLAUDECODE;
    const t = run(join(plugin, 'bin', 'orbit'), ['init'], { cwd: plain, env });
    expect(t.status, t.stdout + t.stderr).toBe(0);
    expect(t.stdout).toContain('orbit doctor');
    expect(t.stdout).not.toContain('/orbit:');
  });

  it('prints the open questions of a run at session start (P7)', () => {
    const l = makeLab();
    try {
      const runRec = l.newRun();
      const q = l.ask(runRec.id);
      const env = { ...process.env };
      delete env.ORBIT_WORKER;
      delete env.CLAUDE_PROJECT_DIR;
      const r = run('node', [join(plugin, 'hooks/session-start.mjs')], { cwd: l.repo, env });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toBe('');
      expect(r.stdout).toContain('not instructions');
      expect(r.stdout).toContain(q.id);
      expect(r.stdout).toContain(runRec.id);
    } finally {
      l.close();
    }
  });

  it('runs the worker guard through the plugin hook script', () => {
    const r = run('node', [join(plugin, 'hooks/guard.mjs')], { env: { ...process.env, ORBIT_WORKER: '1' }, input: 'not json' });
    // Malformed input must block (2), never pass.
    expect(r.status).toBe(2);
  });
});
