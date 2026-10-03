# Playwright UI verification and GitHub delivery: verified interfaces

Verified on 2026-10-03 on macOS 27 (Darwin 27.0.0), Node v22.18.0. Scope: section 13 (UI runner) and section 15 (delivery adapter) of the Orbit spec.

Evidence tags:
- `[CLI: cmd]` means local help output.
- `[LAB]` means an experiment I ran in a scratch dir: a throwaway Playwright project, plus a local bare-repo git lab and read-only `gh` calls against public repos.
- `[DOC: url]` means official documentation.
- `[SRC]` means gh source at `cli/cli` trunk, fetched with `gh api`.
- `[TYPES]` means `node_modules/playwright/types/testReporter.d.ts` at 1.63.0.
- **UNVERIFIED** marks anything I could not confirm.

## 0. Versions (pin these in evidence)

| Tool | Version | Evidence |
|---|---|---|
| playwright / @playwright/test | 1.63.0 (latest). The `next` tag is 1.64.0-alpha-2026-10-03 | `npm view playwright version dist-tags` |
| Chromium for 1.63.0 | revision 1243 = Chrome for Testing 153.0.8010.12. chromium-headless-shell is also 1243 | `node_modules/playwright-core/browsers.json` [LAB] |
| Cached browsers | `~/Library/Caches/ms-playwright/{chromium-1243,chromium_headless_shell-1243,ffmpeg-1011}`. Matches 1.63.0 | `ls` [LAB] |
| @axe-core/playwright | 4.13.0. It depends on `axe-core ~4.13.0` and has peer `playwright-core >= 1.0.0` | `npm view @axe-core/playwright@4.13.0 peerDependencies dependencies` |
| gh | 2.100.0 (2026-09-03). Upstream latest is v2.102.0 | `gh --version`, `gh release view -R cli/cli` |
| git | 2.54.0 (Apple Git-157) | `git --version` |

Orbit should pin `@playwright/test` exactly in the target repo or in its own UI-runner package, because Chromium revisions are tied to the Playwright version. A version bump means a browser download.

---

## A. Playwright

### A1. Browser install status

- Default cache locations: macOS `~/Library/Caches/ms-playwright`, Linux `~/.cache/ms-playwright`, Windows `%USERPROFILE%\AppData\Local\ms-playwright` [DOC: https://playwright.dev/docs/browsers].
- `PLAYWRIGHT_BROWSERS_PATH=<dir>` sets a custom location. `PLAYWRIGHT_BROWSERS_PATH=0` gives a hermetic install in `node_modules/playwright-core/.local-browsers` [DOC: same].
- GC removes unused browser versions. Opt out with `PLAYWRIGHT_SKIP_BROWSER_GC=1` or `install --no-remove` [DOC: same].
- `npx playwright install [options] [browser...]` [CLI: `npx playwright install --help`]. Options: `--with-deps`, `--dry-run`, `--list`, `--force`, `--only-shell`, `--no-shell`, `--no-progress`, `--no-remove`. Browsers: `chromium firefox webkit chromium-headless-shell` (and `chrome` per the help examples).
- **Gotcha:** `npx playwright install --dry-run chromium` exits 0 and prints `Install location:` and `Download url:` lines. It does not say whether the browser is already installed [LAB]. `install --list` printed nothing and exited 0 here [LAB]. Don't use either as a status probe.
- **Reliable probe [LAB]:**
  ```js
  const { chromium } = require('@playwright/test');
  const ok = require('fs').existsSync(chromium.executablePath()); // true here; false with PLAYWRIGHT_BROWSERS_PATH=/nonexistent
  ```
  - Each installed browser dir also contains `INSTALLATION_COMPLETE` and `DEPENDENCIES_VALIDATED` marker files [LAB]. These are undocumented, so use them only as a secondary heuristic.
- Headless Chromium defaults to `chromium-headless-shell`. `channel: 'chromium'` uses "new headless", which is the full Chrome build [DOC: browsers]. Both produced correct screenshots here [LAB].
- Record the browser version with `browser.version()` (it returned `153.0.8010.12`) [LAB].

### A2. `npx playwright test` CLI [CLI: `npx playwright test --help`, v1.63.0]

Relevant flags, verbatim names:
- **Reporting and output:**
  - `--reporter <reporter>`: one of `list|line|dot|json|junit|null|github|html|blob|perfetto`. Default `list`. CI defaults to `dot` [DOC: test-reporters].
  - `--add-reporter <reporter>`
  - `--output <dir>`: default `test-results`
- **Selection:**
  - `-c, --config <file>`
  - `--project <project-name...>`: supports a `*` wildcard. An unknown project prints `Error: Project(s) "nope" not found. Available projects: ...` and exits 1 [LAB].
  - `-g, --grep`, `-G, --grep-invert`, `--list`, `--test-list <file>`, `--test-list-invert <file>`, `--only-changed [ref]`, `--last-failed`, `--shard x/y`
- **Snapshots:**
  - `-u, --update-snapshots [mode]`: choices `all|changed|missing|none`. A bare `-u` presets `changed`. "Running tests without the flag defaults to `missing`".
  - `--ignore-snapshots`
- **Run control:**
  - `--retries <n>`: default no retries
  - `--fail-on-flaky-tests`, `--forbid-only`, `--max-failures <N>`, `-x`
  - `--timeout <ms>`: default 30000
  - `--global-timeout <ms>`
  - `-j, --workers <n|%>`
  - `--pass-with-no-tests`, `--no-deps`, `--repeat-each <N>`
- **Tracing:** `--trace <mode>`: choices `on|off|on-first-retry|on-all-retries|retain-on-failure|retain-on-first-failure|retain-on-failure-and-retries`.
- **Do not use in Orbit:** `--run-agents <mode>` with choices `missing|all|none` ("Run agents to generate the code for page.perform"). Interactive or debug flags `--ui`, `--headed`, `--debug` are unsuitable for unattended runs.

Exit codes [LAB]:

| Situation | Exit |
|---|---|
| All tests expected (pass, skip, or `test.fail()` that failed) | 0 |
| **Flaky (failed then passed on retry)** | **0**. With `--fail-on-flaky-tests` it is **1** |
| Any unexpected failure | 1 |
| No tests matched (without `--pass-with-no-tests`) | 1 |
| Config error (unknown project) | 1 |
| webServer failure (e.g. port already used and `reuseExistingServer:false`) | 1. The JSON report has `suites: []`, all-zero `stats`, and the error in top-level `errors[]` |
| SIGINT/interrupted | **UNVERIFIED** |

### A3. JSON reporter

How to choose the output file:
- Config form: `reporter: [['json', { outputFile: 'results.json' }], ['list']]` [DOC: https://playwright.dev/docs/test-reporters] [LAB].
- Environment form: `PLAYWRIGHT_JSON_OUTPUT_FILE` is a full path and wins. Otherwise `PLAYWRIGHT_JSON_OUTPUT_DIR` + `PLAYWRIGHT_JSON_OUTPUT_NAME` are used. If neither is set, output goes to stdout [DOC: test-reporters]. Both `_FILE` and `_NAME` worked [LAB].
- **Gotcha [LAB]:** CLI `--reporter=json` *replaces* the config's reporters, so the config `outputFile` is ignored. Orbit should run `--reporter=json` with `PLAYWRIGHT_JSON_OUTPUT_FILE=<abs evidence path>`. That makes the location independent of repo config. Add `--add-reporter`-style human output only if needed.

Schema, authoritative from [TYPES] `JSONReport` and matching [LAB] output:
```ts
JSONReport {
  config: FullConfig & { version: string /* "1.63.0" */, configFile, rootDir, updateSnapshots, workers, metadata,
            webServer, projects: { id, name, outputDir, repeatEach, retries, metadata, testDir, testIgnore, testMatch, timeout }[] }
  suites: JSONReportSuite[]           // one per test FILE; nested `suites` per test.describe
  errors: TestError[]                 // global/setup errors (webServer, globalSetup) -> treat non-empty as infra failure
  stats: { startTime: string; duration: number; expected: number; unexpected: number; flaky: number; skipped: number }
}
JSONReportSuite { title; file; line; column; specs: JSONReportSpec[]; suites?: JSONReportSuite[] }
JSONReportSpec  { id; title; tags: string[] /* "@smoke" in title + {tag:'@ui'} => ["smoke","ui"] */; ok: boolean; file; line; column;
                  tests: JSONReportTest[] /* one per PROJECT */ }
JSONReportTest  { projectId; projectName; status: 'skipped'|'expected'|'unexpected'|'flaky';
                  expectedStatus: TestStatus; timeout; annotations: {type, description?, location?}[]; results: JSONReportTestResult[] /* one per retry */ }
JSONReportTestResult { workerIndex; parallelIndex; shardIndex?; status: TestStatus | undefined; duration; retry; startTime;
                  error?: TestError; errors: { message: string; location?: {file,line,column} }[];
                  stdout/stderr: ({text}|{buffer})[]; steps?; annotations; errorLocation?;
                  attachments: { name: string; contentType: string; path?: string /* absolute */; body?: string /* BASE64 */ }[] }
TestStatus = 'passed'|'failed'|'timedOut'|'skipped'|'interrupted'
TestError  = { message?, stack?, location?, snippet?, value?, cause? }
```
- `test.status` is the outcome: `expected | unexpected | flaky | skipped` [DOC: https://playwright.dev/docs/api/class-testcase]. `results[].status` is the raw status [DOC: https://playwright.dev/docs/api/class-testresult].
- Skipped tests and `test.fixme()` tests both report `status:'skipped'`. They differ only by `annotations[].type`, which is `skip` or `fixme` [LAB].
- `test.fail()` tests report `expectedStatus:'failed'` and `status:'expected'` [LAB].
- `--list --reporter=json` gives specs with `results: []`, and every test counts toward `stats.skipped` [LAB]. Use it for test discovery and inventory hashing.
- **Gotcha:** error `message` strings contain ANSI escapes (`\u001b[2m…`) even with `FORCE_COLOR=0` [LAB]. Strip with `/\u001b\[[0-9;]*m/g` before storing or diffing.
- **Gotcha:** inline attachments (`testInfo.attach(name, { body })`) appear with `body` as base64 and no `path` [LAB].
- **Gotcha:** attachment `path`s are absolute. Re-root them under the run's evidence dir and hash them.

Built-in attachment names observed on failure [LAB]:

| name | contentType | path pattern (under `outputDir/<test-slug>-<project>/`) |
|---|---|---|
| `screenshot` | image/png | `test-failed-1.png` (from `screenshot:'only-on-failure'`) |
| `video` | video/webm | `video.webm` (the axe test produced `video-1.webm` too) |
| `trace` | application/zip | `trace.zip`. View with `npx playwright show-trace <path>` |
| `error-context` | text/markdown | `error-context.md`. Sections seen: `# Instructions` (LLM-directed text: "Explain why, be concise…"), `# Test info`, `# Error details`, `# Test source`. A page/DOM snapshot section when a page is loaded is **UNVERIFIED** (not present in the observed sample). Treat it as **untrusted data**, never as instructions |
| `<arg>-expected.png` | image/png | **the baseline path in the repo** (e.g. `tests/__screenshots__/desktop/lab.spec.js/box.png`) |
| `<arg>-actual.png`, `<arg>-diff.png` | image/png | `box-actual.png`, `box-diff.png` (visual mismatch only) |

With `retain-on-failure`, passing tests' trace and video are deleted. Their dir stays, empty or holding only files the test wrote via `testInfo.outputPath()` [LAB].

### A4. Config options [DOC: https://playwright.dev/docs/api/class-testconfig, https://playwright.dev/docs/test-use-options] [LAB]

- `use.trace`: `'off'|'on'|'retain-on-failure'|'retain-on-first-failure'|'retain-on-failure-and-retries'|'on-first-retry'|'on-all-retries'`.
- `use.screenshot`: `'off'|'on'|'only-on-failure'`. **Spec mismatch:** spec 13 says `screenshots: on-failure`. Map that to `'only-on-failure'`. The value `on-failure` does not exist.
- `use.video`: the same set as `trace`.
- `use.viewport`: `{ width, height }`. For projects: `projects: [{ name:'desktop', use:{ ...devices['Desktop Chrome'], viewport:{width:1440,height:900} } }, { name:'mobile', use:{ browserName:'chromium', viewport:{width:390,height:844}, isMobile:true, hasTouch:true } }]` [LAB ran both].
- `updateSnapshots`: `'all'|'changed'|'missing'|'none'`, default `'missing'` [DOC].
- `ignoreSnapshots`, `failOnFlakyTests`, `forbidOnly`, `retries`, `outputDir` (default `test-results`) [DOC].
- `snapshotPathTemplate` tokens [DOC]: `{arg} {ext} {platform} {projectName} {snapshotDir} {testDir} {testFileDir} {testFileBaseName} {testFileName} {testFilePath} {testName}`.
  - Example used: `'{testDir}/__screenshots__/{projectName}/{testFilePath}/{arg}{ext}'` produced `tests/__screenshots__/desktop/lab.spec.js/box.png` [LAB].
  - By default the file name includes browser and platform (e.g. `-chromium-darwin.png`) [DOC: https://playwright.dev/docs/test-snapshots]. Include `{platform}` if baselines may come from Linux CI and macOS.
- `expect.toHaveScreenshot` options [DOC: https://playwright.dev/docs/api/class-locatorassertions]:
  - `animations` (default `"disabled"`), `caret` (default `"hide"`)
  - `mask`, `maskColor` (default `#FF00FF`)
  - `maxDiffPixels`, `maxDiffPixelRatio` (0–1)
  - `omitBackground`, `scale` (default `"css"`), `stylePath`
  - `threshold` (default **0.2**, YIQ), `timeout`
  - `expect.toHaveScreenshot.pathTemplate` in config overrides `snapshotPathTemplate` for screenshots [DOC: testconfig]
- `webServer` [DOC: testconfig]:
  - `command`, `url` (2xx/3xx/400/401/402/403 counts as ready), `port`, `reuseExistingServer`, `timeout` (default 60000), `cwd`, `env`, `stdout`/`stderr` (`'pipe'|'ignore'`), `ignoreHTTPSErrors`, `gracefulShutdown` (`{signal, timeout}`), `name`, `wait` (regex on output). The value may also be an array.
  - The command runs with `shell: true`, `env = {BROWSER:'none', FORCE_COLOR:'1', DEBUG_COLORS:'1', ...process.env, ...webServer.env}` [LAB: read from `node_modules/playwright/lib/runner/index.js`]. The spawned server **inherits Orbit's whole environment**, so pass a scrubbed env to the Playwright process.
  - `reuseExistingServer:false` with the URL already answering fails with `"<url> is already used, make sure that nothing is running on the port/url or set reuseExistingServer:true in config.webServer."` [LAB].
  - **Gotcha [LAB]:** when the Playwright process was killed by a timeout, the `node server.js` webServer child was **orphaned** and kept the port. Run Playwright in its own process group, kill the group, then verify the port is free.

### A5. Forbidding baseline updates (core Orbit invariant)

Verified behaviour [LAB, 1.63.0]:
1. Default or `'missing'` mode with a missing baseline: the test **fails** (exit 1) with `A snapshot doesn't exist at <path>, writing actual.` and **writes the baseline into the repo**. **`CI=1` does not change this.** The next run passes. Within one invocation `--retries=1` did *not* retry it into a pass (only one result was recorded). So the hazard is a **second invocation**.
2. `'none'` mode with a missing baseline: fails with `A snapshot doesn't exist at <path>.` and writes nothing into the snapshot dir. With `--retries=1` it was retried (a `…-retry1` output dir appeared) and still failed.
3. `--update-snapshots=none` on the CLI overrides config `updateSnapshots:'all'`, and the report's `config.updateSnapshots` shows `"none"`. Mismatch error: `toHaveScreenshot(expected) failed … 10000 pixels (ratio 1.00 of all image pixels) are different.`
4. `--update-snapshots=changed` and bare `-u` silently overwrite baselines and exit 0. `--ignore-snapshots` makes a real visual change pass with exit 0.

Orbit policy:
- Always pass `--update-snapshots=none`.
- Reject any worker-supplied args containing `-u`, `--update-snapshots`, `--ignore-snapshots`, `--pass-with-no-tests`, `--run-agents`, `--retries` above the policy value, or `--trace off`.
- After the run, hash the snapshot directories (or `git status --porcelain -- '<snapshot globs>'`). Any new or changed baseline file means `visual_baseline_change` and requires review (`visual_baseline_auto_accept: false`).
- Treat `config.updateSnapshots !== 'none'` in the report as a policy violation.

### A6. Console, page error, and network capture [DOC: https://playwright.dev/docs/api/class-page] [LAB]

```js
// tests/fixtures.js  (auto fixture; worked as written on 1.63.0)
const base = require('@playwright/test');
exports.test = base.test.extend({
  diag: [async ({ page }, use, testInfo) => {
    const d = { console: [], pageErrors: [], failedRequests: [], badResponses: [] };
    page.on('console', m => { if (m.type() === 'error') d.console.push({ type: m.type(), text: m.text(), location: m.location() }); });
    page.on('pageerror', e => d.pageErrors.push({ name: e.name, message: e.message }));
    page.on('requestfailed', r => d.failedRequests.push({ url: r.url(), method: r.method(), failure: r.failure()?.errorText }));
    page.on('response', r => { if (r.status() >= 400) d.badResponses.push({ url: r.url(), status: r.status() }); });
    await use(d);
    await testInfo.attach('orbit-diagnostics', { body: JSON.stringify(d), contentType: 'application/json' });
  }, { auto: true }],
});
exports.expect = base.expect;
```
Observed [LAB]:
- `location()` returns `{url,line,column,lineNumber,columnNumber}`.
- HTTP 4xx/5xx are **not** `requestfailed`. They show up only as `response` events and as console errors (`Failed to load resource: the server responded with a status of 404 (Not Found)`).
- `requestfailed` fires for network-level failures, e.g. `failure().errorText = "net::ERR_UNSAFE_PORT"`.
- An uncaught exception gives `pageerror` with `message:'uncaught-page-error'`.

The full `ConsoleMessage.type()` value list was not extracted from the docs (**UNVERIFIED** list). `'error'` and `'warning'` were observed.

### A7. Accessibility: @axe-core/playwright 4.13.0 [DOC: https://playwright.dev/docs/accessibility-testing; installed `dist/index.d.ts`]

- Import: `import AxeBuilder from '@axe-core/playwright'` or `require('@axe-core/playwright').default`.
- Constructor: `new AxeBuilder({ page, axeSource? })`.
- Chainable methods: `include(sel)`, `exclude(sel)`, `options(RunOptions)`, `withRules(ids)`, `withTags(tags)`, `disableRules(ids)`, `setLegacyMode(bool?)`. Then `analyze(): Promise<AxeResults>`.
- Results: `{ violations, passes, incomplete, inapplicable, url, timestamp, testEngine, testEnvironment }` [DOC: https://github.com/dequelabs/axe-core/blob/develop/doc/API.md].
  - Each violation has `{ id, impact, tags, help, helpUrl, nodes[] }`.
  - Each node has `{ target, html, impact, any, all, none, failureSummary }`.
- `ImpactValue = 'minor'|'moderate'|'serious'|'critical'|null` [installed `axe-core/axe.d.ts`].
- Tags: `wcag2a wcag2aa wcag2aaa wcag21a wcag21aa wcag22aa best-practice ACT section508 TTv5 EN-301-549 RGAAv4 experimental …` [DOC: axe API].
- [LAB] An `<img>` with no alt gave `image-alt`/`critical`. An empty `<button>` gave `button-name`/`critical`.
- Gate: `violations.filter(v => v.impact === 'serious' || v.impact === 'critical')`.
- For "fail on **new**" serious/critical, store a fingerprint per finding: `rule id + sorted node.target + url + viewport`. Compare it to the baseline-run set.
- Docs state automated scans find only some problems. Report that limitation, as spec 13 requires.

### A8. Downloads [DOC: https://playwright.dev/docs/downloads] [LAB]

```js
const downloadPromise = page.waitForEvent('download');   // register BEFORE the click
await page.locator('#dl').click();
const download = await downloadPromise;
download.suggestedFilename();                              // "report-2026.csv" from Content-Disposition
await download.saveAs(testInfo.outputPath(download.suggestedFilename()));
await download.failure();                                  // null on success
```
- Files are deleted when the browser context closes, so `saveAs` before the test ends [DOC].
- The `testInfo.outputPath()` copy survived in `test-results/<slug>/` [LAB].

---

## B. GitHub delivery (gh 2.100.0 + git 2.54.0)

### B1. Auth and credentials

- Token precedence: `GH_TOKEN`, then `GITHUB_TOKEN`, for github.com and `*.ghe.com`. It "takes precedence over previously stored credentials" [CLI: `gh help environment`].
- Other useful environment variables:
  - `GH_PROMPT_DISABLED`: disable prompts
  - `GH_REPO=[HOST/]OWNER/REPO`
  - `GH_CONFIG_DIR`: isolate gh config
  - `GH_NO_UPDATE_NOTIFIER`
  - `NO_COLOR`
  - `GH_TELEMETRY=false` or `DO_NOT_TRACK=1`
  - `GH_PAGER`
- `gh auth status` [CLI + LAB]:
  - Exits 0 when all accounts are OK.
  - **Exits 1 if any known account has a problem.** An invalid `GH_TOKEN` gives exit 1 even though the keyring account is fine. That keyring account is then shown as `Active account: false`.
  - **With `--json hosts` it always exits 0** unless there is a fatal error. Parse it: `gh auth status --json hosts --jq '.hosts["github.com"][] | select(.active)'`. That yields `{active, error, gitProtocol, host, login, scopes, state, tokenSource}`. With a bad `GH_TOKEN` the active entry was `{state:"error", tokenSource:"GH_TOKEN", login:"", error:"non-200 OK status code: 401 Unauthorized …"}`, the keyring entry was `active:false`, and the exit was 0 [LAB]. Here it was `tokenSource:"keyring"`, `gitProtocol:"ssh"`, scopes `admin:org, admin:public_key, gist, repo`, which is **too broad for unattended runs**.
- Exit codes [CLI: `gh help exit-codes`]: 0 ok, 1 failure, 2 cancelled, 4 auth required. Commands may add their own (`gh pr checks`: 8).
- Fine-grained PAT permissions [DOC: https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens]:
  - `POST/PATCH /repos/{o}/{r}/pulls`: Pull requests **write**
  - `GET …/pulls`: Pull requests read
  - `GET …/actions/runs`, `…/actions/jobs/{id}/logs`: Actions read
  - `GET …/commits/{ref}/status`: Commit statuses read
  - `GET …/git/ref/{ref}`: Contents read
  - **UNVERIFIED:** that git-over-HTTPS push needs exactly Contents write (expected, but not quoted from the docs); which permission `…/commits/{ref}/check-runs` needs; whether `gh pr checks` (GraphQL `statusCheckRollup`) works with a fine-grained PAT.
  - `gh run watch` "does not support authenticating via fine grained PATs as it is not currently possible to create a PAT with the `checks:read` permission" [CLI: `gh run watch --help`]. Orbit should poll instead.
- Git push with a scoped token, without touching user config [LAB]:
  - `printf 'protocol=https\nhost=github.com\n\n' | GH_TOKEN=… gh auth git-credential get` prints `username=x-access-token` and `password=<GH_TOKEN>`. The helper honors `GH_TOKEN`. The command is hidden but present.
  - An empty `credential.helper` "resets the helper list" [CLI: `git help gitcredentials`].
  - Per-command form: `git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push https://github.com/OWNER/REPO.git …` with `GH_TOKEN` in env.
  - The user's gh `gitProtocol` is `ssh`, and SSH pushes ignore `GH_TOKEN`. Orbit must push to an explicit HTTPS URL to get token scoping.
  - Never run `gh auth setup-git`, because it writes git config.

### B2. Create a draft PR non-interactively [CLI: `gh pr create --help`] [LAB: `--dry-run`] [SRC]

```sh
GH_PROMPT_DISABLED=1 gh pr create -R OWNER/REPO --draft --base main --head orbit/<run-id> \
  --title "<title>" --body-file <evidence>/pr-body.md   # stdout: PR URL
```
- Flags:
  - `-d, --draft`, `-t, --title`
  - `-b, --body` or `-F, --body-file file` ("-" for stdin)
  - `-B, --base`, `-H, --head`
  - `--no-maintainer-edit`, `-l/--label`, `-r/--reviewer`, `-a/--assignee`, `-T/--template`
  - `--fill`, `--fill-first`, `--fill-verbose`, `--dry-run`, `--attach file` (≤50 files), `--recover`
- "Use `--head` to explicitly skip any forking or pushing behavior." Always pass `--head` and push separately.
- `--head` in `pr create` supports `<user>:<branch>`. `pr list --head` does not support the owner prefix.
- Without title or body in a non-TTY, it prints ``must provide `--title` and `--body` (or `--fill` or `fill-first` or `--fillverbose`) when not running interactively`` and exits 1 [LAB].
- `--dry-run` prints `title: draft: base: head: maintainerCanModify: body:` and exits 0. It does **not** validate that the head branch exists [LAB]. The help warns that `--dry-run` "May still push git changes" unless `--head` is given.
- If an OPEN PR already exists for head into base, the command fails with exit 1 and ``a pull request for branch "<head>" into branch "<base>" already exists:\n<url>`` [SRC create.go]. This was not executed here. Orbit should look up the PR first (B3) rather than parse this.
- `--attach` partial failure: the PR is still created and its URL printed, but the exit is non-zero [CLI]. Treat a non-zero exit as uncertain and reconcile via B3.
- Update later: `gh pr edit <n> --title … --body-file …` [CLI]. Draft toggle: `gh pr ready <n>` / `gh pr ready <n> --undo` [CLI].

### B3. Find an existing PR (reconcile before create or retry) [CLI: `gh pr list --help`] [LAB]

```sh
gh pr list -R OWNER/REPO --head orbit/<run-id> --state all \
  --json number,url,headRefName,headRefOid,baseRefName,isDraft,state,statusCheckRollup
```
- `--state {open|closed|merged|all}` defaults to `open`. `-L, --limit` defaults to 30. With no match it prints `[]` and exits 0 [LAB].
- `state` values seen: `OPEN`, `MERGED`, `CLOSED` [LAB].
- `gh pr view <branch> --json …` with no PR prints `no pull requests found for branch "<b>"` and exits 1 [LAB].
- JSON fields for `pr list`/`pr view` [CLI]: `additions assignees author autoMergeRequest baseRefName baseRefOid body changedFiles closed closedAt closingIssuesReferences comments commits createdAt deletions files fullDatabaseId headRefName headRefOid headRepository headRepositoryOwner id isCrossRepository isDraft labels latestReviews maintainerCanModify mergeCommit mergeStateStatus mergeable mergedAt mergedBy milestone number potentialMergeCommit projectCards projectItems reactionGroups reviewDecision reviewRequests reviews state statusCheckRollup title updatedAt url`.
- `statusCheckRollup[]` items include `__typename` (`CheckRun`), `status` (`COMPLETED`), and `conclusion` (`SUCCESS`/`SKIPPED`/…) [LAB].
- Always assert `headRefOid == delivered commit SHA`.

### B4. PR checks [CLI: `gh pr checks --help`] [SRC checks.go] [LAB]

```sh
gh pr checks <number|url|branch> -R OWNER/REPO --json name,state,bucket,link,workflow,event,startedAt,completedAt,description
```
- JSON fields: `bucket completedAt description event link name startedAt state workflow`.
- `bucket` is one of `pass|fail|pending|skipping|cancel`. `state` is raw, e.g. `SUCCESS`, `FAILURE` [LAB].
- `link` is the job URL, e.g. `https://github.com/cli/cli/actions/runs/<runId>/job/<jobId>`. Parse `runId` and `jobId` from it [LAB].
- Flags: `--required`, `--watch`, `--fail-fast`, `-i/--interval` (default 10s).
- **Exit codes:**
  - Table (non-JSON) mode: 0 when all pass. **1 when any fail** [LAB]. **8 when any are pending** (help text + `cmdutil.PendingError` [SRC]). Failure takes precedence over pending [SRC].
  - **With `--json` it exits 0 even when checks fail** [LAB, pinned by SRC: the exporter returns before the exit-code logic]. Orbit must compute pass/fail from `bucket`.
  - Zero checks gives the error `no checks reported on the '<headRefName>' branch` and exits 1 [SRC]. Distinguish "CI not started or not configured" from failure. Cross-check with `gh run list --commit`.

### B5. Workflow runs and failed logs [CLI: `gh run list --help`, `gh run view --help`] [LAB]

```sh
gh run list -R OWNER/REPO --commit <sha> --json databaseId,status,conclusion,headSha,headBranch,event,workflowName,name,attempt,url
gh run list -R OWNER/REPO --branch orbit/<run-id> -L 20 --json databaseId,status,conclusion,headSha
gh run view <databaseId> -R OWNER/REPO --json jobs   # jobs[].{databaseId,name,status,conclusion,url,steps[].{name,number,status,conclusion,startedAt,completedAt}}
gh run view <databaseId> -R OWNER/REPO --log-failed  # or: --job <jobId> --log-failed
```
- `run list` flags: `-b/--branch`, `-c/--commit SHA`, `-e/--event`, `-s/--status`, `-w/--workflow`, `-u/--user`, `--created`, `-a/--all`, `-L` (default 20).
  - `--status` choices: `queued|completed|in_progress|requested|waiting|pending|action_required|cancelled|failure|neutral|skipped|stale|startup_failure|success|timed_out`.
  - JSON fields: `attempt conclusion createdAt databaseId displayTitle event headBranch headSha name number startedAt status updatedAt url workflowDatabaseId workflowName`. `run view` adds `jobs`.
  - An unknown commit returns `[]` with exit 0 [LAB].
- `--log-failed` output is tab-separated: `<job name>\t<step name>\t<ISO timestamp> <line>`. It contains raw ANSI escapes and exits 0 [LAB]. Sanitize it: strip ANSI, redact secrets, cap size.
- `--log-failed` failure modes [LAB], both exit 1:
  - Expired logs: `failed to get run log: HTTP 410: Server Error`.
  - A run with zero jobs (e.g. a startup or workflow-file failure): `failed to get run log: log not found`.
  - Fallback: `gh run view --json jobs` for the failed step names. Without TTY, `gh run view` needs a run or job ID ("run or job ID required when not running interactively").
- `gh run view <id> --exit-status` exits 1 for a failed run and 0 for a successful one [LAB]. `gh run view` help notes `UNKNOWN STEP` lines and a 25-missing-job-log failure limit for the per-job fallback.
- REST equivalents: the job logs endpoint returns 302 to a URL that "expires after 1 minute" [DOC: https://docs.github.com/en/rest/actions/workflow-jobs].

### B6. `gh api` for exact reconciliation [CLI: `gh api --help`] [LAB]

- `gh api repos/OWNER/REPO/git/ref/heads/<branch> --jq .object.sha` returns the SHA. A missing ref gives `gh: Not Found (HTTP 404)` and exits 1.
- `gh api repos/OWNER/REPO/git/commits/<sha> --jq '{sha, tree: .tree.sha, parents: [.parents[].sha]}'` lets you verify the remote commit's tree equals the tested tree.
- Flags: `-X/--method`, `-f/--raw-field`, `-F/--field` (typed, `@file`), `--input file`, `-H`, `--jq`, `--paginate`, `--slurp`, `--silent`, `-i/--include`, `--cache`, `--hostname`.
- `{owner}`, `{repo}`, and `{branch}` placeholders come from the cwd repo or `GH_REPO`. Prefer explicit values.

### B7. Git plumbing [CLI: `git <cmd> -h`, man pages] [LAB: bare-remote lab, all results observed]

**Worktrees**
```sh
git worktree add [-f] [--detach] [--checkout] [--lock [--reason <s>]] [--orphan] [(-b|-B) <new-branch>] <path> [<commit-ish>]
git worktree list --porcelain -z          # NUL-terminated lines; empty line (double NUL) ends a record
git worktree remove [-f] <worktree>       # dirty => "fatal: '<p>' contains modified or untracked files, use --force to delete it" exit 128
                                          # locked => needs `-f -f` ("cannot remove a locked working tree, lock reason: …") exit 128
git worktree prune [-n] [-v] [--expire <t>]   # -v prints "Removing worktrees/<id>: gitdir file points to non-existent location"
```
- Porcelain records [man + LAB]: `worktree <abs path>`, `HEAD <sha>`, `branch refs/heads/<b>` **or** `detached`, then optional `bare`, `locked [reason]`, `prunable [reason]`.
- The first record is the main worktree. The format is "stable across Git versions and regardless of user configuration".
- A manually deleted worktree shows `prunable gitdir file points to non-existent location` until pruned [LAB].
- Use `--lock --reason "orbit run <id>"` so a concurrent `git worktree prune` can't remove an active worktree.

**Exact-tree capture without touching the worker's index** [LAB]
```sh
TMPIDX=$(mktemp -u)
GIT_INDEX_FILE=$TMPIDX git read-tree HEAD        # seed from HEAD
GIT_INDEX_FILE=$TMPIDX git add -A                # honors .gitignore; captures adds/mods/deletes
TREE=$(GIT_INDEX_FILE=$TMPIDX git write-tree)    # index must be fully merged; prints tree SHA
rm -f "$TMPIDX"
```
- The real index and `git status` were unchanged afterwards [LAB].
- `git rev-parse 'HEAD^{tree}'` gives the tree of a commit. `git rev-parse --verify --quiet '<x>^{commit}'` exits 1 if missing. `git cat-file -e '<sha>^{tree}'` exits 0 if present [LAB].

**Commit exactly that tree**
```sh
COMMIT=$(git commit-tree "$TREE" -p "$PARENT" -F msg.txt)   # or -m; repeat -p for merges; -S/--no-gpg-sign
test "$(git rev-parse "$COMMIT^{tree}")" = "$TREE"
```
- [LAB] `commit-tree` ran **no hooks**: a failing `pre-commit` or `commit-msg` hook did not fire. It also did **not** sign under `commit.gpgsign=true`, even with `gpg.program=/usr/bin/false`. The man page documents only explicit `-S`/`--gpg-sign`.
- [LAB] Identity comes from `GIT_AUTHOR_NAME/EMAIL` and `GIT_COMMITTER_NAME/EMAIL`. With `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` fixed, the commit SHA is deterministic (same SHA twice), which makes retries idempotent.
- Because no commit hooks run, the tree that was tested is exactly the tree that gets delivered.

**Push an explicit SHA to an explicit ref with a lease** [man: "only `--force-with-lease=<refname>:<expect>` … is not experimental"]
```sh
git push --porcelain "--force-with-lease=refs/heads/orbit/<id>:"        origin "$COMMIT:refs/heads/orbit/<id>"   # create; ref must NOT exist
git push --porcelain "--force-with-lease=refs/heads/orbit/<id>:$OLDSHA" origin "$NEW:refs/heads/orbit/<id>"      # update from known SHA
```
- Observed [LAB]:

  | Case | porcelain line | exit |
  |---|---|---|
  | new ref, lease expects absent | `*\t<sha>:refs/heads/…\t[new branch]` | 0 |
  | lease expects absent, ref already at **same** SHA | `=\t…\t[up to date]` | 0 (idempotent retry is safe) |
  | lease expects absent, ref at **other** SHA | `!\t…\t[rejected] (stale info)` | 1 |
  | stale `<expect>` | `!\t…\t[rejected] (stale info)` | 1 |
  | correct `<expect>`, non-ff | `+\t…\told...new (forced update)`. A ff shows ` \t…\told..new` | 0 |
  | non-ff, no lease or force | `!\t…\t[rejected] (non-fast-forward)` | 1 |
  | `--atomic` with one stale ref | every ref `!` (the other shows `(atomic push failed)`); nothing updated | 1 |
- The porcelain format is `<flag>\t<from>:<to>\t<summary> (<reason>)`, ending with `Done`. Flags: ` ` ff, `+` forced, `-` deleted, `*` new, `!` rejected, `=` up to date [man git-push OUTPUT].
- **Gotchas:**
  - Bare `--force-with-lease`, or one without `:<expect>`, compares against the remote-tracking ref. That ref is silently refreshed by pushes and fetches, and the man page warns about background fetch. Always give an explicit `<expect>`.
  - `git push` **runs the local `pre-push` hook**: a failing hook gave exit 1, and `--no-verify` bypassed it [LAB]. Decide by policy. For worker-controlled repos, prefer `--no-verify` plus Orbit's own trusted checks, or run hooks in the sandbox.
  - In zsh, `"$COMMIT:refs/…"` is mangled by the `:r` modifier (observed: `src refspec <sha>efs/heads/…`). Use `${COMMIT}:refs/…` or, better, `execFile` argv arrays with no shell.
  - Quote `HEAD^{tree}` in shells.

**Remote reconciliation** [CLI: `git ls-remote -h`, man] [LAB]
```sh
git ls-remote --exit-code origin refs/heads/orbit/<id>    # "<sha>\trefs/heads/orbit/<id>"; exit 2 when no match
```
- **Gotcha:** patterns match the *tail* of a ref. `orbit/run-1` also matched `refs/heads/x/orbit/run-1` [LAB]. Always pass the full `refs/heads/…` name and compare exact ref names in the output.
- Without `--exit-code`, no match prints nothing and exits 0.
- Other flags: `--branches`/`-b` (`--heads` is deprecated), `--tags`, `--refs`, `--symref`, `--sort`, `-o`.

**Isolation for Orbit-run git [LAB]:**
- `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1` plus explicit identity environment variables gave fully reproducible behaviour in the lab.
- To use a credential helper only per command, add `-c credential.helper= -c credential.helper=…` (see B1).

---

## Implications for Orbit

1. **UI runner invocation (trusted, not worker-editable):**
   ```
   npx playwright test --config <trusted-or-validated config> --project=<p...> --reporter=json --update-snapshots=none --fail-on-flaky-tests --forbid-only --retries=<policy> --trace retain-on-failure --output <evidence>/pw-output
   ```
   - Run it with `PLAYWRIGHT_JSON_OUTPUT_FILE=<evidence>/pw-report.json`, `PLAYWRIGHT_BROWSERS_PATH=<pinned>`, and a scrubbed env (the webServer inherits it).
   - Run it in its own process group with a wall timeout. Kill the group, then assert the port is free.
2. **Verdict from JSON, not the exit code alone.**
   - PASS requires all of: exit 0, `errors.length === 0`, `stats.unexpected === 0`, `stats.flaky === 0` (flaky is disclosed, never clean), and `stats.expected > 0`. The `stats.expected > 0` check guards against all-skipped runs.
   - Every required journey's spec (`file:line:title`) must be present with `status:'expected'` in every required project, and with no `skip`/`fixme` annotations.
   - Treat `config.updateSnapshots !== 'none'` as tampering.
3. **Baseline protection:**
   - Snapshot-dir hash before and after each run.
   - Forbidden-arg list: `-u`, `--update-snapshots*`, `--ignore-snapshots`, `--pass-with-no-tests`, `--run-agents`, `--last-failed`, `--only-changed`.
   - Config lint: `ignoreSnapshots`, `updateSnapshots` other than `'none'`, and a raised `maxDiffPixelRatio`/`threshold` relative to the baseline config all count as an assertion-weakening diff that needs review.
   - Remember that a default-mode run *creates* missing baselines in the repo.
4. **Failure brief assembly:**
   - From `results[].attachments`: `screenshot`, `trace`, `video`, `error-context`, `*-expected/actual/diff.png`, and the `orbit-diagnostics` JSON (base64 body).
   - From `errors[].message` with ANSI stripped, plus `errors[].location`.
   - Copy files into the run evidence dir and hash them, because paths are absolute and `test-results` is wiped on the next run.
   - `error-context.md` embeds model-directed "Instructions". Quote it to repair workers only as delimited untrusted data.
5. **Spec config mapping:**
   - `artifacts.screenshots: on-failure` becomes `use.screenshot: 'only-on-failure'`.
   - `traces: retain-on-failure` maps directly.
   - `viewports[]` become one project each (`desktop-1440x900`, `mobile-390x844`).
   - `accessibility.fail_on_new_serious_or_critical` becomes an AxeBuilder gate on `impact ∈ {serious, critical}` with fingerprint diffing.
   - `console_errors`/`failed_requests` become the auto fixture above. Note that HTTP ≥400 needs the `response` listener.
6. **Evidence binding:** record the Playwright version (`report.config.version`), Chromium revision and `browser.version()`, project name and viewport, the snapshot-dir hash, the config hash, and the candidate tree SHA.
7. **Delivery sequence (each step persists intent, then a receipt):**
   - (a) Compute `TREE` via the temp index. Assert it equals the tested tree.
   - (b) `commit-tree` with fixed identity and dates, which makes it deterministic.
   - (c) `git ls-remote --exit-code <https-url> refs/heads/orbit/<id>` to learn the remote state.
   - (d) Push `${COMMIT}:refs/heads/orbit/<id>` with `--force-with-lease=<ref>:<expected-or-empty> --porcelain` to an explicit HTTPS URL, using a `GH_TOKEN`-scoped helper. Parse the porcelain flags.
   - (e) Run `ls-remote` again and require SHA equality.
   - (f) `gh pr list --head … --state all --json …`. If an OPEN PR exists, use `gh pr edit`. Otherwise `gh pr create --draft --head --base --title --body-file`.
   - (g) Re-list and assert `headRefOid == COMMIT` and `isDraft`.
   - (h) Poll `gh pr checks --json …` and compute from `bucket`. Map "no checks reported" to `ci_absent_or_not_started` and cross-check `gh run list --commit $COMMIT`.
   - (i) On failure, read `gh run view <id> --json jobs`, then `--log-failed`, sanitized and size-capped. Handle 410 and "log not found" explicitly.
8. **Lost-response recovery:** every external action is reconcilable by a read.
   - Push: check `ls-remote` / `gh api git/ref`.
   - PR create: check `pr list --head --state all`.
   - Commit tree: check `gh api git/commits/<sha>`.
   - Never retry a create without that read.
9. **Credentials:**
   - Don't rely on the user's keyring token. It has `admin:org` and `repo` scopes and the protocol is ssh.
   - Require a fine-grained `GH_TOKEN` scoped to the target repo: Contents write (UNVERIFIED that it suffices for push), Pull requests write, Actions read, Commit statuses read.
   - Validate with `gh auth status --json hosts`, because that form always exits 0: check that the active entry has `state=="success"` and `tokenSource=="GH_TOKEN"`.
   - Avoid `gh run watch` (it does not support fine-grained PATs).
10. **Open UNVERIFIED items to close before v1 delivery:**
    - Playwright exit code on SIGINT.
    - The full `ConsoleMessage.type()` value list.
    - The fine-grained PAT permission for git push and for check-runs or `gh pr checks`.
    - A live run of the `gh pr create` "already exists" path and of `gh pr checks` exit 8. Both are confirmed by help and source only; neither was executed. Test them against a private sandbox repo.
