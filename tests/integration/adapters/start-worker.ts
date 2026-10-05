// A stand-in controller for the reattach test: starts one worker through
// ClaudeAdapter, prints "started", then waits to be killed.
import { ClaudeAdapter, type ClaudeTaskSpec } from '../../../src/adapters/claude.ts';

const { spec, command } = JSON.parse(process.argv[2]!) as { spec: ClaudeTaskSpec; command: string[] };
const adapter = new ClaudeAdapter({ command, tier: 'claude-sandbox', graceMs: 300, baseEnv: { PATH: process.env.PATH, HOME: process.env.HOME } });
const handle = await adapter.startTask(spec);
process.stdout.write(`started ${handle.pid}\n`);
setInterval(() => {}, 1_000);
