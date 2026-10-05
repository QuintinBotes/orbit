import { expect, test } from './orbit-fixtures.ts';

test('reports-visual', async ({ page }) => {
  await page.goto('/reports');
  await page.locator('#rows tr').first().waitFor();
  await expect(page).toHaveScreenshot('reports.png');
});
