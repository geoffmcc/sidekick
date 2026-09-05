# Test Manifests

Each manifest owns a domain, tier, resource budget, timeout, and file patterns.
The runner expands these small domain manifests recursively; there is no
central suite registry. A file may match one manifest only. Legacy root-level
tests remain executable through the compatibility manifest while they are
migrated to `node:test` and domain directories.

`live: true` suites are excluded from normal discovery unless
`SIDEKICK_TEST_LIVE=1` is set. Missing optional dependencies must be reported as
explicit skips, never silently counted as passes.

Every resource must have an explicit `resource_scopes` entry of `isolated` or
`shared`. Isolated resources are namespaced by suite; shared resources use one
real lock across suites. Declare `shared` only for a genuinely global provider,
such as the platform subprocess fixture. The runner never inspects suite source
text to infer fixture ownership. Suite-specific isolation is declared in
`test/suite-resources.json`; entries are reviewed metadata, not runtime source
inspection.
