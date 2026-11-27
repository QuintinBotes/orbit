section: Fixes

- **An environment guard in a new test file is no longer read as test weakening (#285).** A `describe.skipIf(...)`, `it.runIf(...)`, `@pytest.mark.skipif` or `@unittest.skipIf`/`skipUnless` added in a test file the candidate creates, whose guarded tests ran on both trees in the fail-before probe, switched nothing off; it no longer marks the candidate INCOMPLETE or sends the run to "strengthen" its tests. An unconditional skip, any skip added to a file that existed, and a guard whose tests did not run still need review as before.
