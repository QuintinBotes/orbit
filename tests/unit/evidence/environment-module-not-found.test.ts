import { describe, expect, it } from 'vitest';
import { BASE_GATED_SIGNALS, classifyCouldNotRun, classifyModuleNotFound } from '../../../src/evidence/environment-failure.ts';
import { classifyProgramNotFound } from '../../../src/evidence/check-misconfigured.ts';

// Issue #166, FR-003: the environment-failure classifier covers a missing module, a missing toolchain and a package
// cache the sandbox denies. Each is read from the check's own output and never without the half that shows the
// repository's code did not fail.

const CHECKOUT = '/orbit/worktrees/acme/run-1/check-1';
const ROOTS = [CHECKOUT, '/orbit/runs/run-1/evidence/1/dist-check'];

/** What node 22 prints for an ES module that imports a package no node_modules holds (captured; the path made neutral). */
const ESM_PACKAGE = [
  'node:internal/modules/package_json_reader:314',
  '  throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);',
  '        ^',
  '',
  `Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'esbuild' imported from ${CHECKOUT}/scripts/build.mjs`,
  '    at Object.getPackageJSONURL (node:internal/modules/package_json_reader:314:9)',
  '    at packageResolve (node:internal/modules/esm/resolve:772:81) {',
  "  code: 'ERR_MODULE_NOT_FOUND'",
  '}',
  '',
  'Node.js v22.23.5',
  '[orbit] check=dist-check status=FAILED exit=1',
].join('\n');

/** The CommonJS form of the same (captured). */
const CJS_PACKAGE = [
  'node:internal/modules/cjs/loader:1433',
  '  throw err;',
  '  ^',
  '',
  "Error: Cannot find module 'esbuild'",
  'Require stack:',
  `- ${CHECKOUT}/scripts/build.cjs`,
  '    at Module._resolveFilename (node:internal/modules/cjs/loader:1430:15) {',
  "  code: 'MODULE_NOT_FOUND',",
  `  requireStack: [ '${CHECKOUT}/scripts/build.cjs' ]`,
  '}',
].join('\n');

describe('classifyModuleNotFound: a package the check imports is not installed where it runs', () => {
  it('reads node\'s ERR_MODULE_NOT_FOUND for a package, with the package and the file that imported it', () => {
    const f = classifyModuleNotFound({ checkId: 'dist-check', output: ESM_PACKAGE });
    expect(f).toMatchObject({ checkId: 'dist-check', fingerprint: null, signals: ['module-not-found'], module: 'esbuild', importer: `${CHECKOUT}/scripts/build.mjs` });
    expect(f!.cause).toBe('the package "esbuild" the check imports is not installed where the check runs');
    expect(f!.lines).toEqual([`Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'esbuild' imported from ${CHECKOUT}/scripts/build.mjs`]);
  });

  it('reads the CommonJS form, and takes the importer from the require stack', () => {
    expect(classifyModuleNotFound({ checkId: 'dist-check', output: CJS_PACKAGE })).toMatchObject({ signals: ['module-not-found'], module: 'esbuild', importer: `${CHECKOUT}/scripts/build.cjs` });
  });

  it('names a scoped package and a subpath by the package', () => {
    const output = `Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@acme/tool' imported from ${CHECKOUT}/scripts/build.mjs\n`;
    expect(classifyModuleNotFound({ checkId: 'build', output })).toMatchObject({ module: '@acme/tool' });
    expect(classifyModuleNotFound({ checkId: 'build', output: "Error: Cannot find module 'yaml/util'\nRequire stack:\n- /x/run.cjs\n" })).toMatchObject({ module: 'yaml', importer: '/x/run.cjs' });
  });

  it('leaves a missing file of the repository to the code: only a package name is the environment\'s', () => {
    for (const output of [
      `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '${CHECKOUT}/src/gone.mjs' imported from ${CHECKOUT}/src/main.mjs\n`,
      `Error: Cannot find module './gone.cjs'\nRequire stack:\n- ${CHECKOUT}/src/main.cjs\n`,
      `Error: Cannot find module '${CHECKOUT}/scripts/gone.mjs'\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1430:15)\n`,
      "Error: Cannot find module '#internal/thing'\nRequire stack:\n- /x/run.cjs\n",
    ]) {
      expect(classifyModuleNotFound({ checkId: 'build', output }), output).toBeNull();
    }
  });

  it('leaves a check whose output shows a failing test or a compile error to the code', () => {
    const failingTest = `${ESM_PACKAGE}\nnot ok 1 - tests/build.test.mjs\n# fail 1\n`;
    expect(classifyModuleNotFound({ checkId: 'unit', output: failingTest })).toBeNull();
    expect(classifyModuleNotFound({ checkId: 'lint', output: `${ESM_PACKAGE}\nsrc/a.ts(2,1): error TS2304: Cannot find name 'x'.\n` })).toBeNull();
  });

  it('is nothing for a check that failed some other way', () => {
    expect(classifyModuleNotFound({ checkId: 'build', output: 'Error: boom\n    at main (file:///x/main.mjs:1:1)\n' })).toBeNull();
    expect(classifyModuleNotFound({ checkId: 'build', output: '' })).toBeNull();
  });

  it('counts on a candidate only with the base revision or the caller\'s own evidence: the signal is base-gated', () => {
    expect(BASE_GATED_SIGNALS.has('module-not-found')).toBe(true);
  });
});

describe('a missing toolchain (classifyProgramNotFound)', () => {
  it.each([
    ['cargo', ['cargo', 'test', '--workspace'], 'sh: 1: cargo: not found'],
    ['pnpm', ['pnpm', 'test'], 'sh: pnpm: command not found'],
    ['dotnet', ['dotnet', 'build'], 'env: dotnet: No such file or directory'],
  ])('a check whose toolchain %s is not installed where it runs is an environment failure naming the program', (program, command, line) => {
    const f = classifyProgramNotFound({ checkId: 'build', command, shell: false, exitCode: 127, output: `${line}\n[orbit] check=build status=FAILED exit=127\n` });
    expect(f).toMatchObject({ signals: ['program-not-found'], program });
    expect(f!.cause).toContain(`the program "${program}" was not found where the check runs (exit 127)`);
  });

  it('a toolchain that ran and failed the code is not one', () => {
    expect(classifyProgramNotFound({ checkId: 'build', command: ['cargo', 'test'], shell: false, exitCode: 101, output: 'test result: FAILED. 0 passed; 1 failed\n' })).toBeNull();
  });
});

describe('a package cache the sandbox denies (classifyCouldNotRun)', () => {
  // The cache lies in the person's home, outside the check's checkout and its scratch directories.
  it.each([
    ['npm, macOS', "npm error code EPERM\nnpm error syscall open\nnpm error path /Users/acme/.npm/_cacache/tmp/3f9a1c\nnpm error errno -1\nnpm error Error: EPERM: operation not permitted, open '/Users/acme/.npm/_cacache/tmp/3f9a1c'\n", '/Users/acme/.npm/_cacache'],
    ['npm, Linux', "npm error code EROFS\nnpm error syscall mkdir\nnpm error path /home/acme/.npm/_cacache/index-v5\nnpm error errno -30\nnpm error rofs EROFS: read-only file system, mkdir '/home/acme/.npm/_cacache/index-v5'\n", '/home/acme/.npm/_cacache'],
    ['pnpm', " ERR_PNPM_EROFS  EROFS: read-only file system, mkdir '/home/acme/.local/share/pnpm/store/v10'\n", '/home/acme/.local/share/pnpm/store'],
    ['pip', "ERROR: Could not install packages due to an OSError: [Errno 30] Read-only file system: '/home/acme/.cache/pip/wheels'\n", '/home/acme/.cache/pip'],
    ['go', 'go: could not create module cache: mkdir /home/acme/go/pkg/mod: read-only file system\n', '/home/acme/go/pkg/mod'],
    // cargo prints the refused path at the head of its error chain and the operating system's answer under "Caused by:".
    ['cargo, Linux', 'error: failed to create directory `/home/acme/.cargo/registry/index/index.crates.io-1949cf8c6b5b557f`\n\nCaused by:\n  Read-only file system (os error 30)\n', '/home/acme/.cargo/registry'],
    ['cargo, macOS', 'error: failed to open: /Users/acme/.cargo/registry/cache/index.crates.io-1949cf8c6b5b557f/serde-1.0.219.crate\n\nCaused by:\n  Operation not permitted (os error 1)\n', '/Users/acme/.cargo/registry'],
  ])('%s: a write to the cache that the sandbox refused is an environment failure that shows the cache\'s path', (_name, output, path) => {
    const f = classifyCouldNotRun({ checkId: 'install', output, insideRoots: ROOTS });
    expect(f, output).toMatchObject({ fingerprint: null, signals: ['filesystem-denied'] });
    expect(f!.lines.join('\n')).toContain(path);
  });

  it('a refused registry connection while the cache is filled is one too (network-denied)', () => {
    const output = 'error: failed to get `serde` as a dependency of package `acme v0.1.0`\n\nCaused by:\n  [56] Failure when receiving data from the peer (CONNECT tunnel failed, response 403)\n';
    expect(classifyCouldNotRun({ checkId: 'build', output, insideRoots: ROOTS })).toMatchObject({ signals: ['network-denied'] });
  });

  // Issue #141: every node check of the baseline ended this way in about a second, with no network and an empty home.
  it('pnpm fetching the version packageManager pins, refused by the proxy with no cache to read, is one (network-denied), gated on a candidate', () => {
    const output = ' ERR_PNPM_FETCH_403  GET https://registry.npmjs.org/pnpm: Forbidden - 403\n\nNo authorization header was set for the request.\n';
    expect(classifyCouldNotRun({ checkId: 'unit', output, insideRoots: ROOTS })).toMatchObject({ signals: ['network-denied'] });
    expect(classifyCouldNotRun({ checkId: 'unit', output, insideRoots: ROOTS, baseSignals: [] })).toBeNull();
  });

  it('an error chain whose refused path lies in the checkout stays the code\'s, as does one with a failing test beside it', () => {
    const inside = `error: failed to create directory \`${CHECKOUT}/target/debug\`\n\nCaused by:\n  Read-only file system (os error 30)\n`;
    expect(classifyCouldNotRun({ checkId: 'build', output: inside, insideRoots: ROOTS })).toBeNull();
    const withTest = 'error: failed to create directory `/home/acme/.cargo/registry/index`\n\nCaused by:\n  Read-only file system (os error 30)\ntest result: FAILED. 3 passed; 1 failed\n';
    expect(classifyCouldNotRun({ checkId: 'test', output: withTest, insideRoots: ROOTS })).toBeNull();
  });

  it('an operating-system answer with no path above it in its chain is not read as one', () => {
    expect(classifyCouldNotRun({ checkId: 'build', output: 'error: could not compile `acme`\n\nCaused by:\n  Operation not permitted (os error 1)\n', insideRoots: ROOTS })).toBeNull();
  });

  it('on a candidate, a permission denial (EACCES) in an error chain counts only when the base revision showed it', () => {
    const output = 'error: failed to open: /home/acme/.cargo/registry/cache/x.crate\n\nCaused by:\n  Permission denied (os error 13)\n';
    expect(classifyCouldNotRun({ checkId: 'build', output, insideRoots: ROOTS })).toMatchObject({ signals: ['permission-denied'] });
    expect(classifyCouldNotRun({ checkId: 'build', output, insideRoots: ROOTS, baseSignals: [] })).toBeNull();
    expect(classifyCouldNotRun({ checkId: 'build', output, insideRoots: ROOTS, baseSignals: ['permission-denied'] })).toMatchObject({ signals: ['permission-denied'] });
  });
});
