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
