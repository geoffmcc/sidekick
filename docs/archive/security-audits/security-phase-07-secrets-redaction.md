# Phase 7 — Secrets and sensitive-information handling

Baseline for this phase: `ed5324dd9dd068eab28df665a88e6f53136b3448` (Phase 6 deployed main).

## Finding F7-01 — debug persistence allowed a caller-controlled redaction bypass

Severity: High. The low-risk `debug_tool` accepted `redact=false` and persisted the supplied finding verbatim in KV storage. Debug input commonly consists of copied command output, configuration, and provider errors, so this option created an intentional secret-bearing persistence sink outside the encrypted secret store.

Fix: debug findings are always passed through `redactSensitive`; the old field remains accepted only as a deprecated compatibility field and no longer changes behavior. The schema and catalog description now state that redaction is mandatory.

Regression coverage: `test/security-phase-07-secrets-redaction.test.js` submits `redact=false` with a generic password assignment and verifies the stored value is redacted.

## Finding F7-02 — ordinary KV storage accepted sensitive-looking keys

Severity: High. `store` is a low-risk plaintext/persistent KV surface. It accepted keys such as `api_key` and `password`, and the corresponding read path could return arbitrary values that pattern-based redaction cannot identify. This contradicted the encrypted `secret` store boundary and made database readers, exports, backups, and memory/telemetry consumers potential secret sinks.

Fix: ordinary `store` rejects sensitive-looking keys using the shared normalized key classifier. `get` refuses legacy sensitive-looking keys rather than returning their values, while other legacy values remain compatible. Project retrieval redacts values for sensitive-looking legacy keys. Users must use `secret` or encrypted workspace secrets for credentials.

Regression coverage: the Phase 7 test verifies sensitive-key writes are rejected and pre-existing sensitive-looking KV keys fail closed on read.

## Secret source/sink audit

- Sources include encrypted `secret`/workspace stores, provider secret references, browser `secret_fill`, dashboard/bootstrap credentials, runtime secret files, environment compatibility, and external provider credentials.
- Dispatcher result normalization, approval previews, tool-log formatting, evolve argument normalization, memory summaries, and family handlers apply redaction. Secret tool values are explicitly withheld from tool logs and memory.
- Subprocesses use the Phase 5 filtered environment. Network providers resolve credentials from secret references and avoid returning authorization headers. Browser credentials are destination-bound and page-derived output is treated as untrusted.
- Persistent handoffs, context, debug findings, KV, artifacts, backups, audit rows, metrics, and errors are sensitive sinks. This phase closes the debug opt-out and plaintext-KV sensitive-key paths; existing pattern/key redaction remains defense in depth.

## Residual risk

An operator or privileged caller can still intentionally place arbitrary non-sensitive-looking content into generic stores, and legacy databases may contain values written before this change under neutral keys. Pattern redaction cannot prove that a random value is a secret. The exact next improvement would be a typed sensitive-data policy for all arbitrary string stores and a migration scanner for existing KV/artifact data. Redis's administrator-oriented raw surface remains intentionally powerful and must stay high-trust/policy-gated.
