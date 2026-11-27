// Child process for spend-file-atomic.test.ts: writes one spend file and, when asked, is killed at the rename, after the
// temporary file is written and before it takes the file's name.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const [path, title, kill] = process.argv.slice(2);
if (kill === 'kill') {
  fs.renameSync = () => {
    process.kill(process.pid, 'SIGKILL');
  };
  syncBuiltinESMExports();
}
const { writeSpendFile } = await import('../../../src/controller/spend-request.ts');
writeSpendFile(path!, { title: title!, usd: 24, tradeoff: 't', recommendation: 'r', command: 'c', at: '2031-01-01T00:00:00.000Z' });
