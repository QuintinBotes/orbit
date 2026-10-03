/**
 * Named fault-injection points for the fault-injection suite. Production code
 * calls `faultPoint('delivery.pr.after-create')` at places where a crash or a
 * lost response matters; tests set ORBIT_FAULTS to make that point misbehave.
 *
 *   ORBIT_FAULTS="controller.transition.after-commit=crash,delivery.pr.after-create=lose-response"
 *
 * Actions:
 *   crash          exit the process immediately with code 137, as SIGKILL would
 *   throw          throw an Error from the call site
 *   lose-response  return 'lose-response' so the caller discards a result it already caused
 *   hang           block for an hour (the test kills the process)
 *
 * A point fires once per process unless suffixed with `*` (`=crash*`).
 * When ORBIT_FAULTS is unset this is a single Map lookup.
 */
export type FaultAction = 'crash' | 'throw' | 'lose-response' | 'hang';

let parsed: Map<string, { action: FaultAction; repeat: boolean }> | null = null;
const fired = new Set<string>();

function table(): Map<string, { action: FaultAction; repeat: boolean }> {
  if (parsed) return parsed;
  parsed = new Map();
  for (const item of (process.env.ORBIT_FAULTS ?? '').split(',')) {
    const [point, raw] = item.split('=');
    if (!point || !raw) continue;
    const repeat = raw.endsWith('*');
    const action = raw.replace(/\*$/, '') as FaultAction;
    if (['crash', 'throw', 'lose-response', 'hang'].includes(action)) parsed.set(point.trim(), { action, repeat });
  }
  return parsed;
}

export function faultPoint(point: string): 'lose-response' | undefined {
  const entry = table().get(point);
  if (!entry) return undefined;
  if (!entry.repeat && fired.has(point)) return undefined;
  fired.add(point);
  switch (entry.action) {
    case 'crash':
      process.stderr.write(`orbit: fault injected at ${point}: crash\n`);
      process.exit(137);
    // eslint-disable-next-line no-fallthrough
    case 'throw':
      throw new Error(`fault injected at ${point}`);
    case 'hang':
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3_600_000);
      return undefined;
    case 'lose-response':
      return 'lose-response';
  }
}

/** For tests that set ORBIT_FAULTS in-process. */
export function resetFaults(): void {
  parsed = null;
  fired.clear();
}
