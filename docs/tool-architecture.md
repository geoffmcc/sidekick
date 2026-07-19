# Tool Architecture

Sidekick's current built-in registry contains 107 tools across 20 categories. Tools execute through a descriptor registry and centralized dispatcher. `src/tools-legacy.js` still contains most migrated-in-place handlers, but it is no longer the authoritative execution path.

## Descriptor Model

Each tool has one normalized descriptor with its public name, description, Zod input schema, handler, explicit risk, category, origin, optional family, aliases, and policy-facing metadata.

Descriptors are validated by `src/tools/descriptor.js`. Validation rejects empty names, invalid names, missing descriptions, missing handlers, missing schemas, missing risks, and risks outside the supported vocabulary: `low`, `medium`, `high`, `critical`.

Extracted descriptor-owned families live under `src/tools/families/` and are aggregated by `src/tools/families/index.js`, which is the single source of extracted descriptors for the registry:

- `utility.js` — `respond`. The first extracted family.
- `data-utilities.js` — `parse`, `diff`, `validate`, `template`. In-process data utilities: they perform no filesystem, database, network, or shell access. This is a description of their current dependencies, not a sandbox guarantee — `validate` compiles caller-supplied JSON Schema through Ajv and `template` compiles caller-supplied Handlebars templates, so their input is still untrusted code-shaped data.

Each family owns its handlers, Zod schemas, risk, category, and compatibility metadata. Legacy `TOOL_DEFS` rows remain only as ordering anchors while MCP ordering compatibility is preserved. When an extracted tool has an entry in `src/tools/schemas/index.js`, remove it so each schema has exactly one owner.

`hash` is intentionally still legacy-owned despite sharing the `Data Pipeline` category: it calls `enforcePathPolicy`, a `src/tools-legacy.js` internal security boundary shared with roughly twenty other handlers. Relocating that boundary is its own slice.

## Registry Lifecycle

`src/tools/registry.js` builds the built-in registry from descriptor data. During migration it adapts legacy definitions into descriptors and substitutes extracted family descriptors at their legacy order position.

The registry rejects ambiguous names with order-independent validation. It collects canonical names first, rejects duplicate canonical names, then rejects aliases that collide with any other canonical name or alias. A descriptor may declare its own canonical name as an explicit self-alias. Built-in tools cannot be shadowed by generated tools; generated tools are resolved only when no built-in descriptor exists for the canonical name.

Compatibility maps are derived from the registry:

- `TOOLS`
- `TOOL_DEFS`
- schema lookup
- MCP definitions
- risk and category metadata for catalog display

New production code should depend on `src/tools/index.js`, `dispatchTool`, or `callTool`, not on `src/tools-legacy.js`.

## Dispatcher Pipeline

`src/tools/dispatcher.js` owns the runtime execution pipeline for production tool calls.

Pipeline order:

1. Reject caller-provided descriptors unless execution is using the test-only descriptor capability.
2. Create or inherit request-scoped execution context.
3. Look up the built-in descriptor or generated-tool descriptor.
4. Reject unknown tools and unclassified generated tools.
5. Validate arguments with the descriptor Zod schema.
6. Evaluate tool policy for the request source.
7. Evaluate approval requirements.
8. Queue approval or continue with a trusted approved execution.
9. Invoke the descriptor handler.
10. Apply timeout and cancellation boundaries where provided.
11. Normalize and sanitize success, validation, policy, approval, timeout, cancellation, handler, and dispatcher errors.
12. Log the invocation with redacted summaries and context metadata.
13. Report audit logging failure separately without misclassifying handler success or failure.
14. Let legacy platform/activity mirroring preserve dashboard compatibility.

Production transports must not directly invoke `descriptor.handler`, legacy handlers, or `dynamicTools.callDynamicTool`. They call the source-specific dispatcher wrappers exported from `src/tools/index.js`.

## Request-Scoped Context

`src/tools/context.js` uses `AsyncLocalStorage` for request-scoped source and invocation metadata. The compatibility `setSource` API remains for old tests and legacy helper calls, but dispatcher-created context is authoritative for tool execution.

Context fields include source, request ID, trace/correlation ID, invocation ID, parent invocation, actor, auth identity, session ID, task ID, project, tool name, approval ID, generated procedure name, execution IDs, operation ID, idempotency key, timeout, cancellation signal, and security metadata.

Nested calls inherit the intended context fields and receive dispatcher-created invocation metadata. Concurrent calls do not share source or request identity. The legacy `setSource` compatibility setter must not be used around asynchronous execution; live request identity is passed into the dispatcher and carried by `AsyncLocalStorage`.

Generic `createExecutionContext` and compatibility `callTool` calls do not trust caller-supplied `source`. Only private source-specific factories can establish transport identity:

- `createMcpExecutionContext` / `callMcpTool`
- `createAgentExecutionContext` / `callAgentTool`
- `createDashboardExecutionContext` / `callDashboardTool`
- `createApprovalExecutionContext`
- `createInternalExecutionContext` / `callInternalTool`
- `createTestExecutionContext` for test-only descriptor execution

## Policy And Approval Boundary

Policy and approval decisions are evaluated in the dispatcher for all tool execution surfaces.

Approval behavior remains compatible with the existing dashboard approval workflow, but ordinary dispatcher callers cannot bypass approval with `bypassApproval`, `approvalBypass`, a supplied approval ID, or a caller-selected source.

- Required approvals queue encrypted payloads.
- Approval previews are redacted.
- Approval records store the canonical tool name, encrypted canonical arguments, an argument hash, requester/source metadata, timeout metadata, creation time, and expiration time.
- Dashboard approval calls `resolveApproval`, which uses the dispatcher-owned trusted `executeApprovedTool` path.
- The trusted path loads the stored approval, verifies it is pending and unexpired, authenticates and decrypts the stored arguments, leases it as `executing` in a database transaction, and executes the stored tool with the stored arguments.
- Approved execution re-resolves the current descriptor, revalidates arguments, rechecks current policy, and verifies current risk before handler invocation.
- Approval execution carries a trusted operation ID, executor ID, and idempotency key through context, timeout errors, tool logs, and finalization.
- Lease renewal updates approval heartbeat and lease expiration while the approved tool is running.
- Finalization requires matching operation ID and executor ID, then records `approved` or `failed`, stores a redacted result preview, discards the encrypted payload, and preserves platform approval/change-set events.
- Timed-out approved operations that may still be running move to `reconciliation_required` with `manual_review` instead of being treated as safely failed or safely retryable.
- Stale high-risk, critical, or unknown executing approvals move to `reconciliation_required`; stale low-risk approvals are only returned to `pending` when an explicit recovery policy allows low-risk retry.
- Pending, rejected, expired, failed, already-approved, and already-executing approvals cannot be executed.
- Approvals are single-use; concurrent duplicate execution is prevented by the leased `pending` to `executing` claim transition.

Operators investigating stale approvals should inspect the approval `operation_id`, `executor_id`, `heartbeat_at`, `lease_expires_at`, `attempt_count`, and `reconciliation_status` fields. Recovery events are recorded in `approval_execution_recovery_events` by migration `021_approval_execution_recovery.sql`.

Approval cannot be bypassed by using MCP, dashboard generated-tool runs, agent execution, scheduler execution, generated-tool nested steps, or legacy `callTool` compatibility APIs.

Future internal callers that need to execute a reviewed request must call the approval subsystem (`resolveApproval` or the dispatcher-owned approved-execution helper) with only an approval ID and reviewer identity. They must not pass replacement arguments or a replacement tool name.

## Risk Behavior

Built-in descriptors must have explicit risk metadata. Missing built-in risk metadata fails registry construction.

Generated tools are untrusted runtime data. Missing or invalid generated risk does not default to `low` or `medium`; dispatcher execution fails closed with `risk_unclassified` until the generated capability has a valid risk.

Legacy compatibility risk lookup returns `critical` for unknown tools so old policy inspection does not fail open.

## Invocation Surfaces

Current production surfaces and routing:

- MCP built-ins in `src/index.js`: register definitions from descriptors and call `callMcpTool`.
- MCP taught procedures: call `callMcpTool("teach", ...)`.
- MCP generated tools: call `callMcpTool(def.name, ...)`.
- Agent tasks and scheduled delay/watch actions in `src/agent.js`: call `callAgentTool`.
- Dashboard evolve actions and generated-tool runs in `src/dashboard.js`: call `callDashboardTool`.
- Legacy internal tool-to-tool calls in `src/tools-legacy.js`: local `callTool` delegates to the dispatcher.
- Generated/evolved tool steps in `src/dynamic-tools.js`: receive injected `callTool`, which is the dispatcher compatibility API.

Dashboard database API routes still use policy checks as HTTP route guards for dashboard-specific endpoints; they do not directly execute MCP tool handlers.

## Result And Error Model

Dispatcher results preserve MCP-compatible `{ content: [{ type: "text", text }] }` responses. Errors include `isError: true` and normalized codes such as:

- `unknown_tool`
- `validation_failed`
- `policy_denied`
- `approval_required`
- `approval_queue_unavailable`
- `descriptor_injection_denied`
- `risk_unclassified`
- `timed_out_operation_may_continue`
- `cancelled`
- `handler_error`
- `policy_evaluation_failed`
- `approval_evaluation_failed`
- `audit_persistence_failed`
- `dispatcher_internal_error`

Responses and logs use centralized result helpers and the shared redaction utility. Dispatcher-returned errors redact bearer tokens, API keys, authorization headers, password-like fields, private-key blocks, database URLs, and stack-trace frames.

Timeouts are best-effort for legacy handlers. The dispatcher passes an `AbortSignal` to handlers and requests cancellation on timeout, but it returns `timed_out_operation_may_continue` unless the caller cancellation signal is explicitly observed. It does not claim that underlying work was terminated when a legacy handler may still be running.

Audit logging is isolated from handler execution. Policy, validation, and approval failures remain denied even if logging later fails. A successful handler result remains successful if final audit persistence fails; the result includes observable audit-failure metadata and a structured application error is emitted with invocation ID, tool name, approval ID when present, and a sanitized error.

## Adding Or Migrating A Tool

For new descriptor-owned tools:

1. Add the handler and descriptors in a focused family module under `src/tools/families/`.
2. Include schema, args metadata, explicit risk, category, source, and family.
3. Register the family module in `src/tools/families/index.js`; `src/tools/registry.js` consumes that aggregate.
4. Remove the live legacy handler when safe.
5. Keep any needed legacy definition row only as a temporary ordering anchor.
6. Check for code that tests tool existence against the legacy `TOOLS` handler map. Such a check silently stops recognizing an extracted tool. Resolve built-in names from `TOOL_DEFS` or the registry instead — `sidekick_batch` did exactly this and lost access to every extracted tool until it was corrected.
7. Add dispatcher-level tests for success, validation failure, policy denial, approval behavior when relevant, logging, and compatibility exports.

Handlers should not implement their own policy or approval logic. Handlers that need nested tools should use an injected or imported dispatcher call path, not raw handler maps.

## Remaining Legacy Work

Most handlers still live in `src/tools-legacy.js`. Remaining migration should proceed by coherent families, such as read-only database inspection tools, memory tools, or the GitHub tools. Avoid migrating destructive infrastructure tools until their security behavior is fully characterized.

A family whose handlers depend on `src/tools-legacy.js` internals — `enforcePathPolicy`, `safeExecFileSync`, `isDangerous`, `jsonText` — needs those helpers relocated to a shared module first. That relocation should be its own slice, not a side effect of a family extraction. Family modules must not require `src/tools-legacy.js` at module top level; the lazy `require` of the dispatcher inside legacy functions is what keeps the dispatcher/legacy cycle from forming.

The compatibility layer remains to preserve external clients, existing generated/evolved tools, dashboard catalogs, approval workflows, and tool logs during gradual extraction.

## Tests

Tool architecture tests live in:

- `test/tool-registry-contract.test.cjs`
- `test/dispatcher.test.cjs`
- `test/approval.test.js`
- existing dashboard, agent, compute, generated-tool, and security suites

Tests assert descriptor completeness, duplicate rejection, fail-closed risk behavior, dispatcher result normalization, approval behavior, concurrency-safe context, MCP routing through `callTool`, and extracted-family compatibility.
