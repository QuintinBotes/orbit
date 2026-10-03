import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import Ajv2020Module from 'ajv/dist/2020.js';
import schema from '../../../schemas/config.schema.json' with { type: 'json' };
import { defaultConfig, loadConfig, modelPermitted, parseConfig, validateConfig } from '../../../src/policy/config.ts';
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
    const validate = new Ajv2020({ strict: true, allowUnionTypes: true }).compile(schema as object);
    expect(validate(JSON.parse(JSON.stringify(defaultConfig())))).toBe(true);
  });

  it('accepts the starter template and resolves it to the defaults', () => {
    const c = parseConfig(TEMPLATE);
    expect(JSON.parse(JSON.stringify(c))).toEqual(JSON.parse(JSON.stringify(defaultConfig())));
  });

  it('keeps the template examples valid when uncommented', () => {
    const raw = { ...(parse(TEMPLATE) as object), ...(parse(`checks:\n${exampleBlock('checks')}`) as object), ...(parse(exampleBlock('ui')) as object) };
    const c = validateConfig(raw);
    expect(Object.keys(c.checks).sort()).toEqual(['build', 'lint', 'typecheck', 'ui-journeys', 'unit-tests']);
    expect(c.checks.build).toMatchObject({ shell: true, command: ['npm run build && test -f dist/index.js'] });
    expect(c.checks.lint).toMatchObject({ shell: false, cwd: '.', mandatory: true, timeout_seconds: 300, kind: 'command' });
    expect(c.ui?.journey_check_ids).toEqual(['ui-journeys']);
    expect(c.ui?.visual_baseline_auto_accept).toBe(false);
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
      env: {},
      mandatory: true,
      flaky_reruns: 0,
      kind: 'command',
    });
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
    expect(parseConfig('version: 1\nmode: release\nactions: {merge: true, deploy_production: true}\n').actions.merge).toBe(true);
  });

  it('refuses isolation none in unattended modes unless explicitly allowed', () => {
    for (const mode of ['autonomous', 'autonomous-delivery', 'release']) {
      const p = problems(() => parseConfig(`version: 1\nmode: ${mode}\nisolation: {provider: none}\n`));
      expect(p.join('\n')).toMatch(/isolation\.provider: "none" is refused/);
      expect(parseConfig(`version: 1\nmode: ${mode}\nisolation: {provider: none, allow_unisolated: true}\n`).isolation.provider).toBe('none');
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
    expect(loadConfig(root).mode).toBe('supervised');
    expect(loadConfig(root, 'other.yaml').mode).toBe('autonomous');
    expect(loadConfig(root, join(root, 'other.yaml'), { mode: 'release' }).mode).toBe('release');
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
