## What and why

<!-- What this changes and the problem it solves. Link the issue: "Fixes #123". -->

## How it was tested

<!-- The test that failed before the change and passes after it, and anything run by hand. -->

## Checklist

- [ ] A test that failed before this change passes now (no assertion was loosened or removed)
- [ ] `npm run verify` passes locally
- [ ] `plugin/dist/` is rebuilt (`npm run build`) if anything under `src/` changed
- [ ] Docs, `CHANGELOG.md` and, for a design decision, an ADR under `docs/decisions/` are updated
- [ ] No credentials, private code or personal data in the diff, the commits or this description
