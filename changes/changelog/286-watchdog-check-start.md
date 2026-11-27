section: Fixes

- **A running check that has printed nothing yet is no longer read as a stalled run (#286).** The watchdog took a check's activity only from its output file, so on a loaded machine, where a check's first line can take seconds, a run in its baseline was reported stalled or even abandoned while the check was starting. A check with no output yet now counts from its start, as a fail-before probe already did; one that stays silent past the stall limit is still a stall.
