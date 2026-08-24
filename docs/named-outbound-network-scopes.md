# Named Outbound Network Scopes

Sidekick named outbound-network scopes are operator-created, versioned
allowlists for governed outbound HTTP, WebSocket, Browser, Browser Automation,
and Security Research traffic. A scope is reachability authority only. It does
not authorize testing a target, create a route, configure a VLAN, or change a
firewall.

## Model

Each scope has a stable ID and name, an immutable revision, a normalized policy
and SHA-256 digest, an enabled state, optional expiry, address and hostname
allowlists, explicit denials, protocols, and bounded ports. IPv4-mapped IPv6,
trailing-dot/case variants, duplicate entries, and equivalent CIDRs are
normalized before hashing. Wildcards are limited to bounded `*.suffix`
patterns; `*`, public suffixes, and bare TLDs are rejected.

The effective decision is fail-closed and has this precedence:

`permanent denial > explicit scope denial > missing effective allowlist > allow`

Unspecified, broadcast, multicast, link-local, loopback metadata, cloud
metadata, and proxy self-targets remain denied. Every DNS answer is checked and
the validated address is pinned for the connection. Redirects, frames,
subresources, downloads, service-worker traffic, popups, and WebSocket/CONNECT
traffic remain inside the Browser session proxy.

## Operator Control

Manage scopes through the authenticated Dashboard Network Scopes page or API:

- `GET /api/network-scopes`
- `GET /api/network-scopes/:scopeId?revision=N`
- `POST /api/network-scopes/validate`
- `POST /api/network-scopes`
- `PUT /api/network-scopes/:scopeId`
- `POST /api/network-scopes/:scopeId/state` with `{"state":"active|disabled|deleted"}`
- `POST /api/network-scopes/diagnose`

The MCP catalog also exposes the `network_scopes` tool (alias
`network_scope`) for listing, validating, creating, revising, disabling, and
diagnosing scopes. Mutating MCP actions require an authenticated operator and
the normal critical-tool approval path.

Mutations require the authenticated Dashboard administrator authority and use
the existing CSRF middleware. Scope changes create a new revision; old
research evidence retains its historical revision and digest. Disabled scopes
cannot start new work, and active work is refused on its next live operation.

For direct Core Browser use, pass `network_scope` to `browser.open`. The
legacy `allow_private_network` flag cannot grant private access. Browser
Automation may have a configured `network_scope`; calls can only use that
ceiling and can narrow it with `allowed_hosts`.

Security Research campaigns and runs may bind `network_scope`. Probes then
require both the existing research target scope and the exact named network
scope revision. A named network scope is not target authorization.

## Legacy Flags

`SIDEKICK_BROWSER_ALLOW_PRIVATE_NETWORK` is only an operator kill switch and
ceiling for scopes that explicitly permit private addresses. It grants no
network by itself. `SIDEKICK_ALLOW_PRIVATE_FETCH` and
`http.allow_private_addresses` are retained as deprecated configuration fields
for migration validation but do not grant private research access. Configure an
explicit named scope instead; no migration creates a permissive private
network scope.

## Routing and Diagnostics

Sidekick does not configure host routes, VLANs, VPNs, or firewall rules. The
Sidekick host/container must already have an operator-authorized path to the
scope. Policy denials are distinct from DNS refusal, routing failure,
connection refusal, timeout, TLS failure, research authorization failure, and
approval requirements. Audit records contain bounded scope identity, revision,
digest, protocol, port, DNS/policy decision and reason code, never credentials,
cookies, authorization headers, query secrets, or page bodies.

Use least privilege: list only the required CIDRs/hosts, protocols, and ports.
Committed defaults contain no real private network.
