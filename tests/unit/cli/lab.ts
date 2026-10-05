/** Shared by the in-process CLI tests: a throwaway git repository, runs written through the real controller modules, and a captured `main`. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../../src/cli/cli.ts';
import { memoryIo } from '../../../src/cli/io.ts';
import type { CliContext } from '../../../src/cli/context.ts';
import { systemClock } from '../../../src/core/clock.ts';
import { openDb, type OrbitDb } from '../../../src/storage/db.ts';
import { defaultConfig } from '../../../src/policy/config.ts';
import { startRun, stateDbPath } from '../../../src/controller/start.ts';
import { acquireLease, releaseLease, transition, type RunRecord } from '../../../src/controller/run-store.ts';
import type { RunState } from '../../../src/controller/states.ts';
import { insertQuestion, type QuestionRecord } from '../../../src/inquisition/store.ts';

const GIT_ENV = { GIT_AUTHOR_NAME: 'acme', GIT_AUTHOR_EMAIL: 'dev@acme.test', GIT_COMMITTER_NAME: 'acme', GIT_COMMITTER_EMAIL: 'dev@acme.test', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

export interface Lab {
  base: string;
  repo: string;
  home: string;
  orbitHome: string;
  db(): OrbitDb;
  cli(argv: string[], over?: Partial<CliContext>, stdin?: string): Promise<{ code: number; out: string; err: string }>;
  newRun(goal?: string, runId?: string): RunRecord;
  /** Walk a run through legal transitions under a short-lived lease, as a controller would. */
  moveTo(runId: string, states: RunState[], reason?: string): RunRecord;
  ask(runId: string, over?: Partial<Parameters<typeof insertQuestion>[1]>): QuestionRecord;
  close(): void;
}

export function makeLab(opts: { git?: boolean } = {}): Lab {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-cli-unit-')));
  const repo = join(base, 'repo');
  const home = join(base, 'home');
  mkdirSync(repo, { recursive: true });
  mkdirSync(home, { recursive: true });
  if (opts.git !== false) {
    const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, env: { ...process.env, ...GIT_ENV }, stdio: 'pipe' });
    g('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), '# acme\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'base');
  }
  let db: OrbitDb | null = null;
  const lab: Lab = {
    base,
    repo,
    home,
    orbitHome: join(home, '.orbit'),
    db() {
      db ??= openDb(stateDbPath(repo));
      return db;
    },
    async cli(argv, over = {}, stdin = '') {
      const io = memoryIo(stdin);
      const code = await main(argv, { io, cwd: repo, homeDir: home, orbitHome: join(home, '.orbit'), env: { ...process.env, ...GIT_ENV, HOME: home, ORBIT_HOME: join(home, '.orbit') }, user: 'alice', ...over });
      return { code, out: io.stdout, err: io.stderr };
    },
    newRun(goal = 'Add a mul function to the calculator.', runId) {
      return startRun({ db: lab.db(), repoRoot: repo, goal, config: defaultConfig('autonomous'), clock: systemClock, ...(runId ? { runId } : {}) });
    },
    moveTo(runId, states, reason = 'test') {
      const d = lab.db();
      const owner = 'test-controller';
      acquireLease(d, runId, owner, 60_000, systemClock);
      try {
        let last!: RunRecord;
        for (const to of states) last = transition(d, { runId, to, ownerId: owner, reason, actor: owner, ...(to === 'BLOCKED' ? { patch: { outcomeReason: 'waiting for a decision' } } : {}) }, systemClock);
        return last;
      } finally {
        releaseLease(d, runId, owner);
      }
    },
    ask(runId, over = {}) {
      return insertQuestion(
        lab.db(),
        {
          runId,
          mode: 'clarify',
          question: 'Should mul round its result?',
          evidence: ['apps/calc.mjs:1'],
          options: [
            { label: 'A', description: 'return the exact product', consequences: 'no rounding surprises' },
            { label: 'B', description: 'round to two decimals', consequences: 'matches money formatting' },
          ],
          changes: ['implementation'],
          recommendation: { option: 'A', reason: 'simplest' },
          safeDefault: { exists: true, option: 'A', reason: 'reversible' },
          material: true,
          affected: ['AC-1'],
          unblocked: [],
          ...over,
        },
        systemClock,
      );
    },
    close() {
      db?.close();
      db = null;
      rmSync(base, { recursive: true, force: true });
    },
  };
  return lab;
}
