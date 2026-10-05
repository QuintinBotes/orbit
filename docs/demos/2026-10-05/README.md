# Live demo runs, 2026-10-05

Repository: QuintinBotes/orbit-demo (private). Providers: Claude writes, Codex reviews. Reports are the controllers' own final.md, unedited apart from secret redaction.

| Goal | Run | Outcome | Pull request |
|---|---|---|---|
| simple | orb-20261005-165615-1fa8f5 | SUCCEEDED | #1 (draft) |
| difficult | orb-20261005-184949-0cb748 | SUCCEEDED | #2 (draft) |
| ui | orb-20261005-185519-bfa362 | BLOCKED: the planner's response exceeded its output token cap (since raised, with a retry at a doubled cap; not re-run live) | none |

The demo repository has no CI workflow, so the two delivered runs report CI as unverified. The table is kept by hand: `scripts/demo/run-live-demo.sh` rewrites this file with only the goals it was asked to run.
