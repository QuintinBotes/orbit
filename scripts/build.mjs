#!/usr/bin/env node
// Builds dist/orbit.mjs, the single-file CLI the plugin ships. The plugin has no
// install step (--plugin-dir and local marketplaces skip dependency install), so
// every runtime dependency is bundled.
//   node scripts/build.mjs            build, then smoke run --version
//   node scripts/build.mjs --check    build in memory; fail if dist/orbit.mjs is stale
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = process.env.ORBIT_BUILD_ENTRY ?? join(root, 'src/cli/main.ts');
const outfile = process.env.ORBIT_BUILD_OUT ?? join(root, 'dist/orbit.mjs');
const check = process.argv.includes('--check');

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
  });
} catch {
  // esbuild already printed the diagnostics; a bare stack trace adds nothing.
  console.error('build failed');
  process.exit(1);
}
const built = result.outputFiles[0].text;

if (check) {
  const current = existsSync(outfile) ? readFileSync(outfile, 'utf8') : null;
  if (current !== built) {
    console.error(`dist is stale: ${outfile} does not match a fresh build. Run npm run build.`);
    process.exit(1);
  }
  console.log('dist/orbit.mjs is up to date');
  process.exit(0);
}

mkdirSync(dirname(outfile), { recursive: true });
writeFileSync(outfile, built);
chmodSync(outfile, 0o755);

// Smoke run: a bundle that builds but cannot start is worse than a build failure.
const smoke = spawnSync(process.execPath, [outfile, '--version'], { encoding: 'utf8', timeout: 20_000 });
if (smoke.status !== 0 || smoke.stdout.trim() === '') {
  console.error(`smoke run failed (status ${smoke.status}): ${smoke.stderr.trim()}`);
  process.exit(1);
}
console.log(`built ${outfile} (${(built.length / 1024).toFixed(0)} KiB), version ${smoke.stdout.trim()}`);
