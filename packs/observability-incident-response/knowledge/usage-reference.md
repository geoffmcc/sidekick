# Observability and Incident Response: capture and review guide

Use `incident-snapshot` when evidence must be retained, selecting a Black Box
profile such as `quick`, `standard`, or `deep`; use `health-review` to keep
platform status and health observations distinct. A capture request can succeed
while an individual source fails, so inspect capture status, source results,
redaction state, retention, and the incident timeline before drawing conclusions.

Metrics queries and writes are separate operations and remain bounded by the
configured provider. Empty metrics, missing sources, stale captures, and
provider errors are unknown or failed, never normal. Evidence is attributable
and redacted through Black Box custody; do not copy secrets or raw credentials
into incident notes or reports.

For health reviews, read `collection_state` to distinguish complete, partial,
and unavailable evidence. For incident and capture operations, `ok` and `state`
describe whether evidence was retrieved; they do not classify the incident as
healthy. Inspect the returned evidence and findings before summarizing.
