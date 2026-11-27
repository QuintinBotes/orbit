section: Fixes

- A criterion mapped to a test that is not a file in the candidate is no longer offered to a person to accept without fail-before evidence, and is never reported supported, under `verification.fail_before: required`, `advisory` or `off`. The report leaves it unverified and names each missing file, with the cause `missing`.
