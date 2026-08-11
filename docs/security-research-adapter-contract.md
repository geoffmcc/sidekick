# Security Research Adapter Contract

Status: Phase 6 boundary only (2026-08-11).

The repository contains no verified `security-research` API implementation and
no operational Security Research Workbench. Phase 6 therefore provides a
typed, fail-closed adapter boundary rather than inventing endpoints or making
arbitrary network requests.

`src/connectors/security-research.js` accepts an injected transport, an
optional HTTPS endpoint, an opaque `secret:*` reference, and declared
capabilities. Without an injected transport the adapter reports
`unavailable`; requests fail before any network operation. With a transport,
operations remain bounded names and the transport is responsible for the
verified external API contract.

Operations are capability-gated (`findings.read`, `reports.read/write`, and
`evidence.read/write`) before reaching the injected transport. The Evidence
Vault boundary in `src/security-research/evidence-vault.js` accepts only opaque
`artifact:<id>` references and returns custody metadata from a resolver; it
never accepts or returns evidence bytes.

This boundary does not create security-research domain tables, claim findings,
assert execution truth, or implement a Workbench adapter. Those belong to the
Phase 7 capability pack after a real API contract is verified.
