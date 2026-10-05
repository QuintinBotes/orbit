/**
 * Shared pieces for the fault-injection suite (spec section 17). The lab
 * (temp git repository, frozen policy, fake provider CLIs behind the real
 * adapters and shim) is the controller integration harness; this file adds
 * a child controller that runs with ORBIT_FAULTS, cleanup of everything a
 * test starts, and a few readers over durable state.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { killGroup } from '../../src/core/proc.ts';
import { Controller } from '../../src/controller/loop.ts';
import type { ControllerDeps } from '../../src/controller/context.ts';
import { step } from '../../src/controller/steps/index.ts';
import { acquireLease, releaseLease } from '../../src/controller/run-store.ts';
import { systemClock } from '../../src/core/clock.ts';
import { labDeps, makeLab, runState, type ChildOptions, type Lab } from '../integration/controller/harness.ts';

export * from '../integration/controller/harness.ts';

export const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

const CHILD = fileURLToPath(new URL('../integration/controller/fixtures/controller-main.ts', import.meta.url));

export interface Tracker {
  lab(opts?: Parameters<typeof makeLab>[0]): Lab;
  child<T extends ChildProcess>(c: T): T;
  group(pgid: number | null | undefined): void;
  cleanup(): void;
}

/** Everything a test starts, stopped and removed in afterEach. */
export function tracker(): Tracker {
  const labs: Lab[] = [];
  const children: ChildProcess[] = [];
  const groups: number[] = [];
  return {
    lab(opts = {}) {
      const l = makeLab(opts);
      labs.push(l);
      return l;
    },
    child(c) {
      children.push(c);
      return c;
    },
    group(pgid) {
      if (pgid) groups.push(pgid);
    },
    cleanup() {
      for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
      for (const g of groups.splice(0)) {
        try {
          killGroup(g, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      for (const l of labs.splice(0)) {
        try {
          l.close();
        } catch {
          // Read-only checkouts (review, check) refuse removal until made writable again.
          spawnSync('chmod', ['-R', 'u+w', l.base]);
          l.close();
        }
      }
    },
  };
}

/** The real controller loop in its own process, with ORBIT_FAULTS set for that process only. */
export function spawnFaultyController(lab: Lab, opts: ChildOptions & { faults?: string }): ChildProcess & { output: () => string } {
  const { faults, ...rest } = opts;
  const args = { repo: lab.repo, orbitHome: lab.orbitHome, configPath: lab.configPath, templatePath: lab.templatePath, scenarioPath: lab.scenarioPath, argvLog: lab.argvLog, ...rest };
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ORBIT_FAULTS;
  if (faults) env.ORBIT_FAULTS = faults;
  const child = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', CHILD, JSON.stringify(args)], { stdio: ['ignore', 'pipe', 'pipe'], env });
  let out = '';
  child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr?.on('data', (d: Buffer) => (out += d.toString()));
  return Object.assign(child, { output: () => out });
}

export function exited(c: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (c.exitCode !== null || c.signalCode !== null) return Promise.resolve({ code: c.exitCode, signal: c.signalCode });
  return new Promise((r) => c.once('exit', (code, signal) => r({ code, signal })));
}

/** Drive one run to a terminal state with an in-process foreground controller (a lease left by stepTo is released first). */
export async function drive(lab: Lab, runId: string, deps: Partial<ControllerDeps> = {}): Promise<void> {
  releaseLease(lab.db(), runId, 'controller-a');
  await new Controller({ mode: 'foreground', runId, deps: { ...labDeps(lab), ...deps }, tickIntervalMs: 20, leaseTtlMs: 30_000, graceMs: 300 }).start();
}

/** Step a run as `ownerId` until it reaches `state`, waiting out workers between steps. */
export async function stepTo(lab: Lab, runId: string, state: string, ownerId = 'controller-a', deps: Partial<ControllerDeps> = {}): Promise<ControllerDeps> {
  const d: ControllerDeps = { ...labDeps(lab), ...deps, ownerId };
  acquireLease(lab.db(), runId, ownerId, 3_600_000, systemClock);
  for (let i = 0; i < 1_200 && runState(lab, runId).state !== state; i++) {
    const r = await step(d, runId, new AbortController().signal);
    if (r.done && runState(lab, runId).state !== state) break;
    if (runState(lab, runId).state !== state) await sleep(25);
  }
  return d;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface EventRow {
  id: number;
  type: string;
  actor: string | null;
  from_state: string | null;
  to_state: string | null;
  data_json: string | null;
}

export function events(lab: Lab, runId: string, type?: string): EventRow[] {
  return type
    ? lab.db().all<EventRow>('SELECT id, type, actor, from_state, to_state, data_json FROM events WHERE run_id = ? AND type = ? ORDER BY id', runId, type)
    : lab.db().all<EventRow>('SELECT id, type, actor, from_state, to_state, data_json FROM events WHERE run_id = ? ORDER BY id', runId);
}

/** The run's state transitions as "FROM>TO". */
export function transitions(lab: Lab, runId: string): string[] {
  return events(lab, runId, 'state.transition').map((e) => `${e.from_state}>${e.to_state}`);
}

export interface ArgvCall {
  tool: string;
  role: string;
  call: number;
  argv: string[];
  cwd: string;
}

export function calls(lab: Lab, role?: string): ArgvCall[] {
  let text = '';
  try {
    text = readFileSync(lab.argvLog, 'utf8');
  } catch {
    return [];
  }
  const all = text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ArgvCall);
  return role ? all.filter((c) => c.role === role) : all;
}

/**
 * Every occurrence of `needle` in `prompt` sits inside an untrusted fence
 * (`~~~~text untrusted` ... `~~~~`, as adapters/prompt.ts renders them).
 * Returns the number of occurrences, and throws on one outside a fence.
 */
export function assertFencedOnly(prompt: string, needle: string): number {
  const lines = prompt.split('\n');
  let marker: string | null = null;
  let found = 0;
  for (const line of lines) {
    if (marker === null) {
      const open = /^(~{4,})text untrusted$/.exec(line);
      if (open) {
        marker = open[1]!;
        continue;
      }
      if (line.includes(needle)) throw new Error(`"${needle}" appears outside an untrusted fence: ${line.slice(0, 200)}`);
    } else {
      if (line === marker) {
        marker = null;
        continue;
      }
      if (line.includes(needle)) found++;
    }
  }
  return found;
}
