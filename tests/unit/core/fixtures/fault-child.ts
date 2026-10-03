// Child process for faults.test.ts. Calls one fault point `times` times and
// reports each outcome; output goes through writeSync so nothing is lost when
// the fault exits the process.
import { writeSync } from 'node:fs';
import { faultPoint } from '../../../../src/core/faults.ts';

const [point, timesArg] = process.argv.slice(2);
const times = Number(timesArg ?? '1');
writeSync(1, 'before\n');
const outcomes: string[] = [];
for (let i = 0; i < times; i++) {
  try {
    outcomes.push(faultPoint(point!) ?? 'none');
  } catch (err) {
    outcomes.push(`threw:${(err as Error).message}`);
  }
}
writeSync(1, `after ${JSON.stringify(outcomes)}\n`);
