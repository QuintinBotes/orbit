// Child process for exec.test.ts: starts a long-lived detached process, prints
// its pid and then has nothing left to do. It must exit promptly anyway.
import { writeSync } from 'node:fs';
import { spawnDetached } from '../../../../src/core/exec.ts';

const [out] = process.argv.slice(2);
const { pid } = spawnDetached([process.execPath, '-e', 'setTimeout(() => {}, 30000)'], { stdoutPath: out!, stderrPath: out! });
writeSync(1, String(pid));
