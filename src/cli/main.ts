/**
 * Process entry of the `orbit` executable: dist/orbit.mjs is this file,
 * bundled, and it runs as soon as it is loaded (hooks/guard.mjs imports the
 * bundle after setting process.argv). The hook subcommand is dispatched
 * before anything else is loaded, so its fail-closed handlers are in place
 * even if the rest of Orbit cannot be imported. Everything else loads the
 * command table (cli.ts, which exports `main`) lazily.
 */
import { hookMain } from './hook.ts';

const argv = process.argv.slice(2);

if (argv[0] === 'hook') {
  await hookMain(argv.slice(1));
} else {
  const { suppressSqliteExperimentalWarning } = await import('../core/warnings.ts');
  suppressSqliteExperimentalWarning();
  const { main } = await import('./cli.ts');
  process.exitCode = await main(argv);
}
