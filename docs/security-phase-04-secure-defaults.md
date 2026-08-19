# Phase 4 — Secure Defaults and Remote Exposure

Status: complete phase gate

Reviewed baseline: `12574d995e9f2b751b5954445f5e6193791be4da`

Branch: `security-phase-04-secure-defaults-20260819`

## Default posture reviewed

- Fresh tool policy defaults to `restricted`; high and critical tools are not
  broadly available merely because policy configuration was omitted.
- Fresh approval mode defaults to `strict`; high and critical allowed tools
  require approval unless an explicit exemption is configured.
- Fresh `.env.example` network allowlists now contain loopback only for MCP and
  dashboard access. Remote subnets require an explicit operator edit.
- Fresh dashboard identity bootstrap/login is the normal authentication path;
  legacy Basic Auth is an explicit compatibility option.
- Agent Bridge remains loopback-bound and is reached through the dashboard
  proxy rather than becoming a fresh-install public listener.
- Browser private-network access, private web fetch, and unconstrained
  filesystem paths remain explicit capability/configuration decisions rather
  than being silently enabled by the fresh template.

## Compatibility and migration

Existing installations retain explicit environment values. In particular,
changing the template does not rewrite an existing `.env`, and explicit
`SIDEKICK_TOOL_POLICY=open`, `SIDEKICK_APPROVAL_MODE=off`, or broad allowlists
remain operator choices. The migration path is to compare the existing file
with `.env.example`, set trusted network ranges deliberately, use restricted
policy and strict approval, and remove legacy Basic Auth when identity sessions
are adopted.

## Finding fixed

`F4-01` (medium): the shipped fresh-install template and README described empty
IP allowlists and Basic Auth as the normal default, which could lead an
operator to expose the high-power services broadly while relying on stale
documentation. The template now starts loopback-only, the documentation
describes identity bootstrap and explicit compatibility, and the migration
behavior is stated without silently changing existing deployments.

This is defense in depth: bearer/scoped credentials, identity authorization,
dispatcher policy, approvals, and OS/network controls remain required. A
loopback template is not a substitute for TLS or an infrastructure firewall.

## Residual risk

The runtime still honors deliberately explicit broad allowlists, open policy,
approval-off mode, and remote binding choices for compatibility. Existing
deployments must be migrated intentionally. The application cannot infer a
safe remote subnet or TLS termination topology, so deployment configuration
remains an operator responsibility.
