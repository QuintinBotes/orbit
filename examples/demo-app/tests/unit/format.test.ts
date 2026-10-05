import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatAmount, statusLabel } from '../../src/reports/format.ts';

describe('formatAmount', () => {
  it('formats cents as dollars with two decimals', () => {
    assert.equal(formatAmount(0), '$0.00');
    assert.equal(formatAmount(5), '$0.05');
    assert.equal(formatAmount(123456), '$1,234.56');
    assert.equal(formatAmount(100000000), '$1,000,000.00');
  });

  it('keeps the sign of a negative amount', () => {
    assert.equal(formatAmount(-250), '-$2.50');
  });
});

describe('statusLabel', () => {
  it('capitalises each status', () => {
    assert.deepEqual([statusLabel('open'), statusLabel('closed'), statusLabel('draft')], ['Open', 'Closed', 'Draft']);
  });
});
