section: Fixes
- **A curator that cannot be launched no longer holds a run's slot (#296).** When the curator's task could not be built (for example, no role prompt), its worker record stayed planned, counted as live, and with parallelism 1 deferred the next implementation attempt for good. The record is now settled FAILED.
