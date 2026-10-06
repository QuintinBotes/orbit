import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import schema from '../../../schemas/config.schema.json' with { type: 'json' };
import { checkCategory, defaultCheck, defaultConfig, isolationLimits, loadConfig, modelPermitted, parseConfig, sastCheckIds, validateConfig } from '../../../src/policy/config.ts';
import { isOrbitError, type OrbitError } from '../../../src/core/errors.ts';

const TEMPLATE = readFileSync(new URL('../../../templates/config.yaml', import.meta.url), 'utf8');

function problems(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    expect(isOrbitError(err, 'CONFIG_INVALID')).toBe(true);
    return ((err as OrbitError).details?.problems as string[]) ?? [];
  }
  throw new Error('expected CONFIG_INVALID');
}

function exampleBlock(name: string): string {
  const lines = TEMPLATE.split('\n');
  const start = lines.indexOf(`# example-${name}:start`);
  const end = lines.indexOf(`# example-${name}:end`);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return lines
    .slice(start + 1, end)
    .map((l) => l.replace(/^# ?/, ''))
    .join('\n');
}

describe('defaults', () => {
  it('fills a minimal file from the spec section 5 example', () => {
    const c = parseConfig('version: 1\n');
    expect(c.mode).toBe('autonomous-delivery');
    expect(c.scope.allowed_paths).toEqual(['apps/**', 'packages/**', 'tests/**', 'docs/**']);
    expect(c.scope.protected_paths).toContain('.github/**');
    expect(c.actions).toMatchObject({ commit: true, push_task_branch: true, open_pull_request: true, merge: false, deploy_production: false });
    expect(c.scheduler.hard_limits).toMatchObject({ implementation_attempts: 12, changed_files: 40, changed_lines: 2000 });
    expect(c.network.allowed_hosts).toEqual(['github.com', 'api.github.com', 'registry.npmjs.org']);
    expect(c.checks).toEqual({});
    expect(c.ui).toBeNull();
    expect(c.review.fallback_same_provider_allowed).toBe(false);
  });

  it('keeps fable out of the default routing allowlist', () => {
    expect(parseConfig('version: 1\n').routing.allowed_models).not.toContain('fable');
  });

  it('defaults delivery actions off in non-delivery modes instead of contradicting them', () => {
    const c = parseConfig('version: 1\nmode: autonomous\n');
    expect(c.actions).toMatchObject({ commit: false, push_task_branch: false, open_pull_request: false, repair_ci: false });
    expect(parseConfig('version: 1\nmode: supervised\nisolation: {provider: none}\n').isolation.provider).toBe('none');
  });

  it('returns a deeply frozen config', () => {
    const c = parseConfig('version: 1\n');
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.scope.allowed_paths)).toBe(true);
    expect(() => {
      (c.actions as { merge: boolean }).merge = true;
    }).toThrow();
  });

  it('produces a document the published schema accepts', () => {
    const Ajv2020 = ((Ajv2020Module as unknown as { default?: typeof Ajv2020Module }).default ?? Ajv2020Module) as typeof Ajv2020Module;
    const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
    // The schema's "format": "date" (security exception expiry) needs the formats the loader registers.
    ((addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ?? addFormatsModule)(ajv);
    const validate = ajv.compile(schema as object);
    expect(validate(JSON.parse(JSON.stringify(defaultConfig())))).toBe(true);
  });

  it('accepts review.security exceptions, with a plain-date expiry and a null location', () => {
    const c = parseConfig(
      [
        'version: 1',
        'review:',
        '  security:',
        '    block_severities: [critical, high]',
        '    exceptions:',
        '      - { category: authorization, severities: [high], reason: tenant model is replaced next quarter, location: null, expires: 2026-12-31 }',
        '',
      ].join('\n'),
    );
    expect(c.review.security.exceptions).toEqual([{ category: 'authorization', severities: ['high'], reason: 'tenant model is replaced next quarter', location: null, expires: '2026-12-31' }]);
  });

  // The starter mode is autonomous (it used to be autonomous-delivery with the four delivery actions written as true,
  // which made `orbit run --mode autonomous` fail on a fresh init), so it resolves to the autonomous defaults.
  it('accepts the starter template and resolves it to the defaults', () => {
    const c = parseConfig(TEMPLATE);
    expect(JSON.parse(JSON.stringify(c))).toEqual(JSON.parse(JSON.stringify(defaultConfig('autonomous'))));
  });

  it('accepts the starter template under every mode, because its delivery actions follow the mode', () => {
    for (const mode of ['supervised', 'autonomous', 'autonomous-delivery'] as const) {
      expect(JSON.parse(JSON.stringify(parseConfig(TEMPLATE, { mode }))), mode).toEqual(JSON.parse(JSON.stringify(defaultConfig(mode))));
    }
  });

  it('keeps the template examples valid when uncommented', () => {
    const raw = { ...(parse(TEMPLATE) as object), ...(parse(`checks:\n${exampleBlock('checks')}`) as object), ...(parse(exampleBlock('ui')) as object) };
    const c = validateConfig(raw);
    expect(Object.keys(c.checks).sort()).toEqual(['build', 'lint', 'sast', 'typecheck', 'ui-journeys', 'unit-tests']);
    expect(c.checks.build).toMatchObject({ shell: true, command: ['npm run build && test -f dist/index.js'] });
    expect(c.checks.lint).toMatchObject({ shell: false, cwd: '.', mandatory: true, timeout_seconds: 300, kind: 'command', category: 'lint' });
    expect(c.checks['ui-journeys']?.category).toBe('ui');
    expect(sastCheckIds({ config: c })).toEqual(['sast']);
    expect(c.ui?.journey_check_ids).toEqual(['ui-journeys']);
    expect(c.ui?.visual_baseline_auto_accept).toBe(false);
    expect(c.ui?.exploration).toEqual({ enabled: false, max_minutes: 15, budget_usd: 2 });
    const release = validateConfig({ ...(parse(TEMPLATE) as object), mode: 'release', actions: { merge: true, deploy_production: true }, ...(parse(exampleBlock('release')) as object) });
    expect(release.release?.merge.method).toBe('squash');
    expect(release.release?.environments.production?.deploy_command).toEqual(['npm', 'run', 'deploy']);
  });

  it('writes no em or en dashes in the template', () => {
    expect(TEMPLATE).not.toMatch(/[\u2013\u2014]/);
  });
});

describe('check normalization', () => {
  it('refuses a string command without an explicit shell: true', () => {
    const p = problems(() => parseConfig('version: 1\nchecks:\n  lint:\n    command: npm run lint\n'));
    expect(p.join('\n')).toMatch(/checks\.lint\.command: a string command would need a shell/);
  });

  it('turns a shell string into a single-element command and fills defaults', () => {
    const c = parseConfig('version: 1\nchecks:\n  lint:\n    command: "npm run lint | tee out"\n    shell: true\n');
    expect(c.checks.lint).toEqual({
      id: 'lint',
      command: ['npm run lint | tee out'],
      shell: true,
      cwd: '.',
      timeout_seconds: 600,
      network_hosts: [],
      local_binding: true,
      env: {},
      mandatory: true,
      flaky_reruns: 0,
      kind: 'command',
      category: 'test',
    });
  });

  it('lets a check bind loopback unless it says local_binding: false, and refuses a non-boolean value', () => {
    const c = parseConfig('version: 1\nchecks:\n  unit: {command: [npm, test]}\n  strict: {command: [npm, test], local_binding: false}\n  open: {command: [npm, test], local_binding: true}\n');
    expect(Object.fromEntries(Object.entries(c.checks).map(([id, k]) => [id, k.local_binding]))).toEqual({ unit: true, strict: false, open: true });
    expect(defaultCheck('x').local_binding).toBe(true);
    expect(problems(() => parseConfig('version: 1\nchecks:\n  a: {command: [x], local_binding: "yes"}\n')).join('\n')).toMatch(/local_binding/);
  });

  it('categorizes checks: default test, playwright implies ui, explicit wins, unknown categories are refused', () => {
    const c = parseConfig(
      [
        'version: 1',
        'checks:',
        '  unit: {command: [npm, test]}',
        '  e2e: {command: [npx, playwright, test], kind: playwright}',
        '  e2e-other: {command: [npx, playwright, test], kind: playwright, category: other}',
        '  semgrep: {command: [semgrep, scan], category: sast}',
        '  audit: {command: [npm, audit], category: sast}',
        '  lint: {command: [npm, run, lint], category: lint}',
        '',
      ].join('\n'),
    );
    expect(Object.fromEntries(Object.entries(c.checks).map(([id, k]) => [id, k.category]))).toEqual({ unit: 'test', e2e: 'ui', 'e2e-other': 'other', semgrep: 'sast', audit: 'sast', lint: 'lint' });
    expect(sastCheckIds({ config: c })).toEqual(['semgrep', 'audit']);
    expect(sastCheckIds({ config: parseConfig('version: 1\n') })).toEqual([]);
    expect(checkCategory({ kind: 'command' })).toBe('test');
    expect(checkCategory({ kind: 'playwright' })).toBe('ui');
    expect(problems(() => parseConfig('version: 1\nchecks:\n  a: {command: [x], category: security}\n')).join('\n')).toMatch(/category/);
  });

  it('refuses shell: true with a multi-element argv, a mismatched id and a missing command', () => {
    const p = problems(() => parseConfig('version: 1\nchecks:\n  a:\n    command: [sh, -c, x]\n    shell: true\n  b:\n    id: c\n    command: [x]\n  d:\n    mandatory: false\n'));
    const text = p.join('\n');
    expect(text).toMatch(/checks\.a\.command: with "shell: true"/);
    expect(text).toMatch(/checks\.b\.id: must equal the key "b"/);
    expect(text).toMatch(/checks\.d\.command: required/);
  });

  it('keeps cwd inside the worktree and credentials out of check env', () => {
    const p = problems(() =>
      parseConfig('version: 1\nchecks:\n  a:\n    command: [x]\n    cwd: ../up\n  b:\n    command: [x]\n    cwd: /abs\n  c:\n    command: [x]\n    env: {GH_TOKEN: t, OK_VAR: v}\n'),
    );
    const text = p.join('\n');
    expect(text).toMatch(/checks\.a\.cwd: must stay inside the worktree/);
    expect(text).toMatch(/checks\.b\.cwd: must be relative/);
    expect(text).toMatch(/checks\.c\.env\.GH_TOKEN: delivery and publishing credentials/);
    expect(text).not.toMatch(/OK_VAR/);
  });

  it('requires check network hosts to be covered by the policy allowlist', () => {
    const p = problems(() => parseConfig('version: 1\nnetwork: {allowed_hosts: ["*.example.com"]}\nchecks:\n  a:\n    command: [x]\n    network_hosts: [api.example.com, other.org]\n'));
    expect(p.join('\n')).toMatch(/checks\.a\.network_hosts\[1\]: "other\.org" is not covered/);
    expect(p.join('\n')).not.toMatch(/network_hosts\[0\]/);
  });
});

describe('mode semantics', () => {
  it('rejects delivery actions outside delivery modes', () => {
    for (const mode of ['supervised', 'autonomous']) {
      for (const action of ['commit', 'push_task_branch', 'open_pull_request', 'repair_ci']) {
        const p = problems(() => parseConfig(`version: 1\nmode: ${mode}\nactions:\n  ${action}: true\n`));
        expect(p.join('\n')).toMatch(new RegExp(`actions\\.${action}: is true but mode "${mode}" does not deliver`));
      }
    }
  });

  it('requires release mode for merge and deploy_production', () => {
    for (const mode of ['supervised', 'autonomous', 'autonomous-delivery']) {
      const p = problems(() => parseConfig(`version: 1\nmode: ${mode}\nactions: {merge: true, deploy_production: true}\n`));
      expect(p.join('\n')).toMatch(/actions\.merge: requires mode "release"/);
      expect(p.join('\n')).toMatch(/actions\.deploy_production: requires mode "release"/);
    }
    const release = 'release: {environments: {production: {deploy_command: [npm, run, deploy]}}}';
    expect(parseConfig(`version: 1\nmode: release\nactions: {merge: true, deploy_production: true}\n${release}\n`).actions.merge).toBe(true);
  });

  it('refuses isolation none in unattended modes unless explicitly allowed', () => {
    for (const mode of ['autonomous', 'autonomous-delivery', 'release']) {
      const extra = mode === 'release' ? 'actions: {merge: true}\nrelease: {}\n' : '';
      const p = problems(() => parseConfig(`version: 1\nmode: ${mode}\n${extra}isolation: {provider: none}\n`));
      expect(p.join('\n')).toMatch(/isolation\.provider: "none" is refused/);
      expect(parseConfig(`version: 1\nmode: ${mode}\n${extra}isolation: {provider: none, allow_unisolated: true}\n`).isolation.provider).toBe('none');
    }
  });

  it('rejects an independent review that may fall back to the same provider', () => {
    const p = problems(() => parseConfig('version: 1\nreview: {independent_provider_required: true, fallback_same_provider_allowed: true}\n'));
    expect(p.join('\n')).toMatch(/review: independent_provider_required and fallback_same_provider_allowed contradict/);
    expect(parseConfig('version: 1\nreview: {independent_provider_required: false, fallback_same_provider_allowed: true}\n').review.fallback_same_provider_allowed).toBe(true);
  });

  it('applies a command-line mode exactly as if the file had said it', () => {
    expect(parseConfig('version: 1\nmode: supervised\n', { mode: 'autonomous-delivery' }).mode).toBe('autonomous-delivery');
    const p = problems(() => parseConfig('version: 1\nactions: {push_task_branch: true}\n', { mode: 'autonomous' }));
    expect(p.join('\n')).toMatch(/actions\.push_task_branch: is true but mode "autonomous"/);
  });

  it('keeps the delivery chain consistent', () => {
    const p = problems(() => parseConfig('version: 1\nactions: {commit: false}\ndelivery: {pull_request: none}\n'));
    const text = p.join('\n');
    expect(text).toMatch(/actions\.push_task_branch: requires actions\.commit/);
    expect(text).toMatch(/delivery\.pull_request: is "none" but actions\.open_pull_request is true/);
  });
});

describe('validation reports every problem at once', () => {
  it('lists schema, glob, host, reference and budget problems together', () => {
    const p = problems(() =>
      parseConfig(
        [
          'version: 1',
          'unknown_top: 1',
          'scope:',
          '  allowed_paths: ["!apps/**", "/abs/**", "../up/**", "ok/**"]',
          '  extra: true',
          'network: {allowed_hosts: ["*", "Example.com", "https://x.org", "*.com", "fine.org"]}',
          'actions: {edit: yes}',
          'review: {preferred_provider: nobody}',
          'routing: {allowed_models: [sonnet], overrides: {planner: claude-opus-5-5, impl: claude-sonnet-5-5}}',
          'retention: {redact_patterns: ["(unclosed"]}',
          'repository: {base_branch: orbit/main, branch_prefix: orbit/}',
          'scheduler: {initial_allowances: {complex_attempts: 50}}',
          'agents: {default_parallelism: 9, isolate_writers: false}',
        ].join('\n'),
      ),
    );
    const text = p.join('\n');
    expect(text).toMatch(/\(top level\): unknown key "unknown_top"/);
    expect(text).toMatch(/scope: unknown key "extra"/);
    expect(text).toMatch(/scope\.allowed_paths\[0\]: "!apps\/\*\*" negation is not supported/);
    expect(text).toMatch(/scope\.allowed_paths\[1\]: "\/abs\/\*\*" must be relative/);
    expect(text).toMatch(/scope\.allowed_paths\[2\]: "\.\.\/up\/\*\*" must not contain a '\.\.' segment/);
    expect(text).toMatch(/network\.allowed_hosts\[0\]: "\*" a bare '\*'/);
    expect(text).toMatch(/network\.allowed_hosts\[1\]: "Example\.com" must be lower case/);
    expect(text).toMatch(/network\.allowed_hosts\[2\]: "https:\/\/x\.org" must be a host name only/);
    expect(text).toMatch(/network\.allowed_hosts\[3\]: "\*\.com" a wildcard needs a registrable domain/);
    expect(text).not.toMatch(/allowed_hosts\[4\]/);
    expect(text).toMatch(/actions\.edit: must be boolean/);
    expect(text).toMatch(/review\.preferred_provider: "nobody" is not defined under providers/);
    expect(text).toMatch(/routing\.overrides\.planner: "claude-opus-5-5" is not permitted/);
    expect(text).not.toMatch(/routing\.overrides\.impl/);
    expect(text).toMatch(/retention\.redact_patterns\[0\]: not a valid regular expression/);
    expect(text).toMatch(/repository\.branch_prefix: "orbit\/" also matches the base branch/);
    expect(text).toMatch(/scheduler\.initial_allowances\.complex_attempts: 50 exceeds/);
    expect(text).toMatch(/agents\.default_parallelism: 9 exceeds/);
    expect(text).toMatch(/agents\.isolate_writers: must be true/);
    expect(p.length).toBeGreaterThanOrEqual(17);
  });

  it('rejects bad YAML, duplicate keys, empty files, non-mappings and prototype keys', () => {
    expect(problems(() => parseConfig('version: 1\nversion: 1\n')).join()).toMatch(/yaml: Map keys must be unique/);
    expect(problems(() => parseConfig('version: [1,\n')).join()).toMatch(/^yaml:/);
    expect(problems(() => parseConfig('')).join()).toMatch(/empty/);
    expect(problems(() => parseConfig('- 1\n- 2\n')).join()).toMatch(/top level must be a mapping/);
    expect(problems(() => parseConfig('version: 1\nscope:\n  __proto__: {allowed_paths: ["**"]}\n')).join()).toMatch(/__proto__: key name is not allowed/);
    expect(problems(() => parseConfig('mode: autonomous\n')).join()).toMatch(/version: required/);
    expect(problems(() => parseConfig('version: 2\n')).join()).toMatch(/version: must be 1/);
  });

  it('refuses argv fields given as strings', () => {
    const p = problems(() => parseConfig('version: 1\ndependencies: {install_command: "npm ci"}\nui: {environment: {start_command: "npm run dev"}}\n'));
    expect(p.join('\n')).toMatch(/dependencies\.install_command: must be an argv array/);
    expect(p.join('\n')).toMatch(/ui\.environment\.start_command: must be an argv array/);
  });

  it('checks ui references and keeps auto-accept of baselines impossible', () => {
    const p = problems(() =>
      parseConfig('version: 1\nchecks:\n  unit: {command: [npm, test]}\nui:\n  journey_check_ids: [unit, missing]\n  visual_baseline_auto_accept: true\n  environment: {production_accounts: true}\n'),
    );
    const text = p.join('\n');
    expect(text).toMatch(/ui\.journey_check_ids: "unit" must be a check of kind "playwright"/);
    expect(text).toMatch(/ui\.journey_check_ids: "missing" is not defined/);
    expect(text).toMatch(/ui\.visual_baseline_auto_accept: must be false/);
    expect(text).toMatch(/ui\.environment\.production_accounts: must be false/);
  });

  it('expands the spec shorthand accessibility: true', () => {
    const c = parseConfig('version: 1\nui: {accessibility: true}\n');
    expect(c.ui?.accessibility).toEqual({ enabled: true, fail_on_new_serious_or_critical: true });
    expect(c.ui?.browsers).toEqual(['chromium']);
  });

  it('requires a container definition for the container provider and fills its limits', () => {
    expect(problems(() => parseConfig('version: 1\nisolation: {provider: container}\n')).join()).toMatch(/isolation\.container: required/);
    expect(parseConfig('version: 1\nisolation: {provider: container, container: {image: "node:22"}}\n').isolation.container).toEqual({ image: 'node:22', memory_mb: 4096, cpus: 2, pids: 512 });
  });

  it('merges user providers over the defaults', () => {
    const c = parseConfig('version: 1\nproviders:\n  codex: {data_policy_eligible: true}\n');
    expect(c.providers.codex).toMatchObject({ command: 'codex', data_policy_eligible: true });
    expect(c.providers.claude).toMatchObject({ command: 'claude' });
  });

  it('requires add_packages to come with change_lockfile', () => {
    expect(problems(() => parseConfig('version: 1\ndependencies: {add_packages: true}\n')).join()).toMatch(/add_packages: requires dependencies\.change_lockfile/);
  });
});

describe('modelPermitted', () => {
  it('accepts exact entries and family members only', () => {
    expect(modelPermitted('sonnet', ['sonnet'])).toBe(true);
    expect(modelPermitted('claude-sonnet-5-5', ['sonnet'])).toBe(true);
    expect(modelPermitted('claude-fable-5-1', ['sonnet', 'opus'])).toBe(false);
    expect(modelPermitted('gpt-x', ['sonnet'])).toBe(false);
  });
});

describe('loadConfig', () => {
  it('reads .orbit/config.yaml from the repo root, or a given path', () => {
    const root = mkdtempSync(join(tmpdir(), 'orbit-cfg-'));
    mkdirSync(join(root, '.orbit'));
    writeFileSync(join(root, '.orbit', 'config.yaml'), 'version: 1\nmode: supervised\n');
    writeFileSync(join(root, 'other.yaml'), 'version: 1\nmode: autonomous\n');
    writeFileSync(join(root, 'release.yaml'), 'version: 1\nmode: autonomous\nactions: {merge: false}\nrelease: {merge: {method: rebase}}\n');
    expect(loadConfig(root).mode).toBe('supervised');
    expect(loadConfig(root, 'other.yaml').mode).toBe('autonomous');
    // A command-line release mode is validated as if the file had said it: it needs a release block and a release action.
    expect(problems(() => loadConfig(root, join(root, 'other.yaml'), { mode: 'release' })).join('\n')).toMatch(/release: required in mode "release"/);
    expect(problems(() => loadConfig(root, 'release.yaml', { mode: 'release' })).join('\n')).toMatch(/needs actions\.merge or actions\.deploy_production/);
  });

  it('reports a missing file as NOT_FOUND and an invalid one with its path', () => {
    const root = mkdtempSync(join(tmpdir(), 'orbit-cfg-'));
    expect(() => loadConfig(root)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    writeFileSync(join(root, 'bad.yaml'), 'version: 1\nmode: yolo\n');
    try {
      loadConfig(root, 'bad.yaml');
      throw new Error('expected failure');
    } catch (err) {
      expect(isOrbitError(err, 'CONFIG_INVALID')).toBe(true);
      expect((err as Error).message).toContain(join(root, 'bad.yaml'));
      expect((err as Error).message).toMatch(/mode: must be one of/);
    }
  });
});

describe('semantic rule failures', () => {
  it('turns a rule that cannot run on a well-formed config into a problem instead of skipping it', async () => {
    const { applySemanticRules } = await import('../../../src/policy/config.ts');
    const broken = function brokenRule(): void {
      throw new Error('boom');
    };
    const ok = (_c: unknown, problems: string[]) => void problems.push('ran');
    const config = defaultConfig();
    const problems: string[] = [];
    applySemanticRules([broken, ok], config, true, problems);
    expect(problems).toEqual([expect.stringMatching(/brokenRule check could not run \(boom\)/), 'ran']);
    // On a malformed config the schema has already said what is wrong.
    const quiet: string[] = [];
    applySemanticRules([broken], config, false, quiet);
    expect(quiet).toEqual([]);
  });
});

describe('sections shared with the delivery, routing, UI, evidence and isolation layers', () => {
  it('defaults every new section so a minimal file resolves, and older-style partial overrides merge with the defaults', () => {
    const c = parseConfig('version: 1\n');
    expect(c.release).toBeNull();
    expect(c.routing.output_budgets).toEqual({ planner: 16000, implementer: 24000, verifier: 8000, reviewer: 12000, inquisitor: 6000, curator: 8000, explorer: 6000 });
    expect(c.dependencies.audit).toEqual({ enabled: false, fail_on: 'high', license_allowlist: null, exceptions: [] });
    expect(c.static_security).toEqual({ block_severities: ['critical', 'high'], exceptions: [] });
    expect(c.isolation.limits).toEqual({ cpu_seconds: 3600, max_processes: 2048, max_file_mb: 2048, memory_mb: 4096 });
    expect(parseConfig('version: 1\nui: true\n').ui?.exploration).toEqual({ enabled: false, max_minutes: 15, budget_usd: 2 });

    const o = parseConfig(
      [
        'version: 1',
        'routing: {output_budgets: {implementer: 12000}}',
        'ui: {exploration: {enabled: true}}',
        'dependencies: {audit: {enabled: true, license_allowlist: [MIT, Apache-2.0], exceptions: [{id: GHSA-c2qf-rxjj-qqgw, reason: no reachable code path in our usage}]}}',
        'static_security: {block_severities: [critical], exceptions: [{rule_id: generic-api-key, reason: documented sample key in fixtures, path_glob: "tests/fixtures/**"}]}',
        'isolation: {limits: {cpu_seconds: 600}}',
        '',
      ].join('\n'),
    );
    expect(o.routing.output_budgets).toMatchObject({ implementer: 12000, planner: 16000 });
    expect(o.ui?.exploration).toEqual({ enabled: true, max_minutes: 15, budget_usd: 2 });
    expect(o.dependencies.audit?.exceptions).toEqual([{ id: 'GHSA-c2qf-rxjj-qqgw', reason: 'no reachable code path in our usage', expires: null }]);
    expect(o.static_security?.exceptions).toEqual([{ rule_id: 'generic-api-key', reason: 'documented sample key in fixtures', path_glob: 'tests/fixtures/**', expires: null }]);
    expect(o.isolation.limits).toEqual({ cpu_seconds: 600, max_processes: 2048, max_file_mb: 2048, memory_mb: 4096 });
  });

  it('fills release defaults and checks release settings against the rest of the policy', () => {
    const c = parseConfig('version: 1\nmode: release\nactions: {merge: true, deploy_production: true}\nrelease: {environments: {production: {deploy_command: [npm, run, deploy], network_hosts: [api.github.com]}}}\n');
    expect(c.release).toEqual({
      merge: { method: 'squash', require_checks: [], delete_branch: true, mark_ready: true },
      environments: { production: { deploy_command: ['npm', 'run', 'deploy'], verify_command: null, allowed_branches: ['main'], require_ci_green: true, network_hosts: ['api.github.com'], timeout_seconds: 1800 } },
    });
    const p = problems(() =>
      parseConfig(
        [
          'version: 1',
          'mode: release',
          'actions: {merge: false, deploy_production: true}',
          'release:',
          '  merge: {method: fast-forward}',
          '  environments:',
          '    staging: {deploy_command: "npm run deploy", network_hosts: [deploy.acme.example.com], allowed_branches: []}',
          '    production: {timeout_seconds: 60}',
          '',
        ].join('\n'),
      ),
    ).join('\n');
    expect(p).toMatch(/release\.merge\.method: must be one of "squash", "merge", "rebase"/);
    expect(p).toMatch(/release\.environments\.staging\.deploy_command: must be an argv array/);
    expect(p).toMatch(/release\.environments\.production\.deploy_command: required/);
    expect(p).toMatch(/release\.environments\.staging\.network_hosts\[0\]: "deploy\.acme\.example\.com" is not covered by network\.allowed_hosts/);
    expect(p).toMatch(/release\.environments\.staging\.allowed_branches: is empty/);
    expect(problems(() => parseConfig('version: 1\nmode: release\nactions: {deploy_production: true}\nrelease: {}\n')).join('\n')).toMatch(/no environment is defined to deploy to/);
    // A release block outside release mode is kept and does nothing.
    expect(parseConfig('version: 1\nrelease: {merge: {method: merge}}\n').release?.merge.method).toBe('merge');
  });

  it('refuses malformed exceptions, budgets and limits', () => {
    const p = problems(() =>
      parseConfig(
        [
          'version: 1',
          'routing: {output_budgets: {implementer: 10, reviewer_x: 100}}',
          'dependencies: {audit: {fail_on: severe, exceptions: [{id: "anything goes", reason: short}]}}',
          'static_security: {block_severities: [info], exceptions: [{rule_id: x, reason: a long enough reason, path_glob: "../outside/**", expires: 31-12-2026}]}',
          'isolation: {limits: {max_processes: 4, max_file_mb: 0, memory_mb: 8}}',
          'ui: {exploration: {max_minutes: 0}}',
          '',
        ].join('\n'),
      ),
    ).join('\n');
    expect(p).toMatch(/routing\.output_budgets\.implementer: must be >= 100/);
    expect(p).toMatch(/routing\.output_budgets: unknown key "reviewer_x"/);
    expect(p).toMatch(/dependencies\.audit\.fail_on: must be one of/);
    expect(p).toMatch(/dependencies\.audit\.exceptions\[0\]\.id: must match pattern/);
    expect(p).toMatch(/dependencies\.audit\.exceptions\[0\]\.reason: must NOT have fewer than 10 characters/);
    expect(p).toMatch(/static_security\.block_severities\[0\]: must be one of/);
    expect(p).toMatch(/static_security\.exceptions\[0\]\.path_glob: "\.\.\/outside\/\*\*"/);
    expect(p).toMatch(/static_security\.exceptions\[0\]\.expires: must match format "date"/);
    expect(p).toMatch(/isolation\.limits\.max_processes/);
    expect(p).toMatch(/isolation\.limits\.max_file_mb/);
    expect(p).toMatch(/isolation\.limits\.memory_mb/);
    expect(p).toMatch(/ui\.exploration\.max_minutes: must be >= 1/);
  });
});

describe('keys the policy cannot turn off (gap G26)', () => {
  it('refuses require_independent_work_units: false and change_secrets: true, and keeps change_permissions configurable', () => {
    const p = problems(() => parseConfig('version: 1\nagents: {require_independent_work_units: false}\nactions: {change_secrets: true}\n')).join('\n');
    expect(p).toMatch(/agents\.require_independent_work_units: must be true/);
    expect(p).toMatch(/actions\.change_secrets: must be false/);
    expect(parseConfig('version: 1\nactions: {change_permissions: true}\n').actions.change_permissions).toBe(true);
    expect(parseConfig('version: 1\n').actions.change_permissions).toBe(false);
  });

  it('refuses a redaction pattern that matches the empty string, which redaction could only skip (a silent leak)', () => {
    const p = problems(() => parseConfig('version: 1\nretention: {redact_patterns: ["acme-[A-Z0-9]{8}", "(?:acme_key=)?[A-Za-z0-9]*"]}\n'));
    expect(p.join('\n')).toMatch(/retention\.redact_patterns\[1\]: matches the empty string/);
    expect(p.join('\n')).not.toMatch(/redact_patterns\[0\]/);
  });
});

describe('limits, rebase and release keys added for the isolation and delivery layers (G24)', () => {
  it('turns the limits on by default, lets a value be switched off with null, and keeps unset keys at their defaults', () => {
    const d = parseConfig('version: 1\n');
    expect(d.isolation.limits).toEqual({ cpu_seconds: 3600, max_processes: 2048, max_file_mb: 2048, memory_mb: 4096 });
    expect(defaultConfig().isolation.limits).toEqual(d.isolation.limits);
    expect(parseConfig('version: 1\nisolation: {limits: {memory_mb: null, max_processes: null}}\n').isolation.limits).toEqual({ cpu_seconds: 3600, max_processes: null, max_file_mb: 2048, memory_mb: null });
    expect(isolationLimits({ isolation: { ...d.isolation, limits: { cpu_seconds: 5, max_processes: 7, max_file_mb: null } as never } })).toEqual({ cpu_seconds: 5, max_processes: 7, max_file_mb: null, memory_mb: 4096 });
  });

  it('defaults isolation.require_resource_limits to false, accepts true, and refuses a non-boolean (G24)', () => {
    expect(parseConfig('version: 1\n').isolation.require_resource_limits).toBe(false);
    expect(defaultConfig().isolation.require_resource_limits).toBe(false);
    expect(parseConfig('version: 1\nisolation: {require_resource_limits: true}\n').isolation.require_resource_limits).toBe(true);
    expect(problems(() => parseConfig('version: 1\nisolation: {require_resource_limits: sometimes}\n')).join('\n')).toMatch(/isolation\/require_resource_limits|isolation\.require_resource_limits/);
  });

  it('defaults actions.rebase_task_branch to false and requires actions.commit for it', () => {
    expect(parseConfig('version: 1\n').actions.rebase_task_branch).toBe(false);
    expect(parseConfig('version: 1\nmode: autonomous-delivery\nactions: {rebase_task_branch: true}\n').actions.rebase_task_branch).toBe(true);
    expect(problems(() => parseConfig('version: 1\nmode: autonomous\nactions: {rebase_task_branch: true}\n')).join('\n')).toMatch(/actions\.rebase_task_branch: requires actions\.commit/);
    expect(problems(() => parseConfig('version: 1\nactions: {rebase_task_branch: yes-please}\n')).join('\n')).toMatch(/actions\.rebase_task_branch/);
  });

  it('reads release.merge.mark_ready and release.environments.*.verify_command, argv only', () => {
    const c = parseConfig('version: 1\nmode: release\nactions: {merge: true, deploy_production: true}\nrelease: {merge: {mark_ready: false}, environments: {production: {deploy_command: [npm, run, deploy], verify_command: [npm, run, check-deploy]}}}\n');
    expect(c.release?.merge.mark_ready).toBe(false);
    expect(c.release?.environments.production?.verify_command).toEqual(['npm', 'run', 'check-deploy']);
    const bad = problems(() => parseConfig('version: 1\nmode: release\nactions: {merge: true}\nrelease: {environments: {production: {deploy_command: [npm, run, deploy], verify_command: "npm run check"}, staging: {deploy_command: [x], verify_command: [""]}}}\n')).join('\n');
    expect(bad).toMatch(/release\.environments\.production\.verify_command: must be an argv array/);
    expect(bad).toMatch(/release\.environments\.staging\.verify_command: the program must not be empty/);
  });
});
