/** `orbit policy show <run-id>`: the frozen policy a run is acting under, and whether it still verifies. */
import { OrbitError } from '../../core/errors.ts';
import { redactValue } from '../../core/redact.ts';
import { verifySnapshot } from '../../policy/snapshot.ts';
import { listAmendments } from '../../inquisition/index.ts';
import type { Args } from '../args.ts';
import { findRunByPrefix, resolveRepo, withState, type CliContext } from '../context.ts';
import { EXIT, UsageError } from '../exit.ts';
import { json, line } from '../io.ts';

export async function policyShowCommand(args: Args, ctx: CliContext): Promise<number> {
  const [id] = args.expect(1);
  if (!id) throw new UsageError('a run id is required', 'orbit policy show <run-id>');
  const repo = await resolveRepo(ctx, args.str('repo'));
  return withState(repo, (db) => {
    const run = findRunByPrefix(db, id);
    // A snapshot that no longer matches its recorded hash is reported, never shown as if it were authoritative.
    const snap = verifySnapshot(run.policyPath, run.policyHash);
    const amendments = listAmendments(db, run.id).map((a) => ({ id: a.id, status: a.status, field: a.record.field, reason: a.record.reason, approved_by: a.approvedBy }));
    if (args.bool('json')) {
      json(ctx.io, { run_id: run.id, policy_hash: run.policyHash, policy_path: run.policyPath, verified: true, snapshot: redactValue(snap), amendments });
      return EXIT.OK;
    }
    const c = snap.config;
    const on = (o: Record<string, boolean>) => Object.entries(o).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none';
    const off = (o: Record<string, boolean>) => Object.entries(o).filter(([, v]) => !v).map(([k]) => k).join(', ') || 'none';
    line(ctx.io, `policy of run ${run.id} (verified against hash ${run.policyHash})`);
    line(ctx.io, `file:        ${run.policyPath}`);
    line(ctx.io, `mode:        ${c.mode}`);
    line(ctx.io, `scope:       may edit ${c.scope.allowed_paths.join(', ') || 'nothing'}`);
    line(ctx.io, `protected:   ${snap.effective_protected_paths.join(', ')}`);
    line(ctx.io, `actions on:  ${on(c.actions)}`);
    line(ctx.io, `actions off: ${off(c.actions)}`);
    line(ctx.io, `network:     ${c.network.allowed_hosts.join(', ') || 'none'}`);
    line(ctx.io, `isolation:   ${c.isolation.provider}${c.isolation.allow_unisolated ? ' (unisolated runs allowed)' : ''}`);
    line(ctx.io, `models:      ${c.routing.allowed_models.join(', ') || 'none'}`);
    line(ctx.io, `providers:   ${Object.entries(c.providers).map(([k, v]) => `${k}${v.data_policy_eligible ? '' : ' (not data-policy eligible)'}`).join(', ')}`);
    line(ctx.io, `review:      independent provider ${c.review.independent_provider_required ? 'required' : 'not required'}, preferred ${c.review.preferred_provider}`);
    line(ctx.io, `delivery:    ${c.delivery.provider}, pull request ${c.delivery.pull_request}, up to ${c.delivery.max_ci_repair_cycles} CI repair cycle(s)`);
    line(ctx.io, `checks:      ${Object.values(c.checks).map((k) => `${k.id}${k.mandatory ? '' : ' (optional)'}`).join(', ') || 'none defined'}`);
    const h = c.scheduler.hard_limits;
    line(ctx.io, `hard limits: ${h.implementation_attempts} attempts, ${h.wall_minutes} min, $${h.model_cost_usd}, ${h.parallel_workers} parallel workers, ${h.changed_files} files, ${h.changed_lines} lines, ${h.ci_repair_cycles} CI repair cycles`);
    line(ctx.io, `knowledge:   ${c.knowledge.enabled ? 'on' : 'off'}${c.knowledge.share_globally ? ', shares code-free lessons globally' : ''}`);
    line(ctx.io, `amendments:  ${amendments.length === 0 ? 'none' : amendments.map((a) => `${a.id} [${a.status}] ${a.field}`).join(', ')}`);
    return EXIT.OK;
  }).catch((err: unknown) => {
    if (err instanceof OrbitError && err.code === 'POLICY_TAMPERED') ctx.io.err('The frozen policy does not match its recorded hash; the run cannot act under it. Nothing below it can be trusted.\n');
    throw err;
  });
}
