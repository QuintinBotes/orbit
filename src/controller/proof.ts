/**
 * A run is done only when each criterion's proof would fail without it (issue #200; the ADR 0014 addendum of
 * 2026-11-20). DELIVERING runs this gate on the final candidate before any delivery action, under
 * `verification.fail_before: required` for a contract whose plan maps tests to criteria (every plan since issue #200):
 *
 * 1. a criterion audit per criterion (person-checked ones excepted): a fresh reviewer session sees only the criterion's
 *    text and its mapped tests with the test-owned files they import, in a directory holding only those files;
 * 2. a conformance check per MUST of the goal: a fresh session quotes the lines that implement its exact wording, Orbit
 *    checks each quote byte for byte and lists the callers of each changed function holding a quoted line;
 * 3. one artifact check: the pull request body and every documentation file the candidate adds or changes, against the
 *    candidate.
 *
 * Each answer is a `proof.answer` decision bound to the tree, the judgement one `proof.result` decision. Any open result
 * (an unproven criterion, an unmet MUST, a caller or artifact finding) goes to repair with a brief naming each; the
 * repaired candidate is verified, reviewed and comes back here, where every check runs again on its tree. Nothing is
 * delivered, and no run succeeds, while one is open (the completion gate reads the same decision).
 */
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { atomicWriteJson, readJsonIfExists } from '../core/fsx.ts';
import { sha256 } from '../core/hash.ts';
import { isOrbitError, OrbitError } from '../core/errors.ts';
import { clipAtWord } from '../core/text.ts';
import { redact } from '../core/redact.ts';
import { renderWorkerPrompt } from '../adapters/prompt.ts';
import { extractRequirements, type Requirement } from '../contract/requirements.ts';
import type { AcceptanceCriterion, GoalContract } from '../contract/types.ts';
import { validateModelOutput } from '../contract/model-outputs.ts';
import { criterionKind, mapsTests } from '../evidence/criterion-tests.ts';
import { git } from '../evidence/git.ts';
import { currentEvidenceReport, type CandidateRecord } from '../evidence/store.ts';
import type { RepairBrief } from '../evidence/types.ts';
import { readIssueGoal } from '../intake/issue.ts';
import { failBeforePolicy } from '../policy/config.ts';
import { isLockfilePath } from '../policy/scope.ts';
import { gitTreeReader, isTestOwnedPath, loadTestLayout } from '../policy/test-files.ts';
import { changedLines, enclosingFunction, judgeProof, parseRange, PROOF_RESULT_KIND, proofResultId, type ProofAnswer, type ProofResult } from '../review/proof.ts';
import { cleanupCandidateCheckout, materializeCandidate } from '../evidence/candidate.ts';
import { appendEvent } from '../storage/events.ts';
import { getDecision } from '../storage/decisions.ts';
import { extensionDecisionRecord } from '../scheduling/budget.ts';
import { progressSince } from '../inquisition/repair.ts';
import { runWorktreeRoot, type RunContext } from './context.ts';
import { attemptHistory } from './steps/diagnosing.ts';
import { assertContract, decide, finishRun, MAX_REGENERATIONS, move, policySummary, progress, WAIT, type StepResult } from './steps/common.ts';
import { briefPath, currentAttempt, type StoredBrief } from './steps/implementing.ts';
import { obtain } from './steps/obtain.ts';
import { recordedReviewer, reviewEffort } from './steps/reviewing.ts';

export const PROOF_ANSWER_KIND = 'proof.answer';
export const PROOF_REPAIR_EVENT = 'proof.repair';

/** The most test text one audit is given; a longer test cannot be audited, and its criterion stays unproven. */
export const AUDIT_MAX_CHARS = 60_000;
const AUDIT_MAX_FILES = 25;

type SubjectKind = 'criterion' | 'requirement' | 'artifacts';
interface Subject {
  kind: SubjectKind;
  id: string;
}

interface AnswerData extends ProofAnswer {
  tree_hash: string;
  subject: SubjectKind;
  subject_id: string;
  worker_id: string | null;
}

/** Whether the gate applies to this run: `required`, and a contract whose plan maps tests to criteria. */
export function proofApplies(ctx: Pick<RunContext, 'snapshot'>, contract: Pick<GoalContract, 'acceptance_criteria'>): boolean {
  return failBeforePolicy(ctx.snapshot.config).mode === 'required' && mapsTests(contract);
}

/** The goal's MUSTs: the issue spec a run was started from, the goal and the objective. */
export function goalRequirements(ctx: Pick<RunContext, 'runDir'>, contract: Pick<GoalContract, 'original_goal' | 'objective'>): Requirement[] {
  const issue = readIssueGoal(ctx.runDir);
  return extractRequirements([...(issue ? [issue.spec] : []), contract.original_goal, contract.objective]);
}

function subjects(ctx: RunContext, contract: GoalContract): Subject[] {
  return [
    ...contract.acceptance_criteria.filter((c) => criterionKind(c) !== 'person').map((c): Subject => ({ kind: 'criterion', id: c.id })),
    ...goalRequirements(ctx, contract).map((r): Subject => ({ kind: 'requirement', id: r.id })),
    { kind: 'artifacts', id: 'ARTIFACTS' },
  ];
}

const answerId = (ctx: RunContext, tree: string, s: Subject): string => `dec-${ctx.run.id}-proof-${tree.slice(0, 12)}-${s.kind}-${s.id}`;

function answerOf(ctx: RunContext, tree: string, s: Subject): AnswerData | null {
  return (getDecision(ctx.db, answerId(ctx, tree, s))?.data as AnswerData | undefined) ?? null;
}

function recordAnswer(ctx: RunContext, tree: string, s: Subject, a: ProofAnswer, workerId: string | null): void {
  const id = answerId(ctx, tree, s);
  if (getDecision(ctx.db, id)) return;
  const what = s.kind === 'criterion' ? `criterion audit of ${s.id}` : s.kind === 'requirement' ? `conformance of ${s.id}` : 'artifact check';
  const summary = a.missing !== null ? `${what} on tree ${tree.slice(0, 12)}: no answer (${a.missing})` : `${what} on tree ${tree.slice(0, 12)}: ${a.verdict}, ${a.findings.length} finding(s)`;
  decide(ctx, { id, kind: PROOF_ANSWER_KIND, summary: clipAtWord(summary, 500), data: { tree_hash: tree, subject: s.kind, subject_id: s.id, worker_id: workerId, ...a } satisfies AnswerData });
}

/**
 * The gate: null once every check on this tree is answered and nothing is open, so delivery may go on; otherwise the
 * step to take (a session running, a repair, a stop).
 */
export async function proveDone(ctx: RunContext, cand: CandidateRecord, prBody: string | null): Promise<StepResult | null> {
  const contract = assertContract(ctx);
  if (!proofApplies(ctx, contract)) return null;
  const done = readProofResult(ctx, cand.treeHash);
  if (done) return done.open.length === 0 ? null : repair(ctx, cand, done);
  for (const s of subjects(ctx, contract)) {
    if (answerOf(ctx, cand.treeHash, s)) continue;
    const step = await ask(ctx, cand, contract, s, prBody);
    if (step) return step;
  }
  const result = await judge(ctx, cand, contract);
  // The read-only checkout the conformance and artifact sessions shared is no longer needed once all have answered.
  await cleanupCandidateCheckout(ctx.run.repoRoot, join(runWorktreeRoot(ctx), `proof-${cand.seq}`)).catch(() => {});
  decide(ctx, { id: proofResultId(ctx.run.id, cand.treeHash), kind: PROOF_RESULT_KIND, summary: clipAtWord(result.open.length === 0 ? `tree ${cand.treeHash.slice(0, 12)} is proven: every criterion, MUST and document checked` : `tree ${cand.treeHash.slice(0, 12)} is not done: ${result.open.join('; ')}`, 2000), data: result });
  atomicWriteJson(join(ctx.runDir, 'proof', `${cand.seq}.json`), result);
  if (result.open.length > 0) return repair(ctx, cand, result);
  progress(ctx, 'proof.done', { candidate_id: cand.id, tree_hash: cand.treeHash });
  return null;
}

export function readProofResult(ctx: Pick<RunContext, 'db' | 'run'>, treeHash: string): ProofResult | null {
  return (getDecision(ctx.db, proofResultId(ctx.run.id, treeHash))?.data as ProofResult | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// Asking

async function ask(ctx: RunContext, cand: CandidateRecord, contract: GoalContract, s: Subject, prBody: string | null): Promise<StepResult | null> {
  const sel = recordedReviewer(ctx);
  if (!sel) return finishRun(ctx, 'BLOCKED', `no reviewer is recorded for run ${ctx.run.id}, so the criterion audits, conformance and the artifact check cannot run before delivery`);
  const packet = await packetOf(ctx, cand, contract, s, prBody);
  if ('missing' in packet) {
    recordAnswer(ctx, cand.treeHash, s, { verdict: null, findings: [], missing: packet.missing }, null);
    return null;
  }
  const p = packet;
  const what = s.kind === 'criterion' ? `the ${sel.provider} auditor of ${s.id}` : s.kind === 'requirement' ? `the ${sel.provider} conformance check of ${s.id}` : `the ${sel.provider} artifact check`;
  const got = await obtain<ProofAnswer>(ctx, {
    base: `proof-${s.kind}:${cand.id}:${s.id}`,
    maxAttempts: MAX_REGENERATIONS,
    what,
    exhausted: async (failed) => {
      // An answer no session could give leaves the subject open (FR-002: no answer is never proof); the run goes on to judge.
      recordAnswer(ctx, cand.treeHash, s, { verdict: null, findings: [], missing: `${what} gave no usable answer (${failed.status}${failed.error ? `: ${clipAtWord(failed.error, 200)}` : ''})` }, null);
      return WAIT(`${what} gave no usable answer`);
    },
    request: (purpose) => ({
      role: 'reviewer',
      purpose,
      candidateId: cand.id,
      provider: sel.provider,
      model: sel.model,
      effort: reviewEffort(ctx, sel),
      cwd: p.cwd,
      readOnly: true,
      phase: 'final',
      prompt: () =>
        renderWorkerPrompt({
          role: 'reviewer',
          // The first line names the check, so its answer is read as that check's and never as a review of the tree.
          task: [`Orbit proof check: ${s.kind === 'criterion' ? 'criterion audit' : s.kind === 'requirement' ? 'conformance' : 'artifacts'}`, ...p.task, `Echo the candidate revision ${cand.commitSha} in candidate_revision. Do not edit anything and do not ask questions.`].join('\n'),
          // The auditor sees no contract: only the criterion and its tests (FR-001).
          contract: s.kind === 'criterion' ? null : contract,
          policySummary: policySummary(ctx, { readOnly: true }),
          candidate: { revision: cand.commitSha, treeHash: cand.treeHash },
          untrusted: p.blocks,
          maxBlockChars: Math.max(...p.blocks.map((b) => b.content.length), 1000) + 100,
          maxPromptChars: p.blocks.reduce((n, b) => n + b.content.length, 0) + 60_000,
        }),
    }),
    accept: (r) => {
      const out = validateModelOutput('review', r.structured);
      if (!cand.commitSha.toLowerCase().startsWith(out.candidate_revision.toLowerCase()) || out.candidate_revision.length < 7) throw new OrbitError('MALFORMED_OUTPUT', `the answer is for revision ${out.candidate_revision}, not candidate ${cand.commitSha.slice(0, 12)}`);
      return { verdict: out.verdict, findings: out.findings.map((f) => ({ id: f.id, severity: f.severity, category: f.category, location: f.location, claim: f.claim, evidence: f.evidence })), missing: null };
    },
  });
  if (!got.ok) return answerOf(ctx, cand.treeHash, s) ? null : got.step;
  recordAnswer(ctx, cand.treeHash, s, got.value, got.worker.id);
  if (s.kind === 'criterion') rmSync(auditDir(ctx, cand, s.id), { recursive: true, force: true });
  return null;
}

type Packet = { cwd: string; task: string[]; blocks: { label: string; content: string }[] } | { missing: string };

/**
 * A subject's packet, built once per tree and kept in the run directory: the step runs again on every pass while its
 * session runs, and the session's directory must not be rebuilt beneath it.
 */
async function packetOf(ctx: RunContext, cand: CandidateRecord, contract: GoalContract, s: Subject, prBody: string | null): Promise<Packet> {
  const path = join(ctx.runDir, 'proof', String(cand.seq), `${s.kind}-${s.id}.json`);
  let packet = readJsonIfExists<Packet>(path);
  if (packet === null) {
    if (s.kind === 'criterion') packet = await auditPacket(ctx, cand, contract.acceptance_criteria.find((c) => c.id === s.id)!);
    else if (s.kind === 'requirement') packet = await conformancePacket(ctx, cand, contract, s.id);
    else packet = await artifactPacket(ctx, cand, prBody);
    atomicWriteJson(path, packet);
  }
  // A restart may have removed the session's directory: the checkout, or the audit's files, are made again.
  if (!('missing' in packet) && !existsSync(packet.cwd)) {
    if (s.kind === 'criterion') await auditPacket(ctx, cand, contract.acceptance_criteria.find((c) => c.id === s.id)!);
    else await proofCheckout(ctx, cand);
  }
  return packet;
}

function auditDir(ctx: RunContext, cand: CandidateRecord, criterionId: string): string {
  return join(runWorktreeRoot(ctx), `audit-${cand.seq}-${criterionId}`);
}

async function show(repoRoot: string, commit: string, path: string): Promise<string | null> {
  try {
    return await git(repoRoot, ['show', `${commit}:${path}`]);
  } catch (err) {
    if (isOrbitError(err, 'GIT_FAILED')) return null;
    throw err;
  }
}

const RELATIVE_SPECIFIER = /(?:from\s+|import\s*\(?\s*|require\s*\(\s*)['"](\.{1,2}\/[^'"\n]+)['"]/g;
const EXTENSIONS = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '/index.ts', '/index.js', '/index.mjs'];

/**
 * The mapped tests and the test-owned files they import (relative imports, followed transitively), from the candidate.
 * A production file is never included (FR-001).
 * shortcut: imports are found by their relative specifiers in JS/TS syntax (from, import(), require()); a helper another
 * language imports by module name is not added, and the auditor then sees the test alone.
 */
export async function auditFiles(repoRoot: string, commit: string, tests: readonly string[], testOwned: (p: string) => boolean): Promise<{ files: Map<string, string>; missing: string[]; truncated: boolean }> {
  const files = new Map<string, string>();
  const missing: string[] = [];
  const queue = [...tests];
  while (queue.length > 0 && files.size < AUDIT_MAX_FILES) {
    const path = queue.shift()!;
    if (files.has(path)) continue;
    const text = await show(repoRoot, commit, path);
    if (text === null) {
      if (tests.includes(path)) missing.push(path);
      continue;
    }
    files.set(path, text);
    for (const m of text.matchAll(RELATIVE_SPECIFIER)) {
      const target = posix.normalize(posix.join(posix.dirname(path), m[1]!));
      if (target.startsWith('..')) continue;
      for (const ext of EXTENSIONS) {
        const p = `${target}${ext}`;
        if (!testOwned(p)) continue;
        if (files.has(p) || queue.includes(p)) break;
        if ((await show(repoRoot, commit, p)) !== null) {
          queue.push(p);
          break;
        }
      }
    }
  }
  return { files, missing, truncated: queue.some((p) => !files.has(p)) };
}

async function auditPacket(ctx: RunContext, cand: CandidateRecord, c: AcceptanceCriterion): Promise<{ cwd: string; task: string[]; blocks: { label: string; content: string }[] } | { missing: string }> {
  const tests = c.tests ?? [];
  if (tests.length === 0) return { missing: `no test is mapped to ${c.id}, so there is nothing to audit` };
  const layout = await loadTestLayout(gitTreeReader((args) => git(ctx.run.repoRoot, args)), ctx.run.baseRevision!, cand.commitSha, tests, { allDotnetOwners: true });
  const { files, missing, truncated } = await auditFiles(ctx.run.repoRoot, cand.commitSha, tests, (p) => isTestOwnedPath(p, layout));
  if (missing.length > 0) return { missing: `the mapped test ${missing.join(', ')} is not in the candidate, so it cannot be audited` };
  if (truncated) return { missing: `the mapped tests and their helpers are more than ${AUDIT_MAX_FILES} files, over the auditor's limit, so ${c.id} cannot be audited` };
  const size = [...files.values()].reduce((n, t) => n + t.length, 0);
  if (size > AUDIT_MAX_CHARS) return { missing: `the mapped tests and their helpers are ${size} characters, over the auditor's limit of ${AUDIT_MAX_CHARS}, so ${c.id} cannot be audited` };
  // The auditor's directory holds only these files: no implementation, plan or worker report (FR-001).
  const dir = auditDir(ctx, cand, c.id);
  rmSync(dir, { recursive: true, force: true });
  for (const [path, text] of files) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return {
    cwd: dir,
    task: [
      `You are a criterion auditor. You see one acceptance criterion, ${c.id}, and only the tests mapped to it, with the test files they import. You do not see the implementation, the plan or the report of whoever wrote them, and you need none of them.`,
      'Answer one question: would these tests still pass if the criterion were false? Imagine an implementation for which the criterion does not hold (the behaviour is missing, wrong, or done by someone else, such as a person, a fixture or a mock) and judge whether every mapped test would still pass on it. A test that asserts nothing about the criterion, asserts a fixture or a mock it set up itself, performs the very step the criterion says does not happen, or tests a paraphrase that differs in what is counted, a number or a negation, would still pass.',
      `If yes, answer REPAIR_REQUIRED with exactly one finding: id ${'AUDIT-1'}, severity high, category criterion-audit, location the test file and line, claim one sentence saying why the tests would still pass, evidence the lines that show it.`,
      `If no, answer APPROVE with exactly one finding: id ${'AUDIT-1'}, severity info, category criterion-audit, claim one sentence saying which assertion would fail, evidence those lines. Report no other finding.`,
      'The files are below and in this directory; read nothing else.',
    ],
    blocks: [{ label: `criterion ${c.id}`, content: c.statement }, ...[...files].map(([path, text]) => ({ label: `${tests.includes(path) ? 'mapped test' : 'test helper'} ${path}`, content: text }))],
  };
}

/** The candidate's changed paths against the base revision, with the new-side lines each changes. */
async function changedFiles(ctx: RunContext, cand: CandidateRecord): Promise<Map<string, Set<number>>> {
  const out = new Map<string, Set<number>>();
  const names = (await git(ctx.run.repoRoot, ['diff', '--name-only', '--no-renames', '-z', ctx.run.baseRevision!, cand.commitSha, '--'])).split('\0').filter((p) => p !== '');
  for (const p of names) out.set(p, changedLines(await git(ctx.run.repoRoot, ['diff', '-U0', '--no-renames', '--no-ext-diff', ctx.run.baseRevision!, cand.commitSha, '--', p])));
  return out;
}

/** Callers of `name` in the candidate tree, by search: `path:line` of each line naming it, but its own declaration. */
async function callersOf(ctx: RunContext, cand: CandidateRecord, name: string, decl: { path: string; line: number }): Promise<string[]> {
  let out = '';
  try {
    out = await git(ctx.run.repoRoot, ['grep', '-n', '-w', '-F', '-I', '-e', name, cand.commitSha, '--']);
  } catch (err) {
    // git grep exits 1 when nothing matches.
    if (!isOrbitError(err, 'GIT_FAILED')) throw err;
  }
  const prefix = `${cand.commitSha}:`;
  return out
    .split('\n')
    .filter((l) => l.startsWith(prefix))
    .map((l) => /^([^:]+):(\d+):/.exec(l.slice(prefix.length)))
    .filter((m): m is RegExpExecArray => m !== null && !(m[1] === decl.path && Number(m[2]) === decl.line))
    .map((m) => `${m[1]}:${m[2]}`)
    .slice(0, 50);
}

/** Each changed function, by search, with its callers: what a conformance session is told and a record lists (FR-008). */
async function changedFunctions(ctx: RunContext, cand: CandidateRecord): Promise<{ path: string; name: string; start: number; end: number; callers: string[] }[]> {
  const out: { path: string; name: string; start: number; end: number; callers: string[] }[] = [];
  for (const [path, lines] of await changedFiles(ctx, cand)) {
    if (lines.size === 0 || isLockfilePath(path)) continue;
    const text = await show(ctx.run.repoRoot, cand.commitSha, path);
    if (text === null) continue;
    for (const line of [...lines].sort((a, b) => a - b)) {
      const fn = enclosingFunction(text, line);
      if (!fn || out.some((f) => f.path === path && f.name === fn.name && f.start === fn.start)) continue;
      out.push({ path, ...fn, callers: await callersOf(ctx, cand, fn.name, { path, line: fn.start }) });
    }
    if (out.length >= 40) break;
  }
  return out;
}

async function conformancePacket(ctx: RunContext, cand: CandidateRecord, contract: GoalContract, id: string): Promise<{ cwd: string; task: string[]; blocks: { label: string; content: string }[] }> {
  const all = goalRequirements(ctx, contract);
  const r = all.find((x) => x.id === id)!;
  const functions = await changedFunctions(ctx, cand);
  const checkout = await proofCheckout(ctx, cand);
  return {
    cwd: checkout,
    task: [
      `This is a conformance check of one requirement, ${r.id}, against the exact candidate in this read-only checkout. Find the line or lines that implement its exact wording.`,
      `If they exist, answer APPROVE with one finding: id ${r.id}, severity info, category conformance, location path:start-end (one range of lines in the candidate), evidence those lines copied exactly as the file has them (Orbit compares them byte for byte), claim one sentence on how they implement the wording. A MUST NOT is met by quoting the guard that prevents it, or the test that shows it does not happen. For a generated file (a bundle, a lockfile, a generated reference) quote the source that generates it.`,
      `If they do not, answer REPAIR_REQUIRED with that finding at severity high, with claim why it is unmet and, where there is one, the nearest line in location and evidence. It is unmet when the code counts something other than what the wording counts (issues for runs, say), uses another number, or drops or adds a negation, even when tests pass.`,
      'The functions the candidate changes and their callers, found by search, are listed below. For the function that holds your quote, judge whether the change alters what any of its callers does. A caller whose behaviour changes where no requirement listed below asks for it is a finding: id CALLER-1, CALLER-2, ..., severity high, category scope, location the caller path:line, claim what changes for it. Report no other finding.',
    ],
    blocks: [
      { label: `requirement ${r.id}`, content: r.wording },
      { label: 'every requirement of the goal', content: all.map((x) => `${x.id}: ${x.wording}`).join('\n') },
      { label: 'changed functions and their callers', content: functions.length === 0 ? '(none found by search)' : functions.map((f) => `${f.name} (${f.path}:${f.start}-${f.end}): ${f.callers.length === 0 ? 'no callers found' : f.callers.join(', ')}`).join('\n') },
    ],
  };
}

const DOC_PATH = /(?:^|\/)(?:readme|changelog|changes|history|contributing|security)(?:\.[a-z]+)?$|\.(?:md|mdx|markdown|rst|adoc|txt)$/i;
const GENERATED = /(?:^|\/)(?:dist|build|out|generated|vendor|node_modules)\//;

/** The documentation files the candidate adds or changes: docs, changelog, ADRs, README. Generated files are skipped. */
export function documentationPaths(paths: readonly string[]): string[] {
  return paths.filter((p) => DOC_PATH.test(p) && !GENERATED.test(p) && !isLockfilePath(p)).sort();
}

async function artifactPacket(ctx: RunContext, cand: CandidateRecord, prBody: string | null): Promise<{ cwd: string; task: string[]; blocks: { label: string; content: string }[] }> {
  const changed = await changedFiles(ctx, cand);
  const docs = documentationPaths([...changed.keys()]);
  const diffs: { label: string; content: string }[] = [];
  for (const p of docs) diffs.push({ label: `change to ${p}`, content: await git(ctx.run.repoRoot, ['diff', '--no-renames', '--no-ext-diff', ctx.run.baseRevision!, cand.commitSha, '--', p]) });
  return {
    cwd: await proofCheckout(ctx, cand),
    task: [
      'This is an artifact check of the exact candidate in this read-only checkout. People read the pull request body and the documents, not the diff: check each sentence below that describes behaviour against what the candidate does.',
      'For each sentence that describes behaviour, a command, an option or a state the candidate does not have (a removed or renamed name, a different number or default, a step that no longer happens), report one finding: id DOC-1, DOC-2, ..., severity high, category documentation, location the file and line (PULL-REQUEST for the pull request body), evidence the sentence exactly, claim what the candidate does instead.',
      'If the candidate removes or renames a command, option or state, also search the documents it does not touch for that name and report each mention the same way. Do not otherwise search untouched documents for staleness.',
      'When every sentence matches the candidate, answer APPROVE with no finding.',
    ],
    blocks: [{ label: 'pull request body', content: prBody ?? '(no pull request in this delivery mode)' }, { label: 'changed documents', content: docs.length === 0 ? '(none)' : docs.join('\n') }, ...diffs],
  };
}

/** A read-only checkout of the candidate, shared by the conformance and artifact sessions of the tree. */
async function proofCheckout(ctx: RunContext, cand: CandidateRecord): Promise<string> {
  const dir = join(runWorktreeRoot(ctx), `proof-${cand.seq}`);
  if (!existsSync(join(dir, '.git'))) {
    rmSync(dir, { recursive: true, force: true });
    await materializeCandidate(ctx.run.repoRoot, cand.commitSha, dir, { readOnly: true });
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Judging

async function judge(ctx: RunContext, cand: CandidateRecord, contract: GoalContract): Promise<ProofResult> {
  const ev = currentEvidenceReport(ctx.db, ctx.run.id, cand.id);
  const texts = new Map<string, string | null>();
  const file = async (p: string): Promise<string | null> => {
    if (!texts.has(p)) texts.set(p, await show(ctx.run.repoRoot, cand.commitSha, p));
    return texts.get(p)!;
  };
  const changed = await changedFiles(ctx, cand);
  const requirements = goalRequirements(ctx, contract);
  // Quoted paths are read before judging, so the judgement itself stays synchronous and pure.
  const callers = new Map<string, { function: string; callers: string[] } | null>();
  for (const r of requirements) {
    const a = answerOf(ctx, cand.treeHash, { kind: 'requirement', id: r.id });
    for (const f of a?.findings ?? []) {
      const range = parseRange(f.location);
      if (!range) continue;
      const { path, start, end } = range;
      const text = await file(path);
      const key = `${path}:${start}-${end}`;
      if (text === null || callers.has(key)) continue;
      const fn = enclosingFunction(text, start);
      const lines = changed.get(path);
      // Only a function the candidate changes: some changed line lies inside it (FR-008).
      const isChanged = fn !== null && lines !== undefined && [...lines].some((l) => l >= fn.start && l <= fn.end);
      callers.set(key, fn && isChanged ? { function: `${fn.name} (${path}:${fn.start})`, callers: await callersOf(ctx, cand, fn.name, { path, line: fn.start }) } : null);
    }
  }
  return judgeProof({
    treeHash: cand.treeHash,
    criteria: contract.acceptance_criteria.map((c) => {
      const kind = criterionKind(c);
      const a = kind === 'person' ? null : answerOf(ctx, cand.treeHash, { kind: 'criterion', id: c.id });
      return { id: c.id, statement: c.statement, kind, tests: c.tests ?? [], ui: c.ui === true, failBefore: ev?.report.acceptance_evidence.find((e) => e.criterion_id === c.id)?.fail_before ?? null, audit: a };
    }),
    requirements: requirements.map((r) => ({
      id: r.id,
      wording: r.wording,
      answer: answerOf(ctx, cand.treeHash, { kind: 'requirement', id: r.id }) ?? { verdict: null, findings: [], missing: 'no conformance answer was recorded' },
      file: (p) => texts.get(p) ?? null,
      callers: (p, start, end) => callers.get(`${p}:${start}-${end}`) ?? null,
    })),
    artifacts: answerOf(ctx, cand.treeHash, { kind: 'artifacts', id: 'ARTIFACTS' }),
  });
}

// ---------------------------------------------------------------------------
// Repair

interface ProofRepairRecord {
  attempt: number;
  tree_hash: string;
  candidate_id: string;
  fingerprint: string;
}

function proofRepairs(ctx: RunContext): ProofRepairRecord[] {
  return ctx.db.all<{ data_json: string | null }>('SELECT data_json FROM events WHERE run_id = ? AND type = ? ORDER BY id', ctx.run.id, PROOF_REPAIR_EVENT).map((r) => JSON.parse(r.data_json ?? '{}') as ProofRepairRecord);
}

/** DELIVERING -> REPAIRING with one brief naming every open result, within the attempt budget. */
async function repair(ctx: RunContext, cand: CandidateRecord, result: ProofResult): Promise<StepResult> {
  const contract = assertContract(ctx);
  const ledger = ctx.ledger!;
  const open = clipAtWord(result.open.join('; '), 1500);
  const outcome = { proof: { tree_hash: cand.treeHash, open: result.open } };
  const fingerprint = `proof:${sha256(JSON.stringify(result.open)).slice(0, 16)}`;
  const next = currentAttempt(ctx) + 1;
  // A repair that already ran and left exactly the same results open made no progress; another attempt would start from
  // the same brief. (A repair recorded for the next attempt and not yet started is this step's own, met again.)
  const last = proofRepairs(ctx).at(-1);
  if (last && last.attempt < next && last.fingerprint === fingerprint) {
    return finishRun(ctx, 'EXHAUSTED', clipAtWord(`non-progress: the repair of tree ${last.tree_hash.slice(0, 12)} left the same proof results open on tree ${cand.treeHash.slice(0, 12)}: ${open}`, 2000), { outcome });
  }
  const att = ledger.state('implementation_attempts');
  if (att.used >= att.hard_cap) return finishRun(ctx, 'EXHAUSTED', clipAtWord(`implementation attempts hard cap reached (${att.used} of ${att.hard_cap}) with the candidate not done: ${open}`, 2000), { data: { counter: 'implementation_attempts' }, outcome });
  if (att.used >= att.allowance && !ctx.db.get('SELECT 1 AS x FROM decisions WHERE id = ?', `dec-${ctx.run.id}-extension-${next}`)) {
    const history = attemptHistory(ctx);
    const cur = history.at(-1) ?? null;
    const p = cur ? progressSince(history.length >= 2 ? history[history.length - 2]! : null, cur) : null;
    const decision = ledger.requestExtension({
      counter: 'implementation_attempts',
      progress: { ...(p ? { newly_supported_criteria: p.newly_supported_criteria, fixed_checks: p.fixed_checks } : {}), localized_fault: null },
      hypothesisIsNew: last?.fingerprint !== fingerprint,
      withinScope: true,
      failureRemains: true,
      nextExperiment: 'repair each open proof result the brief names',
      reason: `${result.open.length} proof result(s) open on tree ${cand.treeHash.slice(0, 12)}`,
      role: 'implementer',
    });
    const rec = extensionDecisionRecord(decision);
    decide(ctx, { id: `dec-${ctx.run.id}-extension-${next}`, kind: rec.kind, summary: rec.summary, data: rec.data });
    if (decision.decision === 'deny_extension') return finishRun(ctx, 'EXHAUSTED', clipAtWord(`implementation attempt allowance spent (${att.used} of ${att.allowance}) and no extension for the proof repair: ${decision.denied_because.join('; ')}; open: ${open}`, 2000), { outcome: { ...outcome, extension: decision } });
  }
  const brief = proofBrief(contract, cand, result, fingerprint);
  const stored: StoredBrief = { attempt: next, source: 'proof', fingerprint, brief };
  if (!existsSync(briefPath(ctx, next))) atomicWriteJson(briefPath(ctx, next), stored);
  ctx.db.tx(() => {
    if (ctx.db.get("SELECT 1 AS x FROM events WHERE run_id = ? AND type = ? AND json_extract(data_json, '$.attempt') = ?", ctx.run.id, PROOF_REPAIR_EVENT, next)) return;
    appendEvent(ctx.db, ctx.run.id, PROOF_REPAIR_EVENT, ctx.ownerId, { attempt: next, tree_hash: cand.treeHash, candidate_id: cand.id, fingerprint } satisfies ProofRepairRecord, ctx.clock.now());
  });
  decide(ctx, { id: `dec-${ctx.run.id}-brief-${next}`, kind: 'repair.brief', summary: clipAtWord(`repair brief (proof) for attempt ${next}: ${open}`, 2000), data: { attempt: next, source: 'proof', open: result.open, path: `briefs/attempt-${next}.json` } });
  return move(ctx, 'REPAIRING', clipAtWord(`delivery waits: candidate ${cand.seq} is not done (${result.open.length} open proof result(s)); brief for attempt ${next}`, 500), { data: { attempt: next, open: result.open.length } });
}

function proofBrief(contract: GoalContract, cand: CandidateRecord, result: ProofResult, fingerprint: string): RepairBrief {
  const red = (s: string) => redact(s);
  const items = [
    ...result.criteria.filter((c) => c.status === 'unproven').map((c) => `${c.criterion_id} (mapped tests: ${c.tests.join(', ') || 'none'}) is unproven: ${c.reason}. Make its mapped tests assert the criterion itself, so they fail on the base revision and would fail if the criterion were false.`),
    ...result.requirements.filter((r) => r.status === 'unmet').map((r) => `${r.id} "${r.wording}" is unmet: ${r.reason}. Implement its exact wording.`),
    ...result.caller_findings.map((f) => `${f.id}${f.location ? ` at ${f.location}` : ''}: ${f.claim}. Keep that caller's behaviour, unless a requirement asks for the change.`),
    ...result.artifact_findings.map((f) => `${f.id}${f.location ? ` at ${f.location}` : ''}: "${f.sentence}": ${f.claim}. Change the sentence or the code so that they agree.`),
  ].map(red);
  return {
    fingerprint,
    evidence: [`proof results open on tree ${cand.treeHash.slice(0, 12)} (proof/${cand.seq}.json)`, ...items.map((i) => clipAtWord(i, 1000))].slice(0, 40),
    hypotheses: items.slice(0, 10).map((i) => ({ statement: clipAtWord(i, 500), supporting: 'the criterion audit, conformance check or artifact check of this tree' })),
    experiment: 'For each item, change the test, the code or the document it names, then check that the mapped tests fail on the base revision and pass on the candidate',
    expected_observation: 'Every criterion is proven by its own mapped tests, every MUST is implemented as worded, and every document sentence matches the candidate',
    scoped_fix: 'Repair exactly the items listed, without changing behaviour no criterion or requirement covers',
    post_fix_checks: [...contract.required_check_ids],
    preserved_constraints: [`Stay within the allowed paths: ${contract.allowed_paths.join(', ')}.`, 'Do not weaken, skip or delete existing tests or assertions.', 'Keep each criterion\'s tests at the paths the contract maps to it.', ...contract.non_goals.slice(0, 10).map((g) => `Non-goal: ${g}`)],
  };
}
