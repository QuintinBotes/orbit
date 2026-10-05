/**
 * scripts/demo/run-live-demo.sh without any provider or network: it refuses to run
 * without an explicit --repo, refuses a public repository, keeps credentials apart,
 * never prints a token, and collects the reports. `gh`, `claude`, `codex` and `orbit`
 * are stubs on PATH; the "GitHub" remote is a local bare repository.
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyExample, git, initRepo, ORBIT_ROOT } from '../../../scripts/demo/lib/example.ts';

const SCRIPT = join(ORBIT_ROOT, 'scripts/demo/run-live-demo.sh');
const TOKEN = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB';

let base: string;
let bin: string;
let bare: string;
let ghVisibility: string;

function stub(name: string, body: string): void {
  const p = join(bin, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
}

function run(args: string[], env: Record<string, string | undefined> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const full: NodeJS.ProcessEnv = {
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      HOME: base,
      TMPDIR: base,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.${bare}.insteadOf`,
      GIT_CONFIG_VALUE_0: 'https://github.com/acme/demo.git',
      ...env,
    };
    for (const k of Object.keys(full)) if (full[k] === undefined) delete full[k];
    const child = spawn('bash', [SCRIPT, ...args], { cwd: base, env: full, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'orbit-live-script-'));
  bin = join(base, 'bin');
  mkdirSync(bin);
  // A remote that already holds the demo app, as a previous run of the script would have left it.
  const seed = join(base, 'seed');
  copyExample(seed);
  initRepo(seed);
  bare = join(base, 'remote.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', bare);
  git(seed, 'push', '-q', bare, 'main');
  ghVisibility = join(base, 'visibility');
  writeFileSync(ghVisibility, 'true');
  const marker = join(base, 'gh-calls.log');
  // Records every call (never an environment), answers only what the script may ask.
  stub(
    'gh',
    `echo "$*" >> ${JSON.stringify(marker)}
if [ -n "$GH_TOKEN" ] || [ -n "$GITHUB_TOKEN" ]; then echo "gh saw a token in its environment" >&2; exit 7; fi
case "$1 $2" in
  "auth status") exit 0 ;;
  "repo view") cat ${JSON.stringify(ghVisibility)}; exit 0 ;;
  *) echo "unexpected gh call: $*" >&2; exit 9 ;;
esac`,
  );
  stub('claude', 'exit 0');
  stub('codex', 'exit 0');
  // npm ci leaves what a real install would: the package doctor looks for. npx (browser install) is a no-op.
  stub('npm', `case "$1" in ci) mkdir -p node_modules/@playwright/test && echo '{}' > node_modules/@playwright/test/package.json ;; *) echo "unexpected npm call: $*" >&2; exit 9 ;; esac`);
  stub('npx', 'exit 0');
  // A stand-in for orbit: doctor passes; run writes a report and prints the token it was given, to prove redaction.
  const orbit = join(base, 'orbit-stub.mjs');
  writeFileSync(
    orbit,
    `import { mkdirSync, writeFileSync } from 'node:fs';
const [cmd] = process.argv.slice(2);
if (cmd === 'doctor') { console.log('doctor: all checks passed'); process.exit(0); }
if (cmd === 'models') { console.log('models: probed'); process.exit(0); }
if (cmd === 'run') {
  let goal = '';
  for await (const c of process.stdin) goal += c;
  const id = 'orb-20261005-000000-' + (goal.length.toString(16).padStart(6, '0'));
  console.log('run ' + id + ' started (autonomous-delivery, foreground)');
  console.log('GH_TOKEN=' + process.env.GH_TOKEN);
  mkdirSync('.orbit/runs/' + id, { recursive: true });
  writeFileSync('.orbit/runs/' + id + '/final.md', '# Orbit run ' + id + ': SUCCEEDED\\n\\n## Revision, branch and pull request\\n\\n- pull request: https://github.com/acme/demo/pull/1 (draft)\\n- note: token ' + process.env.GH_TOKEN + '\\n');
  process.exit(0);
}
process.exit(64);
`,
  );
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('run-live-demo.sh refuses to guess', () => {
  it('will not run without --repo', async () => {
    const r = await run([]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--repo OWNER\/NAME is required/);
    expect(existsSync(join(base, 'gh-calls.log'))).toBe(false);
  });

  it('will not take a malformed repository', async () => {
    const r = await run(['--repo', 'just-a-name']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/OWNER\/NAME/);
  });

  it('will not take an unknown goal', async () => {
    const r = await run(['--repo', 'acme/demo', '--goals', 'simple,nope']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/unknown goal: nope/);
  });

  it('a dry run says what it would do and touches nothing', async () => {
    const r = await run(['--repo', 'acme/demo', '--dry-run']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/repository : acme\/demo \(private\)/);
    expect(r.stdout).toMatch(/dry run: nothing created, nothing run/);
    expect(existsSync(join(base, 'gh-calls.log'))).toBe(false);
  });

  it('needs the scoped GH_TOKEN for the runs and says how to get one', async () => {
    const r = await run(['--repo', 'acme/demo', '--orbit', `node ${join(base, 'orbit-stub.mjs')}`], { GH_TOKEN: undefined });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/GH_TOKEN is not set/);
    expect(r.stderr).toMatch(/fine-grained token scoped to acme\/demo/);
  });

  it('refuses a repository that is not private', async () => {
    writeFileSync(ghVisibility, 'false');
    const r = await run(['--repo', 'acme/demo', '--orbit', `node ${join(base, 'orbit-stub.mjs')}`], { GH_TOKEN: TOKEN });
    writeFileSync(ghVisibility, 'true');
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/is not private; refusing/);
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
  });
});

describe('run-live-demo.sh over a private repository', () => {
  it('runs doctor, the three goals, collects the reports and never prints the token', async () => {
    const out = join(base, 'reports');
    const r = await run(['--repo', 'acme/demo', '--workdir', join(base, 'work'), '--out', out, '--yes', '--orbit', `node ${join(base, 'orbit-stub.mjs')}`], { GH_TOKEN: TOKEN });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const all = r.stdout + r.stderr;
    expect(all).toContain('doctor: all checks passed');
    expect(all).not.toContain(TOKEN);
    expect(all).toContain('GH_TOKEN=[redacted]');
    for (const g of ['simple', 'difficult', 'ui']) {
      expect(all).toContain(`${g}: SUCCEEDED (exit 0)`);
      const report = readFileSync(join(out, `${g}.md`), 'utf8');
      expect(report).toMatch(/^# Orbit run orb-\S+: SUCCEEDED/);
      expect(report).not.toContain(TOKEN);
    }
    expect(readdirSync(out).sort()).toEqual(['README.md', 'difficult.md', 'simple.md', 'ui.md']);
    const index = readFileSync(join(out, 'README.md'), 'utf8');
    expect(index).toMatch(/\| simple \| orb-\S+ \| SUCCEEDED \| https:\/\/github\.com\/acme\/demo\/pull\/1 \(draft\) \|/);
    // The clone holds the example but not the maintainer notes.
    expect(existsSync(join(base, 'work', 'demo', 'goals', 'ui.md'))).toBe(true);
    expect(existsSync(join(base, 'work', 'demo', 'DEMO.md'))).toBe(false);
  }, 120_000);

  it('exits 1 when a run does not succeed, and still collects what it has', async () => {
    const failing = join(base, 'orbit-fail.mjs');
    writeFileSync(
      failing,
      `const [cmd] = process.argv.slice(2);
if (cmd === 'doctor') process.exit(0);
console.log('run orb-20261005-000000-aaaaaa started');
process.exit(10);
`,
    );
    const out = join(base, 'reports-fail');
    const r = await run(['--repo', 'acme/demo', '--workdir', join(base, 'work2'), '--out', out, '--goals', 'simple', '--yes', '--orbit', `node ${failing}`], { GH_TOKEN: TOKEN });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/simple: exit 10 \(exit 10\)|simple: .*exit 10/);
    expect(readFileSync(join(out, 'README.md'), 'utf8')).toMatch(/\| simple \| orb-20261005-000000-aaaaaa \| exit 10 \| none \|/);
    // The stub also fails the model probe: that is a warning, not a reason to skip the runs.
    expect(r.stdout).toMatch(/warning: the model probe failed \(exit 10\)/);
  }, 120_000);

  it('stops before any run when doctor fails', async () => {
    const bad = join(base, 'orbit-doctor-fail.mjs');
    writeFileSync(bad, `if (process.argv[2] === 'doctor') { console.log('doctor: FAIL codex is not logged in'); process.exit(1); }\nconsole.log('run should never start'); process.exit(0);\n`);
    const r = await run(['--repo', 'acme/demo', '--workdir', join(base, 'work3'), '--out', join(base, 'reports-doctor'), '--yes', '--orbit', `node ${bad}`], { GH_TOKEN: TOKEN });
    expect(r.code).toBe(3);
    expect(r.stdout).toMatch(/codex is not logged in/);
    expect(r.stdout).not.toMatch(/run should never start/);
    expect(existsSync(join(base, 'reports-doctor'))).toBe(false);
  }, 120_000);
  it('installs the dependencies before doctor, also when the repository already exists', async () => {
    const strict = join(base, 'orbit-doctor-needs-install.mjs');
    writeFileSync(strict, `import { existsSync } from 'node:fs';
if (process.argv[2] === 'doctor') {
  if (!existsSync('node_modules/@playwright/test/package.json')) { console.log('doctor: FAIL @playwright/test is not installed'); process.exit(3); }
  console.log('doctor: all checks passed'); process.exit(0);
}
process.exit(1);
`);
    const r = await run(['--repo', 'acme/demo', '--workdir', join(base, 'work4'), '--out', join(base, 'reports-install'), '--yes', '--goals', 'simple', '--orbit', `node ${strict}`], { GH_TOKEN: TOKEN });
    expect(r.stdout).not.toMatch(/is not installed/);
    expect(r.stdout).toContain('doctor: all checks passed');
  }, 120_000);
  it('validates the models live after doctor and before the first run, so escalation has an eligible target', async () => {
    const calls = join(base, 'orbit-calls.log');
    const rec = join(base, 'orbit-recording.mjs');
    writeFileSync(rec, `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, args.join(' ') + '\\n');
if (args[0] === 'doctor') { console.log('doctor: all checks passed'); process.exit(0); }
if (args[0] === 'models') { console.log('probed'); process.exit(0); }
if (args[0] === 'run') {
  const id = 'orb-20261005-000000-abcdef';
  console.log('run ' + id + ' started');
  mkdirSync('.orbit/runs/' + id, { recursive: true });
  writeFileSync('.orbit/runs/' + id + '/final.md', '# Orbit run ' + id + ': SUCCEEDED\\n');
  process.exit(0);
}
process.exit(64);
`);
    const r = await run(['--repo', 'acme/demo', '--workdir', join(base, 'work5'), '--out', join(base, 'reports-probe'), '--yes', '--goals', 'simple', '--orbit', `node ${rec}`], { GH_TOKEN: TOKEN });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const order = readFileSync(calls, 'utf8').trim().split('\n').map((l) => l.split(' ').slice(0, 3).join(' '));
    expect(order[0]).toBe('doctor');
    expect(order[1]).toBe('models refresh --probe');
    expect(order[2]?.startsWith('run')).toBe(true);
  }, 120_000);
  it('passes progress through as it happens, not when the run ends', async () => {
    const seen = join(base, 'progress-seen');
    const stub = join(base, 'orbit-progress.mjs');
    writeFileSync(stub, `import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
const [cmd] = process.argv.slice(2);
if (cmd !== 'run') process.exit(0);
console.log('[12:00:00] CREATED -> PREFLIGHT  run started');
// Wait (up to 10 s) until the test has seen that line on the script's output.
const until = Date.now() + 10_000;
while (!existsSync(${JSON.stringify(seen)}) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
console.log(existsSync(${JSON.stringify(seen)}) ? 'progress: seen while running' : 'progress: not seen while running');
const id = 'orb-20261005-000000-cccccc';
console.log('run ' + id + ' started');
mkdirSync('.orbit/runs/' + id, { recursive: true });
writeFileSync('.orbit/runs/' + id + '/final.md', '# Orbit run ' + id + ': SUCCEEDED\\n');
`);
    const full: NodeJS.ProcessEnv = { PATH: `${bin}${delimiter}${process.env.PATH}`, HOME: base, TMPDIR: base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${bare}.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/acme/demo.git', GH_TOKEN: TOKEN };
    const child = spawn('bash', [SCRIPT, '--repo', 'acme/demo', '--workdir', join(base, 'work6'), '--out', join(base, 'reports-progress'), '--yes', '--goals', 'simple', '--orbit', `node ${stub}`], { cwd: base, env: full, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let seenWhileRunning = false;
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      if (!seenWhileRunning && out.includes('CREATED -> PREFLIGHT')) { seenWhileRunning = true; writeFileSync(seen, ''); }
    });
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    expect(code, out).toBe(0);
    expect(out).toContain('progress: seen while running');
  }, 120_000);
  it('collects reports without local paths: home, the clone and the system temp directory', async () => {
    const stub = join(base, 'orbit-paths.mjs');
    writeFileSync(stub, `import { mkdirSync, writeFileSync } from 'node:fs';
const [cmd] = process.argv.slice(2);
if (cmd === 'doctor' || cmd === 'models') process.exit(0);
const id = 'orb-20261005-000000-dddddd';
console.log('run ' + id + ' started');
mkdirSync('.orbit/runs/' + id, { recursive: true });
const lines = ['# Orbit run ' + id + ': SUCCEEDED', '', '- denied: cd ' + process.env.HOME + '/.orbit/worktrees/abc', '- clone: ' + process.cwd() + '/src/app.ts', '- temp: /private/var/folders/ab/cdef/T/orbit-x/y', '- temp2: /var/folders/ab/cdef/T/z'];
writeFileSync('.orbit/runs/' + id + '/final.md', lines.join('\\n') + '\\n');
`);
    const out = join(base, 'reports-paths');
    const r = await run(['--repo', 'acme/demo', '--workdir', join(base, 'work7'), '--out', out, '--yes', '--goals', 'simple', '--orbit', `node ${stub}`], { GH_TOKEN: TOKEN });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const report = readFileSync(join(out, 'simple.md'), 'utf8');
    expect(report).not.toContain(base);
    expect(report).not.toMatch(/\/var\/folders\//);
    expect(report).toContain('- denied: cd ~/.orbit/worktrees/abc');
    expect(report).toContain('- clone: <demo-repo>/src/app.ts');
    expect(report).toContain('- temp: <tmp>/orbit-x/y');
  }, 120_000);
});
