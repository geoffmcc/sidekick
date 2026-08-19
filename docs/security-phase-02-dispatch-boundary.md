# Phase 2 — Central Execution Boundary

Status: complete phase gate

Reviewed baseline: `f984a536d09faf7d22de908ad96dada29a8f93da`

Branch: `security-phase-02-dispatch-boundary-20260819`

## Boundary verified

Production dispatch enters `src/tools/dispatcher.js` through the canonical
`dispatchTool` seam or one of its typed wrappers:

- `callMcpTool` establishes MCP source context;
- `callDashboardTool` establishes dashboard source context;
- `callAgentTool` establishes Agent Bridge source context;
- `callInternalTool` establishes server-internal context;
- `dispatchTool` resolves canonical names, validates schemas, authorizes,
  evaluates source policy, evaluates approval, enforces module state,
  applies timeout/cancellation, invokes the handler, redacts/logs, and audits;
- `dispatchTestTool` is a test-only descriptor seam and is not accepted by
  production dispatch.

The registry resolves built-in descriptors and dynamic descriptors. Dynamic
tools are still passed to `dispatchTool`; generated capability state and risk
classification are checked before execution. Module-owned descriptors are
checked against persisted lifecycle state immediately before execution.

## Alternate routes reviewed

The following routes were traced to the dispatcher rather than treated as
independent execution frameworks:

- MCP, dashboard, and Agent Bridge callers use typed dispatcher wrappers;
- nested family calls use `src/tools/dispatch-seam.js`, which calls
  `dispatcher.dispatchTool` at runtime;
- dynamic/evolved tools use the nested dispatch callback;
- flow control, scheduling, delay, retry, batch, orchestration, runbooks,
  teach/procedure, and workflow paths use dispatcher-backed calls;
- approval continuation uses the private approved-execution capability only
  after the approval store verifies task, operation, tool, checkpoint, and
  argument binding;
- standalone approval execution claims and finalizes the approval before
  dispatching through the same dispatcher;
- module services call the dispatcher after their module permission gate.

The legacy module remains a compatibility/catalog/helper owner. Repository
search found no production consumer that invokes a legacy handler map directly
outside dispatcher registry construction. The direct legacy calls in Brain are
approval-state/risk helpers, not tool-handler execution.

## Adversarial boundary properties

Evidence and regression coverage establish that:

1. Generic `dispatchTool` input cannot manufacture dashboard, Agent Bridge, or
   another trusted source identity; typed wrappers establish those identities.
2. Caller-supplied `bypassApproval`, `approvalBypass`, and approved-execution
   fields are removed from public context and cannot disable approval.
3. Caller-provided production descriptors are rejected; only the explicit test
   capability accepts a descriptor.
4. A dynamic capability with missing/invalid risk is rejected rather than
   executed.
5. Approval continuation rejects missing approvals, wrong task, wrong
   operation, wrong tool, stale checkpoint, non-running task, and mismatched
   arguments before reaching the approved-execution seam.
6. The approved-execution capability is a module-private `Symbol`; the public
   tools facade does not export the privileged task-step seam.
7. Approval continuation does not inherit authorization from decorative caller
   metadata; it verifies persisted approval state and argument digest.

## Findings

No new exploitable Phase 2 weakness was established. Existing boundary fixes
and regression coverage were verified against the current implementation. The
remaining risk is architectural: in-process handlers and compatibility helpers
remain powerful, so future changes must preserve the single dispatcher seam.

## Evidence

- `test/dispatcher.test.cjs` covers source provenance, schema validation,
  policy, approval, descriptor injection, timeout, cancellation, and dynamic
  risk rejection.
- `test/approval.test.js` covers caller bypass flags and approval execution.
- `test/approval-continuation.test.cjs` covers forged privileged-seam metadata,
  task/operation/tool/argument binding, replay, and continuation behavior.
- `test/security-phase-02-dispatch-boundary.test.js` provides a compact gate
  for the critical production-boundary invariants.

Phase 3 owns the separate route-by-route authentication, authorization,
session, and resource-scope audit. Phase 2 does not claim that work.
