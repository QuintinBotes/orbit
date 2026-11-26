section: Fixes
- `orbit doctor` in a repository with no `.orbit/config.yaml` no longer fails delivery on a missing `GH_TOKEN`. It judged Orbit's built-in default policy, which delivers, though no run can start without a config and the one `orbit init` writes does not deliver. The config check alone fails, with its fix (#259).
