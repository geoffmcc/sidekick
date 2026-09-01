# CI/CD and Release Engineering: workflow guide

Use `ci-readiness` to inspect repository verification signals and available CI
status evidence. Use `release-gate` to combine repository state, changelog and
verification evidence for a release decision. The configured verification mode
controls breadth when `dev_verify` is available; missing optional tools remain
an explicit limitation. A CI status lookup describes the selected commit or
ref, not a locally reproduced build.

Treat readiness as evidence, not authorization. A green check or clean diff
does not prove deployment safety, migrations, rollback readiness, or runtime
health. These workflows do not publish, push, merge, create releases, or change
the target environment. Run the relevant verification and inspect its detailed
command results before accepting a gate.
