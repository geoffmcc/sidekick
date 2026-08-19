# Phase 3 — Authentication, Identity, and Authorization

Status: complete phase gate

Reviewed baseline: `f27d676725c6c129334065680a62df766bc29898`

Branch: `security-phase-03-auth-authorization-20260819`

## Identity model

Sidekick uses server-side principals and permission-based authorization. Human,
agent, worker, provider, and service identities are distinct. Roles expand to
permissions from the database catalog; callers do not select roles or
permissions by presenting arbitrary metadata.

Authentication mechanisms are intentionally separate from authorization:

- MCP/API routes accept scoped credentials whose verifier is stored rather
  than the raw token, plus a transitional installation-wide API key;
- dashboard identity sessions use opaque server-side session tokens, with
  Basic Auth and the legacy dashboard cookie retained only for compatibility;
- Compute worker routes authenticate an enrolled worker credential;
- enrollment-token creation, job administration, and health administration use
  the explicit administrator credential path;
- Agent Bridge and internal execution receive server-created execution context,
  not caller-selected trusted source identity.

## Route matrix

| Surface | Authentication | Authorization/scope |
| --- | --- | --- |
| `/mcp`, `/messages`, `/sse` | scoped credential or transitional API key | dispatcher authorization, source policy, risk, approval |
| `/compute/jobs*` administration | administrator credential | admin route guard plus job contract and project checks |
| `/compute/*` worker lifecycle | worker enrollment credential | worker identity and job lease/state binding |
| `/compute/enroll` and enrollment exchange | enrollment token / worker protocol | enrollment rate limit, token lifecycle, worker state |
| dashboard API | identity session, legacy Basic Auth compatibility, or bootstrap path | route guard plus permission checks for identity and mutations |
| dashboard bootstrap/login/status/logout | deliberately public bootstrap/auth lifecycle | bootstrap singleton and credential verification; no privileged data |
| Agent Bridge | service boundary and execution context | agent policy, dispatcher authorization, approvals, task scope |

## Controls verified

- Missing, malformed, expired, revoked, and disabled credentials fail closed.
- Credential records persist a verifier/hash and token prefix, not the raw
  credential. Session records persist a hash and sessions can be invalidated by
  token or principal.
- Disabling a principal invalidates its sessions and credentials.
- Credential scopes can only narrow the principal's role permissions.
- Delegations require an enabled delegator and delegate, permissions held by the
  delegator, expiry/revocation checks, and cannot expand beyond current
  delegator authority.
- Unknown permissions are denied rather than treated as an allow.
- Dashboard bootstrap is singleton-protected; before bootstrap, only explicit
  bootstrap/auth endpoints and static assets are reachable and other routes
  return `bootstrap-required`.
- Dashboard sensitive identity routes use `principals.read`,
  `principals.manage`, `roles.manage`, or the specific account guard rather
  than relying on authentication alone.
- Owner promotion/demotion and final-owner protection require an attributable
  authorized actor, with the documented legacy-adoption exception.
- Session cookies are HttpOnly and SameSite=Lax; dashboard state-changing
  requests also have the Phase 9 Origin/Fetch Metadata defense-in-depth gate.
- MCP session identifiers select a transport session only after the request has
  passed the API authentication middleware; unknown/stale sessions do not
  become authenticated sessions.
- Dashboard local-password login and legacy Basic Auth now use a bounded
  process-local failure limiter keyed by client address and normalized account,
  returning `429` with `Retry-After` after repeated failures and clearing the
  failure window after successful authentication.

## Adversarial evidence

The identity authentication and authorization suites cover anonymous access,
credential scope reduction, revocation, rotation, expiry, disabled principals,
delegation revocation, unknown permissions, owner protection, and audit data.
Dashboard API tests cover bootstrap/login/session and protected routes. The
Phase 3 test adds a compact guard against regression in the permission and
bootstrap source contracts.

The implementation route inventory was reviewed for these dashboard groups:
identity/bootstrap, Grafana proxy, artifacts, event deliveries,
scope/connector state, Compute administration, Black Box, prediction/evolve,
capability packs, reconciliation, knowledge/memory/handoffs/sync, procedures,
database and backup, logs/KV/data deletion, internal error logging, webhooks,
Agent Bridge proxy/history/stream, approvals, quick actions, system/metrics,
and tool statistics. Dashboard-wide authentication middleware precedes these
registrations; sensitive identity, Black Box, approval, capability, database,
and destructive routes additionally use permission or governed-tool checks.
Connector and operational read routes expose bounded/sanitized state only and
remain behind the authenticated dashboard boundary.

The MCP inventory covers health, session/SSE/message/MCP transport, scoped
credential/API-key middleware, and all Compute administration, enrollment,
worker lifecycle, job, cancellation, artifact, recovery, and compatibility
routes. Compute worker/enrollment routes intentionally bypass the coordinator
credential middleware only where their route-local worker/enrollment guard is
installed; administrative routes retain `requireAdmin`. No bypass path was
found that reaches a handler without its route-local or global authenticator.

## Finding fixed in this phase

`F3-01` (medium): dashboard local-password login and legacy Basic Auth had no
online brute-force throttling. An attacker who could reach the dashboard could
make unbounded password guesses against a valid username. The fix is
`src/core/auth-rate-limit.js`, integrated into both dashboard authentication
paths, with regression coverage in `test/auth-rate-limit.test.js`. The limiter
is bounded, does not persist credentials or raw usernames, expires failures,
and preserves successful authentication and existing compatibility behavior.

## Residual risk

Transitional legacy API-key and Basic Auth compatibility remain accepted
migration risks and must stay explicitly scoped and attributable. The
rate-limiter is process-local; a horizontally scaled deployment needs a shared
counter or upstream gateway throttling for equivalent cross-instance
protection. The dashboard may be configured with compatibility credentials, so
operators must still use TLS and safe network exposure. Phase 8 and Phase 9
separately audit transport, network, CSRF, XSS, headers, and proxy trust.

Phase 4 owns secure defaults and remote exposure policy; this phase does not
claim those configuration decisions are complete.
