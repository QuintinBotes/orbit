# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub security advisories on this
repository: open the Security tab and choose "Report a vulnerability". Do not
open a public issue or pull request for a vulnerability.

Include the Orbit version (`orbit --version`), your platform, the isolation
provider and worker tier shown by `orbit doctor`, and the smallest steps that
reproduce the problem. Do not include real credentials, customer code or
private repository content. Redact logs first.

You can expect an acknowledgement within 7 days. Fixes are released as patch
versions and noted in the changelog.

## Scope

In scope: a worker escaping its filesystem or network confinement, a worker
changing protected paths or the policy without the controller noticing,
credentials reaching a worker or a log, success reported without fresh
evidence, duplicate external actions after a crash, and the learning layer
granting authority or leaking private content.

Known limits that are documented rather than vulnerabilities are listed in
[docs/security.md](docs/security.md#what-is-not-enforced).

## Supported versions

Only the latest released version receives fixes.
