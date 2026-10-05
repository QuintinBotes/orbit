Make the not-found response friendlier.

Today a request for an unknown path gets the plain text body `not found`. It should
say `Page not found. Try /reports.` instead. Keep the 404 status and the plain text
content type, and add a unit test that checks the new text.

Follow the existing conventions. Do not change dependencies or anything outside
`src/` and `tests/`.
