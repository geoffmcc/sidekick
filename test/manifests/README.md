# Test Manifests

Each manifest owns a domain, tier, resource budget, timeout, and file patterns.
The runner expands these small domain manifests recursively; there is no
central suite registry. A file may match one manifest only. Legacy root-level
tests remain executable through the compatibility manifest while they are
migrated to `node:test` and domain directories.

`live: true` suites are excluded from normal discovery unless
`SIDEKICK_TEST_LIVE=1` is set. Missing optional dependencies must be reported as
explicit skips, never silently counted as passes.

Every manifest resource must have an explicit `resource_contracts` entry. A
contract declares `kind` (`isolated`, `shared`, or `exclusive`), a registered
`provisioner`, `fixture`, registered `cleanup`, `cleanup_owner`, `lock_identity`,
and `supported_platforms`. Isolated resources receive per-suite instances;
shared resources retain one scheduling lock even when a built-in provisioner
creates a scoped fixture; exclusive resources serialize the complete runner
resource set. The versioned `test/suite-resources.json` document contains the
registered resource catalog and the default suite contract. Unknown or
meaningless provisioner/cleanup labels are rejected. The runner validates and
executes these contracts, checks owned resources after cleanup, and never
inspects suite source text to infer fixture ownership. This is scoped process
isolation, not a claim of hermetic test execution.
