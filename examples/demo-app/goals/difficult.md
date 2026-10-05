Fix the reports totals when there is more than one page.

Two reports from people using the reports page:

1. "The total amount at the bottom changes every time I click Next. It should be
   the total of everything my filters match, not of the ten rows on screen."
2. "With the filter on All statuses there are 47 reports, but the last few never
   show up however far I page."

Fix both so that the total amount covers every record matching the current filters
and every matching record can be reached by paging. Do not change the filtering
rules, the page size, or the wording of the page. Add tests that would have caught
each problem, including a case where the number of matching records is not a
multiple of the page size, and add a browser journey for the totals across pages.

Follow the existing conventions. Do not change dependencies or anything outside
`src/` and `tests/`.
