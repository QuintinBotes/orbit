# Demo notes for maintainers

This file is for people maintaining the demo. It is left out of the repositories the
demo scripts create, so workers never see it. Do not describe the seeded defects in
`README.md`, in the goals, or in code comments.

## What the demo shows

Spec section 2 asks for three unattended runs. Each goal in `goals/` is one of them.

| Goal | Shows | Expected route and path |
|---|---|---|
| `simple.md` | a small change on a low-cost route | difficulty `simple`, a Haiku or Sonnet implementer, one attempt, one Codex review, draft PR |
| `difficult.md` | evidence-backed escalation and repair | difficulty `medium` with high coupling, escalated to Opus on observed difficulty; the first candidate fails its own new tests, a diagnosis names the cause, the second attempt repairs it |
| `ui.md` | browser checks that fail, a repair, independent review, a draft PR | the first candidate passes unit tests but fails the export journey on desktop and mobile; the repair passes; Codex approves; a draft PR opens |

## The seeded defects (difficult goal)

Two defects sit in `src/reports/query.ts`, in one function, so one can hide the other.
Nothing else in the app is broken on purpose.

1. **Total amount sums the page, not the matches.** `queryReports` returns
   `totalAmountCents: sumAmounts(rows)`. `rows` is the current page, so the total changes
   as the visitor pages. The count above it (`total`) is computed from the full filtered
   list and is right, which makes the problem look like a rendering issue. The fix is
   `sumAmounts(filtered)`.
2. **The last partial page is unreachable.** `pageCountFor` uses `Math.floor`, so 47
   records give 4 pages and records 41 to 47 can never be shown. It is invisible whenever
   the record count is a multiple of the page size, which is why every existing test uses
   10, 20 or 30 records and passes. The fix is `Math.ceil`.

`goals/difficult.md` states both as user reports and does not point at a file. The
existing journey `reports-pagination` asserts `Page 1 of \d+`, not a number, so it does
not encode the defect.

## Things the demo depends on

- **Visual baselines cover the table only** (`tests/e2e/visual.spec.ts`), so the export
  link the UI goal adds does not change a baseline. A candidate that edits baselines is
  blocked for review by policy; a UI goal must be doable without touching them.
- **Baselines are per platform.** The ones committed here are for the platform they were
  recorded on (`darwin`). `scripts/demo/run-mock-demo.sh` and `run-live-demo.sh` record
  them for the current platform when that folder is missing, as the person's decision,
  before any run starts.
- **The `ui` check is not mandatory.** Playwright checks run through Orbit's UI runner only
  when a criterion or a changed path needs browser evidence (`ui.ui_paths`). The simple goal
  touches neither, so it must not require `ui`. Goals that do need it list `ui` in their
  contract.
- **`ui.ui_paths` is `src/views/**` and `src/public/**`.** The simple goal changes
  `src/server.ts` only, on purpose.
- **The export filename needs the visitor's clock.** The server cannot know the local date,
  so the page script names the download. A `Content-Disposition` filename from the server
  would override it in Chromium.
- **The data is fixed** (`src/reports/data.ts`, 47 records). Two titles contain a comma and
  a quote on purpose, for the CSV escaping journey.

## Running the demos

- `scripts/demo/run-mock-demo.sh`: offline, fake providers, FakeGitHub. The scripted
  workers are in `scripts/demo/mock/scenarios.ts` and apply edits to this app's files, so a
  change here that they no longer fit makes the mock demo fail loudly. Fix the scenario, or
  the app, rather than loosening the expectations.
- `scripts/demo/run-live-demo.sh --repo OWNER/NAME`: live providers, a private GitHub
  repository, billed. Reports land in `docs/demos/<date>/`.

## Resetting a live demo repository

Delete the repository and run the script again, or close the draft PRs and delete the
`orbit/*` branches. `main` is never changed by a run.
