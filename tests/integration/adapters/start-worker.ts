// A stand-in controller for the reattach test: starts one worker through
// ClaudeAdapter, prints "started", then waits to be killed. The spec comes in
// ORBIT_TEST_START_WORKER, not argv, so no command-line argument reaches the
// adapter's schema check (CodeQL js/regex-injection).
import { ClaudeAdapter, type ClaudeTaskSpec } from '../../../src/adapters/claude.ts';

const { spec, command } = JSON.parse(process.env.ORBIT_TEST_START_WORKER!) as { spec: ClaudeTaskSpec; command: string[] };
const adapter = new ClaudeAdapter({ command, tier: 'claude-sandbox', graceMs: 300, baseEnv: { PATH: process.env.PATH, HOME: process.env.HOME } });
const handle = await adapter.startTask(spec);
process.stdout.write(`started ${handle.pid}\n`);
setInterval(() => {}, 1_000);
