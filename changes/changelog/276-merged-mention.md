section: Fixes
- A goal that mentions something already merged ("merged PR #55", "#200 was merged", "the merged commit") no longer reads as a request to merge. The authority check turned such a mention into a needs-decision that blocked every criterion before planning; a request such as "get this merged" still counts (#276).
