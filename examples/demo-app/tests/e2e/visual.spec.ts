import { expect, test } from './orbit-fixtures.ts';

// The baseline covers the table only. Toolbar and footer change with features (a new button, a
// new total) and are asserted by behaviour journeys instead of pixels.
test('reports-visual', async ({ page }) => {
  await page.goto('/reports');
  await page.locator('#reports-table tbody tr').first().waitFor();
  await expect(page.locator('#reports-table')).toHaveScreenshot('reports-table.png');
});
