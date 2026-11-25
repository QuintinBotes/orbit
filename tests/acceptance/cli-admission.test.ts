/**
 * Issue #166, FR-002: what a person sees before a run exists. Each scenario replays one report from the first
 * outside runs (issues #138, #139 and #142) through the `orbit` CLI as a child process, or through doctor's own check
 * where the full command needs an OS sandbox the lab does not have.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkSandboxCheck } from '../../src/cli/commands/doctor-sandbox.ts';
import { listRuns } from '../../src/controller/run-store.ts';
import { NoIsolation } from '../../src/isolation/none.ts';
import type { IsolationProvider } from '../../src/isolation/types.ts';
import { defaultCheck } from '../../src/policy/config.ts';
import type { OrbitConfig } from '../../src/policy/types.ts';
import { repoKeyFor } from '../../src/storage/retention.ts';
import { git, makeLab, orbitOnce, READY, seedRegistry, writeScenario, type Lab, type LabOptions } from './helpers/lab.ts';
import { GOAL, scenario } from './helpers/scenarios.ts';

const labs: Lab[] = [];
afterEach(() => labs.splice(0).forEach((l) => l.close()));
function lab(opts: LabOptions = {}): Lab {
  const l = makeLab(opts);
  labs.push(l);
  return l;
}

/** The first `{` to the end: the CLI child's stderr and stdout share one buffer, and warnings go before the JSON. */
function jsonOf<T>(out: string): T {
  return JSON.parse(out.slice(out.indexOf('{'))) as T;
}

describe.skipIf(!READY)('acceptance: admission and setup say what they did not check (issue #166, FR-002)', () => {
  it('issue #138: init proposes the test command CLAUDE.md documents and says where it read it (issue #178, FR-001)', async () => {
    // Given a repository whose CLAUDE.md documents its test command, and no Orbit config yet.
    const l = lab({ files: { 'CLAUDE.md': '# Commands\n\nRun the tests with `npm test -- --test-concurrency=4`: an uncapped run starves on a loaded machine.\n' } });
    git(l.repo, 'rm', '-q', '.orbit/config.yaml');
    git(l.repo, 'commit', '-q', '-m', 'No Orbit config yet');

    // When init writes the config.
    const r = await orbitOnce(l, ['init', '--json']);
    expect(r.code, r.out).toBe(0);
    const j = jsonOf<{ config: { status: string }; checks: { proposed: { command: string[]; reason: string }[]; read_docs?: string[]; unread_docs?: string[] }; warnings: string[] }>(r.out);

    // Then it proposed the documented command in place of the manifest's, says where it read it, and records the file.
    expect(j.config.status).toBe('created');
    const documented = j.checks.proposed.find((c) => c.command.join(' ') === 'npm test -- --test-concurrency=4');
    expect(documented?.reason, JSON.stringify(j.checks)).toMatch(/^documented in CLAUDE\.md line 3/);
    expect(j.checks.read_docs).toEqual(['CLAUDE.md']);
    expect(j.checks).not.toHaveProperty('unread_docs');
  }, 120_000);

  it('issue #139: submitting a goal an unfinished run already has is refused, naming that run and how to continue it', async () => {
    const l = lab();
    writeScenario(l, scenario({}));
    seedRegistry(l.db());
    const argv = ['run', '--goal', GOAL, '--detach', '--policy', l.configPath];

    // Given one detached run of the goal, waiting for a controller.
    const first = await orbitOnce(l, argv);
    expect(first.code, first.out).toBe(0);
    const runs = listRuns(l.db());
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    const snapshots = readdirSync(join(l.repo, '.orbit', 'runs')).sort();

    // When the same goal is submitted again.
    const second = await orbitOnce(l, argv);

    // Then no second run exists, and the refusal names the first and the commands that move it.
    expect(second.code, second.out).not.toBe(0);
    expect(listRuns(l.db())).toHaveLength(1);
    expect(readdirSync(join(l.repo, '.orbit', 'runs')).sort()).toEqual(snapshots);
    expect(second.out).toContain(run.id);
    for (const command of ['status', 'resume', 'cancel']) expect(second.out).toContain(`orbit ${command} ${run.id}`);
    expect(second.out).toContain('No run was created');

    // A different goal is still admitted, and so is the same goal once the first run is cancelled.
    const other = await orbitOnce(l, ['run', '--goal', `${GOAL} (second request)`, '--detach', '--policy', l.configPath]);
    expect(other.code, other.out).toBe(0);
    expect((await orbitOnce(l, ['cancel', run.id])).code).toBe(0);
    const again = await orbitOnce(l, argv);
    expect(again.code, again.out).toBe(0);
    expect(listRuns(l.db()).filter((r) => r.goal === GOAL)).toHaveLength(2);
  }, 180_000);

  it('issue #142: doctor warns when a mandatory check runs a toolchain whose dependency cache is missing and no install fills it, though its probe starts', async () => {
    // Given a Cargo workspace whose mandatory check is `cargo test`, no dependencies.install_command, and no cache yet.
    const l = lab({ files: { 'Cargo.toml': '[workspace]\nmembers = []\n' } });
    const bin = join(l.base, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'cargo'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const config = structuredClone(l.config) as OrbitConfig;
    config.checks = { 'rust-test': { ...defaultCheck('rust-test'), command: ['cargo', 'test', '--workspace'], mandatory: true } };
    config.dependencies = { ...config.dependencies, install_existing_lockfile: true, install_command: null };
    // The check sandbox as doctor sees it on a machine that has one; the lab itself runs without an OS sandbox.
    const inner = new NoIsolation();
    const provider = { kind: 'sandbox-runtime', available: () => inner.available(), wrap: inner.wrap.bind(inner) } as unknown as IsolationProvider;
    const cache = join(l.orbitHome, 'toolchains', repoKeyFor(l.repo), 'cargo');
    const run = (cfg: OrbitConfig) => checkSandboxCheck({ config: cfg, repo: l.repo, provider, available: true, env: { PATH: bin, HOME: l.base }, homeDir: l.base, orbitHome: l.orbitHome, launch: async () => ({ exitCode: 0, output: 'cargo 1.90.0' }) });

    // When doctor examines the check sandbox.
    const c = await run(config);

    // Then the probe that starts is not reported as a pass: the missing cache and its fix are named.
    expect(c.id).toBe('checks.sandbox');
    expect(c.status).toBe('warn');
    expect(c.summary).toContain(`no run fills the rust toolchain's dependency cache ${cache}`);
    expect(c.summary).toContain('check rust-test runs at its baseline');
    expect(c.fix).toContain('set dependencies.install_command');
    // Doctor created nothing, and an install that fills the cache settles it.
    expect(existsSync(cache)).toBe(false);
    const withInstall = structuredClone(config) as OrbitConfig;
    withInstall.dependencies = { ...withInstall.dependencies, install_command: ['cargo', 'fetch'] };
    expect((await run(withInstall)).status).toBe('pass');
  }, 120_000);
});
