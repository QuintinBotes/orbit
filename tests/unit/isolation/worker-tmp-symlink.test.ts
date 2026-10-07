// A sandboxed process can replace its own temp directory with a link; the next process that reuses that directory (a
// worker after a controller restart, an approved operation, a release command) must not follow it: the sandbox would
// make the link's target writable and prepareWorkerTmpDir would change the target's mode.
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareFreshTmpDir, prepareWorkerTmpDir, workerTmpDir } from '../../../src/isolation/profiles.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function lab(): { root: string; target: string; worker: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-tmp-link-')));
  dirs.push(base);
  const root = join(base, 'root');
  mkdirSync(root, { mode: 0o700 });
  chmodSync(root, 0o700);
  const target = join(base, 'elsewhere');
  mkdirSync(target);
  chmodSync(target, 0o755);
  writeFileSync(join(target, 'keep.txt'), 'kept\n');
  return { root, target, worker: join(base, 'worker-1') };
}

describe('prepareWorkerTmpDir and a link in place of the temp directory', () => {
  it('replaces a link with a private directory: the target keeps its mode and is not the directory returned', () => {
    const { root, target, worker } = lab();
    symlinkSync(target, workerTmpDir(worker, root));
    const dir = prepareWorkerTmpDir(worker, root);
    expect(lstatSync(dir).isSymbolicLink()).toBe(false);
    expect(lstatSync(dir).isDirectory()).toBe(true);
    expect(realpathSync(dir)).not.toBe(realpathSync(target));
    expect(statSync(target).mode & 0o777).toBe(0o755);
    expect(statSync(join(target, 'keep.txt')).isFile()).toBe(true);
  });

  it('replaces a file in place of the temp directory', () => {
    const { root, worker } = lab();
    writeFileSync(workerTmpDir(worker, root), 'not a directory\n');
    const dir = prepareWorkerTmpDir(worker, root);
    expect(lstatSync(dir).isDirectory()).toBe(true);
  });

  it('prepareFreshTmpDir empties the directory and never reaches through a link', () => {
    const { root, target, worker } = lab();
    symlinkSync(target, workerTmpDir(worker, root));
    const dir = prepareFreshTmpDir(worker, root);
    expect(lstatSync(dir).isSymbolicLink()).toBe(false);
    expect(statSync(join(target, 'keep.txt')).isFile()).toBe(true);
    expect(statSync(target).mode & 0o777).toBe(0o755);
  });

  it('keeps an existing private directory and its contents', () => {
    const { root, worker } = lab();
    const first = prepareWorkerTmpDir(worker, root);
    writeFileSync(join(first, 'state'), 'x');
    expect(prepareWorkerTmpDir(worker, root)).toBe(first);
    expect(statSync(join(first, 'state')).isFile()).toBe(true);
    expect(statSync(first).mode & 0o777).toBe(0o700);
  });
});
