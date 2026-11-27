/**
 * Shared pieces of the spend-request scenarios (issue #254): a lab whose implementer's one session costs most of a $12
 * cap (past the $9.60 ordinary work may spend), an inbox under a temporary XDG_STATE_HOME, and the CLI in this process.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../../src/cli/cli.ts';
import { memoryIo } from '../../../src/cli/io.ts';
import { listQuestions, type QuestionRecord } from '../../../src/inquisition/store.ts';
import { argvCalls, drive, makeLab, startLabRun, writeScenario, type Lab } from './lab.ts';
import type { ControllerDeps } from '../../../src/controller/context.ts';
import type { RunRecord } from '../../../src/controller/run-store.ts';
import { GOAL, GOOD_IMPLEMENTATION, scenario } from './scenarios.ts';

const labs: Lab[] = [];
const dirs: string[] = [];

export function cleanupSpend(): void {
  for (const l of labs.splice(0)) l.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

export function tempDir(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-spend-')));
  dirs.push(d);
  return d;
}

export function costlyLab(): Lab {
  const l = makeLab({ tweak: (c) => void (c.scheduler.hard_limits.model_cost_usd = 12) });
  labs.push(l);
  writeScenario(l, scenario({ implementer: [{ ...GOOD_IMPLEMENTATION(), usage: { costUSD: 11.5 } }] }));
  return l;
}

export const inbox = (stateHome: string): string => join(stateHome, 'stack', 'inbox', 'spend');
export const inboxFiles = (stateHome: string): string[] => (existsSync(inbox(stateHome)) ? readdirSync(inbox(stateHome)) : []);
export const readInbox = (stateHome: string, name: string): Record<string, unknown> => JSON.parse(readFileSync(join(inbox(stateHome), name), 'utf8')) as Record<string, unknown>;

/** Controller deps whose inbox is under `stateHome`. */
export const inState = (stateHome: string): Partial<ControllerDeps> => ({ hostEnv: { ...process.env, XDG_STATE_HOME: stateHome } });

/** Drive a fresh costly run to its block. */
export async function blockedRun(): Promise<{ lab: Lab; run: RunRecord; stateHome: string; question: QuestionRecord }> {
  const lab = costlyLab();
  const stateHome = tempDir();
  const started = startLabRun(lab, GOAL);
  const run = await drive(lab, started.id, inState(stateHome));
  const question = listQuestions(lab.db(), run.id, { status: 'open' })[0]!;
  return { lab, run, stateHome, question };
}

export const sessions = (l: Lab): number => argvCalls(l).filter((c) => c.role !== undefined).length;

/** The command as a person would type it: the words of `orbit ...`, with the shell's single quotes removed. */
export function commandWords(command: string): string[] {
  const words = command.match(/'[^']*'|\S+/g) ?? [];
  if (words[0] !== 'orbit') throw new Error(`not an orbit command: ${command}`);
  return words.slice(1).map((w) => w.replace(/^'|'$/g, ''));
}

/** `orbit <args>` as a person's shell runs it: no worker markers in the environment. */
export async function cli(l: Lab, args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  const io = memoryIo('');
  const base: Record<string, string | undefined> = { ...process.env, ORBIT_HOME: l.orbitHome, ...env };
  for (const k of ['ORBIT_WORKER', 'ORBIT_POLICY_HASH', 'ORBIT_POLICY_PATH']) if (!(k in env)) delete base[k];
  const code = await main(args, { io, cwd: l.repo, homeDir: l.base, orbitHome: l.orbitHome, env: base, user: 'acme' });
  return { code, out: io.stdout + io.stderr };
}
