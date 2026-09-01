# Campaign Packs 6-10

This slice adds five independently installable capability packs:

- `database-administration`: read-only schema, statistics, migration status and parameterized query inspection.
- `ci-cd-release-engineering`: repository CI facts, dry-run verification selection and release-note previews.
- `testing-quality-engineering`: bounded project quality gates and semantic-index verification.
- `api-engineering`: deterministic API checks that require an operator-created named network scope.
- `infrastructure-as-code`: provider-authoritative Compose preflight and parsed, plan-only configuration review.

All module adapters delegate through `services.dispatch`, so policy, approval, timeout, redaction and audit remain owned by the existing tools. The new packs do not add permissions or expose release publication, Git push, API writes, infrastructure apply, lifecycle or destroy operations. Composed dependencies are optional at installation time and are reported by pack health and runtime probes when the corresponding provider pack is enabled.

## Minimums

- Database queries are single-statement, parameterized `SELECT`/`WITH` reads; write verbs, multiple statements, empty responses and dependency errors fail closed.
- CI, quality, API and IaC results preserve delegated failures and return deterministic bounds; IaC remains plan-only and API workflows are read-only.
- API targets require an exact named network scope and assertions are bounded and structurally validated.
- Every positive result identifies the checks or evidence sources that support it; a delegated error is never reported as success.
