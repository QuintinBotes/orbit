/** `orbit init`, `orbit gc`, `orbit policy show` and `orbit run --detach`: the paths the main tests do not take. */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXCLUDE_RULES } from '../../../src/cli/commands/init.ts';
import { defaultConfig } from '../../../src/policy/config.ts';
import { startRun } from '../../../src/controller/start.ts';
import { getRun, acquireLease } from '../../../src/controller/run-store.ts';
import { insertAmendment } from '../../../src/inquisition/store.ts';
import { registerController } from '../../../src/storage/controllers.ts';
import { systemClock } from '../../../src/core/clock.ts';
import { OrbitError } from '../../../src/core/errors.ts';
import type { OrbitConfig } from '../../../src/policy/types.ts';
import { makeLab, type Lab } from './lab.ts';

const hooks = vi.hoisted(() => ({
  exec: null as null | ((argv: readonly string[]) => unknown),
  installDir: null as null | string,
  loadConfig: null as null | (() => unknown),
}));

vi.mock('../../../src/core/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/exec.ts')>();
  return { ...actual, execCapture: (argv: readonly string[], opts: never) => (hooks.exec?.(argv) as ReturnType<typeof actual.execCapture> | undefined) ?? actual.execCapture(argv, opts) };
});
vi.mock('../../../src/controller/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/controller/index.ts')>();
  return { ...actual, orbitInstallDir: (...a: []) => hooks.installDir ?? actual.orbitInstallDir(...a) };
});
vi.mock('../../../src/policy/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/policy/index.ts')>();
  return { ...actual, loadConfig: (...a: Parameters<typeof actual.loadConfig>) => (hooks.loadConfig ? hooks.loadConfig() : actual.loadConfig(...a)) } as typeof actual;
});

const labs: Lab[] = [];
const scratch: string[] = [];
const lab = (o?: Parameters<typeof makeLab>[0]) => {
  const l = makeLab(o);
  labs.push(l);
  return l;
};
beforeEach(() => {
  hooks.exec = null;
  hooks.installDir = null;
  hooks.loadConfig = null;
});
afterEach(() => {
  labs.splice(0).forEach((l) => l.close());
  scratch.splice(0).forEach((d) => {
    try {
      chmodSync(d, 0o755);
    } catch {
      /* gone */
    }
    rmSync(d, { recursive: true, force: true });
  });
});

describe('orbit init', () => {
  const configPath = (l: Lab) => join(l.repo, '.orbit', 'config.yaml');
  const excludePath = (l: Lab) => join(l.repo, '.git', 'info', 'exclude');

  it('says the starter template is missing from the installation, and writes nothing', async () => {
    const l = lab();
    const empty = mkdtempSync(join(tmpdir(), 'orbit-noinstall-'));
    scratch.push(empty);
    hooks.installDir = empty;
    const r = await l.cli(['init']);
    expect(r.code).toBe(3);
    expect(r.err).toBe(`orbit: the starter template ${join(empty, 'templates', 'config.yaml')} is missing from this installation\n`);
    expect(existsSync(configPath(l))).toBe(false);
    expect(existsSync(join(l.repo, '.orbit'))).toBe(false);
  });

  it('treats a config that appeared between the check and the write as already there', async () => {
    const l = lab();
    mkdirSync(join(l.repo, '.orbit'));
    // A dangling link is invisible to the existence check but refuses an exclusive create.
    symlinkSync(join(l.base, 'nowhere.yaml'), configPath(l));
    const r = await l.cli(['init', '--json']);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out).config.status).toBe('exists');
    expect(existsSync(join(l.base, 'nowhere.yaml'))).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)('reports a write failure other than "already exists" instead of hiding it', async () => {
    const l = lab();
    mkdirSync(join(l.repo, '.orbit'));
    chmodSync(join(l.repo, '.orbit'), 0o500);
    scratch.push(join(l.repo, '.orbit'));
    const r = await l.cli(['init']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/EACCES/);
  });

  it('fails with the git message when it cannot locate the exclude file', async () => {
    const l = lab();
    hooks.exec = (argv) => (argv.includes('info/exclude') ? { exitCode: 128, signal: null, stdout: '', stderr: 'fatal: not a git repository (or any parent)\n' } : undefined);
    const r = await l.cli(['init']);
    expect(r.code).toBe(1);
    expect(r.err).toBe('orbit: cannot locate .git/info/exclude: fatal: not a git repository (or any parent)\n');
    hooks.exec = (argv) => (argv.includes('info/exclude') ? { exitCode: 0, signal: null, stdout: '  \n', stderr: '' } : undefined);
    expect((await l.cli(['init'])).err).toBe('orbit: cannot locate .git/info/exclude: \n');
  });

  it('starts a new line before its rules when the exclude file does not end in one, and reuses its own header', async () => {
    const l = lab();
    writeFileSync(excludePath(l), '*.scratch');
    await l.cli(['init']);
    expect(readFileSync(excludePath(l), 'utf8')).toBe(`*.scratch\n# Orbit runtime state (added by "orbit init")\n${EXCLUDE_RULES.join('\n')}\n`);

    const m = lab();
    writeFileSync(excludePath(m), '# Orbit runtime state (added by "orbit init")\n/.orbit/runs/\n');
    const r = await m.cli(['init', '--json']);
    expect(JSON.parse(r.out).exclude.added).toEqual(['/.orbit/state.sqlite*', '/.orbit/knowledge.sqlite*']);
    const text = readFileSync(excludePath(m), 'utf8');
    expect(text.split('\n').filter((x) => x.startsWith('# Orbit runtime state'))).toHaveLength(1);
    expect(text.endsWith('/.orbit/knowledge.sqlite*\n')).toBe(true);
  });

  it('creates the exclude file\'s directory when it is missing', async () => {
    const l = lab();
    rmSync(join(l.repo, '.git', 'info'), { recursive: true, force: true });
    const r = await l.cli(['init']);
    expect(r.code, r.err).toBe(0);
    expect(readFileSync(excludePath(l), 'utf8')).toContain('/.orbit/runs/');
  });

  it('lists what does not validate yet, at most ten problems, and prints the success line otherwise', async () => {
    const l = lab();
    mkdirSync(join(l.repo, '.orbit'));
    writeFileSync(configPath(l), 'version: [unclosed\n');
    const bad = await l.cli(['init']);
    expect(bad.code).toBe(0);
    expect(bad.out).toContain(`${configPath(l)} already exists; left unchanged`);
    expect(bad.out).toContain('The configuration does not validate yet:');
    expect(bad.out).toMatch(/\n {2}- yaml: /);
    expect(bad.out).not.toContain('The configuration validates.');
    expect(bad.out).toContain('Next: define your checks in .orbit/config.yaml, then run "orbit doctor".');

    const asJson = JSON.parse((await l.cli(['init', '--json'])).out) as { config_problems: string[] };
    expect(asJson.config_problems.length).toBeGreaterThan(0);
    expect(asJson.config_problems[0]).toMatch(/^yaml: /);

    const many = Array.from({ length: 14 }, (_, i) => `p${i + 1}`);
    hooks.loadConfig = () => {
      throw new OrbitError('CONFIG_INVALID', 'invalid', { problems: many });
    };
    const capped = await l.cli(['init']);
    expect(capped.out).toContain('  - p1\n');
    expect(capped.out).toContain('  - p10\n');
    expect(capped.out).not.toContain('p11');
    hooks.loadConfig = () => {
      throw Object.assign(new Error('plain failure'), { code: 'CONFIG_INVALID', details: { problems: many } });
    };
    // A plain Error is not an Orbit error, so only its message is shown.
    const plain = await l.cli(['init']);
    expect(plain.out).toContain('  - plain failure');
    expect(plain.out).not.toContain('p1\n');
    hooks.loadConfig = () => {
      throw 'a thrown string';
    };
    expect((await l.cli(['init'])).out).toContain('  - a thrown string');

    hooks.loadConfig = null;
    const l2 = lab();
    const ok = await l2.cli(['init']);
    expect(ok.out).toContain('The configuration validates.');
    expect(ok.out).toMatch(/created .*config\.yaml from the starter template/);
    expect(ok.out).toContain('added 3 rule(s)');
    const again = await l2.cli(['init']);
    expect(again.out).toMatch(/already excludes Orbit runtime state/);
  });

  it('refuses an argument', async () => {
    const l = lab();
    expect((await l.cli(['init', 'extra'])).err).toContain('expected 0 argument(s), got 1');
  });
});

describe('orbit gc', () => {
  const DAY = 86_400_000;
  function endedRun(l: Lab, goal: string, days: number) {
    const run = l.newRun(goal);
    l.moveTo(run.id, ['PREFLIGHT', 'CANCELLED']);
    const dir = dirname(getRun(l.db(), run.id).policyPath);
    writeFileSync(join(dir, 'evidence.txt'), 'artifact');
    l.db().run('UPDATE runs SET ended_at = ?, updated_at = ? WHERE id = ?', Date.now() - days * DAY, Date.now() - days * DAY, run.id);
    return { id: run.id, dir };
  }

  it('refuses a negative retention period, and takes 0 to mean every finished run (P19)', async () => {
    const l = lab();
    const r = await l.cli(['gc', '--keep-days=-1']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('--keep-days must be a non-negative integer');
    expect(r.err).toContain('usage: orbit gc [--keep-days <n>] [--dry-run] [--json]');
    const ended = endedRun(l, 'Finished a moment ago.', 0);
    const zero = await l.cli(['gc', '--keep-days', '0']);
    expect(zero.code, zero.err).toBe(0);
    expect(zero.out).toContain('(0 days)');
    expect(zero.out).toContain(`pruned ${ended.id} (CANCELLED`);
    expect(existsSync(ended.dir)).toBe(false);
  });

  it('says "1 day" for one day and takes the period from the policy when none is given', async () => {
    const l = lab();
    await l.cli(['init']);
    l.db();
    const one = await l.cli(['gc', '--keep-days', '1', '--dry-run']);
    expect(one.out).toMatch(/\(1 day\); dry run, nothing removed\n/);
    expect(one.out).toContain('nothing to prune');
    const policy = await l.cli(['gc', '--json']);
    expect(JSON.parse(policy.out)).toMatchObject({ keep_days: 30, dry_run: false, pruned: [], skipped: [] });
  });

  it('names what it pruned, or would prune, with the number of locations', async () => {
    const l = lab();
    const old = endedRun(l, 'Old finished goal.', 40);
    const dry = await l.cli(['gc', '--keep-days', '30', '--dry-run']);
    expect(dry.out).toMatch(new RegExp(`dry run, nothing removed\\nwould prune ${old.id} \\(CANCELLED, ended \\d{4}-\\d\\d-\\d\\dT[^)]*\\): 1 location\\(s\\)\\n$`));
    const real = await l.cli(['gc', '--keep-days', '30', '--json']);
    expect(JSON.parse(real.out)).toMatchObject({ dry_run: false, pruned: [{ runId: old.id, state: 'CANCELLED', removed: [old.dir] }], skipped: [] });
    expect(existsSync(old.dir)).toBe(false);
    const text = await l.cli(['gc', '--keep-days', '30']);
    expect(text.out).toContain('nothing to prune');
    const l2 = lab();
    const other = endedRun(l2, 'Another old goal.', 50);
    const printed = await l2.cli(['gc', '--keep-days', '30']);
    expect(printed.out).toMatch(new RegExp(`\\npruned ${other.id} \\(CANCELLED, ended `));
  });

  it('reports a run it left alone, with the reason, and does not say "nothing to prune"', async () => {
    const l = lab();
    const old = endedRun(l, 'Old finished goal.', 40);
    acquireLease(l.db(), old.id, 'a-controller', 600_000, systemClock);
    const r = await l.cli(['gc', '--keep-days', '30']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`skipped ${old.id}: a controller still holds its lease`);
    expect(r.out).not.toContain('nothing to prune');
    expect(existsSync(old.dir)).toBe(true);
  });
});

describe('orbit policy show', () => {
  /** A run whose frozen policy has every optional part in its other state, so each "none" wording shows. */
  function bareRun(l: Lab) {
    const config: OrbitConfig = defaultConfig('autonomous');
    config.scope = { ...config.scope, allowed_paths: [] };
    config.network = { allowed_hosts: [] };
    config.routing = { ...config.routing, allowed_models: [] };
    config.actions = Object.fromEntries(Object.keys(config.actions).map((k) => [k, k === 'edit'])) as typeof config.actions;
    config.isolation = { ...config.isolation, provider: 'none', allow_unisolated: true };
    config.providers = { claude: { ...config.providers.claude!, data_policy_eligible: false }, codex: config.providers.codex! };
    config.knowledge = { ...config.knowledge, enabled: false };
    return startRun({ db: l.db(), repoRoot: l.repo, goal: 'Policy with nothing allowed', config, clock: systemClock });
  }

  it('prints "none" for each empty allowance and flags what is off', async () => {
    const l = lab();
    const run = bareRun(l);
    const r = await l.cli(['policy', 'show', run.id]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('scope:       may edit nothing');
    expect(r.out).toContain('actions on:  edit\n');
    expect(r.out).toMatch(/actions off: test, commit, .*deploy_production/);
    expect(r.out).toContain('network:     none');
    expect(r.out).toContain('isolation:   none (unisolated runs allowed)');
    expect(r.out).toContain('models:      none');
    expect(r.out).toMatch(/providers:   claude \(not data-policy eligible\), codex/);
    expect(r.out).toContain('checks:      none defined');
    expect(r.out).toContain('knowledge:   off\n');
    expect(r.out).toContain('amendments:  none');
  });

  it('lists the checks, marking optional ones, the amendments with their status, and shared knowledge', async () => {
    const l = lab();
    const config: OrbitConfig = defaultConfig('autonomous');
    config.checks = {
      unit: { ...defaultCheckDef('unit'), mandatory: true },
      lint: { ...defaultCheckDef('lint'), mandatory: false },
    };
    config.knowledge = { ...config.knowledge, share_globally: true };
    config.review = { ...config.review, independent_provider_required: false };
    const run = startRun({ db: l.db(), repoRoot: l.repo, goal: 'Policy with checks', config, clock: systemClock });
    insertAmendment(
      l.db(),
      { runId: run.id, id: 'amd-1', record: { field: 'verification.AC-1', old_value: null, new_value: 'x', evidence: 'e', reason: 'because', approval_required: true, affected_verification: [] }, change: null, status: 'pending-approval' },
      systemClock,
    );
    const r = await l.cli(['policy', 'show', run.id]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('checks:      unit, lint (optional)');
    expect(r.out).toContain('knowledge:   on, shares code-free lessons globally');
    expect(r.out).toContain('independent provider not required');
    expect(r.out).toContain('amendments:  amd-1 [pending-approval] verification.AC-1');
    const j = JSON.parse((await l.cli(['policy', 'show', run.id, '--json'])).out) as { amendments: unknown[] };
    expect(j.amendments).toEqual([{ id: 'amd-1', status: 'pending-approval', field: 'verification.AC-1', reason: 'because', approved_by: null }]);
  });

  it('says "none" for actions when every one is on, or every one is off', async () => {
    const l = lab();
    const all = (v: boolean) => {
      const c = defaultConfig('autonomous');
      c.actions = Object.fromEntries(Object.keys(c.actions).map((k) => [k, v])) as typeof c.actions;
      return startRun({ db: l.db(), repoRoot: l.repo, goal: `All actions ${String(v)}`, config: c, clock: systemClock });
    };
    const on = await l.cli(['policy', 'show', all(true).id]);
    expect(on.out).toContain('actions off: none\n');
    expect(on.out).toMatch(/actions on:  edit, test, .*deploy_production/);
    const off = await l.cli(['policy', 'show', all(false).id]);
    expect(off.out).toContain('actions on:  none\n');
  });

  it('warns that nothing under a tampered policy can be trusted, and shows nothing of it', async () => {
    const l = lab();
    const run = l.newRun();
    chmodSync(run.policyPath, 0o644);
    writeFileSync(run.policyPath, `${JSON.stringify({ tampered: true })}\n`);
    const r = await l.cli(['policy', 'show', run.id]);
    expect(r.code).toBe(4);
    expect(r.out).toBe('');
    expect(r.err).toContain('The frozen policy does not match its recorded hash; the run cannot act under it. Nothing below it can be trusted.\n');
    const j = await l.cli(['policy', 'show', run.id, '--json']);
    expect(j.code).toBe(4);
    expect(JSON.parse(j.err.split('\n').filter((x) => x.startsWith('{'))[0]!).error.code).toBe('POLICY_TAMPERED');
  });

  it('needs exactly one run id and a repository with state', async () => {
    const l = lab();
    const none = await l.cli(['policy', 'show']);
    expect(none.code).toBe(2);
    expect(none.err).toContain('expected 1 argument(s), got 0');
    const noState = await l.cli(['policy', 'show', 'run-1']);
    expect(noState.code).toBe(3);
    expect(noState.err).toContain('no Orbit state in');
  });
});

describe('orbit run --detach', () => {
  it('tells a running service apart from none: no warning, and service_running in the JSON', async () => {
    const l = lab();
    await l.cli(['init']);
    l.db();
    registerController(l.db(), { id: 'svc-1', pid: process.pid, host: hostname(), mode: 'service' }, systemClock);
    const quiet = await l.cli(['run', '--goal', 'Add a mul function.', '--detach']);
    expect(quiet.code, quiet.err).toBe(0);
    expect(quiet.out).toMatch(/run .* created \(autonomous\), handed to the service/);
    expect(quiet.err).toBe('');
    const j = await l.cli(['run', '--goal', 'Add a div function.', '--detach', '--json']);
    expect(JSON.parse(j.out)).toMatchObject({ detached: true, service_running: true, state: 'CREATED' });
  });
});

function defaultCheckDef(id: string) {
  return { id, command: ['node', '-e', '0'], shell: false, cwd: '.', timeout_seconds: 60, network_hosts: [], local_binding: true, env: {}, mandatory: true, flaky_reruns: 0, kind: 'command' as const, category: 'test' as const };
}
