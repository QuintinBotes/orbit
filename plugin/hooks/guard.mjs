// PreToolUse entry for the plugin. It is a no-op unless ORBIT_WORKER=1, so normal
// sessions pay only node startup. For workers it fails closed: exit code 2 is the
// default and any crash exits 2, because a missing or crashing guard exits with a
// non-blocking code and would silently disable enforcement. The real policy lives in
// the bundle; worker enforcement does not depend on this plugin (it is in --settings).
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

if (process.env.ORBIT_WORKER === '1') {
  process.exitCode = 2;
  const die = (err) => {
    process.stderr.write(`orbit guard failed closed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  };
  process.on('uncaughtException', die);
  process.on('unhandledRejection', die);
  const bundle = fileURLToPath(new URL('../dist/orbit.mjs', import.meta.url));
  if (!existsSync(bundle)) die(new Error(`bundle missing at ${bundle}`));
  process.argv = [process.argv[0], bundle, 'hook', 'pre-tool-use'];
  await import(bundle);
}
