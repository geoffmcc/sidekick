# Software Supply Chain: audit inputs and interpretation

`supply-chain-audit` parses bounded manifests and lockfiles, optionally hashes
files, inspects Git state, and uses semantic repository evidence. The configured
`max_manifest_chars` prevents unbounded input. Treat digests as integrity
evidence for the exact bytes observed; they do not prove provenance, safety,
license compliance, or that a dependency is intentional.

The pack is read-only. It does not install packages, resolve registries, run
package scripts, fetch dependencies, or modify Git. Distinguish missing lock
data, uncommitted changes, unverifiable provenance, vulnerable dependency
claims, and parser limitations. A clean manifest audit is not a release or
deployment approval.
