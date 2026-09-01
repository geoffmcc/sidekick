# Operational Readiness: evidence and acceptance guide

`readiness-check` combines a repository profile, current health, formal handoff,
and caller-supplied research-evidence references. Evidence references must
exist in custody, be attributable, and meet the configured `minimum_evidence`.
Use fresh, independent checks for services, dependencies, migrations, rollback,
and relevant endpoints; a single aggregate health score is insufficient.

The result is a decision aid, not an automatic release or deployment approval.
Explicitly record acceptance criteria and unresolved unknowns. A missing,
expired, redacted-inadequately, or inaccessible evidence reference must fail
closed. The pack performs no deployment, service restart, migration, or commit.
