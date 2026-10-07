/**
 * Baseline exceptions from a person's decision (spec section 6, "Preflight": "do not label a run green if
 * mandatory checks still fail, unless the contract explicitly accepts a documented baseline exception").
 *
 * Raised at PREFLIGHT. A mandatory check that already fails on the base revision becomes a persisted decision
 * question, and a `baseline.exception-request` decision carries what approving it means: the
 * `accept_baseline_failure` amendment proposal (contract/amend.ts `baselineExceptionProposal`) bound to the check's
 * recorded failure fingerprint. Nothing is excepted by asking.
 *
 * Applied when a person answers (`orbit decide` -> questions.ts `answerQuestion`) or, when the contract did not
 * exist yet at that moment, at the next controller step that calls `applyBaselineExceptionAnswers`. Only an answer
 * of "Approve" from a human applies it, through `applyAmendment` with the baseline report's failures, so the
 * fingerprint must equal the one recorded on the base revision and the policy's rules hold. The applied amendment
 * is recorded with the contract hashes around it, and the run's contract is rewritten, so the evidence report
 * (evidence/report.ts) honours the exception, and only while the check fails with exactly that fingerprint.
 *
 * Only a failure of the repository's code can be excepted. A check that never tested it (one the environment stopped,
 * a misconfigured one whose tool rejected its command, or one whose command names something that does not exist on the
 * base revision) is refused whoever approves it and however (`orbit decide`, a remote answer):
 * docs/decisions/0010-base-failure-classification.md.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';
import type { Clock } from '../core/clock.ts';
import { isOrbitError, OrbitError } from '../core/errors.ts';
import { atomicWriteJson, readJsonIfExists } from '../core/fsx.ts';
import { canonicalJson, hashObject } from '../core/hash.ts';
import { redact } from '../core/redact.ts';
import { invalidateEvidence } from '../evidence/freshness.ts';
import { applyAmendment, assessAmendment, baselineExceptionProposal } from '../contract/amend.ts';
import type { HumanAmendmentProposal } from '../contract/amendment-types.ts';
import type { ContractAmendment, GoalContract } from '../contract/types.ts';
import { verifySnapshot } from '../policy/snapshot.ts';
import type { PolicySnapshot } from '../policy/types.ts';
import type { BaselineReport } from '../evidence/baseline.ts';
import { classifyMisconfigured, classifyProgramNotFound } from '../evidence/check-misconfigured.ts';
import { classifyCouldNotRun, classifyNotExecuted, type EnvironmentSignal } from '../evidence/environment-failure.ts';
import { listCheckRuns } from '../evidence/store.ts';
import type { OrbitDb } from '../storage/db.ts';
import { getDecision, listDecisions, recordDecision, type DecisionRecord } from '../storage/decisions.ts';
import { appendEvent } from '../storage/events.ts';
import { answerDecisionId, ANSWER_DECISION_KIND, isHumanActor } from './actors.ts';
import { amendmentHistory, findQuestion, insertAmendment, insertQuestion, listAmendments, type QuestionRecord } from './store.ts';

export const BASELINE_EXCEPTION_REQUEST_KIND = 'baseline.exception-request';
export const BASELINE_APPROVE = 'Approve';
export const BASELINE_REJECT = 'Reject';
/** Where the baseline report is kept in a run directory (evidence/baseline.ts BASELINE_FILE). */
const BASELINE_FILE = 'baseline.json';

export interface BaselineExceptionRequest {
  question_id: string;
  check_id: string;
  fingerprint: string;
  base_revision: string;
  proposal: HumanAmendmentProposal;
}

export interface BaselineFailureInput {
  checkId: string;
  fingerprint: string | null;
  excerpt: string | null;
}

interface RunScope {
  db: OrbitDb;
  clock: Clock;
  runId: string;
  runDir: string;
}

function keyOf(runId: string, checkId: string, fingerprint: string): string {
  return hashObject({ run: runId, check: checkId, fingerprint }).slice(7, 19);
}

export function baselineQuestionId(runId: string, checkId: string, fingerprint: string): string {
  return `q-baseline-${keyOf(runId, checkId, fingerprint)}`;
}

function requestDecisionId(runId: string, checkId: string, fingerprint: string): string {
  return `dec-${runId}-baseline-exception-${keyOf(runId, checkId, fingerprint)}`;
}

export interface RaisedBaselineQuestions {
  raised: { question: QuestionRecord; request: DecisionRecord }[];
  /** Failures that cannot be excepted, with why (a failure with no fingerprint cannot be told from a different breakage). */
  skipped: { checkId: string; why: string }[];
}

/**
 * One decision question per pre-existing failure, each with its request decision. Idempotent: ids derive from the
 * run, the check and the fingerprint, so a restarted PREFLIGHT finds what it already raised. The question is not
 * material: it blocks no criterion, because the run goes on under the normal rules (an unexcepted failing check
 * keeps the evidence failing) until a person decides.
 */
export function raiseBaselineExceptionQuestions(ctx: RunScope, input: { failures: readonly BaselineFailureInput[]; baseRevision: string }): RaisedBaselineQuestions {
  const out: RaisedBaselineQuestions = { raised: [], skipped: [] };
  const rev = input.baseRevision.slice(0, 12);
  for (const f of input.failures) {
    if (f.fingerprint === null || f.fingerprint.trim() === '') {
      out.skipped.push({ checkId: f.checkId, why: 'it failed without a fingerprint, so a later failure of the same check could not be told apart from it' });
      continue;
    }
    const fingerprint = f.fingerprint;
    const excerpt = f.excerpt === null ? null : redact(f.excerpt);
    const proposal = baselineExceptionProposal({ checkId: f.checkId, fingerprint, excerpt });
    const qid = baselineQuestionId(ctx.runId, f.checkId, fingerprint);
    const question =
      findQuestion(ctx.db, qid) ??
      insertQuestion(
        ctx.db,
        {
          id: qid,
          runId: ctx.runId,
          mode: 'decision-record',
          question: `Check ${f.checkId} already fails on the base revision ${rev}; should that failure be accepted as a documented baseline exception for this run?`,
          evidence: [proposal.evidence, `Fingerprint of the recorded failure: ${fingerprint}.`],
          options: [
            {
              label: BASELINE_APPROVE,
              description: `Record a baseline exception for check ${f.checkId}: it may keep failing with fingerprint ${fingerprint} and the run can still be green.`,
              consequences: `The contract gains a baseline exception bound to that fingerprint and the report lists it as accepted. A different failure of ${f.checkId} is still a failure.`,
            },
            {
              label: BASELINE_REJECT,
              description: `Do not accept it: check ${f.checkId} must pass for the run to be green.`,
              consequences: 'The run goes on under the normal rules; unless the change makes the check pass, the evidence stays failing and the run cannot succeed.',
            },
          ],
          changes: ['proof'],
          recommendation: { option: BASELINE_REJECT, reason: 'accepting a failing mandatory check changes what green means, so only a person should decide it' },
          safeDefault: { exists: true, option: BASELINE_REJECT, reason: 'leaving the check mandatory is the stricter reading and loses nothing but time' },
          material: false,
          affected: [`check:${f.checkId}`],
          unblocked: [],
        },
        ctx.clock,
        'controller',
      );
    const data: BaselineExceptionRequest = { question_id: qid, check_id: f.checkId, fingerprint, base_revision: input.baseRevision, proposal };
    const request = recordDecision(
      ctx.db,
      ctx.runDir,
      {
        id: requestDecisionId(ctx.runId, f.checkId, fingerprint),
        runId: ctx.runId,
        kind: BASELINE_EXCEPTION_REQUEST_KIND,
        summary: `baseline exception requested for check ${f.checkId} (fingerprint ${fingerprint}); applies only if a person approves question ${qid}`,
        data,
      },
      ctx.clock,
      { actor: 'controller' },
    );
    out.raised.push({ question, request });
  }
  return out;
}

export type BaselineApplyStatus =
  /** The contract now carries the exception. */
  | 'applied'
  | 'already-applied'
  /** Nobody has answered yet. */
  | 'unanswered'
  /** Answered, but not with "Approve" (or not by a person): nothing is excepted. */
  | 'declined'
  /** Approved, but the amendment could not apply (fingerprint, policy or check mismatch); recorded as rejected. */
  | 'refused'
  /** Approved before the run had a contract; a later call applies it. */
  | 'deferred';

export interface BaselineApplyOutcome {
  questionId: string;
  checkId: string;
  status: BaselineApplyStatus;
  detail: string | null;
}

export interface AppliedBaselineAnswers {
  /** The run's contract after applying; null when the run has none yet. */
  contract: GoalContract | null;
  outcomes: BaselineApplyOutcome[];
}

interface RunRow {
  contract_json: string | null;
  contract_hash: string | null;
  policy_path: string;
  policy_hash: string;
}

const MAX_CAS_ATTEMPTS = 4;

/** Log bytes read at most to judge a baseline failure; the classifier stops scanning long before. */
const MAX_LOG_BYTES = 4 * 1024 * 1024;

function logOf(path: string | undefined): string | null {
  if (!path) return null;
  try {
    return readFileSync(path, 'utf8').slice(0, MAX_LOG_BYTES);
  } catch {
    return null;
  }
}

/** The environment signals read from a denial on a path, which only the check's own directories tell from the code's. */
const ON_A_PATH: ReadonlySet<EnvironmentSignal> = new Set<EnvironmentSignal>(['filesystem-denied', 'permission-denied', 'sandbox-violation']);

/**
 * Why the failure of `checkId` recorded on the base revision may not be accepted as a baseline exception, or null when
 * it may (docs/decisions/0010-base-failure-classification.md). PREFLIGHT blocks on a failure it classifies as an
 * environment failure or a misconfigured check and raises no question for it; it does ask about a missing target, so
 * that the contract can expect it to flip, but that is no exception either: a check whose target does not exist tests
 * nothing, and accepting its failure would make a meaningless check green. This is the guard behind all three, for a
 * question raised before the classification existed and for a baseline PREFLIGHT marked. A usage error and a program
 * that was not found are read again from the recorded log, the exit code and the command in the frozen policy, since
 * that needs no other context; so is a check the environment stopped before it ran anything of the repository
 * (classifyNotExecuted, classifyCouldNotRun), with the checkout and cwd of its recorded run (`recordedCwd`) as its own
 * directories. Without a recorded run a denial on a path is not read, since it may be inside the checkout.
 */
function notExceptable(baseline: BaselineReport, checkId: string, snapshot: PolicySnapshot, recordedCwd: string | null = null): string | null {
  const failure = (baseline.failures ?? []).find((f) => f.checkId === checkId);
  const def = snapshot.config.checks[checkId];
  const entry = (baseline.checks ?? []).find((c) => c.checkId === checkId);
  const input = def && def.kind === 'command' && entry ? { checkId, command: def.command, shell: def.shell, exitCode: entry.exitCode, output: logOf(entry.log) ?? failure?.excerpt ?? '' } : null;
  const stopped = (): boolean => {
    if (input === null) return false;
    if (classifyProgramNotFound(input) !== null || classifyNotExecuted({ checkId, output: input.output }) !== null) return true;
    const cwd = recordedCwd !== null ? normalize(recordedCwd) : null;
    const rel = def && def.kind === 'command' ? normalize(def.cwd ?? '.') : '.';
    const checkout = cwd !== null && rel !== '.' && cwd.endsWith(`${sep}${rel}`) ? cwd.slice(0, -(rel.length + 1)) : cwd;
    const roots = [...(checkout !== null ? [checkout] : []), ...(cwd !== null ? [cwd] : []), dirname(entry!.log)];
    const found = classifyCouldNotRun({ checkId, output: input.output, insideRoots: roots });
    return found !== null && (cwd !== null || !found.signals.some((sg) => ON_A_PATH.has(sg)));
  };
  if (failure?.classification === 'environment' || stopped()) {
    return `check ${checkId} could not run on the base revision: PREFLIGHT found an environment cause, not a pre-existing failure, so its failure cannot be accepted as a baseline exception (a check that never ran would let a run pass)`;
  }
  const found = input !== null ? classifyMisconfigured(input) : null;
  const evidence = found ? `: ${found.cause} (${JSON.stringify(found.lines[0])})` : '';
  if (failure?.classification === 'missing-target' || found?.kind === 'missing-target') {
    return `check ${checkId} names something that does not exist on the base revision${evidence}, so its failure cannot be accepted as a baseline exception: a check whose target does not exist tests nothing, and accepting its failure would make a meaningless check green. If the goal creates it, the contract names the check as the proof of a criterion and expects it to flip; otherwise start a new run, after installing or restoring it when a tool that is not there yet provides it (a cargo plugin, a dotnet local tool, a pytest plugin), or after correcting checks.${checkId}.command in .orbit/config.yaml when the command is wrong`;
  }
  if (failure?.classification !== 'misconfigured' && found === null) return null;
  return `check ${checkId} is misconfigured on the base revision${evidence}, so its failure cannot be accepted as a baseline exception: a check whose command is wrong never tested anything. Correct checks.${checkId}.command in .orbit/config.yaml and start a new run`;
}

/**
 * Apply every approved baseline-exception answer to the run's contract (all of them, or the one `questionId`).
 * Idempotent: an exception already applied, or refused, is not applied again. Never throws for a refused
 * amendment (that is an outcome, recorded as a rejected amendment); a missing run or unreadable state does throw.
 */
export function applyBaselineExceptionAnswers(ctx: RunScope, opts: { questionId?: string; snapshot?: PolicySnapshot } = {}): AppliedBaselineAnswers {
  const requests = listDecisions(ctx.db, ctx.runId, { kind: BASELINE_EXCEPTION_REQUEST_KIND })
    .map((d) => ({ decision: d, data: d.data as BaselineExceptionRequest }))
    .filter((r) => opts.questionId === undefined || r.data.question_id === opts.questionId);
  const outcomes: BaselineApplyOutcome[] = [];
  const load = (): RunRow => {
    const row = ctx.db.get<RunRow>('SELECT contract_json, contract_hash, policy_path, policy_hash FROM runs WHERE id = ?', ctx.runId);
    if (!row) throw new OrbitError('NOT_FOUND', `no run ${ctx.runId}`);
    return row;
  };

  for (const { data } of requests) {
    const outcome = (status: BaselineApplyStatus, detail: string | null = null): void => {
      outcomes.push({ questionId: data.question_id, checkId: data.check_id, status, detail });
    };
    const q = findQuestion(ctx.db, data.question_id);
    if (!q || q.status !== 'answered') {
      outcome('unanswered');
      continue;
    }
    const answerId = answerDecisionId(q.id);
    const answer = getDecision(ctx.db, answerId);
    const answeredBy = (answer?.data as { answered_by?: unknown } | undefined)?.answered_by;
    if (!answer || answer.kind !== ANSWER_DECISION_KIND || answer.runId !== ctx.runId || typeof answeredBy !== 'string' || !isHumanActor(answeredBy)) {
      outcome('declined', 'the answer is not a recorded decision by a person');
      continue;
    }
    if (q.answer !== BASELINE_APPROVE) {
      outcome('declined', q.answer === BASELINE_REJECT ? 'a person rejected the exception' : 'the answer is not "Approve", so nothing is excepted');
      continue;
    }

    const canonical = canonicalJson(data.proposal.change);
    const prior = listAmendments(ctx.db, ctx.runId).filter((a) => a.change !== null && canonicalJson(a.change) === canonical);
    if (prior.some((a) => a.status === 'applied')) {
      outcome('already-applied');
      continue;
    }
    if (prior.some((a) => a.status === 'rejected')) {
      outcome('refused', 'an earlier attempt was refused; see the rejected amendment');
      continue;
    }

    let applied = false;
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS && !applied; attempt++) {
      const row = load();
      if (row.contract_json === null) {
        outcome('deferred', 'the run has no contract yet');
        break;
      }
      const current = JSON.parse(row.contract_json) as GoalContract;
      let snapshot: PolicySnapshot;
      try {
        snapshot = opts.snapshot ?? verifySnapshot(row.policy_path, row.policy_hash);
      } catch (err) {
        outcome('refused', `the policy snapshot could not be verified: ${err instanceof Error ? err.message : String(err)}`);
        break;
      }
      const baseline = readJsonIfExists<BaselineReport>(join(ctx.runDir, BASELINE_FILE));
      const proposal = data.proposal;
      let next: GoalContract;
      let record: ContractAmendment;
      try {
        // Never for a check that tested nothing (ADR 0010), whoever approves it and however (orbit decide, a remote answer).
        const recorded = listCheckRuns(ctx.db, { runId: ctx.runId, candidateId: null, checkId: data.check_id, rootsOnly: true }).at(-1);
        const never = baseline ? notExceptable(baseline, data.check_id, snapshot, recorded?.cwd ?? null) : null;
        if (never !== null) throw new OrbitError('POLICY_DENIED', never, { checkId: data.check_id });
        const res = applyAmendment(current, proposal, {
          snapshot,
          approvedBy: answerId,
          policyHash: row.policy_hash,
          history: amendmentHistory(ctx.db, ctx.runId),
          ...(baseline ? { baselineFailures: baseline.failures.map((f) => ({ checkId: f.checkId, fingerprint: f.fingerprint })) } : {}),
        });
        next = res.contract;
        record = res.record;
      } catch (err) {
        if (!isOrbitError(err)) throw err;
        if (/does not alter the contract/.test(err.message)) {
          outcome('already-applied', 'the contract already carries this exception');
          break;
        }
        let rejected: ContractAmendment;
        try {
          rejected = assessAmendment(current, proposal, { snapshot, baselineFailures: baseline?.failures.map((f) => ({ checkId: f.checkId, fingerprint: f.fingerprint })) }).record;
        } catch {
          rejected = { field: 'baseline_exceptions', old_value: null, new_value: null, evidence: proposal.evidence, reason: proposal.reason, approval_required: true, affected_verification: [`check:${data.check_id}`] };
        }
        insertAmendment(ctx.db, { runId: ctx.runId, record: rejected, change: proposal.change, status: 'rejected', approvedBy: answerId, note: err.message }, ctx.clock, 'controller');
        outcome('refused', err.message);
        break;
      }
      const before = hashObject(current);
      const after = hashObject(next);
      // The amendment row and the run's contract change together, and only if nobody changed the contract since it was read.
      const wrote = ctx.db.tx(() => {
        const res = ctx.db.run('UPDATE runs SET contract_json = ?, contract_hash = ? WHERE id = ? AND contract_json = ?', JSON.stringify(next), after, ctx.runId, row.contract_json);
        if (res.changes !== 1) return false;
        insertAmendment(ctx.db, { runId: ctx.runId, record, change: proposal.change, status: 'applied', approvedBy: answerId, contractBefore: before, contractAfter: after }, ctx.clock, 'controller');
        // A verdict reached under the contract as it was may now differ: the failure it counted is excused. The check results
        // are recorded, so the next verification only evaluates them again; a PASS cannot change and stands.
        invalidateEvidence(ctx.db, ctx.runId, `the contract now accepts a baseline exception for check ${data.check_id}`, ctx.clock, { exceptVerdict: 'PASS' });
        appendEvent(ctx.db, ctx.runId, 'contract.amended', 'controller', { field: record.field, check_id: data.check_id, approved_by: answerId }, ctx.clock.now());
        return true;
      });
      if (!wrote) continue;
      applied = true;
      // After the transaction: a decision writes its jsonl mirror, which a transaction must not.
      recordDecision(
        ctx.db,
        ctx.runDir,
        {
          id: `dec-${ctx.runId}-baseline-exception-applied-${keyOf(ctx.runId, data.check_id, data.fingerprint)}`,
          runId: ctx.runId,
          kind: 'contract.baseline-exception',
          summary: `the contract accepts the pre-existing failure of check ${data.check_id} (fingerprint ${data.fingerprint}) as a baseline exception, approved by ${answeredBy} in ${answerId}`,
          data: { check_id: data.check_id, fingerprint: data.fingerprint, approved_by: answeredBy, answer_decision: answerId, question_id: data.question_id },
        },
        ctx.clock,
        { actor: 'controller' },
      );
      outcome('applied');
    }
    if (!applied && !outcomes.some((o) => o.questionId === data.question_id)) {
      throw new OrbitError('CONCURRENT_UPDATE', `the contract of run ${ctx.runId} kept changing while the baseline exception for check ${data.check_id} was applied`, { questionId: data.question_id });
    }
  }

  const row = load();
  const contract = row.contract_json === null ? null : (JSON.parse(row.contract_json) as GoalContract);
  // contract.json mirrors the row; rewriting it after an apply (or a crash that stopped before it) keeps the two the same.
  if (contract && outcomes.some((o) => o.status === 'applied' || o.status === 'already-applied')) atomicWriteJson(join(ctx.runDir, 'contract.json'), contract);
  return { contract, outcomes };
}
