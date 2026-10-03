// Child process for proc.test.ts. Started by `sh -c 'node own-group.ts $$; true'`,
// so it is a member, not the leader, of the shell's process group, whose id
// arrives as argv[2]. Reports whether proc.ts would signal that group: a
// negative kill there would reach this very process. Only signal 0 is used.
import { writeSync } from 'node:fs';
import { isGroupAlive } from '../../../../src/core/proc.ts';

const pgid = Number(process.argv[2]);
let outcome: string;
try {
  isGroupAlive(pgid);
  outcome = 'allowed';
} catch (err) {
  outcome = /refusing/.test((err as Error).message) ? 'refused' : `error: ${(err as Error).message}`;
}
writeSync(1, JSON.stringify({ outcome, pid: process.pid, pgid }));
