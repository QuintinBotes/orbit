import { describe, expect, it } from 'vitest';
import { RESUMABLE_STATES, RUN_STATES, TERMINAL_STATES, allowedTransitions, canTransition, isRunState, isTerminal } from '../../../src/controller/states.ts';

describe('the run state machine', () => {
  it('lists the edges out of each state, and an edge is allowed exactly when it is listed', () => {
    for (const from of RUN_STATES) {
      const edges = allowedTransitions(from);
      for (const to of RUN_STATES) expect(canTransition(from, to), `${from} -> ${to}`).toBe(edges.includes(to));
    }
  });

  it('ends nothing but BLOCKED once terminal, and BLOCKED resumes to every working stage', () => {
    for (const s of ['SUCCEEDED', 'EXHAUSTED', 'IMPOSSIBLE', 'CANCELLED'] as const) expect(allowedTransitions(s)).toEqual([]);
    expect(allowedTransitions('BLOCKED')).toEqual(expect.arrayContaining(['PREFLIGHT', 'IMPLEMENTING', 'AWAITING_CI', 'INQUISITION', 'CANCELLED']));
    expect([...RESUMABLE_STATES]).toEqual(['BLOCKED']);
    expect([...TERMINAL_STATES].sort()).toEqual(['BLOCKED', 'CANCELLED', 'EXHAUSTED', 'IMPOSSIBLE', 'SUCCEEDED']);
    expect(isTerminal('BLOCKED')).toBe(true);
    expect(isTerminal('IMPLEMENTING')).toBe(false);
  });

  it('has no way to succeed without review, and every live state can be cancelled, blocked, exhausted or recovered', () => {
    expect(canTransition('VERIFYING', 'SUCCEEDED')).toBe(false);
    expect(canTransition('REVIEWING', 'SUCCEEDED')).toBe(true);
    for (const s of RUN_STATES.filter((x) => !isTerminal(x))) {
      for (const to of ['BLOCKED', 'EXHAUSTED', 'CANCELLED'] as const) expect(canTransition(s, to), `${s} -> ${to}`).toBe(true);
    }
    expect(canTransition('CREATED', 'IMPLEMENTING')).toBe(false);
  });

  it('recognises state names', () => {
    expect(isRunState('AWAITING_CI')).toBe(true);
    expect(isRunState('awaiting_ci')).toBe(false);
    expect(isRunState('nope')).toBe(false);
  });
});
