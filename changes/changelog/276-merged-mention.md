section: Fixes
- A goal that says "merged PR #55", "the merged commit", "#200 was merged" or "already merged" no longer reads as a request to merge. The authority check turned such a mention into a needs-decision that blocked every criterion before planning. Requests such as "get this merged", "make sure the PR is merged" or "ensure all PRs are merged" still count (#276).
