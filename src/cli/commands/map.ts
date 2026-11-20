/**
 * `orbit map build` and `orbit map query <path...>`: the repository map of one revision (#175), built from git without
 * a model and cached by tree hash. Workers may run `map query` as a tool for structural questions; plain search stays
 * the default. The check links come from the repository's .orbit/config.yaml when it has one.
 */
import { isOrbitError } from '../../core/errors.ts';
import { loadConfig } from '../../policy/index.ts';
import { buildRepoMap, queryRepoMap, type MapChecks, type RepoMap } from '../../repomap/map.ts';
import type { Args, OptionSpec } from '../args.ts';
import { resolveRepo, type CliContext } from '../context.ts';
import { EXIT } from '../exit.ts';
import { json, line } from '../io.ts';

export const MAP_OPTIONS: OptionSpec = {
  rev: { type: 'string', description: 'revision to map (default: HEAD)', valueName: 'rev' },
};
export const MAP_BUILD_USAGE = 'orbit map build [--rev <rev>] [--json]';
export const MAP_QUERY_USAGE = 'orbit map query <path...> [--rev <rev>] [--json]';

async function mapOf(args: Args, ctx: CliContext): Promise<RepoMap> {
  const repo = await resolveRepo(ctx, args.str('repo'));
  let checks: MapChecks = {};
  try {
    checks = loadConfig(repo).checks;
  } catch (err) {
    if (!isOrbitError(err, 'NOT_FOUND')) throw err;
  }
  return buildRepoMap(repo, args.str('rev') ?? 'HEAD', { checks });
}

export async function mapBuildCommand(args: Args, ctx: CliContext): Promise<number> {
  args.expect(0);
  const map = await mapOf(args, ctx);
  if (args.bool('json')) {
    json(ctx.io, map);
    return EXIT.OK;
  }
  const count = (pick: (f: RepoMap['files'][number]) => number) => map.files.reduce((n, f) => n + pick(f), 0);
  line(ctx.io, `repository map of tree ${map.tree}: ${map.files.length} files, ${count((f) => (f.generated ? 1 : 0))} generated, ${count((f) => (f.test ? 1 : 0))} tests, ${count((f) => f.imports.length)} import edges, ${count((f) => f.tests.length)} test links, ${Object.keys(map.checks).length} checks`);
  line(ctx.io, map.build.cached ? 'served from the cache' : `built: ${map.build.parsed} files read, ${map.build.reused} reused from the cache`);
  return EXIT.OK;
}

export async function mapQueryCommand(args: Args, ctx: CliContext): Promise<number> {
  const paths = args.expect(1, Number.MAX_SAFE_INTEGER);
  const map = await mapOf(args, ctx);
  const results = paths.map((p) => queryRepoMap(map, p));
  if (args.bool('json')) {
    json(ctx.io, { tree: map.tree, results });
    return results.some((r) => r.kind === 'missing') ? EXIT.NOT_FOUND : EXIT.OK;
  }
  for (const r of results) {
    if (r.kind === 'missing') line(ctx.io, `${r.path || '.'}: not in tree ${map.tree.slice(0, 12)}`);
    for (const f of r.files) {
      line(ctx.io, `${f.path} (${f.size} bytes${f.generated ? ', generated' : ''}${f.test ? ', test' : ''})`);
      line(ctx.io, `  imports:     ${f.imports.join(', ') || 'none'}`);
      line(ctx.io, `  imported by: ${f.imported_by.join(', ') || 'none'}`);
      if (!f.test) line(ctx.io, `  tests:       ${f.tests.join(', ') || 'none linked'}`);
      line(ctx.io, `  checks:      ${f.checks.join(', ') || 'none name it'}`);
    }
  }
  return results.some((r) => r.kind === 'missing') ? EXIT.NOT_FOUND : EXIT.OK;
}
