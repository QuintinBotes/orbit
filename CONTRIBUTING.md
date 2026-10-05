# Contributing

## Setup

Node 22.16 or newer and git are required. Node runs the TypeScript sources
directly through type stripping, so there is no build step for development:

```bash
git clone https://github.com/QuintinBotes/orbit.git
cd orbit
npm ci
node src/cli/main.ts --help
```

Conventions: strict ESM TypeScript with `.ts` import extensions, vitest for
tests, and no runtime dependencies in the shipped bundle.

## Tests

```bash
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:fault          # fault injection: crashes at every durable step
npm run test:acceptance     # end to end with the fake providers
npm test                    # everything
```

Tests use the fakes in `tests/fakes` (`fake-claude.mjs`, `fake-codex.mjs`,
`fake-anthropic-api.mjs`; the scenario format is in `tests/fakes/README.md`)
and `FakeGitHub`. Test the real exports; do not reimplement runtime logic in a
test. If a test needs live providers, say so and keep it out of the default
suite.

## The bundle check

`dist/orbit.mjs` is committed and is what the plugin and the `orbit` binary
run. After changing anything under `src/`, rebuild and commit it:

```bash
npm run build
npm run check:dist          # fails if the committed bundle is stale (CI runs this)
```

## Plugin validation

```bash
npm run validate:plugin     # claude plugin validate . --strict
node scripts/check-plugin.mjs   # the same, plus a lint for frontmatter keys Claude Code ignores
```

Both need the `claude` CLI on PATH. Plugin agents silently ignore
`permissionMode`, `hooks` and `mcpServers`, so the lint treats them as errors.

## Before you open a pull request

```bash
npm run verify
```

## No private information

Nothing in this repository may contain an employer or client name, a real
customer identifier, or a credential. Examples use "acme". The `Publish guard`
workflow (`.github/workflows/publish-guard.yml`) scans pushes, pull requests,
issues and comments against a private terms list held in a repository secret,
and fails when a term or a disallowed email address appears. Orbit's own
publication guard (`src/guard`) applies the same list at runtime. To run it
locally, keep your terms in `~/.config/publish-guard/terms.txt` and never
commit that file or its contents.

Write plain prose and avoid em and en dashes in documentation and messages.

## Security issues

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).
