/** Issue #254: a queue's budget stop stays a budget stop, and an evaluation replay never asks the owner for money. */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../../../src/cli/cli.ts';
import { memoryIo } from '../../../src/cli/io.ts';
import type { QueueRecord } from '../../../src/cli/commands/queue.ts';
import { Controller } from '../../../src/controller/loop.ts';
import { ReplayEvalRunner } from '../../../src/controller/eval-runner.ts';
import { listRuns } from '../../../src/controller/run-store.ts';
import { systemClock } from '../../../src/core/clock.ts';
import { FakeIssueReader, FAKE_ISSUES_FILE } from '../../../src/intake/github.ts';
import { buildReplaySuite } from '../../../src/knowledge/evals.ts';
import type { OrbitDb } from '../../../src/storage/db.ts';
import { baseScenario, git, implementMul, labDeps, makeLab, PLANNER_OUTPUT, seedRegistry,startLabRun, writeScenario, type Lab } from '../controller/harness.ts';

const TIMING = { tickIntervalMs: 20, leaseTtlMs: 30_000, graceMs: 300 };

const labs: Lab[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const l of labs.splice(0)) l.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(tweak: Parameters<typeof makeLab>[0] extends infer O ? NonNullable<O> extends { tweak?: infer T } ? T : never : never): { l: Lab; state: string; env: NodeJS.ProcessEnv } {
  const l = makeLab({ tweak });
  labs.push(l);
  const state = mkdtempSync(join(tmpdir(), 'orbit-spend-state-'));
  dirs.push(state);
  return { l, state, env: { ...process.env, XDG_STATE_HOME: state } };
}

const inbox = (state: string): string[] => {
  const dir = join(state, 'stack', 'inbox', 'spend');
  return existsSync(dir) ? readdirSync(dir) : [];
};

const SPEC = ['## Summary', '', 'The calculator gains `mul`.', '', '## User Scenarios & Testing', '', '### User Story 1 - multiply (Priority: P1)', '', 'A caller uses `mul`.', '', '**Why this priority**: It is the feature.', '', '**Independent Test**: Call `mul(6, 3)`.', '', '**Acceptance Scenarios**:', '', '1. **Given** the calculator, **When** `mul(6, 3)` is called, **Then** it returns 18.', '', '## Requirements', '', '### Functional Requirements', '', '- **FR-001**: `mul` MUST be exported.', '', '## Success Criteria', '', '### Measurable Outcomes', '', '- **SC-001**: The unit check passes.', ''].join('\n');

describe('runs that are not a person\'s own request', () => {
  it('a queue run its --budget-usd cap stops with a spend request is a budget stop, and the issue stays the queue\'s', async () => {
    const { l, state, env } = setup((c) => {
      c.mode = 'autonomous';
      c.delivery = { ...c.delivery, provider: 'fake', require_ci: false };
    });
    const remote = join(l.base, 'remote.git');
    git(l.base, 'init', '-q', '--bare', '-b', 'main', remote);
    git(l.repo, 'remote', 'add', 'origin', remote);
    git(l.repo, 'push', '-q', 'origin', 'main');
    git(l.repo, 'switch', '-q', '-c', 'next');
    git(l.repo, 'push', '-q', 'origin', 'next');
    const issues = new FakeIssueReader({ statePath: join(l.repo, '.orbit', FAKE_ISSUES_FILE) });
    issues.put({ number: 1, title: 'Add mul', body: SPEC, labels: ['spec', 'ready-for-agent'] });
    // The queue's issue has one scenario, S1-1: the plan must name it for the run to get past its contract.
    const planner = { structured: { ...PLANNER_OUTPUT, criteria: [{ ...PLANNER_OUTPUT.criteria[0]!, key: 'S1-1' }] } };
    writeScenario(l, baseScenario({ planner: [planner], implementer: [{ ...implementMul('*'), usage: { costUSD: 1.6 } }] }));

    const io = memoryIo();
    const code = await main(['queue', 'run', '--base', 'next', '--budget-usd', '1.5', '--policy', l.configPath], {
      io,
      cwd: l.repo,
      homeDir: l.base,
      orbitHome: l.orbitHome,
      env: { ...env, ORBIT_HOME: l.orbitHome, HOME: l.base },
      user: 'alice',
      seams: {
        pollMs: 20,
        controller: { ...TIMING, shutdownGraceMs: 400, startGraceMs: 2_000 },
        controllerDeps: (input) => {
          seedRegistry(input.db!);
          return { ...labDeps(l, input.db), hostEnv: env };
        },
      },
    });
    expect(code, `${io.stdout}\n${io.stderr}`).toBe(0);
    expect(listRuns(l.db(), { limit: -1 }).map((r) => r.state)).toEqual(['BLOCKED']);
    const dir = join(l.repo, '.orbit', 'queue');
    const record = JSON.parse(readFileSync(join(dir, readdirSync(dir).find((f) => f.endsWith('.json'))!), 'utf8')) as QueueRecord;
    expect(record.stop?.kind).toBe('budget');
    expect(record.issues.map((i) => i.outcome)).toEqual(['budget']);
    expect(issues.writes).toEqual([]);
    expect(inbox(state)).toHaveLength(1);
  }, 300_000);

  it('an evaluation replay that reaches its cap ends as before and writes nothing to the inbox', async () => {
    const { l, state, env } = setup((c) => {
      c.scheduler.hard_limits.model_cost_usd = 12;
      c.scheduler.hard_limits.implementation_attempts = 1;
      c.scheduler.initial_allowances = { simple_attempts: 1, medium_attempts: 1, complex_attempts: 1 };
    });
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const source = startLabRun(l);
    await new Controller({ mode: 'foreground', runId: source.id, deps: labDeps(l), ...TIMING }).start();
    const original = listRuns(l.db(), { limit: -1 }).find((r) => r.id === source.id)!;
    expect(original.state, original.outcomeReason ?? '').toBe('SUCCEEDED');

    writeScenario(l, baseScenario({ implementer: [{ ...implementMul('*'), usage: { costUSD: 11.5 } }] }));
    const runner = new ReplayEvalRunner({ repoRoot: l.repo, config: l.config, clock: systemClock, orbitHome: l.orbitHome, budgetUsd: 12, registryDb: l.db(), deps: (input) => ({ ...labDeps(l, input.db as OrbitDb), hostEnv: env }), controller: TIMING });
    const suite = buildReplaySuite(l.db(), { limit: 1, role: 'implementer' }, systemClock);
    const result = await runner.runCase(suite, suite.cases[0]!, null);

    expect(result.verified).toBe(false);
    expect(runner.spentUsd).toBeGreaterThanOrEqual(11.5);
    expect(inbox(state)).toEqual([]);
  }, 200_000);
});
