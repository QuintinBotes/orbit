import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isOrbitError, type OrbitError } from '../../../src/core/errors.ts';
import {
  applySemanticRules,
  defaultConfig,
  defaultDependencyAudit,
  defaultStaticSecurity,
  dependencyAuditPolicy,
  loadConfig,
  outputBudgets,
  parseConfig,
  staticSecurityPolicy,
  validateConfig,
  type Rule,
} from '../../../src/policy/config.ts';

function problemsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    expect(isOrbitError(err, 'CONFIG_INVALID')).toBe(true);
    return ((err as OrbitError).details?.problems as string[]) ?? [];
  }
  throw new Error('expected CONFIG_INVALID');
}
const bad = (yaml: string): string[] => problemsOf(() => parseConfig(`version: 1\n${yaml}`));
const ok = (yaml: string) => parseConfig(`version: 1\n${yaml}`);

describe('defaults for sections older snapshots lack', () => {
  const base = defaultConfig();

  it('fall back to the built-in defaults when the section is absent and use the stored one when present', () => {
    const withoutBudgets = { routing: { ...base.routing, output_budgets: undefined } as never };
    expect(outputBudgets(withoutBudgets)).toEqual(outputBudgets({ routing: { ...base.routing, output_budgets: {} as never } }));
    const roles = Object.keys(outputBudgets(withoutBudgets));
    expect(roles.length).toBeGreaterThan(0);
    const role = roles[0]!;
    expect(outputBudgets({ routing: { ...base.routing, output_budgets: { [role]: 123 } } as never })[role as keyof ReturnType<typeof outputBudgets>]).toBe(123);

    expect(staticSecurityPolicy({ static_security: undefined as never })).toEqual(defaultStaticSecurity());
    const stored = { ...defaultStaticSecurity(), exceptions: [] };
    expect(staticSecurityPolicy({ static_security: stored })).toBe(stored);

    expect(dependencyAuditPolicy({ dependencies: { ...base.dependencies, audit: undefined } as never })).toEqual(defaultDependencyAudit());
    const audit = { ...defaultDependencyAudit(), exceptions: [] };
    expect(dependencyAuditPolicy({ dependencies: { ...base.dependencies, audit } })).toBe(audit);
  });
});

describe('loadConfig', () => {
  let repo: string;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'orbit-cfg-cov-'));
    mkdirSync(join(repo, '.orbit'), { recursive: true });
    mkdirSync(join(repo, 'conf'), { recursive: true });
    writeFileSync(join(repo, '.orbit', 'config.yaml'), 'version: 1\nmode: autonomous\n');
    writeFileSync(join(repo, 'conf', 'alt.yaml'), 'version: 1\nmode: supervised\nisolation: {provider: none}\n');
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('reads .orbit/config.yaml by default, a repo-relative path, or an absolute path', () => {
    expect(loadConfig(repo).mode).toBe('autonomous');
    expect(loadConfig(repo, 'conf/alt.yaml').mode).toBe('supervised');
    expect(loadConfig(repo, join(repo, 'conf', 'alt.yaml')).mode).toBe('supervised');
  });

  it('reports a missing file as NOT_FOUND with the path, and an unreadable one as CONFIG_INVALID', () => {
    let missing: unknown;
    try {
      loadConfig(repo, 'nope.yaml');
    } catch (e) {
      missing = e;
    }
    expect(missing).toMatchObject({ code: 'NOT_FOUND', details: { path: join(repo, 'nope.yaml') } });
    expect((missing as Error).message).toContain('orbit init');

    let unreadable: unknown;
    try {
      loadConfig(repo, 'conf');
    } catch (e) {
      unreadable = e;
    }
    expect(unreadable).toMatchObject({ code: 'CONFIG_INVALID', details: { problems: ['cannot read file: EISDIR'] } });
  });

  it('applies a command-line mode over the file', () => {
    expect(loadConfig(repo, 'conf/alt.yaml', { mode: 'supervised' }).mode).toBe('supervised');
  });
});

describe('top level shape and yaml', () => {
  it('rejects an empty file, a non-mapping, a missing version and prototype-polluting keys', () => {
    expect(problemsOf(() => validateConfig(null))).toEqual(['the file is empty; it must be a mapping with at least "version: 1"']);
    expect(problemsOf(() => validateConfig(undefined))).toHaveLength(1);
    expect(problemsOf(() => validateConfig([]))).toEqual(['the top level must be a mapping']);
    expect(problemsOf(() => validateConfig({}))).toContain('version: required (use "version: 1")');
    expect(problemsOf(() => validateConfig(JSON.parse('{"version":1,"__proto__":{"x":1}}')))).toEqual(['__proto__: key name is not allowed']);
    expect(problemsOf(() => validateConfig(JSON.parse('{"version":1,"scope":{"constructor":1}}')))).toEqual(['scope.constructor: key name is not allowed']);
    expect(problemsOf(() => validateConfig(JSON.parse('{"version":1,"x":[{"prototype":1}]}')))).toEqual(['x[0].prototype: key name is not allowed']);
  });

  it('reports yaml errors, warnings and alias bombs as problems', () => {
    expect(problemsOf(() => parseConfig('version: 1\nversion: 2\n'))).toEqual(['yaml: Map keys must be unique (line 2, column 1)']);
    expect(problemsOf(() => parseConfig(`version: 1\na: &a [x]\nb: [${Array(60).fill('*a').join(',')}]\n`))).toEqual(['yaml: Excessive alias count indicates a resource exhaustion attack']);
    expect(problemsOf(() => parseConfig('version: 1\n%FOO\n')).every((p) => p.startsWith('yaml: '))).toBe(true);
  });

  it('describes schema violations by kind: unknown key, enum, const, wrong type, bad key name', () => {
    expect(bad('bogus: 1\n')).toEqual(['(top level): unknown key "bogus"']);
    expect(bad('mode: nonsense\n')).toEqual(['mode: must be one of "supervised", "autonomous", "autonomous-delivery", "release", got "nonsense"']);
    expect(problemsOf(() => parseConfig('version: 2\n'))).toEqual(['version: must be 1']);
    expect(bad('scope: 5\n')).toEqual(['scope: must be object']);
    expect(bad('checks: {"bad id!": {command: [x]}}\n')).toContain('checks: key "bad id!" is not a valid name');
  });

  it('a command-line mode replaces the one in the file and an unknown file mode falls back to the default', () => {
    expect(validateConfig({ version: 1, mode: 'autonomous' }, { mode: 'supervised' }).mode).toBe('supervised');
    expect(problemsOf(() => validateConfig({ version: 1, mode: 7 }))).toEqual(['mode: must be one of "supervised", "autonomous", "autonomous-delivery", "release", got 7']);
  });
});

describe('check normalization', () => {
  it('treats absent checks as none and passes shapes it cannot normalize to the schema', () => {
    expect(ok('checks:\n').checks).toEqual({});
    expect(bad('checks: 5\n')).toEqual(['checks: must be object']);
    expect(bad('checks: {a: 5}\n')).toEqual(['checks.a: must be object']);
  });

  it('requires the id to match the key and the command to be an argv array unless shell is true', () => {
    expect(bad('checks: {a: {id: b, command: [x]}}\n')).toEqual(['checks.a.id: must equal the key "a" (got "b")']);
    expect(bad('checks: {a: {command: "npm test"}}\n')[0]).toMatch(/a string command would need a shell/);
    expect(ok('checks: {a: {command: "npm test", shell: true}}\n').checks.a).toMatchObject({ command: ['npm test'], shell: true });
    expect(bad('checks: {a: {command: [a, b], shell: true}}\n')).toEqual(['checks.a.command: with "shell: true" the command must be one string (the script for /bin/sh -c)']);
    expect(bad('checks: {a: {mandatory: true}}\n')).toContain('checks.a.command: required');
  });

  it('derives the category: playwright implies ui, an explicit category wins, the default is test', () => {
    const c = ok('checks: {p: {command: [x], kind: playwright}, q: {command: [x], kind: playwright, category: other}, r: {command: [x]}}\n');
    expect(c.checks.p!.category).toBe('ui');
    expect(c.checks.q!.category).toBe('other');
    expect(c.checks.r!.category).toBe('test');
  });

  it('validates cwd, program, network hosts and forbidden environment names', () => {
    expect(bad('checks: {a: {command: [x], cwd: /abs}}\n')).toEqual(['checks.a.cwd: must be relative to the worktree root']);
    expect(bad('checks: {a: {command: [x], cwd: "~/x"}}\n')).toEqual(['checks.a.cwd: must be relative to the worktree root']);
    expect(bad('checks: {a: {command: [x], cwd: ../up}}\n')).toEqual(['checks.a.cwd: must stay inside the worktree']);
    expect(bad('checks: {a: {command: [x], cwd: "a\\\\b"}}\n')).toEqual(['checks.a.cwd: must use forward slashes']);
    expect(bad('checks: {a: {command: [" "]}}\n')).toEqual(['checks.a.command: the program must not be empty']);
    expect(bad('checks: {a: {command: [x], network_hosts: ["Bad Host", "other.test"]}}\n')).toEqual([
      'checks.a.network_hosts[0]: "Bad Host" must be lower case',
      'checks.a.network_hosts[1]: "other.test" is not covered by network.allowed_hosts',
    ]);
    expect(bad('checks: {a: {command: [x], env: {GITHUB_TOKEN: x}}}\n')).toEqual(['checks.a.env.GITHUB_TOKEN: delivery and publishing credentials must not be given to checks']);
  });
});

describe('ui normalization', () => {
  it('reads null and false as no UI, true as the defaults, and expands the accessibility shorthand', () => {
    expect(ok('ui:\n').ui).toBeNull();
    expect(ok('ui: false\n').ui).toBeNull();
    expect(ok('ui: true\n').ui).not.toBeNull();
    expect(ok('ui: {accessibility: true}\n').ui!.accessibility).toEqual({ enabled: true, fail_on_new_serious_or_critical: true });
    expect(ok('ui: {accessibility: false}\n').ui!.accessibility).toEqual({ enabled: false, fail_on_new_serious_or_critical: false });
    expect(bad('ui: 5\n')).toEqual(['ui: must be object']);
  });

  it('refuses a shell string for the start command and unresolvable references', () => {
    expect(bad('ui: {environment: {start_command: "npm start"}}\n')).toEqual(['ui.environment.start_command: must be an argv array (it is never run through a shell)']);
    expect(bad('ui: {journey_check_ids: [nope]}\n')).toEqual(['ui.journey_check_ids: "nope" is not defined under checks']);
    expect(bad('checks: {j: {command: [x]}}\nui: {journey_check_ids: [j]}\n')).toEqual(['ui.journey_check_ids: "j" must be a check of kind "playwright"']);
    expect(bad('ui: {ui_paths: ["/abs"], visual: {baseline_globs: ["!x"]}}\n')).toEqual([
      'ui.ui_paths[0]: "/abs" must be relative to the repository root',
      'ui.visual.baseline_globs[0]: "!x" negation is not supported; list what is allowed or protected',
    ]);
  });
});

describe('release normalization and rules', () => {
  const REL = 'mode: release\nactions: {merge: true}\n';

  it('reads an absent release as none and fills merge and environment defaults', () => {
    expect(ok('release:\n').release).toBeNull();
    const c = ok(`${REL}release: {environments: {prod: {deploy_command: [./deploy]}}}\n`);
    expect(c.release!.merge).toMatchObject({ method: expect.any(String) });
    expect(c.release!.environments.prod).toMatchObject({ deploy_command: ['./deploy'], verify_command: null, require_ci_green: true, allowed_branches: ['main'] });
    expect(ok(`${REL}release: {}\n`).release!.environments).toEqual({});
    expect(ok(`${REL}release: {environments:}\n`).release!.environments).toEqual({});
  });

  it('bases the default allowed branch on repository.base_branch', () => {
    const c = ok(`${REL}repository: {base_branch: trunk}\nrelease: {environments: {prod: {deploy_command: [d]}}}\n`);
    expect(c.release!.environments.prod!.allowed_branches).toEqual(['trunk']);
  });

  it('passes shapes it cannot normalize to the schema', () => {
    expect(bad('release: 5\n')).toEqual(['release: must be object']);
    expect(bad(`${REL}release: {merge: x}\n`)).toEqual(['release.merge: must be object']);
    expect(bad(`${REL}release: {environments: 5}\n`)).toEqual(['release.environments: must be object']);
    expect(bad(`${REL}release: {environments: {prod: 5}}\n`)).toEqual(['release.environments.prod: must be object']);
  });

  it('requires deploy_command and refuses shell strings for deploy and verify', () => {
    expect(bad(`${REL}release: {environments: {prod: {}}}\n`)).toContain('release.environments.prod.deploy_command: required');
    expect(bad(`${REL}release: {environments: {prod: {deploy_command: "./deploy", verify_command: "./verify"}}}\n`)).toEqual([
      'release.environments.prod.deploy_command: must be an argv array (it is never run through a shell)',
      'release.environments.prod.verify_command: must be an argv array (it is never run through a shell)',
    ]);
  });

  it('checks programs, branches and network hosts of each environment', () => {
    expect(bad(`${REL}release: {environments: {prod: {deploy_command: [" "], verify_command: [" "], allowed_branches: []}}}\n`)).toEqual([
      'release.environments.prod.deploy_command: the program must not be empty',
      'release.environments.prod.verify_command: the program must not be empty',
      'release.environments.prod.allowed_branches: is empty, so nothing could ever be deployed to prod',
    ]);
    expect(bad(`${REL}release: {environments: {prod: {deploy_command: [d], network_hosts: ["Bad", "unlisted.test", "github.com"]}}}\n`)).toEqual([
      'release.environments.prod.network_hosts[0]: "Bad" must be lower case',
      'release.environments.prod.network_hosts[1]: "unlisted.test" is not covered by network.allowed_hosts',
    ]);
  });

  it('release mode needs a release section and a merge or deploy action; deploying needs an environment', () => {
    expect(bad(REL)).toEqual(['release: required in mode "release" (merge settings and the deploy environments)']);
    expect(bad('mode: release\nrelease: {environments: {}}\n')[0]).toMatch(/needs actions\.merge or actions\.deploy_production/);
    expect(bad('mode: release\nactions: {deploy_production: true}\nrelease: {}\n')).toEqual(['release.environments: actions.deploy_production is true but no environment is defined to deploy to']);
  });
});

describe('provider and isolation normalization', () => {
  it('keeps default providers, adds new ones with defaults and rejects malformed entries', () => {
    expect(Object.keys(ok('providers:\n').providers)).toEqual(expect.arrayContaining(['claude', 'codex']));
    const extra = ok('providers: {extra: {command: extra-cli}}\n').providers.extra!;
    expect(extra).toMatchObject({ command: 'extra-cli', data_policy_eligible: false, model: null, reasoning_effort: null, extra_args: [] });
    expect(bad('providers: {claude: 5}\n')).toEqual(['providers.claude: must be object']);
    expect(bad('providers: 5\n')[0]).toBe('providers: must be object');
  });

  it('fills container limits and requires a container section for the container provider', () => {
    expect(ok('isolation: {provider: container, container: {image: img}}\n').isolation.container).toMatchObject({ image: 'img', memory_mb: 4096, cpus: 2, pids: 512 });
    expect(bad('isolation: {provider: container}\n')).toEqual(['isolation.container: required when isolation.provider is "container" (at least an image)']);
    expect(bad('isolation: {provider: none}\n')).toEqual(['isolation.provider: "none" is refused in mode "autonomous-delivery" unless isolation.allow_unisolated is true']);
  });
});

describe('exception lists and argv fields', () => {
  it('lets static security exceptions leave out nullable fields, reading them as null', () => {
    const c = ok('static_security:\n  exceptions:\n    - {rule_id: R1, reason: accepted for the legacy parser}\n');
    expect(c.static_security!.exceptions[0]).toMatchObject({ rule_id: 'R1', path_glob: null, expires: null });
  });

  it('rejects an exception glob that is not relative, and a string install command', () => {
    expect(bad('static_security:\n  exceptions:\n    - {rule_id: R1, reason: accepted for the legacy parser, path_glob: "/abs"}\n')).toEqual(['static_security.exceptions[0].path_glob: "/abs" must be relative to the repository root']);
    expect(bad('dependencies: {install_command: "npm ci"}\n')).toEqual(['dependencies.install_command: must be an argv array (it is never run through a shell)']);
  });
});

describe('semantic rules', () => {
  it('delivery chain: every dependent action needs its prerequisite', () => {
    expect(bad('actions: {commit: false, push_task_branch: true, rebase_task_branch: true, open_pull_request: true, repair_ci: true}\n')).toEqual([
      'actions.push_task_branch: requires actions.commit (there is nothing to push without a commit)',
      'actions.rebase_task_branch: requires actions.commit (a rebase rewrites the task branch commits)',
    ]);
    expect(bad('actions: {push_task_branch: false, open_pull_request: true, repair_ci: true, read_ci_logs: false}\n')).toEqual([
      'actions.open_pull_request: requires actions.push_task_branch (a pull request needs a pushed task branch)',
      'actions.repair_ci: requires actions.push_task_branch (CI runs on a pushed task branch)',
      'actions.repair_ci: requires actions.read_ci_logs (repairs are driven by the CI logs)',
    ]);
    expect(bad('delivery: {pull_request: none}\n')).toEqual(['delivery.pull_request: is "none" but actions.open_pull_request is true']);
  });

  it('mode gates delivery and release actions', () => {
    const p = bad('mode: autonomous\nactions: {commit: true, merge: true}\n');
    expect(p).toContain('actions.commit: is true but mode "autonomous" does not deliver; use mode autonomous-delivery or release, or set it to false');
    expect(p).toContain('actions.merge: requires mode "release" (mode is "autonomous")');
  });

  it('review: contradictory fallback and unknown preferred provider', () => {
    const p = bad('review: {independent_provider_required: true, fallback_same_provider_allowed: true, preferred_provider: nope}\n');
    expect(p[0]).toMatch(/^review: independent_provider_required and fallback_same_provider_allowed contradict each other/);
    expect(p[1]).toBe('review.preferred_provider: "nope" is not defined under providers');
  });

  it('scope, network, dependency, routing, retention, repository and budget rules', () => {
    expect(bad('scope: {allowed_paths: [], protected_paths: ["!x"]}\n')).toEqual([
      'scope.protected_paths[0]: "!x" negation is not supported; list what is allowed or protected',
      'scope.allowed_paths: is empty, so actions.edit would allow nothing; list paths or set actions.edit to false',
    ]);
    expect(bad('network: {allowed_hosts: ["Bad"]}\n')).toEqual(['network.allowed_hosts[0]: "Bad" must be lower case']);
    expect(bad('dependencies: {add_packages: true, change_lockfile: false}\n')).toEqual(['dependencies.add_packages: requires dependencies.change_lockfile (adding a package rewrites the lockfile)']);
    expect(bad('routing: {overrides: {plan: not-allowed-model}}\n')).toEqual(['routing.overrides.plan: "not-allowed-model" is not permitted by routing.allowed_models']);
    const retention = bad('retention: {redact_patterns: ["(", "a*", "ok+"]}\n');
    expect(retention[0]).toMatch(/^retention\.redact_patterns\[0\]: not a valid regular expression/);
    expect(retention[1]).toMatch(/^retention\.redact_patterns\[1\]: matches the empty string/);
    expect(retention).toHaveLength(2);
    expect(bad('repository: {base_branch: orbit/main}\n')).toEqual(['repository.branch_prefix: "orbit/" also matches the base branch "orbit/main"; task branches must never be able to name the base branch']);
    expect(bad('scheduler: {hard_limits: {parallel_workers: 1, ci_repair_cycles: 1}}\nagents: {default_parallelism: 5}\ndelivery: {max_ci_repair_cycles: 5}\n')).toEqual([
      'agents.default_parallelism: 5 exceeds scheduler.hard_limits.parallel_workers (1)',
      'delivery.max_ci_repair_cycles: 5 exceeds scheduler.hard_limits.ci_repair_cycles (1)',
    ]);
  });
});

describe('applySemanticRules', () => {
  const config = defaultConfig();
  const boom: Rule = function brokenRule() {
    throw new Error('rule exploded');
  };
  const anonymous: Rule = (() => (): void => {
    throw new Error('no name');
  })();
  const pushes: Rule = (_c, problems) => {
    problems.push('from rule');
  };

  it('a rule that throws on a well-formed config becomes a problem naming the rule, so nothing is accepted unchecked', () => {
    const problems: string[] = [];
    applySemanticRules([pushes, boom], config, true, problems);
    expect(problems).toEqual(['from rule', 'internal: the brokenRule check could not run (rule exploded); the config is refused rather than accepted unchecked']);
  });

  it('names an anonymous rule "semantic", and stays silent when the shape is already known to be wrong', () => {
    const named: string[] = [];
    applySemanticRules([anonymous], config, true, named);
    expect(named[0]).toMatch(/^internal: the semantic check could not run \(no name\)/);
    const silent: string[] = [];
    applySemanticRules([boom, pushes], config, false, silent);
    expect(silent).toEqual(['from rule']);
  });
});
