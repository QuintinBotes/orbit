section: Fixes
- The plugin payload test no longer fails a pull request into `next` that edits a documentation file. It checks that `plugin/` has every documentation path and that a fresh build of the payload (`ORBIT_BUILD_DOCS_DIR` on `scripts/build.mjs`) equals the repository files; the committed copies are compared by `check:dist` on `main` and in `release.yml`.
