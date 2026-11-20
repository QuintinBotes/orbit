/**
 * `orbit export <run-id> --otel`: a run as OpenTelemetry traces (src/observability/otel.ts), one OTLP/JSON request on
 * one line, the form a collector's otlpjsonfile receiver reads and its OTLP/HTTP receiver accepts at /v1/traces.
 * Read-only; it never carries prompt or source text.
 */
import { resolve } from 'node:path';
import { atomicWrite } from '../../core/fsx.ts';
import { exportRunOtel, GENAI_SEMCONV_VERSION } from '../../observability/otel.ts';
import type { Args, OptionSpec } from '../args.ts';
import { findRunByPrefix, resolveRepo, withState, type CliContext } from '../context.ts';
import { EXIT, UsageError } from '../exit.ts';
import { line } from '../io.ts';

export const EXPORT_USAGE = 'orbit export <run-id> --otel [--out file]';
export const EXPORT_OPTIONS: OptionSpec = {
  otel: { type: 'boolean', description: `OpenTelemetry traces (OTLP/JSON) under the GenAI semantic conventions ${GENAI_SEMCONV_VERSION}` },
  out: { type: 'string', description: 'write the export here instead of standard output', valueName: 'file' },
};

export async function exportCommand(args: Args, ctx: CliContext): Promise<number> {
  const [runRef] = args.expect(1);
  // The only format today; naming it keeps room for another without changing what this command means.
  if (!args.bool('otel')) throw new UsageError('name the format to export: --otel', EXPORT_USAGE);
  const repo = await resolveRepo(ctx, args.str('repo'));
  return withState(repo, (db) => {
    const run = findRunByPrefix(db, runRef!);
    const text = `${JSON.stringify(exportRunOtel(db, run, ctx.clock.now()))}\n`;
    const out = args.str('out');
    if (out) {
      atomicWrite(resolve(ctx.cwd, out), text);
      line(ctx.io, `exported run ${run.id} as OpenTelemetry traces (semantic conventions ${GENAI_SEMCONV_VERSION}) to ${resolve(ctx.cwd, out)}`);
    } else ctx.io.out(text);
    return EXIT.OK;
  });
}
