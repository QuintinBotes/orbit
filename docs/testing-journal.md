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

### 2026-10-06: run start and managed plugins: the doctor failure that `orbit run` ignored (issue #22)
- Tested: `orbit run --foreground` with Claude Code loading four managed plugins and the default policy (`agents.allowed_plugins: []`, `agents.allow_managed_plugins: false`), over the real adapters and the fake `claude` (scenario `plugins`), with a base revision whose check fails so a baseline question would be raised.
- Went well: the report reproduced exactly. Doctor failed `claude.plugins`; the run created itself, ran the base checks, raised the baseline question, started a planner twice and ended `BLOCKED: the planner: no usable result after 2 attempt(s) (last: failed, ...)` with the refusal cut mid-sentence at 200 characters.
- Went wrong: the refusal existed only at session collection (`classifyClaudeTranscript`), so nothing before a worker looked at plugins; a refused session was a plain failure, regenerated like malformed output; the outcome line sliced the error; the curator, a session in the same environment, was started for a run with gate decisions that cite evidence.
- Root cause: doctor's judgement lived in the CLI (`doctor-plugins.ts`) and was never called at run start; the retry classifier had no notion of a refusal that the next session repeats; the curator gate looked only at observations.
- Change: fixed on branch fix/issue-22-plugin-policy-preflight. One shared judgement (`adapters/worker-plugins-check.ts`) used by doctor, admission (before the run exists) and PREFLIGHT (before any check); a refused session blocks once, in full, and is not retried; no curator for a refused run with no candidate. `FakeAdapter` now lists plugins so the fake exercises doctor and run start the way the CLI does. Watch: a plugin whose scope doctor cannot place is only a warning, so its refusal still happens after the first session (once, not twice, and with no curator).

### 2026-10-06: preflight classification, fourth review round (#10, #23)
- Tested: the surfaces that print the way forward of a blocked run (the `orbit resume` refusal, the foreground run summary, the notification) for the CONTRACTING missing-target block, a forced resume of a PREFLIGHT misconfigured check with the tool fixed outside the policy, the cap on the stored outcome reason with several long log paths, and the fixtures scan on its own samples.
- Went well: the forced resume of a PREFLIGHT block does run the check again and goes on once the tool is fixed, so the doc claim could be checked with a stand-in `dotnet`; the by-cause advice was already in the reason, so the other surfaces only had to stop contradicting it.
- Went wrong: (1) the self-test of the fixtures scan used the real session id, assembly hash and pid that the scan had just removed from the fixtures, so the squash would have published them under another path. (2) The `orbit resume` refusal and the foreground summary still said "fix .orbit/config.yaml" for the missing-target block, because it is still recorded as a frozen-policy block; troubleshooting spotted a frozen-policy block by a sentence this block's reason no longer carries. (3) Four documents and one comment said a forced resume "reads the same recorded baseline": true at CONTRACTING, false at PREFLIGHT, where the baseline is incomplete and the check runs again. (4) The notification of any frozen-policy block said "resolve the block, then run orbit resume". (5) The 2000-character cap on the stored reason cut off the advice, which comes last, once several missing targets had long log paths. (6) The scan read only the top level of a capture directory.
- Root cause: one recorded setting (`frozen_policy`) stood for causes with different fixes, and each surface chose its sentence from it; the cap and the self-test samples were not written with their consequences in mind.
- Change: `missingTargetChecks` (resume.ts) tells the missing-target block from an argument error, and the refusal reuses `missingTargetAdvice`; the summary and the notification point to the report and say resuming alone would only block again; `finishRun` cuts the evidence, never the advice at the end; the self-test uses made-up values and the scan walks subdirectories; docs say a forced resume runs the same command again (it blocks again unless the tool changed outside the policy) and that a tool "not installed or restored yet" is what the advice means (a dotnet local tool is declared in the repository). Rejected: restoring the VSTest correlation property to the MSB1001 capture (the scan rejects any GUID on purpose and nothing reads the property). Watch: the branch's first commit holds the real session id in its history, so it must be squash-merged.

### 2026-10-06: preflight classification, third review round (#10, #23)
- Tested: the CONTRACTING block for a missing target end to end, the real npm with a script the contract does not name and a stand-in `cargo` printing cargo's real "no such command" error for `nextest` (exit 101); then the plugin "installed" (the stand-in passes) and the transition `orbit resume --force` makes replayed. Every captured fixture scanned for GUIDs, pids, home directories, temp directories and long hexadecimal ids. The whole branch diff read again against the final behaviour.
- Went well: the forced resume after installing the plugin blocks again on the recorded baseline, as the advice now says; the classification rules needed no change.
- Went wrong: the missing-target block at CONTRACTING ended with the generic frozen-policy advice ("Fix the config, then cancel this run and start a new run"), after its own "Fix: correct checks.X.command ..." and a sentence about the goal, so a block caused by a goal that should create the target, or by a cargo plugin installed outside the repository, was told to fix the config twice (it named no `--force`: round two had removed that). `dotnet-msb1001-unknown-switch.log` still carried VSTest's `<pid>_<guid>` session id: round two changed it to `4242_` and a nil GUID, which is still a GUID and which a `\b`-bounded pattern does not see after the underscore; `dotnet-xunit-v3-eperm.log` carried xunit's 64 digit assembly id. Wording outlived the behaviour: the ADR and the docs said the CONTRACTING block only "adds" a sentence to the same fix, and operations.md and baseline-questions.ts called a sandbox refusal "the environment's" when PREFLIGHT blocks on those before a question exists. The oldest entry below still said the MSB1025 fixture was reconstructed.
- Root cause: `finishRun` had one frozen-policy advice for every setting, and a missing target is not only a config fix. Neutralising a capture was by hand, and nothing read the fixtures.
- Change: `missingTargetAdvice` (by cause: a goal that creates the target says so in a new run, a target supplied outside the repository needs a new run once installed, a wrong command is corrected; no `--force`), passed to `finishRun` as `frozenAdvice`, with the baseline-exception refusal naming the same causes; the session id property dropped from the MSB1001 capture and the assembly id zeroed; `tests/unit/evidence/fixtures-neutral.test.ts` fails on a GUID, a pid, a real home or temp directory or a long hex id in the capture directories (and checks it catches each); the ADR, CHANGELOG, operations, troubleshooting, configuration and traceability reworded. Watch: a new capture directory under `tests/fixtures` must be added to the scan.

### 2026-10-06: preflight classification, second review round (#10, #23)
- Tested: real .NET test runners with `dotnet run` on macOS (.NET 9.0.305 SDK): MSTest 3.6.4's and 4.4.1's runners (Microsoft.Testing.Platform 1.4 and 2), TUnit 1.72.16, and xunit v3 3.2.2 in its own runner and in platform mode, a test that creates a directory under `/System` (EPERM) or reads `/etc/sudoers` (EACCES); `dotnet test` with VSTest for comparison. Real npm 11.6 with `"test": "cd client && npm test"` and `"lint": "npm run lint --prefix web"` where the nested package has no such script, with and without `--silent`. `dotnet format` as a check under Orbit's runner and srt on macOS: with `-m:1`, plain, with `--no-restore` after a restore, and `whitespace --folder`. pytest 8.4 with `--cov` and the plugin not loaded.
- Went well: VSTest's `Failed!  - Failed: 1` was already read as a failing test; npm prints no lifecycle banner for the command's own missing script, even with a pre-script, and `--silent` hides both the banner and the nested error; `dotnet format whitespace --folder --verify-no-changes` passes in the sandbox in about a second.
- Went wrong: the platform's report (`failed X (12ms)`, then `total: 2` and `failed: 1` on their own lines) and xunit's (`[FAIL]`, `Failed: 1,`) were not recognised as failing tests: on the branch the EPERM test left the repair loop on a candidate (filesystem-denied, an ungated signal) and the EACCES test blocked the base revision as an environment failure. A script that hands the same name to a nested npm was blamed on the check's command as a missing target. `-m:1` broke a `dotnet format` check (it reads it as a project), and the suggested `--no-restore` does not work either: the format's project loader times out on its build host's named pipe after a minute. A missing target blocked CONTRACTING only after the contract was written and another check's question was withdrawn as expected to flip. The frozen-policy advice offered `orbit resume --force` for a misconfigured check, which only blocks again.
- Root cause: round one's `\s+` read the platform's summary as a count only by accident across a line break; holding the count to one line (for the NuGet `-1` then `Failed to restore` case) removed it, and no fixture of a .NET test runner other than VSTest existed. `npm-missing-script` required only the script name, and npm's banner, which shows npm ran a script, was not read. The socket fix was verified on `dotnet test` only. The order of steps in CONTRACTING's accept. A setting-blind advice string.
- Change: the platform's and xunit's failing-test lines and word-then-count summaries in `CODE_FAILURE`, with real fixtures for the base revision and a candidate (unit and end to end); `npm-missing-script` refuses output with a lifecycle banner (`without`), with the real npm fixture; MSBuild's restore-only error count is set aside on a candidate only when its base revision showed an environment failure; `environmentFix` reads the check's command and gives `dotnet format` its own measured fix; CONTRACTING blocks on a missing target before writing the contract or settling flips; the advice for a misconfigured check names only a new run (reason and resume refusal); pytest's cause names a plugin's option; the MSB1001 fixture's pid and session id neutralised. Watch: a `dotnet format` check under srt on macOS fails with "Restore operation failed" or a pipe `TimeoutException` and no denial, so it is still recorded as a pre-existing failure with a question.

### 2026-10-06: preflight classification, review round (#10, #23)
- Tested: the MSB1025 scenario reproduced on macOS from origin/main code under Orbit's runner and srt 0.0.78 (an xunit project that references two class libraries, packages restored beforehand into the toolchain cache, `dotnet test <project>` with no `-m:1`): FAILED after 301 s with ten MSB1025 crashes; the same check with `-m:1` PASSED in 11 s. A NuGet restore of a package not in the cache, under the runner and srt (CookieContainer type initializer, `GetDomainName: -1`) and through srt's real proxy from outside the profile (`The proxy tunnel request ... failed with status code '403'`, "2 Error(s)" counting NU1301 and an uncoded NuGet.targets error). Real npm, sh, bash, zsh, env, pytest, go and cargo outputs for the new attribution cases: `npm test` running a missing `npm run lint`, a chain, `dotnet run --project build/...` printing MSB1008, pytest `addopts`, `go mod x`, `cargo nextest`, a missing `./scripts/x.sh`. Python 3.12 unittest erroring with `PermissionError`. PREFLIGHT, CONTRACTING and VERIFYING end to end in the controller lab.
- Went well: argument errors still block at PREFLIGHT; a missing npm script now reaches CONTRACTING and either flips (the contract names the check; the run creates the script and succeeds) or blocks there as misconfigured; a denial a candidate brings goes to DIAGNOSING.
- Went wrong: the first attempt blocked P18 cases (a check for a target the goal creates) at PREFLIGHT with no way forward; attributed usage errors printed by repository scripts, chains and `dotnet run` to the check; let the new EACCES, socket and network signals take a candidate's own failure out of the repair loop (a unittest `PermissionError`); hid a refused restore behind MSBuild's error count; named an unverified fix (`-nodeReuse:false`, server settings); and repeated identical evidence once per check. The "N failed" pattern matched across a line break ("GetDomainName: -1" then "Failed to restore").
- Root cause: one table for two different errors; command words matched anywhere in the command instead of its direct invocation; the classifiers had no base-revision gate on a candidate; the error count did not look at what it counted; the fix text came from documentation, not a measurement; `\s+` in a count pattern.
- Change: the table split into argument errors and missing targets (P18 settles the latter at CONTRACTING), exit 127 an environment failure, `evidence/check-command.ts` for the direct invocation, `BASE_GATED_SIGNALS` on candidates, unittest's summary as a failing test, restore-only error counts ignored, the real MSB1025 fixture and the `-m:1` fix, grouped evidence and capitalised sentences in every block reason. Lesson: a fixture reconstructed from a report hid that the real crash repeats ten times and names no path; reproduce before writing the classifier.

### 2026-10-06: preflight: base-revision failure classification (#10 retest, #23)
- Tested: PREFLIGHT end to end with real failing commands: a stand-in `dotnet` on the check's PATH printing exactly what the real one printed (MSB1025 with `SocketException (13): Permission denied` for three checks; MSB1008 for `dotnet build A.csproj B.csproj`), a program not installed under a real shell (exit 127), the real npm with a missing script, and a failing TAP test whose assertion says "permission denied". Each usage-error signature against the real tools run as checks through Orbit's runner (.NET 9.0.305, npm 11, pytest 8.4, go 1.27, cargo 1.98, macOS sh). Under real srt on macOS: a Unix socket bind by the repository's own .NET program (refused, `SocketException (13)`), curl through the sandbox proxy (`CONNECT tunnel failed, response 403`, `X-Proxy-Error: blocked-by-allowlist`), node fetch (DNS refused, `ENOTFOUND`). Multi-project `dotnet build` with `-m` and with the MSBuild server, with and without `local_binding`.
- Went well: the MSB1008, npm and exit 127 cases now block in seconds with the error line and `checks.<id>.command`; the MSB1025 case blocks with both lines and a fix; the TAP failure keeps its question. A resume after installing the missing program, or after fixing the tool, reaches CONTRACTING.
- Went wrong: before the fix the #10 case went "preflight passed ... with 3 pre-existing failure(s)" with three exception questions, and all four blocking cases ran into repair attempts until EXHAUSTED. The MSB1025 crash itself could not be reproduced on macOS with srt 0.0.78: multi-project builds passed, so its fixture was reconstructed from the report with captured socket frames (the review round above reproduced it and replaced it with the real capture). A resume after fixing the environment re-read the recorded failure and blocked again.
- Root cause: PREFLIGHT knew only two kinds (could not run, from EPERM and EROFS filesystem denials and crashes; everything else pre-existing), with no EACCES, socket or proxy denials and no notion of a wrong command line. The check runner reuses a recorded result for the same tree, configuration and policy, so a resumed baseline never ran the blocked check again.
- Change: ADR 0010; `evidence/check-misconfigured.ts` (explicit table), EACCES, socket-in-tool-crash and proxy denials in `classifyCouldNotRun`, PREFLIGHT blocks on both with classified decisions, the timeline names them, `applyBaselineExceptionAnswers` refuses them, and a resumed baseline sets the classified checks' recorded results aside (fixed in this branch). Watch: the MSB1025 shape on Linux (it was reproduced in `dotnet test` on macOS in the review round above).

### 2026-10-06: v0.1.0 released; installed from the public catalog and run
- Tested: CI on GitHub's runners for the first time (the repository is public); the signed v0.1.0 tag and release; the catalog entry (git-subdir, path plugin); a marketplace install in a fresh Claude config; init, doctor and a real run in a new repository from the installed copy; /orbit:status through Claude Code with the installed copy.
- Went well: CI green on Ubuntu (Node 22 and 24) and macOS (Node 24), publish-guard green. The install brought 16 MB of node_modules (the sandbox runtime only), 8 skills, 7 agents and both hooks; bin/orbit and srt 0.0.78 ran from the cache. Doctor went to 0 failures after the two documented steps (a check, the Codex data-policy opt-in); the run SUCCEEDED in about a minute with Codex review. An earlier run in the same repository, whose test script was broken at baseline outside the allowed paths, stopped cleanly as non-progress after three identical attempts.
- Went wrong: the first public CI run failed one Ubuntu test (GitHub's runners ship gh in /usr/bin, so a "no gh" PATH was not) and the publish-guard workflow ran a pinned 0.1.0 that treated subdomains of reserved domains as real addresses. In non-interactive claude -p, the status skill's own orbit command needs approval.
- Root cause: a test PATH that assumed the host's /usr/bin; a stale workflow pin; skills without allowed-tools frontmatter.
- Change: a git-only PATH in the test; the workflow pinned to publish-guard 0.1.2. Proposed for 0.1.1: allowed-tools frontmatter so the read-only skills (status, doctor) run their own orbit command without a prompt.

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

### 2026-10-06: the issue loop and the road to v0.2.0
- Tested: nine issues filed by an agent using Orbit on its own repositories (#2 to #10), each reproduced, fixed test-first on its own branch and merged through a pull request with the five required checks; five features built and merged the same way.
- Went well: every report reproduced; the worktree-per-fixer pattern let five fixers work in parallel; a public-issue guard scans every new issue and comment against the private terms and removes a match at once (none so far).
- Went wrong: (1) the landing script merged two pull requests whose CI had failed: it read the checks 20 seconds after a push, when only the fast checks existed, and an admin merge does not wait for missing checks; main went red on Ubuntu. (2) The failures were real: GitHub's Ubuntu runners ship .NET SDK 10, whose SourceLink queries git and hits srt's protection of .gitmodules on Linux, and srt on Linux reports a denied write as EROFS, not EPERM. (3) Branches built in parallel clashed semantically after rebasing (init's --json line, doctor's review check, a skill's pre-approved commands).
- Root cause: a merge gate that treated "no failing check yet" as "passed"; a local .NET SDK older than CI's; parallel branches each green against an older main.
- Change: the gate now waits until every required check exists on the exact pushed commit and succeeded, and merges with --match-head-commit; checks set EnableSourceControlManagerQueries=false and treat EROFS as a denial; semantic conflicts were merged by hand with both branches' tests as the oracle; the remaining features were combined into one integration branch so CI ran once.

### 2026-10-06: the toolchain profiles meet GitHub's runners
- Tested: the combined v0.2.0 feature branch on ubuntu-latest (Node 22, 24) and macos-latest (Node 24), with the runners' preinstalled Go, Rust, Java and .NET.
- Went well: every product defect was caught by the required checks before merge, and each was reproduced locally (Node 24 on macOS; an Ubuntu container with rustup, a JDK and Go) before it was fixed.
- Went wrong: (1) removing a check's scratch failed after Go made it read-only, only on Node 24. (2) Java checks failed on macOS runners. (3) doctor said cargo started when it could not. (4) Tests assumed this Mac's toolchain layout (no Go; EPERM denials). (5) The acceptance suite had leaked a 50 MB demo template per worker per run: 1188 copies, 63 GB, which filled the disk mid-gate.
- Root cause: (1) Node 24 on macOS reports a read-only tree it cannot empty as ENOTEMPTY (the parent's rmdir error replaces the child's EACCES) and the repair only ran on EACCES and EPERM. (2) A check sees only PATH, and /usr/bin/java is Apple's stub, which needs JAVA_HOME to find a JDK outside /Library/Java. (3) doctor resolved links before starting a tool, so for rustup's cargo proxy it started rustup. (4) Local development used one Node version and one toolchain layout. (5) The cleanup ran on the worker's 'exit' event, which does not fire when vitest ends its workers.
- Change: the repair runs on ENOTEMPTY too and never follows symlinks; the JVM profile passes the host's absolute JAVA_HOME (not into containers); doctor starts tools by name and checks containment on the target; denials are asserted per platform; templates carry the run's id and a global teardown removes them.
