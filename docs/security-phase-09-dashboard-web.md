# Security Phase 9 — Dashboard and Web Security

Baseline: `53bace834189f83e4772f94bfb735c6e5dfa4dd5`

## Finding F9-01 — forwarded-protocol spoofing and inconsistent browser headers

Severity: Medium

The dashboard previously treated `X-Forwarded-Proto` as authoritative even
though Express proxy trust was not enabled. A client could therefore influence
whether a compatibility session cookie received `Secure` and which scheme was
used by the Origin comparison. The dashboard also did not establish a single
set of browser security headers for its own UI responses.

The dashboard now opts into forwarded-header trust only when
`SIDEKICK_DASHBOARD_TRUST_PROXY=true` is explicitly configured. Otherwise
`req.secure` and `req.protocol` are derived from the direct connection. The
dashboard also emits CSP, clickjacking, MIME-sniffing, referrer, permissions,
cross-origin, and HTTPS transport headers as applicable. Grafana remains a
separate application behind the existing local auth proxy and is excluded from
the Sidekick UI CSP.

Regression coverage: `test/security-phase-09-dashboard-web.test.js`.

Residual risk: the dashboard intentionally retains inline event handlers and
inline styles, so its CSP uses `unsafe-inline` for compatibility. A future UI
refactor can remove those allowances and deploy a nonce/hash-based policy.
