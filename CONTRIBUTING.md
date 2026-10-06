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

The repository root is the development workspace; the plugin is `plugin/`
(docs/decisions/0006-plugin-packaging.md). `plugin/dist/orbit.mjs` is committed
and is what the plugin and the `orbit` binary run. After changing anything
under `src/` or `templates/config.yaml`, rebuild and commit it:

```bash
npm run build
npm run check:dist          # fails if the committed bundle is stale (CI runs this)
```

## Plugin validation

```bash
npm run validate:plugin     # node scripts/check-plugin.mjs
node scripts/check-plugin.mjs   # claude plugin validate --strict plugin/, a lint for frontmatter keys
                                # Claude Code ignores, and the payload check: only the allowed files, and a
                                # package whose one dependency is @anthropic-ai/sandbox-runtime at the verified version
```

Both need the `claude` CLI on PATH. Plugin agents silently ignore
`permissionMode`, `hooks` and `mcpServers`, so the lint treats them as errors.

## Before you open a pull request

```bash
npm run verify
```

Every change, including a bug fix, comes with a test that fails before the
change and passes after it; never loosen or delete an assertion to make a test
pass. Design decisions get a short record under `docs/decisions/`.

## Pull requests

`main` is protected. Changes land through a pull request that:

- passes the required checks: CI on Ubuntu (Node 22 and 24) and macOS (Node 24),
  and the publish guard;
- keeps a linear history (pull requests are squash-merged or rebased);
- has every review conversation resolved.

Commits on `main` are signed; GitHub signs the squash merge, so your own
commits do not need to be. Fork the repository, work on a branch, and open the
pull request against `main`; the template lists what to check. Dependabot
opens weekly update pull requests; a bump of the sandbox runtime in
`plugin/package.json` also needs the browser checks re-verified
(docs/decisions/0001).

## Releasing

A release is a tag. Pushing a tag named `v*` runs
`.github/workflows/release.yml`; nobody builds or uploads anything by hand.

1. Bump the version to the new one in all three places, in a pull request:
   `package.json`, `plugin/package.json` and `plugin/.claude-plugin/plugin.json`
   (and the matching `version` lines in the two lockfiles).
2. In `CHANGELOG.md`, rename `## Unreleased` to `## X.Y.Z (YYYY-MM-DD)` and
   start a fresh `## Unreleased` above it. That section is the text of the
   release notes, so write it for readers of the release page.
3. Rebuild the bundle (`npm run build`) if anything under `src/` changed, and merge.
4. Tag the merge commit on `main` and push the tag:

   ```bash
   git tag -s vX.Y.Z -m "Orbit X.Y.Z"
   git push origin vX.Y.Z
   ```

   `vX.Y.Z-rc.1` style tags make a GitHub prerelease and never touch the catalog.

The workflow then, in order, and stops at the first failure with nothing
published:

1. checks the tag against the three versions, checks that `CHANGELOG.md` has a
   section for it, and checks that the tagged commit is on `main`
   (`scripts/check-release-versions.mjs`, `scripts/release-notes.mjs`);
2. runs the full gate on Ubuntu with Node 24 and the prerequisites of `ci.yml`:
   typecheck, unit, integration, fault-injection and acceptance tests,
   `npm run check:dist` and `node scripts/check-plugin.mjs`;
3. builds `orbit-plugin-X.Y.Z.tar.gz` from the committed `plugin/` tree, with a
   `SHA256SUMS` file, and creates a GitHub artifact attestation (build
   provenance) for the archive;
4. creates the GitHub release with the archive, the checksums and the
   `CHANGELOG.md` section as its notes;
5. opens a pull request on `QuintinBotes/claude-plugins` that sets the `ref` of
   the `orbit` entry in `.claude-plugin/marketplace.json` to the tag
   (`scripts/bump-catalog-ref.mjs` changes that one line).

Step 5 needs the repository secret `CATALOG_PR_TOKEN`: a fine-grained personal
access token with access to `QuintinBotes/claude-plugins` and the permissions
Contents (read and write) and Pull requests (read and write). Set it once with
`gh secret set CATALOG_PR_TOKEN --repo QuintinBotes/orbit`. Without it the
release still completes; the job prints a notice and a step summary saying the
catalog was not updated, and you set the ref by hand or re-run the job after
adding the secret.

If the gate fails, fix the problem on `main`, delete the tag (`git push --delete
origin vX.Y.Z` and `git tag -d vX.Y.Z`) and tag again. Every action in the
workflow is pinned by commit SHA with a version comment; Dependabot proposes
the bumps. To check a downloaded archive:
`gh attestation verify orbit-plugin-X.Y.Z.tar.gz --repo QuintinBotes/orbit`.

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
