Implement CSV export for the reports page.

Add an "Export CSV" link to the reports page that downloads the reports matching the
current filters.

- Export every record matching the current filters, not just the current page.
- Preserve the visible column order and use the visible column names as the header
  row. Write amounts as plain decimals, for example `1234.50`.
- Escape values correctly: wrap a value in double quotes when it contains a comma,
  a double quote or a line break, and double any double quote inside it.
- Name the file `reports-YYYY-MM-DD.csv` using the user's local date, the date on the
  user's own clock and time zone, not the server's or UTC.
- Cover the empty result: a filter that matches nothing downloads a file with just the
  header row.

Cover the behaviour with unit tests and a browser journey that applies a filter,
downloads the file and checks its name and contents on desktop and mobile. Keep the
filtering rules and the existing page layout and screenshots as they are.

Follow the existing conventions. Do not change dependencies or anything outside
`src/` and `tests/`.
