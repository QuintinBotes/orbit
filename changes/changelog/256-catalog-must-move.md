section: Fixes
- The release workflow's catalog job fails when the `CATALOG_PR_TOKEN` secret is not set, instead of passing with a notice. v0.4.0 and v0.4.1 were released that way and the plugin catalog kept offering 0.3.1, so no release since 16 Oct reached an install (#256).
