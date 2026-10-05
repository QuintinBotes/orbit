import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// G34: the deviation from spec section 13 is recorded, with its reasons.
const adr = readFileSync(new URL('../../../docs/decisions/0004-ui-config.md', import.meta.url), 'utf8');

describe('docs/decisions/0004-ui-config.md', () => {
  it('records the decision, the reasons and the consequences', () => {
    expect(adr).toMatch(/^# 0004\. /);
    expect(adr).toMatch(/^Status: accepted/m);
    for (const heading of ['## Context', '## Decision', '## Why not the spec\'s shape', '## Consequences']) expect(adr).toContain(heading);
  });
  it('names what replaced the spec keys', () => {
    for (const term of ['journey_check_ids', 'journeys[].id', 'artifacts:', 'ORBIT_A11Y_FAIL_ON', 'expectKeyboardReachable', 'ui.exploration', 'UI_ENFORCEMENT_VERSION']) expect(adr).toContain(term);
  });
  it('has no em or en dashes', () => {
    expect(adr).not.toMatch(/[\u2013\u2014]/);
  });
});
