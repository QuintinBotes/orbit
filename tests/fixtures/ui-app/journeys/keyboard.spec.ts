import { expect, expectKeyboardReachable, test } from './orbit-fixtures.ts';

// The toolbar must be operable without a pointer: the filter first, then the
// export button, each with a visible focus indicator.
test('reports-keyboard', async ({ page }) => {
  await page.goto('/reports');
  await expect(page.locator('#count')).toHaveText('6 reports');
  await expectKeyboardReachable(page, ['#status', '#export']);
});
