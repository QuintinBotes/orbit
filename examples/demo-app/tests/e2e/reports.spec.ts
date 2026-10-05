import { expect, test } from './orbit-fixtures.ts';

// Journey ids mirror the spec: open the page, filter, page through, assert what the user sees.
test('reports-filter', async ({ page }) => {
  await test.step('Open reports', async () => {
    await page.goto('/reports');
    await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible();
    await expect(page.locator('#summary')).toHaveText('Showing 1-10 of 47 reports');
    await expect(page.locator('#reports-table tbody tr')).toHaveCount(10);
  });
  await test.step('Filter by status', async () => {
    await page.getByLabel('Status').selectOption('closed');
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await expect(page).toHaveURL(/status=closed/);
    await expect(page.locator('#summary')).toHaveText('Showing 1-10 of 16 reports');
    await expect(page.locator('#reports-table tbody tr td:nth-child(4)').first()).toHaveText('Closed');
  });
  await test.step('Search by text', async () => {
    await page.getByLabel('Search').fill('audit');
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await expect(page.locator('#reports-table tbody tr')).not.toHaveCount(0);
    await expect(page.locator('#reports-table tbody')).toContainText('audit', { ignoreCase: true });
  });
  await test.step('A search with no match shows the empty state', async () => {
    await page.getByLabel('Search').fill('no such report');
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await expect(page.locator('#empty')).toHaveText('No reports match your filters.');
  });
});

test('reports-pagination', async ({ page }) => {
  await page.goto('/reports');
  await expect(page.locator('#page-of')).toHaveText(/^Page 1 of \d+$/);
  await page.getByRole('link', { name: 'Next' }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page.locator('#summary')).toHaveText('Showing 11-20 of 47 reports');
  await expect(page.locator('#reports-table tbody tr').first().locator('td').first()).toHaveText('R-110');
  await page.getByRole('link', { name: 'Previous' }).click();
  await expect(page.locator('#summary')).toHaveText('Showing 1-10 of 47 reports');
});
