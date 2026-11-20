/**
 * What `orbit bench --without <stage>` may turn off (FR-006 of #172), and the gates it never may. A stage is off for
 * every scenario of the run; the scorecard then compares the same scenarios with and without it.
 */
import type { ControllerDeps } from '../controller/context.ts';
import type { OrbitConfig } from '../policy/types.ts';

export interface StageOff {
  what: string;
  deps?: Partial<ControllerDeps>;
  tweak?: (c: OrbitConfig) => void;
}

export const BENCH_STAGES: Readonly<Record<string, StageOff>> = {
  diagnosis: { what: 'the verifier session that writes the repair brief; without it the brief is the failure records as they are', deps: { withoutDiagnosis: true } },
  'fail-before': { what: 'running the new tests on the base revision (verification.fail_before off)', tweak: (c) => void (c.verification = { ...c.verification, fail_before: 'off' }) },
};

/** A run without these is not Orbit, so no comparison may turn them off. */
export const FIXED_GATES: Readonly<Record<string, string>> = {
  scope: 'scope inspection: allowed and protected paths, size limits',
  secrets: 'the secret scan of every candidate',
  verification: 'the trusted checks and the evidence report every delivery rests on',
};

/** The stage `name` names, or why it cannot be turned off. */
export function stageOff(name: string): StageOff {
  const stage = BENCH_STAGES[name];
  if (stage) return stage;
  const known = `stages that can be turned off: ${Object.keys(BENCH_STAGES).join(', ')}`;
  if (FIXED_GATES[name]) throw new Error(`${name} is a gate no bench may turn off (${FIXED_GATES[name]}); ${known}`);
  throw new Error(`unknown stage "${name}"; ${known}`);
}
