/**
 * Issue #22: `orbit doctor` fails claude.plugins when workers would load a plugin the policy does not allow, but
 * `orbit run --foreground` started anyway, spent its time on checks and a planner, and only then found every worker
 * session refused. Run start now evaluates the same check as doctor, in admission, before a run row, a frozen policy,
 * a base-revision check or a model call exists.
 *
 * In this process, over the real adapters and the fake `claude` (scenario `plugins`: what `claude plugin list --json`
 * reports and what a session's system/init loads).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../../../src/cli/cli.ts';
import { memoryIo } from '../../../src/cli/io.ts';
import type { CliContext, CliSeams } from '../../../src/cli/context.ts';
import { listRuns } from '../../../src/controller/run-store.ts';
import { openDb } from '../../../src/storage/db.ts';
import { stateDbPath } from '../../../src/controller/start.ts';
import { argvCalls, baseScenario, implementMul, labDeps, makeLab, seedRegistry, writeScenario, type Lab } from '../controller/harness.ts';

const labs: Lab[] = [];
function lab(opts: Parameters<typeof makeLab>[0] = {}): Lab {
  const l = makeLab(opts);
  labs.push(l);
  return l;
}
afterEach(() => labs.splice(0).forEach((l) => l.close()));

function seams(l: Lab): CliSeams {
  return {
    pollMs: 20,
    controller: { tickIntervalMs: 20, leaseTtlMs: 30_000, graceMs: 300, shutdownGraceMs: 400, startGraceMs: 2_000 },
    controllerDeps: (input) => {
      seedRegistry(input.db!);
      return labDeps(l, input.db);
    },
  };
}

async function cli(l: Lab, argv: string[]) {
  const io = memoryIo();
  const ctx: Partial<CliContext> = { io, cwd: l.repo, homeDir: l.base, orbitHome: l.orbitHome, env: { ...process.env, ORBIT_HOME: l.orbitHome, HOME: l.base }, user: 'alice', seams: seams(l) };
  const code = await main(argv, ctx);
  return { code, out: io.stdout, err: io.stderr };
}

const GOAL = 'Add a mul function to the calculator.';
const MANAGED = ['acme-audit@acme-it', 'acme-guard@acme-it', 'acme-lint@acme-it', 'acme-notes@acme-it'].map((id) => ({ id, scope: 'managed', enabled: true }));

function withPlugins(l: Lab, plugins: object[]): void {
  writeScenario(l, { ...baseScenario({ implementer: [implementMul('*')] }), plugins });
}

/** The runs this repository's state database holds; none when it was never created. */
function runIds(l: Lab): string[] {
  const path = stateDbPath(l.repo);
  if (!existsSync(path)) return [];
  const db = openDb(path);
  try {
    return listRuns(db).map((r) => r.id);
  } finally {
    db.close();
  }
}

describe('orbit run --foreground and the plugins a worker would load (issue #22)', () => {
  it('refuses with the full list and the exact fix, before a run, a check or a model call exists', async () => {
    const l = lab();
    withPlugins(l, MANAGED);
    const r = await cli(l, ['run', '--goal', GOAL, '--foreground', '--policy', l.configPath]);

    expect(r.code, r.out).toBe(4);
    expect(r.out, 'nothing started').not.toMatch(/started/);
    // The same words and the same fix line `orbit doctor` prints for claude.plugins.
    expect(r.err).toContain('cannot start a run: workers would load 4 plugin(s) the policy does not allow, so every worker session would be refused: ');
    for (const p of MANAGED) expect(r.err).toContain(`${p.id} (scope managed)`);
    expect(r.err).toContain(`add to .orbit/config.yaml: agents.allowed_plugins: ${JSON.stringify(MANAGED.map((p) => p.id))} (or agents.allow_managed_plugins: true for every managed plugin); a plugin can add hooks and tools to workers`);
    expect(r.err).toMatch(/No run was created and no model was called/);

    expect(runIds(l), 'no run row').toEqual([]);
    expect(existsSync(join(l.repo, '.orbit', 'runs')), 'no frozen policy').toBe(false);
    expect(argvCalls(l), 'no model call').toEqual([]);
  }, 60_000);

  it('starts once the policy allows the plugins', async () => {
    const l = lab({
      tweak: (c) => {
        c.agents.allow_managed_plugins = true;
      },
    });
    withPlugins(l, MANAGED);
    const r = await cli(l, ['run', '--goal', GOAL, '--foreground', '--policy', l.configPath]);
    expect(r.code, `${r.out}\n${r.err}`).toBe(0);
    expect(r.out).toMatch(/ended SUCCEEDED/);
  }, 120_000);

  it('does not refuse for plugins no worker loads (user scope, disabled) or whose scope doctor cannot place (a warning, not a failure)', async () => {
    const l = lab();
    withPlugins(l, [
      { id: 'acme-notes@acme', scope: 'user', enabled: true },
      { id: 'acme-off@acme-it', scope: 'managed', enabled: false },
    ]);
    const r = await cli(l, ['run', '--goal', GOAL, '--foreground', '--policy', l.configPath]);
    expect(r.code, `${r.out}\n${r.err}`).toBe(0);
  }, 120_000);

  it('a detached run is handed to a service whose environment is its own: not judged here, but by its controller at PREFLIGHT', async () => {
    const l = lab();
    withPlugins(l, MANAGED);
    const r = await cli(l, ['run', '--goal', GOAL, '--detach', '--policy', l.configPath]);
    expect(r.code, r.err).toBe(0);
    expect(runIds(l)).toHaveLength(1);
    expect(argvCalls(l)).toEqual([]);
  }, 60_000);
});
