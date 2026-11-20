import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { freePort } from './helpers.ts';

// The first port the kernel hands out by itself, to listen(0) and to outgoing connections (macOS: net.inet.ip.portrange.first).
const ephemeralLow = process.platform === 'linux' ? Number(readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/)[0]) : 49152;

describe('freePort (#185)', () => {
  it('gives an application a port no other listen(0) on the machine can be handed before the application binds it', async () => {
    for (let i = 0; i < 20; i++) expect(await freePort()).toBeLessThan(ephemeralLow);
  });
});
