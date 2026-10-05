/**
 * `orbit verify`: the verdict printing, the exit codes and the ways a run can
 * be unfit for verification. The evidence collection itself (a clean checkout
 * of the candidate, the checks, the evaluation) is replaced here by a recorded
 * outcome; the integration suite runs it for real. What these tests check is
 * what verify does with an outcome: how it prints it and which code it exits with.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyCandidate } from '../../../src/cli/commands/verify.ts';
import { getRun } from '../../../src/controller/run-store.ts';
import { getLease } from '../../../src/controller/run-store.ts';
import type { RunContext } from '../../../src/controller/context.ts';
import type { EvidenceReport } from '../../../src/evidence/types.ts';
import { makeLab, type Lab } from './lab.ts';

const hooks = vi.hoisted(() => ({
  rc: null as null | ((runId: string) => unknown),
  collected: null as null | (() => unknown),
  scope: [] as unknown[],
  materialized: [] as string[],
  cleaned: [] as string[],
  cleanupFails: false,
  intervals: [] as Array<() => void>,
}));

vi.mock('../../../src/controller/context.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/controller/context.ts')>();
  return { ...actual, loadRunContext: (_deps: unknown, runId: string) => (hooks.rc ? hooks.rc(runId) : actual.loadRunContext(_deps as never, runId, new AbortController().signal)) } as typeof actual;
});
vi.mock('../../../src/controller/verification.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/controller/verification.ts')>();
  return { ...actual, collectVerificationEvidence: () => Promise.resolve(hooks.collected!()) } as typeof actual;
});
vi.mock('../../../src/policy/scope.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/policy/scope.ts')>();
  return { ...actual, inspectScope: (input: unknown) => (hooks.scope.push(input), Promise.resolve({ marker: 'inspected' })) } as unknown as typeof actual;
});
vi.mock('../../../src/evidence/candidate.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/evidence/candidate.ts')>();
  return {
    ...actual,
    materializeCandidate: (_repo: string, sha: string, dir: string) => (hooks.materialized.push(`${sha}@${dir}`), Promise.resolve()),
    cleanupCandidateCheckout: (_repo: string, dir: string) => {
      hooks.cleaned.push(dir);
      return hooks.cleanupFails ? Promise.reject(new Error('busy')) : Promise.resolve();
    },
  } as unknown as typeof actual;
});

const labs: Lab[] = [];
const lab = () => {
  const l = makeLab();
  labs.push(l);
  return l;
};
beforeEach(() => {
  hooks.rc = null;
  hooks.collected = null;
  hooks.scope = [];
  hooks.materialized = [];
  hooks.cleaned = [];
  hooks.cleanupFails = false;
  hooks.intervals = [];
});
afterEach(() => {
  vi.restoreAllMocks();
  labs.splice(0).forEach((l) => l.close());
});

const CONTRACT = {
  allowed_paths: ['apps/**'],
  acceptance_criteria: [
    { id: 'AC-1', statement: 'mul(a, b)   returns\nthe product', mandatory: true },
    { id: 'AC-2', statement: 'mul rounds to cents', mandatory: false },
  ],
};

function report(over: Partial<EvidenceReport> = {}): EvidenceReport {
  return {
    task_id: 't',
    run_id: 'r',
    attempt: 1,
    candidate_revision: 'a'.repeat(40),
    tree_hash: 'b'.repeat(40),
    check_config_hash: 'c',
    policy_hash: 'd',
    scope: {} as never,
    checks: [],
    ui: [],
    acceptance_evidence: [],
    verdict: 'PASS',
    unverified: [],
    ...over,
  };
}

/** A run with a contract, whose "context" is a record the test controls. */
function setup(l: Lab, opts: { scope?: unknown; outcome: { report: EvidenceReport; failReasons?: string[]; incompleteReasons?: string[] } }) {
  const run = l.newRun();
  l.db().run('UPDATE runs SET contract_json = ?, base_revision = ? WHERE id = ?', JSON.stringify(CONTRACT), 'f'.repeat(40), run.id);
  const live = getRun(l.db(), run.id);
  hooks.rc = () => ({
    run: live,
    contract: CONTRACT,
    candidate: { seq: 2, id: 'cand-2', commitSha: 'e'.repeat(40), treeHash: 'a1b2c3d4e5f6a7b8c9d0', scope: opts.scope ?? null },
    snapshot: { config: {} },
    deps: { orbitHome: l.orbitHome },
  });
  hooks.collected = () => ({ evidence: { report: opts.outcome.report, failReasons: opts.outcome.failReasons ?? [], incompleteReasons: opts.outcome.incompleteReasons ?? [] } });
  return live;
}

describe('orbit verify: printing a verdict', () => {
  it('PASS exits 0: a line per criterion with its evidence, optional ones marked, the checks, and nothing about repair', async () => {
    const l = lab();
    const run = setup(l, {
      scope: { allowed_paths_pass: true },
      outcome: {
        report: report({
          verdict: 'PASS',
          acceptance_evidence: [
            { criterion_id: 'AC-1', status: 'supported', artifacts: [join(l.repo, '.orbit', 'runs', 'x', 'unit.log'), '/elsewhere/trace.zip'], note: 'covered by   unit\ntest' },
            { criterion_id: 'AC-2', status: 'unverified', artifacts: [] },
            { criterion_id: 'AC-9', status: 'blocked', artifacts: [] },
          ],
          checks: [
            { id: 'unit', status: 'PASSED' as never, exit_code: 0, flaky: false, log: join(l.repo, '.orbit', 'runs', 'x', 'unit.log') },
            { id: 'e2e', status: 'PASSED' as never, exit_code: null, flaky: true, log: l.repo },
          ],
          unverified: ['no browser available'],
        }),
      },
    });
    const r = await l.cli(['verify', run.id]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe(
      [
        `run ${run.id}  candidate 2  tree a1b2c3d4e5f6  verdict PASS`,
        '  AC-1  supported   mul(a, b) returns the product',
        '      evidence: .orbit/runs/x/unit.log',
        '      evidence: /elsewhere/trace.zip',
        '      note: covered by unit test',
        '  AC-2  unverified  (optional) mul rounds to cents',
        '  AC-9  blocked     ',
        'checks:',
        '  unit  PASSED (exit 0)  .orbit/runs/x/unit.log',
        `  e2e  PASSED flaky  ${l.repo}`,
        'unverified: no browser available',
        '',
      ].join('\n'),
    );
    // The scope the candidate already carries is used as it is, and the checkout is removed again.
    expect(hooks.scope).toEqual([]);
    expect(hooks.materialized).toHaveLength(1);
    expect(hooks.materialized[0]).toMatch(/^e{40}@.*verify-2$/);
    expect(hooks.cleaned.length).toBe(2);
    expect(getLease(l.db(), run.id)).toBeNull();
    expect(getRun(l.db(), run.id).state).toBe('CREATED');
  });

  it('FAIL exits 14 and points to repair; INCOMPLETE exits 15 and lists what is missing', async () => {
    const l = lab();
    const run = setup(l, { outcome: { report: report({ verdict: 'FAIL' }), failReasons: ['check unit failed   with\nexit 1'], incompleteReasons: [] } });
    const fail = await l.cli(['verify']);
    expect(fail.code).toBe(14);
    expect(fail.out).toContain('failed: check unit failed with exit 1\n');
    expect(fail.out.endsWith(`hand the failure to a repair with: orbit repair ${run.id}\n`)).toBe(true);
    expect(fail.out).not.toContain('checks:');

    setup(l, { outcome: { report: report({ verdict: 'INCOMPLETE' }), incompleteReasons: ['AC-1 has no evidence'] } });
    const inc = await l.cli(['verify', run.id]);
    expect(inc.code).toBe(15);
    expect(inc.out).toContain('incomplete: AC-1 has no evidence\n');
    expect(inc.out).not.toContain('hand the failure');
  });

  it('with --json prints the verdict, the exit code and per-criterion and per-check records', async () => {
    const l = lab();
    const run = setup(l, {
      outcome: {
        report: report({
          verdict: 'FAIL',
          acceptance_evidence: [
            { criterion_id: 'AC-1', status: 'unsupported', artifacts: [join(l.repo, 'out.log')], note: 'failed' },
            { criterion_id: 'AC-9', status: 'blocked', artifacts: [] },
          ],
          checks: [{ id: 'unit', status: 'FAILED' as never, exit_code: 1, flaky: false, log: join(l.repo, 'out.log') }],
          unverified: ['u'],
        }),
        failReasons: ['f1'],
        incompleteReasons: ['i1'],
      },
    });
    const r = await l.cli(['verify', run.id, '--json']);
    expect(r.code).toBe(14);
    expect(JSON.parse(r.out)).toMatchObject({
      run_id: run.id,
      candidate_id: 'cand-2',
      candidate_seq: 2,
      tree_hash: 'a1b2c3d4e5f6a7b8c9d0',
      verdict: 'FAIL',
      exit_code: 14,
      criteria: [
        { id: 'AC-1', status: 'unsupported', mandatory: true, statement: 'mul(a, b)   returns\nthe product', artifacts: ['out.log'], note: 'failed' },
        { id: 'AC-9', status: 'blocked', mandatory: null, statement: null, artifacts: [] },
      ],
      checks: [{ id: 'unit', status: 'FAILED', exit_code: 1, flaky: false, log: 'out.log' }],
      fail_reasons: ['f1'],
      incomplete_reasons: ['i1'],
      unverified: ['u'],
    });
  });

  it('inspects the candidate\'s scope itself when the candidate carries none', async () => {
    const l = lab();
    setup(l, { scope: null, outcome: { report: report() } });
    const r = await l.cli(['verify']);
    expect(r.code, r.err).toBe(0);
    expect(hooks.scope).toEqual([expect.objectContaining({ baseRev: 'f'.repeat(40), candidateRev: 'e'.repeat(40), contractAllowedPaths: ['apps/**'] })]);
  });

  it('removes the checkout even when cleaning it up fails, and says so when verification stopped', async () => {
    const l = lab();
    setup(l, { outcome: { report: report() } });
    hooks.cleanupFails = true;
    expect((await l.cli(['verify'])).code).toBe(0);
    expect(hooks.cleaned).toHaveLength(2);
    hooks.collected = () => ({ stopped: true });
    const stopped = await l.cli(['verify']);
    expect(stopped.code).toBe(1);
    expect(stopped.err).toBe('orbit: verification stopped without a checkpoint\n');
    expect(hooks.cleaned).toHaveLength(4);
    expect(getLease(l.db(), getRun(l.db(), (await l.db().all<{ id: string }>('SELECT id FROM runs'))[0]!.id).id)).toBeNull();
  });

  it('renews its lease while it works, and a renewal that fails is not an error', async () => {
    const l = lab();
    const real = globalThis.setInterval;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms: number) => {
      hooks.intervals.push(fn);
      return real(() => {}, 1_000_000);
    }) as typeof setInterval);
    const run = setup(l, { outcome: { report: report() } });
    hooks.collected = () => {
      // Called while the lease is held and the database is open.
      for (const f of hooks.intervals) f();
      return { evidence: { report: report(), failReasons: [], incompleteReasons: [] } };
    };
    expect((await l.cli(['verify', run.id])).code).toBe(0);
    expect(hooks.intervals).toHaveLength(1);
    // After the command the database is closed: the renewal throws, and is swallowed.
    expect(() => hooks.intervals[0]!()).not.toThrow();
  });
});

describe('verifyCandidate: a run that is not ready', () => {
  const rc = (over: Record<string, unknown>) => ({ run: { id: 'orb-x', state: 'IMPLEMENTING', baseRevision: 'f'.repeat(40), repoRoot: '/r' }, contract: CONTRACT, candidate: { seq: 1 }, snapshot: {}, deps: { orbitHome: '/h' }, ...over }) as unknown as RunContext;

  it('says what is missing: a contract, a candidate, or a base revision', async () => {
    await expect(verifyCandidate(rc({ contract: null }))).rejects.toMatchObject({ code: 'TRANSITION_INVALID', message: 'run orb-x has no contract yet; there is nothing to verify' });
    await expect(verifyCandidate(rc({ candidate: null }))).rejects.toMatchObject({ code: 'TRANSITION_INVALID', message: 'run orb-x has no candidate yet (it is IMPLEMENTING); verification needs a change to check' });
    await expect(verifyCandidate(rc({ run: { id: 'orb-x', state: 'PREFLIGHT', baseRevision: null, repoRoot: '/r' } }))).rejects.toMatchObject({ code: 'TRANSITION_INVALID', message: 'run orb-x has no base revision; preflight did not finish' });
    expect(hooks.materialized).toEqual([]);
  });

  it('through the command, a run without a candidate is refused with the same words and leaves no lease behind', async () => {
    const l = lab();
    const run = l.newRun();
    l.db().run("UPDATE runs SET contract_json = '{}' WHERE id = ?", run.id);
    hooks.rc = () => ({ run: getRun(l.db(), run.id), contract: CONTRACT, candidate: null, snapshot: {}, deps: { orbitHome: l.orbitHome } });
    mkdirSync(l.orbitHome, { recursive: true });
    const r = await l.cli(['verify', run.id]);
    expect(r.code).toBe(5);
    expect(r.err).toContain('has no candidate yet (it is CREATED)');
    expect(getLease(l.db(), run.id)).toBeNull();
  });
});
