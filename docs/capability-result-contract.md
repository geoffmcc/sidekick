# Capability Result Contract

Capability-pack handlers may return legacy MCP `content` and `isError` fields,
but the canonical dispatcher normalizes structured JSON into one result
contract. The machine-readable `status` and `result_status` values are:

`succeeded`, `partial`, `failed`, `unavailable`, `denied`,
`approval_required`, and `cancelled`.

Every normalized result also carries `ok`, `code`, `retry_safe`,
`evidence_refs`, `warnings`, `limitations`, `dependency_results`,
`approval_state`, `partial_completion`, and `recovery` fields. Empty arrays or
null values are used when a field has no evidence; protected evidence and
credentials are never copied into the envelope.

`ok` describes execution, not the domain conclusion. A completed assertion
that finds a negative or indeterminate condition remains `status: succeeded`
and may expose `finding_ok: false`. A dependency, policy, authorization, or
provider failure must use its specific status and stable error code.

The transport adapter preserves `content` and legacy `isError` behavior. The
workflow runner consumes the normalized status rather than parsing human text,
so approval, cancellation, partial progress, cleanup, and failure decisions
remain durable and attributable.

This contract proves result classification and propagation only. It does not
prove provider correctness, production readiness, external integration health,
or the truth of a domain finding.
