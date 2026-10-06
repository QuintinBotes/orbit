/**
 * `orbit notify test` sends a test notification through the configured channels (ADR 0008), and
 * `readRemoteAnswers` lets `orbit resume` take the `/orbit answer` comments of a blocked run first, which is how a
 * remote answer reaches a run when no service is polling.
 */
import { dirname, resolve } from 'node:path';
import { isOrbitError } from '../../core/errors.ts';
import { redact } from '../../core/redact.ts';
import type { RunRecord } from '../../controller/run-store.ts';
import { listQuestions } from '../../inquisition/store.ts';
import { loadConfig, notificationsPolicy } from '../../policy/config.ts';
import { verifySnapshot } from '../../policy/snapshot.ts';
import type { OrbitDb } from '../../storage/db.ts';
import { resolveNotifyDeps, sendTestNotification } from '../../notify/notify.ts';
import { pollRemoteAnswers } from '../../notify/remote-answers.ts';
import type { Args, OptionSpec } from '../args.ts';
import { resolveRepo, type CliContext } from '../context.ts';
import { EXIT } from '../exit.ts';
import { json, line } from '../io.ts';

export const NOTIFY_TEST_OPTIONS: OptionSpec = {
  policy: { type: 'string', description: 'policy file to read the notifications section from (default: .orbit/config.yaml)', valueName: 'path' },
};

export const NOTIFY_TEST_USAGE = 'orbit notify test [--policy path] [--json]';

function depsOf(ctx: CliContext) {
  return resolveNotifyDeps({ hostEnv: ctx.env, ...(ctx.seams.notify ? { notify: ctx.seams.notify } : {}) });
}

export async function notifyTestCommand(args: Args, ctx: CliContext): Promise<number> {
  args.expect(0);
  const repo = await resolveRepo(ctx, args.str('repo'));
  const policy = args.str('policy');
  const config = loadConfig(repo, policy ? resolve(ctx.cwd, policy) : undefined);
  const outcomes = await sendTestNotification({ config, repoRoot: repo, deps: depsOf(ctx) });
  if (args.bool('json')) json(ctx.io, { outcomes });
  else for (const o of outcomes) line(ctx.io, `${o.channel}: ${o.status} (${o.detail})`);
  return outcomes.some((o) => o.status === 'failed') ? EXIT.FAILURE : EXIT.OK;
}

function errorText(err: unknown): string {
  return redact(isOrbitError(err) ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err)).slice(0, 300);
}

/**
 * Before `orbit resume` judges a BLOCKED run, read the `/orbit answer` comments its frozen policy allows. Never
 * throws: a failed read is said and the resume goes on by its usual rules.
 */
export async function readRemoteAnswers(ctx: CliContext, db: OrbitDb, run: RunRecord, say: (text: string) => void): Promise<void> {
  if (run.state !== 'BLOCKED' || listQuestions(db, run.id, { status: 'open' }).length === 0) return;
  let config;
  try {
    config = verifySnapshot(run.policyPath, run.policyHash).config;
  } catch {
    // An unverifiable policy authorizes nothing, remote answers included; resume reports the policy itself.
    return;
  }
  if (!notificationsPolicy(config).remote_answers.enabled) return;
  try {
    const client = await depsOf(ctx).threads(run.repoRoot, config);
    const report = await pollRemoteAnswers({ db, clock: ctx.clock, run, runDir: dirname(run.policyPath), config, client, actor: `cli:${ctx.user}` });
    for (const a of report.accepted) say(`recorded the answer to ${a.questionId} by ${a.author} (${a.permission}) from ${a.thread}`);
    for (const r of report.refused) say(`ignored a comment by ${r.author} on ${r.thread} (${r.reason})`);
    for (const e of report.errors) say(`could not read remote answers: ${e}`);
  } catch (err) {
    say(`could not read remote answers: ${errorText(err)}`);
  }
}
