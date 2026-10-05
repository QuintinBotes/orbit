/**
 * Stand-alone entry for the worker shim, for running it from source
 * (`node src/adapters/shim-main.ts ...` with Node's type stripping) in tests
 * and before the bundle exists. The shipped path is `orbit shim`, which calls
 * the same shimMain.
 */
import { shimMain } from './shim.ts';

process.exitCode = await shimMain(process.argv.slice(2));
