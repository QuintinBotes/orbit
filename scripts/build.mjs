#!/usr/bin/env node
// Builds plugin/dist/orbit.mjs, the single-file CLI the plugin ships (docs/decisions/0006-plugin-packaging.md).
// Every runtime dependency is bundled except srt, the plugin package's one dependency, which runs as its own program.
// Files the bundle loads at runtime but must not inline are copied beside it as they are (RUNTIME_FILES); text the
// bundle needs from outside src/ (the starter config) is inlined. The default build also copies the repository's
// README, changelog and documentation into plugin/, because a git-subdir marketplace install receives only that tree.
//   node scripts/build.mjs            build, then smoke run --version
//   node scripts/build.mjs --check    build in memory; fail if the plugin bundle, runtime files or documentation is stale
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = process.env.ORBIT_BUILD_ENTRY ?? join(root, 'src/cli/main.ts');
const outfile = process.env.ORBIT_BUILD_OUT ?? join(root, 'plugin/dist/orbit.mjs');
const check = process.argv.includes('--check');
const defaultPluginBuild = process.env.ORBIT_BUILD_ENTRY === undefined && process.env.ORBIT_BUILD_OUT === undefined;

function filesBelow(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...filesBelow(path));
    else out.push(path);
  }
  return out;
}

const DOCUMENTATION_FILES = [
  ['README.md', join(root, 'README.md')],
  ['CHANGELOG.md', join(root, 'CHANGELOG.md')],
  ...filesBelow(join(root, 'docs')).map((source) => [relative(root, source).split(sep).join('/'), source]),
];

function documentationProblem() {
  for (const [name, source] of DOCUMENTATION_FILES) {
    const target = join(root, 'plugin', name);
    if (!existsSync(target) || readFileSync(target, 'utf8') !== readFileSync(source, 'utf8')) return `${target} does not match ${source}`;
  }
  return null;
}

// Runtime files shipped next to plugin/dist/orbit.mjs, by name in dist/ and source. The srt preload runs in its own node
// process ahead of srt (src/isolation/sandbox-runtime.ts finds it beside the bundle), so it cannot be bundled.
const RUNTIME_FILES = [['srt-chromium-preload.mjs', join(root, 'src/isolation/srt-chromium-preload.mjs')]];

// Some dependencies (ajv) are CommonJS and call require() at load; an ESM bundle has
// no require, so provide one. The shebang must stay on line 1.
const banner = [
  '#!/usr/bin/env node',
  "import { createRequire as __orbitCreateRequire } from 'node:module';",
  'const require = __orbitCreateRequire(import.meta.url);',
].join('\n');

if (!existsSync(entry)) {
  console.error(`build: entry not found: ${entry}`);
  process.exit(1);
}

let result;
try {
  result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    write: false,
    banner: { js: banner },
    // yaml's "node" export is CJS; its default export is the ESM build, which bundles smaller.
    alias: { yaml: join(root, 'node_modules/yaml/browser/index.js') },
    legalComments: 'none',
    logLevel: 'warning',
    // Deterministic output: no timestamps or absolute-path comments.
    sourcemap: false,
    minify: false,
    // Resolve dependencies from this repository even when the entry lives elsewhere.
    nodePaths: [join(root, 'node_modules')],
    // `orbit init` writes this starter config; src/cli/commands/init.ts reads the file itself when run from the sources.
    define: { __ORBIT_CONFIG_TEMPLATE__: JSON.stringify(readFileSync(join(root, 'templates/config.yaml'), 'utf8')) },
  });
} catch {
  // esbuild already printed the diagnostics; a bare stack trace adds nothing.
  console.error('build failed');
  process.exit(1);
}
const built = result.outputFiles[0].text;

// The bundle finds each runtime file beside itself through new URL(..., import.meta.url), which esbuild leaves alone.
// Orbit's own entry must reference every one of them; another entry (tests) ships the ones it references.
const referenced = (name) => built.includes(`new URL("./${name}", import.meta.url)`);
const unreferenced = RUNTIME_FILES.filter(([name]) => !referenced(name)).map(([name]) => name);
if (process.env.ORBIT_BUILD_ENTRY === undefined && unreferenced.length > 0) {
  console.error(`build: the bundle no longer locates ${unreferenced.join(', ')} beside itself`);
  process.exit(1);
}
const shipped = RUNTIME_FILES.filter(([name]) => referenced(name));

if (check) {
  const current = existsSync(outfile) ? readFileSync(outfile, 'utf8') : null;
  if (current !== built) {
    console.error(`dist is stale: ${outfile} does not match a fresh build. Run npm run build.`);
    process.exit(1);
  }
  for (const [name, source] of shipped) {
    const copy = join(dirname(outfile), name);
    if (!existsSync(copy) || readFileSync(copy, 'utf8') !== readFileSync(source, 'utf8')) {
      console.error(`dist is stale: ${copy} does not match ${source}. Run npm run build.`);
      process.exit(1);
    }
  }
  const docs = defaultPluginBuild ? documentationProblem() : null;
  if (docs !== null) {
    console.error(`plugin documentation is stale: ${docs}. Run npm run build.`);
    process.exit(1);
  }
  console.log(`${[outfile, ...shipped.map(([n]) => join(dirname(outfile), n))].join(', ')} up to date`);
  process.exit(0);
}

mkdirSync(dirname(outfile), { recursive: true });
writeFileSync(outfile, built);
chmodSync(outfile, 0o755);
for (const [name, source] of shipped) writeFileSync(join(dirname(outfile), name), readFileSync(source, 'utf8'), { mode: 0o644 });
if (defaultPluginBuild) {
  for (const [name, source] of DOCUMENTATION_FILES.slice(0, 2)) writeFileSync(join(root, 'plugin', name), readFileSync(source, 'utf8'));
  const pluginDocs = join(root, 'plugin', 'docs');
  rmSync(pluginDocs, { recursive: true, force: true });
  cpSync(join(root, 'docs'), pluginDocs, { recursive: true });
}

// Smoke run: a bundle that builds but cannot start is worse than a build failure.
const smoke = spawnSync(process.execPath, [outfile, '--version'], { encoding: 'utf8', timeout: 20_000 });
if (smoke.status !== 0 || smoke.stdout.trim() === '') {
  console.error(`smoke run failed (status ${smoke.status}): ${smoke.stderr.trim()}`);
  process.exit(1);
}
console.log(`built ${outfile} (${(built.length / 1024).toFixed(0)} KiB), version ${smoke.stdout.trim()}`);
