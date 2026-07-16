# Dispatcher Identity And Approval Recovery Plan

## Current Architecture Trace

- MCP calls in `src/index.js` register canonical descriptors and call `callTool(...)` with MCP transport metadata.
- Agent calls in `src/agent.js` and scheduler/watch paths call `callTool(...)` with agent metadata.
- Dashboard calls in `src/dashboard.js` call `callTool(...)` for generated/evolve execution and call `resolveApproval(...)` for approvals.
- Compatibility calls in `src/tools-legacy.js` delegate local `callTool(...)` to `src/tools/dispatcher.js`.
- Generated procedures in `src/dynamic-tools.js` receive the injected dispatcher-backed `callTool`.
- Approved execution currently enters `executeApprovedTool(...)`, claims the stored approval, then calls the dispatcher with a private approval capability.

## Verified PR #97 Protections

- Caller-supplied `bypassApproval` and `approvalBypass` are removed from public context input.
- Approved execution uses stored approval tool and encrypted canonical arguments.
- Policy, schema, current descriptor, and risk are rechecked before approved execution.
- Registry alias collisions fail deterministically.
- Dispatcher errors are normalized and sanitized.
- Audit logging failure is surfaced separately and does not change handler success.

## Remaining Gaps

- Generic execution context still accepts caller-supplied `source`.
- Production dispatcher still accepts caller-provided `descriptor` objects.
- Approval claim state is not leased; a crash after `pending -> executing` can strand the approval.
- Timed-out approved operations have no trusted operation identity for reconciliation.
- Stale executing approvals have no recovery classification.

## Focused Plan

1. Add source-specific context factories for MCP, agent, dashboard, approval, internal, and test execution; sanitize generic context input so it cannot assert trusted source identity.
2. Migrate production call sites to those source-specific factories or wrapper `callTool` helpers.
3. Remove descriptor injection from production dispatch and keep direct descriptor execution behind a test-only/internal capability.
4. Add approval lease metadata on JSON approval records: operation ID, executor ID, claim timestamps, lease expiration, heartbeat, attempt count, and reconciliation status.
5. Add claim renewal/finalization ownership checks and stale-approval recovery classification.
6. Pass trusted operation ID and idempotency key through approved execution context and audit metadata.
7. Keep high-risk or unknown stale operations in manual-review/reconciliation state rather than replaying them automatically.
8. Add focused tests for source forgery, descriptor injection, approval leases, stale recovery, timeout operation identity, and PR #97 regressions.
9. Update `docs/tool-architecture.md` with the final trust-boundary and operator behavior.

## Validation Plan

- `node --check` for modified source files.
- Focused dispatcher, approval, registry, and security tests.
- `npm run test:security`.
- Full CI-equivalent `npm run test:ci` inside WSL.
