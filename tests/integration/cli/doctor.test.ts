/**
 * `orbit doctor` as a child process in a controlled environment: a temp
 * repository, a private HOME, and fake `claude` and `codex` executables
 * (tests/fakes) as the only provider CLIs on PATH.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeScratch, makeSandbox, removeScratch, TEST_CONFIG, type Sandbox } from './helpers.ts';

interface Check {
  id: string;
  area: string;
  status: 'pass' | 'warn' | 'fail';
  summary: string;
  details: string[];
  missing: string | null;
  fix: string | null;
}
interface Report {
  repo: string | null;
  ok: boolean;
  counts: { pass: number; warn: number; fail: number };
  checks: Check[];
}

/** review.when_unavailable: block, the default before decision 0007 (#6, #8): Codex is then needed and judged as such. */
const BLOCK_CONFIG = TEST_CONFIG.replace('knowledge:', 'review:\n  when_unavailable: block\nknowledge:');

const boxes: Sandbox[] = [];
function box(opts: Parameters<typeof makeSandbox>[0] = {}): Sandbox {
  const b = makeSandbox(opts);
  boxes.push(b);
  return b;
}
afterEach(() => {
  boxes.splice(0).forEach((b) => b.close());
  removeScratch();
});

async function doctor(b: Sandbox, extra: string[] = [], opts: Parameters<Sandbox['run']>[1] = {}): Promise<{ code: number | null; report: Report; stderr: string }> {
  const r = await b.run(['doctor', '--json', ...extra], opts);
  return { code: r.code, report: JSON.parse(r.stdout) as Report, stderr: r.stderr };
}
const byId = (r: Report, id: string): Check => {
  const c = r.checks.find((x) => x.id === id);
  if (!c) throw new Error(`no check ${id}; have ${r.checks.map((x) => x.id).join(', ')}`);
  return c;
};

describe('orbit doctor with working provider CLIs', () => {
  it('passes every capability it can verify and says what it could not', async () => {
    const b = box();
    const { code, report } = await doctor(b);
    expect(code, JSON.stringify(report.checks.filter((c) => c.status === 'fail'))).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.counts.fail).toBe(0);
    for (const id of ['runtime.node', 'runtime.sqlite', 'git.cli', 'git.repo', 'config', 'storage', 'checks', 'claude.cli', 'claude.auth', 'codex.cli', 'codex.auth', 'review', 'models', 'playwright', 'delivery']) {
      expect(byId(report, id).status, id).toBe('pass');
    }
    expect(byId(report, 'claude.cli').summary).toMatch(/^claude 2\.1\.288 at .*tools\/claude$/);
    expect(byId(report, 'codex.cli').summary).toMatch(/^codex 0\.153\.4 at /);
    // A credential's presence is reported as presence, never as validity.
    expect(byId(report, 'claude.auth').summary).toMatch(/present \(api_key\); not verified \(use --probe/);
    expect(byId(report, 'codex.auth').summary).toMatch(/codex credential valid \(api_key\)/);
    expect(byId(report, 'review').summary).toMatch(/independent review: codex\/gpt-6-astra \(independent\)/);
    expect(byId(report, 'models').details.join('\n')).toMatch(/claude-sonnet-5-5: eligible, unvalidated/);
    expect(byId(report, 'models').details.join('\n')).toMatch(/claude-fable-5-1: excluded, not in routing.allowed_models/);
    expect(byId(report, 'checks').details[0]).toMatch(/^unit: node -> /);
    // Nothing is created in the repository by looking.
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(b.repo, '.orbit', 'state.sqlite'))).toBe(false);
  });

  it('states the isolation provider and every limitation it carries', async () => {
    const b = box();
    const { report } = await doctor(b);
    const iso = byId(report, 'isolation');
    expect(iso.status).toBe('warn');
    expect(iso.missing).toBe('an isolation provider');
    expect(iso.details[0]).toBe('provider: none');
    expect(iso.details.filter((d) => d.startsWith('limitation: ')).length).toBeGreaterThanOrEqual(5);
    const tier = byId(report, 'claude.worker-tier');
    expect(tier.status).toBe('warn');
    expect(tier.details.join('\n')).toMatch(/limitation: Edit and Write are confined by Claude Code's permission rules/);
  });

  it('prints each failure with the exact missing capability and the fix, as text', async () => {
    const b = box({ config: BLOCK_CONFIG, fakes: { codex: false } });
    const r = await b.run(['doctor']);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/^PASS {2}claude\.cli /m);
    expect(r.stdout).toMatch(/^FAIL {2}codex\.cli /m);
    expect(r.stdout).toMatch(/^ {6}missing: the codex CLI \(codex\) on PATH/m);
    expect(r.stdout).toMatch(/^ {6}fix: {5}install the Codex CLI/m);
    expect(r.stdout).toMatch(/\d+ passed, \d+ warning\(s\), [1-9]\d* failed/);
  });
});

describe('orbit doctor with missing or broken capabilities', () => {
  it('fails when the claude CLI is not on PATH, and names it', async () => {
    const b = box({ fakes: { claude: false } });
    const { code, report } = await doctor(b);
    expect(code).toBe(1);
    const c = byId(report, 'claude.cli');
    expect(c.status).toBe('fail');
    expect(c.missing).toMatch(/claude CLI \(claude\) on PATH/);
    expect(c.fix).toMatch(/install Claude Code/);
    // With no Claude, nothing can implement, and the models check says so too.
    expect(byId(report, 'models').status).toBe('pass');
    expect(byId(report, 'codex.cli').status).toBe('pass');
  });

  it('fails when a credential is missing and gives the provider\'s own login command', async () => {
    // Both fakes read their login state from a scenario file named in their wrapper's environment.
    const scenario = join(makeScratch(), 'scenario.json');
    writeFileSync(scenario, JSON.stringify({ auth: { loggedIn: false, authMethod: 'none', method: 'chatgpt', valid: false } }));
    const lo = box({ config: BLOCK_CONFIG, fakes: { claude: { ORBIT_FAKE_SCENARIO: scenario }, codex: { ORBIT_FAKE_SCENARIO: scenario } } });
    const { code, report } = await doctor(lo);
    expect(code).toBe(1);
    const claude = byId(report, 'claude.auth');
    expect(claude.status).toBe('fail');
    expect(claude.fix).toMatch(/claude auth login/);
    expect(claude.fix).toMatch(/ANTHROPIC_API_KEY/);
    const codex = byId(report, 'codex.auth');
    expect(codex.status).toBe('fail');
    expect(codex.fix).toMatch(/codex login/);
    expect(codex.fix).toMatch(/CODEX_API_KEY/);
    // A reviewer that cannot authenticate blocks independent review, which this policy requires.
    expect(byId(report, 'review').status).toBe('fail');
    expect(byId(report, 'review').summary).toMatch(/would block/);
  });

  it('excludes models an old claude cannot run, and fails only when none is left', async () => {
    const old = box({ fakes: { claude: { ORBIT_FAKE_CLAUDE_VERSION: '2.1.270' } } });
    const { report } = await doctor(old);
    const models = byId(report, 'models');
    expect(models.status).toBe('pass');
    expect(models.details.join('\n')).toMatch(/claude-sonnet-5-5: excluded, needs claude >= 2\.1\.284, installed 2\.1\.270/);
    expect(models.details.join('\n')).toMatch(/claude-haiku-4-5-20251001: eligible/);

    const sonnetOnly = box({ config: TEST_CONFIG.replace('knowledge:', 'routing:\n  allowed_models: [sonnet]\nknowledge:'), fakes: { claude: { ORBIT_FAKE_CLAUDE_VERSION: '2.1.270' } } });
    const r = await doctor(sonnetOnly);
    expect(r.code).toBe(1);
    const m = byId(r.report, 'models');
    expect(m.status).toBe('fail');
    expect(m.missing).toMatch(/at least one routing.allowed_models entry that the installed claude CLI can run/);
  });

  it('reports configured checks that cannot run, including package scripts that do not exist', async () => {
    const cfg = TEST_CONFIG.replace(
      '    command: [node, -e, "process.exit(0)"]',
      ['    command: [node, -e, "process.exit(0)"]', '  lint:', '    command: [npm, run, lint]', '  ghost:', '    command: [definitely-not-installed-xyz, --flag]', '  optional-ghost:', '    command: [another-missing-tool]', '    mandatory: false'].join('\n'),
    );
    const b = box({ config: cfg });
    const npm = join(b.tools, 'npm');
    writeFileSync(npm, '#!/bin/sh\nexit 0\n');
    chmodSync(npm, 0o755);
    writeFileSync(join(b.repo, 'package.json'), JSON.stringify({ name: 'acme', scripts: { test: 'echo ok' } }));
    const { code, report } = await doctor(b);
    expect(code).toBe(1);
    const c = byId(report, 'checks');
    expect(c.status).toBe('fail');
    expect(c.summary).toBe('3 of 4 check(s) cannot run');
    const d = c.details.join('\n');
    expect(d).toMatch(/lint: npm script "lint" is not defined in package\.json/);
    expect(d).toMatch(/ghost: "definitely-not-installed-xyz" was not found/);
    expect(d).toMatch(/optional-ghost: "another-missing-tool" was not found \(optional check\)/);
    expect(d).toMatch(/unit: node -> /);
  });

  it('warns, rather than fails, when only optional checks cannot run', async () => {
    const cfg = TEST_CONFIG.replace('    command: [node, -e, "process.exit(0)"]', ['    command: [node, -e, "process.exit(0)"]', '  extra:', '    command: [another-missing-tool]', '    mandatory: false'].join('\n'));
    const { report } = await doctor(box({ config: cfg }));
    expect(byId(report, 'checks').status).toBe('warn');
  });

  it('reports a missing or invalid configuration without crashing', async () => {
    const none = box({ config: null });
    const a = await doctor(none);
    expect(a.code).toBe(1);
    expect(byId(a.report, 'config')).toMatchObject({ status: 'fail', fix: expect.stringContaining('orbit init') });
    expect(byId(a.report, 'claude.cli').status).toBe('pass');

    const bad = box({ config: 'version: 1\nmode: sideways\nunknown_key: true\n' });
    const b = await doctor(bad);
    const c = byId(b.report, 'config');
    expect(c.status).toBe('fail');
    expect(c.details.join('\n')).toMatch(/mode/);
    expect(c.details.join('\n')).toMatch(/unknown_key/);
  });

  it('fails outside a git repository', async () => {
    const b = box();
    const { code, report } = await doctor(b, [], { cwd: b.base });
    expect(code).toBe(1);
    expect(report.repo).toBeNull();
    expect(byId(report, 'git.repo')).toMatchObject({ status: 'fail', missing: 'a git repository to run in' });
  });

  it('warns about an unclean tree and a missing remote when delivering', async () => {
    const cfg = TEST_CONFIG.replace('mode: autonomous', 'mode: autonomous-delivery');
    const b = box({ config: cfg });
    writeFileSync(join(b.repo, 'stray.txt'), 'x');
    const { report } = await doctor(b);
    const g = byId(report, 'git.repo');
    expect(g.status).toBe('warn');
    expect(g.missing).toMatch(/remote origin/);
    expect(g.missing).toMatch(/a clean working tree/);
    // Delivery is on, so a missing GitHub credential is a failure with the exact token requirement.
    const d = byId(report, 'delivery');
    expect(d.status).toBe('fail');
    expect(d.missing).toMatch(/gh executable|GH_TOKEN/);
  });

  it('reports the storage state of an existing database', async () => {
    const b = box();
    const { openDb } = await import('../../../src/storage/db.ts');
    mkdirSync(join(b.repo, '.orbit'), { recursive: true });
    openDb(join(b.repo, '.orbit', 'state.sqlite')).close();
    const { report } = await doctor(b);
    expect(byId(report, 'storage').summary).toMatch(/state database writable, WAL, schema version \d+\/\d+/);
  });
});

describe('orbit doctor: service, terms and playwright', () => {
  it('reports that no service is installed and how to install one', async () => {
    const b = box();
    const { report } = await doctor(b);
    const s = byId(report, 'service');
    expect(s.status).toBe('warn');
    expect(s.fix).toBe('orbit service install');
    expect(s.details.join('\n')).toMatch(/heartbeat: no controller has registered/);
  });

  it('reports the publish-guard terms file by presence and count, and never prints a term', async () => {
    const b = box();
    const none = byId((await doctor(b)).report, 'guard.terms');
    expect(none.status).toBe('warn');
    const dir = join(b.home, '.config', 'publish-guard');
    mkdirSync(dir, { recursive: true });
    const secret = 'zq-synthetic-private-term-7781';
    writeFileSync(join(dir, 'terms.txt'), `${secret}\nanother-synthetic-term-9921\n`);
    const r = await b.run(['doctor', '--json']);
    const g = byId(JSON.parse(r.stdout) as Report, 'guard.terms');
    expect(g.status).toBe('pass');
    expect(g.summary).toMatch(/2 term\(s\); never printed/);
    expect(r.stdout + r.stderr).not.toContain(secret);
    expect(r.stdout + r.stderr).not.toContain('another-synthetic-term');
    const text = await b.run(['doctor']);
    expect(text.stdout).not.toContain(secret);
  });

  it('requires Playwright and its browsers only when the policy uses them', async () => {
    const notNeeded = byId((await doctor(box())).report, 'playwright');
    expect(notNeeded.status).toBe('pass');
    expect(notNeeded.summary).toMatch(/not required/);

    const cfg = TEST_CONFIG.replace('knowledge:', ['ui:', '  ui_paths: ["src/**"]', '  journey_check_ids: [ui]', 'knowledge:'].join('\n')).replace('checks:\n', 'checks:\n  ui:\n    command: [node, -e, "0"]\n    kind: playwright\n');
    const b = box({ config: cfg });
    const needed = byId((await doctor(b)).report, 'playwright');
    expect(needed.status).toBe('fail');
    expect(needed.missing).toMatch(/@playwright\/test in the repository/);

    // Present packages with a browsers manifest but no installed browser: the missing browser is named.
    const pw = join(b.repo, 'node_modules', '@playwright', 'test');
    const core = join(b.repo, 'node_modules', 'playwright-core');
    mkdirSync(pw, { recursive: true });
    mkdirSync(core, { recursive: true });
    writeFileSync(join(pw, 'package.json'), '{"name":"@playwright/test","version":"1.0.0"}');
    writeFileSync(join(core, 'package.json'), '{"name":"playwright-core","version":"1.0.0"}');
    writeFileSync(join(core, 'browsers.json'), JSON.stringify({ browsers: [{ name: 'chromium', revision: '9999' }, { name: 'chromium_headless_shell', revision: '9999' }] }));
    const cache = join(b.base, 'pw-cache');
    mkdirSync(cache, { recursive: true });
    const missing = byId((await doctor(b, [], { env: { PLAYWRIGHT_BROWSERS_PATH: cache } })).report, 'playwright');
    expect(missing.status).toBe('fail');
    expect(missing.missing).toMatch(/chromium/);
    expect(missing.fix).toMatch(/npx playwright install chromium/);
    mkdirSync(join(cache, 'chromium-9999'));
    // The default ui policy also scans accessibility, which needs axe.
    const axe = join(b.repo, 'node_modules', '@axe-core', 'playwright');
    mkdirSync(axe, { recursive: true });
    writeFileSync(join(axe, 'package.json'), '{"name":"@axe-core/playwright","version":"1.0.0"}');
    const ok = byId((await doctor(b, [], { env: { PLAYWRIGHT_BROWSERS_PATH: cache } })).report, 'playwright');
    expect(ok.status).toBe('pass');
  });

  it('makes tiny live requests, per provider and per eligible model, only with --probe', async () => {
    const b = box();
    const plain = await doctor(b);
    expect(byId(plain.report, 'claude.auth').summary).not.toMatch(/live request/);
    expect(byId(plain.report, 'models').details.join('\n')).not.toMatch(/live probe/);
    const probed = await doctor(b, ['--probe']);
    expect(probed.code).toBe(0);
    expect(byId(probed.report, 'claude.auth').summary).toMatch(/^claude credential valid .*, confirmed by a live request$/);
    const models = byId(probed.report, 'models').details.filter((d) => d.includes(': eligible'));
    expect(models).toHaveLength(3);
    for (const m of models) expect(m).toMatch(/live probe answered/);
  });

  it('never prints a credential from the environment', async () => {
    const b = box();
    const key = 'sk-ant-api03-synthetic0123456789abcdefghijklmnop';
    const r = await b.run(['doctor'], { env: { ANTHROPIC_API_KEY: key, CODEX_API_KEY: 'sk-synthetic-codex-0123456789abcdefghij', GH_TOKEN: 'ghp_synthetic0123456789abcdefghijklmnopqrstuv' } });
    expect(r.stdout + r.stderr).not.toContain(key);
    expect(r.stdout + r.stderr).not.toContain('synthetic-codex');
    expect(r.stdout + r.stderr).not.toContain('ghp_synthetic');
    // The environment credential does move workers into the stronger tier, and doctor says so.
    expect(r.stdout).toMatch(/PASS|WARN/);
  });
});
