# Test Manifests

Each manifest owns a domain, tier, resource budget, timeout, and file patterns.
The runner expands these small domain manifests recursively; there is no
central suite registry. A file may match one manifest only. Legacy root-level
tests remain executable through the compatibility manifest while they are
migrated to `node:test` and domain directories.

`live: true` suites are excluded from normal discovery unless
`SIDEKICK_TEST_LIVE=1` is set. Missing optional dependencies must be reported as
explicit skips, never silently counted as passes.

Resources are fixture-scoped by default when a suite creates a temporary root.
Use `shared_resources` only for a resource whose provider is genuinely global,
such as the platform subprocess fixture; the runner uses that declaration to
serialize only the affected suites.
