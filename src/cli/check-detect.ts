/**
 * `orbit init`'s check proposals: the checks a new repository would otherwise need written by hand, derived from what
 * the repository itself declares (package.json scripts, a solution file, a pytest section, go.mod, Cargo.toml) and
 * only for tools that are on the machine's PATH. Nothing is run here except, for Rust, `cargo clippy --version` to
 * learn whether the component is installed. Every proposal is root-level: a monorepo gets one command at the root
 * (a root script, a solution, a workspace), never one check per package.
 *
 * Proposals are text for a new config only. `orbit init` never edits an existing config, so a check someone wrote is
 * never touched. The commands are argv lists (no shell), a category, a timeout and a reason; the written config
 * carries the reason in a comment asking the person to review the check.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { execCapture } from '../core/exec.ts';
import { which } from '../isolation/util.ts';
import { REPO_INSTRUCTION_FILES } from '../adapters/prompt.ts';
import { withOneMsbuildNode } from '../evidence/msbuild.ts';

export type CheckCategory = 'test' | 'lint' | 'typecheck' | 'build';
export type Ecosystem = 'node' | 'dotnet' | 'python' | 'go' | 'rust';

export interface ProposedCheck {
  id: string;
  ecosystem: Ecosystem;
  command: string[];
  category: CheckCategory;
  timeout_seconds: number;
  /** What the repository declares that led to the proposal. */
  reason: string;
}

export interface NotProposed {
  ecosystem: Ecosystem;
  reason: string;
}

export interface CheckProposal {
  proposed: ProposedCheck[];
  notProposed: NotProposed[];
  /** The tracked root instruction files read for documented commands, in reading order (issue #178, FR-001). */
  readDocs: string[];
}

/** A command an instruction file documents, as argv, with the check it would be and where it was read. */
interface DocumentedCommand {
  command: string[];
  ecosystem: Ecosystem;
  category: CheckCategory;
  /** "AGENTS.md line 7". */
  source: string;
}


export interface DetectInput {
  repo: string;
  /** git ls-files: nested projects, solutions and workspace packages are found here. */
  files: readonly string[];
  /** PATH of the environment the checks will run in; a tool absent from it is never proposed. */
  pathEnv: string | undefined;
  /** Answers whether `cargo clippy` works; the real probe runs it. Tests pass their own. */
  clippyAvailable?: (cargo: string) => Promise<boolean>;
}

const TIMEOUT = { lint: 300, typecheck: 300, nodeTest: 900, nodeBuild: 600, compile: 900, rustBuild: 1200, rustTest: 1200, rustLint: 900, pyType: 600 };
const MAX_READ_BYTES = 256 * 1024;
const MAX_PROJECT_READS = 200;
const MAX_TARGETS = 3;

function read(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').slice(0, MAX_READ_BYTES);
  } catch {
    return null;
  }
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

/** The program a documented command starts, for the ecosystem it belongs to; anything else is not read as a check. */
const TOOL_ECOSYSTEM: Readonly<Record<string, Ecosystem>> = {
  npm: 'node', pnpm: 'node', yarn: 'node', npx: 'node',
  dotnet: 'dotnet',
  pytest: 'python', python: 'python', python3: 'python', ruff: 'python', mypy: 'python', flake8: 'python', tox: 'python', uv: 'python', poetry: 'python',
  go: 'go',
  cargo: 'rust',
};

/** The words that make a command a check of a category, first match wins: `npm run test:unit` is a test, `cargo clippy` lint. */
const CATEGORY_WORDS: readonly [CheckCategory, ReadonlySet<string>][] = [
  ['typecheck', new Set(['typecheck', 'type-check', 'check-types', 'tsc', 'mypy', 'pyright'])],
  ['lint', new Set(['lint', 'eslint', 'ruff', 'flake8', 'clippy', 'vet'])],
  ['test', new Set(['test', 'tests', 'vitest', 'jest', 'mocha', 'pytest'])],
  ['build', new Set(['build'])],
];

/** Words that make a command set up dependencies, not check anything: `pnpm add -D vitest` is no test. */
const SETUP_WORDS: ReadonlySet<string> = new Set(['install', 'i', 'add', 'ci', 'get', 'sync', 'remove', 'uninstall', 'update', 'upgrade']);

const DRAFT_NAME: Readonly<Record<CheckCategory, string>> = { test: 'unit-tests', lint: 'lint', typecheck: 'typecheck', build: 'build' };
const CATEGORY_TIMEOUT: Readonly<Record<CheckCategory, number>> = { test: TIMEOUT.nodeTest, lint: TIMEOUT.lint, typecheck: TIMEOUT.typecheck, build: TIMEOUT.nodeBuild };

/**
 * The commands the repository's tracked root AGENTS.md, then CLAUDE.md, document (issue #138): every line of a fenced
 * code block and every inline code span, read as argv when it starts with a known tool, needs no shell (no operator,
 * quote, variable or leading assignment) and names a check category. Prose is never parsed into a command.
 */
export function documentedCommands(repo: string, files: readonly string[]): { read: string[]; commands: DocumentedCommand[] } {
  const readDocs: string[] = [];
  const commands: DocumentedCommand[] = [];
  for (const doc of REPO_INSTRUCTION_FILES) {
    if (!files.includes(doc)) continue;
    const text = read(join(repo, doc));
    if (text === null) continue;
    readDocs.push(doc);
    let fenced = false;
    text.split(/\r?\n/).forEach((lineText, i) => {
      if (/^\s*(```|~~~)/.test(lineText)) {
        fenced = !fenced;
        return;
      }
      const candidates = fenced ? [lineText.replace(/\s+#.*$/, '')] : [...lineText.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!);
      for (const raw of candidates) {
        const cmd = raw.trim().replace(/^\$\s+/, '');
        if (cmd === '' || /[|&;<>$`'"(){}\\*?]/.test(cmd)) continue;
        const argv = cmd.split(/\s+/);
        if (argv.some((a) => SETUP_WORDS.has(a))) continue;
        const ecosystem = Object.hasOwn(TOOL_ECOSYSTEM, argv[0]!) ? TOOL_ECOSYSTEM[argv[0]!] : undefined;
        if (ecosystem === undefined) continue;
        const words = new Set(argv.flatMap((a) => a.toLowerCase().split(':')));
        const category = CATEGORY_WORDS.find(([, set]) => [...set].some((w) => words.has(w)))?.[0];
        if (category !== undefined) commands.push({ command: argv, ecosystem, category, source: `${doc} line ${i + 1}` });
      }
    });
  }
  return { read: readDocs, commands };
}

class Collector {
  readonly proposed: ProposedCheck[] = [];
  readonly notProposed: NotProposed[] = [];
  add(c: ProposedCheck): void {
    this.proposed.push(c);
  }
  skip(ecosystem: Ecosystem, reason: string): void {
    this.notProposed.push({ ecosystem, reason });
  }
}

type Draft = Omit<ProposedCheck, 'id' | 'ecosystem'> & { name: string };

function nodeDrafts(input: DetectInput, out: Collector): Draft[] {
  const { repo, files, pathEnv } = input;
  const manifest = read(join(repo, 'package.json'));
  if (manifest === null) return [];
  let pkg: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(manifest);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
    pkg = parsed as Record<string, unknown>;
  } catch {
    out.skip('node', 'package.json is not valid JSON');
    return [];
  }
  const scripts = typeof pkg.scripts === 'object' && pkg.scripts !== null ? (pkg.scripts as Record<string, unknown>) : {};
  const has = (name: string): boolean => typeof scripts[name] === 'string' && (scripts[name] as string).trim() !== '';

  let pm: 'npm' | 'pnpm' | 'yarn' = 'npm';
  let pmFrom = 'no lockfile, so npm';
  if (existsSync(join(repo, 'pnpm-lock.yaml'))) [pm, pmFrom] = ['pnpm', 'pnpm-lock.yaml'];
  else if (existsSync(join(repo, 'yarn.lock'))) [pm, pmFrom] = ['yarn', 'yarn.lock'];
  else if (existsSync(join(repo, 'package-lock.json')) || existsSync(join(repo, 'npm-shrinkwrap.json'))) pmFrom = 'package-lock.json';
  else {
    const declared = typeof pkg.packageManager === 'string' ? /^(npm|pnpm|yarn)@/.exec(pkg.packageManager)?.[1] : undefined;
    if (declared === 'pnpm' || declared === 'yarn') [pm, pmFrom] = [declared, 'package.json packageManager'];
  }
  if (which(pm, pathEnv) === null) {
    out.skip('node', `package.json declares checks, but ${pm} (chosen from ${pmFrom}) was not found on PATH`);
    return [];
  }

  const workspaceDeclared = Array.isArray(pkg.workspaces) || (typeof pkg.workspaces === 'object' && pkg.workspaces !== null) || existsSync(join(repo, 'pnpm-workspace.yaml'));
  const nestedManifests = files.filter((f) => f.endsWith('package.json') && f !== 'package.json' && !f.split('/').includes('node_modules'));
  const nestedHas = (name: string): boolean =>
    nestedManifests.some((f) => {
      const t = read(join(repo, f));
      if (t === null) return false;
      try {
        const s = (JSON.parse(t) as { scripts?: Record<string, unknown> }).scripts;
        return typeof s?.[name] === 'string';
      } catch {
        return false;
      }
    });

  const run = (script: string): string[] => (script === 'test' ? [pm, 'test'] : [pm, 'run', script]);
  // The root script when there is one; else, in a workspace, one command that runs the script in every package that has it.
  const fanOut = (script: string): string[] | null => {
    if (!workspaceDeclared || !nestedHas(script)) return null;
    if (pm === 'npm') return ['npm', 'run', script, '--workspaces', '--if-present'];
    if (pm === 'pnpm') return ['pnpm', '-r', '--if-present', 'run', script];
    return null;
  };
  const drafts: Draft[] = [];
  const script = (name: string, scriptNames: string[], category: CheckCategory, timeout: number): boolean => {
    const found = scriptNames.find(has);
    if (found !== undefined) {
      drafts.push({ name, command: run(found), category, timeout_seconds: timeout, reason: `package.json declares a ${found} script (${pm}, from ${pmFrom})` });
      return true;
    }
    const fan = scriptNames.map(fanOut).find((c) => c !== null);
    if (fan) {
      drafts.push({ name, command: fan, category, timeout_seconds: timeout, reason: `workspace packages declare a ${scriptNames[0]} script and the root declares none, so one root command runs them (${pm}, from ${pmFrom})` });
      return true;
    }
    return false;
  };

  script('lint', ['lint'], 'lint', TIMEOUT.lint);
  const typed = script('typecheck', ['typecheck', 'type-check', 'check-types'], 'typecheck', TIMEOUT.typecheck);
  if (!typed) {
    const deps = { ...(pkg.dependencies as Record<string, unknown> | undefined), ...(pkg.devDependencies as Record<string, unknown> | undefined) };
    if (existsSync(join(repo, 'tsconfig.json')) && 'typescript' in deps) {
      const tsc = pm === 'npm' ? ['npx', '--no-install', 'tsc', '--noEmit'] : pm === 'pnpm' ? ['pnpm', 'exec', 'tsc', '--noEmit'] : ['yarn', 'tsc', '--noEmit'];
      drafts.push({ name: 'typecheck', command: tsc, category: 'typecheck', timeout_seconds: TIMEOUT.typecheck, reason: `tsconfig.json and the typescript dependency (${pm}, from ${pmFrom})` });
    }
  }
  // The default "npm init" test script only fails.
  if (has('test') && /no test specified/i.test(scripts.test as string)) {
    out.skip('node', 'the test script is the npm placeholder ("no test specified"), so no test check was proposed');
  } else script('unit-tests', ['test'], 'test', TIMEOUT.nodeTest);
  script('build', ['build'], 'build', TIMEOUT.nodeBuild);
  return drafts;
}

/** Test projects among the tracked project files: they reference the test SDK, or are named as tests. */
function dotnetTestProjects(repo: string, projects: readonly string[]): string[] {
  const found: string[] = [];
  for (const p of projects.slice(0, MAX_PROJECT_READS)) {
    const text = read(join(repo, p)) ?? '';
    if (/Microsoft\.NET\.Test\.Sdk/i.test(text) || /<IsTestProject>\s*true/i.test(text) || /tests?\.[cfv]sproj$/i.test(basename(p))) found.push(p);
  }
  return found;
}

/**
 * Every proposed dotnet command pins one MSBuild node: the dotnet CLI asks MSBuild for one node per processor, and a
 * worker node binds a named pipe under /tmp that the check sandbox refuses (docs/decisions/0009-toolchain-profiles.md,
 * addendum). `orbit doctor` fails a dotnet check without it.
 */
const ONE_MSBUILD_NODE = '-m:1';
const ONE_NODE_REASON = '-m:1 keeps MSBuild on one node, since the check sandbox refuses worker nodes their named pipe';

function dotnetDrafts(input: DetectInput, out: Collector): Draft[] {
  const { repo, files, pathEnv } = input;
  const solutions = files.filter((f) => /\.(sln|slnx)$/i.test(f));
  const projects = files.filter((f) => /\.(cs|fs|vb)proj$/i.test(f));
  if (solutions.length === 0 && projects.length === 0) return [];
  if (which('dotnet', pathEnv) === null) {
    out.skip('dotnet', 'the repository has .NET projects, but dotnet was not found on PATH');
    return [];
  }
  const depth = (f: string): number => f.split('/').length;
  let targets: string[];
  let what: string;
  if (solutions.length > 0) {
    const shallowest = Math.min(...solutions.map(depth));
    targets = solutions.filter((f) => depth(f) === shallowest).sort();
    what = 'solution';
  } else {
    targets = [...projects].sort();
    what = 'project';
  }
  if (targets.length > MAX_TARGETS) {
    out.skip('dotnet', `${targets.length} ${what} files and no single solution to build, so none was proposed; add a solution file or define the checks by hand`);
    return [];
  }
  const testProjects = dotnetTestProjects(repo, projects);
  const drafts: Draft[] = [];
  for (const target of targets) {
    // A file name starting with a dash must not read as an option.
    const t = target.startsWith('-') ? `./${target}` : target;
    const suffix = targets.length > 1 ? `-${slug(basename(target).replace(/\.[^.]+$/, ''))}` : '';
    drafts.push({ name: `build${suffix}`, command: ['dotnet', 'build', t, ONE_MSBUILD_NODE], category: 'build', timeout_seconds: TIMEOUT.compile, reason: `${what} file ${t}; ${ONE_NODE_REASON}` });
    const testable = what === 'solution' ? testProjects.length > 0 : testProjects.includes(t);
    if (testable) drafts.push({ name: `unit-tests${suffix}`, command: ['dotnet', 'test', t, ONE_MSBUILD_NODE], category: 'test', timeout_seconds: TIMEOUT.nodeTest, reason: `${what} file ${t} with ${what === 'solution' ? 'a test project' : 'a test project of its own'} (Microsoft.NET.Test.Sdk); ${ONE_NODE_REASON}` });
  }
  return drafts;
}

function pythonDrafts(input: DetectInput, out: Collector): Draft[] {
  const { repo, files, pathEnv } = input;
  const pyproject = read(join(repo, 'pyproject.toml'));
  const setupCfg = read(join(repo, 'setup.cfg'));
  const toxIni = read(join(repo, 'tox.ini'));
  const rootFiles = files.filter((f) => !f.includes('/'));
  const requirements = rootFiles.filter((f) => /^requirements.*\.(txt|in)$/i.test(f)).map((f) => read(join(repo, f)) ?? '');
  const markers = ['pyproject.toml', 'setup.cfg', 'tox.ini', 'pytest.ini', 'mypy.ini', 'ruff.toml', '.flake8'];
  if (!markers.some((m) => existsSync(join(repo, m)))) return [];
  const listed = (name: string): boolean => {
    const re = new RegExp(`(^|[^\\w-])${name}([^\\w-]|$)`, 'im');
    return [pyproject, setupCfg, toxIni, ...requirements].some((t) => t !== null && re.test(t));
  };
  const section = (text: string | null, re: RegExp): boolean => text !== null && re.test(text);
  const exists = (f: string): boolean => existsSync(join(repo, f));

  const declared = {
    pytest: exists('pytest.ini') ? 'pytest.ini' : section(pyproject, /^\[tool\.pytest/m) ? 'pyproject.toml' : section(setupCfg, /^\[tool:pytest\]/m) ? 'setup.cfg' : section(toxIni, /^\[pytest\]/m) ? 'tox.ini' : listed('pytest') ? 'the declared dependencies' : null,
    ruff: exists('ruff.toml') ? 'ruff.toml' : exists('.ruff.toml') ? '.ruff.toml' : section(pyproject, /^\[tool\.ruff/m) ? 'pyproject.toml' : listed('ruff') ? 'the declared dependencies' : null,
    flake8: exists('.flake8') ? '.flake8' : section(setupCfg, /^\[flake8\]/m) ? 'setup.cfg' : section(toxIni, /^\[flake8\]/m) ? 'tox.ini' : listed('flake8') ? 'the declared dependencies' : null,
    mypy: exists('mypy.ini') ? 'mypy.ini' : exists('.mypy.ini') ? '.mypy.ini' : section(pyproject, /^\[tool\.mypy/m) ? 'pyproject.toml' : section(setupCfg, /^\[mypy/m) ? 'setup.cfg' : listed('mypy') ? 'the declared dependencies' : null,
  };
  const present = (tool: string): boolean => which(tool, pathEnv) !== null;
  const drafts: Draft[] = [];
  const need = (tool: keyof typeof declared): boolean => {
    if (declared[tool] === null) return false;
    if (present(tool)) return true;
    out.skip('python', `${tool} is declared in ${declared[tool]}, but was not found on PATH`);
    return false;
  };
  if (need('pytest')) drafts.push({ name: 'unit-tests', command: ['pytest'], category: 'test', timeout_seconds: TIMEOUT.nodeTest, reason: `pytest is configured in ${declared.pytest}` });
  // One linter: ruff first, flake8 when ruff is not declared or not installed.
  if (declared.ruff !== null && present('ruff')) drafts.push({ name: 'lint', command: ['ruff', 'check', '.'], category: 'lint', timeout_seconds: TIMEOUT.lint, reason: `ruff is configured in ${declared.ruff}` });
  else if (declared.flake8 !== null && present('flake8')) drafts.push({ name: 'lint', command: ['flake8'], category: 'lint', timeout_seconds: TIMEOUT.lint, reason: `flake8 is configured in ${declared.flake8}` });
  else if (declared.ruff !== null) out.skip('python', `ruff is declared in ${declared.ruff}, but was not found on PATH`);
  else if (declared.flake8 !== null) out.skip('python', `flake8 is declared in ${declared.flake8}, but was not found on PATH`);
  if (need('mypy')) drafts.push({ name: 'typecheck', command: ['mypy', '.'], category: 'typecheck', timeout_seconds: TIMEOUT.pyType, reason: `mypy is configured in ${declared.mypy}` });
  return drafts;
}

/** The module directories a go.work file names with `use`, as `./dir` patterns; empty when it names only the root. */
function goWorkModules(text: string): string[] {
  const dirs: string[] = [];
  const clean = text.replace(/\/\/.*$/gm, '');
  for (const m of clean.matchAll(/^\s*use\s*\(([^)]*)\)/gm)) for (const l of (m[1] ?? '').split('\n')) dirs.push(l.trim());
  for (const m of clean.matchAll(/^\s*use\s+([^\s(][^\s]*)\s*$/gm)) dirs.push(m[1] ?? '');
  const norm = dirs.map((d) => d.replace(/^"|"$/g, '').replace(/^\.\//, '').replace(/\/$/, '')).filter((d) => d !== '');
  return [...new Set(norm)].filter((d) => d !== '.' && !d.startsWith('/') && !d.includes('..'));
}

function goDrafts(input: DetectInput, out: Collector): Draft[] {
  const { repo, pathEnv } = input;
  const work = read(join(repo, 'go.work'));
  if (!existsSync(join(repo, 'go.mod')) && work === null) return [];
  if (which('go', pathEnv) === null) {
    out.skip('go', 'the repository has a Go module, but go was not found on PATH');
    return [];
  }
  const modules = work === null ? [] : goWorkModules(work);
  const patterns = modules.length > 0 ? modules.map((m) => `./${m}/...`) : ['./...'];
  const reason = modules.length > 0 ? `go.work lists ${modules.length} module(s), so one root command covers them` : 'go.mod';
  if (modules.length === 0 && !existsSync(join(repo, 'go.mod'))) {
    out.skip('go', 'go.work names no module directory and there is no root go.mod');
    return [];
  }
  return [
    { name: 'build', command: ['go', 'build', ...patterns], category: 'build', timeout_seconds: TIMEOUT.compile, reason },
    { name: 'vet', command: ['go', 'vet', ...patterns], category: 'lint', timeout_seconds: TIMEOUT.lint, reason },
    { name: 'unit-tests', command: ['go', 'test', ...patterns], category: 'test', timeout_seconds: TIMEOUT.nodeTest, reason },
  ];
}

async function rustDrafts(input: DetectInput, out: Collector): Promise<Draft[]> {
  const { repo, pathEnv } = input;
  const manifest = read(join(repo, 'Cargo.toml'));
  if (manifest === null) return [];
  const cargo = which('cargo', pathEnv);
  if (cargo === null) {
    out.skip('rust', 'the repository has a Cargo.toml, but cargo was not found on PATH');
    return [];
  }
  const ws = /^\[workspace\]/m.test(manifest) ? ['--workspace'] : [];
  const reason = ws.length > 0 ? 'Cargo.toml declares a workspace, so one root command covers its members' : 'Cargo.toml';
  const drafts: Draft[] = [
    { name: 'build', command: ['cargo', 'build', ...ws], category: 'build', timeout_seconds: TIMEOUT.rustBuild, reason },
    { name: 'unit-tests', command: ['cargo', 'test', ...ws], category: 'test', timeout_seconds: TIMEOUT.rustTest, reason },
  ];
  const clippy = await (input.clippyAvailable ?? realClippyProbe)(cargo);
  if (clippy) drafts.push({ name: 'clippy', command: ['cargo', 'clippy', ...ws, '--all-targets', '--', '-D', 'warnings'], category: 'lint', timeout_seconds: TIMEOUT.rustLint, reason: `${reason}; cargo clippy is installed` });
  else out.skip('rust', 'cargo clippy is not installed (rustup component add clippy), so no clippy check was proposed');
  return drafts;
}

async function realClippyProbe(cargo: string): Promise<boolean> {
  try {
    const r = await execCapture([cargo, 'clippy', '--version'], { cwd: dirname(cargo), timeoutMs: 20_000, maxOutputBytes: 16 * 1024 });
    return r.exitCode === 0 && !r.timedOut;
  } catch {
    return false;
  }
}

/** The checks to propose for a repository, in a fixed order; ids carry the ecosystem when more than one ecosystem has checks. */
export async function detectChecks(input: DetectInput): Promise<CheckProposal> {
  const out = new Collector();
  const groups: [Ecosystem, Draft[]][] = [
    ['node', nodeDrafts(input, out)],
    ['dotnet', dotnetDrafts(input, out)],
    ['python', pythonDrafts(input, out)],
    ['go', goDrafts(input, out)],
    ['rust', await rustDrafts(input, out)],
  ];
  // A command the repository documents wins over the one derived from its manifests (issue #138): the first one per
  // ecosystem and category, in reading order, so AGENTS.md comes before CLAUDE.md. It is proposed only when its tool is on PATH.
  const docs = documentedCommands(input.repo, input.files);
  const taken = new Set<string>();
  for (const d of docs.commands) {
    const key = `${d.ecosystem}/${d.category}`;
    if (taken.has(key)) continue;
    const tool = d.command[0]!;
    if (which(tool, input.pathEnv) === null) {
      out.skip(d.ecosystem, `${d.source} documents ${d.command.join(' ')}, but ${tool} was not found on PATH`);
      continue;
    }
    taken.add(key);
    const drafts = groups.find(([e]) => e === d.ecosystem)![1];
    // The check sandbox needs one MSBuild node, as for the derived .NET commands; unchanged for every other tool.
    const command = d.ecosystem === 'dotnet' ? withOneMsbuildNode(d.command) : d.command;
    const same = drafts.flatMap((x, j) => (x.category === d.category ? [j] : []));
    // Several drafts of one kind are per target (.NET without one solution): replace the one whose target it names.
    const i = same.length === 1 ? same[0]! : (same.find((j) => drafts[j]!.command.every((w) => w.startsWith('-') || command.includes(w))) ?? -1);
    const derived = i >= 0 ? drafts[i]! : null;
    const draft: Draft = {
      name: derived?.name ?? DRAFT_NAME[d.category],
      command,
      category: d.category,
      timeout_seconds: derived?.timeout_seconds ?? CATEGORY_TIMEOUT[d.category],
      reason: `documented in ${d.source}${derived ? `, in place of ${derived.command.join(' ')} from the manifests` : ''}${command.join(' ') !== d.command.join(' ') ? `; ${ONE_NODE_REASON}` : ''}`,
    };
    if (derived) drafts[i] = draft;
    else drafts.push(draft);
  }
  const active = groups.filter(([, d]) => d.length > 0);
  const mixed = active.length > 1;
  for (const [ecosystem, drafts] of active) {
    for (const { name, ...rest } of drafts) out.add({ id: mixed ? `${ecosystem}-${name}` : name, ecosystem, ...rest });
  }
  return { proposed: out.proposed, notProposed: out.notProposed, readDocs: docs.read };
}

/** The `checks:` entries for the written config, each under a comment saying init proposed it. Empty when nothing was proposed. */
export function renderChecksYaml(proposed: readonly ProposedCheck[]): string {
  let text = '';
  for (const c of proposed) {
    text += `  # Proposed by "orbit init" (${c.reason.replace(/[\r\n]+/g, ' ')}). Review it before the first run.\n`;
    text += `  ${c.id}:\n`;
    text += `    command: [${c.command.map((x) => JSON.stringify(x)).join(', ')}]\n`;
    text += `    category: ${c.category}\n`;
    text += `    timeout_seconds: ${c.timeout_seconds}\n`;
  }
  return text;
}
