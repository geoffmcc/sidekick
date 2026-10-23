# ADR: Core Service Authority Boundary

## Status

**Accepted — 2026-10-23.** This decision records the current trust boundary and
the prerequisite for safely separating Core service identities. It does not
claim that the broker or service isolation has been implemented.

## Context

Sidekick runs MCP, Dashboard, and Agent Bridge as separate processes in the
Linux deployment. Their systemd units currently use the same `sidekick` UID
and GID and point at the same file-backed secret directory. The processes also
open shared SQLite state. Dashboard and Agent Bridge import the local tools
facade and call the canonical dispatcher directly in-process.

The relevant execution paths are:

```text
MCP client -> MCP HTTP -> callMcpTool -> canonical dispatcher
Browser -> Dashboard routes -> callDashboardTool -> canonical dispatcher
Dashboard proxy -> Agent Bridge -> callAgentTool -> canonical dispatcher
MCP, Dashboard, Agent Bridge -> shared SQLite and secret files
```

The Compute Worker is a separate Linux identity with systemd filesystem
restrictions. Third-party executable modules fail closed when an OS isolation
backend is unavailable. Those controls do not separate MCP, Dashboard, or
Agent Bridge from one another. JavaScript execution contexts and source labels
are useful for policy and audit, but are not OS-enforced process identities.

Source evidence is in `src/index.js`, `src/dashboard.js`, `src/agent.js`,
`src/tools/dispatcher.js`, and the service definitions under `systemd/`.

## Decision

1. Treat MCP, Dashboard, and Agent Bridge as one OS trust domain until a real
   boundary is enforced. Do not describe their current process separation as
   containment of a compromised Core process.
2. Do not split their service UIDs by editing unit files alone. Direct tool
   dispatch, shared database access, and credential resolution would either
   break legitimate operations or remain reachable across the proposed
   boundary.
3. Before service UID separation, move privileged tool dispatch, secret
   resolution, and protected state operations behind a Core-owned authenticated
   broker. The broker must authenticate the calling service at an OS boundary,
   validate any principal or delegation from server-verifiable state, and
   recheck current policy, project/resource scope, approval, and risk before
   execution.
4. Keep secrets and protected state inside the broker boundary. Merely
   forwarding a shared bearer key, trusting a caller-supplied principal ID, or
   adding a JavaScript interceptor is not an acceptable isolation mechanism.
5. Migrate incrementally, starting with a read-only operation and then a
   narrow tool call. Every stage must preserve useful Dashboard and Agent
   workflows and include negative tests against the actual OS access boundary.
6. Select the transport only after proving its access-control properties on
   every supported platform. Linux/macOS Unix-domain socket permissions and
   Windows named-pipe ACLs are candidates; neither is approved solely by name.

## Required broker properties

- Authenticate the service peer outside the requesting process.
- Bind requests to a service identity and, where applicable, the initiating
  principal, durable task, project, workspace, resource, and delegation.
- Resolve durable authority from Core-owned state instead of trusting claims
  carried only in an RPC payload.
- Revalidate current schemas, authorization, risk, approval, revocation, and
  idempotency immediately before execution.
- Keep secret values within the broker and authorized tool handler; never
  return them to Dashboard or Agent as general-purpose data.
- Produce authoritative audit records that client processes cannot forge or
  suppress.
- Fail closed with an actionable diagnostic when the broker or its OS
  authentication is unavailable.
- Enforce request size, concurrency, execution timeout, and resource limits.

## Alternatives considered

- **Change only `User=` in the three unit files:** rejected. The services
  directly share the dispatcher, SQLite state, and secret files.
- **Use a shared loopback bearer token:** rejected as the isolation boundary.
  It does not bind a request to an OS peer or prevent a compromised client
  from forging another caller's identity.
- **Keep current services and claim process isolation:** rejected because the
  same UID grants equivalent file access and local dispatch remains in-process.
- **Choose a single cross-platform IPC transport now:** deferred until
  peer-authentication and ACL behavior can be tested on Linux, Windows, and
  macOS without adding an unnecessary dependency or weakening supported
  deployment modes.

## Consequences

- The current code remains operational and no production service, credential,
  database, filesystem, or network configuration is changed by this decision.
- Invariant 7 is only partially enforced for Core processes. Invariants 1, 5,
  and 10 still lack independent process attribution for direct local calls.
- A service-account migration depends on a larger API/state ownership change;
  it must include data migration, backup/restore, rollback, and recovery tests.
- The architecture work must include performance measurements and positive
  tests for Jellyfin, development, administration, scheduled work, and task
  recovery. Security is not accepted by disabling those operations.

## Acceptance evidence

The decision is not implementation completion. The broker is ready for service
separation only when integration tests prove that Dashboard and Agent cannot
read Core credentials or protected database files directly, cannot impersonate
principals or replay approvals, and still perform authorized work through the
broker. These tests must exercise OS permissions and broker failure behavior
on each supported platform.

Track implementation and residuals in the external security initiative
reports; this ADR is the repository architecture reference and must be kept
consistent with actual code.
