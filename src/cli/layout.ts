/**
 * What the repository's own layout says about `scope.allowed_paths`. The
 * starter template names apps/, packages/, tests/ and docs/, which match
 * nothing in a repository laid out under src/; `orbit init` derives the paths
 * from the tracked files instead, and `orbit doctor` warns when none match.
 */
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { execCapture } from '../core/exec.ts';
import { gitEnv, type CliContext } from './context.ts';

/** Top-level directories that hold generated, vendored or protected-by-default material, never a sensible default scope. */
const NOT_SOURCE = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', 'target', 'infra', 'tmp', 'temp']);

/** Extensions that mark a top-level file as source in a flat layout (configuration formats such as json and yaml are left out). */
const SOURCE_EXTENSIONS = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cc', 'cpp', 'cs', 'php', 'swift', 'sh']);

/** Central build-system files that steer every project in a repository; protected wherever they are found (Makefile only at the root). */
const CENTRAL_BUILD_FILES = new Set(['directory.build.props', 'directory.build.targets', 'directory.packages.props', 'global.json', 'nuget.config']);

/** Pipeline YAML is recognised by content, so read at most this many files of at most this many bytes each. */
const MAX_YAML_READS = 2000;
const YAML_READ_BYTES = 64 * 1024;

/** At most this many directories are written; a repository with more is better scoped by hand. */
const MAX_DIRS = 8;

export async function trackedFiles(ctx: CliContext, repo: string): Promise<string[]> {
  try {
    const r = await execCapture(['git', 'ls-files', '-z'], { cwd: repo, env: gitEnv(ctx.env), timeoutMs: 30_000 });
    if (r.exitCode !== 0) return [];
    return r.stdout.split('\0').filter((f) => f.length > 0);
  } catch {
    return [];
  }
}

/** What the tracked files say about CI and build-system definitions (issue 4). */
export interface CiDefinitions {
  /** Globs and paths to add to scope.protected_paths: the definitions found, nothing else. */
  protectedPaths: string[];
  /** Top-level directories that hold definitions and no source, so they are left out of scope.allowed_paths. */
  excludedDirs: string[];
}

/** True when YAML text declares a pipeline: a top-level trigger:, stages: or jobs: key, or an extends: that names a template. */
export function isPipelineYaml(text: string): boolean {
  if (/^(trigger|stages|jobs):/m.test(text)) return true;
  return /^extends:[ \t]*(\r?\n[ \t]+template:|\{[^}\n]*\btemplate:|template:)/m.test(text);
}

/** A pipeline definition by its path alone: GitLab CI, CircleCI, Jenkinsfiles and GitHub Actions workflows. */
function isCiPath(file: string): boolean {
  const base = file.slice(file.lastIndexOf('/') + 1);
  if (base === '.gitlab-ci.yml' || base.startsWith('Jenkinsfile')) return true;
  return file.startsWith('.circleci/') || file.startsWith('.github/workflows/');
}

function isCentralBuildFile(file: string): boolean {
  const base = file.slice(file.lastIndexOf('/') + 1);
  return CENTRAL_BUILD_FILES.has(base.toLowerCase()) || file === 'Makefile';
}

/**
 * Which tracked files define CI pipelines or the central build, and what that means for the proposed scope. `isPipeline`
 * answers for a YAML file by its content. A top-level directory holding a definition and no source of its own (apart from
 * shell scripts) is excluded from the scope and protected as a whole; one that also holds source stays in scope, with
 * only the definitions protected.
 */
export function classifyCiDefinitions(files: readonly string[], isPipeline: (file: string) => boolean = () => false): CiDefinitions {
  const protectedPaths = new Set<string>();
  const defsByTop = new Map<string, string[]>();
  const definitionFiles = new Set<string>();
  for (const f of files) {
    if (isCentralBuildFile(f)) protectedPaths.add(f);
    const isYaml = /\.ya?ml$/i.test(f);
    if (isCiPath(f) || (isYaml && isPipeline(f))) {
      definitionFiles.add(f);
      const slash = f.indexOf('/');
      const top = slash > 0 ? f.slice(0, slash) : '';
      if (top === '' || top.startsWith('.')) {
        // A hidden top-level directory is never proposed as scope; protect the definitions it holds.
        protectedPaths.add(top === '.circleci' ? '.circleci/**' : top === '.github' ? '.github/**' : f);
      } else defsByTop.set(top, [...(defsByTop.get(top) ?? []), f]);
    }
  }
  const excludedDirs: string[] = [];
  for (const [top, defs] of [...defsByTop].sort(([a], [b]) => a.localeCompare(b))) {
    const holdsSource = files.some((f) => {
      if (!f.startsWith(`${top}/`) || definitionFiles.has(f)) return false;
      const dot = f.lastIndexOf('.');
      const ext = dot > 0 ? f.slice(dot + 1).toLowerCase() : '';
      return ext !== 'sh' && SOURCE_EXTENSIONS.has(ext);
    });
    if (!holdsSource) {
      excludedDirs.push(top);
      protectedPaths.add(`${top}/**`);
      continue;
    }
    for (const d of defs) {
      const dir = d.slice(0, d.lastIndexOf('/'));
      protectedPaths.add(dir === top ? d : `${dir}/**`);
    }
  }
  return { protectedPaths: [...protectedPaths].sort(), excludedDirs };
}

/** The scope `orbit init` proposes: source folders to allow, plus the CI and build definitions to protect. */
export interface ProposedScope {
  allowed: string[];
  protectedExtra: string[];
  excluded: string[];
}

async function readHead(path: string): Promise<string> {
  const h = await open(path, 'r');
  try {
    const buf = Buffer.alloc(YAML_READ_BYTES);
    const { bytesRead } = await h.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await h.close();
  }
}

/** Reads the YAML files of the visible top-level directories (and the root) to find pipeline definitions by content. */
async function pipelineYaml(repo: string, files: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  const candidates = files.filter((f) => /\.ya?ml$/i.test(f) && !f.startsWith('.') && !f.split('/').includes('node_modules')).slice(0, MAX_YAML_READS);
  for (const f of candidates) {
    try {
      if (isPipelineYaml(await readHead(join(repo, f)))) found.add(f);
    } catch {
      // An unreadable file (deleted since the listing, a dangling link) is not a pipeline definition we can name.
    }
  }
  return found;
}

export async function proposeScope(ctx: CliContext, repo: string, files?: readonly string[]): Promise<ProposedScope> {
  const tracked = files ?? (await trackedFiles(ctx, repo));
  const pipelines = await pipelineYaml(repo, tracked);
  const ci = classifyCiDefinitions(tracked, (f) => pipelines.has(f));
  return { allowed: suggestAllowedPaths(tracked, ci.excludedDirs), protectedExtra: ci.protectedPaths, excluded: ci.excludedDirs };
}

/**
 * `<dir>/**` for each top-level directory of the tracked files that looks like source, tests or documentation (minus the
 * `excludedDirs` that hold CI or build definitions); for a flat layout (no such directory) `*.<ext>` for the source
 * extensions at the top level; [] when there is neither.
 */
export function suggestAllowedPaths(files: readonly string[], excludedDirs: readonly string[] = []): string[] {
  const dirs = new Set<string>();
  for (const f of files) {
    const slash = f.indexOf('/');
    if (slash <= 0) continue;
    const top = f.slice(0, slash);
    if (top.startsWith('.') || NOT_SOURCE.has(top) || excludedDirs.includes(top)) continue;
    // A glob metacharacter in a directory name would change what the glob means; leave such directories to a person.
    if (/[*?[\]{}()!\\]/.test(top)) continue;
    dirs.add(top);
  }
  const sorted = [...dirs].sort();
  if (sorted.length > MAX_DIRS) return [];
  if (sorted.length > 0) return sorted.map((d) => `${d}/**`);
  // A flat layout has no directory to scope to: the source files sit at the top level, so scope by their extensions.
  const exts = new Set<string>();
  for (const f of files) {
    if (f.includes('/') || f.startsWith('.')) continue;
    const dot = f.lastIndexOf('.');
    const ext = dot > 0 ? f.slice(dot + 1).toLowerCase() : '';
    if (SOURCE_EXTENSIONS.has(ext)) exts.add(ext);
  }
  return [...exts].sort().map((e) => `*.${e}`);
}
