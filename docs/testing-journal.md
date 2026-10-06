# Testing journal

A running record of what we tested, what worked, what went wrong, why, and
what changed as a result. Newest entries at the top. Each entry ends with a
status: **fixed** (with the commit), **open** (with the gap id from
`docs/gaps.md`), or **watch** (no change yet, keep an eye on it).

Entry format:

```
### <date>: <area>: <title>
- Tested:
- Went well:
- Went wrong:
- Root cause:
- Change: (fixed in <commit> | open <G#> | watch)
```

## Summary of open items

| Item | Area | Status |
|---|---|---|
| Coverage below the floor (lines 89.5%, branches 78%) and not enforced | tests | open G40 |
| Live demo with real providers never run | demo | open G39 |
| Impact register never produced by the Inquisition | inquisition | open G30 |
| `final.json` written without redaction | report | open G46 |
| Planner does not select or justify engineering practices | planning | open G25 |
| Baseline exception has no runtime path into a contract | contract | open G27 |
| No rebase path when the base branch moves | delivery | open G37 |
| Supervised mode asks only about dependency changes | controller | open G15 |
| No memory limit under srt; limits off by default | isolation | open G24 |
| `orbit verify` judges security findings differently from VERIFYING | cli | open G47 |
| Release mode cannot merge the default draft PR | release | open G48 |
| Three tests flaky under full parallel load | tests | open G49 |
| One writer per run; merge overhead not weighed | scheduler | open G14 |
| Smaller items | various | open G4, G50 to G54 |

Closed in 30e6e5c: G1 to G3, G5 to G13, G16 to G23, G26, G28, G29, G31 to G36, G38, G41 to G45 and the six acceptance and fault-injection defects.

---|---|---|
| Completion ignores criteria blocked by the Inquisition | controller | open G6 |
| Authentication failure ends EXHAUSTED instead of BLOCKED | controller | open G7 |
| Worker that dies under a live controller is not restarted | controller | open G8 |
| Resource admission counts only the current run's workers | scheduler | open G9 |
| Implementer escalates to Opus after one failure | routing | open G11 (decision recorded in ADR 0001) |
| `orbit verify`, `orbit repair`, `orbit inquisition` missing behind the skills | CLI/plugin | open G1, G2 |
| `retention.redact_patterns` never applied | security | open G20 |
| Coverage below the floor (lines 88.9%, branches 77.9%) | tests | open G40 |
| Live demo with real providers never run | demo | open G39 |

---

### 2026-10-06: closing re-test of all three live demos (65a03ab)
- Tested: the live demo script, all three goals, real Claude and Codex, real delivery to the private demo repository (draft PRs #5, #6 and #7; reports in docs/demos/2026-10-06/). Then the UI goal once more on a demo branch whose config starts implementers on the cheapest tier (routing.overrides, disclosed), to try to exercise the repair loop live (draft PR #8 against that branch).
- Went well: all four runs SUCCEEDED unattended. Simple: Sonnet, the routine tier, one attempt, about 2.5 minutes. Difficult: escalated to Opus on recorded coupling evidence, browser journeys under srt, about 4 minutes. UI: a 9-criterion contract graded complex, escalated to Opus, CSV export with download journeys on desktop and mobile passing under srt, Codex cleared the tree, about 8 minutes. The collected reports carry no local paths.
- Went wrong: nothing failed. The spec's third demo asks for a UI task that first fails its browser checks; current models solve this goal on the first attempt, even starting from the cheapest tier (coupling evidence lifted it to Sonnet). The live repair loop on a real browser failure ran on 2026-10-06 (failed check, diagnosis, repair brief, second candidate) but its cause was the sandbox download defect, since fixed.
- Root cause: not a defect; Orbit cannot make a model fail, and planting a failure would not be evidence.
- Change: none to the product. The repair path for a UI defect is proven deterministically by acceptance scenario 17 (real Chromium, fake providers: reproduce, diagnose, repair, reverify, review, draft PR); the release notes say exactly this.

### 2026-10-06: end-to-end test 2: fix wave and integration (NB1 to NB3, NM1 to NM6, Nm1 to Nm11, P17, P27, P28, polish)
- Tested: every defect of the re-test synthesis with a test that failed first (four parallel fixers: loop, budget, cli, diagnose; then the integrator for the polish list), then as CI runs it: `npx tsc --noEmit`, `npm run test:coverage` with the per-file floor, `npm run build`, `npm run check:dist`, `node scripts/check-plugin.mjs`, `claude plugin validate --strict plugin/`, and the steps of `.github/workflows/ci.yml` in a native arm64 `node:22` container on a fresh copy of the tree.
- Went well: macOS green: 408 test files pass and 1 is skipped, 7041 tests pass and 4 are skipped; lines 99.48%, branches 95.71%, functions 99.48%, statements 98.78%, every file at least 80% lines. Linux: typecheck, unit (6217), fault (34), acceptance (37), check:dist and plugin validation pass; integration passes except one container-only case. The real-CLI test reproduced the diagnosis Bash denial exactly and caught the sandbox's writable working directory.
- Went wrong: Linux integration failed the plugin `init` test, because Linux git's default branch is `master` and `init` now adopts the checked-out branch (Nm4). One full macOS run failed `claude-real.test.ts` with "cannot send SIGTERM to process group: EPERM" (passes alone). Fixers saw each other's in-progress failures during the parallel wave; a Python edit turned `\b` into backspace characters (found and fixed). A worker summary was cut off mid-sentence twice, so every claim was checked against the diff.
- Root cause: the init test assumed `main` (test made deterministic with `git init -b main`); Darwin answers a signal to a process group with only unreaped zombies with EPERM, which `terminateGroup` turned into a crash (now it waits for the group to go, U/core/coverage-proc.test.ts). Container-only: the doctor `service` test needs `systemctl`, which the `node:22` image lacks (GitHub's Ubuntu runner has it).
- Change: fixed (uncommitted). Watch: Nm12 (srt start timeout under load, unconfirmed); a session killed mid-request with no model output is now charged $0 although the provider may have billed input tokens (NB2 trade-off); `parallel-writers.ts` can still overshoot a split cap by one request per unit; delivery credentials of a detached run are judged at preflight, not admission.

### 2026-10-06: re-test of all three live demos after the fix wave (e34bb12)
- Tested: the live demo script with real Claude and Codex and real delivery to the private demo repository, all three goals in one run, from the plugin/ bundle.
- Went well: the simple goal SUCCEEDED in about 2.5 minutes and the difficult goal in about 4 minutes (escalated to Opus on coupling evidence, browser journeys passed under srt, Codex cleared the tree, draft PRs opened). The UI goal now gets past planning (the raised output caps let the planner write an 8-criterion contract, graded complex), escalated to Opus, failed the browser check, was diagnosed and repaired: exactly the loop the spec asks for.
- Went wrong: every browser download is canceled inside the sandbox, so the CSV export journey could never pass; the implementer's own diagnostic journeys (a static file and a data URL) failed the same way, and the diagnoser suspected the sandbox. The run was cancelled after the second attempt.
- Root cause: the Seatbelt profile; outside the sandbox, and with the sandbox's exact environment but no Seatbelt, the same download succeeds. Two logged denials (disk-space query, an XPC lookup) were not the whole cause.
- Change: under investigation (bisecting the profile for the narrowest rule or a Chromium setting Orbit controls); a download journey is being added to the real-srt test first. Proposed: classify "every journey fails the same way, including the implementer's minimal probes" as an environment failure sooner.

### 2026-10-06: end-to-end test 1: second wave and integration (P13, P14, P17d, Linux, service)
- Tested: the adapters, Linux and service fixes; then, as CI runs them, `npx tsc --noEmit`, `npm run test:coverage` (with the per-file floor), `npm run build`, `npm run check:dist`, `node scripts/check-plugin.mjs` and `claude plugin validate --strict plugin/` on macOS, and every step of `.github/workflows/ci.yml` (with `CI=true`) on a fresh copy of the tree in a native arm64 `node:22` container (`--privileged --init`, as a non-root user with sudo).
- Went well: macOS green throughout: 385 test files pass and 1 is skipped, 6921 tests pass and 4 are skipped; lines 99.51%, branches 95.91%, functions 99.54%, statements 98.85%; every file at least 80% lines. On Linux typecheck, unit (6121), fault, acceptance (35), dist check and plugin check pass. The container provider's UI path, never working before (the application never became ready), now passes the demo's 6 functional journeys in one container with the official Playwright image.
- Went wrong: the first Linux run failed 5 tests none of the fixers saw. Playwright switches to its "dot" reporter when `CI` is set, so the demo test that looks for `[desktop]` would fail on every GitHub runner, macOS included; `demo-shapes` demo 2 ran the demo's visual journeys with no Linux baselines and ended EXHAUSTED; scenario 18 read a darwin-only baseline from the example; git 2.39 refuses to commit a gitlink while `diff.ignoreSubmodules` is `all`. One failure remains in the container and is container-specific: doctor's service check finds no `systemctl` in `node:22` (it passes there once systemd is installed, and GitHub's Ubuntu runners have it).
- Root cause: no one had run the suite with `CI=true` or on Linux since the visual baselines and the reporter assumption went in; acceptance labs recorded platform baselines only in `ui.test.ts`.
- Change: uncommitted. Demo `playwright.config.ts` pins the `list` reporter; `demo-shapes` records this platform's baselines first and scenario 18 compares with the lab template; the gitlink test sets the config after its commit. Also from the fixers' open items: a provider config directory may not be, contain or sit inside the Orbit home (it holds the service launcher); auth advice reads the controller's host environment; the container provider has `privateLoopback` and runs the launcher with the image's `node`; exploration refuses up front under a private loopback; doctor passes on Linux naming the one-sandbox mode; ADR 0001 and 0006, installation and troubleshooting updated. CI trimmed to Ubuntu on Node 22 and 24 and macOS on Node 24. Rows in `docs/traceability.md`, "End-to-end test 1".

### 2026-10-05: end-to-end test 1: fix wave (P1 to P29, D1 to D11)
- Tested: the defect list from the first end-to-end test; six fixers, each writing the failing test first, then one integration pass of `npx tsc --noEmit`, `npm run test:coverage` (with the per-file floor), `npm run build`, `npm run check:dist` and `node scripts/check-plugin.mjs`.
- Went well: every product defect but P13 and P14 (not in this wave) has a fix and a test that failed first (rows in `docs/traceability.md`, "End-to-end test 1"); typecheck, build, dist check, plugin check and the per-file floor pass; 6876 tests pass and 1 is skipped; coverage lines 99.52%, branches 95.96%, functions 99.54%, statements 98.87%.
- Went wrong: the fixes collided where they met. The P4 fix accepted every claim the Inquisition did not refute, so acceptance scenario 16 saw a finding accepted by default (a vote, not evidence); its "rejected" branch stored a rejection with no evidence, which `persistResolution` refuses. P15's token-priced charges removed the premise of the curator "budget reserve" test. P29's larger output budgets break five adapter tests that pin the old 4000 and 8000 values, in files the integrator may not edit. `inquisition/amendment-answers.ts` (P1) was below the 80% file floor.
- Root cause: each fixer verified only its own directories, so cross-area expectations met first at the integration run; the P4 fix used "not refuted" as the acceptance rule instead of what the inquiry recorded.
- Change: uncommitted. `steps/reviewing.ts:settleInquiredClaims` accepts a claim only when the inquiry's ledger supports it or an amendment cites it, rejects it with the ledger entry as its evidence, and otherwise leaves it pending and sends it to a repair attempt that runs its discriminating test; new unit tests for both ledger branches and for `amendment-answers.ts` (100% lines); the curator test now uses a budget equal to the cost cap. Open: the five adapter tests (`claude-fake`, `codex-fake`, `output-budget`) need their expected budgets moved to the new table (implementer 24000, reviewer 12000) by their owner.

### 2026-10-05: plugin packaging: the plugin moves to plugin/ (ADR 0006)
- Tested: a snapshot clone's `plugin/` installed through a local `git-subdir` marketplace with a fresh `CLAUDE_CONFIG_DIR` (no model calls); `claude plugin validate --strict plugin/`; the plugin, skill, hook and CLI tests, each written to fail first.
- Went well: the install ran `npm ci` on the plugin package only: `node_modules` held sandbox-runtime and its four dependencies (16 MB, was 137 MB); `plugin details` listed 8 skills, 7 agents and both hooks; `bin/orbit --version` worked by path and through PATH; doctor found srt in the plugin's own `node_modules/.bin` with no srt on PATH and the sandbox probe passed.
- Went wrong: the SessionStart hook called `questions --pending --quiet`, which did not exist, and swallowed the exit (P7); skills pasted `$ARGUMENTS` into shell commands (P25) and left runs without a controller (P11); plugin users had no init or doctor path (P10); the bundle read `templates/config.yaml` from beside itself, which the plugin does not ship.
- Root cause: the plugin root was the development workspace, so a marketplace install pulled every devDependency (P9); no test ran the hook against a real bundle or linted skill fences.
- Change: `plugin/` payload with a payload check in `scripts/check-plugin.mjs`; `bin/orbit`; srt found on PATH, then the nearest `node_modules/.bin` up from the bundle; the starter config inlined at build; `orbit questions --pending [--quiet]`; `orbit repair -` and `orbit resume --detach`; `/orbit:init` and `/orbit:doctor`; skills check `service status`, then `--detach` or `--foreground` with `run_in_background`, and pass free text through quoted here-documents (uncommitted).

### 2026-10-05: CI on a78669d did not run: Actions billing
- Tested: the first CI run with every prerequisite installed.
- Went well: nothing to judge; no job started.
- Went wrong: every job was refused with "recent account payments have failed or your spending limit needs to be increased"; the publish-guard workflow failed on the old commits that hold the slugged path (expected until the history rewrite).
- Root cause: the private repository's Actions allowance is used up (macOS runners count ten times).
- Change: CI is verified locally until the repository is public (Linux in a container, macOS on the maintainer's machine); public repositories run standard runners free. Proposed: macOS on one Node version only.

### 2026-10-05: browsers under srt: adversarial review of the preload change
- Tested: two independent reviews (Claude and Codex) of the uncommitted preload change; each finding reproduced with a failing test first (16 unit tests, 3 real-srt tests), then fixed.
- Went well: the preload itself held (no fail-open, no injection, no flag leakage); doctor now launches Playwright's headless Chromium binary directly and passes only on a nonce the page script computed, and fails under real srt without the rules; a hostile @playwright/test never runs; deny paths that spell the marker, sandbox-exec or an apostrophe patch cleanly under real srt.
- Went wrong: doctor's check required the repository's @playwright/test inside srt with no read-denies (credential exposure) and passed on exit 0 alone; repository text (an assertion message, stdout) or a command's own exit 97 could turn a journey failure into an environment block, also on Linux and the container provider; a path containing "(allow process-exec)" or "/usr/bin/sandbox-exec" made the preload refuse.
- Root cause: doctor reused the repository's Playwright as a launcher; the classifier read channels the repository can write and srt passes exit codes through; the preload counted substrings instead of parsing srt's quoting.
- Change: uncommitted. Doctor runs Orbit's own argv with credentialDenyPaths plus the repository denied; the preload parses srt's quoted words, matches the marker as a whole line, and records refusals beside srt's settings file (out of the sandbox's reach); the runner reads text only on macOS srt, only when no journey passed, only from browserType.launch errors.

### 2026-10-05: live demo 2 succeeds: escalation, browser checks under srt, draft PR
- Tested: the difficult goal with real delivery, from a build with the Chromium Mach-rule preload.
- Went well: doctor's new ui.browser-isolation check passed; the planner graded the change medium with high subsystem coupling and the router sent the first implementation to Opus with that evidence; lint, unit and the browser journeys (desktop and mobile) passed under srt on the first attempt, with the isolation adjustment disclosed in the UI gate; Codex cleared the exact tree; Orbit pushed an orbit/* branch and opened draft PR #2; progress streamed live. About five minutes end to end.
- Went wrong: nothing failed. CI is unverified because the demo repository has no workflow (allowed by require_ci: false and stated in the report).
- Root cause: not applicable.
- Change: none.

### 2026-10-05: browsers under srt on macOS: the two-rule preload
- Tested: the chosen design from ADR 0001 ("Browsers under sandbox-runtime on macOS"), tests first: preload unit tests (10, all failing before the file existed), wrap() argv tests (7), runner, classifier and environment-block tests (8), doctor tests (5), then examples/demo-app through Orbit's UI runner under the real srt 0.0.78.
- Went well: without the rules the FATAL still appears and the run is an environment ERROR; with them 8/8 journeys pass on desktop and mobile, twice; inside the patched sandbox other Mach names (com.example.*, a non-numeric suffix) get 1100, a denied canary gives EPERM, egress off the allowlist fails and a HOME write gives EPERM; an srt copy with the marker doubled exits 97 and is classified as an environment failure; doctor launches a real headless Chromium through the preload.
- Went wrong: the first integration run timed out the app fixture in under a second, and the first unit run of the spawn hook read a mock it had already replaced.
- Root cause: the test passed a ManualClock to the runner, so the app fixture's readiness wait did not run on real time; the test took the mock reference after installing the hook.
- Change: uncommitted (this round). Linux remains unverified until CI runs the real-srt test; `ui.isolation: container` from the ADR is not implemented (isolation.provider: container is the existing opt-in).

### 2026-10-05: live demo 2, second run: escalation proven, Chromium cannot start under srt
- Tested: the difficult goal with real delivery, from a build of the fixed tree (kept in an ignored `.demo-build/`, because Orbit resolves `agents/` and `srt` relative to its bundle).
- Went well: the model probe validated Opus, Sonnet and Haiku; the planner graded the change medium with high subsystem coupling, and the router sent the first implementation to Opus "escalated from claude-sonnet-5-5" with that evidence (spec section 8, coupled changes); the app fixture now starts and the browser journeys execute.
- Went wrong: every journey failed at browser launch; the run treated that as a code failure and started an Opus repair, so it was cancelled. The demo script's output was block-buffered, so a running demo looked frozen.
- Root cause: Chromium registers a Mach service (bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer.<pid>), and srt's Seatbelt profile allows only listed mach-lookup names, with no mach-register option (also absent from the latest srt). `--single-process` starts but crashes on a browser's second context (3 of 8 journeys). sed buffers when its output is not a terminal.
- Change: four browser-under-sandbox designs are being prototyped and judged (Seatbelt rule through srt's library, one browser per test, browser outside the sandbox with locked egress, Linux container). The demo script line-buffers its filter (test failed first). Proposed: a browser that cannot launch is an environment failure, not a repair.

### 2026-10-05: CI, second pass: the integration tests had never run in CI
- Tested: CI on 55a0aaf, which fixed the three unit-test assumptions.
- Went well: Ubuntu's unit tests passed and its jobs reached the integration tests for the first time; every remaining failure had a concrete, environment-specific cause.
- Went wrong: the integration step failed in 10 to 11 files on Ubuntu and one unit file on macOS.
- Root cause: CI installed the claude CLI after the tests that call it and never installed Playwright's browsers or srt's Linux prerequisites; a limits test read back with /bin/sh (dash has no `ulimit -u`); the limit tests expected the requested process count, while macOS reports at most kern.maxprocperuid and the wrapper now keeps a stricter host limit; the demo example test expected Node's TAP summary, but newer Node prints the spec format. Two Linux-only failures (fake-Claude cancellation, the environment-failure wording) are being reproduced in a Linux container.
- Change: ci.yml installs bubblewrap, socat and ripgrep (relaxing Ubuntu's AppArmor user-namespace restriction), Playwright's Chromium and the claude CLI before any test; the tests read back with bash, compare with what the host itself reports, and accept either reporter's summary line; verified under a 1333-process hard limit.

### 2026-10-05: pre-public audit: NO-GO, then remediation
- Tested: four independent scanners (full history terms and secrets, identity and paths, semantic content review, GitHub-side content) and an adversarial verifier that re-checked every finding and covered the gaps itself.
- Went well: the verifier's separator-insensitive search found what all four scanners missed; 20 gitleaks hits were confirmed synthetic by reading each one; Actions logs, settings and secrets were clean.
- Went wrong: a scratchpad path that embeds the home directory as a hyphenated slug sat in two interface docs since the first commit; publish-guard passed it because it matched terms only as exact strings. A journal entry described leaks in other repositories. Tools run with HOME unset or set to a literal "~" wrote `Library/` and `~/` into the working tree, one holding a local tool token.
- Root cause: exact-string term matching; scratch paths pasted into docs; no ignore rule for HOME-relative tool output.
- Change: the docs use placeholders; the journal entry is generic; both stray directories are deleted and ignored. publish-guard 0.1.2 matches multi-token terms across separators (failing-first tests; zero new false positives over two trees); its history audit flags the old commits and passes a rewritten copy. History is rewritten and the repository recreated before going public (owner's decision), since old SHAs stay reachable after a force-push. Git hooks installed in four more plugin repositories; the plugin updated in every Claude config.

### 2026-10-05: CI on main failed in every job: three environment assumptions
- Tested: each failing group reproduced locally under CI-like conditions before any change.
- Went well: each reproduction matched CI exactly (15, 3 and 3 failures); no assertion was loosened.
- Went wrong: the rebase tests relied on the Mac's `init.defaultBranch=main`; a shim test helper blocked the event loop that writes the log it waited for; the release tests ran the verify command under a process limit above the macOS runner's hard limit.
- Root cause: tests never ran without the maintainer's git config, on a slow start, or under a low hard limit. The last one is also a product defect: a limit above the hard limit makes the wrapper exit 1, which a verify command reads as "not deployed".
- Change: the tests are hermetic (explicit initial branch, a readiness file, a forced ps branch). The limit wrapper keeps a host's stricter hard limit and exits 125 with a message when a limit cannot be read or applied (tests failed first); the release tests' workaround is reverted and they pass under a 1500-process hard limit.

### 2026-10-05: live demo 1 with real delivery: draft PR opened
- Tested: `run-live-demo.sh --goals simple` against the private demo repository, autonomous-delivery mode, real Claude and Codex, the scoped token.
- Went well: SUCCEEDED in three minutes: contract, Sonnet implementation passing lint and unit first time, Codex review of the exact tree, commit, push of an `orbit/*` branch and a draft pull request (#1), CI observed for the delivered SHA. The token never appeared in any output or report; progress lines now show local time.
- Went wrong: nothing failed. Two observations: CI is reported unverified because the demo repository has no workflow (honest, and `require_ci: false` allows it; the spec's demos do not require CI); and the route note said no claude-cli model was validated yet.
- Root cause: the model registry is per repository and starts unvalidated, so in a fresh demo clone Opus is ineligible and the difficult demo could never escalate to it.
- Change: the demo script runs `orbit models refresh --probe` after doctor (a failed probe is a warning, not fatal); test "validates the models live after doctor and before the first run" failed first. Proposed: doctor warns when no eligible model is stronger than the routine route.

### 2026-10-05: live demo script, first delivery attempt: stopped at doctor
- Tested: `scripts/demo/run-live-demo.sh --goals simple` against the private demo repository with a fine-grained token scoped to that repository only.
- Went well: the script refused nothing it should have accepted, kept the token out of its output, seeded the empty repository, and stopped before any run when doctor failed (exit 3), exactly as designed. The token was checked first without printing it: correct prefix, push access to the demo repository, no access to any other repository.
- Went wrong: doctor failed with "@playwright/test is not installed".
- Root cause: the script ran `npm ci` only inside the branch that records visual baselines; the demo app already ships macOS baselines, so nothing was installed, and the existing-repository path never installed at all.
- Change: one `install_deps` step always runs before doctor and is reused by the baselines step; integration test "installs the dependencies before doctor, also when the repository already exists" failed first.

### 2026-10-05: live demo 2 (difficult goal): blocked because the UI app could not start
- Tested: the difficult goal (a pagination totals bug) live, autonomous mode, real Claude and Codex.
- Went well: the planner wrote a 4-criterion contract with two UI criteria and made the `ui` check mandatory; Orbit refused green unit checks as proof of UI criteria (Inquisition: unsupported confidence) and finally blocked with an exact reason (mandatory verification unavailable) instead of passing. Routing stayed on Sonnet: no repeated failure fingerprint, so no escalation, as ADR 0001 requires.
- Went wrong: the demo app crashed at start inside the UI fixture (Node aborts in process initialization, SIGABRT), so the browser journeys never ran; the repair loop then repeated the same tree twice before blocking. Progress lines printed UTC times without saying so, which looked like a two-hour stall.
- Root cause: the app fixture handed the app its log, which lives under the read-denied run directory, as stdout and stderr; under Seatbelt fstat on that descriptor fails with EPERM and node aborts at startup. Check shims use pipes, so checks were unaffected. The repair loop does not yet recognize "mandatory check could not execute" as an environment failure the implementer cannot fix.
- Change: the stdio file is readable (exactly that file, read-only) through `WrapOptions.stdioFiles`; a mandatory check that cannot execute now blocks at once as an environment failure (both tests failed first). Progress and log times use local time; the test suite pins TZ=UTC and the clock test proves local time in another zone.

### 2026-10-05: live demo 1 succeeds end to end
- Tested: demo 1 after tier selection by login type (7cfe79c).
- Went well: SUCCEEDED in about 90 seconds: preflight, a real 3-criterion contract, graded simple, Sonnet implementation passing lint and unit on the first attempt, Codex (gpt-6.1-sol, codex-sandbox tier) clearing the exact tree, completion bound to that tree. Report in docs/demos/2026-10-05/demo-1-simple.md.
- Went wrong: the budget shows 4.18 of 30 USD against 0.18 USD of measured model spend.
- Root cause: Codex reports no cost, so the review is charged its conservative ceiling (spec section 7: unmeasured spend is admitted conservatively and reported, never claimed exact).
- Change: none needed; the report states that spend is partly unmeasured. Proposed: estimate Codex cost from its reported tokens when the plan's pricing is known.

### 2026-10-05: live demo 1, third run: Codex with a ChatGPT login cannot work under srt
- Tested: demo 1 after the single-sandbox fix (7369267); then direct probes of Codex inside srt with and without its apps and plugins features, with srt debug logging, and curl through the same proxy.
- Went well: the nested-sandbox error was gone and Codex started; curl through srt's proxy reached chatgpt.com while example.com was refused, which ruled out the allowlist; srt's debug log showed every Codex request to chatgpt.com allowed, which ruled out host blocking; the run again blocked honestly at review rather than skipping it.
- Went wrong: Codex failed with "workspace routing discovery failed" after five reconnects, in the run and in the direct probe; disabling apps and plugins did not help.
- Root cause: inside Codex's client when it talks to the ChatGPT backend through srt's proxy; not pursued further (outside our code, and diminishing returns).
- Change: ADR 0001 records tier selection by login type (ChatGPT login: codex-sandbox; API key: os-sandbox; explicit override); implementation in progress. Proposed: report the issue upstream with the minimal srt plus codex reproduction.

### 2026-10-05: live demo 1 re-run: verification passes, the Codex reviewer cannot start
- Tested: demo 1 again on a fresh lab after the loopback and environment-failure fixes (9a81424).
- Went well: graded simple; the first candidate passed every mandatory check (the unit suite now binds loopback); the run blocked honestly at review instead of skipping the mandatory independent reviewer.
- Went wrong: the Codex reviewer exited 1 twice with `Operation not permitted (os error 1)`.
- Root cause: in the os-sandbox tier Codex runs inside srt and also starts its own Seatbelt sandbox (`--sandbox read-only`); macOS refuses to apply a Seatbelt profile from inside another (`sandbox_apply: Operation not permitted`, reproduced directly). The interface notes had marked this combination unverified, and no test exercised a real nested sandbox.
- Change: ADR 0001 "Codex reviewer tiers": srt is the only sandbox in the os-sandbox tier and Codex runs with `danger-full-access` inside it, the review checkout never writable; fix in progress.

### 2026-10-05: first live run with real providers (demo 1, simple goal)
- Tested: Orbit end to end on a local copy of the demo app in autonomous mode with the real Claude CLI (subscription login, claude-sandbox tier) and Codex as reviewer, no delivery.
- Went well: `orbit doctor` found three real bugs before any model spend (a keychain login reported as logged out because USER was dropped, `@axe-core/playwright` reported missing because its exports hide package.json, `npm run --silent lint` read as a script named "--silent"); a contradictory mode/actions config was refused with exit 4; the real planner produced a 3-criterion contract with the practices block; routing stayed on Sonnet with no unjustified escalation; the run stopped honestly at EXHAUSTED instead of claiming success.
- Went wrong: the `unit` check failed on the base revision and every candidate with `listen EPERM 127.0.0.1` because trusted checks ran with loopback binding denied; Orbit then spent all three attempts on a failure the code could not cause (repairs produced the identical tree). Config problems were printed twice.
- Root cause: the check sandbox profile denied local binding for all checks; diagnosis did not distinguish an environment failure identical to the baseline from a code failure; the CLI printed the error message and its problem list.
- Change: doctor and CLI fixes made (tests failed first); check `local_binding` (default true) and environment-failure blocking in progress. Demo 1 to be re-run after.

### 2026-10-05: security re-reviews: all eight findings closed
- Tested: two further Codex (gpt-6.1-sol) re-reviews of the fix diffs, each judging every finding and whether its test would fail if the fix were reverted.
- Went well: the first re-review confirmed five fixes and showed exactly why three were partial (built-in credential globs only, line-wise redaction missing multi-line keys, scan completeness tied to blocking severity) plus a new CI bypass (only the first page of commit statuses read, aggregate failure discarded); the second confirmed all four closed.
- Went wrong: the second re-review found a defect in my own follow-up (`scope.credential_paths` skipped glob validation, so an absolute path protected nothing). I also committed 2fbc86a while the full gate had one failing test, because the command chain did not stop on the test exit code.
- Root cause: a new config key was added without routing it through the existing validator; the flaky test sent SIGINT before the fake provider installed its handler; my commit step was not conditional on the gate.
- Change: fixed in 2d0710b, 2fbc86a and 895355a (credential paths validated; the test waits for readiness). Commits now run only when `npm run test:coverage` exits 0.

### 2026-10-05: independent security review by Codex (gpt-6.1-sol)
- Tested: an adversarial review of the policy, isolation, adapter, delivery and controller modules on a read-only checkout of 7f7d0d7, by a different provider than the one that wrote the code.
- Went well: eight concrete defects with failure scenarios and demonstrating tests; it confirmed no further defect in publication guarding, policy hash verification, candidate/evidence/review tree matching and UNKNOWN-deploy reconciliation. Running it through the Codex CLI cost no Claude tokens.
- Went wrong: one critical (parallel integration could write through a symlink outside the worktree) and six high (delivery actions not fenced by the lease, worker shells able to read credential files and git config, unredacted worker output, additional push URLs, large files skipping the secret scan while reporting complete, approve-once widening worker permissions), one medium (checks attributed to the wrong SHA). Separately, `gpt-6.1-sol` was refused for ChatGPT-account logins on codex-cli 0.153.4.
- Root cause: our own reviewers checked each module against its brief; the cross-cutting paths (controller writing as itself, grants, remote configuration) fell between briefs. The model refusal was an outdated CLI.
- Change: decisions in ADR 0005; fixes in progress with failing-first tests. `codex update` to 0.160.0 made gpt-6.1-sol work; `orbit doctor` should warn on an outdated Codex CLI (proposed).

### 2026-10-05: minor gaps: target environment, late approvals, coverage floor
- Tested: the last minor gaps, each with a failing-first test checked by reverting the fix.
- Went well: `orbit run --environment`, late baseline-exception approvals and the rebased-then-failing candidate now have end-to-end tests; the coverage gate also enforces a per-file floor.
- Went wrong: an older release test assumed a partial deploy before a refused environment; a browser-launch test errored once under load.
- Root cause: only the unit suite of the changed module was run before the full suite.
- Change: fixed in 8515373. Proposed: `npm run test:related` mapping a source directory to its unit and integration suites.

### 2026-10-05: gap-fix round: 37 spec gaps closed, five more defects found in review
- Tested: seven fixers with disjoint file ownership, each closing gaps with a test that failed first; an adversarial verifier over the controller, release and policy changes; a fresh traceability audit that only counted a gap closed after reading its test.
- Went well: the fake-provider lab made every controller gap reproducible end to end; all six `it.fails` defect markers flipped to passing; release mode reused the action ledger, freshness gate and isolation profiles, so `release.ts` stayed small; traceability rose from 285 to 341 of 359 requirements done.
- Went wrong: the verifier found five defects in fresh fixes, including a release that could wait forever for a branch check that never reports, and a dependency audit that could not run being dropped from the evidence report; strict model-output schemas made a new planner field (`practices`) impossible to add without touching four other owners' fixtures; ownership boundaries left cross-file follow-ups behind (the demo app's copy of the Playwright template, `orbit verify`'s security wiring, the impact register call site); the default draft pull request makes release-mode merge impossible; three tests are flaky under full parallel load; I stopped a fixer's background test run by mistake after misidentifying it as a leftover.
- Root cause: one scheduler limit mixed per-run settings with machine capacity; the controller trusted spend nobody measured (auth failures and lost sessions charged at the cap); parallel fixers cannot finish changes that span owners.
- Change: fixed in 30e6e5c (37 gaps, 5 verifier defects, the template copy). Open G14, G15, G24, G25, G27, G30, G37, G39, G40, G46 to G54 (see docs/gaps.md). Process: cross-owner follow-ups now get one integrator agent after the parallel round, and I check a background task's command before stopping it.

### 2026-10-05: publication hygiene lessons
- Tested: sanitized history rewrites, each verified offline by two scanners, commit counts and tip diffs before any force-push.
- Went well: force-with-lease pins meant nothing could overwrite a concurrent change; branch protection was restored by a trap on every exit path; unpushed local branches were remapped onto rewritten history with uncommitted work intact.
- Went wrong: a broader term list found leaks a narrower first audit had missed; shell variables passed as single arguments under zsh broke two command batches (nothing was changed either time).
- Root cause: a narrow term list; a "forbidden words" guard that lists the words publishes them; zsh does not word-split unquoted variables.
- Change: guard greps replaced by publish-guard (terms stay private, outside the repository); multi-argument shell work goes through bash scripts with arrays.
### 2026-10-05: privacy: personal data added to the guarded terms; Orbit published privately
- Tested: a scan of Orbit (working tree and full history) and the plugin catalog for personal identifiers (home path, personal email, machine name, personal Claude config directory names, a third party's name), then the first push of Orbit through publish-guard's pre-push hook.
- Went well: the catalog was already clean; Orbit had one real hit (a test using a personal config directory name as sample data) and two in the first version of an interface note. The pre-push hook passed only after history was clean, which is the point of it.
- Went wrong: a broad scan for the personal config name also matched the Orbit identifier `claude-worker`; converting fixture literals to runtime-built addresses left two partial domains that still parsed as addresses, which the pre-commit hook caught.
- Root cause: substring terms need word boundaries where they overlap real identifiers; fixture rewrites must move the whole domain into the runtime constant.
- Change: personal identifiers added to the private terms file with a word-bounded pattern for config directory names; CI secrets refreshed in all six guarded repositories; Orbit's unpublished history rewritten (fixture domains, config names) and pushed to the private repository at 5b63791.

### 2026-10-05: coverage: first measurement
- Tested: `vitest run --coverage` over `src/**` (v8 provider).
- Went well: functions 90.5%, lines 88.9%, statements 85.8% on the first measurement; every source file is reached by some test.
- Went wrong: branches 77.9%. 20 files below 80% lines, worst `cli/commands/doctor.ts` (0.9%), `adapters/shim.ts` (29.6%), `controller/workers.ts` (61%), `policy/bash.ts` (68.5%).
- Root cause: code exercised only in spawned child processes (shim, hook, controller restarts) is invisible to in-process v8 coverage; `doctor` and the service commands have only smoke tests.
- Change: open G40. Floor set to lines and functions 95%, branches 90%, no file under 80% lines; child-process code needs in-process entry tests or `NODE_V8_COVERAGE` collection.

### 2026-10-05: acceptance and fault injection: six runtime defects surfaced
- Tested: all 20 mandatory scenarios, the six safe stops, the three demo shapes, and the 13 spec faults, against the real controller with fake providers and FakeGitHub.
- Went well: restart without duplicate workers or actions (scenario 7), exactly one PR after a lost response (8), stale evidence refusing delivery (10), cancellation surviving restart (20), prompt injection staying fenced, indirect shell writes caught by scope inspection, policy tampering blocked.
- Went wrong: a criterion blocked by the Inquisition did not stop SUCCEEDED (G6); an expired credential was charged the session spend ceiling first and ended EXHAUSTED (G7); an implementer killed under a live controller was never restarted (G8); two runs on one controller both admitted implementers under memory saturation (G9); one failed Sonnet attempt escalated to Opus (G11); the UI evidence entry dropped `checkId`, so every UI goal ended INCOMPLETE.
- Root cause: gates and accounting were each tested in isolation; only end-to-end runs exposed the ordering between cost charging, credential blocking and completion.
- Change: UI `checkId` fixed in b7bd4d2 (3 lines). The rest open as G6 to G11; each has an `it.fails` test that must flip to `it`.

### 2026-10-05: tooling: npm dropped a native vitest binding, twice
- Tested: adding `@vitest/coverage-v8`; earlier, the first wave-1 install.
- Went wrong: vitest failed at startup (`@rolldown/binding-darwin-arm64` missing) after an `npm install` of a new dev dependency.
- Root cause: npm's optional-dependency bug drops platform packages when the lockfile is updated in place.
- Change: watch. Workaround is `rm -rf node_modules package-lock.json && npm install`. CI should run `npm ci` on macOS and Linux so a broken lockfile fails there first.

### 2026-10-05: publish-guard dogfooding on Orbit
- Tested: the first push of Orbit to its private repository through publish-guard's pre-push hook.
- Went well: the hook blocked the push and named every offending line with the address masked; no term was ever printed.
- Went wrong: the findings were fixture addresses on real-looking domains (`acme.io`, `widgets.io`) and one on a subdomain of `example.com`.
- Root cause: tests used real-looking domains; publish-guard exempted `example.com` but not its subdomains.
- Change: publish-guard 0.1.1 (catalog 90811f3) exempts subdomains of the RFC 2606 example domains; tests that need a real-looking address build it at runtime. Orbit fixtures still need moving to `.test` domains before the first push (open, part of G42 cleanup).

### 2026-10-05: wave 3: recovery and controller under adversarial review
- Tested: recovery and controller modules, each attacked by an independent verifier writing failing tests first.
- Went well: verifiers found real high-severity defects before any end-to-end run.
- Went wrong: a check shim known only from `pid.json` was judged alive by bare pid, so a recycled pid in an ended run could receive SIGTERM; a crash takeover moved a run waiting in INQUISITION to the stage before it and spent recovery budget; a RUNNING worker row with missing files was restarted while its process still ran; review findings ended runs BLOCKED instead of entering a repair loop.
- Root cause: liveness checks without start-time identity; INQUISITION treated as a crash-recoverable working stage; review resolution routed every claim to the Inquisition.
- Change: fixed in 0ae38b9 and b7bd4d2 (start-time ownership checks, INQUISITION excluded from RECOVERING, review repair loop).

### 2026-10-04: wave 2: adapters under adversarial review
- Tested: Claude and Codex adapters, the worker shim, real `claude` against a fake Anthropic API.
- Went well: real-CLI tests at zero model cost; both isolation tiers exercised.
- Went wrong: a restart in the same worker directory reused the first attempt's `--session-id`, which the CLI rejects; an archived attempt could leave a live orphan beside the restarted worker; `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` silently switched the permission mode to `default`; the inquisitor's task environment carried policy variables that every adapter refuses (G18).
- Root cause: session ids derived per worker instead of per attempt; environment variables with side effects on permission mode.
- Change: fixed in 638109e except G18 (open).

### 2026-10-03: interface verification: the docs were wrong in twelve places
- Tested: every external interface against current docs and the installed CLIs.
- Went well: a fake Anthropic API let the real `claude` binary run with scripted responses, so hooks, permissions and result shapes were observed, not assumed.
- Went wrong (documentation vs reality): `--setting-sources user` loads the user's plugins and hooks into workers; `--bare` skips every hook; `claude auth status` reports a fake key as logged in; a keychain login is invisible inside srt; SIGINT exits 0 with no result line; Codex does not enforce `--output-schema`; `--max-budget-usd` is checked only after a response.
- Root cause: docs lag the CLI; behaviour differs between subscription and API-key auth.
- Change: fixed in design (ADR 0001 worker tiers, ADR 0003 auth, `--setting-sources ""`, Orbit validates every structured output itself).

### 2026-10-03: process: orchestration mistakes worth not repeating
- Went wrong: a workflow was launched with a placeholder argument instead of the commit list; a command chain reported success because `| tail` swallowed a failing exit code; an agent resolved a mirror path relatively and its "0 findings" meant "nothing scanned"; the weekly usage limit stopped three agents mid-task.
- Went well: workflow resume replayed finished agents from cache, so only the interrupted work re-ran; per-agent model choice (Opus only for security and integration, Sonnet for the rest) cut token use.
- Change: watch. Check `PIPESTATUS`-safe exit codes, assert absolute paths in verification output, and treat "0 findings" as suspicious until the scanner proves it can find a known leak.
