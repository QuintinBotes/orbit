# Demo app

A small reports app, built so Orbit has something real to work on. It is a plain
`node:http` server that renders a reports page: a list of records with a status
filter, a text search and a pager. There is no framework and no build step. Node
runs the TypeScript sources directly.

## Run it

Needs Node 22.18 or newer.

```sh
npm ci
npm start                 # http://127.0.0.1:4310/reports (PORT overrides the port)
```

## Checks

| Command | What it is |
|---|---|
| `npm run lint` | `tsc --noEmit`: the type check that stands in for a linter |
| `npm test` | unit tests with `node --test`, no dependencies beyond Node |
| `npm run test:ui` | Playwright journeys on a desktop and a mobile viewport, with an accessibility scan and a visual baseline of the reports table |

The UI checks need Playwright's browser once: `npx playwright install chromium`.
`npm run test:ui` starts the app itself.

### Visual baselines

`tests/e2e/__screenshots__/` holds the committed baselines, one folder per project
and platform (`desktop/darwin/...`). Renderings differ between operating systems, so
on a platform without a folder, record the baselines once, review the images and
commit them:

```sh
npm run ui:baselines
```

Orbit runs the journeys with `--update-snapshots=none` and never records a baseline.

## Layout

```
src/server.ts            routes (pure `handle`, plus the http server around it)
src/reports/             records, filtering, pagination, formatting
src/views/               HTML for the reports page
src/public/              static files
tests/unit/              node:test unit tests
tests/e2e/               Playwright journeys (orbit-fixtures.ts is Orbit's template)
.orbit/config.yaml       Orbit policy: autonomous-delivery, checks lint, unit and ui
goals/                   three goals to hand to Orbit
```

## Using it with Orbit

`.orbit/config.yaml` lets workers change `src/**` and `tests/**` only, protects
`.github/**`, the package files and the policy itself, uses Claude to write and
Codex to review, and delivers draft pull requests through GitHub.

```sh
orbit doctor
orbit run --goal - --foreground < goals/simple.md
```

The three goals:

| File | What it asks for |
|---|---|
| `goals/simple.md` | a small text change |
| `goals/difficult.md` | a fix for wrong numbers on the reports page that needs diagnosis |
| `goals/ui.md` | CSV export of the filtered reports, checked in a browser |

The Orbit repository has scripts that run all three: `scripts/demo/run-mock-demo.sh`
offline with fake providers, and `scripts/demo/run-live-demo.sh` against a private
GitHub repository with the real ones.
