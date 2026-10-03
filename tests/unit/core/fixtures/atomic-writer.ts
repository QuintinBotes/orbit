// Child process for fsx.test.ts: rewrites one file many times with
// alternating, equally sized contents while a reader watches it.
import { atomicWrite } from '../../../../src/core/fsx.ts';

const [path, countArg, sizeArg] = process.argv.slice(2);
const count = Number(countArg);
const size = Number(sizeArg);
const contents = ['A', 'B', 'C'].map((c) => c.repeat(size));
for (let i = 0; i < count; i++) atomicWrite(path!, contents[i % contents.length]!);
