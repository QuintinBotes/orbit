/**
 * Process entry of the `orbit` executable: plugin/dist/orbit.mjs is this file,
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
  // A reader that goes away early (`orbit help | head -1`) is its own choice, not a failure of ours: leave quietly,
  // unless a foreground controller is driving a run, which keeps going with its output discarded (io.ts).
  // The hook branch above deliberately has no such handler: it fails closed on any error.
  // Loaded here, not at the top: the hook branch above must not depend on anything but hook.ts.
  const { onOutputStreamError } = await import('./io.ts');
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (err: NodeJS.ErrnoException) => onOutputStreamError(stream, err));
  }
  const { suppressSqliteExperimentalWarning } = await import('../core/warnings.ts');
  suppressSqliteExperimentalWarning();
  const { main } = await import('./cli.ts');
  process.exitCode = await main(argv);
}
