// `orbit retro` under faults (issue #174, AC-3): a draft that cannot be written, a question that fails, a gh that fails
// after a yes, and run records holding garbage. In every case nothing is sent that the person did not approve, nothing
// is recorded as sent that was not, and what reaches a draft or the screen is still redacted.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCommand } from '../../src/cli/args.ts';
import { createContext } from '../../src/cli/context.ts';
import { memoryIo } from '../../src/cli/io.ts';
import { ghSend, RETRO_OPTIONS, RETRO_USAGE, runRetro, type RetroDeps } from '../../src/cli/commands/retro.ts';
import { stateDbPath } from '../../src/controller/start.ts';
import { findDecision, listDecisions } from '../../src/observability/retro.ts';
import { openDb } from '../../src/storage/db.ts';
import { makeSandbox, type Sandbox } from '../integration/cli/helpers.ts';
import { DEADLOCK_OUTCOME, seedRuns, writeFakeGh } from '../support/retro-runs.ts';

const boxes: Sandbox[] = [];
const sandbox = (): Sandbox => {
  const s = makeSandbox();
  boxes.push(s);
  seedRuns(s.repo, [{ id: 'orb-dead-1', state: 'BLOCKED', outcome: DEADLOCK_OUTCOME }]);
  return s;
};
afterEach(() => boxes.splice(0).forEach((s) => s.close()));

const KEY = 'issue-draft:gate-deadlock:blocked_criteria+questions';
const SECRET = 'sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ';
const draftDir = (s: Sandbox): string => join(s.repo, '.orbit', 'runs', 'retro-drafts');
const gh = (s: Sandbox): string => join(s.base, 'gh.log');
const ghCalls = (s: Sandbox): string => (existsSync(gh(s)) ? readFileSync(gh(s), 'utf8') : '');

const decision = (s: Sandbox) => {
  const db = openDb(stateDbPath(s.repo));
  try {
    return findDecision(db, KEY);
  } finally {
    db.close();
  }
};

/** The command in this process, with `deps` standing for the person and, when given, the real gh sender. */
async function retro(s: Sandbox, deps: RetroDeps, argv: string[] = []): Promise<{ code: number; out: string }> {
  const io = memoryIo();
  const ctx = createContext({ io, cwd: s.repo, homeDir: s.home, orbitHome: s.orbitHome, env: { PATH: s.env().PATH, HOME: s.home }, user: 'alice' });
  const code = await runRetro(parseCommand(argv, RETRO_OPTIONS, RETRO_USAGE), ctx, deps);
  return { code, out: io.stdout };
}

function yes(s: Sandbox): RetroDeps & { asked: string[] } {
  const ctx = createContext({ env: { PATH: s.env().PATH, HOME: s.home } });
  const f = { asked: [] as string[], ask: async (q: string): Promise<boolean | null> => (f.asked.push(q), true), send: ghSend(ctx) };
  return f;
}

describe('fault: the draft cannot be written', () => {
  it('reports the error, asks no one, sends nothing, records nothing, and proposes the draft once the obstruction is gone', async () => {
    const s = sandbox();
    writeFakeGh(s.tools, gh(s));
    // A regular file stands where the drafts directory must be.
    mkdirSync(join(s.repo, '.orbit', 'runs'), { recursive: true });
    writeFileSync(draftDir(s), 'in the way');

    const deps = yes(s);
    await expect(retro(s, deps)).rejects.toThrow();
    expect(deps.asked).toEqual([]);
    expect(ghCalls(s)).toBe('');
    expect(decision(s)).toBeNull();

    // The same through the CLI: a non-zero exit and an error on stderr, no gh call, no stack trace of the host.
    const cli = await s.run(['retro']);
    expect(cli.code).not.toBe(0);
    expect(cli.stderr).toMatch(/orbit/);
    expect(cli.stderr).not.toContain(s.base);
    expect(ghCalls(s)).toBe('');

    // Nothing was lost: with the obstruction removed, the proposal is made.
    const { rmSync } = await import('node:fs');
    rmSync(draftDir(s));
    const ok = await s.run(['retro']);
    expect(ok.code, ok.stderr).toBe(0);
    expect(ok.stdout).toContain('1 proposal(s)');
    expect(readdirSync(draftDir(s))).toHaveLength(1);
    expect(decision(s)?.decision).toBe('drafted');
    expect(ghCalls(s)).toBe('');
  });
});

describe('fault: the question fails', () => {
  it('a question that throws sends nothing, and leaves the draft recorded as a draft, not as sent', async () => {
    const s = sandbox();
    writeFakeGh(s.tools, gh(s));
    const deps: RetroDeps = {
      ask: async () => {
        throw new Error('the terminal went away');
      },
      send: ghSend(createContext({ env: { PATH: s.env().PATH, HOME: s.home } })),
    };
    await expect(retro(s, deps)).rejects.toThrow('the terminal went away');
    expect(ghCalls(s)).toBe('');
    expect(decision(s)?.decision).toBe('drafted');
    expect(readdirSync(draftDir(s))).toHaveLength(1);
    // The person never answered, so the next retro asks again; a no then ends it, and still nothing was sent.
    const no: RetroDeps = { ask: async () => false, send: deps.send };
    const again = await retro(s, no);
    expect(again.out).toContain('declined: nothing was sent');
    expect(decision(s)?.decision).toBe('declined');
    expect(ghCalls(s)).toBe('');
  });
});

describe('fault: gh fails after a yes', () => {
  it('keeps the draft, exits non-zero, shows the error without paths or secrets, and does not record the issue as sent', async () => {
    const s = sandbox();
    writeFakeGh(s.tools, gh(s), { fail: `gh: HTTP 401 for ${s.repo}/x with ${SECRET}` });
    const deps = yes(s);
    const r = await retro(s, deps);
    expect(r.code).toBe(1);
    expect(deps.asked).toHaveLength(1);
    expect(ghCalls(s)).toContain('issue');
    expect(r.out).toContain('not sent:');
    for (const forbidden of [s.repo, s.base, SECRET]) expect(r.out, forbidden).not.toContain(forbidden);
    expect(decision(s)).toMatchObject({ decision: 'drafted', decidedBy: null });
    expect(readdirSync(draftDir(s))).toHaveLength(1);
  });

  it('a gh that is not installed is the same failure, not a crash', async () => {
    const s = sandbox();
    const deps = yes(s);
    const r = await retro(s, deps);
    expect(r.code).toBe(1);
    expect(r.out).toContain('not sent:');
    expect(decision(s)?.decision).toBe('drafted');
  });
});

describe('fault: run records hold garbage', () => {
  it('a corrupt outcome, a version that is a path and a secret-like second class never reach the draft, and the draft is still made', async () => {
    const s = sandbox();
    const db = openDb(stateDbPath(s.repo));
    try {
      db.run('UPDATE runs SET outcome_json = ?, orbit_version = ?, failure_secondary = ? WHERE id = ?', `{"questions": [ ${SECRET}`, `${s.repo}/secret`, `${s.repo}/${SECRET}`, 'orb-dead-1');
    } finally {
      db.close();
    }
    const r = await s.run(['retro']);
    expect(r.code, r.stderr).toBe(0);
    const draft = readFileSync(join(draftDir(s), readdirSync(draftDir(s))[0]!), 'utf8');
    expect(draft).toContain('orb-dead-1');
    expect(draft).toContain('gate-deadlock');
    expect(draft).toContain('unknown');
    for (const forbidden of [s.base, s.repo, SECRET, 'secret']) {
      expect(draft, forbidden).not.toContain(forbidden);
      expect(r.stdout, forbidden).not.toContain(forbidden);
    }
    const db2 = openDb(stateDbPath(s.repo));
    try {
      expect(listDecisions(db2).map((d) => d.decision)).toEqual(['drafted']);
    } finally {
      db2.close();
    }
  });
});
