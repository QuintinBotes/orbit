/**
 * Loading `.orbit/config.yaml` (spec §5). The file is trusted input, but it
 * is still validated strictly: a typo that silently fell back to a default
 * could widen authority, so unknown keys, wrong types and contradictory
 * settings are all errors, reported together in one CONFIG_INVALID.
 *
 * Order: parse YAML -> normalize shorthands (string commands, partial check,
 * ui and provider entries) -> merge over documented defaults -> validate the
 * merged result against schemas/config.schema.json -> semantic rules (mode
 * contradictions, references between sections, glob and host syntax).
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, join, posix, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import Ajv2020Module from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv/dist/2020.js';
import configSchema from '../../schemas/config.schema.json' with { type: 'json' };
import { OrbitError } from '../core/errors.ts';
import type { CheckDefinition, OrbitConfig, ProviderConfig, UiConfig } from './types.ts';
import { globProblem } from './globs.ts';
import { hostEntryCovered, hostEntryProblem } from './hosts.ts';

/** Derived from the contract type so policy/ never imports controller/ (architecture dependency rule). */
export type RunMode = OrbitConfig['mode'];

type AjvCtor = typeof Ajv2020Module;
// ajv is CommonJS; under ESM the class arrives either as the default export or as the module itself.
const Ajv2020 = ((Ajv2020Module as unknown as { default?: AjvCtor }).default ?? Ajv2020Module) as AjvCtor;

export const CONFIG_RELATIVE_PATH = '.orbit/config.yaml';

export const RUN_MODES: readonly RunMode[] = Object.freeze(['supervised', 'autonomous', 'autonomous-delivery', 'release']);

/** The spec's unified configuration example runs in this mode, so it is the default. */
export const DEFAULT_MODE: RunMode = 'autonomous-delivery';

/** Modes that may commit, push task branches, open PRs and repair CI (spec §5 Execution modes). */
export const DELIVERY_MODES: ReadonlySet<RunMode> = new Set<RunMode>(['autonomous-delivery', 'release']);

/** Modes that run without a person approving each material step. */
export const UNATTENDED_MODES: ReadonlySet<RunMode> = new Set<RunMode>(['autonomous', 'autonomous-delivery', 'release']);

export const DELIVERY_ACTIONS = Object.freeze(['commit', 'push_task_branch', 'open_pull_request', 'repair_ci'] as const);
export const RELEASE_ACTIONS = Object.freeze(['merge', 'deploy_production'] as const);

/**
 * Environment names a check may not set. Checks run repository code, which is
 * as untrusted as the model that just edited it, so delivery and publishing
 * credentials must never reach them (spec §5 "Separate implementation and
 * delivery credentials").
 */
export const FORBIDDEN_CHECK_ENV: ReadonlySet<string> = new Set([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'SSH_AUTH_SOCK',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
]);

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface ConfigOptions {
  /** Shown in error messages. */
  source?: string;
  /** Mode from the command line; validated exactly as if the file had said it. */
  mode?: RunMode;
}

// ---------------------------------------------------------------------------
// Defaults

/**
 * The documented defaults: the spec §5 example, plus values for fields the
 * spec leaves open. Delivery actions default on only in delivery modes, so
 * `mode: autonomous` with no actions block is valid rather than contradictory.
 */
export function defaultConfig(mode: RunMode = DEFAULT_MODE): OrbitConfig {
  const delivering = DELIVERY_MODES.has(mode);
  return {
    version: 1,
    mode,
    repository: { base_branch: 'main', branch_prefix: 'orbit/', allow_dirty_start: false, remote: 'origin' },
    scope: {
      allowed_paths: ['apps/**', 'packages/**', 'tests/**', 'docs/**'],
      protected_paths: ['.github/**', 'infra/**', '.orbit/config.yaml', '**/.env*'],
    },
    actions: {
      edit: true,
      test: true,
      commit: delivering,
      push_task_branch: delivering,
      open_pull_request: delivering,
      read_ci_logs: delivering,
      repair_ci: delivering,
      merge: false,
      deploy_production: false,
      change_secrets: false,
      change_permissions: false,
    },
    dependencies: {
      install_existing_lockfile: true,
      install_command: null,
      add_packages: false,
      change_lockfile: false,
      install_scripts: 'deny-unless-allowlisted',
      install_script_allowlist: [],
    },
    network: { allowed_hosts: ['github.com', 'api.github.com', 'registry.npmjs.org'] },
    ambiguity: {
      resolve_reversible_choices: true,
      require_evidence_for_behavior_changes: true,
      block_security_or_data_semantics: true,
    },
    scheduler: {
      hard_limits: {
        implementation_attempts: 12,
        diagnostic_experiments: 16,
        review_rounds: 4,
        ci_repair_cycles: 3,
        worker_turns_per_session: 30,
        wall_minutes: 120,
        model_cost_usd: 30,
        parallel_workers: 4,
        changed_files: 40,
        changed_lines: 2000,
        infrastructure_retries: 5,
        recovery_attempts: 3,
      },
      initial_allowances: { simple_attempts: 2, medium_attempts: 4, complex_attempts: 6 },
      extension: {
        attempts_per_extension: 1,
        require_measurable_progress: true,
        require_new_hypothesis: true,
        preserve_final_verification_reserve: true,
      },
      repeated_failure_threshold: 2,
      final_reserve_fraction: 0.2,
    },
    agents: {
      default_parallelism: 1,
      require_independent_work_units: true,
      isolate_writers: true,
      prohibit_shared_worktree_writes: true,
      cancel_obsolete_workers: true,
    },
    review: {
      independent_provider_required: true,
      preferred_provider: 'codex',
      fallback_same_provider_allowed: false,
      block_unresolved_high_impact_findings: true,
    },
    delivery: { provider: 'github', pull_request: 'draft', max_ci_repair_cycles: 3, ci_timeout_minutes: 60 },
    checks: {},
    ui: null,
    isolation: { provider: 'sandbox-runtime', allow_unisolated: false, container: null },
    providers: {
      // Running Orbit at all sends code to Claude, so the Claude adapter is eligible by default.
      claude: defaultProvider('claude', true),
      // Any other provider needs the user's explicit attestation (spec §12 data-handling eligibility).
      codex: defaultProvider('codex', false),
    },
    // Fable is left out on purpose: headless Claude Code bills Fable usage credits without asking.
    routing: { allowed_models: ['opus', 'sonnet', 'haiku'], overrides: {} },
    retention: { keep_runs_days: 30, redact_patterns: [] },
    knowledge: { enabled: true, share_globally: false, max_advisory_tokens: 800, curator_budget_usd: 0.25, eval_budget_usd: 0, auto_adopt_overlays: true },
    guard: { terms_file: null, allowed_emails: [] },
  };
}

export function defaultCheck(id: string): CheckDefinition {
  return {
    id,
    command: [],
    shell: false,
    cwd: '.',
    timeout_seconds: 600,
    network_hosts: [],
    env: {},
    mandatory: true,
    flaky_reruns: 0,
    kind: 'command',
  };
}

export function defaultUi(): UiConfig {
  return {
    required_when_ui_changes: true,
    ui_paths: ['**/*.tsx', '**/*.jsx', '**/*.vue', '**/*.svelte', '**/*.css', '**/*.scss', '**/*.html'],
    browsers: ['chromium'],
    viewports: [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ],
    environment: {
      base_url: 'http://127.0.0.1:3000',
      start_command: null,
      ready_timeout_seconds: 120,
      isolated_test_data: true,
      production_accounts: false,
    },
    journey_check_ids: [],
    accessibility: { enabled: true, fail_on_new_serious_or_critical: true },
    visual: {
      enabled: true,
      baseline_changes_require_review: true,
      baseline_globs: ['**/*-snapshots/**', '**/__screenshots__/**', '**/__image_snapshots__/**'],
    },
    visual_baseline_auto_accept: false,
  };
}

function defaultProvider(id: string, eligible: boolean): ProviderConfig {
  return { command: id, data_policy_eligible: eligible, model: null, reasoning_effort: null, extra_args: [] };
}

const CONTAINER_DEFAULTS = { memory_mb: 4096, cpus: 2, pids: 512 };

// ---------------------------------------------------------------------------
// Entry points

/** Read, validate and resolve the config. Missing file -> NOT_FOUND; anything wrong -> CONFIG_INVALID. */
export function loadConfig(repoRoot: string, path?: string, opts: Omit<ConfigOptions, 'source'> = {}): OrbitConfig {
  const file = path === undefined ? join(repoRoot, CONFIG_RELATIVE_PATH) : isAbsolute(path) ? path : resolve(repoRoot, path);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new OrbitError('NOT_FOUND', `no Orbit config at ${file}; run "orbit init" to create one`, { path: file });
    throw new OrbitError('CONFIG_INVALID', `cannot read ${file}: ${(err as Error).message}`, { path: file, problems: [`cannot read file: ${code ?? 'error'}`] });
  }
  return parseConfig(text, { ...opts, source: file });
}

/** Parse YAML text and resolve it. */
export function parseConfig(text: string, opts: ConfigOptions = {}): OrbitConfig {
  const source = opts.source ?? 'config';
  const doc = parseDocument(text, { uniqueKeys: true, prettyErrors: false, strict: true });
  const yamlProblems = [...doc.errors, ...doc.warnings].map((e) => `yaml: ${e.message.split('\n')[0]}`);
  if (yamlProblems.length > 0) throw invalid(source, yamlProblems);
  let raw: unknown;
  try {
    raw = doc.toJS({ maxAliasCount: 50 });
  } catch (err) {
    throw invalid(source, [`yaml: ${(err as Error).message.split('\n')[0]}`]);
  }
  return validateConfig(raw, { ...opts, source });
}

/**
 * Resolve an in-memory config (the parsed YAML, or an object built by a
 * caller). Returns a deeply frozen OrbitConfig or throws CONFIG_INVALID
 * listing every problem found.
 */
export function validateConfig(raw: unknown, opts: ConfigOptions = {}): OrbitConfig {
  const source = opts.source ?? 'config';
  const problems: string[] = [];
  if (raw === null || raw === undefined) throw invalid(source, ['the file is empty; it must be a mapping with at least "version: 1"']);
  if (!isPlainObject(raw)) throw invalid(source, ['the top level must be a mapping']);
  findDangerousKeys(raw, '', problems);
  if (problems.length > 0) throw invalid(source, problems);
  if (raw.version === undefined) problems.push('version: required (use "version: 1")');

  const fileMode = raw.mode;
  const mode: RunMode = opts.mode ?? (typeof fileMode === 'string' && (RUN_MODES as readonly string[]).includes(fileMode) ? (fileMode as RunMode) : DEFAULT_MODE);
  const merged = mergeWithDefaults(raw, mode, problems);
  // The merge kept the file's mode (or the default); a command-line mode replaces it.
  if (opts.mode !== undefined) merged.mode = opts.mode;

  const validate = schemaValidator();
  const shapeOk = validate(merged);
  if (!shapeOk) problems.push(...describeSchemaErrors(validate.errors));
  applySemanticRules(SEMANTIC_RULES, merged as unknown as OrbitConfig, shapeOk, problems);
  if (problems.length > 0) throw invalid(source, problems);
  return deepFreeze(merged as unknown as OrbitConfig);
}

function invalid(source: string, problems: string[]): OrbitError {
  const unique = [...new Set(problems)];
  return new OrbitError('CONFIG_INVALID', `invalid Orbit config (${source}):\n  - ${unique.join('\n  - ')}`, { source, problems: unique });
}

// ---------------------------------------------------------------------------
// Normalization and merge

function mergeWithDefaults(raw: Record<string, unknown>, mode: RunMode, problems: string[]): Record<string, unknown> {
  const base = defaultConfig(mode) as unknown as Record<string, unknown>;
  const { checks, ui, providers, ...rest } = raw;
  const merged = deepMerge(base, rest) as Record<string, unknown>;
  merged.checks = normalizeChecks(checks, problems);
  merged.ui = normalizeUi(ui, problems);
  merged.providers = normalizeProviders(providers, base.providers as Record<string, ProviderConfig>);
  normalizeContainer(merged);
  normalizeArgvField(merged, ['dependencies', 'install_command'], 'dependencies.install_command', problems);
  return merged;
}

function normalizeChecks(raw: unknown, problems: string[]): unknown {
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) return raw;
  const out: Record<string, unknown> = {};
  for (const [id, def] of Object.entries(raw)) {
    if (!isPlainObject(def)) {
      out[id] = def;
      continue;
    }
    const where = `checks.${id}`;
    if (def.id !== undefined && def.id !== id) problems.push(`${where}.id: must equal the key "${id}" (got ${JSON.stringify(def.id)})`);
    let command = def.command;
    const shell = def.shell === true;
    if (typeof command === 'string') {
      if (!shell) {
        problems.push(`${where}.command: a string command would need a shell; give an argv array, or set "shell: true" to run it through /bin/sh -c`);
      }
      command = [command];
    } else if (Array.isArray(command) && shell && command.length !== 1) {
      problems.push(`${where}.command: with "shell: true" the command must be one string (the script for /bin/sh -c)`);
    }
    if (command === undefined) problems.push(`${where}.command: required`);
    out[id] = { ...defaultCheck(id), ...def, command: command ?? [] };
  }
  return out;
}

function normalizeUi(raw: unknown, problems: string[]): unknown {
  if (raw === undefined || raw === null || raw === false) return null;
  if (raw === true) return defaultUi();
  if (!isPlainObject(raw)) return raw;
  const ui: Record<string, unknown> = { ...raw };
  // Spec §13 writes `accessibility: true`; expand the shorthand to the full form.
  if (typeof ui.accessibility === 'boolean') ui.accessibility = { enabled: ui.accessibility, fail_on_new_serious_or_critical: ui.accessibility };
  const merged = deepMerge(defaultUi(), ui) as Record<string, unknown>;
  normalizeArgvField(merged, ['environment', 'start_command'], 'ui.environment.start_command', problems);
  return merged;
}

function normalizeProviders(raw: unknown, defaults: Record<string, ProviderConfig>): unknown {
  if (raw === undefined || raw === null) return { ...defaults };
  if (!isPlainObject(raw)) return raw;
  const out: Record<string, unknown> = { ...defaults };
  for (const [id, def] of Object.entries(raw)) {
    out[id] = isPlainObject(def) ? { ...(defaults[id] ?? defaultProvider(id, false)), ...def } : def;
  }
  return out;
}

function normalizeContainer(merged: Record<string, unknown>): void {
  const iso = merged.isolation;
  if (isPlainObject(iso) && isPlainObject(iso.container)) iso.container = { ...CONTAINER_DEFAULTS, ...iso.container };
}

/** argv fields never take a string: there is no `shell` switch for them. */
function normalizeArgvField(obj: Record<string, unknown>, path: string[], label: string, problems: string[]): void {
  let parent: unknown = obj;
  for (const key of path.slice(0, -1)) parent = isPlainObject(parent) ? parent[key] : undefined;
  const last = path[path.length - 1]!;
  if (isPlainObject(parent) && typeof parent[last] === 'string') {
    problems.push(`${label}: must be an argv array (it is never run through a shell)`);
    parent[last] = [parent[last]];
  }
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (override === undefined) return clone(base);
  if (isPlainObject(base) && isPlainObject(override)) {
    const out: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(base), ...Object.keys(override)])) {
      out[key] = deepMerge(base[key], override[key]);
    }
    return out;
  }
  return clone(override);
}

function clone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clone);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = clone(v);
    return out;
  }
  return value;
}

function findDangerousKeys(value: unknown, path: string, problems: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => findDangerousKeys(v, `${path}[${i}]`, problems));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) {
    const here = path ? `${path}.${key}` : key;
    if (DANGEROUS_KEYS.has(key)) problems.push(`${here}: key name is not allowed`);
    else findDangerousKeys(value[key], here, problems);
  }
}

// ---------------------------------------------------------------------------
// Schema

let compiled: ValidateFunction | null = null;

function schemaValidator(): ValidateFunction {
  if (compiled) return compiled;
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
  compiled = ajv.compile(configSchema as object);
  return compiled;
}

function describeSchemaErrors(errors: ErrorObject[] | null | undefined): string[] {
  const list = errors ?? [];
  // `oneOf: [null, {...}]` reports a "must be null" branch failure and a summary
  // line alongside the real error; keep only the error that says what is wrong.
  const meaningful = list.filter((e) => !(e.keyword === 'type' && (e.params as { type?: string }).type === 'null'));
  const out: string[] = [];
  for (const e of meaningful) {
    if (e.keyword === 'oneOf' && meaningful.some((o) => o !== e && o.instancePath.startsWith(e.instancePath) && o.keyword !== 'oneOf')) continue;
    const where = pointerToPath(e.instancePath) || '(top level)';
    if (e.keyword === 'additionalProperties') {
      out.push(`${where}: unknown key "${(e.params as { additionalProperty: string }).additionalProperty}"`);
    } else if (e.keyword === 'enum') {
      out.push(`${where}: must be one of ${((e.params as { allowedValues: unknown[] }).allowedValues ?? []).map((v) => JSON.stringify(v)).join(', ')}`);
    } else if (e.keyword === 'const') {
      out.push(`${where}: must be ${JSON.stringify((e.params as { allowedValue: unknown }).allowedValue)}`);
    } else if (e.keyword === 'propertyNames') {
      out.push(`${where}: key ${JSON.stringify((e.params as { propertyName: string }).propertyName)} is not a valid name`);
    } else {
      out.push(`${where}: ${e.message ?? e.keyword}`);
    }
  }
  return out;
}

function pointerToPath(pointer: string): string {
  return pointer
    .split('/')
    .slice(1)
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
    .map((s) => (/^\d+$/.test(s) ? `[${s}]` : s))
    .join('.')
    .replace(/\.\[/g, '[');
}

// ---------------------------------------------------------------------------
// Semantic rules. Each pushes human-readable problems and may assume nothing
// about shape beyond what it checks itself; a throw is treated as "nothing to add".

export type Rule = (c: OrbitConfig, problems: string[]) => void;

const SEMANTIC_RULES: readonly Rule[] = Object.freeze([
  function modeAllowsActions(c, problems) {
    // An unknown mode is already reported by the schema; judging actions against it would only add noise.
    if (!RUN_MODES.includes(c.mode)) return;
    for (const action of DELIVERY_ACTIONS) {
      if (c.actions[action] === true && !DELIVERY_MODES.has(c.mode)) {
        problems.push(`actions.${action}: is true but mode "${c.mode}" does not deliver; use mode autonomous-delivery or release, or set it to false`);
      }
    }
    for (const action of RELEASE_ACTIONS) {
      if (c.actions[action] === true && c.mode !== 'release') {
        problems.push(`actions.${action}: requires mode "release" (mode is "${c.mode}")`);
      }
    }
  },
  function deliveryChainIsConsistent(c, problems) {
    const a = c.actions;
    if (a.push_task_branch && !a.commit) problems.push('actions.push_task_branch: requires actions.commit (there is nothing to push without a commit)');
    if (a.open_pull_request && !a.push_task_branch) problems.push('actions.open_pull_request: requires actions.push_task_branch (a pull request needs a pushed task branch)');
    if (a.repair_ci && !a.push_task_branch) problems.push('actions.repair_ci: requires actions.push_task_branch (CI runs on a pushed task branch)');
    if (a.repair_ci && !a.read_ci_logs) problems.push('actions.repair_ci: requires actions.read_ci_logs (repairs are driven by the CI logs)');
    if (a.open_pull_request && c.delivery.pull_request === 'none') problems.push('delivery.pull_request: is "none" but actions.open_pull_request is true');
  },
  function isolationForMode(c, problems) {
    if (c.isolation.provider === 'none' && UNATTENDED_MODES.has(c.mode) && c.isolation.allow_unisolated !== true) {
      problems.push(`isolation.provider: "none" is refused in mode "${c.mode}" unless isolation.allow_unisolated is true`);
    }
    if (c.isolation.provider === 'container' && c.isolation.container === null) {
      problems.push('isolation.container: required when isolation.provider is "container" (at least an image)');
    }
  },
  function reviewIsConsistent(c, problems) {
    if (c.review.independent_provider_required && c.review.fallback_same_provider_allowed) {
      problems.push('review: independent_provider_required and fallback_same_provider_allowed contradict each other; an independent review cannot fall back to the same provider');
    }
    if (!Object.hasOwn(c.providers, c.review.preferred_provider)) {
      problems.push(`review.preferred_provider: "${c.review.preferred_provider}" is not defined under providers`);
    }
  },
  function scopeGlobs(c, problems) {
    globList(c.scope.allowed_paths, 'scope.allowed_paths', problems);
    globList(c.scope.protected_paths, 'scope.protected_paths', problems);
    if (c.actions.edit && c.scope.allowed_paths.length === 0) problems.push('scope.allowed_paths: is empty, so actions.edit would allow nothing; list paths or set actions.edit to false');
  },
  function networkHosts(c, problems) {
    c.network.allowed_hosts.forEach((h, i) => {
      const p = hostEntryProblem(h);
      if (p) problems.push(`network.allowed_hosts[${i}]: ${JSON.stringify(h)} ${p}`);
    });
  },
  function dependencyRules(c, problems) {
    if (c.dependencies.add_packages && !c.dependencies.change_lockfile) {
      problems.push('dependencies.add_packages: requires dependencies.change_lockfile (adding a package rewrites the lockfile)');
    }
  },
  function checkDefinitions(c, problems) {
    for (const [id, check] of Object.entries(c.checks)) {
      const where = `checks.${id}`;
      const cwdProblem = relativeDirProblem(check.cwd);
      if (cwdProblem) problems.push(`${where}.cwd: ${cwdProblem}`);
      if (check.command.length > 0 && check.command[0]!.trim() === '') problems.push(`${where}.command: the program must not be empty`);
      check.network_hosts.forEach((h, i) => {
        const p = hostEntryProblem(h);
        if (p) problems.push(`${where}.network_hosts[${i}]: ${JSON.stringify(h)} ${p}`);
        else if (!hostEntryCovered(h, c.network.allowed_hosts)) problems.push(`${where}.network_hosts[${i}]: ${JSON.stringify(h)} is not covered by network.allowed_hosts`);
      });
      for (const name of Object.keys(check.env)) {
        if (FORBIDDEN_CHECK_ENV.has(name)) problems.push(`${where}.env.${name}: delivery and publishing credentials must not be given to checks`);
      }
    }
  },
  function uiReferences(c, problems) {
    if (c.ui === null) return;
    globList(c.ui.ui_paths, 'ui.ui_paths', problems);
    globList(c.ui.visual.baseline_globs, 'ui.visual.baseline_globs', problems);
    for (const id of c.ui.journey_check_ids) {
      const check = c.checks[id];
      if (!check) problems.push(`ui.journey_check_ids: "${id}" is not defined under checks`);
      else if (check.kind !== 'playwright') problems.push(`ui.journey_check_ids: "${id}" must be a check of kind "playwright"`);
    }
  },
  function routingReferences(c, problems) {
    for (const [work, model] of Object.entries(c.routing.overrides)) {
      if (!modelPermitted(model, c.routing.allowed_models)) problems.push(`routing.overrides.${work}: "${model}" is not permitted by routing.allowed_models`);
    }
  },
  function retentionPatterns(c, problems) {
    c.retention.redact_patterns.forEach((p, i) => {
      try {
        new RegExp(p, 'u');
      } catch (err) {
        problems.push(`retention.redact_patterns[${i}]: not a valid regular expression (${(err as Error).message})`);
      }
    });
  },
  function repositoryBranches(c, problems) {
    const { base_branch, branch_prefix } = c.repository;
    if (base_branch.startsWith(branch_prefix)) {
      problems.push(`repository.branch_prefix: "${branch_prefix}" also matches the base branch "${base_branch}"; task branches must never be able to name the base branch`);
    }
  },
  function budgetsFitCaps(c, problems) {
    const caps = c.scheduler.hard_limits;
    for (const [k, v] of Object.entries(c.scheduler.initial_allowances)) {
      if (v > caps.implementation_attempts) problems.push(`scheduler.initial_allowances.${k}: ${v} exceeds hard_limits.implementation_attempts (${caps.implementation_attempts})`);
    }
    if (c.agents.default_parallelism > caps.parallel_workers) {
      problems.push(`agents.default_parallelism: ${c.agents.default_parallelism} exceeds scheduler.hard_limits.parallel_workers (${caps.parallel_workers})`);
    }
    if (c.delivery.max_ci_repair_cycles > caps.ci_repair_cycles) {
      problems.push(`delivery.max_ci_repair_cycles: ${c.delivery.max_ci_repair_cycles} exceeds scheduler.hard_limits.ci_repair_cycles (${caps.ci_repair_cycles})`);
    }
  },
]);

/**
 * Run semantic rules, collecting their problems. A rule that throws on a
 * malformed section has nothing to add (the schema already reported that
 * section); on a well-formed config a throwing rule is a check that did not
 * run, so it becomes a problem and the config is refused, never accepted
 * unchecked.
 */
export function applySemanticRules(rules: readonly Rule[], config: OrbitConfig, shapeOk: boolean, problems: string[]): void {
  for (const rule of rules) {
    try {
      rule(config, problems);
    } catch (err) {
      if (shapeOk) problems.push(`internal: the ${rule.name || 'semantic'} check could not run (${(err as Error).message}); the config is refused rather than accepted unchecked`);
    }
  }
}

function globList(globs: readonly string[], where: string, problems: string[]): void {
  globs.forEach((g, i) => {
    const p = globProblem(g);
    if (p) problems.push(`${where}[${i}]: ${JSON.stringify(g)} ${p}`);
  });
}

function relativeDirProblem(dir: string): string | null {
  if (dir.includes('\0')) return 'contains a NUL byte';
  if (dir.includes('\\')) return 'must use forward slashes';
  if (posix.isAbsolute(dir) || dir.startsWith('~')) return 'must be relative to the worktree root';
  const norm = posix.normalize(dir);
  if (norm === '..' || norm.startsWith('../')) return 'must stay inside the worktree';
  return null;
}

/** A model reference is permitted when listed exactly, or when it is a `claude-<family>-...` id whose family is listed. */
export function modelPermitted(model: string, allowed: readonly string[]): boolean {
  if (allowed.includes(model)) return true;
  const family = /^claude-([a-z]+)-/.exec(model)?.[1];
  return family !== undefined && allowed.includes(family);
}

// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}
