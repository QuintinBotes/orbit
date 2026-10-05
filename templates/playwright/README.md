# Orbit Playwright fixtures

`orbit-fixtures.ts` is a template. Copy it into your repository's journeys directory (for example `e2e/orbit-fixtures.ts`) and import `test` and `expect` from it instead of from `@playwright/test`. Orbit never loads it from its own install: journeys are your code, and they must keep working without Orbit.

## Adopting it

1. Install the dependencies in your repository: `@playwright/test` and `@axe-core/playwright`. Pin `@playwright/test` exactly; browser revisions are tied to its version.
2. Copy `orbit-fixtures.ts` next to your journeys and change the imports:

   ```ts
   import { expect, expectNoSeriousA11yViolations, test } from './orbit-fixtures.ts';

   test('reports-export', async ({ page }) => {
     await test.step('Open reports', async () => {
       await page.goto('/reports');
     });
     // ...
   });
   ```

3. Check that your `playwright.config.ts` has what Orbit relies on:

   ```ts
   export default defineConfig({
     use: {
       baseURL: process.env.ORBIT_UI_BASE_URL ?? 'http://127.0.0.1:3000',
       trace: 'retain-on-failure',
       screenshot: 'only-on-failure',
     },
     // Include the platform: renderings differ between operating systems.
     snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{platform}/{testFilePath}/{arg}{ext}',
     projects: [
       { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
       { name: 'mobile', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
     ],
   });
   ```

   Orbit sets `ORBIT_UI_BASE_URL`, `ORBIT_UI_VIEWPORTS` and `ORBIT_UI_BROWSERS` (JSON) for the run, so a config may derive its projects from them.
4. Declare the journeys as a check of `kind: playwright` in `.orbit/config.yaml` and list it under `ui.journey_check_ids`. Keep the command to selection (`--config`, `--project`, a file filter). Orbit adds the flags that make the result trustworthy and rejects a command that carries `-u`, `--update-snapshots`, `--ignore-snapshots`, `--pass-with-no-tests`, `--reporter`, `--output`, `--trace`, `--retries`, `--headed`, `--debug` or `--ui`.

## What it records

Per test, as attachments Orbit reads back:

| Attachment | Contents |
|---|---|
| `orbit-diagnostics` | console errors, uncaught page errors, failed requests, HTTP 4xx and 5xx responses, the browser name and version, the viewport and the final URL |
| `orbit-failure-screenshot` | a full-page screenshot when the test fails, even if the config forgot `screenshot: 'only-on-failure'` |
| `orbit-a11y` | one per accessibility scan: new and baselined serious or critical violations, and whether the scan was advisory |
| `orbit-keyboard` | one per `expectKeyboardReachable` call: the Tab press that reached each element, and whether it showed a focus indicator |

Console errors and failed requests are recorded, not failed on. Assert on them in a journey when they matter.

## Accessibility

`expectNoSeriousA11yViolations(page, { baselinePath })` runs axe-core and fails on serious or critical violations. With a `baselinePath`, violations already in that file are tolerated and only new ones fail; each is fingerprinted by rule, element, page path and viewport. A missing baseline file counts as empty.

`ui.accessibility.fail_on_new_serious_or_critical` reaches the fixture as `ORBIT_A11Y_FAIL_ON` (`serious,critical` or `none`). With `none` a new violation is still attached to the report but is advisory: it does not fail the test, and the run lists it under `a11yAdvisory` and `unverified`. Outside Orbit the variable is unset and violations fail.

Recording a baseline is a person's decision, never Orbit's:

```sh
ORBIT_A11Y_RECORD_BASELINE=1 npx playwright test e2e/a11y.spec.ts
```

The recorder refuses to run when `ORBIT_UI_RUN` is set, which Orbit's runner always sets. A candidate that edits a baseline file is reported and blocked for review; it cannot pass on that edit.

Automated scans find only part of the possible accessibility problems. A clean scan is not a claim that the interface is accessible, and Orbit's reports say so.

## Keyboard navigation

`expectKeyboardReachable(page, ['#status', '#export'])` presses Tab from the top of the page and fails unless every CSS selector is focused, in the order given, with a visible focus indicator (an outline or a box shadow). Call it right after navigation, before clicking anything, because sequential focus navigation starts from the last interaction. Options: `ordered: false` to skip the order check, `requireFocusRing: false` to skip the indicator check, `maxTabs` (default 60).

It checks tab order, reachability and the indicator for the elements you list. It does not test that they work from the keyboard, focus traps or screen reader behaviour, and Orbit's reports say so.

## Exploration

When `ui.exploration.enabled` is true, an explorer worker looks for defects on the running application. Each candidate finding is turned into a Playwright spec outside your repository (under the run's evidence directory) and kept only if that spec fails on every run against the candidate. Reproduced findings come back as failing specs for the implementer; they are never acceptance evidence.

## Visual baselines

Orbit runs with `--update-snapshots=none`, so a missing or mismatching screenshot fails. Record baselines yourself with `npx playwright test -u`, review the images, and commit them. A candidate whose diff changes files matching `ui.visual.baseline_globs` is blocked for human review, even if every journey then passes.
