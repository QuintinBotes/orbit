// Child process for fsx.test.ts: reads the file in a tight loop until the
// stop file appears and reports every read that was not one whole version.
import { existsSync, readFileSync, writeSync } from 'node:fs';

const [path, stopPath, sizeArg] = process.argv.slice(2);
const size = Number(sizeArg);
let reads = 0;
let missing = 0;
let torn = 0;
const deadline = Date.now() + 30_000;
while (!existsSync(stopPath!) && Date.now() < deadline) {
  let data: string;
  try {
    data = readFileSync(path!, 'utf8');
  } catch {
    missing++;
    continue;
  }
  reads++;
  const first = data[0];
  if (data.length !== size || !first || data !== first.repeat(size)) torn++;
}
writeSync(1, JSON.stringify({ reads, missing, torn }));
