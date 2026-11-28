section: Fixes
- CONTRIBUTING's release step 3 now says to build again after the lab bench (#329). The build copies `docs/` into `plugin/docs`, so a scorecard written after the only build left `npm run check:dist` failing on its stale plugin copy.
