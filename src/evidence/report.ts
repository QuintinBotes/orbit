import { basename, isAbsolute, join, relative, sep } from 'node:path';
import type { Clock } from '../core/clock.ts';
import { atomicWriteJson } from '../core/fsx.ts';
import { hashObject } from '../core/hash.ts';
import type { GoalContract } from '../contract/types.ts';
import { snapshotHash } from '../policy/snapshot.ts';
import { isTestPath, type TestLayout } from '../policy/test-files.ts';
import type { PolicySnapshot } from '../policy/types.ts';
import type { OrbitDb } from '../storage/db.ts';
import { candidateEvidenceDir } from './runner.ts';
import { insertEvidenceReport, type EvidenceReportRecord } from './store.ts';
import type { Candidate, CheckResult, CheckStatus, CriterionEvidence, CriterionStatus, EvidenceReport, ScopeReport } from './types.ts';

/**
 * Evidence reports (spec §11 "Completion proof"). A report is derived only
 * from executed checks bound to this exact candidate, configuration and
 * policy. A criterion with no executed passing evidence is `unverified`, never
 * `supported`; model opinion, prose proof and unexecuted plans prove nothing.
 * Every gap is listed in `unverified`, so a reader never has to infer what was
 * not established.
 */

export interface UiResultInput {
  journey: string;
  status: CheckStatus;
  artifacts: string[];
  /** Check id of the playwright check this journey belongs to, so criteria can map to it. */
  checkId?: string;
  flaky?: boolean;
}

export interface BuildReportInput {
  contract: GoalContract;
  candidate: Candidate;
  checkResults: readonly CheckResult[];
  uiResults?: readonly UiResultInput[];
  scope: ScopeReport;
  snapshot: PolicySnapshot;
  /** The candidate touches UI paths (or the contract needs UI proof): missing or failing journeys then block PASS. */
  uiRequired?: boolean;
  /**
   * The base revision, so a green check that says nothing about the change is never counted as support (spec section
   * 10 "green checks without proof"). Absent only for callers that judge results without a base (no candidate change
   * can then be compared); the controller and `orbit verify` always pass it.
   */
  base?: BaseComparison;
  /** The run directory: artifacts and logs are then named by their path relative to it, so a reader can open them. */
  runDir?: string;
}

export interface BaseComparison {
  /** Tree of the base revision; a candidate with the same tree changes nothing. */
  treeHash: string;
  /** The base revision's check results (baseline.json), or null when no baseline of this revision is recorded. */
  checks: readonly { checkId: string; status: CheckStatus }[] | null;
  /** Paths the candidate adds or modifies relative to the base revision (deletions excluded). */
  changedPaths: readonly string[];
  /**
   * The test layout of the base and candidate trees for those paths (loadTestLayout, ADR 0011), so a file of a .NET
   * test project or a crate's tests/ counts as a test. Absent, path conventions alone decide.
   */
  testLayout?: TestLayout;
  /** Diffs of changed files whose test changes only their content shows (testedByContent: a #[test] added in Rust). */
  diffs?: ReadonlyMap<string, string>;
}

/** One hash over the configuration of the given checks, in id order. */
export function aggregateCheckConfigHash(snapshot: PolicySnapshot, checkIds: Iterable<string>): string {
  const ids = [...new Set(checkIds)].sort();
  const map: Record<string, string | null> = {};
  for (const id of ids) map[id] = snapshot.check_config_hashes[id] ?? null;
  return hashObject(map);
}

type Outcome = 'passed' | 'flaky' | 'failed' | 'error' | 'missing' | 'excepted';

interface Evidence {
  outcome: Outcome;
  status?: CheckStatus;
  artifacts: string[];
  fingerprint?: string | null;
}

export function buildEvidenceReport(input: BuildReportInput): EvidenceReport {
  return evaluateEvidence(input).report;
}

export interface Evaluation {
  report: EvidenceReport;
  /** Why the verdict is FAIL: established problems (failing checks, scope violations). */
  failReasons: string[];
  /** Why the verdict is not PASS without being FAIL: evidence missing or needing review. */
  incompleteReasons: string[];
}

/** Like buildEvidenceReport, also returning the reasons behind the verdict for repair briefs and status output. */
export function evaluateEvidence(input: BuildReportInput): Evaluation {
  const { contract, candidate, snapshot } = input;
  const policyHash = snapshotHash(snapshot);
  // Policy, not a caller choice: a run cannot grant itself flaky passes. An absent setting is the strict one.
  const allowFlaky = snapshot.config.verification?.allow_flaky_pass === true;
  const fail: string[] = [];
  const incomplete: string[] = [];
  const unverified: string[] = [];
  const note = (list: string[], text: string) => {
    if (!list.includes(text)) list.push(text);
  };

  // Only results bound to this candidate under this configuration and policy count.
  const valid = new Map<string, CheckResult>();
  const failedAt = new Map<string, number>();
  for (const r of input.checkResults) {
    const b = r.binding;
    const expected = snapshot.check_config_hashes[r.checkId];
    const problem =
      b.candidateId !== candidate.id ? 'a different candidate'
      : b.treeHash !== candidate.treeHash ? 'a different tree'
      : b.policyHash !== policyHash ? 'a different policy snapshot'
      : expected !== undefined && b.checkConfigHash !== expected ? 'a different check configuration'
      : null;
    if (problem) {
      note(unverified, `check ${r.checkId}: result is bound to ${problem} and was ignored`);
      continue;
    }
    const prev = valid.get(r.checkId);
    if (!prev || r.endedAt >= prev.endedAt) valid.set(r.checkId, r);
    if (r.status === 'FAILED' || r.status === 'TIMEOUT') failedAt.set(r.checkId, Math.min(failedAt.get(r.checkId) ?? Infinity, r.endedAt));
  }
  // A pass that came after a failure of the same check on the same tree is a rerun, wherever the two results came from.
  for (const [id, r] of valid) {
    const failed = failedAt.get(id);
    if (r.status === 'PASSED' && !r.flaky && failed !== undefined && failed <= r.endedAt) valid.set(id, { ...r, flaky: true });
  }
  const ui = new Map<string, UiResultInput[]>();
  for (const u of input.uiResults ?? []) {
    if (u.checkId === undefined) continue;
    ui.set(u.checkId, [...(ui.get(u.checkId) ?? []), u]);
  }

  // The contract records the base revision's failure fingerprint for each exception. A failing check is excused only
  // while it fails with exactly that fingerprint: a different breakage of the same check is a new failure.
  const exceptions = new Map((contract.baseline_exceptions ?? []).map((e) => [e.check_id, e.fingerprint]));
  const excepted = (checkId: string, fp: string | null | undefined): boolean => {
    const recorded = exceptions.get(checkId);
    if (recorded === undefined) return false;
    if (fp === null || fp === undefined || fp !== recorded) {
      note(incomplete, `check ${checkId}: the contract documents a baseline exception, but this failure is not the one recorded in it`);
      return false;
    }
    note(unverified, `check ${checkId}: failing as recorded in the contract's baseline exception; accepted`);
    return true;
  };

  // A path a reader can open: relative to the run directory when it lies inside it; otherwise as it was given.
  const runDir = input.runDir;
  const artifactPath = (p: string, fallback: string): string => {
    if (runDir === undefined) return fallback;
    const r = relative(runDir, p);
    return r === '' || r.startsWith('..') || isAbsolute(r) ? p : r.split(sep).join('/');
  };
  const logName = (p: string): string => artifactPath(p, basename(p));

  const evidenceFor = (checkId: string): Evidence => {
    const r = valid.get(checkId);
    const journeys = ui.get(checkId);
    if (!r && !journeys) return { outcome: 'missing', artifacts: [] };
    if (r) {
      const art = [logName(r.logPath)];
      switch (r.status) {
        case 'PASSED':
          return { outcome: r.flaky ? 'flaky' : 'passed', status: r.status, artifacts: art };
        case 'FAILED':
        case 'TIMEOUT':
          return { outcome: excepted(checkId, r.fingerprint) ? 'excepted' : 'failed', status: r.status, artifacts: art, fingerprint: r.fingerprint };
        default:
          return { outcome: 'error', status: r.status, artifacts: art };
      }
    }
    const worst = journeys!.find((j) => j.status !== 'PASSED');
    const art = journeys!.flatMap((j) => j.artifacts.map((a) => (isAbsolute(a) ? artifactPath(a, a) : a)));
    if (!worst) return { outcome: journeys!.some((j) => j.flaky) ? 'flaky' : 'passed', status: 'PASSED', artifacts: art };
    return { outcome: worst.status === 'FAILED' || worst.status === 'TIMEOUT' ? 'failed' : 'error', status: worst.status, artifacts: art };
  };

  // Mandatory checks: the contract's list plus everything the policy marks mandatory (journeys only when UI proof is needed).
  const mandatory = new Set(contract.required_check_ids);
  for (const [id, def] of Object.entries(snapshot.config.checks)) {
    if (def.mandatory && (def.kind === 'command' || input.uiRequired === true)) mandatory.add(id);
  }
  for (const id of [...mandatory].sort()) {
    const e = evidenceFor(id);
    switch (e.outcome) {
      case 'passed':
      case 'excepted':
        break;
      case 'flaky':
        if (allowFlaky) note(unverified, `check ${id}: passed only after a rerun (flaky); accepted by policy`);
        else note(incomplete, `check ${id}: passed only after a rerun (flaky); a flaky pass is not a clean pass`);
        break;
      case 'failed':
        note(fail, `check ${id}: ${e.status === 'TIMEOUT' ? 'timed out' : 'failed'}`);
        break;
      case 'error':
        note(incomplete, `check ${id}: ${e.status === 'CANCELLED' ? 'was cancelled' : 'could not be run'}; no result`);
        break;
      case 'missing':
        note(incomplete, `check ${id}: mandatory but not executed for this candidate`);
        break;
    }
  }

  // With nothing executed there is no evidence at all, whatever the contract and policy happen to make mandatory.
  if (valid.size === 0 && (input.uiResults ?? []).length === 0) note(incomplete, 'no check was executed for this candidate, so nothing about it is verified');

  // Optional checks that ran and failed are disclosed; they do not decide the verdict.
  for (const r of valid.values()) {
    if (!mandatory.has(r.checkId) && (r.status === 'FAILED' || r.status === 'TIMEOUT')) note(unverified, `optional check ${r.checkId} ${r.status === 'TIMEOUT' ? 'timed out' : 'failed'}`);
  }

  // What the change could have turned green (spec section 10 "green checks without proof"). A candidate whose tree is
  // the base tree changes nothing, so nothing it passes is evidence about a change. A criterion whose mapped checks
  // have no failing result on the base revision rests on a green result the base revision gives as well, unless the
  // candidate adds or changes a test those checks can run: without one, the pass is no new evidence.
  const base = input.base;
  const noChange = base !== undefined && base.treeHash === candidate.treeHash;
  if (noChange) note(incomplete, 'the candidate makes no change: its tree is the base revision\'s tree, so no check result is evidence of a change');
  // One test-file predicate for every language (ADR 0011); the change's diff counts here, since the question is
  // whether the change adds or changes a test.
  const testChanged = base !== undefined && base.changedPaths.some((p) => isTestPath(p, base.testLayout, base.diffs?.get(p)));
  const baseStatus = new Map((base?.checks ?? []).map((c) => [c.checkId, c.status] as const));
  const newEvidenceGap = (ids: readonly string[]): string | null => {
    if (base === undefined) return null;
    if (noChange) return 'the candidate makes no change, so its green checks are no evidence of one';
    if (testChanged) return null;
    if (ids.some((id) => baseStatus.get(id) === 'FAILED' || baseStatus.get(id) === 'TIMEOUT')) return null;
    const passed = base.checks !== null && ids.every((id) => baseStatus.get(id) === 'PASSED');
    return `no new evidence: ${ids.join(', ')} ${passed ? 'already passed on the base revision' : 'has no failing result recorded on the base revision'} and the candidate adds or changes no test`;
  };

  // Criteria.
  const journeyIds = new Set(snapshot.config.ui?.journey_check_ids ?? []);
  const isBrowserCheck = (id: string): boolean => snapshot.config.checks[id]?.kind === 'playwright' || journeyIds.has(id) || ui.has(id);
  const criteria: CriterionEvidence[] = contract.acceptance_criteria.map((c) => {
    const ids = c.check_ids ?? [];
    let status: CriterionStatus;
    let artifacts: string[] = [];
    let why: string | undefined;
    if (ids.length === 0) {
      status = 'unverified';
      why = c.ui === true ? 'no browser check is mapped to this UI criterion' : 'no executed check is mapped to this criterion; prose proof alone is not evidence';
    } else {
      const ev = ids.map((id) => ({ id, e: evidenceFor(id) }));
      artifacts = [...new Set(ev.flatMap((x) => x.e.artifacts))];
      const bad = ev.filter((x) => x.e.outcome === 'failed');
      const err = ev.filter((x) => x.e.outcome === 'error');
      const gap = ev.filter((x) => x.e.outcome === 'missing' || x.e.outcome === 'excepted' || (x.e.outcome === 'flaky' && !allowFlaky));
      if (bad.length) {
        status = 'unsupported';
        why = `failing: ${bad.map((x) => x.id).join(', ')}`;
      } else if (err.length) {
        status = 'blocked';
        why = `no result for: ${err.map((x) => x.id).join(', ')}`;
      } else if (gap.length) {
        status = 'unverified';
        why = gap.map((x) => (x.e.outcome === 'flaky' ? `${x.id} passed only after a rerun` : x.e.outcome === 'excepted' ? `${x.id} fails as on the base revision` : `${x.id} was not executed`)).join('; ');
      } else if (c.ui === true && !ids.some(isBrowserCheck)) {
        // Spec §11: passing unit tests alone do not prove a user journey.
        status = 'unverified';
        why = 'no browser check is mapped to this UI criterion; command checks alone do not prove a user journey';
      } else {
        const gapWhy = newEvidenceGap(ids);
        if (gapWhy !== null) {
          status = 'unverified';
          why = gapWhy;
        } else {
          status = 'supported';
        }
      }
    }
    if (c.mandatory) {
      if (status === 'unsupported') note(fail, `criterion ${c.id}: ${why}`);
      else if (status !== 'supported') note(incomplete, `criterion ${c.id}: ${status}${why ? ` (${why})` : ''}`);
    } else if (status !== 'supported') {
      note(unverified, `optional criterion ${c.id}: ${status}${why ? ` (${why})` : ''}`);
    }
    return { criterion_id: c.id, status, artifacts, ...(why ? { note: why } : {}) };
  });

  // UI journeys.
  const uiRows = (input.uiResults ?? []).map((u) => ({ journey: u.journey, status: u.status, artifacts: [...u.artifacts] }));
  if (input.uiRequired === true) {
    const journeyChecks = new Set(snapshot.config.ui?.journey_check_ids ?? []);
    if (input.uiResults === undefined || input.uiResults.length === 0) {
      if (![...journeyChecks].some((id) => mandatory.has(id))) note(incomplete, 'UI evidence is required for this candidate but no journey was executed');
    }
    for (const u of input.uiResults ?? []) {
      if (u.status === 'FAILED' || u.status === 'TIMEOUT') note(fail, `journey ${u.journey}: ${u.status === 'TIMEOUT' ? 'timed out' : 'failed'}`);
      else if (u.status !== 'PASSED') note(incomplete, `journey ${u.journey}: ${u.status === 'CANCELLED' ? 'was cancelled' : 'could not be run'}`);
    }
  }

  // Scope.
  const s = input.scope;
  const deps = snapshot.config.dependencies;
  if (!s.allowed_paths_pass) note(fail, 'scope: paths outside the allowed scope or in protected paths changed');
  for (const p of s.forbidden_paths_changed) note(fail, `scope: forbidden path changed: ${p}`);
  for (const p of s.out_of_scope_paths_changed) note(fail, `scope: out-of-scope path changed: ${p}`);
  if (!s.within_size_limits) note(fail, `scope: change exceeds the size limits (${s.changed_files} files, ${s.changed_lines} lines)`);
  for (const p of s.symlinks_escaping) note(fail, `scope: symlink escapes the repository: ${p}`);
  if (s.lockfile_changed && !deps.change_lockfile) note(fail, 'scope: a lockfile changed and policy does not allow lockfile changes');
  if (s.dependency_manifest_changed.length > 0 && !deps.add_packages) note(fail, `scope: dependency manifests changed and policy does not allow adding packages: ${s.dependency_manifest_changed.join(', ')}`);
  for (const w of s.weakening_signals) note(incomplete, `possible test weakening in ${w.path}: ${w.signal} (${w.detail}); needs review`);
  if (s.visual_baseline_changes.length > 0 && snapshot.config.ui?.visual.baseline_changes_require_review !== false) {
    note(incomplete, `visual baselines changed and require review: ${s.visual_baseline_changes.join(', ')}`);
  }

  for (const t of incomplete) note(unverified, t);

  const checks = [...valid.values()]
    .sort((a, b) => a.checkId.localeCompare(b.checkId))
    .map((r) => ({ id: r.checkId, status: r.status, exit_code: r.exitCode, flaky: r.flaky, log: logName(r.logPath) }));
  // Journey checks that came in as UI results carry no CheckResult, so the hash covers exactly the checks listed in `checks`.
  const report: EvidenceReport = {
    task_id: contract.task_id,
    run_id: candidate.runId,
    attempt: candidate.attempt,
    candidate_revision: candidate.commitSha,
    tree_hash: candidate.treeHash,
    check_config_hash: aggregateCheckConfigHash(snapshot, checks.map((c) => c.id)),
    policy_hash: policyHash,
    scope: s,
    checks,
    ui: uiRows,
    acceptance_evidence: criteria,
    verdict: fail.length > 0 ? 'FAIL' : incomplete.length > 0 ? 'INCOMPLETE' : 'PASS',
    unverified,
  };
  return { report, failReasons: fail, incompleteReasons: incomplete };
}

export function reportPath(runDir: string, candidate: Pick<Candidate, 'seq'>): string {
  return join(candidateEvidenceDir(runDir, candidate.seq), 'report.json');
}

/** Write report.json and the evidence_reports row. The row is the authority; the file is the readable copy. */
export function saveEvidenceReport(opts: { db: OrbitDb; runDir: string; candidate: Candidate; report: EvidenceReport; clock: Clock }): EvidenceReportRecord {
  const path = reportPath(opts.runDir, opts.candidate);
  atomicWriteJson(path, opts.report, 0o644);
  return insertEvidenceReport(opts.db, { candidateId: opts.candidate.id, report: opts.report, reportPath: path }, opts.clock);
}
