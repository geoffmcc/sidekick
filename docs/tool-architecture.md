# Tool Architecture

Sidekick tools execute through a descriptor registry and a centralized dispatcher. `src/tools-legacy.js` still contains most migrated-in-place handlers, but it is no longer the authoritative execution path.

## Descriptor Model

Each tool has one normalized descriptor with its public name, description, Zod input schema, handler, explicit risk, category, origin, optional family, aliases, and policy-facing metadata.

Descriptors are validated by `src/tools/descriptor.js`. Validation rejects empty names, invalid names, missing descriptions, missing handlers, missing schemas, missing risks, and risks outside the supported vocabulary: `low`, `medium`, `high`, `critical`.

`src/tools/families/utility.js` is the first extracted descriptor-owned family. It owns the `respond` handler, schema, risk, category, and compatibility metadata. The legacy `TOOL_DEFS` row remains only as an ordering anchor while MCP ordering compatibility is preserved.

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

1. Resolve the canonical tool name or explicit test descriptor.
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

Production transports must not directly invoke `descriptor.handler`, legacy handlers, or `dynamicTools.callDynamicTool`. They call `callTool` or `dispatchTool`.

## Request-Scoped Context

`src/tools/context.js` uses `AsyncLocalStorage` for request-scoped source and invocation metadata. The compatibility `setSource` API remains for old tests and legacy helper calls, but dispatcher-created context is authoritative for tool execution.

Context fields include source, request ID, trace/correlation ID, invocation ID, parent invocation, actor, auth identity, session ID, task ID, project, tool name, approval ID, generated procedure name, execution IDs, timeout, cancellation signal, and security metadata.

Nested calls inherit the intended context fields and receive dispatcher-created invocation metadata. Concurrent calls do not share source or request identity. The legacy `setSource` compatibility setter must not be used around asynchronous execution; live request identity is passed into the dispatcher and carried by `AsyncLocalStorage`.

## Policy And Approval Boundary

Policy and approval decisions are evaluated in the dispatcher for all tool execution surfaces.

Approval behavior remains compatible with the existing dashboard approval workflow, but ordinary dispatcher callers cannot bypass approval with `bypassApproval`, `approvalBypass`, a supplied approval ID, or a caller-selected source.

- Required approvals queue encrypted payloads.
- Approval previews are redacted.
- Approval records store the canonical tool name, encrypted canonical arguments, an argument hash, requester/source metadata, creation time, and expiration time.
- Dashboard approval calls `resolveApproval`, which uses the dispatcher-owned trusted `executeApprovedTool` path.
- The trusted path loads the stored approval, verifies it is pending and unexpired, authenticates and decrypts the stored arguments, transitions it to `executing` in a database transaction, and executes the stored tool with the stored arguments.
- Approved execution re-resolves the current descriptor, revalidates arguments, rechecks current policy, and verifies current risk before handler invocation.
- Finalization records `approved` or `failed`, stores a redacted result preview, discards the encrypted payload, and preserves platform approval/change-set events.
- Pending, rejected, expired, failed, already-approved, and already-executing approvals cannot be executed.
- Approvals are single-use; concurrent duplicate execution is prevented by the `pending` to `executing` claim transition.

Approval cannot be bypassed by using MCP, dashboard generated-tool runs, agent execution, scheduler execution, generated-tool nested steps, or legacy `callTool` compatibility APIs.

Future internal callers that need to execute a reviewed request must call the approval subsystem (`resolveApproval` or the dispatcher-owned approved-execution helper) with only an approval ID and reviewer identity. They must not pass replacement arguments or a replacement tool name.

## Risk Behavior

Built-in descriptors must have explicit risk metadata. Missing built-in risk metadata fails registry construction.

Generated tools are untrusted runtime data. Missing or invalid generated risk does not default to `low` or `medium`; dispatcher execution fails closed with `risk_unclassified` until the generated capability has a valid risk.

Legacy compatibility risk lookup returns `critical` for unknown tools so old policy inspection does not fail open.

## Invocation Surfaces

Current production surfaces and routing:

- MCP built-ins in `src/index.js`: register definitions from descriptors and call `callTool`.
- MCP taught procedures: call `callTool("teach", ...)`.
- MCP generated tools: call `callTool(def.name, ...)`.
- Agent tasks and scheduled delay/watch actions in `src/agent.js`: call `callTool` with `source: "agent"`.
- Dashboard evolve actions and generated-tool runs in `src/dashboard.js`: call `callTool` with `source: "dashboard"`.
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
3. Add the family descriptors to `src/tools/registry.js`.
4. Remove the live legacy handler when safe.
5. Keep any needed legacy definition row only as a temporary ordering anchor.
6. Add dispatcher-level tests for success, validation failure, policy denial, approval behavior when relevant, logging, and compatibility exports.

Handlers should not implement their own policy or approval logic. Handlers that need nested tools should use an injected or imported dispatcher call path, not raw handler maps.

## Remaining Legacy Work

Most handlers still live in `src/tools-legacy.js`. Remaining migration should proceed by coherent families, such as read-only data utilities, memory tools, or database inspection tools. Avoid migrating destructive infrastructure tools until their security behavior is fully characterized.

The compatibility layer remains to preserve external clients, existing generated/evolved tools, dashboard catalogs, approval workflows, and tool logs during gradual extraction.

## Tests

Tool architecture tests live in:

- `test/tool-registry-contract.test.cjs`
- `test/dispatcher.test.cjs`
- `test/approval.test.js`
- existing dashboard, agent, compute, generated-tool, and security suites

Tests assert descriptor completeness, duplicate rejection, fail-closed risk behavior, dispatcher result normalization, approval behavior, concurrency-safe context, MCP routing through `callTool`, and extracted-family compatibility.
