import { readFileSync } from 'node:fs';
import { expect, test } from './orbit-fixtures.ts';

// Journey ids mirror the spec section 13 example: open, filter, export, assert name and contents.
test('reports-export', async ({ page }, testInfo) => {
  await test.step('Open reports', async () => {
    await page.goto('/reports');
    await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible();
  });
  await test.step('Apply a filter', async () => {
    await page.locator('#status').selectOption('open');
    await expect(page.locator('#count')).toHaveText('3 reports');
  });
  const downloadPromise = page.waitForEvent('download');
  await test.step('Trigger export', async () => {
    await page.getByRole('button', { name: 'Export CSV' }).click();
  });
  const download = await downloadPromise;
  const saved = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(saved);
  await test.step('Assert downloaded filename', async () => {
    expect(download.suggestedFilename()).toBe('reports-open.csv');
  });
  await test.step('Assert downloaded contents', async () => {
    const lines = readFileSync(saved, 'utf8').trim().split('\n');
    expect(lines[0]).toBe('id,name,status,amount');
    expect(lines.slice(1).map((l) => l.split(',')[0])).toEqual(['R-100', 'R-102', 'R-105']);
  });
});

test('reports-filter', async ({ page }) => {
  await page.goto('/reports');
  await expect(page.locator('#count')).toHaveText('6 reports');
  await page.locator('#status').selectOption('closed');
  await expect(page.locator('#count')).toHaveText('2 reports');
  await expect(page.locator('#rows tr')).toHaveCount(2);
});
