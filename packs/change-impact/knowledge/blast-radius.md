# Change Impact and Blast Radius

`change_impact` combines the Developer pack's mechanically-derived change summary with its semantic repository index. It reports changed files, classifications, symbols, callers, callees, and dependency leads while preserving the repository's untrusted-data boundary.

The result is not a runtime dependency graph. Deployment topology, feature flags, generated code, external consumers, and data migrations need independent evidence. Use the tool in read-only review and keep its limitations with any decision.
