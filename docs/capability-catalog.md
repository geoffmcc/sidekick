# Capability Catalog

Sidekick exposes a read-only, bounded capability projection through the
existing governed `capability` tool:

```json
{ "action": "catalog", "source": "agent", "kind": "tool", "limit": 50 }
```

The projection combines installed and bundled packs, registered modules,
canonical tools, generated tools, and workflow definitions. Each entry reports
its owner, lifecycle state, availability and reasons, dependencies,
configuration, health, permissions, and required network scopes. Tool entries
also include the source-specific policy and approval decision.

`offset` and `limit` are bounded, and `query`, `kind`, `owner`, `state`, and
`available` are deterministic filters. This is discovery data only. Actual
Agent, Dashboard, and MCP execution continues through the canonical registry
and dispatcher, which revalidates schemas, authorization, policy, approval,
and module state.

The Dashboard exposes the same projection at
`GET /api/capabilities/catalog`; its request is dispatched as the Dashboard
source rather than reading lifecycle state from browser code.
