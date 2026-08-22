# Phase 8 — HTTP, network, and SSRF security

Baseline for this phase: `eb9b483c5ea0756f60ec9d990c2fb434992e7986` (Phase 7 deployed main).

## Finding F8-01 — GitHub connector requests were not DNS-pinned

Severity: High. GitHub API calls and GitHub connector health probes constructed raw `https.request` options from the configured connector hostname. Registration rejected embedded credentials but did not pin DNS, so a configured hostname that changed from a public address to an internal address could redirect the Sidekick process's credential-bearing request to a private service. The request paths also did not enforce HTTPS for custom GitHub connector endpoints.

Fix: both GitHub request paths and the connector health probe now use `resolveOutboundUrl` immediately before connecting, pin the resolved address, retain the original hostname for TLS SNI and certificate verification, preserve the configured port, and reject metadata/link-local results. Private addresses remain allowed for deliberately configured GitHub Enterprise deployments, while GitHub endpoints must use HTTPS.

Regression coverage: `test/security-phase-08-http-network.test.js` verifies the implementation uses DNS-pinned resolution and TLS hostname binding, and confirms provider endpoint policy continues to reject metadata/link-local destinations while allowing intentional local inference providers. Existing outbound URL and provider security suites cover DNS rebinding, metadata, Host preservation, and private-provider functionality.

## Network surface audit

- `web_fetch` and notification webhooks use `resolveOutboundUrl`; private/loopback access requires explicit configuration, metadata and link-local destinations remain forbidden, caller-controlled credential/Host headers are constrained, redirects are not followed, and response/time limits are bounded.
- Compute/provider HTTP uses endpoint validation plus per-request DNS resolution and address pinning. Private inference endpoints are intentional; metadata/link-local targets are denied.
- GitHub API and connector health now use the same pinned boundary. GitHub connector registration requires HTTPS; credentials are loaded from the protected secret store.
- Browser navigation uses its isolated per-session egress policy and does not inherit direct HTTP caller trust. Provider, Proxmox, firewall, and connector endpoints are administrator-selected rather than arbitrary browser destinations.
- Influx metrics uses an explicit host allowlist. Security Research has no guessed network transport and refuses requests without a verified adapter.
- Direct callers do not follow redirects. Any future redirect support must validate and pin each hop independently.

## Residual risk

Private-network access is intentionally available for homelab and GitHub Enterprise/provider operations when explicitly configured. This is an accepted architecture risk controlled by connector/provider authorization, metadata/link-local denial, DNS pinning, TLS verification, and dispatcher policy. A compromised administrator-selected private endpoint can still receive credentials by design; endpoint custody and secret scope remain operational responsibilities.
