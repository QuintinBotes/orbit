import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectNoSeriousA11yViolations, test } from './orbit-fixtures.ts';

const baselinePath = join(dirname(fileURLToPath(import.meta.url)), 'a11y-baseline.json');

test('reports-accessibility', async ({ page }) => {
  await page.goto('/reports');
  await page.locator('#reports-table tbody tr').first().waitFor();
  await expectNoSeriousA11yViolations(page, { baselinePath });
});
