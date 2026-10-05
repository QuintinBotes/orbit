import { describe, expect, it } from 'vitest';
import { UI_ARTIFACT_KINDS, UI_JOURNEY_STATUSES, UI_RUN_VERDICTS } from '../../../src/ui/types.ts';

describe('UI vocabularies', () => {
  it('are runtime lists other modules can validate against', () => {
    expect(UI_JOURNEY_STATUSES).toEqual(['PASSED', 'FAILED', 'FLAKY', 'SKIPPED', 'TIMED_OUT', 'INTERRUPTED']);
    expect(UI_RUN_VERDICTS).toEqual(['PASS', 'FAIL', 'BLOCKED', 'ERROR', 'TIMEOUT', 'CANCELLED']);
    expect(UI_ARTIFACT_KINDS).toContain('screenshot');
    expect(UI_ARTIFACT_KINDS.at(-1)).toBe('other');
    expect(new Set(UI_ARTIFACT_KINDS).size).toBe(UI_ARTIFACT_KINDS.length);
  });
});
