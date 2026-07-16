# Tool Architecture

Sidekick's built-in tools are moving from a monolithic implementation file to a descriptor-driven tool layer.

## Canonical Descriptor

Each built-in tool is represented as a validated descriptor:

```js
{
  name: "read",
  description: "Read a file from the remote filesystem",
  schema: z.object({ path: z.string() }),
  args: { path: "string" },
  risk: "medium",
  category: "Core",
  handler: readTool,
}
```

The descriptor validator rejects duplicate names, missing handlers, empty descriptions, missing Zod schemas, and invalid risk values. Compatibility `TOOLS`, `TOOL_DEFS`, schema maps, risk lookup, and category lookup are derived from descriptor inputs.

## Current Module Boundaries

- `src/tools.js` is the compatibility facade. It intentionally preserves the historical CommonJS export set.
- `src/tools-legacy.js` contains the legacy handlers while domain extraction proceeds.
- `src/tools/index.js` is the new registry-aware tool-layer entry point.
- `src/tools/descriptor.js` validates and normalizes descriptors.
- `src/tools/registry.js` builds the built-in registry.
- `src/tools/schemas/index.js` owns MCP input schemas.
- `src/tools/metadata.js` owns built-in risk and category metadata.
- `src/tools/dispatcher.js` is the policy-enforced call boundary.
- `src/tools/policy.js`, `src/tools/approvals.js`, `src/tools/logging.js`, and `src/tools/registry-sync.js` expose centralized policy, approval, logging, and registry-sync interfaces.

## Dispatcher Pipeline

Normal tool execution should use `callTool` rather than raw handler invocation. The dispatcher path is responsible for prefix normalization, policy checks, approval handling, dynamic tool dispatch, execution timing, result handling, and logging.

Raw handler invocation is limited to controlled MCP registration and tests. Nested execution, procedures, schedules, retries, batches, and generated tools should call through the dispatcher so policy and logging remain consistent.

## MCP Registration

`src/index.js` registers built-in tools from `getBuiltinRegistry().listInDefinitionOrder()`. It no longer owns an independent `TOOL_SCHEMAS` object. Dynamic tools and taught procedures still register separately and are excluded when their names collide with built-ins.

## Dynamic Tools And Procedures

Dynamic tools are not merged into the built-in registry because their metadata is untrusted runtime data. They continue to use the dynamic-tool registry and receive an injected `callTool` dependency for nested calls.

Taught procedures remain registered at MCP startup from stored procedure definitions. Procedure execution still goes through the existing `teach` tool path.

## Compute Delegation

Compute remains implemented under `src/compute/`. The generic tool layer treats Compute tools as descriptors whose handlers delegate to `src/compute/tools.js`; it must not import worker agents, dashboard code, or scheduling internals.

## Adding A Built-In Tool

During the migration, add the handler in the appropriate domain module, then add one descriptor containing the name, description, schema, args metadata, risk, category, and handler.

Add focused tests for valid invocation, invalid arguments, policy block behavior, result shape, logging when applicable, and dashboard/MCP visibility through the registry contract.

Adding a normal tool should not require editing separate central handler, schema, risk, category, and definition maps.

## Dependency Rules

Allowed direction:

```text
domain handlers -> shared services/interfaces
registry -> descriptors + handlers
dispatcher -> registry + policy + approvals + logging
MCP adapter -> registry + dispatcher
```

Domain handlers should not import `src/tools.js` to call other tools. Use an injected dispatcher/call service for nested execution.
