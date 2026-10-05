/**
 * A lab for driving complete runs: a temp git repository with a tiny
 * calculator and a trusted check, a frozen policy, the fake provider CLIs
 * behind the real adapters and shim, and a private ~/.orbit. No vitest
 * import, so the child controller (fixtures/controller-main.ts) can use it.
 */
import { ENGINEERING_PRACTICES } from '../../../src/contract/practices.ts';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { systemClock } from '../../../src/core/clock.ts';
import { openDb, type OrbitDb } from '../../../src/storage/db.ts';
import { defaultCheck, defaultConfig } from '../../../src/policy/config.ts';
import type { OrbitConfig } from '../../../src/policy/types.ts';
import { createAdapter } from '../../../src/adapters/index.ts';
import type { ProviderAdapter } from '../../../src/adapters/types.ts';
import { ModelRegistry } from '../../../src/routing/registry.ts';
import { startRun, stateDbPath } from '../../../src/controller/start.ts';
import type { ControllerDeps } from '../../../src/controller/context.ts';
import { getRun, type RunRecord } from '../../../src/controller/run-store.ts';
import { ScenarioAdapter } from './scenario-adapter.ts';

export const FAKES = fileURLToPath(new URL('../../fakes/', import.meta.url));
export const FAKE_CLAUDE = join(FAKES, 'fake-claude.mjs');
export const FAKE_CODEX = join(FAKES, 'fake-codex.mjs');
export const ORBIT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CHILD = fileURLToPath(new URL('./fixtures/controller-main.ts', import.meta.url));

export interface Lab {
  base: string;
  repo: string;
  orbitHome: string;
  /** Scenario with $CANDIDATE / $FINGERPRINT placeholders; ScenarioAdapter renders it into scenarioPath. */
  templatePath: string;
  scenarioPath: string;
  argvLog: string;
  configPath: string;
  config: OrbitConfig;
  db(): OrbitDb;
  close(): void;
}

const GIT_ENV = { GIT_AUTHOR_NAME: 'acme', GIT_AUTHOR_EMAIL: 'dev@acme.test', GIT_COMMITTER_NAME: 'acme', GIT_COMMITTER_EMAIL: 'dev@acme.test', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...GIT_ENV } }).trim();
}

/** The repository: a calculator with add, a test runner, and one test. tests/slow.flag makes the suite sleep (cancellation tests). */
export const REPO_FILES: Record<string, string> = {
  '.gitignore': '.orbit/\n',
  'apps/calc.mjs': 'export const add = (a, b) => a + b;\n',
  'tests/add.test.mjs': "import { add } from '../apps/calc.mjs';\nif (add(2, 3) !== 5) { console.error('add(2, 3) expected 5'); process.exit(1); }\n",
  'tests/run.mjs': [
    "import { existsSync, readdirSync } from 'node:fs';",
    "const here = new URL('.', import.meta.url);",
    "if (existsSync(new URL('slow.flag', here))) await new Promise((r) => setTimeout(r, 60_000));",
    "for (const f of readdirSync(here).filter((n) => n.endsWith('.test.mjs')).sort()) await import(new URL(f, here));",
    "console.log('all tests passed');",
    '',
  ].join('\n'),
};

export function labConfig(tweak?: (c: OrbitConfig) => void): OrbitConfig {
  const c = defaultConfig('autonomous');
  c.isolation = { provider: 'none', allow_unisolated: true, container: null };
  c.scope.allowed_paths = ['apps/**', 'tests/**'];
  c.checks = { unit: { ...defaultCheck('unit'), command: [process.execPath, 'tests/run.mjs'], timeout_seconds: 120 } };
  c.providers = {
    claude: { command: FAKE_CLAUDE, data_policy_eligible: true, model: null, reasoning_effort: null, extra_args: [] },
    codex: { command: FAKE_CODEX, data_policy_eligible: true, model: 'gpt-6-astra', reasoning_effort: null, extra_args: [] },
  };
  c.knowledge = { ...c.knowledge, enabled: false };
  tweak?.(c);
  return c;
}

export function makeLab(opts: { tweak?: (c: OrbitConfig) => void; files?: Record<string, string> } = {}): Lab {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-ctl-')));
  const repo = join(base, 'repo');
  for (const [rel, content] of Object.entries({ ...REPO_FILES, ...(opts.files ?? {}) })) {
    mkdirSync(join(repo, rel, '..'), { recursive: true });
    writeFileSync(join(repo, rel), content);
  }
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  const config = labConfig(opts.tweak);
  const configPath = join(base, 'config.json');
  writeFileSync(configPath, JSON.stringify(config));
  let db: OrbitDb | null = null;
  const lab: Lab = {
    base,
    repo,
    orbitHome: join(base, 'orbit-home'),
    templatePath: join(base, 'scenario.template.json'),
    scenarioPath: join(base, 'scenario.json'),
    argvLog: join(base, 'argv.jsonl'),
    configPath,
    config,
    db() {
      db ??= openDb(stateDbPath(repo));
      return db;
    },
    close() {
      db?.close();
      db = null;
      // Worktrees registered in the repo point into orbit-home; both go with the base directory.
      rmSync(base, { recursive: true, force: true });
    },
  };
  return lab;
}

export function writeScenario(lab: Pick<Lab, 'templatePath' | 'scenarioPath'>, scenario: object): void {
  writeFileSync(lab.templatePath, JSON.stringify(scenario));
  writeFileSync(lab.scenarioPath, JSON.stringify(scenario));
}

/** What `orbit doctor` would have done: seed the registry and validate the Claude models on the CLI surface. */
export function seedRegistry(db: OrbitDb): void {
  const registry = new ModelRegistry(db, systemClock);
  registry.seed();
  for (const e of registry.list()) if (e.provider === 'claude' && e.family !== 'fable') registry.markAvailability(e.modelId, 'claude-cli', true, 'validated by the test lab');
}

export function startLabRun(lab: Lab, goal = 'Add a mul function to the calculator.', opts: { environment?: string } = {}): RunRecord {
  const db = lab.db();
  seedRegistry(db);
  return startRun({ db, repoRoot: lab.repo, goal, config: lab.config, clock: systemClock, ...(opts.environment !== undefined ? { environment: opts.environment } : {}) });
}

export function labAdapters(lab: Pick<Lab, 'config' | 'templatePath' | 'scenarioPath' | 'argvLog'>): Record<string, ProviderAdapter> {
  const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME, ORBIT_FAKE_SCENARIO: lab.scenarioPath, ORBIT_FAKE_ARGV_LOG: lab.argvLog };
  const out: Record<string, ProviderAdapter> = {};
  for (const [id, pc] of Object.entries(lab.config.providers)) {
    out[id] = new ScenarioAdapter(createAdapter(id, pc, { claudeTier: 'claude-sandbox', graceMs: 300, baseEnv, clock: systemClock }), lab.templatePath, lab.scenarioPath);
  }
  return out;
}

/**
 * A fixed machine for tests that start several workers at once (docs/gaps.md G54): 16 cores and 64 GB free,
 * whatever this host is doing, so admission is decided by the units and limits under test, not by the machine
 * the suite runs on. labDeps passes it as `schedulerProbe` by default; a test that needs another machine (the
 * saturation fault test) overrides it in the deps it builds.
 */
export const FIXED_PROBE: NonNullable<ControllerDeps['schedulerProbe']> = Object.freeze({ availableParallelism: () => 16, freemem: () => 64_000 * 1024 * 1024 });

export function labDeps(lab: Lab, db: OrbitDb = lab.db()): Omit<ControllerDeps, 'ownerId'> {
  return {
    db,
    clock: systemClock,
    adapters: labAdapters(lab),
    registry: new ModelRegistry(db, systemClock),
    orbitHome: lab.orbitHome,
    hostEnv: process.env,
    orbitInstallDir: ORBIT_ROOT,
    timing: { checkPollMs: 50, killGraceMs: 300, ciAbsentGraceMs: 0, workerTimeoutMs: 120_000 },
    schedulerProbe: FIXED_PROBE,
  };
}

// ---------------------------------------------------------------------------
// Scenario pieces

export const PLANNER_OUTPUT = {
  objective: 'Add a mul function to the calculator.',
  current_behavior: [{ statement: 'apps/calc.mjs exports add only', evidence: ['apps/calc.mjs:1'] }],
  criteria: [
    {
      key: 'mul',
      statement: 'mul(a, b) returns the product of a and b.',
      mandatory: true,
      ui: false,
      proof: ['tests/mul.test.mjs asserts mul(2, 3) === 6'],
      check_ids: ['unit'],
      changes: [{ path: 'apps/calc.mjs', summary: 'add mul' }],
    },
  ],
  expected_changed_files: [
    { path: 'apps/calc.mjs', change: 'modify', reason: 'add mul' },
    { path: 'tests/mul.test.mjs', change: 'add', reason: 'behaviour test' },
  ],
  allowed_paths: ['apps/**', 'tests/**'],
  required_check_ids: ['unit'],
  non_goals: ['Change add'],
  risks: [],
  assumptions: [],
  unresolved_decisions: [],
  material_topics: [],
  practices: plannerPractices(),
};

/** The planner's engineering-practice selection (contract/practices): every practice, each with a reason. */
export function plannerPractices(applicable: readonly string[] = ['behavior-tests', 'compatibility-and-public-interfaces']): { practice: string; applicable: boolean; justification: string }[] {
  return ENGINEERING_PRACTICES.map((practice) => ({
    practice,
    applicable: applicable.includes(practice),
    justification: applicable.includes(practice) ? 'covered by the planned behaviour test and the existing checks' : `a small calculator function change does not involve ${practice}`,
  }));
}

export const IMPLEMENTER_OUTPUT = {
  summary: 'added mul and a behaviour test',
  changed_paths: [
    { path: 'apps/calc.mjs', change: 'modify', purpose: 'add mul' },
    { path: 'tests/mul.test.mjs', change: 'add', purpose: 'behaviour test' },
  ],
  tests_added: [{ path: 'tests/mul.test.mjs', name: 'mul multiplies', kind: 'unit', criterion_ids: ['AC-1'] }],
  checks_run: [],
  evidence_refs: [],
  remaining_issues: [],
  next_action: { kind: 'request-verification', detail: 'run the trusted checks' },
};

export const MUL_TEST = "import { mul } from '../apps/calc.mjs';\nif (mul(2, 3) !== 6) { console.error('mul(2, 3) expected 6, got ' + mul(2, 3)); process.exit(1); }\n";

export function implementMul(op: '*' | '+' = '*', extra: object[] = []): object {
  return {
    edits: [
      { op: 'write', path: 'apps/calc.mjs', content: `export const add = (a, b) => a + b;\nexport const mul = (a, b) => a ${op} b;\n` },
      { op: 'write', path: 'tests/mul.test.mjs', content: MUL_TEST },
      ...extra,
    ],
    structured: IMPLEMENTER_OUTPUT,
  };
}

export const APPROVE = { structured: { verdict: 'APPROVE', candidate_revision: '$CANDIDATE', findings: [] } };

export const DIAGNOSIS = {
  structured: {
    repair_brief: {
      fingerprint: '$FINGERPRINT',
      evidence: ['tests/mul.test.mjs reports mul(2, 3) expected 6, got 5'],
      hypotheses: [{ statement: 'mul adds its arguments instead of multiplying them', supporting: 'mul(2, 3) returned 5, which is 2 + 3', refuting: null }],
      experiment: 'Call mul(2, 3) and mul(4, 5) and compare the results with sums and products',
      expected_observation: 'mul returns the sum of its arguments for both calls',
      scoped_fix: 'Change mul in apps/calc.mjs to multiply its two arguments',
      post_fix_checks: ['unit'],
      preserved_constraints: ['Keep the tests/mul.test.mjs assertions unchanged'],
    },
    fingerprint_comparison: { current: '$FINGERPRINT', previous: [], relation: 'first-occurrence', progress: 'unknown', explanation: 'first failure of this kind' },
    competing_hypotheses: [
      {
        id: 'H1',
        statement: 'mul adds its arguments instead of multiplying them',
        supporting_evidence: ['mul(2, 3) returned 5'],
        refuting_evidence: [],
        discriminating_experiment: 'Call mul(4, 5)',
        expected_if_true: 'returns 9',
        status: 'leading',
        previously_tested: false,
      },
      {
        id: 'H2',
        statement: 'the test runner imports a stale copy of calc.mjs',
        supporting_evidence: ['the runner imports by relative URL'],
        refuting_evidence: ['the checkout is fresh for every check'],
        discriminating_experiment: 'Print the resolved module path in the runner',
        expected_if_true: 'a path outside the checkout',
        status: 'alternative',
        previously_tested: false,
      },
    ],
    chosen_hypothesis_id: 'H1',
    confidence: 'high',
  },
};

export function baseScenario(roles: Record<string, object[]>): object {
  return { auth: { loggedIn: true, authMethod: 'api_key', method: 'api_key', valid: true }, roles: { planner: [{ structured: PLANNER_OUTPUT }], reviewer: [APPROVE], ...roles } };
}

// ---------------------------------------------------------------------------
// Waiting and the child controller

export async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 60_000, stepMs = 50): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== null && v !== undefined && v !== false) return v as T;
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export function runState(lab: Lab, runId: string): RunRecord {
  return getRun(lab.db(), runId);
}

export interface ChildOptions {
  mode: 'service' | 'foreground';
  runId?: string;
  leaseTtlMs?: number;
}

/** The real controller loop in its own process (Node strips and transforms the TypeScript sources). */
export function spawnController(lab: Lab, opts: ChildOptions): ChildProcess & { output: () => string } {
  const args = { repo: lab.repo, orbitHome: lab.orbitHome, configPath: lab.configPath, templatePath: lab.templatePath, scenarioPath: lab.scenarioPath, argvLog: lab.argvLog, ...opts };
  const child = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', CHILD, JSON.stringify(args)], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
  let out = '';
  child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr?.on('data', (d: Buffer) => (out += d.toString()));
  return Object.assign(child, { output: () => out });
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function argvCalls(lab: Lab): { tool: string; role: string; call: number }[] {
  if (!existsSync(lab.argvLog)) return [];
  return readFileSync(lab.argvLog, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { tool: string; role: string; call: number });
}

export function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}
