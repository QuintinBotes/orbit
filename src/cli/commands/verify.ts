/**
 * `orbit verify [run-id]`: run the independent verification for a run's latest
 * candidate and print a verdict per contract criterion with the artifacts it
 * rests on. It collects evidence with the controller's own function
 * (controller/verification.collectVerificationEvidence: a clean checkout of
 * the exact candidate tree, the frozen policy's checks, static security judged
 * under the frozen static_security policy, the evidence evaluation), so its
 * verdict matches VERIFYING's. It takes a short CLI lease so it never runs
 * beside a live controller, and never moves the run's state.
 *
 * Check results are durable and bound to the candidate and the check
 * configuration, so a check that already ran for this candidate is reported
 * from its record rather than run a second time.
 */
import { dirname, isAbsolute, join, relative } from 'node:path';
import { OrbitError } from '../../core/errors.ts';
import { inspectScope } from '../../policy/scope.ts';
import { cleanupCandidateCheckout, materializeCandidate } from '../../evidence/candidate.ts';
import type { EvidenceReport } from '../../evidence/types.ts';
import { loadRunContext, runWorktreeRoot, type RunContext } from '../../controller/context.ts';
import { listRuns, renewLease, type RunRecord } from '../../controller/run-store.ts';
import { collectVerificationEvidence } from '../../controller/verification.ts';
import type { GoalContract } from '../../contract/types.ts';
import type { Args } from '../args.ts';
import { findRunByPrefix, openState, resolveRepo, withCliLease, type CliContext } from '../context.ts';
import { EXIT } from '../exit.ts';
import { flat, json, line, oneLine } from '../io.ts';
import { cliLeaseDeps } from './control.ts';

const LEASE_TTL_MS = 10 * 60_000;
const LEASE_RENEW_MS = 20_000;

export interface VerifyOutcome {
  run: RunRecord;
  candidateSeq: number;
  candidateId: string;
  treeHash: string;
  report: EvidenceReport;
  failReasons: string[];
  incompleteReasons: string[];
}

export function exitCodeForVerdict(verdict: EvidenceReport['verdict']): number {
  return verdict === 'PASS' ? EXIT.OK : verdict === 'FAIL' ? EXIT.VERIFY_FAILED : EXIT.VERIFY_INCOMPLETE;
}

/** The newest run, or a NOT_FOUND error naming what to do. */
function newestRun(db: Parameters<typeof listRuns>[0]): RunRecord {
  const [run] = listRuns(db, { limit: 1 });
  if (!run) throw new OrbitError('NOT_FOUND', 'there are no runs to verify; start one with "orbit run --goal ..."');
  return run;
}

export async function verifyCommand(args: Args, ctx: CliContext): Promise<number> {
  const [ref] = args.expect(0, 1);
  const repo = await resolveRepo(ctx, args.str('repo'));
  const db = openState(repo);
  try {
    const run = ref ? findRunByPrefix(db, ref) : newestRun(db);
    if (!run.contractJson) throw new OrbitError('TRANSITION_INVALID', `run ${run.id} has no contract yet (it is ${run.state}); there is nothing to verify`);
    const outcome = await withCliLease(
      ctx,
      db,
      run.id,
      async (ownerId) => {
        const renew = setInterval(() => {
          try {
            renewLease(db, run.id, ownerId, LEASE_TTL_MS, ctx.clock);
          } catch {
            /* the next renewal tries again; the lease simply expires if the database stays busy */
          }
        }, LEASE_RENEW_MS);
        renew.unref();
        const abort = new AbortController();
        try {
          const rc = loadRunContext(cliLeaseDeps(ctx, repo, db, ownerId), run.id, abort.signal);
          return await verifyCandidate(rc);
        } finally {
          clearInterval(renew);
        }
      },
      LEASE_TTL_MS,
    );
    return print(ctx, repo, args.bool('json'), outcome, run.contractJson);
  } finally {
    db.close();
  }
}

/** Evidence for the run's current candidate, produced the way VERIFYING produces it, without changing the run. */
export async function verifyCandidate(rc: RunContext): Promise<VerifyOutcome> {
  const contract = rc.contract;
  const cand = rc.candidate;
  if (!contract) throw new OrbitError('TRANSITION_INVALID', `run ${rc.run.id} has no contract yet; there is nothing to verify`);
  if (!cand) throw new OrbitError('TRANSITION_INVALID', `run ${rc.run.id} has no candidate yet (it is ${rc.run.state}); verification needs a change to check`);
  if (!rc.run.baseRevision) throw new OrbitError('TRANSITION_INVALID', `run ${rc.run.id} has no base revision; preflight did not finish`);
  const snapshot = rc.snapshot;

  const scope = cand.scope ?? (await inspectScope({ repoRoot: rc.run.repoRoot, baseRev: rc.run.baseRevision, candidateRev: cand.commitSha, snapshot, contractAllowedPaths: contract.allowed_paths }));

  const checkoutDir = join(runWorktreeRoot(rc), `verify-${cand.seq}`);
  await cleanupCandidateCheckout(rc.run.repoRoot, checkoutDir).catch(() => {});
  await materializeCandidate(rc.run.repoRoot, cand.commitSha, checkoutDir, { readOnly: false });
  try {
    // The same evidence function as VERIFYING, so findings are judged under the same frozen policy.
    const collected = await collectVerificationEvidence(rc, cand, { checkoutDir, scope, exploration: false });
    if ('stopped' in collected) throw new OrbitError('INTERNAL', 'verification stopped without a checkpoint');
    const { report, failReasons, incompleteReasons } = collected.evidence;
    return { run: rc.run, candidateSeq: cand.seq, candidateId: cand.id, treeHash: cand.treeHash, report, failReasons, incompleteReasons };
  } finally {
    await cleanupCandidateCheckout(rc.run.repoRoot, checkoutDir).catch(() => {});
  }
}

function print(ctx: CliContext, repo: string, asJson: boolean, o: VerifyOutcome, contractJson: string): number {
  const contract = JSON.parse(contractJson) as GoalContract;
  const statements = new Map(contract.acceptance_criteria.map((c) => [c.id, c] as const));
  // Evidence paths are relative to the run directory (evidence/report.ts); shown relative to the repository.
  const runDir = dirname(o.run.policyPath);
  const rel = (given: string): string => {
    const p = isAbsolute(given) ? given : join(runDir, given);
    const r = relative(repo, p);
    return r.startsWith('..') || r === '' ? p : r;
  };
  const code = exitCodeForVerdict(o.report.verdict);
  if (asJson) {
    json(ctx.io, {
      run_id: o.run.id,
      candidate_id: o.candidateId,
      candidate_seq: o.candidateSeq,
      tree_hash: o.treeHash,
      verdict: o.report.verdict,
      exit_code: code,
      criteria: o.report.acceptance_evidence.map((e) => ({ id: e.criterion_id, status: e.status, mandatory: statements.get(e.criterion_id)?.mandatory ?? null, statement: statements.get(e.criterion_id)?.statement ?? null, artifacts: e.artifacts.map(rel), note: e.note ?? null })),
      checks: o.report.checks.map((c) => ({ id: c.id, status: c.status, exit_code: c.exit_code, flaky: c.flaky, log: rel(c.log) })),
      fail_reasons: o.failReasons,
      incomplete_reasons: o.incompleteReasons,
      unverified: o.report.unverified,
    });
    return code;
  }
  line(ctx.io, `run ${o.run.id}  candidate ${o.candidateSeq}  tree ${o.treeHash.slice(0, 12)}  verdict ${o.report.verdict}`);
  for (const e of o.report.acceptance_evidence) {
    const c = statements.get(e.criterion_id);
    line(ctx.io, `  ${e.criterion_id}  ${e.status.padEnd(11)}${c?.mandatory === false ? ' (optional) ' : ' '}${oneLine(c?.statement ?? '', 100)}`);
    for (const a of e.artifacts) line(ctx.io, `      evidence: ${rel(a)}`);
    if (e.note) line(ctx.io, `      note: ${flat(e.note)}`);
  }
  if (o.report.checks.length > 0) {
    line(ctx.io, 'checks:');
    for (const c of o.report.checks) line(ctx.io, `  ${c.id}  ${c.status}${c.exit_code === null ? '' : ` (exit ${c.exit_code})`}${c.flaky ? ' flaky' : ''}  ${rel(c.log)}`);
  }
  for (const r of o.failReasons) line(ctx.io, `failed: ${flat(r)}`);
  for (const r of o.incompleteReasons) line(ctx.io, `incomplete: ${flat(r)}`);
  for (const u of o.report.unverified) line(ctx.io, `unverified: ${flat(u)}`);
  if (o.report.verdict === 'FAIL') line(ctx.io, `hand the failure to a repair with: orbit repair ${o.run.id}`);
  return code;
}
