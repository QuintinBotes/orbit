import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeLab, type Lab } from './lab.ts';

const labs: Lab[] = [];
const servers: Server[] = [];
afterEach(() => {
  labs.splice(0).forEach((l) => l.close());
  servers.splice(0).forEach((s) => s.closeAllConnections?.() ?? s.close());
});

describe('orbit learn ingest from a URL', () => {
  it('stops reading a body that never ends instead of buffering it', async () => {
    const l = makeLab();
    labs.push(l);
    mkdirSync(join(l.repo, '.orbit'), { recursive: true });
    writeFileSync(join(l.repo, '.orbit', 'config.yaml'), 'version: 1\nmode: autonomous\nisolation: {provider: none, allow_unisolated: true}\nknowledge:\n  enabled: true\n');
    let sent = 0;
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' }); // no content-length: chunked
      const chunk = Buffer.alloc(64 * 1024, 97);
      const pump = (): void => {
        while (sent < 400 * 1024 * 1024) {
          sent += chunk.length;
          if (!res.write(chunk)) return void res.once('drain', pump);
        }
        res.end();
      };
      res.on('close', () => undefined);
      pump();
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/big`;
    const r = await l.cli(['learn', 'ingest', url, '--print-task']);
    expect(r.code, r.out + r.err).toBe(4);
    expect(r.err).toMatch(/larger than/);
    // Socket buffers add some slack, but nowhere near the whole 400 MB body.
    expect(sent).toBeLessThan(40 * 1024 * 1024);
  });
});
